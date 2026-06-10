import { Agenda } from 'agenda';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { budgetRepo } from './db/repos/budget.repo.js';
import { memoryRepo } from './db/repos/memory.repo.js';
import { loadApprovalMatrix, logApprovalMatrixLoaded } from './core/stateMachine.js';
import { defineAllJobs, scheduleAllJobs } from './jobs/index.js';
import { logger } from './logger.js';

let agenda: Agenda | null = null;

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
