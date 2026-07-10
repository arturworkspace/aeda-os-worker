import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { investorRepo } from '../db/repos/investor.repo.js';
import { Investor } from '../db/schemas/investor.js';
import { isJuliaGmailConfigured, juliaDeleteDraft } from '../services/juliaGmail.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';
import { google } from 'googleapis';

export const JOB_NAME = 'outreach.gmailSendStatusSync';

const JULIA_EMAIL = 'julia@aedawallet.com';
const ARTUR_EMAIL = 'artur@aedawallet.com';

// Keywords for sentiment classification (cheap keyword-based approach first)
const NEGATIVE_KEYWORDS = [
  'pass', 'passing', 'not moving forward', 'not a fit', 'not the right fit',
  'decline', 'declining', 'not interested', 'no longer investing',
  'not actively investing', 'pause', 'pausing', 'hold off',
  'not at this time', 'not right now', 'not currently',
  'outside our mandate', 'outside of our focus', 'not aligned',
  'best of luck', 'good luck', 'wish you well', 'wishing you success',
];

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

function classifySentiment(body: string): 'positive' | 'negative' {
  const lowerBody = body.toLowerCase();
  for (const keyword of NEGATIVE_KEYWORDS) {
    if (lowerBody.includes(keyword)) {
      return 'negative';
    }
  }
  return 'positive';
}

export interface GmailSendStatusSyncResult {
  success: boolean;
  checkedCount: number;
  updatedCount: number;
  repliesDetected: number;
  draftsRemoved: number;
  durationMs: number;
  error?: string;
}

export async function runGmailSendStatusSync(): Promise<GmailSendStatusSyncResult> {
  const startTime = Date.now();
  let checkedCount = 0;
  let updatedCount = 0;
  let repliesDetected = 0;
  let draftsRemoved = 0;

  if (!isJuliaGmailConfigured()) {
    logger.warn('julia gmail not configured, skipping send status sync');
    return {
      success: false,
      checkedCount: 0,
      updatedCount: 0,
      repliesDetected: 0,
      draftsRemoved: 0,
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
      repliesDetected: 0,
      draftsRemoved: 0,
      durationMs: Date.now() - startTime,
      error: 'gmail client not available',
    };
  }

  try {
    // ═══════════════════════════════════════════════════════════════════
    // PART 1: Check draft → sent status (existing behavior)
    // ═══════════════════════════════════════════════════════════════════
    const pendingDrafts = await emailDraftRepo.findPendingSendStatus();
    logger.info({ count: pendingDrafts.length }, 'checking gmail send status for drafts');

    for (const draft of pendingDrafts) {
      checkedCount++;

      if (!draft.gmail_draft_id) {
        continue;
      }

      try {
        await gmailClient.users.drafts.get({
          userId: 'me',
          id: draft.gmail_draft_id,
        });
        logger.debug({ draftId: draft.gmail_draft_id, investorId: draft.investorId }, 'draft still exists in gmail');
      } catch (error: unknown) {
        const err = error as { code?: number; message?: string };

        if (err.code === 404 || err.message?.includes('Requested entity was not found')) {
          logger.info({ draftId: draft.gmail_draft_id, investorId: draft.investorId }, 'draft no longer in gmail, marking as sent');

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
              for (const msg of messages.reverse()) {
                if (!msg.labelIds?.includes('DRAFT')) {
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

          // Also update investor's firstEmailSentAt if this is a first_email and not already set
          if (draft.investorId && draft.draftType === 'first_email') {
            const investor = await investorRepo.findById(draft.investorId);
            if (investor && !investor.firstEmailSentAt) {
              await Investor.findByIdAndUpdate(draft.investorId, {
                firstEmailSentAt: sentAt || new Date(),
                $push: { activityLog: { action: 'first_email_sent_auto', at: new Date() } },
              });
              logger.info({ investorId: draft.investorId }, 'set firstEmailSentAt on investor (auto-detected from gmail)');
            }
          }
        } else {
          logger.warn({ error: err.message, draftId: draft.gmail_draft_id }, 'error checking draft status');
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PART 2: Reply detection (Round 4)
    // ═══════════════════════════════════════════════════════════════════
    const investorsAwaitingReply = await investorRepo.findAwaitingReply();
    logger.info({ count: investorsAwaitingReply.length }, 'checking for investor replies');

    for (const investor of investorsAwaitingReply) {
      // Find drafts for this investor with gmail_thread_id (any status first for debugging)
      const allDrafts = await emailDraftRepo.find({
        investorId: investor._id,
        gmail_thread_id: { $exists: true, $ne: null },
      });

      logger.info({
        investorId: investor._id,
        investorName: investor.name,
        totalDrafts: allDrafts.length,
        draftStatuses: allDrafts.map(d => ({ id: d._id, status: d.status, threadId: d.gmail_thread_id })),
      }, 'checking investor for reply detection');

      // Filter to only sent drafts for reply checking
      const drafts = allDrafts.filter(d => d.status === 'sent');

      if (drafts.length === 0) {
        logger.info({ investorId: investor._id, investorName: investor.name }, 'no sent drafts found, skipping reply check');
        continue;
      }

      // Get the thread ID from the most recent sent draft
      const latestDraft = drafts[0];
      if (!latestDraft?.gmail_thread_id) continue;

      try {
        const threadResponse = await gmailClient.users.threads.get({
          userId: 'me',
          id: latestDraft.gmail_thread_id,
          format: 'full',
        });

        const messages = threadResponse.data.messages || [];

        // Find the most recent outbound message (from julia or artur)
        let lastOutboundDate: Date | null = null;
        for (const msg of messages) {
          const from = msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const isOutbound = from.includes(JULIA_EMAIL) || from.includes(ARTUR_EMAIL);
          if (isOutbound && msg.internalDate) {
            const msgDate = new Date(parseInt(msg.internalDate, 10));
            if (!lastOutboundDate || msgDate > lastOutboundDate) {
              lastOutboundDate = msgDate;
            }
          }
        }

        if (!lastOutboundDate) continue;

        // Check for inbound replies after the last outbound
        for (const msg of messages) {
          const from = msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const isOutbound = from.includes(JULIA_EMAIL) || from.includes(ARTUR_EMAIL);

          if (!isOutbound && msg.internalDate) {
            const msgDate = new Date(parseInt(msg.internalDate, 10));

            if (msgDate > lastOutboundDate) {
              // Reply detected!
              logger.info({
                investorId: investor._id,
                investorName: investor.name,
                from,
                replyDate: msgDate.toISOString(),
              }, 'reply detected from investor');

              // Extract body for sentiment classification
              let bodyText = '';
              const textPart = msg.payload?.parts?.find(p => p.mimeType === 'text/plain');
              if (textPart?.body?.data) {
                bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
              } else if (msg.payload?.body?.data) {
                bodyText = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
              }

              const sentiment = classifySentiment(bodyText);
              logger.info({ investorId: investor._id, sentiment, bodyPreview: bodyText.slice(0, 100) }, 'classified reply sentiment');

              // Mark reply received
              await investorRepo.markReplyReceived(investor._id as Types.ObjectId, sentiment);
              repliesDetected++;

              // Auto-dismiss any pending follow-up drafts for this investor
              const pendingFollowUpDrafts = await emailDraftRepo.find({
                investorId: investor._id,
                status: 'pushed_to_gmail',
                gmail_draft_id: { $exists: true, $ne: null },
              });

              for (const pendingDraft of pendingFollowUpDrafts) {
                if (pendingDraft.gmail_draft_id) {
                  try {
                    await juliaDeleteDraft(pendingDraft.gmail_draft_id);
                    await emailDraftRepo.updateStatus(pendingDraft._id, 'rejected');

                    // Remove from Julia's inbox
                    await InboxItem.deleteOne({
                      message_id: { $regex: `investor-followup.*-${pendingDraft._id.toString()}` },
                    });

                    logger.info({
                      draftId: pendingDraft.gmail_draft_id,
                      investorId: investor._id,
                    }, 'auto-removed pending follow-up draft after reply detected');
                    draftsRemoved++;
                  } catch (deleteErr) {
                    logger.warn({
                      error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
                      draftId: pendingDraft.gmail_draft_id,
                    }, 'failed to delete pending draft from gmail');
                  }
                }
              }

              await writeAuditEvent({
                actor: 'system',
                actorType: 'system',
                eventType: 'investor.reply_detected',
                payload: {
                  investorId: investor._id.toString(),
                  investorName: investor.name,
                  sentiment,
                  from,
                  draftsRemoved: pendingFollowUpDrafts.length,
                },
              });

              break; // Only process first reply
            }
          }
        }
      } catch (threadErr) {
        const errMsg = threadErr instanceof Error ? threadErr.message : String(threadErr);
        logger.warn({ error: errMsg, threadId: latestDraft.gmail_thread_id }, 'error checking thread for replies');
      }
    }

    logger.info({ checkedCount, updatedCount, repliesDetected, draftsRemoved }, 'gmail send status sync completed');

    return {
      success: true,
      checkedCount,
      updatedCount,
      repliesDetected,
      draftsRemoved,
      durationMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg }, 'gmail send status sync failed');
    return {
      success: false,
      checkedCount,
      updatedCount,
      repliesDetected,
      draftsRemoved,
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
