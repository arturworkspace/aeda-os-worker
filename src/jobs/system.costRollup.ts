import { Agenda, Job } from 'agenda';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { CostDaily } from '../db/schemas/costDaily.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'system.costRollup';

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (job: Job) => {
    const startTime = Date.now();
    let success = false;
    let errorMessage: string | undefined;

    try {
      const now = new Date();
      const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const dateStr = yesterdayDate.toISOString().slice(0, 10);

      const aggregates = await costLedgerRepo.getYesterdayAggregates();

      await CostDaily.findOneAndUpdate(
        { date: dateStr },
        {
          $set: {
            date: dateStr,
            totalCostUsd: aggregates.totalCostUsd,
            totalInputTokens: aggregates.totalInputTokens,
            totalOutputTokens: aggregates.totalOutputTokens,
            callCount: aggregates.callCount,
            byAgent: aggregates.byAgent,
            byTier: aggregates.byTier,
            byModel: aggregates.byModel,
          },
        },
        { upsert: true }
      );

      success = true;
      logger.info(
        {
          date: dateStr,
          totalCostUsd: aggregates.totalCostUsd,
          callCount: aggregates.callCount,
        },
        'cost rollup completed'
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'cost rollup failed');
      throw error;
    } finally {
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'job.run',
        payload: {
          jobName: JOB_NAME,
          success,
          durationMs: Date.now() - startTime,
          error: errorMessage,
        },
      });
    }
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  await agenda.every('30 3 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('scheduled cost rollup job for 03:30 Europe/Prague daily');
}
