# Homework Notificator

<p align="center">
  <strong>Automated college homework scraper with WhatsApp notifications via Evolution API</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Playwright-1.62-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white" alt="Docker">
</p>

---

## Overview

Scrapes the college homework portal daily at 10:00 AM, extracts new assignments, deduplicates via SQLite, and sends formatted WhatsApp notifications through Evolution API. Everything runs locally in Docker.

```
┌─────────────┐     ┌──────────┐     ┌────────────────┐     ┌───────────┐
│  College    │────▶│  Scraper │────▶│    SQLite      │────▶│ WhatsApp  │
│  Portal     │     │ (daily)  │     │  (dedup + DB)  │     │ (message) │
└─────────────┘     └──────────┘     └────────────────┘     └───────────┘
       ▲                                 │                        │
       │                                 │                        │
       └─── HTML snapshots ──────────────┘                        │
            (debugging)                            ┌───────────────┘
                                                   │
                                          ┌────────▼───────┐
                                          │  Evolution API │
                                          │  (Docker)      │
                                          └────────────────┘
```

## Features

- **Mock mode** — Generate fake homework data when the college site is unreachable (holidays, vacations). Still tests the full pipeline end-to-end
- **SQLite deduplication** — `UNIQUE(title_hash, due_date)` constraint prevents duplicate notifications. Same homework for multiple days is only sent once
- **Dry run** — Log what *would* be sent without actually hitting the Evolution API. Perfect for testing
- **Cron scheduling** — Configurable cron expression, runs automatically every day
- **Health endpoint** — `GET /health` returns full system status (DB state, last run, Evolution API connectivity, lock status)
- **Manual trigger** — `GET /trigger` to force a scrape run on-demand
- **HTML snapshots** — Page HTML archived by date for debugging selector issues without re-scraping
- **Persistent DB** — SQLite database mounted as a Docker volume, survives container restarts
- **File-based lock** — Prevents concurrent scrapes (stale lock detection included)
- **Graceful shutdown** — Cleanup on SIGTERM/SIGINT: releases lock, closes DB, stops browser
- **Structured JSON logging** — Every log line is JSON with `run_id` context, compatible with log aggregators
- **Evolution API integration** — REST client with retry logic, connectivity check, and per-recipient error handling

## Prerequisites

- **Docker** and Docker Compose
- **Node.js 20+** (only needed for one-time auth setup — not inside Docker)
- **WhatsApp number** with an active account (for Evolution API)

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url>
cd homework-notificator-evolutionapi
cp .env.example .env
```

Edit `.env` — at minimum, set `EVOLUTION_API_KEY` and `NOTIFY_NUMBERS`.

### 2. Start services

```bash
docker compose up -d
```

This starts both containers:
- `hw-scraper` — The notificator app (port 3000)
- `hw-evolution-api` — Evolution API gateway (port 8080)

### 3. Connect WhatsApp

1. Open `http://localhost:8080` in your browser
2. Navigate to the instance manager
3. Scan the QR code with your WhatsApp mobile app
4. Once connected, the Evolution API is ready

### 4. Verify health

```bash
curl http://localhost:3000/health
```

Expected response (mock mode, dry run):

```json
{
  "status": "ok",
  "mode": "MOCK",
  "dry_run": true,
  "database": { "ok": true, "total_homeworks": 4, "pending_notifications": 0 },
  "evolution_api": { "reachable": true, "instance_connected": true },
  "last_run": { "status": "success", "entries_found": 4, "entries_new": 4, "entries_dup": 0 },
  "lock": { "active": false }
}
```

### 5. Trigger first scrape

```bash
curl http://localhost:3000/trigger
```

Check `/health` again — you should see `total_homeworks: 4` and `entries_new: 4`.

### 6. Switch to production

Once you confirm the pipeline works end-to-end:

```env
# .env
USE_MOCK=false
DRY_RUN=false
```

## Configuration

| Variable | Default | Required | Description |
|---|---|---|---|
| `COLLEGE_AUTH_URL` | `https://api.plataforma.grupoa.education/v2/safea-client/auth/sso/saml` | No | SAML SSO auth endpoint |
| `COLLEGE_HOMEWORK_URL` | `https://plataforma.grupoa.education/homeworks` | No | Homework list page |
| `USE_MOCK` | `true` | No | Use fake data instead of real scraping |
| `MOCK_SEED_DATE` | `2026-03-09` | No | Base date for mock homework generation |
| `CRON_EXPRESSION` | `0 10 * * *` | No | Cron schedule (default: daily at 10 AM) |
| `TZ` | `America/Sao_Paulo` | No | Timezone for cron and logs |
| `EVOLUTION_API_URL` | `http://evolution-api:8080` | No | Evolution API base URL |
| `EVOLUTION_API_KEY` | — | **Yes** | API key for Evolution API authentication |
| `EVOLUTION_INSTANCE` | `default` | No | WhatsApp instance name |
| `NOTIFY_NUMBERS` | — | **Yes** | Comma-separated phone numbers (e.g., `5511999999999`) |
| `PLAYWRIGHT_VERSION` | `1.62.0` | No | Playwright version to install |
| `BROWSER_TIMEOUT_MS` | `30000` | No | Page load timeout in milliseconds |
| `RETRY_MAX` | `3` | No | Max retries for failed page loads |
| `RETRY_BACKOFF_MS` | `30000` | No | Delay between retries in milliseconds |
| `SELECTOR_CONTAINER` | `.homework-list > .item` | No | CSS selector for homework items |
| `SELECTOR_TITLE` | `.title` | No | CSS selector for title within item |
| `SELECTOR_DUE_DATE` | `.due-date` | No | CSS selector for due date |
| `SELECTOR_SENTINEL` | `h1` | No | CSS selector always present on page (load check) |
| `HEALTH_PORT` | `3000` | No | Health HTTP server port |
| `DRY_RUN` | `true` | No | Skip Evolution API calls, only log messages |

**Phone number format:** Country code + area code + number, no `+`, spaces, dashes, or parentheses.

```
Valid:   5511999999999
Invalid: +55 11 99999-9999
```

## Authentication Setup

The college site uses SAML SSO authentication. Auth runs on your **host machine** (Windows) since Docker can't display a browser.

### One-time setup

```bash
npm install                   # Already done if you cloned the repo
npm run auth:setup
```

1. A visible Chromium window opens at the college login page
2. Log in manually (SAML SSO redirects handled automatically)
3. The script detects login completion and saves `data/auth.json`
4. `docker compose up` — the scraper picks up `auth.json` via the mounted volume

### Auth expiry

- If the scraper detects it's redirected to the login page → logs `"Auth expired"`, saves a snapshot, and aborts the run
- Re-run `npm run auth:setup` to refresh
- Health endpoint shows `auth.valid: false` when expired

## API Endpoints

### `GET /health`

Full system status report:

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "mode": "MOCK",
  "dry_run": false,
  "auth": { "valid": true, "file_exists": true },
  "database": { "ok": true, "total_homeworks": 42, "pending_notifications": 0 },
  "evolution_api": { "reachable": true, "instance_connected": true },
  "scheduler": {
    "cron_expression": "0 10 * * *",
    "timezone": "America/Sao_Paulo",
    "next_run": "2026-08-09T10:00:00-03:00"
  },
  "last_run": {
    "run_id": "abc-123",
    "started_at": "2026-08-08T10:00:05-03:00",
    "ended_at": "2026-08-08T10:00:12-03:00",
    "status": "success",
    "entries_found": 5,
    "entries_new": 2,
    "entries_dup": 3,
    "duration_ms": 7000,
    "parser_warning": false
  },
  "lock": { "active": false }
}
```

### `GET /trigger`

Manually triggers a scrape run:

```json
{
  "triggered": true,
  "run_id": "def-456",
  "message": "Scrape started. Check /health for results."
}
```

If a run is already in progress:

```json
{
  "triggered": false,
  "message": "Run already in progress. Run ID: abc-123"
}
```

## Testing

### Mock pipeline test (dry run)

```bash
# .env: USE_MOCK=true, DRY_RUN=true
docker compose up -d

# First scrape — should find 4 new entries
curl http://localhost:3000/trigger
curl http://localhost:3000/health  # entries_found: 4, entries_new: 4, entries_dup: 0

# Second scrape — all duplicates
curl http://localhost:3000/trigger
curl http://localhost:3000/health  # entries_found: 4, entries_new: 0, entries_dup: 4

# Check logs for [DRY RUN] messages
docker logs hw-scraper
```

### Persistence test

```bash
# Run mock scrape, then restart
docker compose down
docker compose up -d
curl http://localhost:3000/trigger
curl http://localhost:3000/health  # total_homeworks: 4 (persisted), entries_dup: 4
```

### Notification test (with Evolution API)

```bash
# .env: DRY_RUN=false, USE_MOCK=true
# Ensure Evolution API container runs and WhatsApp is connected (QR scanned)
curl http://localhost:3000/trigger
# WhatsApp should receive messages for new entries
```

### Real scraping test (when college site is live)

```bash
npm run auth:setup              # Capture login cookies
# .env: USE_MOCK=false, DRY_RUN=true
docker compose up -d
curl http://localhost:3000/trigger
curl http://localhost:3000/health  # Verify entries extracted from real HTML
# Check snapshot: data/snapshots/YYYY-MM-DD/page.html
```

## Project Structure

```
homework-notificator-evolutionapi/
├── docker-compose.yml              # Scraper + Evolution API services
├── Dockerfile                      # Multi-stage (build TS + runtime Playwright)
├── .env / .env.example             # Configuration
├── .gitignore
├── tsconfig.json
├── package.json
├── scripts/
│   └── auth-setup.mjs              # Standalone SAML auth capture (host machine)
├── src/
│   ├── index.ts                    # Entry point: cron, health server, startup flow
│   ├── config.ts                   # Env loading, validation, defaults
│   ├── types.ts                    # Shared TypeScript interfaces
│   ├── logger.ts                   # Structured JSON logger with run_id context
│   ├── db.ts                       # SQLite init, schema, insert, dedup queries
│   ├── lock.ts                     # File-based lock to prevent concurrent scrapes
│   ├── scraper.ts                  # Playwright browser lifecycle, navigation, retries
│   ├── parser.ts                   # Date parsing utilities (multi-format)
│   ├── mock.ts                     # Seeded mock homework generator
│   ├── notifier.ts                 # Evolution API REST client, message formatting
│   ├── health.ts                   # Express health + manual trigger endpoints
│   └── shutdown.ts                 # Graceful SIGTERM/SIGINT handler
├── data/                           # Mounted volume (persistent)
│   ├── homeworks.db                # SQLite database
│   ├── auth.json                   # Browser auth cookies/session state
│   └── snapshots/
│       └── YYYY-MM-DD/
│           └── page.html           # HTML snapshot for debugging
└── dist/                           # Compiled JavaScript (gitignored)
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot-reload via tsx)
npm run dev

# Compile TypeScript
npm run build

# Run compiled output (requires build first)
npm run start

# Capture authentication cookies (headed browser)
npm run auth:setup
```

## Logging

All logs are structured JSON, one line per event. View with:

```bash
docker logs hw-scraper -f
```

Example log lines:

```json
{"level":"INFO","ts":"2026-08-08T10:00:05-03:00","run_id":"abc-123","msg":"Scrape started","url":"https://plataforma.grupoa.education/homeworks"}
{"level":"INFO","ts":"2026-08-08T10:00:12-03:00","run_id":"abc-123","msg":"Scrape completed","new":2,"dup":3,"duration_ms":7000}
{"level":"WARN","ts":"2026-08-08T10:00:10-03:00","run_id":"abc-123","msg":"Auth expired, re-auth required"}
{"level":"ERROR","ts":"2026-08-08T10:00:11-03:00","run_id":"abc-123","msg":"Evolution API unreachable","err":"ECONNREFUSED"}
```

## Failure Modes

| Scenario | Behavior |
|---|---|
| College site unreachable (mock disabled) | Error logged, pipeline skips notifications. Health shows `last_run_status: "error"` |
| Auth state expired or missing | Logged, snapshot saved, run aborted. Shows `auth.valid: false` on health |
| Page structure changed (selectors broken) | Sentinel found but no items extracted → warning logged, snapshot saved |
| Evolution API down | Retry 3x with exponential backoff. Entries marked as `failed` for later retry |
| WhatsApp instance disconnected | Evolution API returns `state: "close"`. Entries marked as `failed` |
| Rate limited (429) | Sleeps for `Retry-After` seconds, retries |
| Concurrent scrape attempt | Lock file prevents concurrent runs. Second run logs `"Skipping — previous run in progress"` |
| Container crash | Docker `restart: unless-stopped` brings it back. Startup checks for missed runs |
| DB file corrupted | `PRAGMA integrity_check` on startup detects corruption, backs up corrupt file, recreates fresh DB |

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | Node.js + TypeScript | First-class Playwright support, type safety |
| Data extraction | HTML DOM parsing | Structured data, no OCR needed |
| Database | SQLite | Zero config, single file, perfect for <1MB data |
| Deduplication | `UNIQUE(title_hash, due_date)` | DB-level guarantee with normalized title hashing |
| Scheduling | node-cron | Single container, cron syntax |
| Messaging | Evolution API | Open-source WhatsApp gateway, REST API |
| Docker image | Custom (`node:20-bookworm` + Chromium) | Smaller than official Playwright image, only Chromium |
| Storage | Host-mounted `./data` volume | Easy access, persistent across rebuilds |
| Auth setup | Host machine (headed browser) | SAML SSO requires visual interaction, Docker has no display |

## License

MIT
