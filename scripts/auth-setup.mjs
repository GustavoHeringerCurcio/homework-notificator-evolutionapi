import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const AUTH_URL = process.env.COLLEGE_AUTH_URL || 'https://api.plataforma.grupoa.education/v2/safea-client/auth/sso/saml';
const HOMEWORK_URL = process.env.COLLEGE_HOMEWORK_URL || 'https://plataforma.grupoa.education/homeworks';

async function setupAuth() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to auth URL...');
  await page.goto(AUTH_URL);

  console.log('\n========================================');
  console.log('  Complete the login in the browser window');
  console.log('  The script will auto-detect when done');
  console.log('========================================\n');

  try {
    await page.waitForURL(url => {
      return !url.includes('/auth/') && !url.includes('/sso/') && !url.includes('/saml');
    }, { timeout: 300_000 });

    console.log('Login detected! Saving auth state...');

    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const authPath = path.join(dataDir, 'auth.json');
    await context.storageState({ path: authPath });
    console.log(`Auth saved to ${authPath}`);
  } catch (err) {
    console.error('Timeout waiting for login completion.');
    console.error('Make sure you complete the login within 5 minutes.');
    console.error('Error:', err.message);
    process.exit(1);
  }

  await browser.close();
  console.log('Done! You can now run `docker compose up` to start the notificator.');
}

setupAuth().catch(err => {
  console.error('Auth setup failed:', err.message);
  process.exit(1);
});
