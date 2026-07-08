import { Express } from 'express';
import { Agenda } from 'agenda';
import { createWebhookRouter } from './webhookInbound.js';
import { createInvestorResearchRouter } from './investorResearch.js';
import { runFollowUpScheduler } from '../jobs/investor.followUpScheduler.js';
import { logger } from '../logger.js';

export function registerRoutes(app: Express, agenda: Agenda): void {
  const webhookRouter = createWebhookRouter(agenda);
  app.use('/webhook', webhookRouter);

  // Manual trigger for hasmik weekly intelligence job (protected by secret)
  app.post('/jobs/hasmik-intelligence/trigger', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    // Reject if no secret configured OR if provided doesn't match
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, async (_req, res) => {
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

  // Investor research on-demand trigger (protected by secret)
  const investorResearchRouter = createInvestorResearchRouter();
  app.use('/jobs/investor-research', investorResearchRouter);

  // Follow-up scheduler on-demand trigger (protected by secret)
  app.post('/jobs/investor-followup-scheduler/trigger-now', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, async (_req, res) => {
    try {
      const result = await runFollowUpScheduler();
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  logger.info('routes registered');
}
