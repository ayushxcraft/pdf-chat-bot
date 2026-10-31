# PDF RAG Chatbot

A browser-based chatbot that lets a user upload a PDF, index its text in a vector database, and ask questions about that document. The application uses Retrieval-Augmented Generation (RAG): it retrieves relevant PDF chunks and sends those chunks to Gemini as the context for an answer.

> **Project status:** The uploaded code represents a working local prototype. The frontend and backend are served together by Express. Vercel deployment, persistent PDF storage, OCR, server-side document management, and document deletion from Qdrant are not implemented in the current source files.

---

## 1. Technology stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | HTML, CSS, vanilla JavaScript | PDF upload, document list, PDF preview, chat UI |
| Backend | Node.js, Express | Serves the frontend and exposes API routes |
| File upload | Multer | Receives PDF files and stores them temporarily |
| PDF extraction | `pdf-parse` | Extracts selectable text from PDF files |
| Embeddings and answer generation | Google Gemini through `@google/genai` | Creates vectors and generates answers |
| Vector database | Qdrant Cloud through `@qdrant/js-client-rest` | Stores document chunks and searches for relevant chunks |
| Configuration | `dotenv` | Loads API keys and service URLs from `.env` |
| Browser-side persistence | `localStorage` | Stores the document list, chat messages, and active document ID |

### Main models and database settings

| Setting | Current value |
|---|---|
| Embedding model | `gemini-embedding-2` |
| Embedding vector dimension | `3072` |
| Default chat model | `gemini-3.5-flash-lite` |
| Qdrant collection | `pdf-docs` |
| Vector distance | `Cosine` |
| Retrieved chunks per question | `4` |
| Text chunk size | `1000` characters |
| Chunk overlap | `200` characters |
| Embedding batch size | `5` |
| Qdrant upsert batch size | `100` points |
| Maximum PDF size | `20 MB` |

The chat model can be overridden with the `GEMINI_CHAT_MODEL` environment variable. The embedding dimension configured in the backend must match the vector size of the Qdrant collection.

---

## 2. Project folder structure

The current backend code serves the frontend from the `public` directory and writes temporary uploads to `uploads/`.

```text
PDF-RAG-CHATBOT/
└── server/
    ├── public/
    │   └── index.html
    │
    ├── uploads/
    │   └── (temporary uploaded PDF files)
    │
    ├── node_modules/
    ├── .env
    ├── index.js
    ├── package.json
    ├── package-lock.json
    └── README.md
```

**Important folder details**

- `public/index.html` is the frontend entry point. Express serves it with `express.static('public')`.
- `uploads/` is temporary working storage used by Multer. The backend deletes the temporary file after the upload/indexing request finishes.
- `.env` contains secrets and connection settings. It must not be committed to Git.
- `index.js` contains the Express server, Gemini integration, PDF processing, and Qdrant operations.

Run the server with the `server` directory as the working directory because the current code uses relative paths such as `public` and `uploads/`.

---

## 3. How the application works

### 3.1 PDF upload and indexing

The frontend sends the selected PDF to `POST /upload` as `multipart/form-data` using the field name `pdf`.

The backend then:

1. Checks that a file was received.
2. Reads the temporary file written by Multer.
3. Extracts PDF text using `pdf-parse`.
4. Normalizes whitespace and splits the text into fixed-size chunks.
5. Creates a Gemini embedding for every chunk.
6. Generates a unique `docId` for the uploaded PDF.
7. Gives every Qdrant point a unique UUID.
8. Stores each vector and its payload in the `pdf-docs` collection.
9. Deletes the temporary uploaded file in a `finally` block.
10. Returns the generated `docId` and number of chunks to the frontend.

Each Qdrant point contains a payload with:

```json
{
  "text": "Text content of this chunk",
  "docId": "unique-id-for-this-upload",
  "chunkIndex": 0,
  "source": "original-file-name.pdf"
}
```

The `docId` makes it possible to retrieve chunks belonging to one uploaded PDF without mixing them with other PDFs.

### 3.2 Text chunking

The current `chunkText()` helper:

- Replaces consecutive whitespace with a single space.
- Trims the extracted text.
- Uses a default chunk size of `1000` characters.
- Uses an overlap of `200` characters.
- Moves forward by `800` characters for each next chunk.

The overlap retains some surrounding text between adjacent chunks, which can help preserve context at chunk boundaries.

### 3.3 Embedding generation

The backend calls Gemini's `embedContent` method with `gemini-embedding-2`. The returned vector is stored in Qdrant.

Chunks are embedded in batches of five. The five embeddings within a batch are requested concurrently with `Promise.all`; batches are processed sequentially.

### 3.4 Asking a question

The frontend sends a JSON request to `POST /ask`.

The backend:

1. Converts the question into an embedding using the same embedding model.
2. Queries Qdrant for the four closest vectors.
3. Applies a `docId` filter when a `docId` is provided.
4. Builds a context string from the retrieved chunks.
5. Sends the context and question to the configured Gemini chat model.
6. Returns the generated answer and the source chunk indexes/scores.

The prompt instructs Gemini to answer **only from the retrieved context** and to say `I couldn't find that in the document.` when the answer is not present in that context.

```text
PDF
 │
 ▼
Extract text
 │
 ▼
Split into chunks
 │
 ▼
Generate embeddings with Gemini
 │
 ▼
Store vectors and payloads in Qdrant
        (upload flow)


User question
 │
 ▼
Generate question embedding
 │
 ▼
Search Qdrant for top 4 relevant chunks
 │
 ▼
Build context from retrieved chunks
 │
 ▼
Send context + question to Gemini
 │
 ▼
Return answer + source chunk information
        (question flow)
```

---

## 4. Frontend functionality

The frontend is a single-page HTML/CSS/JavaScript application in `public/index.html`.

### Document upload screen

- Displays the PDF upload/drop area when no document is selected.
- Supports the **Choose a PDF** button.
- Supports drag-and-drop of a PDF onto the page.
- Checks the file extension/type and enforces a 20 MB client-side size limit.
- Shows an indexing overlay while the upload request is running.
- Displays a success or error toast after the request.

### Document workspace

After the backend successfully indexes a PDF:

- The upload screen is hidden.
- The PDF preview appears on the left.
- The chat appears on the right.
- The chat input stays at the bottom of the chat column.
- The header shows the number of indexed chunks.
- The banner identifies the selected PDF.

### Sidebar and document controls

- Search filters the document names shown in the sidebar.
- Clicking a document selects it and loads its chat.
- **+ New document** returns to the upload screen without removing existing documents.
- The upload icon opens the file picker.
- The database button calls `GET /create-collection`.
- A document can be removed from the browser's local list after confirmation. This does **not** delete its vectors from Qdrant because the backend has no delete route yet.

### Chat functionality

- Sends questions to the backend with the selected `docId`.
- Displays user and AI messages.
- Shows a typing indicator while waiting for an answer.
- Displays retrieved source chunk indexes and similarity scores.
- Provides a Copy control for successful AI messages.
- Provides suggested questions when a document has no chat messages.
- Allows the current document's chat history to be cleared.

### Browser-side persistence

The frontend uses these `localStorage` keys:

| Key | Stored information |
|---|---|
| `pdfrag.docs` | Document metadata: `docId`, name, chunk count, creation time |
| `pdfrag.chats` | Chat messages grouped by `docId` |
| `pdfrag.active` | Currently selected document ID |

**PDF preview limitation:** The PDF itself is not saved in `localStorage`. The preview uses a browser object URL created during the upload session. After a page reload, the document metadata and chat history can remain in the browser, but the original PDF preview is unavailable unless the PDF is uploaded again. The frontend shows a preview-unavailable message in that case.

### Responsive layout

The CSS includes responsive behaviour for smaller viewports:

- At widths of `1100px` or less, the PDF viewer and chat are switched between views using the mobile view toggle.
- At widths of `760px` or less, the sidebar becomes a slide-in drawer and the desktop navigation rail is hidden.

The UI also follows the operating system's light/dark colour-scheme preference.

---

## 5. Environment variables

Create a `.env` file inside `server/`:

```env
GEMINI_API_KEY=your_gemini_api_key
QDRANT_URL=your_qdrant_cluster_url
QDRANT_API_KEY=your_qdrant_api_key

# Optional: overrides the default chat model
GEMINI_CHAT_MODEL=gemini-3.5-flash-lite
```

| Variable | Required? | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `QDRANT_URL` | Yes | Qdrant cluster URL |
| `QDRANT_API_KEY` | Yes | Qdrant API key |
| `GEMINI_CHAT_MODEL` | No | Chat model override; defaults to `gemini-3.5-flash-lite` in the current source |

Never place API keys directly in frontend JavaScript or commit the `.env` file to a public repository.

---

## 6. Installation and local setup

### Prerequisites

- Node.js and npm installed.
- A Gemini API key.
- A Qdrant Cloud cluster and its URL/API key.

### Install dependencies

Open a terminal in the `server/` directory:

```bash
npm install
```

The project dependencies include:

- `@google/genai`
- `@qdrant/js-client-rest`
- `dotenv`
- `express`
- `multer`
- `pdf-parse`

### Configure environment

Create `server/.env` using the environment-variable template above.

### Start the backend and frontend

From the `server/` directory:

```bash
node index.js
```

The current server listens on port `3000`.

Open this URL in the browser:

```text
http://localhost:3000
```

Do not open `public/index.html` by double-clicking it. The page should be served by Express so its relative API requests (`/upload`, `/ask`, and `/create-collection`) go to the same origin.

### Initialize the Qdrant collection

Use the **Initialise database (run once)** button in the sidebar, or call:

```http
GET http://localhost:3000/create-collection
```

The route creates the `pdf-docs` collection if it does not exist and creates the keyword payload index on `docId`.

---

## 7. Backend API reference

### `GET /create-collection`

Creates the Qdrant collection if required and creates the `docId` keyword payload index.

**Request body:** None.

**Success response:** Plain text indicating whether the collection existed or was created and that the `docId` index was created.

### `POST /upload`

Uploads and indexes a PDF.

**Content type:** `multipart/form-data`

**Required form field:**

| Field | Type | Description |
|---|---|---|
| `pdf` | File | PDF to upload; field name must be exactly `pdf` |

**Success response:**

```json
{
  "docId": "generated-document-id",
  "chunks": 12
}
```

The values above are an example response shape; the actual `docId` and chunk count depend on the uploaded PDF.

**Relevant error responses:**

| HTTP status | Meaning |
|---|---|
| `400` | No file was received under the `pdf` field |
| `422` | No extractable text was found; scanned/image-only PDFs need OCR |
| `500` | PDF parsing, Gemini embedding, Qdrant, or another server-side operation failed |

Multer is configured with a server-side maximum file size of 20 MB.

### `POST /ask`

Retrieves relevant chunks and generates an answer.

**Content type:** `application/json`

**Request body:**

```json
{
  "question": "What is RAG?",
  "docId": "generated-document-id"
}
```

`question` is required. The current backend treats `docId` as optional, but the frontend sends the selected document's `docId`.

**Success response:**

```json
{
  "answer": "Generated answer based on the retrieved PDF context.",
  "sources": [
    {
      "chunkIndex": 0,
      "score": 0.82
    }
  ]
}
```

The answer and source values above are examples of the response shape, not fixed values.

**Relevant error responses:**

| HTTP status | Meaning |
|---|---|
| `400` | The question is missing |
| `404` | Qdrant returned no relevant chunks |
| `500` | Embedding, Qdrant query, Gemini generation, or another server-side operation failed |

---

## 8. Important implementation details

- The Express server uses `express.json()` for JSON request bodies.
- `express.static('public')` serves the frontend.
- Multer writes incoming files to `uploads/`.
- Temporary upload files are removed in the upload route's `finally` block.
- Qdrant collection name is `pdf-docs`.
- Qdrant vectors use `Cosine` distance and a configured dimension of `3072`.
- Every uploaded PDF receives a unique `docId`.
- Every chunk receives a unique UUID as its Qdrant point ID, preventing chunk IDs from overwriting points from other uploads.
- Each Qdrant upsert is sent in batches of up to 100 points.
- The `/ask` route uses the Qdrant `query` method and requests up to four points with payloads.
- The current answer-generation prompt receives the current question and retrieved context. It does not send earlier chat messages to Gemini.

---

## 9. Known limitations in the current source

These are limitations visible in the uploaded source files, not features that should be assumed to exist.

1. **20 MB PDF limit:** Both the frontend and Multer backend enforce a 20 MB limit.
2. **No OCR:** Image-only/scanned PDFs do not produce extractable text and are rejected when no text chunks are found.
3. **No persistent PDF file storage:** The backend deletes its temporary upload after indexing. It does not upload the original PDF to object storage.
4. **Preview is session-bound:** The PDF preview relies on a browser object URL and is not restored after a page reload.
5. **Browser-only document/chat metadata:** The document list and chat history are stored in `localStorage`, not in a server-side user account.
6. **No user authentication:** The current source does not implement accounts or access control.
7. **No Qdrant delete route:** Removing a document from the sidebar only removes its browser-side record and chat history. Its vectors remain in Qdrant.
8. **No conversational memory in retrieval prompt:** Each `/ask` request is independent; previous messages are not included in the Gemini prompt.
9. **Character-based chunking:** Chunks are split by character count rather than PDF page, sentence, paragraph, or section.
10. **No explicit retry helper in the current backend file:** The uploaded `index.js` calls `ai.models.generateContent()` directly. It does not contain the retry helper discussed during earlier debugging.
11. **No deployment adapter/configuration in the supplied files:** The current backend starts with `app.listen(3000)`. No Vercel serverless entry point or deployment configuration is present in the uploaded source.
12. **No explicit separate frontend/backend API configuration:** The frontend uses relative paths such as `/upload` and `/ask`, so it expects to be served from the same origin as the Express API in the current setup.

---

## 10. Deployment considerations and future work

The intended deployment target discussed for this project is Vercel, but the supplied files show the local Express setup rather than a completed Vercel deployment.

Before production deployment, the architecture will need to account for:

- A serverless-compatible backend entry point or an appropriate persistent Node.js hosting arrangement.
- Correct routing for the static frontend and backend API.
- Persistent object storage for original PDFs if PDF previews must work after refresh or across devices.
- Upload handling appropriate for the deployment platform's request/body and execution limits.
- Secure environment-variable configuration for Gemini and Qdrant.
- A reliable document metadata store if users should see their documents across browsers or devices.
- Authentication and authorization if documents are private to individual users.
- Cleanup/deletion of Qdrant points when a document is deleted.
- Retry/backoff handling for temporary Gemini availability or rate-limit errors.
- Monitoring and production error handling.

### Suggested future improvements

These are potential next steps, not current functionality:

- Add external file storage for PDFs and store a durable file reference.
- Support larger PDFs through an upload architecture designed for the chosen storage and hosting platform.
- Restore the PDF preview using the stored file reference.
- Add OCR for scanned PDFs.
- Add document deletion in Qdrant.
- Add server-side document metadata and user accounts.
- Include conversation history in the LLM prompt when multi-turn contextual chat is required.
- Add robust retry/backoff for temporary Gemini and Qdrant failures.
- Add request validation, rate limiting, and production logging.

---

## 11. Development rules for future changes

When extending this project:

1. Preserve the existing PDF Chat UI and its dark/light responsive styling unless a UI redesign is explicitly requested.
2. Keep the existing upload field name `pdf` consistent between frontend `FormData` and `upload.single('pdf')` in Express.
3. Keep frontend API paths and backend routes aligned.
4. Keep the embedding model, embedding dimension, and Qdrant collection vector configuration compatible.
5. Preserve the `docId` filter so answers are retrieved from the selected PDF rather than unrelated documents.
6. Do not claim a PDF is permanently stored unless persistent file storage has actually been added.
7. Do not claim document deletion is complete until the corresponding Qdrant points are deleted.
8. Keep secrets in environment variables, never in browser-side code.
9. Test upload, indexing, question answering, switching documents, starting a new document, and reloading the page after changes.
10. Update this README whenever the implementation or deployment architecture changes.

---

## 12. Quick project summary

**PDF RAG Chatbot** is a single-page PDF question-answering application. The frontend uploads a PDF to a Node.js/Express backend. The backend extracts text, splits it into overlapping chunks, generates Gemini embeddings, and stores the chunks in Qdrant. When the user asks a question, the backend embeds the question, retrieves the four most relevant chunks for the selected `docId`, and asks Gemini to answer from that retrieved context. The browser displays the PDF preview and chat side by side and stores document/chat metadata locally.

**Current verified scope from the supplied files:** local Express app, 20 MB PDF upload, text extraction, chunking, Gemini embeddings, Qdrant indexing and retrieval, Gemini answer generation, browser-side document/chat metadata, PDF preview during the upload session, and a responsive chat UI.
