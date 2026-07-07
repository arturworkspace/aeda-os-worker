// NOT YET SCHEDULED. Activate registration only after @vagho confirms the
// Gmail read-only scope security review is complete.
// When activated: this job will poll Gmail threads.get (using GMAIL_CLIENT_ID /
// GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN, already in Railway env vars) for
// threadIds stored in investors.emailThreadId. On detecting a reply, it will
// call POST https://aeda-workspace.vercel.app/api/investors/[id]/mark-replied
// (already built in aeda-workspace) to sync status and stop further follow-ups.

import { Agenda, Job } from 'agenda';
import { investorRepo } from '../db/repos/investor.repo.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'investor.replyDetection';

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (_job: Job) => {
    const startTime = Date.now();
    let success = false;
    let errorMessage: string | undefined;
    let repliesDetected = 0;

    try {
      // ═══════════════════════════════════════════════════════════════════
      // TODO: Implement reply detection once Gmail scope is approved
      //
      // Intended flow:
      // 1. Query investors with emailThreadId set but repliedAt not set
      //    const awaitingReply = await investorRepo.findAwaitingReply();
      //
      // 2. For each, call Gmail API threads.get:
      //    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
      //    const thread = await gmail.users.threads.get({
      //      userId: 'me',
      //      id: investor.emailThreadId,
      //      format: 'metadata',
      //      metadataHeaders: ['From', 'Date'],
      //    });
      //
      // 3. Check if any message in thread is NOT from artur@aedawallet.com
      //    (indicating a reply from the investor)
      //
      // 4. If reply detected, call workspace API:
      //    await fetch(`https://aeda-workspace.vercel.app/api/investors/${investor._id}/mark-replied`, {
      //      method: 'POST',
      //      headers: { 'Content-Type': 'application/json' },
      //    });
      //
      // 5. Log result to audit log
      // ═══════════════════════════════════════════════════════════════════

      const awaitingReply = await investorRepo.findAwaitingReply();
      logger.info({ count: awaitingReply.length }, 'investors awaiting reply (job not yet active)');

      // Placeholder: job defined but not executing Gmail calls
      success = true;
      logger.info('reply detection job ran (stub only, no Gmail calls made)');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'reply detection failed');
      throw error;
    } finally {
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'job.run',
        payload: {
          jobName: JOB_NAME,
          success,
          repliesDetected,
          durationMs: Date.now() - startTime,
          error: errorMessage,
          note: 'stub only - Gmail polling not yet activated',
        },
      });
    }
  });
}

// NOTE: Do NOT call scheduleJob until @vagho approves Gmail scope
// export async function scheduleJob(agenda: Agenda): Promise<void> {
//   await agenda.every('0 9 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
//   logger.info('scheduled investor reply detection job for 09:00 Europe/Prague daily');
// }
