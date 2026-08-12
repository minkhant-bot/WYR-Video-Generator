# WYR Video Generator

A standalone single-user web app that creates 8-scene, 1080×1920 Would You Rather videos with Groq-generated content, Pexels photos, Edge TTS narration, local sound effects, and FFmpeg rendering.

## Requirements

- Node.js 20 or newer
- Network access for Groq, Pexels, Edge TTS, and npm installation
- `GROQ_API_KEY` and `PEXELS_API_KEY` for real generation

The app prefers system `ffmpeg` and `ffprobe`. The npm dependencies provide portable fallbacks. You may explicitly set `FFMPEG_PATH` and `FFPROBE_PATH`. The project bundles GNU FreeFont Bold under its GPLv3 font exception; `WYR_FONT_PATH` can select another compatible font file.

## Setup

```bash
npm ci
cp .env.example .env.local
```

The app reads environment variables from its process; it does not automatically load `.env.local`. Export the required values or use a process manager that loads the file.

## Commands

```bash
npm start       # Web UI and API on port 3100 by default
npm run generate # One real provider-backed command-line generation
npm run fixture  # Full local 8-scene fixture render; no provider keys required
npm test         # WYR unit tests
```

Open `http://localhost:3100` after starting the server. For a credential-free server smoke test, launch with `WYR_FIXTURE_MODE=true npm start`.

Job workspaces default to `data/wyr-jobs`; fixture output defaults to `data/wyr-fixture-job`. Relative paths in `WYR_JOBS_DIR`, `WYR_FIXTURE_DIR`, `FFMPEG_PATH`, and `FFPROBE_PATH` resolve from the project root, not the current shell directory.

## Visual reference

`reference/would-you-rather-reference.mp4` is retained as the visual source of truth. Runtime rendering uses the encoded template configuration and does not read the reference file.
