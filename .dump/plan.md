# Plan: Homework Notificator

## Overview

Automated system that scrapes the college homework portal daily at 10am, extracts new assignments, deduplicates via SQLite, and sends WhatsApp notifications through Evolution API. Everything runs locally in Docker.

---

## Phase 1 — Project Scaffold & Docker Setup

### 1.1 Directory Structure

```
homework-notificator-evolutionapi/
├── docker-compose.yml
├── Dockerfile
├── .env
├── .env.example
├── .gitignore
├── tsconfig.json
├── package.json
├── package-lock.json
├── scripts/
│   └── auth-setup.mjs          # Standalone auth capture (runs on host, not in Docker)
├── src/
│   ├── index.ts                # Entry point: cron, health server, startup logic
│   ├── config.ts               # Env vars, validation, defaults
│   ├── db.ts                   # SQLite init, schema, insert, queries
│   ├── scraper.ts              # Playwright: browser lifecycle, navigation, retries
│   ├── parser.ts               # DOM extraction via Playwright locators (no cheerio needed)
│   ├── notifier.ts             # Evolution API REST client, retries
│   ├── mock.ts                 # Mock data generator (when college site is offline)
│   ├── lock.ts                 # File-based lock to prevent concurrent scrapes
│   ├── logger.ts               # Structured JSON logger with run_id
│   ├── health.ts               # Express health + manual trigger endpoints
│   ├── shutdown.ts             # Graceful SIGTERM/SIGINT handler
│   └── types.ts                # Shared TypeScript interfaces
├── data/                       # Mounted volume (persistent)
│   ├── homeworks.db            # SQLite database
│   ├── auth.json               # Browser auth cookies/state (created by auth-setup.mjs)
│   └── snapshots/              # HTML snapshots organized by date
│       └── 2026-08-08/
│           └── page.html
└── .dump/
    ├── research.md
    └── plan.md
```

### 1.2 Config (.env)

```env
# College website (auth endpoint for login, not the homework list itself)
COLLEGE_AUTH_URL=https://api.plataforma.grupoa.education/v2/safea-client/auth/sso/saml
COLLEGE_HOMEWORK_URL=https://plataforma.grupoa.education/homeworks

# Mock mode (true = use fake data, skip real scraping)
USE_MOCK=true
MOCK_SEED_DATE=2026-03-09

# Scheduling
CRON_EXPRESSION=0 10 * * *
TZ=America/Sao_Paulo

# Evolution API
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_API_KEY=your-api-key-here
EVOLUTION_INSTANCE=default

# WhatsApp recipients (comma-separated, country code + number, no "+" or spaces)
# Valid: 5511999999999  Invalid: +55 11 99999-9999
NOTIFY_NUMBERS=5511999999999

# Scraper settings
BROWSER_TIMEOUT_MS=30000
RETRY_MAX=3
RETRY_BACKOFF_MS=30000

# HTML selectors (for real scraping — only needed when USE_MOCK=false)
SELECTOR_CONTAINER=.homework-list > .item
SELECTOR_TITLE=.title
SELECTOR_DUE_DATE=.due-date
SELECTOR_SENTINEL=h1

# Health server
HEALTH_PORT=3000

# Dry run (true = skip Evolution API calls, log what would be sent)
DRY_RUN=true
```

### 1.3 Docker Compose

```yaml
version: '3.8'

services:
  scraper:
    build: .
    container_name: hw-scraper
    restart: unless-stopped
    ports:
      - "${HEALTH_PORT:-3000}:3000"
    volumes:
      - ./data:/app/data
    environment:
      - TZ=${TZ:-America/Sao_Paulo}
    env_file:
      - .env
    init: true
    depends_on:
      evolution-api:
        condition: service_healthy     # Wait until Evolution API is ready
    deploy:
      resources:
        limits:
          memory: 1G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  evolution-api:
    image: atendai/evolution-api:v2.2.0      # Pinned version, not :latest
    container_name: hw-evolution-api
    restart: unless-stopped
    ports:
      - "${EVOLUTION_PORT:-8080}:8080"
    volumes:
      - evolution_instances:/evolution/instances
    environment:
      - AUTHENTICATION_API_KEY=${EVOLUTION_API_KEY}
      - AUTHENTICATION_TYPE=apikey
      - TZ=${TZ:-America/Sao_Paulo}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s

volumes:
  evolution_instances:
```

### 1.4 Dockerfile (Multi-stage)

**Why multi-stage**: `npm ci --omit=dev` removes TypeScript — we can't run `tsc`. A build stage installs all deps + compiles; the runtime stage copies only `dist/` + production deps. This also keeps the final image smaller.

**Why `PLAYWRIGHT_BROWSERS_PATH`**: Playwright installs browsers to `~/.cache/ms-playwright/` by default. A casual `rm -rf /root/.cache` would delete them. Setting `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` isolates browsers from the cache directory.

```dockerfile
# ── Build stage: compile TypeScript ──────────────────────────
FROM node:20-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/

RUN npm ci && npx tsc


# ── Runtime stage: browsers + prod deps only ─────────────────
FROM node:20-bookworm

# System libs required by Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install Chromium to a known path (not ~/.cache so it survives cleanup)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.62.0 install --with-deps chromium && \
    playwright@1.62.0 install-deps chromium

WORKDIR /app

# Copy compiled JS and production node_modules only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]
```

### Expected outcome

- `docker compose up --build` starts both containers
- Scraper boots, initializes SQLite, starts cron scheduler
- Health endpoint responds at `http://localhost:3000/health`
- Evolution API boots at `http://localhost:8080`

---

## Phase 2 — Mock Data & Scraping Engine

### 2.1 Why Mock Data Now

The college site (`plataforma.grupoa.education`) uses SAML SSO and is unreachable during vacation. We cannot test the real scraping flow yet. Mock mode lets us build and verify the entire pipeline (parsing → dedup → notify) end-to-end before the site comes back online.

### 2.2 Mock Module (`src/mock.ts`)

**Design constraint**: If every date is `today + N`, then every new day produces entirely new `(title_hash, due_date)` combinations — dedup _never_ fires across days. The mock must use **seeded static dates** so the same entries are returned day after day, allowing deduplication to be tested realistically.

```typescript
// Mock uses a seed date so entries are stable across days.
// Changing MOCK_SEED_DATE produces a new batch (simulates new semester).
// Default seed: a past Monday so entries span a realistic week window.
const MOCK_SEED_DATE = '2026-03-09'; // configurable via .env

function generateMockHomeworks(seedDate: string): Homework[] {
  const base = new Date(seedDate);

  const entries: Homework[] = [
    { title: 'Lista de exercícios - Cálculo I',      offsetDays: 2 },
    { title: 'Projeto final - Estrutura de Dados',    offsetDays: 3 },
    { title: 'Relatório de laboratório - Física II',  offsetDays: 5 },
    { title: 'Leitura complementar - Programação',    offsetDays: 7 },
  ];

  return entries.map(({ title, offsetDays }) => ({
    title,
    due_date: formatDate(addDays(base, offsetDays)),
    due_time: '23:59',
  }));
}
// All entries always have the SAME due_date every time the function runs.
// Day 1 trigger: 4 new, 0 dup.  Day 2 trigger: 0 new, 4 dup.
// Only changing MOCK_SEED_DATE (new semester) produces new entries.
```

Mock also exposes a helper to generate a **fresh entry** (different seed) so you can manually test the "new homework detected" flow:
```typescript
function generateMockFreshEntry(): Homework {
  return {
    title: `Tarefa extra - ${new Date().toISOString().slice(0, 10)}`,
    due_date: formatDate(addDays(new Date(), 2)),
    due_time: '23:59',
  };
}
```

### 2.3 Scraper Contract (`src/scraper.ts`)

```typescript
interface ScraperResult {
  success: boolean;
  entries: Homework[];
  error?: string;
  snapshotPath?: string;  // path to saved HTML snapshot
  durationMs?: number;
}

async function runScraper(config: Config): Promise<ScraperResult> {
  // 1. If USE_MOCK=true → return mock data immediately
  // 2. Acquire lock (lock.ts), abort if already running
  // 3. Launch browser (launch options: headed=false, args=['--no-sandbox'])
  // 4. Load auth state from data/auth.json if exists; if missing + USE_MOCK=false → log error, abort
  // 5. Navigate to COLLEGE_HOMEWORK_URL
  //    - Retry up to RETRY_MAX with exponential backoff
  //    - On 5xx/timeout → retry
  //    - On 4xx/redirect to login → if auth expired → save error → abort
  // 6. Wait for a sentinel element (page title, navbar, or known container)
  //    to confirm the page loaded correctly. If sentinel is missing → save snapshot → abort.
  // 7. Wait for homework list container selector with page.waitForSelector()
  //    - If timeout → save full HTML snapshot (page.content()) → return error
  // 8. Extract entries using Playwright locators directly (NOT cheerio):
  //    page.locator(HOMEWORK_ITEM_SELECTOR).all() → map each to { title, date, time }
  //    This handles SPA/XHR-loaded content because we wait for the selector first.
  // 9. Save HTML snapshot to data/snapshots/YYYY-MM-DD/page.html
  // 10. Close browser
  // 11. Release lock
  // 12. Return { success, entries, snapshotPath, durationMs }
}
```

### 2.4 Parser Contract (`src/parser.ts`)

Uses Playwright locators directly (not cheerio on `page.content()`). This avoids the SPA problem where data loads via XHR after the initial HTML payload.

```typescript
// Extracts homework data from Playwright locators on the live page.
// Configurable selectors per site, passed via SelectorConfig.
function extractHomeworks(
  items: Locator[],             // page.locator('.hw-item').all()
  selectors: SelectorConfig
): Homework[] {
  // For each locator element:
  //   a. item.locator(selectors.title).textContent()  → normalize
  //   b. item.locator(selectors.date).textContent()   → parseDate()
  //   c. item.locator(selectors.time).textContent()   → optional HH:MM
  // 4. Validate: title.length >= 3, date is valid, time is valid or null
  // 5. Return validated array
}

// Multi-format date parser
function parseDate(raw: string): string | null {
  // Try: DD/MM/YYYY, YYYY-MM-DD, MM/DD/YYYY, "10 de agosto de 2026"
  // Return ISO 8601 or null
}
```

**SelectorConfig** (in `.env` or config file):
```typescript
interface SelectorConfig {
  container: string;     // e.g. '.homework-list > .item'
  title: string;         // e.g. '.title a' or '.homework-title'
  dueDate: string;       // e.g. '.due-date span'
  dueTime: string;       // e.g. '.due-time' (optional)
  sentinel: string;      // e.g. 'h1' or '.page-title' — always present if page loaded
}
```

### Failure modes covered in Phase 2

| Failure | Handling |
|---------|----------|
| Mock mode disabled + site unreachable | Error logged. Pipeline skips notification. Health endpoint shows `last_run_status: "error"` |
| Browser fails to launch | Retry 3x. On final failure → log error, release lock, exit run |
| Auth state expired (redirected to login) | Log "auth expired — needs manual re-auth". Save snapshot. Skip run |
| Auth state file missing (never set up) | Log "Auth state not found. Run `npm run auth:setup` first." Skip run |
| Page load timeout | Retry with increased timeout. Save partial snapshot |
| Sentinel element missing (page broken?) | Save full HTML snapshot. Log ERROR. Abort run — page did not load correctly |
| Zero entries extracted (no assignments posted) | Sentinel is present → page loaded OK → log INFO "No homework entries found". Return empty array (valid). Health shows `entries_found: 0` |
| Zero entries extracted (selectors broken) | Sentinel is present + item container matches 0 elements → log WARNING "Selectors matched nothing — site may have changed". Save snapshot. Return empty array. Health shows `parser_warning: true` |
| HTML changes structure | Snapshots provide historical reference for debugging selector changes |
| Lock file exists (previous run still executing) | Log "run already in progress". Skip silently. Health endpoint shows active run |

---

## Phase 3 — Database & Deduplication

### 3.1 Schema (`src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS homeworks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  title_hash  TEXT    NOT NULL,           -- SHA256 of normalized title for dedup
  due_date    TEXT    NOT NULL,           -- ISO 8601 date
  due_time    TEXT,                       -- HH:MM or NULL
  source_url  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,                       -- NULL = pending, datetime = sent
  notify_status TEXT DEFAULT 'pending',   -- pending | sent | failed | skipped
  notify_error TEXT,                      -- last error message if failed

  UNIQUE(title_hash, due_date)
);

CREATE INDEX IF NOT EXISTS idx_pending ON homeworks(notify_status)
  WHERE notify_status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS scrape_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT    NOT NULL UNIQUE,    -- UUID
  started_at  TEXT    NOT NULL,
  ended_at    TEXT,
  status      TEXT    NOT NULL DEFAULT 'running', -- running | success | error
  entries_found INTEGER DEFAULT 0,
  entries_new   INTEGER DEFAULT 0,
  entries_dup   INTEGER DEFAULT 0,
  error       TEXT,
  snapshot_path TEXT
);
```

### 3.2 DB Module Operations

```typescript
// Called once on startup
function initDb(dbPath: string): void {
  // 1. Open connection
  // 2. Run PRAGMA integrity_check
  //    - If fails → backup corrupt file to data/homeworks.corrupt.YYYYMMDD.db
  //    - Create fresh DB
  // 3. Run CREATE TABLE IF NOT EXISTS
  // 4. Enable WAL mode for better concurrent reads
  // 5. Return connection
}

function insertHomework(db: Database, hw: Homework): InsertResult {
  // 1. Normalize title (trim, collapse whitespace, lowercase)
  // 2. Compute title_hash = SHA256(normalized_title)
  // 3. Validate due_date is valid ISO date
  // 4. INSERT OR IGNORE (SQLite handles UNIQUE constraint)
  // 5. Return { status: 'new' | 'duplicate', id?: number }
}

function getPendingNotifications(db: Database): Homework[] {
  // Return all homeworks where notified_at IS NULL
  // Used when:
  //   a. After scraping, for new entries
  //   b. On startup, to retry failed notifications
  //   c. When Evolution API was down during last run
}

function markNotified(db: Database, id: number, success: boolean, error?: string): void {
  // Update notify_status, notified_at, notify_error
}

function recordScrapeRun(db: Database, run: ScrapeRun): void {
  // Insert new run row, update on completion
}
```

### 3.3 Deduplication Strategy

**Problem**: The same homework assignment appears on the website for multiple days. We must notify only once.

**Solution — Two layers**:

1. **DB-level**: `UNIQUE(title_hash, due_date)` constraint. SQLite rejects duplicates automatically.
2. **App-level normalization**: Before hashing, normalize the title:
   ```
   "  Lista   de Exercícios  -  Cálculo I  "  →  "lista de exercícios - cálculo i"
   ```

**Edge cases handled**:

| Scenario | Behavior |
|----------|----------|
| Same title, same date | Duplicate → skipped |
| Same title, different date | New entry → notified (homework rescheduled) |
| Different title, same date | New entry → notified |
| Title changed slightly (typo, extra space) | After normalization + hash → treated as same title |
| Homework date changed (professor updates it) | Old entry stays with old date. New date = new entry (correct — it's a changed deadline) |

### Failure modes covered in Phase 3

| Failure | Handling |
|---------|----------|
| DB file doesn't exist (first run) | `CREATE TABLE IF NOT EXISTS` handles it |
| DB file corrupted | `PRAGMA integrity_check` on startup → backup + recreate |
| Disk full | SQLITE_FULL error caught → logged → run aborted |
| Concurrent writes | WAL mode allows 1 writer + many readers. Lock file prevents 2 scrapes from writing simultaneously |
| Massive HTML snapshots filling disk | Keep all (user preference). Health endpoint reports `data/snapshots/` size |

---

## Phase 4 — Notification Service

### 4.1 Evolution API Integration (`src/notifier.ts`)

```typescript
interface NotificationResult {
  homeworkId: number;
  success: boolean;
  error?: string;
  statusCode?: number;
}

async function notifyHomework(
  hw: Homework,
  config: Config
): Promise<NotificationResult> {
  // 1. If DRY_RUN=true → log "[DRY RUN] Would send: {title}" → return { success: true }
  // 2. Build message text (UTF-8, emoji allowed by WhatsApp)
  // 3. For each phone number in NOTIFY_NUMBERS (comma-separated):
  //    a. POST to EVOLUTION_API_URL/message/sendText/{instance}
  //    b. Headers: { apikey: EVOLUTION_API_KEY }
  //    c. Body: { number, text }
  //    d. Retry up to 3x with exponential backoff
  //    e. On 4xx → log error, skip this number, continue with next
  //    f. On 5xx/timeout → retry
  // 4. Return aggregated result
}

async function sendPendingNotifications(
  db: Database,
  config: Config
): Promise<number> {
  // Called:
  //   a. After scrape completes (for new entries)
  //   b. On startup (for entries that failed to notify previously)
  // 1. Query homeworks WHERE notify_status IN ('pending', 'failed')
  // 2. For each, call notifyHomework()
  // 3. Update DB (markNotified) after each attempt
  // 4. Return count of successfully sent
}
```

### 4.2 Message Format

```
📚 *Nova tarefa*

*{title}*
📅 Entrega: {formatted_date}
⏰ Horário: {due_time}

🔗 {college_url}
```

`{formatted_date}`: Localized date like "10 de agosto de 2026"

### 4.3 Evolution API Connectivity Check

```typescript
async function checkEvolutionApi(config: Config): Promise<boolean> {
  // GET EVOLUTION_API_URL/instance/connect/{instance}
  // Headers: { apikey: EVOLUTION_API_KEY }
  // Returns: true if connected, false otherwise
  // Called by health endpoint
}
```

### Failure modes covered in Phase 4

| Failure | Handling |
|---------|----------|
| Evolution API container down | Health check before sending. Retry 3x with backoff. Mark entries as `failed` for later retry |
| WhatsApp instance disconnected | Evolution API returns `state: 'close'`. Log warning. Mark as `failed`. Health endpoint shows warning |
| Invalid/no phone numbers configured | Validate on startup. If empty → log WARNING, skip notifications, continue scraping |
| API key rejected (401/403) | Validate on startup. If invalid → log ERROR, skip notifications. Don't crash |
| Rate limited (429) | Sleep for `Retry-After` seconds, retry |
| Network error mid-send | Retry 3x per number. On final failure → mark as `failed`, continue to next number |
| Partial success (some numbers fail) | Track per-number. Overall notification marked `sent` if ≥1 number received it |
| Message too long (>4096 chars) | Truncate title to fit. WhatsApp limit: 4096 chars |
| DRY_RUN=true in production | Startup log makes it explicit: `[DRY RUN] Notifications will NOT be sent` |

---

## Phase 5 — Scheduling & Startup Logic

### 5.1 Startup Flow (`src/index.ts`)

```
main():
  1. Load and validate config (config.ts)
     → Error if required env vars missing → exit(1)

  2. Initialize logger with first run_id
     → Log: "Starting homework-notificator v1.0.0"
     → Log: "Mode: {USE_MOCK ? 'MOCK' : 'LIVE'}"
     → Log: "Dry run: {DRY_RUN}"

  3. Initialize database (db.ts)
     → PRAGMA integrity_check
     → Log: "Database OK"

  4. Start health HTTP server (health.ts)
     → Listen on HEALTH_PORT (3000)
     → Endpoints: GET /health, GET /trigger

  5. Check Evolution API connectivity
     → Log: "Evolution API: {connected ? 'OK' : 'UNREACHABLE'}"

  6. Check for missed run
     → Query scrape_runs for last success
     → If last run > 24h ago OR never ran:
       → Log: "Missed run detected. Running now."
       → executeRun()

  7. Retry pending notifications
     → sendPendingNotifications()
     → Log: "Retried {count} pending notifications"

  8. Start cron scheduler
     → node-cron with CRON_EXPRESSION, timezone TZ
     → Log: "Cron scheduled: {CRON_EXPRESSION} ({TZ})"
     → Log: "Next run: {next_run_time}"

  9. Register graceful shutdown handlers (SIGTERM, SIGINT)
     → Release lock if held
     → Close SQLite connection
     → Close Playwright browser if open
     → Stop Express server
     → Log "Shutdown complete"
     → process.exit(0)

  10. Keep process alive
      → (cron scheduler runs in background)
```

### 5.2 Run Lifecycle (`executeRun`)

```
executeRun():
  1. Generate run_id (UUID v4)
  2. Record run start in scrape_runs table
  3. Acquire lock (lock.ts)
     → If lock held → log "Skipping — previous run in progress" → return
  4. Run scraper (scraper.ts)
     → On error → record run error → release lock → return
  5. Parse extracted entries (parser.ts)
     → Validate each entry
  6. Insert into DB (db.ts)
     → Count: new, duplicates
  7. Send notifications (notifier.ts)
     → For each new entry
  8. Update scrape_runs (success, counts, snapshot_path)
  9. Release lock
  10. Log summary: "{new} new, {dup} duplicates, {sent} notified"
```

### 5.3 Lock File (`src/lock.ts`)

```typescript
// File-based lock using the filesystem (works in Docker)
// Path: /tmp/scraper.lock
// Contains: run_id + timestamp of lock acquisition
// On process exit/crash → OS releases file handle → lock auto-released

function acquireLock(): boolean;      // Returns true if lock acquired
function releaseLock(): void;         // Releases the lock
function getLockInfo(): string | null; // Returns lock holder info or null
```

### Failure modes covered in Phase 5

| Failure | Handling |
|---------|----------|
| Container starts but config is invalid | Exit(1) with clear error message. Docker restarts 3x, then stops |
| Worker crashes (unhandled exception) | `process.on('uncaughtException')` → log → release lock → exit(1). Docker `restart: unless-stopped` brings it back |
| Docker restart after crash | Startup logic checks for missed run → runs immediately |
| Lock file stale (process killed -9) | Lock file contains PID. On acquire, check if process still exists. If not → steal lock |
| Two containers running same compose project | Lock file is local to container filesystem. Each container has its own `/tmp`. Only an issue if 2 instances run against same `./data` volume. Mitigation: health endpoint shows lock state |
| DST transition (clock jumps forward/back) | node-cron uses `tz` database with `TZ` env var. DST transitions handled automatically |
| Cron scheduled but scraper takes >24h | Lock prevents concurrent runs. Next scheduled run detects lock → skips. No missed data because scraper retrieves all current entries |

---

## Phase 6 — Authentication Handling

### 6.1 SAML SSO Login Flow (College Site)

The URL `https://api.plataforma.grupoa.education/v2/safea-client/auth/sso/saml` uses SAML SSO authentication. This means:

1. User navigates to the URL
2. Redirected to SAML identity provider (likely institutional login)
3. User enters credentials
4. Redirected back with auth tokens/cookies
5. Session established

### 6.2 Auth Strategy: Cookie Persistence

**Problem**: The auth setup requires a headed browser (user must visually click through the SAML login). Docker containers don't have a display. Running a headed browser inside Docker requires VNC/noVNC, adding significant complexity.

**Solution**: Auth setup runs on the **host machine** (Windows), not in Docker. A standalone script handles login, and the resulting `auth.json` is saved to the `./data/` volume shared with the container.

**One-time setup** (outside Docker):
```bash
# 1. Install Node.js + Playwright locally (one-time)
npm install playwright

# 2. Run the auth capture script (opens visible browser)
node scripts/auth-setup.mjs

# 3. Log in manually in the browser window that opens
# 4. Script auto-detects login completion and saves data/auth.json
# 5. docker compose up → scraper picks up auth.json via the mounted volume
```

**Auth setup script** (`scripts/auth-setup.mjs` — self-contained, no TypeScript compilation needed):
```javascript
// Standalone ESM script - runs directly with `node` on the host machine.
// No project dependencies needed except playwright.
import { chromium } from 'playwright';

// Config hardcoded or read from .env via process.env
const AUTH_URL = process.env.COLLEGE_AUTH_URL;
const HOMEWORK_URL = process.env.COLLEGE_HOMEWORK_URL;

async function setupAuth() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(AUTH_URL);

  // Wait for user to complete SAML login (detect redirect to dashboard)
  console.log('Waiting for login... (complete the login in the browser window)');
  await page.waitForURL(url => url.startsWith(HOMEWORK_URL), { timeout: 300_000 });

  // Save cookies + localStorage to shared volume
  await context.storageState({ path: 'data/auth.json' });
  console.log('✅ Auth saved to data/auth.json');

  await browser.close();
}

setupAuth().catch(err => { console.error(err); process.exit(1); });
```

**Reusing auth in the Docker container** (inside scraper.ts):
```typescript
// Load auth state from the mounted volume
const context = await browser.newContext({
  storageState: path.join(config.dataDir, 'auth.json'),
});
```

### 6.3 Auth Expiry Handling

- On each scrape, after navigation, check if we land on login page (URL contains `/auth/` or `/sso/`)
- If redirected to login → auth expired → log ERROR → save snapshot → abort
- Manual re-auth needed (run `npm run auth:setup` again)
- Health endpoint shows `auth_valid: false`

### 6.4 Mock Mode as Permanent Bypass

Since the site is frequently offline (vacations, maintenance), mock mode is a permanent feature:
- `USE_MOCK=true` → skips authentication entirely, uses fake data
- `USE_MOCK=false` → real scraping with auth
- Configurable per-environment, no code changes needed

---

## Phase 7 — Observability & Operations

### 7.1 Health Endpoint (`GET /health`)

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "mode": "MOCK",
  "dry_run": false,
  "auth": {
    "valid": true,
    "file_exists": true
  },
  "database": {
    "ok": true,
    "total_homeworks": 42,
    "pending_notifications": 0
  },
  "evolution_api": {
    "reachable": true,
    "instance_connected": true
  },
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
  "lock": {
    "active": false
  }
}
```

### 7.2 Manual Trigger (`GET /trigger`)

```json
{
  "triggered": true,
  "run_id": "def-456",
  "message": "Scrape started. Check /health for results."
}
```
If already running: `{ "triggered": false, "message": "Run already in progress. Run ID: abc-123" }`

### 7.3 Logging (`src/logger.ts`)

All logs structured as JSON, one line per event:
```json
{"level":"INFO","ts":"2026-08-08T10:00:05-03:00","run_id":"abc-123","msg":"Scrape started","url":"https://..."}
{"level":"INFO","ts":"2026-08-08T10:00:12-03:00","run_id":"abc-123","msg":"Scrape completed","new":2,"dup":3,"duration_ms":7000}
{"level":"WARN","ts":"2026-08-08T10:00:10-03:00","run_id":"abc-123","msg":"Auth expired, re-auth required"}
{"level":"ERROR","ts":"2026-08-08T10:00:11-03:00","run_id":"abc-123","msg":"Evolution API unreachable","err":"ECONNREFUSED"}
```

View with: `docker logs hw-scraper -f`

### 7.4 Snapshot Management

All HTML snapshots kept indefinitely (user preference, negligible storage for text HTML):
```
data/snapshots/
├── 2026-08-08/
│   └── page.html
├── 2026-08-09/
│   └── page.html
└── 2026-08-10/
    └── page.html
```
Health endpoint reports total snapshot directory size.

---

## Phase 8 — Testing Strategy

### 8.1 Mock Mode Full Pipeline Test

1. Set `USE_MOCK=true`, `DRY_RUN=true`
2. `docker compose up --build`
3. Hit `GET /trigger` to run a scrape
4. Check `/health` → should show 4 entries found, 4 new, 0 duplicates
5. Hit `GET /trigger` again
6. Check `/health` → should show 4 entries found, 0 new, 4 duplicates
7. Check logs → should show "[DRY RUN] Would send: Lista de exercícios..."

### 8.2 Persistence Test

1. Run mock scrape (creates entries in DB)
2. `docker compose down`
3. `docker compose up`
4. Hit `GET /trigger`
5. All entries should be duplicates (DB persisted across restarts)

### 8.3 Notification Test (with Evolution API)

1. Set `DRY_RUN=false`, `USE_MOCK=true`
2. Ensure Evolution API container is running and WhatsApp is connected (QR scanned)
3. Hit `GET /trigger`
4. WhatsApp should receive messages for new entries

### 8.4 Real Scrape Test (when site is live)

1. Run `npm run auth:setup` to capture login cookies
2. Set `USE_MOCK=false`, `DRY_RUN=true`
3. Hit `GET /trigger`
4. Verify entries are extracted from real HTML
5. Check snapshot saved to `data/snapshots/YYYY-MM-DD/`

---

## Dependency Summary

### npm packages

```
prod:
  playwright                     # Browser automation (Chromium)
  better-sqlite3                 # SQLite driver
  node-cron                      # Cron scheduler
  express                        # Health HTTP server
  uuid                           # Run ID generation
  dotenv                         # .env loading

dev:
  typescript                     # TypeScript compiler
  @types/node                    # Node.js type definitions
  @types/better-sqlite3          # SQLite type definitions
  @types/node-cron               # node-cron type definitions
  @types/express                 # Express type definitions
  @types/uuid                    # UUID type definitions
  tsx                            # TypeScript execution (dev)
```

---

## Timeline & Implementation Order

| Phase | What | Prerequisites |
|-------|------|--------------|
| **Phase 1** | Docker setup, TypeScript config, .env, scaffolding | None |
| **Phase 2** | Mock data module, scraper with browser launch + retries | Phase 1 |
| **Phase 3** | SQLite schema, DB module, insert/dedup logic | Phase 2 |
| **Phase 4** | Evolution API client, notification sending, retry logic | Phase 3 |
| **Phase 5** | Cron scheduler, startup logic, lock file, health endpoints | Phase 4 |
| **Phase 6** | Auth capture script, cookie persistence, expiry detection | Phase 1 (runs independently) |
| **Phase 7** | Health endpoint, logging, manual trigger | Phase 5 |
| **Phase 8** | End-to-end testing with mock + dry-run | All |
| **Future** | Real parser when site comes back online | Phase 6 + real HTML |

---

## Open Questions & Future Work

1. **Parser selectors**: The real CSS selectors for the college site's homework list can only be determined when the site is live and we can inspect the DOM. The parser module (`parser.ts`) accepts configurable selectors so this is a configuration change, not code change.

2. **SAML redirect chain**: The exact SAML flow (how many redirects, which identity provider) is unknown until we hit the live site. The auth setup script uses headed mode so the user can follow the flow visually.

3. **Evolution API WhatsApp number**: The phone number used for WhatsApp must have an active WhatsApp account. Evolution API's QR scan connects one number per instance.
