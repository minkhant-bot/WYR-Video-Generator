# WYR Video Generator

A standalone single-user web app that creates 8-scene, 1080×1920 Would You Rather videos with Groq-generated content, Pexels photos, Edge TTS narration, local sound effects, and FFmpeg rendering.

## Requirements

- Node.js 20 or newer
- Network access for Groq, Pexels, Edge TTS, and npm installation
- `GROQ_API_KEY` and `PEXELS_API_KEY` for real generation, supplied through the Settings UI or environment variables

The app prefers system `ffmpeg` and `ffprobe`. The npm dependencies provide portable fallbacks. You may explicitly set `FFMPEG_PATH` and `FFPROBE_PATH`. The project bundles GNU FreeFont Bold under its GPLv3 font exception; `WYR_FONT_PATH` can select another compatible font file.

## Setup

```bash
npm ci
cp .env.example .env.local
```

Open the Settings section in the web UI to save both API keys locally. They are written atomically to the ignored `.wyr-secrets.json` file with restrictive permissions. The browser receives configuration status only, never the saved values. `GROQ_API_KEY` and `PEXELS_API_KEY` environment variables remain supported and take precedence over saved values. The app does not automatically load `.env.local`; export those variables or use a process manager that loads the file.

## Commands

```bash
npm start       # Web UI and API on port 3100 by default
npm run generate # One real provider-backed command-line generation
npm run fixture  # Full local 8-scene fixture render; no provider keys required
npm test         # WYR unit tests
```

Open `http://localhost:3100` after starting the server. For a credential-free server smoke test, launch with `WYR_FIXTURE_MODE=true npm start`.

Job workspaces default to `data/wyr-jobs`; fixture output defaults to `data/wyr-fixture-job`. Relative paths in `WYR_JOBS_DIR`, `WYR_FIXTURE_DIR`, `FFMPEG_PATH`, and `FFPROBE_PATH` resolve from the project root, not the current shell directory.

Accepted production dilemmas and recently used categories are stored atomically in `WYR_CONTENT_HISTORY_DIR/history.json` (default: ignored `data/content-history/history.json`). Set `WYR_CONTENT_HISTORY_DIR` to a mounted Railway persistent-volume directory, such as `/data/wyr-content-history`, to preserve duplicate prevention across redeployments. Without a persistent volume, history survives normal server restarts on the same filesystem but cross-deployment retention cannot be guaranteed. `WYR_CONTENT_GENERATION_RETRIES` bounds automatic replacement attempts; a job fails clearly instead of rendering if eight strong, distinct dilemmas cannot be accepted. Groq HTTP 429 recovery has a separate bounded policy: `WYR_GROQ_RATE_LIMIT_RETRIES` defaults to 4 retries and `WYR_GROQ_RATE_LIMIT_MAX_WAIT_MS` defaults to 60000 milliseconds of cumulative waiting. A server-provided `Retry-After` value is honored when it fits within that budget; otherwise the job fails with a rate-limit-specific error.

For isolated testing, `WYR_SECRET_CONFIG_PATH` can select another local credential file. Relative paths resolve from the project root; ensure any custom path is excluded from version control.

Railway production concurrency is bounded and configurable with `WYR_PEXELS_CONCURRENCY` (default 4), `WYR_TTS_CONCURRENCY` (default 4), `WYR_SCENE_RENDER_CONCURRENCY` (default 2), and `WYR_FFMPEG_THREADS` (default 4). Pexels selection remains centrally deduplicated, voiceovers and rendered scenes retain source order, and the FFmpeg thread limit applies only to H.264 scene encoding.

Pexels remains the primary image source. When its candidates fail the relevance gate, the optional `WYR_WEB_IMAGE_FALLBACK=true` path uses the free DuckDuckGo Images web-wide index with bounded, serial requests. If DuckDuckGo is blocked or has no usable result, the selector falls back to the best valid Pexels candidate. DuckDuckGo Images is an unofficial fallback and may be unavailable from Railway datacenter IPs. Web results are not assumed to be copyright-free: their source page and domain are retained, and unavailable rights metadata is recorded as `unknown` for review before reuse.

## Visual reference

`reference/would-you-rather-reference.mp4` is retained as the visual source of truth. Runtime rendering uses the encoded template configuration and does not read the reference file.
