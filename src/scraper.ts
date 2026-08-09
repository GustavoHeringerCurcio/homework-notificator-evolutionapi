import type { Browser, BrowserContext } from 'playwright';
import { Config, ScraperResult } from './types';
import { generateMockHomeworks } from './mock';
import { logger } from './logger';

export async function runScraper(config: Config): Promise<ScraperResult> {
  const startTime = Date.now();

  if (config.useMock) {
    logger.info('Mock mode enabled, generating fake homeworks');
    const entries = generateMockHomeworks(config.mockSeedDate);
    return {
      success: true,
      entries,
      snapshotPath: undefined,
      durationMs: Date.now() - startTime,
    };
  }

  let browser: Browser | null = null;

  try {
    const { chromium } = await import('playwright');
    const fs = (await import('fs')).promises;
    const path = await import('path');

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const authPath = path.join(config.dataDir, 'auth.json');
    let context: BrowserContext;
    try {
      await fs.access(authPath);
      context = await browser.newContext({ storageState: authPath });
      logger.info('Auth state loaded', { path: authPath });
    } catch {
      context = await browser.newContext();
      if (!config.useMock) {
        logger.error('Auth state not found. Run `npm run auth:setup` first.');
        return {
          success: false,
          entries: [],
          error: 'Auth state not found',
          durationMs: Date.now() - startTime,
        };
      }
    }

    const page = await context.newPage();
    page.setDefaultTimeout(config.browserTimeoutMs);

    let lastError: string | undefined;
    for (let attempt = 0; attempt < config.retryMax; attempt++) {
      try {
        await page.goto(config.collegeHomeworkUrl, { waitUntil: 'domcontentloaded' });

        const currentUrl = page.url();
        if (currentUrl.includes('/auth/') || currentUrl.includes('/sso/') || currentUrl.includes('/saml')) {
          logger.error('Auth expired, redirected to login');
          return {
            success: false,
            entries: [],
            error: 'Auth expired — re-auth required',
            durationMs: Date.now() - startTime,
          };
        }
        break;
      } catch (err) {
        lastError = String(err);
        logger.warn(`Navigation attempt ${attempt + 1} failed`, { error: lastError });
        if (attempt < config.retryMax) {
          await new Promise(r => setTimeout(r, config.retryBackoffMs));
        }
      }
    }

    try {
      await page.waitForSelector(config.selectorSentinel, { timeout: config.browserTimeoutMs });
    } catch {
      const htmlContent = await page.content();
      const today = new Date().toISOString().slice(0, 10);
      const snapshotDir = path.join(config.dataDir, 'snapshots', today);
      const fsSync = await import('fs');

      if (!fsSync.existsSync(snapshotDir)) {
        fsSync.mkdirSync(snapshotDir, { recursive: true });
      }
      const snapshotPath = path.join(snapshotDir, 'page.html');
      const { writeFile } = await import('fs/promises');
      await writeFile(snapshotPath, htmlContent);

      logger.error('Sentinel element not found, page may be broken');
      return {
        success: false,
        entries: [],
        error: 'Sentinel element not found',
        snapshotPath,
        durationMs: Date.now() - startTime,
      };
    }

    const containerItems = page.locator(config.selectorContainer);
    const items = await containerItems.all();

    if (items.length === 0) {
      logger.info('No homework entries found on page');
      return {
        success: true,
        entries: [],
        durationMs: Date.now() - startTime,
      };
    }

    const entries = await extractHomeworks(page, items, config);

    const today = new Date().toISOString().slice(0, 10);
    const snapshotDir = path.join(config.dataDir, 'snapshots', today);
    const fsSync = await import('fs');
    if (!fsSync.existsSync(snapshotDir)) {
      fsSync.mkdirSync(snapshotDir, { recursive: true });
    }
    const snapshotPath = path.join(snapshotDir, 'page.html');
    const htmlContent = await page.content();
    const { writeFile } = await import('fs/promises');
    await writeFile(snapshotPath, htmlContent);

    await browser.close();

    return {
      success: true,
      entries,
      snapshotPath,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error('Scraper error', { error: String(err) });
    return {
      success: false,
      entries: [],
      error: String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

async function extractHomeworks(
  page: { locator: (selector: string) => { textContent: () => Promise<string | null> } },
  items: { locator: (selector: string) => { textContent: () => Promise<string | null> } }[],
  config: Config,
): Promise<{ title: string; due_date: string; due_time: string | null }[]> {
  const results: { title: string; due_date: string; due_time: string | null }[] = [];

  for (const item of items) {
    try {
      const titleEl = item.locator(config.selectorTitle);
      const rawTitle = await titleEl.textContent();
      if (!rawTitle || rawTitle.trim().length < 3) continue;

      const dateEl = item.locator(config.selectorDueDate);
      const rawDate = await dateEl.textContent();
      const parsedDate = rawDate ? parseDate(rawDate.trim()) : null;
      if (!parsedDate) continue;

      results.push({
        title: rawTitle.trim(),
        due_date: parsedDate,
        due_time: null,
      });
    } catch {
      continue;
    }
  }

  return results;
}

function parseDate(raw: string): string | null {
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return raw;

  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;

  const usMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;

  const textMatch = raw.match(/(\d{1,2})\s*de\s*(\w+)\s*de\s*(\d{4})/i);
  if (textMatch) {
    const months: Record<string, string> = {
      'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03',
      'abril': '04', 'maio': '05', 'junho': '06',
      'julho': '07', 'agosto': '08', 'setembro': '09',
      'outubro': '10', 'novembro': '11', 'dezembro': '12',
    };
    const monthKey = textMatch[2].toLowerCase().replace(/ç/g, 'c');
    const month = months[monthKey];
    if (month) {
      const day = textMatch[1].padStart(2, '0');
      return `${textMatch[3]}-${month}-${day}`;
    }
  }

  return null;
}
