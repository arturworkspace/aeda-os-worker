import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { investorRepo } from '../db/repos/investor.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { businessDaysBetween } from '../lib/dates.js';
import { routedCall, getTextContent } from '../core/modelRouter.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { getPersona } from '../agents/personas.js';
import { createDraft, isGmailConfigured } from '../services/gmail.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'investor.followUpScheduler';

const FOLLOW_UP_1_BUSINESS_DAYS = 5;
const FOLLOW_UP_2_BUSINESS_DAYS = 7;

// Test mode: env vars to use minute-based thresholds instead of business days
const FOLLOWUP_1_TEST_MINUTES = process.env['FOLLOWUP_1_TEST_MINUTES']
  ? parseInt(process.env['FOLLOWUP_1_TEST_MINUTES'], 10)
  : null;
const FOLLOWUP_2_TEST_MINUTES = process.env['FOLLOWUP_2_TEST_MINUTES']
  ? parseInt(process.env['FOLLOWUP_2_TEST_MINUTES'], 10)
  : null;

function minutesBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 60000);
}

function shouldTriggerFollowUp1(firstEmailSentAt: Date, now: Date): boolean {
  if (FOLLOWUP_1_TEST_MINUTES !== null) {
    return minutesBetween(firstEmailSentAt, now) >= FOLLOWUP_1_TEST_MINUTES;
  }
  return businessDaysBetween(firstEmailSentAt, now) >= FOLLOW_UP_1_BUSINESS_DAYS;
}

function shouldTriggerFollowUp2(followUp1SentAt: Date, now: Date): boolean {
  if (FOLLOWUP_2_TEST_MINUTES !== null) {
    return minutesBetween(followUp1SentAt, now) >= FOLLOWUP_2_TEST_MINUTES;
  }
  return businessDaysBetween(followUp1SentAt, now) >= FOLLOW_UP_2_BUSINESS_DAYS;
}

interface DraftResponse {
  subject: string;
  body: string;
}

function parseDraftResponse(text: string): DraftResponse {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        subject: typeof parsed['subject'] === 'string' ? parsed['subject'] : 'Follow-up',
        body: typeof parsed['body'] === 'string' ? parsed['body'] : text,
      };
    }
  } catch {
    // fall through to plain text
  }
  return {
    subject: 'Follow-up',
    body: text,
  };
}

export interface FollowUpSchedulerResult {
  success: boolean;
  draftsCreated: number;
  totalCostUsd: number;
  durationMs: number;
  error?: string | undefined;
}

export async function runFollowUpScheduler(): Promise<FollowUpSchedulerResult> {
  const startTime = Date.now();
  let success = false;
  let errorMessage: string | undefined;
  let draftsCreated = 0;
  let totalCostUsd = 0;

  // Log which mode is active
  if (FOLLOWUP_1_TEST_MINUTES !== null) {
    logger.info({ minutes: FOLLOWUP_1_TEST_MINUTES }, 'using TEST MODE: minute threshold for followup1');
  } else {
    logger.info({ days: FOLLOW_UP_1_BUSINESS_DAYS }, 'using production business-day threshold for followup1');
  }
  if (FOLLOWUP_2_TEST_MINUTES !== null) {
    logger.info({ minutes: FOLLOWUP_2_TEST_MINUTES }, 'using TEST MODE: minute threshold for followup2');
  } else {
    logger.info({ days: FOLLOW_UP_2_BUSINESS_DAYS }, 'using production business-day threshold for followup2');
  }

  try {
    const julia = getPersona('julia');
    if (!julia) {
      throw new Error('julia persona not found');
    }

    const now = new Date();

    // ═══════════════════════════════════════════════════════════════════
    // FOLLOW-UP 1: investors needing first follow-up
    // ═══════════════════════════════════════════════════════════════════
    const needingFollowUp1 = await investorRepo.findNeedingFollowUp1();
    logger.info({ count: needingFollowUp1.length }, 'investors checked for follow-up 1');

    for (const investor of needingFollowUp1) {
      if (!investor.firstEmailSentAt) continue;

      if (!shouldTriggerFollowUp1(investor.firstEmailSentAt, now)) continue;
      const daysSinceFirst = businessDaysBetween(investor.firstEmailSentAt, now);

        // Check if draft already exists (hard cap: never create duplicate)
        const existingDraft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup1'
        );
        if (existingDraft) {
          logger.info({ investorId: investor._id, name: investor.name }, 'follow-up 1 draft already exists, skipping');
          continue;
        }

        // Generate draft via Julia
        const result = await routedCall({
          tier: 'production',
          agentOrJob: 'julia',
          system: julia.systemPrompt + '\n\nYou are drafting a follow-up email. Return JSON with "subject" and "body" fields.',
          messages: [
            {
              role: 'user',
              content: `Draft a follow-up 1 email for investor outreach. This is the first follow-up, sent 5 business days after the initial email.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}

Rules:
- Write as Artur (CEO), first person
- Keep it brief (under 100 words)
- Reference the initial email
- Add one small new data point if possible
- Professional but warm
- No signature needed

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 400,
        });

        totalCostUsd += result.costUsd;
        const draftText = getTextContent(result.response);
        const draftContent = parseDraftResponse(draftText);

        // Create draft in os_email_drafts
        const emailDraft = await emailDraftRepo.create({
          drafted_by_agent: 'julia',
          to: investor.email,
          subject: draftContent.subject,
          body: draftContent.body,
          thread_context: `Follow-up 1 for ${investor.name} (${investor.firm})`,
          investorId: investor._id as Types.ObjectId,
          followUpStage: 'followup1',
        });

        // Create InboxItem so draft appears in Julia's inbox
        const inboxItem = new InboxItem({
          recipient: 'julia@aeda.internal',
          sender_email: 'system@aeda.internal',
          sender_name: 'aeda System',
          subject: `Follow-up 1 email drafted for ${investor.name}`,
          body_raw: '',
          body_sanitized: '',
          body_hardened: '',
          body_text: draftContent.body,
          body_html: '',
          attachments: [],
          agent_commentary: `Follow-up email ready for review. Investor: ${investor.name} (${investor.firm || 'Unknown'})`,
          draft_text: draftContent.body,
          received_at: new Date(),
          message_id: `investor-followup1-draft-${(emailDraft._id as Types.ObjectId).toHexString()}`,
          in_reply_to: null,
          crm_match: {
            matched: true,
            investor_id: (investor._id as Types.ObjectId).toHexString(),
            investor_name: investor.name,
            matched_on: null,
          },
          routing: {
            artur_classification: 'investor_outreach',
            routed_to_agent: 'julia',
            artur_brief: `Follow-up 1 draft for ${investor.name}`,
            lilit_task_id: null,
          },
          draft_id: emailDraft._id as Types.ObjectId,
          processing_status: 'draft_created',
          processing_error: null,
          cost_usd: 0,
        });
        await inboxItem.save();

        // Push to Gmail drafts if configured
        if (isGmailConfigured() && investor.email) {
          try {
            const gmailResult = await createDraft(
              investor.email,
              draftContent.subject,
              draftContent.body,
              investor.emailThreadId || undefined
            );
            await emailDraftRepo.updateGmailInfo(
              emailDraft._id as Types.ObjectId,
              gmailResult.draftId,
              gmailResult.messageId
            );
          } catch (gmailError) {
            const errMsg = gmailError instanceof Error ? gmailError.message : String(gmailError);
            logger.warn({ error: errMsg, investorId: investor._id }, 'gmail draft creation failed for follow-up 1');
          }
        }

        // Mark follow-up 1 as scheduled (creates activity log entry)
        await investorRepo.markFollowUp1Sent(investor._id as Types.ObjectId);

        draftsCreated++;
        logger.info(
          { investorId: investor._id, name: investor.name, daysSinceFirst },
          'follow-up 1 draft created'
        );

        await writeAuditEvent({
          actor: 'julia',
          actorType: 'agent',
          eventType: 'investor.followup_draft_created',
          payload: {
            investorId: (investor._id as Types.ObjectId).toString(),
            investorName: investor.name,
            followUpStage: 'followup1',
            daysSinceFirst,
            costUsd: result.costUsd,
          },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // FOLLOW-UP 2: investors needing second follow-up
      // ═══════════════════════════════════════════════════════════════════
      const needingFollowUp2 = await investorRepo.findNeedingFollowUp2();
      logger.info({ count: needingFollowUp2.length }, 'investors checked for follow-up 2');

      for (const investor of needingFollowUp2) {
        if (!investor.followUp1SentAt) continue;

        if (!shouldTriggerFollowUp2(investor.followUp1SentAt, now)) continue;
        const daysSinceFollowUp1 = businessDaysBetween(investor.followUp1SentAt, now);

        // Check if draft already exists (hard cap: never create duplicate)
        const existingDraft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup2'
        );
        if (existingDraft) {
          logger.info({ investorId: investor._id, name: investor.name }, 'follow-up 2 draft already exists, skipping');
          continue;
        }

        // Generate draft via Julia
        const result = await routedCall({
          tier: 'production',
          agentOrJob: 'julia',
          system: julia.systemPrompt + '\n\nYou are drafting a follow-up email. Return JSON with "subject" and "body" fields.',
          messages: [
            {
              role: 'user',
              content: `Draft a follow-up 2 email for investor outreach. This is the final follow-up, sent 7 business days after follow-up 1.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}

Rules:
- Write as Artur (CEO), first person
- Keep it very brief (under 75 words)
- This is a final check-in, respect their time
- Offer to close the loop if not a fit
- Professional and gracious
- No signature needed

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 300,
        });

        totalCostUsd += result.costUsd;
        const draftText = getTextContent(result.response);
        const draftContent = parseDraftResponse(draftText);

        // Create draft in os_email_drafts
        const emailDraft = await emailDraftRepo.create({
          drafted_by_agent: 'julia',
          to: investor.email,
          subject: draftContent.subject,
          body: draftContent.body,
          thread_context: `Follow-up 2 (final) for ${investor.name} (${investor.firm})`,
          investorId: investor._id as Types.ObjectId,
          followUpStage: 'followup2',
        });

        // Create InboxItem so draft appears in Julia's inbox
        const inboxItem2 = new InboxItem({
          recipient: 'julia@aeda.internal',
          sender_email: 'system@aeda.internal',
          sender_name: 'aeda System',
          subject: `Follow-up 2 (final) email drafted for ${investor.name}`,
          body_raw: '',
          body_sanitized: '',
          body_hardened: '',
          body_text: draftContent.body,
          body_html: '',
          attachments: [],
          agent_commentary: `Final follow-up email ready for review. Investor: ${investor.name} (${investor.firm || 'Unknown'})`,
          draft_text: draftContent.body,
          received_at: new Date(),
          message_id: `investor-followup2-draft-${(emailDraft._id as Types.ObjectId).toHexString()}`,
          in_reply_to: null,
          crm_match: {
            matched: true,
            investor_id: (investor._id as Types.ObjectId).toHexString(),
            investor_name: investor.name,
            matched_on: null,
          },
          routing: {
            artur_classification: 'investor_outreach',
            routed_to_agent: 'julia',
            artur_brief: `Follow-up 2 (final) draft for ${investor.name}`,
            lilit_task_id: null,
          },
          draft_id: emailDraft._id as Types.ObjectId,
          processing_status: 'draft_created',
          processing_error: null,
          cost_usd: 0,
        });
        await inboxItem2.save();

        // Push to Gmail drafts if configured
        if (isGmailConfigured() && investor.email) {
          try {
            const gmailResult = await createDraft(
              investor.email,
              draftContent.subject,
              draftContent.body,
              investor.emailThreadId || undefined
            );
            await emailDraftRepo.updateGmailInfo(
              emailDraft._id as Types.ObjectId,
              gmailResult.draftId,
              gmailResult.messageId
            );
          } catch (gmailError) {
            const errMsg = gmailError instanceof Error ? gmailError.message : String(gmailError);
            logger.warn({ error: errMsg, investorId: investor._id }, 'gmail draft creation failed for follow-up 2');
          }
        }

        // Mark follow-up 2 as scheduled (creates activity log entry)
        await investorRepo.markFollowUp2Sent(investor._id as Types.ObjectId);

        draftsCreated++;
        logger.info(
          { investorId: investor._id, name: investor.name, daysSinceFollowUp1 },
          'follow-up 2 draft created'
        );

        await writeAuditEvent({
          actor: 'julia',
          actorType: 'agent',
          eventType: 'investor.followup_draft_created',
          payload: {
            investorId: (investor._id as Types.ObjectId).toString(),
            investorName: investor.name,
            followUpStage: 'followup2',
            daysSinceFollowUp1,
            costUsd: result.costUsd,
          },
        });
      }

    success = true;
    logger.info({ draftsCreated, totalCostUsd }, 'follow-up scheduler completed');
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'follow-up scheduler failed');
  } finally {
    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'job.run',
      payload: {
        jobName: JOB_NAME,
        success,
        draftsCreated,
        totalCostUsd,
        durationMs: Date.now() - startTime,
        error: errorMessage,
      },
    });
  }

  return {
    success,
    draftsCreated,
    totalCostUsd,
    durationMs: Date.now() - startTime,
    error: errorMessage,
  };
}

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (_job: Job) => {
    await runFollowUpScheduler();
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  await agenda.every('0 8 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('scheduled investor follow-up scheduler job for 08:00 Europe/Prague daily');
}
