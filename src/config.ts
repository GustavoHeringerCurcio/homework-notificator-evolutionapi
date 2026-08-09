import dotenv from 'dotenv';
import path from 'path';
import { Config } from './types';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), 'data');

function parseCommaSeparated(val: string): string[] {
  return val
    .split(',')
    .map(s => s.trim().replace(/[\s+\-()]/g, ''))
    .filter(s => /^\d{10,15}$/.test(s));
}

function validateNotEmpty(val: string | undefined, name: string): string {
  if (!val || val.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val.trim();
}

function loadConfig(): Config {
  const useMock = process.env.USE_MOCK === 'true';
  const dryRun = process.env.DRY_RUN === 'true';

  if (!useMock) {
    const hwUrl = process.env.COLLEGE_HOMEWORK_URL || '';
    try {
      new URL(hwUrl);
    } catch {
      console.warn('COLLEGE_HOMEWORK_URL is not a valid URL. Force-enabling mock mode.');
    }
  }

  const notifyNumbers = parseCommaSeparated(process.env.NOTIFY_NUMBERS || '');

  const evolutionApiKey = process.env.EVOLUTION_API_KEY || '';
  if (!evolutionApiKey || evolutionApiKey === 'your-api-key-here') {
    console.warn('EVOLUTION_API_KEY is missing or still set to default placeholder.');
  }

  try {
    const cronExpr = process.env.CRON_EXPRESSION || '0 10 * * *';
    require('node-cron').validate(cronExpr);
  } catch {
    throw new Error(`Invalid CRON_EXPRESSION: ${process.env.CRON_EXPRESSION}`);
  }

  return {
    collegeAuthUrl: process.env.COLLEGE_AUTH_URL || 'https://api.plataforma.grupoa.education/v2/safea-client/auth/sso/saml',
    collegeHomeworkUrl: process.env.COLLEGE_HOMEWORK_URL || 'https://plataforma.grupoa.education/homeworks',
    useMock,
    mockSeedDate: process.env.MOCK_SEED_DATE || '2026-03-09',
    cronExpression: process.env.CRON_EXPRESSION || '0 10 * * *',
    timezone: process.env.TZ || 'America/Sao_Paulo',
    evolutionApiUrl: (process.env.EVOLUTION_API_URL || 'http://evolution-api:8080').replace(/\/+$/, ''),
    evolutionApiKey,
    evolutionInstance: process.env.EVOLUTION_INSTANCE || 'default',
    notifyNumbers,
    playwrightVersion: process.env.PLAYWRIGHT_VERSION || '1.62.0',
    browserTimeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS || '30000', 10),
    retryMax: parseInt(process.env.RETRY_MAX || '3', 10),
    retryBackoffMs: parseInt(process.env.RETRY_BACKOFF_MS || '30000', 10),
    selectorContainer: process.env.SELECTOR_CONTAINER || '.homework-list > .item',
    selectorTitle: process.env.SELECTOR_TITLE || '.title',
    selectorDueDate: process.env.SELECTOR_DUE_DATE || '.due-date',
    selectorSentinel: process.env.SELECTOR_SENTINEL || 'h1',
    healthPort: parseInt(process.env.HEALTH_PORT || '3000', 10),
    dryRun,
    dataDir: DATA_DIR,
  };
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
