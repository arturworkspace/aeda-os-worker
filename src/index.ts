import { Agenda } from 'agenda';
import express from 'express';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { budgetRepo } from './db/repos/budget.repo.js';
import { memoryRepo } from './db/repos/memory.repo.js';
import { loadApprovalMatrix, logApprovalMatrixLoaded } from './core/stateMachine.js';
import { defineAllJobs, scheduleAllJobs } from './jobs/index.js';
import { registerRoutes } from './routes/index.js';
import { initGmailClient, ensurePendingSendLabel } from './services/gmail.js';
import { logger } from './logger.js';

let agenda: Agenda | null = null;
let httpServer: ReturnType<typeof import('http').createServer> | null = null;

async function main(): Promise<void> {
  logger.info('starting aeda os worker');

  try {
    await connectDb();
    logger.info('database connected');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: connectDb -', err.message, err.stack);
    throw err;
  }

  try {
    loadApprovalMatrix();
    await logApprovalMatrixLoaded();
    logger.info('approval matrix loaded');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: loadApprovalMatrix -', err.message, err.stack);
    throw err;
  }

  try {
    await budgetRepo.seedGlobalBudget();
    logger.info('global budget seeded');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: seedGlobalBudget -', err.message, err.stack);
    throw err;
  }

  try {
    await memoryRepo.seedFounderPreferences();
    logger.info('founder preferences seeded');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: seedFounderPreferences -', err.message, err.stack);
    throw err;
  }

  try {
    agenda = new Agenda({
      db: { address: env.MONGODB_URI, collection: 'os_agenda_jobs' },
      processEvery: '1 minute',
      maxConcurrency: 5,
    });
    logger.info('agenda instance created');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: agenda creation -', err.message, err.stack);
    throw err;
  }

  try {
    defineAllJobs(agenda);
    logger.info('jobs defined');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: defineAllJobs -', err.message, err.stack);
    throw err;
  }

  try {
    initGmailClient();
    await ensurePendingSendLabel();
    logger.info('gmail client initialized');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('step failed: initGmailClient -', err.message, err.stack);
    logger.warn({ err: err.message }, 'gmail init failed, continuing without gmail');
  }

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'aeda-os-worker' });
  });

  registerRoutes(app, agenda);

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  console.log(`starting http server on port ${port}...`);
  logger.info({ port }, 'starting http server');

  httpServer = app.listen(port);

  httpServer.on('listening', () => {
    console.log(`http server listening on port ${port}`);
    logger.info({ port }, 'http server listening');
  });

  httpServer.on('error', (err) => {
    console.error('http server error:', err);
    logger.fatal({ err: err.message }, 'http server failed to start');
    process.exit(1);
  });

  agenda.on('ready', async () => {
    try {
      logger.info('agenda ready');
      await scheduleAllJobs(agenda!);
      await agenda!.start();
      logger.info('agenda started');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('step failed: agenda start/schedule -', err.message, err.stack);
      logger.fatal({ err: err.message, stack: err.stack }, 'agenda startup failed');
      process.exit(1);
    }
  });

  agenda.on('error', (error) => {
    console.error('agenda error:', error.message, error.stack);
    logger.error({ err: error.message, stack: error.stack }, 'agenda error');
  });

  agenda.on('start', (job) => {
    logger.info({ jobName: job.attrs.name }, 'job started');
  });

  agenda.on('complete', (job) => {
    logger.info({ jobName: job.attrs.name }, 'job completed');
  });

  agenda.on('fail', (error, job) => {
    console.error('job failed:', job.attrs.name, error.message, error.stack);
    logger.error({ jobName: job.attrs.name, err: error.message, stack: error.stack }, 'job failed');
  });

  logger.info('aeda os worker running');
}

async function shutdown(): Promise<void> {
  logger.info('shutting down aeda os worker');

  if (httpServer) {
    httpServer.close();
    logger.info('http server closed');
  }

  if (agenda) {
    await agenda.stop();
    logger.info('agenda stopped');
  }

  await disconnectDb();
  logger.info('database disconnected');

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('fatal error during startup:', err.message);
  console.error('stack:', err.stack);
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal error during startup');
  process.exit(1);
});
