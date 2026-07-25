import { Express } from 'express';
import { Agenda } from 'agenda';
import { createWebhookRouter } from './webhookInbound.js';
import { createInvestorResearchRouter } from './investorResearch.js';
import { runFollowUpScheduler } from '../jobs/investor.followUpScheduler.js';
import { runGmailSendStatusSync } from '../jobs/outreach.gmailSendStatusSync.js';
import { getJobCeilings, getJobSpendToday, checkBudget, BudgetExceededError } from '../core/budgetGuard.js';
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

  // Gmail send status sync on-demand trigger (protected by secret)
  app.post('/jobs/gmail-send-status-sync/trigger-now', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, async (_req, res) => {
    try {
      const result = await runGmailSendStatusSync();
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // -------------------------------------------------------------------------
  // Debug: Job budget ceiling status and test endpoint
  // -------------------------------------------------------------------------

  // GET /debug/job-ceilings — list all configured ceilings
  app.get('/debug/job-ceilings', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, (_req, res) => {
    const ceilings = getJobCeilings();
    res.json({
      ceilings,
      note: 'Daily per-job ceilings in USD. _default applies to unlisted jobs.',
    });
  });

  // GET /debug/job-spend?job=<agentOrJob> — check spend vs ceiling for a job
  app.get('/debug/job-spend', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, async (req, res) => {
    const job = req.query['job'];
    if (!job || typeof job !== 'string') {
      res.status(400).json({ error: 'Missing ?job=<agentOrJob> parameter' });
      return;
    }
    try {
      const status = await getJobSpendToday(job);
      res.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /debug/test-job-ceiling?job=<agentOrJob>&amount=<usd> — simulate a budget check
  // This does NOT actually spend money; it just checks if a call of that size would be blocked.
  app.post('/debug/test-job-ceiling', (req, res, next) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, async (req, res) => {
    const job = req.query['job'];
    const amountStr = req.query['amount'];
    if (!job || typeof job !== 'string') {
      res.status(400).json({ error: 'Missing ?job=<agentOrJob> parameter' });
      return;
    }
    const amount = amountStr ? parseFloat(amountStr as string) : 0.01;
    if (isNaN(amount) || amount <= 0) {
      res.status(400).json({ error: 'Invalid amount — must be a positive number' });
      return;
    }

    try {
      // Get current status before check
      const beforeStatus = await getJobSpendToday(job);

      // Attempt the budget check (this will throw if blocked)
      await checkBudget(amount, {
        packageId: null,
        projectKey: null,
        smokeTest: false,
        agentOrJob: job,
      });

      res.json({
        wouldBeBlocked: false,
        testAmount: amount,
        ...beforeStatus,
        message: `A $${amount.toFixed(4)} call for "${job}" would be ALLOWED.`,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError && err.scope === 'job') {
        const afterStatus = await getJobSpendToday(job);
        res.json({
          wouldBeBlocked: true,
          testAmount: amount,
          ...afterStatus,
          message: `A $${amount.toFixed(4)} call for "${job}" would be BLOCKED. Alert sent to founder inbox.`,
          alertSent: true,
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    }
  });

  logger.info('routes registered');
}
