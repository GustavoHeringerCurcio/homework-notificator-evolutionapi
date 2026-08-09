import { logger } from './logger';
import { releaseLock } from './lock';
import { closeDb } from './db';

interface ShutdownResources {
  healthServer?: { close: (cb: () => void) => void };
  browser?: { close: () => Promise<void> } | null;
}

let resources: ShutdownResources = {};
let shuttingDown = false;

export function registerShutdownResources(res: ShutdownResources): void {
  resources = res;
}

export async function handleShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully`);

  try {
    releaseLock();
  } catch (err) {
    logger.warn('Error releasing lock during shutdown', { error: String(err) });
  }

  try {
    if (resources.browser) {
      await resources.browser.close();
      logger.info('Browser closed');
    }
  } catch (err) {
    logger.warn('Error closing browser', { error: String(err) });
  }

  try {
    if (resources.healthServer) {
      await new Promise<void>(resolve => {
        resources.healthServer!.close(() => resolve());
      });
      logger.info('Health server stopped');
    }
  } catch (err) {
    logger.warn('Error stopping health server', { error: String(err) });
  }

  try {
    closeDb();
  } catch (err) {
    logger.warn('Error closing database', { error: String(err) });
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

export function setupShutdownHandlers(): void {
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    handleShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
  });
}
