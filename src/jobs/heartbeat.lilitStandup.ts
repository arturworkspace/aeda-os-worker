import { Agenda, Job } from 'agenda';
import { executionPackageRepo } from '../db/repos/executionPackage.repo.js';
import { auditLogRepo } from '../db/repos/auditLog.repo.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { budgetRepo } from '../db/repos/budget.repo.js';
import { founderInboxRepo } from '../db/repos/founderInbox.repo.js';
import { routedCall, getTextContent } from '../core/modelRouter.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { getPersona } from '../agents/personas.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'heartbeat.lilitStandup';

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (job: Job) => {
    const startTime = Date.now();
    let success = false;
    let errorMessage: string | undefined;

    try {
      const lilit = getPersona('lilit');
      if (!lilit) {
        throw new Error('lilit persona not found');
      }

      const packagesByState = await executionPackageRepo.getOpenPackagesByState();

      const now = new Date();
      const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const auditEventCounts = await auditLogRepo.getEventCountsByType(yesterdayStart, todayStart);

      const monthToDateSpend = await costLedgerRepo.getMonthToDateTotal();
      const globalBudget = await budgetRepo.getGlobal();
      const budgetCap = globalBudget?.monthlyCapUsd ?? 60;
      const budgetPct = Math.round((monthToDateSpend / budgetCap) * 100);

      const contextSummary = `
Current date: ${now.toISOString().slice(0, 10)}

Open execution packages by state:
- PREPARED: ${packagesByState.PREPARED ?? 0}
- C_LEVEL_REVIEW: ${packagesByState.C_LEVEL_REVIEW ?? 0}
- AWAITING_FOUNDER: ${packagesByState.AWAITING_FOUNDER ?? 0}
- APPROVED: ${packagesByState.APPROVED ?? 0}
- SCHEDULED: ${packagesByState.SCHEDULED ?? 0}
- EXECUTING: ${packagesByState.EXECUTING ?? 0}

Yesterday's audit events:
${Object.entries(auditEventCounts)
  .map(([type, count]) => `- ${type}: ${count}`)
  .join('\n') || '- none recorded'}

Budget status:
- Month-to-date spend: $${monthToDateSpend.toFixed(2)}
- Monthly cap: $${budgetCap.toFixed(2)}
- Usage: ${budgetPct}%
`.trim();

      const result = await routedCall({
        tier: 'production',
        agentOrJob: 'lilit',
        system: lilit.systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Write the morning standup summary for Artur. Here is the current state of aeda os:\n\n${contextSummary}\n\nProvide a clear, concise summary (under 200 words) highlighting what needs attention today. Lead with the most important items.`,
          },
        ],
        maxTokens: 500,
      });

      const standupContent = getTextContent(result.response);

      await founderInboxRepo.insert({
        source: 'lilit',
        title: `morning standup - ${now.toISOString().slice(0, 10)}`,
        content: standupContent,
      });

      success = true;
      logger.info({ costUsd: result.costUsd }, 'lilit standup completed');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'lilit standup failed');
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
  await agenda.every('0 7 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('scheduled lilit standup job for 07:00 Europe/Prague daily');
}
