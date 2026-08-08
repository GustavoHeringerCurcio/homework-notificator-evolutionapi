# Research: Homework Notificator

## 1. Playwright in Docker

### Official Docker Images
Microsoft publishes official Playwright Docker images with all browsers and system dependencies pre-installed:

- **Node.js image**: `mcr.microsoft.com/playwright:v1.62.0-noble` (Ubuntu 24.04 LTS)
- **Python image**: `mcr.microsoft.com/playwright/python:v1.61.0-noble`
- Both include Chromium, Firefox, and WebKit with all required system libs
- Alpine-based images are NOT supported (browsers require glibc, not musl)

### Key Docker Flags (required for stability)
```
--ipc=host         # Prevents Chromium OOM crashes (shared memory)
--init             # Avoids zombie processes (proper PID 1 handling)
--cap-add=SYS_ADMIN # If seeing weird Chrome launch errors locally
```

### Building Custom Image
Alternative to the pre-built image — useful for smaller footprint:
```dockerfile
FROM node:20-bookworm
RUN npx -y playwright@1.62.0 install --with-deps chromium
```
This installs only Chromium (not all 3 browsers), reducing image size significantly.

### Screenshots vs HTML Extraction
| Approach | Pros | Cons |
|----------|------|------|
| **Screenshot (PNG)** | Visual evidence of what was on screen | Requires OCR (Tesseract), error-prone, hard to parse structured data |
| **HTML text extraction** | Structured data, reliable parsing, no OCR needed | Relies on DOM selectors (page redesign breaks them) |

**Decision**: Use HTML text extraction. Playwright can read `element.textContent()`, `element.getAttribute()`, or evaluate JS in the page context to grab structured data directly. This avoids OCR entirely and makes deduplication trivial.

---

## 2. Lightweight Database: SQLite

### Why SQLite
- **Zero administration**: No server process, no ports, no config files
- **Single file**: The entire database is one file (`homeworks.db`)
- **Perfect for this use case**: Low concurrency (1 writer at a time), local storage, <1MB of data
- **Deduplication at DB level**: `UNIQUE` constraints prevent duplicate entries natively
- **Built into many languages**: Python has `sqlite3` in stdlib; Node.js has `better-sqlite3`

### Node.js Driver: better-sqlite3
- Synchronous API (simpler for scripts, no async/await overhead)
- 2-5x faster than async alternatives for single-connection workloads
- Native C++ bindings, tiny footprint
- npm package: `better-sqlite3`

### Schema Design
```sql
CREATE TABLE IF NOT EXISTS homeworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,      -- ISO 8601 date: '2026-08-10'
  due_time TEXT,               -- optional time: '23:59'
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  notified_at TEXT,            -- when WhatsApp was sent
  UNIQUE(title, due_date)      -- dedup: same homework + same date = skip
);
```

### When NOT to use SQLite
- High-concurrency writes → use PostgreSQL/MySQL
- Data accessed over network by multiple clients → client/server DB
- Datasets >1TB → not applicable here

**Our use case hits none of these limitations. SQLite is the right choice.**

---

## 3. Cron in Docker

### Approach Comparison

| Approach | How It Works | Pros | Cons |
|----------|-------------|------|------|
| **Host cron + `docker run`** | OS scheduler (cron/task scheduler) runs container on schedule | Separation of concerns, uses battle-tested OS scheduler | Coupled to host, need Docker on host, manual setup per machine |
| **`node-cron` (npm)** | In-process Node.js scheduler inside the container | Single container, self-contained, no external deps | Container must run 24/7, cron syntax, PID 1 considerations |
| **`supercronic`** | Standalone cron binary, crontab-compatible | Standard crontab syntax, proper signal handling | Extra binary in container |
| **`ofelia` (Docker)** | Separate Docker container that triggers other containers | Cleanest separation, docker-native | Extra container, more complex docker-compose |
| **Simple `setInterval`** | Plain JS polling loop | No dependencies, dead simple | No cron syntax, must calculate next run manually |

### Decision: `node-cron`
- Single container keeps the architecture simple
- Container runs 24/7 (minimal resource usage when idle)
- cron expression: `0 10 * * *` (every day at 10:00 AM)
- Uses `node-cron` npm package (~50KB, no native deps)

---

## 4. Evolution API (WhatsApp Gateway)

### What It Is
The Evolution API is an open-source (Apache 2.0) WhatsApp Business API gateway. It allows sending/receiving WhatsApp messages via a REST API, managing multiple WhatsApp instances programmatically.

### How It Works
1. You run the Evolution API Docker container
2. You connect a WhatsApp number by scanning a QR code (one-time setup)
3. After connection, you send messages via REST API:
```
POST /message/sendText/{instance}
{
  "number": "5511999999999",
  "text": "New homework: Math Assignment due 2026-08-10"
}
```

### Docker Setup
```yaml
# Official Docker image
evolution-api:
  image: atendai/evolution-api:latest
  ports:
    - "8080:8080"
  volumes:
    - evolution_instances:/evolution/instances
  environment:
    - AUTHENTICATION_API_KEY=your-secret-key
```

### Notes
- Evolution API is a separate container from our scraper
- Communication is via HTTP REST from scraper → evolution-api
- The WhatsApp number must stay connected (phone with WhatsApp must be online)
- Evolution API handles message queuing, retries, and connection management

---

## 5. Screenshot/Print Storage Strategy

### Option A: Host-mounted volume
```yaml
volumes:
  - ./data/screenshots:/app/data/screenshots
```
- Files stored on host machine, accessible outside container
- Persists across container rebuilds/restarts
- Can organize by date: `screenshots/2026-08-08/page.png`

### Option B: Docker named volume
```yaml
volumes:
  - screenshot_data:/app/data/screenshots
```
- Managed by Docker, harder to inspect directly
- Better for production, overkill for local scraping

### Decision: Option A (host-mounted volume)
Since this runs locally, we want easy access to the data. Mount `./data` to the container. Structure:
```
data/
├── homeworks.db              # SQLite database
└── snapshots/
    └── 2026-08-08/
        └── page.html         # HTML snapshot for debugging
```

Since we're doing HTML extraction (not screenshots), we store the full page HTML as reference. This lets us debug extraction issues later without hitting the college site again.

---

## 6. Language Choice: Node.js + TypeScript

### Why Node.js
- Project already has `package-lock.json` (project name: `homework-notificator-evolutionapi`)
- Playwright's primary/first-class language is Node.js/TypeScript
- Official Playwright Docker image is Node.js-based
- `better-sqlite3` is the fastest SQLite driver in the Node.js ecosystem
- Single language across scraper + notifier = simpler codebase

### Why TypeScript
- Type safety for database operations and API calls
- Better IDE support and self-documenting code
- Catches bugs at compile time (mismatched API responses, missing fields)

---

## 7. Deduplication Strategy

### Problem
The same homework might appear on the college website for multiple days. Running the scraper daily means we'd see the same entries repeatedly. We need to only notify once per homework.

### Solution: DB-level deduplication
```sql
UNIQUE(title, due_date)
```
- When inserting a scraped homework, if `(title, due_date)` already exists, SQLite throws a constraint violation
- Catch the violation → skip notification → the homework was already notified
- No need for in-memory hashing or complex comparison logic

### Edge Cases
- If a homework's due date changes: the `UNIQUE` constraint won't match the old entry → treated as new notification (desirable behavior)
- If two homeworks have identical titles but different due dates: unique constraint allows both (correct)
- If the scraper crashes mid-run: no partial state issues, SQLite transactions ensure atomicity
- If the scraper runs twice in one day (manual trigger): dedup catches everything

---

## 8. Summary of Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Node.js + TypeScript | Matches project setup, best Playwright support |
| Data extraction | HTML DOM parsing | Structured, reliable, no OCR |
| Database | SQLite (better-sqlite3) | Zero config, single file, perfect for local |
| Deduplication | SQLite UNIQUE constraint | DB-level guarantee, simple |
| Scheduling | node-cron | Single container, cron syntax |
| Messaging | Evolution API | Open-source WhatsApp gateway, REST API |
| Base image | Custom (node:20-bookworm + Playwright) | Smaller than official, only Chromium |
| Storage | Host-mounted `./data` volume | Easy access, persistent |
| HTML snapshots | Stored by date | Debuggability without re-scraping |

---

## 9. References

- Playwright Docker docs: https://playwright.dev/docs/docker
- Playwright official Docker image: `mcr.microsoft.com/playwright:v1.62.0-noble`
- Microsoft Artifact Registry (Playwright): https://mcr.microsoft.com/en-us/product/playwright/about
- Evolution API docs: https://docs.evolutionfoundation.com.br
- Evolution API GitHub: https://github.com/evolution-foundation
- SQLite appropriate uses: https://www.sqlite.org/whentouse.html
- better-sqlite3 npm: https://www.npmjs.com/package/better-sqlite3
- node-cron npm: https://www.npmjs.com/package/node-cron
