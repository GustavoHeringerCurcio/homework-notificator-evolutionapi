import fs from 'fs';
import os from 'os';
import path from 'path';

const LOCK_FILE = path.join(os.tmpdir(), 'scraper.lock');

export function acquireLock(runId: string): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf-8');
      try {
        const info = JSON.parse(content);
        if (isProcessAlive(info.pid)) {
          return false;
        }
        fs.unlinkSync(LOCK_FILE);
      } catch {
        fs.unlinkSync(LOCK_FILE);
      }
    }

    const dir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({
        run_id: runId,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Lock file may already be removed
  }
}

export function getLockInfo(): string | null {
  try {
    if (!fs.existsSync(LOCK_FILE)) {
      return null;
    }
    return fs.readFileSync(LOCK_FILE, 'utf-8');
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
