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

  await connectDb();
  logger.info('database connected');

  loadApprovalMatrix();
  await logApprovalMatrixLoaded();

  await budgetRepo.seedGlobalBudget();
  logger.info('global budget seeded');

  await memoryRepo.seedFounderPreferences();
  logger.info('founder preferences seeded');

  agenda = new Agenda({
    db: { address: env.MONGODB_URI, collection: 'os_agenda_jobs' },
    processEvery: '1 minute',
    maxConcurrency: 5,
  });

  defineAllJobs(agenda);

  agenda.on('ready', async () => {
    logger.info('agenda ready');
    await scheduleAllJobs(agenda!);
    await agenda!.start();
    logger.info('agenda started');
  });

  agenda.on('error', (error) => {
    logger.error({ error: error.message }, 'agenda error');
  });

  agenda.on('start', (job) => {
    logger.info({ jobName: job.attrs.name }, 'job started');
  });

  agenda.on('complete', (job) => {
    logger.info({ jobName: job.attrs.name }, 'job completed');
  });

  agenda.on('fail', (error, job) => {
    logger.error({ jobName: job.attrs.name, error: error.message }, 'job failed');
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
  logger.fatal({ error: error.message }, 'fatal error during startup');
  process.exit(1);
});
