import { LogEntry } from './types';

let currentRunId: string | null = null;

export function setRunId(runId: string | null): void {
  currentRunId = runId;
}

export function getRunId(): string | null {
  return currentRunId;
}

function formatLog(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function log(level: LogEntry['level'], msg: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...(currentRunId ? { run_id: currentRunId } : {}),
    ...(extra || {}),
  };

  const line = formatLog(entry);

  switch (level) {
    case 'ERROR':
      process.stderr.write(line + '\n');
      break;
    case 'WARN':
      process.stderr.write(line + '\n');
      break;
    default:
      process.stdout.write(line + '\n');
      break;
  }
}

export const logger = {
  info(msg: string, extra?: Record<string, unknown>): void {
    log('INFO', msg, extra);
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    log('WARN', msg, extra);
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    log('ERROR', msg, extra);
  },
  debug(msg: string, extra?: Record<string, unknown>): void {
    log('DEBUG', msg, extra);
  },
};
