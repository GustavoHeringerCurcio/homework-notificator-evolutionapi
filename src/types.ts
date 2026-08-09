export interface Homework {
  title: string;
  due_date: string;
  due_time?: string | null;
  source_url?: string;
}

export interface Config {
  collegeAuthUrl: string;
  collegeHomeworkUrl: string;
  useMock: boolean;
  mockSeedDate: string;
  cronExpression: string;
  timezone: string;
  evolutionApiUrl: string;
  evolutionApiKey: string;
  evolutionInstance: string;
  notifyNumbers: string[];
  playwrightVersion: string;
  browserTimeoutMs: number;
  retryMax: number;
  retryBackoffMs: number;
  selectorContainer: string;
  selectorTitle: string;
  selectorDueDate: string;
  selectorSentinel: string;
  healthPort: number;
  dryRun: boolean;
  dataDir: string;
}

export interface SelectorConfig {
  container: string;
  title: string;
  dueDate: string;
  dueTime?: string;
  sentinel: string;
}

export interface ScraperResult {
  success: boolean;
  entries: Homework[];
  error?: string;
  snapshotPath?: string;
  durationMs?: number;
}

export interface InsertResult {
  status: 'new' | 'duplicate';
  id?: number;
}

export interface NotificationResult {
  homeworkId: number;
  success: boolean;
  error?: string;
  statusCode?: number;
}

export interface ScrapeRun {
  run_id: string;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'success' | 'error';
  entries_found: number;
  entries_new: number;
  entries_dup: number;
  error?: string;
  snapshot_path?: string;
}

export interface DbHomework {
  id: number;
  title: string;
  title_hash: string;
  due_date: string;
  due_time: string | null;
  source_url: string | null;
  created_at: string;
  notified_at: string | null;
  notify_status: 'pending' | 'sent' | 'failed' | 'skipped';
  notify_error: string | null;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  uptime_seconds: number;
  mode: 'MOCK' | 'LIVE';
  dry_run: boolean;
  auth: {
    valid: boolean;
    file_exists: boolean;
  };
  database: {
    ok: boolean;
    total_homeworks: number;
    pending_notifications: number;
  };
  evolution_api: {
    reachable: boolean;
    instance_connected: boolean;
  };
  scheduler: {
    cron_expression: string;
    timezone: string;
    next_run: string;
  };
  last_run: {
    run_id: string | null;
    started_at: string | null;
    ended_at: string | null;
    status: string | null;
    entries_found: number;
    entries_new: number;
    entries_dup: number;
    duration_ms: number | null;
    parser_warning: boolean;
  };
  lock: {
    active: boolean;
  };
}

export interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  ts: string;
  run_id?: string;
  msg: string;
  [key: string]: unknown;
}
