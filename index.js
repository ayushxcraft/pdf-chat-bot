'use strict';

const path = require('path');
require('dotenv').config();
// Also load server/.env when the app is started from the repository root.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');

const pdfParse = require('pdf-parse');
const { GoogleGenAI } = require('@google/genai');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { get } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const COLLECTION = 'pdf-docs';
const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_DIM = 3072;
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash-lite';
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

// Stay comfortably below the 100 requests/minute free-tier limit shown by
// Gemini. You can override this in .env, but do not set it above your quota.
const EMBED_REQUESTS_PER_MINUTE = Math.min(90, Math.max(1, Number(process.env.GEMINI_EMBED_RPM) || 45));
const EMBED_REQUEST_INTERVAL_MS = Math.ceil(60_000 / EMBED_REQUESTS_PER_MINUTE);
const MAX_EMBED_ATTEMPTS = 3; // Initial request + up to 2 retries.

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Keep secrets on the server only. Never expose these values to the frontend.
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
});

// This version intentionally does not require an application password.

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// All embedding requests (PDF chunks and chat questions) pass through this
// single queue. This prevents parallel requests from exhausting the RPM quota.
let embeddingQueue = Promise.resolve();
let nextEmbeddingRequestAt = 0;

function runEmbeddingRequest(task) {
    const job = embeddingQueue.then(async () => {
        const waitMs = Math.max(0, nextEmbeddingRequestAt - Date.now());
        if (waitMs > 0) {
            await sleep(waitMs);
        }

        nextEmbeddingRequestAt = Date.now() + EMBED_REQUEST_INTERVAL_MS;
        return task();
    });

    // Keep the queue alive after a failed request; the caller still receives
    // the original rejection through `job`.
    embeddingQueue = job.catch(() => undefined);
    return job;
}

function getErrorText(error) {
    const parts = [
        error?.message,
        error?.status,
        error?.code,
        error?.response?.status,
    ];

    for (const value of [error?.details, error?.response?.data, error?.error]) {
        if (value === undefined || value === null) continue;
        try {
            parts.push(typeof value === 'string' ? value : JSON.stringify(value));
        } catch {
            // Ignore values that cannot be serialized.
        }
    }

    return parts.filter(Boolean).join('\n');
}

function isRetryableGeminiError(error) {
    const status = String(
        error?.status || error?.code || error?.response?.status || ''
    ).toUpperCase();
    const message = getErrorText(error);

    return (
        status === '429' ||
        status === '503' ||
        status === '502' ||
        status === '500' ||
        status === '504' ||
        status.includes('RESOURCE_EXHAUSTED') ||
        status.includes('UNAVAILABLE') ||
        /quota exceeded|rate.?limit|too many requests|temporarily unavailable/i.test(message)
    );
}

function isGeminiQuotaError(error) {
    const status = String(error?.status || error?.code || '').toUpperCase();
    const message = getErrorText(error);

    return (
        status === '429' ||
        status.includes('RESOURCE_EXHAUSTED') ||
        /quota exceeded|rate.?limit|too many requests/i.test(message)
    );
}

function getSuggestedRetryDelayMs(error) {
    const message = getErrorText(error);

    // Gemini commonly returns RetryInfo as: "retryDelay":"48s".
    const retryInfo = message.match(/"retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/i);
    if (retryInfo) {
        return Math.ceil(Number(retryInfo[1]) * 1000);
    }

    // It can also return human-readable text such as "Please retry in 48.2s".
    const retryText = message.match(
        /retry\s+(?:in|after)\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?)/i
    );

    if (retryText) {
        const amount = Number(retryText[1]);
        const unit = retryText[2].toLowerCase();
        return Math.ceil(unit.startsWith('m') ? amount : amount * 1000);
    }

    return null;
}

function makeQuotaError(originalError) {
    const error = new Error(
        'Gemini embedding quota/rate limit is still exceeded after automatic retries. ' +
        'Wait at least one minute and try again. If it continues, check the Gemini API ' +
        'rate limits and billing for the Google AI Studio project connected to this API key.'
    );
    error.statusCode = 429;
    error.cause = originalError;
    return error;
}

async function createEmbedding(text) {
    return runEmbeddingRequest(async () => {
        let lastError;

        for (let attempt = 1; attempt <= MAX_EMBED_ATTEMPTS; attempt += 1) {
            try {
                const response = await ai.models.embedContent({
                    model: EMBED_MODEL,
                    contents: text,
                });

                const values = response?.embeddings?.[0]?.values;

                if (!Array.isArray(values) || values.length !== EMBED_DIM) {
                    throw new Error(
                        `Embedding model returned an unexpected vector size. Expected ${EMBED_DIM}.`
                    );
                }

                return values;
            } catch (error) {
                lastError = error;

                if (!isRetryableGeminiError(error) || attempt === MAX_EMBED_ATTEMPTS) {
                    if (isGeminiQuotaError(error)) {
                        throw makeQuotaError(error);
                    }
                    throw error;
                }

                const suggestedDelay = getSuggestedRetryDelayMs(error);
                const exponentialDelay = Math.min(30_000, 2_000 * (2 ** (attempt - 1)));
                const waitMs = Math.max(suggestedDelay || exponentialDelay, 1_000) +
                    Math.floor(Math.random() * 750);

                console.warn(
                    `Gemini embedding request failed (attempt ${attempt}/${MAX_EMBED_ATTEMPTS}). ` +
                    `Retrying in ${(waitMs / 1000).toFixed(1)} seconds.`,
                    getErrorText(error)
                );

                await sleep(waitMs);
            }
        }

        if (isGeminiQuotaError(lastError)) {
            throw makeQuotaError(lastError);
        }
        throw lastError || new Error('Gemini embedding request failed.');
    });
}

// Process chunks one by one. The shared queue also throttles question
// embeddings from /ask, including when an upload is being processed.
async function embedAll(texts) {
    const output = [];

    for (let i = 0; i < texts.length; i += 1) {
        const vector = await createEmbedding(texts[i]);
        output.push(vector);

        if ((i + 1) % 10 === 0 || i + 1 === texts.length) {
            console.log(`Gemini embeddings completed: ${i + 1}/${texts.length}`);
        }
    }

    return output;
}

function chunkText(text, size = 1000, overlap = 200) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const chunks = [];

    for (let start = 0; start < clean.length; start += size - overlap) {
        const chunk = clean.slice(start, start + size).trim();
        if (chunk) chunks.push(chunk);
        if (start + size >= clean.length) break;
    }

    return chunks;
}

// Client code should request a path such as pdf-chat/<uuid>.pdf.
// A single filename segment is allowed; path traversal and nested paths are not.
function isAllowedPdfPath(pathname) {
    return (
        typeof pathname === 'string' &&
        /^pdf-chat\/[a-z0-9_-]{1,120}\.pdf$/i.test(pathname) &&
        !pathname.includes('..')
    );
}

function safePdfName(name) {
    const cleaned = String(name || 'document.pdf')
        .replace(/[\\/]/g, '_')
        .replace(/[^\w .()-]/g, '_')
        .trim()
        .slice(0, 150);

    const baseName = cleaned || 'document';
    return baseName.toLowerCase().endsWith('.pdf')
        ? baseName
        : `${baseName}.pdf`;
}

async function webStreamToBuffer(webStream, maxBytes) {
    if (!webStream || typeof webStream.getReader !== 'function') {
        throw new Error('The stored PDF could not be read from Blob storage.');
    }

    const reader = webStream.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;

            if (totalBytes > maxBytes) {
                await reader.cancel();
                const error = new Error('PDF is larger than the 20 MB upload limit.');
                error.statusCode = 413;
                throw error;
            }

            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
}

function isPdfBuffer(buffer) {
    // PDF headers are normally at the beginning, but the PDF specification
    // permits a small amount of leading data before the %PDF- marker.
    return buffer.subarray(0, Math.min(buffer.length, 1024)).includes(Buffer.from('%PDF-'));
}

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'PDF Chat Bot API',
        config: {
            blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
            qdrantConfigured: Boolean(process.env.QDRANT_URL && process.env.QDRANT_API_KEY),
        },
    });
});

// -----------------------------------------------------------------------------
// Step 1: Vercel Blob client-upload handshake
// -----------------------------------------------------------------------------
// The browser must use @vercel/blob/client upload() with:
//   access: 'private'
//   handleUploadUrl: '/api/blob-upload'
//   pathname: 'pdf-chat/<uuid>.pdf'
// The PDF bytes go directly from the browser to Blob, not through this function.

app.post('/api/blob-upload', async (req, res) => {
    try {
        const eventType = req.body?.type;
        if (!['blob.generate-client-token', 'blob.upload-completed'].includes(eventType)) {
            return res.status(400).json({
                error: 'Invalid Blob upload request. Make sure the frontend uses the matching secure-upload code.',
                receivedType: eventType || null,
            });
        }

        const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

        if (!blobToken) {
            return res.status(500).json({
                error: 'BLOB_READ_WRITE_TOKEN is not configured for this environment.',
            });
        }

        const result = await handleUpload({
            // handleUpload needs the static read-write token for client-token signing.
            // Passing it explicitly avoids relying on OIDC for this helper.
            token: blobToken,
            request: req,
            body: req.body,
            onBeforeGenerateToken: async (pathname) => {
                if (!isAllowedPdfPath(pathname)) {
                    throw new Error('Only PDF files in the pdf-chat folder are allowed.');
                }

                return {
                    allowedContentTypes: ['application/pdf'],
                    maximumSizeInBytes: MAX_FILE_BYTES,
                    validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
                    addRandomSuffix: true,
                    allowOverwrite: false,
                };
            },
            onUploadCompleted: async ({ blob }) => {
                // This callback is invoked by Vercel after the direct client upload.
                console.log('Private PDF upload completed:', blob.pathname);
            },
        });

        return res.status(200).json(result);
    } catch (error) {
        console.error('Blob upload handshake error:', {
            message: error?.message || String(error),
            name: error?.name || 'Error',
            status: error?.status || error?.statusCode || null,
            code: error?.code || null,
            eventType: req.body?.type || null,
            pathname: req.body?.payload?.pathname || null,
        });
        return res.status(error?.statusCode || 400).json({
            error: error.message || 'Could not authorize the PDF upload.',
        });
    }
});

// -----------------------------------------------------------------------------
// Step 2: Process PDF after direct upload to private Blob
// -----------------------------------------------------------------------------
// The frontend sends only the Blob pathname and original filename here.
// Do not send the PDF itself to this route; Vercel Functions have a body limit.

app.post('/process-upload', async (req, res) => {
    const { pathname, originalName } = req.body || {};

    if (!isAllowedPdfPath(pathname)) {
        return res.status(400).json({
            error: 'A valid PDF Blob pathname is required.',
        });
    }

    try {
        const storedBlob = await get(pathname, { access: 'private' });

        if (
            !storedBlob ||
            storedBlob.statusCode !== 200 ||
            !storedBlob.stream
        ) {
            return res.status(404).json({
                error: 'The uploaded PDF was not found in private Blob storage.',
            });
        }

        const blobSize = Number(storedBlob.blob?.size || 0);
        if (blobSize > MAX_FILE_BYTES) {
            return res.status(413).json({
                error: 'PDF is larger than the 20 MB upload limit.',
            });
        }

        if (
            storedBlob.blob?.contentType &&
            storedBlob.blob.contentType !== 'application/pdf'
        ) {
            return res.status(415).json({
                error: 'The uploaded file is not a PDF.',
            });
        }

        const dataBuffer = await webStreamToBuffer(
            storedBlob.stream,
            MAX_FILE_BYTES
        );

        if (!isPdfBuffer(dataBuffer)) {
            return res.status(415).json({
                error: 'The uploaded file does not appear to be a valid PDF.',
            });
        }

        const pdfData = await pdfParse(dataBuffer);
        const chunks = chunkText(pdfData.text);

        if (chunks.length === 0) {
            return res.status(422).json({
                error: 'No text found in PDF (scanned PDFs need OCR).',
            });
        }

        const vectors = await embedAll(chunks);
        const docId = crypto.randomUUID();
        const sourceName = safePdfName(originalName || pathname.split('/').pop());

        const points = chunks.map((text, index) => ({
            id: crypto.randomUUID(),
            vector: vectors[index],
            payload: {
                text,
                docId,
                chunkIndex: index,
                source: sourceName,
                blobPathname: pathname,
            },
        }));

        for (let i = 0; i < points.length; i += 100) {
            await qdrant.upsert(COLLECTION, {
                wait: true,
                points: points.slice(i, i + 100),
            });
        }

        return res.json({
            docId,
            chunks: chunks.length,
            name: sourceName,
            pathname,
        });
    } catch (error) {
        console.error('PDF processing error:', error);
        return res.status(error.statusCode || 500).json({
            error: error.message || 'Could not process the uploaded PDF.',
        });
    }
});

// -----------------------------------------------------------------------------
// Step 3: Preview private PDF
// -----------------------------------------------------------------------------

app.get('/pdf-preview', async (req, res) => {
    const pathname = req.query.pathname;

    if (!isAllowedPdfPath(pathname)) {
        return res.status(400).send('Invalid PDF path.');
    }

    try {
        const storedBlob = await get(pathname, { access: 'private' });

        if (
            !storedBlob ||
            storedBlob.statusCode !== 200 ||
            !storedBlob.stream
        ) {
            return res.status(404).send('PDF not found.');
        }

        res.status(200);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const blobSize = Number(storedBlob.blob?.size || 0);
        if (blobSize > 0) {
            res.setHeader('Content-Length', String(blobSize));
        }

        const pdfStream = Readable.fromWeb(storedBlob.stream);
        pdfStream.on('error', (error) => {
            console.error('PDF preview stream error:', error);
            if (!res.headersSent) {
                res.status(500).end('Could not load PDF preview.');
            } else {
                res.destroy(error);
            }
        });
        pdfStream.pipe(res);
    } catch (error) {
        console.error('PDF preview error:', error);

        if (!res.headersSent) {
            return res.status(500).send('Could not load PDF preview.');
        }

        res.destroy(error);
    }
});

// -----------------------------------------------------------------------------
// Step 4: Create Qdrant collection
// -----------------------------------------------------------------------------

app.get('/create-collection', async (req, res) => {
    try {
        const exists = await qdrant.collectionExists(COLLECTION);

        if (!exists.exists) {
            await qdrant.createCollection(COLLECTION, {
                vectors: {
                    size: EMBED_DIM,
                    distance: 'Cosine',
                },
            });
        }

        await qdrant.createPayloadIndex(COLLECTION, {
            field_name: 'docId',
            field_schema: 'keyword',
            wait: true,
        });

        return res.send(
            exists.exists
                ? 'collection existed, docId index created'
                : 'collection and docId index created'
        );
    } catch (error) {
        console.error('Qdrant setup error:', error);
        return res.status(500).json({
            error: error.message || 'Qdrant setup failed.',
        });
    }
});

// -----------------------------------------------------------------------------
// Step 5: Ask questions about an indexed PDF
// -----------------------------------------------------------------------------

app.post('/ask', async (req, res) => {
    const { question, docId } = req.body || {};

    if (
        typeof question !== 'string' ||
        !question.trim()
    ) {
        return res.status(400).json({
            error: '"question" is required.',
        });
    }

    if (question.length > 1000) {
        return res.status(400).json({
            error: 'Question is too long. Please keep it under 1000 characters.',
        });
    }

    if (
        docId !== undefined &&
        (typeof docId !== 'string' || docId.length > 100)
    ) {
        return res.status(400).json({
            error: 'Invalid document ID.',
        });
    }

    try {
        const questionEmbedding = await createEmbedding(question.trim());

        const result = await qdrant.query(COLLECTION, {
            query: questionEmbedding,
            limit: 4,
            with_payload: true,
            filter: docId
                ? {
                    must: [
                        {
                            key: 'docId',
                            match: { value: docId },
                        },
                    ],
                }
                : undefined,
        });

        const hits = result.points || [];

        if (hits.length === 0) {
            return res.status(404).json({
                error: 'No relevant content found. Upload a PDF first.',
            });
        }

        const context = hits
            .map((hit, index) => `[${index + 1}] ${hit.payload?.text || ''}`)
            .join('\n\n');

        const prompt = `You are a helpful assistant. Answer the question using ONLY the context below.
If the answer is not in the context, say "I couldn't find that in the document."

Context:
${context}

Question: ${question}`;

        const response = await ai.models.generateContent({
            model: CHAT_MODEL,
            contents: prompt,
        });

        return res.json({
            answer: response.text || '(empty answer)',
            sources: hits.map((hit) => ({
                chunkIndex: hit.payload?.chunkIndex,
                score: hit.score,
            })),
        });
    } catch (error) {
        console.error('Question answering error:', error);
        return res.status(500).json({
            error: error.message || 'Could not generate an answer.',
            details: error.data || null,
        });
    }
});

// -----------------------------------------------------------------------------
// Global error handler
// -----------------------------------------------------------------------------

app.use((error, req, res, next) => {
    console.error('Unhandled Express error:', error);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).json({
        error: 'Internal server error.',
    });
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
    console.log(`PDF Chat Bot server is running on port ${PORT}`);
});
