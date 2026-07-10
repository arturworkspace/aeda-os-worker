import { Agenda, Job } from 'agenda';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { isJuliaGmailConfigured } from '../services/juliaGmail.js';
import { logger } from '../logger.js';
import { google } from 'googleapis';

export const JOB_NAME = 'outreach.gmailSendStatusSync';

let juliaGmailClient: ReturnType<typeof google.gmail> | null = null;

function getJuliaGmailClient(): ReturnType<typeof google.gmail> | null {
  if (juliaGmailClient) return juliaGmailClient;

  const clientId = process.env['JULIA_GMAIL_CLIENT_ID'];
  const clientSecret = process.env['JULIA_GMAIL_CLIENT_SECRET'];
  const refreshToken = process.env['JULIA_GMAIL_REFRESH_TOKEN'];

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  juliaGmailClient = google.gmail({ version: 'v1', auth: client });
  return juliaGmailClient;
}

export interface GmailSendStatusSyncResult {
  success: boolean;
  checkedCount: number;
  updatedCount: number;
  durationMs: number;
  error?: string;
}

export async function runGmailSendStatusSync(): Promise<GmailSendStatusSyncResult> {
  const startTime = Date.now();
  let checkedCount = 0;
  let updatedCount = 0;

  if (!isJuliaGmailConfigured()) {
    logger.warn('julia gmail not configured, skipping send status sync');
    return {
      success: false,
      checkedCount: 0,
      updatedCount: 0,
      durationMs: Date.now() - startTime,
      error: 'julia gmail not configured',
    };
  }

  const gmailClient = getJuliaGmailClient();
  if (!gmailClient) {
    logger.warn('could not initialize julia gmail client for send status sync');
    return {
      success: false,
      checkedCount: 0,
      updatedCount: 0,
      durationMs: Date.now() - startTime,
      error: 'gmail client not available',
    };
  }

  try {
    // Find all drafts that are pushed_to_gmail (not yet marked as sent)
    const pendingDrafts = await emailDraftRepo.findPendingSendStatus();
    logger.info({ count: pendingDrafts.length }, 'checking gmail send status for drafts');

    for (const draft of pendingDrafts) {
      checkedCount++;

      if (!draft.gmail_draft_id) {
        continue;
      }

      try {
        // Try to get the draft - if it 404s, the draft was sent (Gmail removes drafts when sent)
        await gmailClient.users.drafts.get({
          userId: 'me',
          id: draft.gmail_draft_id,
        });

        // Draft still exists - not sent yet
        logger.debug({ draftId: draft.gmail_draft_id, investorId: draft.investorId }, 'draft still exists in gmail');
      } catch (error: unknown) {
        const err = error as { code?: number; message?: string };

        if (err.code === 404 || err.message?.includes('Requested entity was not found')) {
          // Draft no longer exists - it was sent!
          logger.info({ draftId: draft.gmail_draft_id, investorId: draft.investorId }, 'draft no longer in gmail, marking as sent');

          // Try to find the sent message by thread ID
          let sentAt: Date | null = null;
          if (draft.gmail_thread_id) {
            try {
              const threadResponse = await gmailClient.users.threads.get({
                userId: 'me',
                id: draft.gmail_thread_id,
                format: 'metadata',
                metadataHeaders: ['Date'],
              });

              const messages = threadResponse.data.messages || [];
              // Find the most recent SENT message (not in DRAFT label)
              for (const msg of messages.reverse()) {
                if (!msg.labelIds?.includes('DRAFT')) {
                  // Get the internal date from the message
                  if (msg.internalDate) {
                    sentAt = new Date(parseInt(msg.internalDate, 10));
                  }
                  break;
                }
              }
            } catch {
              logger.warn({ threadId: draft.gmail_thread_id }, 'could not fetch thread for sent timestamp');
            }
          }

          await emailDraftRepo.markAsSent(draft._id, sentAt || new Date());
          updatedCount++;
        } else {
          logger.warn({ error: err.message, draftId: draft.gmail_draft_id }, 'error checking draft status');
        }
      }
    }

    logger.info({ checkedCount, updatedCount }, 'gmail send status sync completed');

    return {
      success: true,
      checkedCount,
      updatedCount,
      durationMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg }, 'gmail send status sync failed');
    return {
      success: false,
      checkedCount,
      updatedCount,
      durationMs: Date.now() - startTime,
      error: errMsg,
    };
  }
}

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (_job: Job) => {
    await runGmailSendStatusSync();
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  // Run twice daily at 09:00 and 17:00 Europe/Prague
  await agenda.every('0 9,17 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('scheduled gmail send status sync job for 09:00 and 17:00 Europe/Prague');
}
