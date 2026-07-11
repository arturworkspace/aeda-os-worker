import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { investorRepo } from '../db/repos/investor.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { OsSettings } from '../db/schemas/osSettings.js';
import { businessDaysBetween } from '../lib/dates.js';
import { routedCall, getTextContent } from '../core/modelRouter.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { getPersona } from '../agents/personas.js';
import { isJuliaGmailConfigured, juliaCreateDraft } from '../services/juliaGmail.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'investor.followUpScheduler';

// Forbidden placeholders that must be filled in before creating a draft
const FORBIDDEN_PLACEHOLDERS = [
  '[PENDING FINANCIAL UPDATE]',
  '[First Name]',
  '[FIRST NAME]',
];

interface PlaceholderValidationResult {
  valid: boolean;
  foundPlaceholder?: string;
}

function validateNoForbiddenPlaceholders(subject: string, body: string, investorName?: string): PlaceholderValidationResult {
  for (const placeholder of FORBIDDEN_PLACEHOLDERS) {
    if (body.includes(placeholder) || subject.includes(placeholder)) {
      console.log(`[placeholder-gate] BLOCKED draft for "${investorName || 'unknown'}" - found: ${placeholder}`);
      return { valid: false, foundPlaceholder: placeholder };
    }
  }
  console.log(`[placeholder-gate] PASSED validation for "${investorName || 'unknown'}"`);
  return { valid: true };
}

const FOLLOW_UP_1_BUSINESS_DAYS = 5;
const FOLLOW_UP_2_BUSINESS_DAYS = 7;

const FOLLOW_UP_POSITIONING_GUARDRAILS = `
CRITICAL — GEOGRAPHIC POSITIONING:
Never name Armenia specifically in the email. aeda's positioning is the broader EU/US <> Eastern Europe & Central Asia (EECA) corridor, not a single country. Do not say "EU-Armenia corridor," "EUR-AMD," or reference Armenia by name.

CRITICAL — COMPANY DESCRIPTION (if needed):
Describe aeda only as "cross-border payment infrastructure built on stablecoin rails and blockchain for individuals and businesses" — never name specific stablecoins (EURC, USDC, etc.).

CRITICAL — MARKET SIZE:
If a market-size reference is used, only "$81B annual corridor" or "$81B market" — no other figure.

CRITICAL — FINANCIAL FIGURES:
For any specific financial metric (burn rate, cash position, runway months, revenue, funding target amount, traction numbers), you MUST use the exact placeholder text "[PENDING FINANCIAL UPDATE]" instead of inventing or inferring a number.
`.trim();

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
    // Check global outreach pause flag
    const globalSettings = await OsSettings.findOne({ key: 'global' }).lean();
    if (globalSettings?.outreachPaused) {
      logger.info({
        pausedBy: globalSettings.outreachPausedBy,
        pausedAt: globalSettings.outreachPausedAt,
      }, 'follow-up scheduler skipped - global outreach is PAUSED');
      return {
        success: true,
        draftsCreated: 0,
        totalCostUsd: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const julia = getPersona('julia');
    if (!julia) {
      throw new Error('julia persona not found');
    }

    const now = new Date();

    // ═══════════════════════════════════════════════════════════════════
    // FOLLOW-UP 1: investors needing first follow-up
    // ═══════════════════════════════════════════════════════════════════
    const needingFollowUp1 = await investorRepo.findNeedingFollowUp1();
    logger.info({
      count: needingFollowUp1.length,
      investors: needingFollowUp1.map(i => ({ id: i._id, name: i.name, firstEmailSentAt: i.firstEmailSentAt })),
    }, 'investors checked for follow-up 1');

    for (const investor of needingFollowUp1) {
      if (!investor.firstEmailSentAt) continue;

      // Round 4: Stop cadence permanently if investor has replied
      if (investor.hasReply) {
        logger.info({ investorId: investor._id, name: investor.name }, 'skipping follow-up 1 - investor has replied');
        continue;
      }

      // Check per-investor pause flag
      if (investor.outreachPaused) {
        logger.info({ investorId: investor._id, name: investor.name }, 'skipping follow-up 1 - investor outreach is PAUSED');
        continue;
      }

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

        // Fetch the original first_email for context
        const firstEmailDraft = await emailDraftRepo.findByInvestorAndDraftType(
          investor._id as Types.ObjectId,
          'first_email'
        );
        const firstEmailContext = firstEmailDraft
          ? `\n\nOriginal email sent:\nSubject: ${firstEmailDraft.subject}\nBody: ${firstEmailDraft.body}`
          : '';

        // Generate draft via Julia
        const result = await routedCall({
          tier: 'production',
          agentOrJob: 'julia',
          system: julia.systemPrompt + '\n\nYou are drafting a follow-up email. Return JSON with "subject" and "body" fields.\n\n' + FOLLOW_UP_POSITIONING_GUARDRAILS,
          messages: [
            {
              role: 'user',
              content: `Draft a follow-up 1 email for investor outreach. This is the first follow-up, sent 5 business days after the initial email.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}${firstEmailContext}

Rules:
- Write as Artur (CEO), first person
- Keep it brief (under 100 words)
- Reference the initial email naturally (you have it above for context)
- Add one small new data point if possible
- Professional but warm
- If the contact's first name is not known or not provided, use a generic greeting like "Hi," or "Hi there," — NEVER output a bracketed placeholder token like "[First Name]" or similar in the final email text
- End with signature block (blank line before it):

Best Regards
Julia Maklakova
Fundraising manager

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 400,
        });

        totalCostUsd += result.costUsd;
        const draftText = getTextContent(result.response);
        const draftContent = parseDraftResponse(draftText);

        // Validate no forbidden placeholders BEFORE saving draft
        const placeholderCheck = validateNoForbiddenPlaceholders(draftContent.subject, draftContent.body, investor.name);
        if (!placeholderCheck.valid) {
          logger.error({
            investorId: investor._id,
            investorName: investor.name,
            placeholder: placeholderCheck.foundPlaceholder,
            followUpStage: 'followup1',
          }, 'BLOCKED: AI-generated follow-up 1 draft contains unfilled placeholder - not saving');

          // Create error inbox item
          const errorInboxItem = new InboxItem({
            recipient: 'julia@aeda.internal',
            sender_email: 'system@aeda.internal',
            sender_name: 'aeda System',
            subject: `⚠️ Follow-up 1 BLOCKED for ${investor.name}: unfilled placeholder`,
            body_raw: '',
            body_sanitized: '',
            body_hardened: '',
            body_text: `The AI-generated follow-up 1 for ${investor.name} was blocked because it contains: ${placeholderCheck.foundPlaceholder}\n\nPlease manually draft this email.`,
            body_html: '',
            attachments: [],
            agent_commentary: `Draft blocked: ${placeholderCheck.foundPlaceholder}`,
            received_at: new Date(),
            message_id: `placeholder-block-fu1-${(investor._id as Types.ObjectId).toHexString()}-${Date.now()}`,
            in_reply_to: null,
            crm_match: {
              matched: true,
              investor_id: (investor._id as Types.ObjectId).toHexString(),
              investor_name: investor.name,
              matched_on: null,
            },
            routing: {
              artur_classification: 'system_alert',
              routed_to_agent: 'julia',
              artur_brief: `Follow-up 1 blocked for ${investor.name}`,
              lilit_task_id: null,
            },
            processing_status: 'blocked',
            processing_error: `Unfilled placeholder: ${placeholderCheck.foundPlaceholder}`,
            cost_usd: 0,
          });
          await errorInboxItem.save();
          continue; // Skip this investor, move to next
        }

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

        // Push to Julia's Gmail drafts if configured (best-effort, non-blocking)
        if (isJuliaGmailConfigured() && investor.email) {
          try {
            // Use first_email's threadId and rfc822MessageId for proper Gmail threading
            const threadId = firstEmailDraft?.gmail_thread_id ?? undefined;
            const inReplyToMessageId = firstEmailDraft?.gmail_rfc822_message_id ?? undefined;
            const gmailResult = await juliaCreateDraft(
              investor.email,
              draftContent.subject,
              draftContent.body,
              threadId || inReplyToMessageId ? { threadId, inReplyToMessageId } : undefined
            );
            await emailDraftRepo.updateGmailInfo(
              emailDraft._id as Types.ObjectId,
              gmailResult.draftId,
              gmailResult.messageId,
              gmailResult.threadId,
              gmailResult.rfc822MessageId
            );
            logger.info(
              { investorId: investor._id, gmailDraftId: gmailResult.draftId, threadId: gmailResult.threadId, rfc822MessageId: gmailResult.rfc822MessageId },
              'follow-up 1 draft pushed to julia gmail'
            );
          } catch (gmailError) {
            const errMsg = gmailError instanceof Error ? gmailError.message : String(gmailError);
            logger.warn({ error: errMsg, investorId: investor._id }, 'julia gmail draft creation failed for follow-up 1');
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

        // Round 4: Stop cadence permanently if investor has replied
        if (investor.hasReply) {
          logger.info({ investorId: investor._id, name: investor.name }, 'skipping follow-up 2 - investor has replied');
          continue;
        }

        // Check per-investor pause flag
        if (investor.outreachPaused) {
          logger.info({ investorId: investor._id, name: investor.name }, 'skipping follow-up 2 - investor outreach is PAUSED');
          continue;
        }

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

        // Fetch the original first_email for context
        const firstEmailDraft = await emailDraftRepo.findByInvestorAndDraftType(
          investor._id as Types.ObjectId,
          'first_email'
        );
        const firstEmailContext = firstEmailDraft
          ? `\n\nOriginal email sent:\nSubject: ${firstEmailDraft.subject}\nBody: ${firstEmailDraft.body}`
          : '';

        // Fetch followup1 draft for Gmail threading (continue the thread chain)
        const followup1Draft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup1'
        );

        // Generate draft via Julia
        const result = await routedCall({
          tier: 'production',
          agentOrJob: 'julia',
          system: julia.systemPrompt + '\n\nYou are drafting a follow-up email. Return JSON with "subject" and "body" fields.\n\n' + FOLLOW_UP_POSITIONING_GUARDRAILS,
          messages: [
            {
              role: 'user',
              content: `Draft a follow-up 2 email for investor outreach. This is the final follow-up, sent 7 business days after follow-up 1.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}${firstEmailContext}

Rules:
- Write as Artur (CEO), first person
- Keep it very brief (under 75 words)
- This is a final check-in, respect their time
- Offer to close the loop if not a fit (this is intentionally different from the first-email CTA — it's a graceful exit)
- Professional and gracious
- If the contact's first name is not known or not provided, use a generic greeting like "Hi," or "Hi there," — NEVER output a bracketed placeholder token like "[First Name]" or similar in the final email text
- End with signature block (blank line before it):

Best Regards
Julia Maklakova
Fundraising manager

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 300,
        });

        totalCostUsd += result.costUsd;
        const draftText = getTextContent(result.response);
        const draftContent = parseDraftResponse(draftText);

        // Validate no forbidden placeholders BEFORE saving draft
        const placeholderCheck2 = validateNoForbiddenPlaceholders(draftContent.subject, draftContent.body, investor.name);
        if (!placeholderCheck2.valid) {
          logger.error({
            investorId: investor._id,
            investorName: investor.name,
            placeholder: placeholderCheck2.foundPlaceholder,
            followUpStage: 'followup2',
          }, 'BLOCKED: AI-generated follow-up 2 draft contains unfilled placeholder - not saving');

          // Create error inbox item
          const errorInboxItem2 = new InboxItem({
            recipient: 'julia@aeda.internal',
            sender_email: 'system@aeda.internal',
            sender_name: 'aeda System',
            subject: `⚠️ Follow-up 2 BLOCKED for ${investor.name}: unfilled placeholder`,
            body_raw: '',
            body_sanitized: '',
            body_hardened: '',
            body_text: `The AI-generated follow-up 2 for ${investor.name} was blocked because it contains: ${placeholderCheck2.foundPlaceholder}\n\nPlease manually draft this email.`,
            body_html: '',
            attachments: [],
            agent_commentary: `Draft blocked: ${placeholderCheck2.foundPlaceholder}`,
            received_at: new Date(),
            message_id: `placeholder-block-fu2-${(investor._id as Types.ObjectId).toHexString()}-${Date.now()}`,
            in_reply_to: null,
            crm_match: {
              matched: true,
              investor_id: (investor._id as Types.ObjectId).toHexString(),
              investor_name: investor.name,
              matched_on: null,
            },
            routing: {
              artur_classification: 'system_alert',
              routed_to_agent: 'julia',
              artur_brief: `Follow-up 2 blocked for ${investor.name}`,
              lilit_task_id: null,
            },
            processing_status: 'blocked',
            processing_error: `Unfilled placeholder: ${placeholderCheck2.foundPlaceholder}`,
            cost_usd: 0,
          });
          await errorInboxItem2.save();
          continue; // Skip this investor, move to next
        }

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

        // Push to Julia's Gmail drafts if configured (best-effort, non-blocking)
        if (isJuliaGmailConfigured() && investor.email) {
          try {
            // Use followup1's threadId and rfc822MessageId to continue the thread chain (fall back to first_email's)
            const threadId = followup1Draft?.gmail_thread_id ?? firstEmailDraft?.gmail_thread_id ?? undefined;
            const inReplyToMessageId = followup1Draft?.gmail_rfc822_message_id ?? firstEmailDraft?.gmail_rfc822_message_id ?? undefined;
            const gmailResult = await juliaCreateDraft(
              investor.email,
              draftContent.subject,
              draftContent.body,
              threadId || inReplyToMessageId ? { threadId, inReplyToMessageId } : undefined
            );
            await emailDraftRepo.updateGmailInfo(
              emailDraft._id as Types.ObjectId,
              gmailResult.draftId,
              gmailResult.messageId,
              gmailResult.threadId,
              gmailResult.rfc822MessageId
            );
            logger.info(
              { investorId: investor._id, gmailDraftId: gmailResult.draftId, threadId: gmailResult.threadId, rfc822MessageId: gmailResult.rfc822MessageId },
              'follow-up 2 draft pushed to julia gmail'
            );
          } catch (gmailError) {
            const errMsg = gmailError instanceof Error ? gmailError.message : String(gmailError);
            logger.warn({ error: errMsg, investorId: investor._id }, 'julia gmail draft creation failed for follow-up 2');
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
