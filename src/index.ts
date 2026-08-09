import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import http from 'http';

import { getConfig } from './config';
import { initDb, getDb, insertHomework, getPendingNotifications, markNotified, recordScrapeRun, getLastRun, getTotalHomeworks, getPendingCount, closeDb } from './db';
import { runScraper } from './scraper';
import { notifyForHomework, checkEvolutionApi } from './notifier';
import { acquireLock, releaseLock, getLockInfo } from './lock';
import { logger, setRunId } from './logger';
import { createHealthServer } from './health';
import { setupShutdownHandlers, registerShutdownResources } from './shutdown';
import { HealthReport, ScrapeRun } from './types';

let isRunning = false;
let lastRunResult: HealthReport['last_run'] = {
  run_id: null,
  started_at: null,
  ended_at: null,
  status: null,
  entries_found: 0,
  entries_new: 0,
  entries_dup: 0,
  duration_ms: null,
  parser_warning: false,
};

async function executeRun(): Promise<void> {
  if (isRunning) {
    logger.warn('Scrape already in progress, skipping');
    return;
  }

  const config = getConfig();
  const runId = uuidv4();
  setRunId(runId);
  isRunning = true;

  const startedAt = new Date().toISOString();
  logger.info('Scrape started');

  const run: ScrapeRun = {
    run_id: runId,
    started_at: startedAt,
    status: 'running',
    entries_found: 0,
    entries_new: 0,
    entries_dup: 0,
  };
  recordScrapeRun(run);

  lastRunResult = {
    run_id: runId,
    started_at: startedAt,
    ended_at: null,
    status: 'running',
    entries_found: 0,
    entries_new: 0,
    entries_dup: 0,
    duration_ms: null,
    parser_warning: false,
  };

  try {
    if (!acquireLock(runId)) {
      logger.warn('Could not acquire lock, another run is in progress');
      isRunning = false;
      return;
    }

    const result = await runScraper(config);
    const endedAt = new Date().toISOString();

    let newCount = 0;
    let dupCount = 0;
    let sentCount = 0;

    if (result.success && result.entries.length > 0) {
      for (const entry of result.entries) {
        const insertResult = insertHomework(entry, config.collegeHomeworkUrl);
        if (insertResult.status === 'new') {
          newCount++;
        } else {
          dupCount++;
        }
      }
    }

    if (newCount > 0) {
      const pending = getPendingNotifications();
      for (const hw of pending) {
        const sent = await notifyForHomework(hw.title, hw.due_date, hw.due_time, config);
        if (sent > 0) {
          markNotified(hw.id, true);
          sentCount++;
        } else {
          markNotified(hw.id, false, 'No numbers received the message');
        }
      }
    }

    const durationMs = Date.now() - new Date(startedAt).getTime();

    run.status = result.success ? 'success' : 'error';
    run.ended_at = endedAt;
    run.entries_found = result.entries.length;
    run.entries_new = newCount;
    run.entries_dup = dupCount;
    run.error = result.error;
    run.snapshot_path = result.snapshotPath;
    recordScrapeRun(run);

    lastRunResult = {
      run_id: runId,
      started_at: startedAt,
      ended_at: endedAt,
      status: run.status,
      entries_found: result.entries.length,
      entries_new: newCount,
      entries_dup: dupCount,
      duration_ms: durationMs,
      parser_warning: false,
    };

    logger.info('Scrape completed', {
      entries_found: result.entries.length,
      new: newCount,
      dup: dupCount,
      sent: sentCount,
      duration_ms: durationMs,
    });
  } catch (err) {
    logger.error('Scrape run failed', { error: String(err) });
    run.status = 'error';
    run.ended_at = new Date().toISOString();
    run.error = String(err);
    recordScrapeRun(run);

    lastRunResult.status = 'error';
    lastRunResult.ended_at = run.ended_at;
  } finally {
    releaseLock();
    isRunning = false;
    setRunId(null);
  }
}

function buildHealthReport(): HealthReport {
  const config = getConfig();
  const now = new Date();
  const uptimeSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);

  const authPath = path.join(config.dataDir, 'auth.json');
  const authFileExists = fs.existsSync(authPath);
  const authValid = authFileExists && !config.useMock;

  let dbOk = true;
  try {
    getDb();
  } catch {
    dbOk = false;
  }

  let nextRunDate = '';
  try {
    const parts = config.cronExpression.split(/\s+/);
    const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
    nextRunDate = 'next cron tick';
  } catch {
    nextRunDate = 'unknown';
  }

  return {
    status: lastRunResult.status === 'error' ? 'degraded' : 'ok',
    uptime_seconds: uptimeSeconds,
    mode: config.useMock ? 'MOCK' : 'LIVE',
    dry_run: config.dryRun,
    auth: {
      valid: authValid,
      file_exists: authFileExists,
    },
    database: {
      ok: dbOk,
      total_homeworks: dbOk ? getTotalHomeworks() : 0,
      pending_notifications: dbOk ? getPendingCount() : 0,
    },
    evolution_api: {
      reachable: false,
      instance_connected: false,
    },
    scheduler: {
      cron_expression: config.cronExpression,
      timezone: config.timezone,
      next_run: nextRunDate,
    },
    last_run: lastRunResult,
    lock: {
      active: getLockInfo() !== null,
    },
  };
}

const startTime = new Date();

async function main(): Promise<void> {
  logger.info('Starting homework-notificator v1.0.0');

  let config;
  try {
    config = getConfig();
  } catch (err) {
    logger.error('Invalid configuration', { error: String(err) });
    process.exit(1);
  }

  logger.info(`Mode: ${config.useMock ? 'MOCK' : 'LIVE'}`);
  logger.info(`Dry run: ${config.dryRun}`);

  const dbPath = path.join(config.dataDir, 'homeworks.db');
  initDb(dbPath);
  logger.info('Database OK');

  const healthApp = createHealthServer({
    getHealthReport: buildHealthReport,
    onTrigger: async () => {
      if (isRunning) {
        return {
          triggered: false,
          runId: lastRunResult.run_id || undefined,
          message: `Run already in progress. Run ID: ${lastRunResult.run_id}`,
        };
      }
      const runId = uuidv4();
      setImmediate(() => executeRun());
      return { triggered: true, runId, message: 'Scrape started. Check /health for results.' };
    },
  });

  const server = healthApp.listen(config.healthPort, () => {
    logger.info(`Health server listening on port ${config.healthPort}`);
  });

  registerShutdownResources({ healthServer: server });

  setupShutdownHandlers();

  try {
    const evoStatus = await checkEvolutionApi(config);
    if (evoStatus.reachable) {
      logger.info('Evolution API: OK', evoStatus);
    } else {
      logger.warn('Evolution API: UNREACHABLE');
    }
  } catch {
    logger.warn('Evolution API: UNREACHABLE (error during check)');
  }

  try {
    const lastRun = getLastRun();
    if (!lastRun) {
      logger.info('No previous run detected. Running initial scrape.');
      setImmediate(() => executeRun());
    } else {
      const lastRunTime = new Date(lastRun.started_at).getTime();
      const hoursSince = (Date.now() - lastRunTime) / (1000 * 60 * 60);
      if (hoursSince > 24) {
        logger.info('Missed run detected (>24h). Running now.');
        setImmediate(() => executeRun());
      }
    }
  } catch (err) {
    logger.warn('Could not check for missed runs', { error: String(err) });
  }

  try {
    const pending = getPendingNotifications();
    if (pending.length > 0) {
      logger.info(`Retrying ${pending.length} pending notifications`);
      for (const hw of pending) {
        const sent = await notifyForHomework(hw.title, hw.due_date, hw.due_time, config);
        markNotified(hw.id, sent > 0, sent === 0 ? 'Retry failed' : undefined);
      }
    }
  } catch (err) {
    logger.warn('Failed to retry pending notifications', { error: String(err) });
  }

  cron.schedule(config.cronExpression, () => executeRun(), {
    timezone: config.timezone,
    scheduled: true,
  });

  logger.info(`Cron scheduled: ${config.cronExpression} (${config.timezone})`);
  logger.info(`Health server: http://localhost:${config.healthPort}/health`);
  logger.info(`Manual trigger: http://localhost:${config.healthPort}/trigger`);
  logger.info('Ready');
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: String(err) });
  process.exit(1);
});
