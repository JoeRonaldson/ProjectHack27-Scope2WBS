# WBS Workflow (TypeScript + React + npm)

This app is now fully migrated to a TypeScript/npm stack:

- **Backend:** Express + OpenAI API (`server`)
- **Frontend:** React + Vite (`src`)
- **Single container runtime:** serves API and built React app

## 1) Setup

```bash
npm install
cp .env.example .env
```

Then set your key in `.env`:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5-mini
OPENAI_SYSTEM_PROMPT=
PORT=3000
```

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
