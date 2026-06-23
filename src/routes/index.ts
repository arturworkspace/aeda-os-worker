import { Express } from 'express';
import { Agenda } from 'agenda';
import { createWebhookRouter } from './webhookInbound.js';
import { logger } from '../logger.js';

export function registerRoutes(app: Express, agenda: Agenda): void {
  const webhookRouter = createWebhookRouter(agenda);
  app.use('/webhook', webhookRouter);

  // Manual trigger for hasmik weekly intelligence job (for testing)
  app.post('/jobs/hasmik-intelligence/trigger', async (_req, res) => {
    try {
      if (!agenda) {
        res.status(503).json({ error: 'Agenda not initialized' });
        return;
      }
      await agenda.now('hasmik.weeklyIntelligence', {});
      res.json({ ok: true, message: 'hasmik weekly intelligence job triggered' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET version for easy browser testing
  app.get('/jobs/hasmik-intelligence/trigger', async (_req, res) => {
    try {
      if (!agenda) {
        res.status(503).json({ error: 'Agenda not initialized' });
        return;
      }
      await agenda.now('hasmik.weeklyIntelligence', {});
      res.json({ ok: true, message: 'hasmik weekly intelligence job triggered' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  logger.info('routes registered');
}
