import express, { Request, Response } from 'express';
import { HealthReport } from './types';

export interface HealthServerDeps {
  getHealthReport: () => HealthReport;
  onTrigger: () => Promise<{ triggered: boolean; runId?: string; message: string }>;
}

export function createHealthServer(deps: HealthServerDeps): express.Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    try {
      const report = deps.getHealthReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ status: 'error', message: String(err) });
    }
  });

  app.get('/trigger', async (_req: Request, res: Response) => {
    try {
      const result = await deps.onTrigger();
      const statusCode = result.triggered ? 200 : 409;
      res.status(statusCode).json(result);
    } catch (err) {
      res.status(500).json({ triggered: false, message: String(err) });
    }
  });

  return app;
}
