import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { investorRepo } from '../db/repos/investor.repo.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { Investor, IThreadMessage } from '../db/schemas/investor.js';
import { isJuliaGmailConfigured, juliaDeleteDraft } from '../services/juliaGmail.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';
import { google } from 'googleapis';
import { estimateCostUsd } from '../config/pricing.js';

const anthropic = new Anthropic();

export const JOB_NAME = 'outreach.gmailSendStatusSync';

const JULIA_EMAIL = 'julia@aedawallet.com';
const ARTUR_EMAIL = 'artur@aedawallet.com';

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

const SENTIMENT_CLASSIFICATION_PROMPT = `You are classifying investor email replies to a startup's outreach.

The startup (aeda) sent a fundraising/intro email to an investor. The investor has replied. Your task is to classify the reply sentiment:

- "positive": The investor is interested, wants to learn more, requests the deck, suggests a call, asks follow-up questions, or gives any indication they want to continue the conversation.
- "negative": The investor is declining, passing, not interested, says it's not a fit, outside their scope/mandate/focus, not investing right now, or any form of rejection — even if politely worded.

Important: Polite rejections ("unfortunately", "best of luck", "not in our scope") are NEGATIVE, not positive. The presence of pleasantries does not make a decline positive.

Reply with ONLY the word "positive" or "negative" — no explanation, no punctuation.`;

interface SentimentClassificationResult {
  sentiment: 'positive' | 'negative';
  costUsd: number;
  rawResponse: string;
}

async function classifySentimentWithLLM(body: string, investorName: string): Promise<SentimentClassificationResult> {
  const truncatedBody = body.slice(0, 2000); // Limit context to save tokens

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: SENTIMENT_CLASSIFICATION_PROMPT,
      messages: [{
        role: 'user',
        content: `Investor "${investorName}" replied:\n\n${truncatedBody}`,
      }],
    });

    const costUsd = estimateCostUsd('claude-haiku-4-5-20251001', {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });

    await costLedgerRepo.insert({
      agentOrJob: JOB_NAME,
      packageId: null,
      projectKey: null,
      llmModel: 'claude-haiku-4-5-20251001',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
      estimatedMaxUsd: costUsd,
      tier: 'background',
    });

    const rawResponse = response.content[0]?.type === 'text' ? response.content[0].text.trim().toLowerCase() : '';

    logger.info({
      investorName,
      bodyPreview: truncatedBody.slice(0, 150),
      rawResponse,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd,
    }, 'LLM sentiment classification completed');

    // Parse response - default to negative if unclear (safer for rejection detection)
    const sentiment: 'positive' | 'negative' = rawResponse.includes('positive') ? 'positive' : 'negative';

    return { sentiment, costUsd, rawResponse };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errMsg, investorName }, 'LLM sentiment classification failed, defaulting to negative');
    // Default to negative on error - safer to flag for human review
    return { sentiment: 'negative', costUsd: 0, rawResponse: `ERROR: ${errMsg}` };
  }
}

export interface GmailSendStatusSyncResult {
  success: boolean;
  checkedCount: number;
  updatedCount: number;
  repliesDetected: number;
  draftsRemoved: number;
  threadsSynced: number;
  durationMs: number;
  error?: string;
}

export async function runGmailSendStatusSync(): Promise<GmailSendStatusSyncResult> {
  const startTime = Date.now();
  let checkedCount = 0;
  let updatedCount = 0;
  let repliesDetected = 0;
  let draftsRemoved = 0;
  let threadsSynced = 0;

  if (!isJuliaGmailConfigured()) {
    logger.warn('julia gmail not configured, skipping send status sync');
    return {
      success: false,
      checkedCount: 0,
      updatedCount: 0,
      repliesDetected: 0,
      draftsRemoved: 0,
      threadsSynced: 0,
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
      threadsSynced: 0,
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
        const draftCheckResponse = await gmailClient.users.drafts.get({
          userId: 'me',
          id: draft.gmail_draft_id,
        });

        // Gmail keeps draft metadata even after sending - check if MESSAGE has SENT label
        const messageId = draftCheckResponse.data.message?.id;
        if (messageId) {
          try {
            const messageResponse = await gmailClient.users.messages.get({
              userId: 'me',
              id: messageId,
              format: 'metadata',
            });
            const labels = messageResponse.data.labelIds || [];
            const isDraft = labels.includes('DRAFT');
            const isSent = labels.includes('SENT');

            if (!isDraft && isSent) {
              logger.info({
                draftId: draft._id.toString(),
                gmailDraftId: draft.gmail_draft_id,
                investorId: draft.investorId,
              }, 'draft message has SENT label - marking as sent');

              let sentAt: Date | null = null;
              if (messageResponse.data.internalDate) {
                sentAt = new Date(parseInt(messageResponse.data.internalDate, 10));
              }

              await emailDraftRepo.markAsSent(draft._id, sentAt || new Date());
              updatedCount++;

              // Update investor record when email is sent
              if (draft.investorId) {
                const contactDate = sentAt || new Date();
                const contactDateStr = contactDate.toISOString().split('T')[0]; // YYYY-MM-DD format

                const updatePayload: Record<string, unknown> = {
                  lastContact: contactDateStr,
                };

                if (draft.draftType === 'first_email') {
                  const investor = await investorRepo.findById(draft.investorId);
                  if (investor && !investor.firstEmailSentAt) {
                    updatePayload['firstEmailSentAt'] = contactDate;
                  }
                }

                await Investor.findByIdAndUpdate(draft.investorId, {
                  ...updatePayload,
                  $push: { activityLog: { action: `${draft.draftType || 'email'}_sent_auto`, at: new Date() } },
                });
                logger.info({ investorId: draft.investorId, lastContact: contactDateStr }, 'updated investor lastContact on send detection');
              }
              continue;
            }
          } catch (msgErr) {
            logger.warn({
              draftId: draft._id.toString(),
              messageId,
              error: msgErr instanceof Error ? msgErr.message : String(msgErr),
            }, 'failed to check message labels');
          }
        }
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

          // Update investor record when email is sent
          if (draft.investorId) {
            const contactDate = sentAt || new Date();
            const contactDateStr = contactDate.toISOString().split('T')[0]; // YYYY-MM-DD format

            const updatePayload: Record<string, unknown> = {
              lastContact: contactDateStr,
            };

            if (draft.draftType === 'first_email') {
              const investor = await investorRepo.findById(draft.investorId);
              if (investor && !investor.firstEmailSentAt) {
                updatePayload['firstEmailSentAt'] = contactDate;
              }
            }

            await Investor.findByIdAndUpdate(draft.investorId, {
              ...updatePayload,
              $push: { activityLog: { action: `${draft.draftType || 'email'}_sent_auto`, at: new Date() } },
            });
            logger.info({ investorId: draft.investorId, lastContact: contactDateStr }, 'updated investor lastContact on send detection (draft 404)');
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

              const classificationResult = await classifySentimentWithLLM(bodyText, investor.name);
              const sentiment = classificationResult.sentiment;
              logger.info({
                investorId: investor._id,
                sentiment,
                bodyPreview: bodyText.slice(0, 100),
                rawLLMResponse: classificationResult.rawResponse,
                classificationCostUsd: classificationResult.costUsd,
              }, 'classified reply sentiment via LLM');

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

    // ═══════════════════════════════════════════════════════════════════
    // PART 3: Sync full thread messages for investors with gmail_thread_id
    // ═══════════════════════════════════════════════════════════════════
    const investorsWithThreads = await Investor.find({
      firstEmailSentAt: { $exists: true, $ne: null },
    }).exec();

    logger.info({ count: investorsWithThreads.length }, 'syncing thread messages for investors');

    for (const investor of investorsWithThreads) {
      // Find the gmail_thread_id from drafts
      const sentDrafts = await emailDraftRepo.find({
        investorId: investor._id,
        gmail_thread_id: { $exists: true, $ne: null },
        status: 'sent',
      });

      if (sentDrafts.length === 0) continue;

      const threadId = sentDrafts[0]?.gmail_thread_id;
      if (!threadId) continue;

      try {
        const threadResponse = await gmailClient.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = threadResponse.data.messages || [];
        const threadMessages: IThreadMessage[] = [];

        for (const msg of messages) {
          const labels = msg.labelIds || [];
          // Skip draft-only messages (not yet sent)
          if (labels.includes('DRAFT') && !labels.includes('SENT')) continue;

          const headers = msg.payload?.headers || [];
          const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
          const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';

          const isOutbound = from.includes(JULIA_EMAIL) || from.includes(ARTUR_EMAIL);

          // Extract body text
          let bodyText = '';
          const textPart = msg.payload?.parts?.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          } else if (msg.payload?.body?.data) {
            bodyText = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
          }

          const sentAt = msg.internalDate
            ? new Date(parseInt(msg.internalDate, 10))
            : new Date();

          threadMessages.push({
            gmailMessageId: msg.id || '',
            direction: isOutbound ? 'outbound' : 'inbound',
            from,
            to,
            subject,
            bodyText,
            sentAt,
            labelIds: labels,
          });
        }

        // Sort chronologically
        threadMessages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

        // Update investor with thread messages
        await Investor.findByIdAndUpdate(investor._id, {
          threadMessages,
          threadSyncedAt: new Date(),
          emailThreadId: threadId,
        });

        threadsSynced++;
        logger.info({
          investorId: investor._id,
          investorName: investor.name,
          messageCount: threadMessages.length,
        }, 'synced thread messages for investor');
      } catch (syncErr) {
        const errMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        logger.warn({ error: errMsg, investorId: investor._id }, 'failed to sync thread messages');
      }
    }

    logger.info({ checkedCount, updatedCount, repliesDetected, draftsRemoved, threadsSynced }, 'gmail send status sync completed');

    return {
      success: true,
      checkedCount,
      updatedCount,
      repliesDetected,
      draftsRemoved,
      threadsSynced,
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
      threadsSynced,
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
