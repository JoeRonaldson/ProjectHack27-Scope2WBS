# WBS Workflow (TypeScript + React + npm)

This app is structured so model connectivity is configurable from environment variables (no code edits needed):

- **Backend:** Express + OpenAI API (`server`)
- **Frontend:** React + Vite (`src`)
- **Single container runtime:** serves API and built React app

Model access is modularized under:

- `server/model-config.ts` (env + runtime config)
- `server/model-adapters.ts` (provider-specific API adapters)
- `server/model-client.ts` (provider-agnostic entrypoint used by workflow)

## 1) Setup

```bash
npm install
cp .env.example .env
```

Then set your key in `.env`:

```env
MODEL_PROVIDER=openai
MODEL_API_STYLE=responses
MODEL_NAME=gpt-5-mini
MODEL_API_KEY=your_openai_api_key
MODEL_BASE_URL=

# Optional legacy aliases (still supported)
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_SYSTEM_PROMPT=
PORT=3000
```

### Model configuration options

The backend now reads model settings from a dedicated config layer:

- `MODEL_PROVIDER`: `openai` or `openai-compatible`
- `MODEL_API_STYLE`: `responses` or `chat-completions`
- `MODEL_NAME`: model ID to send in API requests
- `MODEL_API_KEY`: API key or token (can be blank for local servers that do not require auth)
- `MODEL_BASE_URL`: required for `openai-compatible` (example: `https://my-cloud-gpu-server.example.com/v1`)

Defaults:

- `openai` defaults to `MODEL_API_STYLE=responses`
- `openai-compatible` defaults to `MODEL_API_STYLE=chat-completions`

Backwards compatibility:

- `OPENAI_API_KEY` still works if `MODEL_API_KEY` is not set
- `OPENAI_MODEL` still works if `MODEL_NAME` is not set

### Pointing to a cloud-hosted local model server

If your local model is hosted on another cloud server and exposes an OpenAI-compatible API (for example via vLLM, Ollama + proxy, LM Studio server, or similar), set:

```env
MODEL_PROVIDER=openai-compatible
MODEL_API_STYLE=chat-completions
MODEL_NAME=qwen2.5-coder-32b-instruct
MODEL_API_KEY=optional-token-if-your-server-requires-it
MODEL_BASE_URL=https://my-cloud-gpu-server.example.com/v1
```

Then restart the app:

```bash
npm run dev
```

Quick verification:

- `GET /api/health` now returns active model config metadata (`provider`, `model`, `baseURL`)

## 2) Local development

Run backend + frontend dev servers together:

```bash
npm run dev
```

- App (single dev URL): `http://localhost:3000`
- Backend API runs internally on `http://localhost:3001` and is proxied via `/api`
- Health check: `GET /api/health`
- Workflow endpoint: `POST /api/workflow`

## 3) Build and run

```bash
npm run build
npm run start
```

`npm run start` serves:

- Built React app from `dist-client`
- API from `dist-server`

## 4) Docker

Build image:

```bash
docker build -t wbs-workflow-app .
```

Run container:

```bash
docker run --rm -p 3000:3000 --env-file .env wbs-workflow-app
```

Open:

- `http://localhost:3000`

## 5) API format

`POST /api/workflow`

Request:

```json
{
  "input": "your scope text",
  "systemPrompt": "optional custom prompt",
  "model": "optional model name"
}
```

Response:

```json
{
  "outputText": "raw model output",
  "mermaidCode": "graph TD ...",
  "wbsRows": [
    { "level": 1, "code": "1", "name": "Project WBS" }
  ]
}
```
