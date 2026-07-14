import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { investorRepo } from '../db/repos/investor.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { OsSettings } from '../db/schemas/osSettings.js';
import { businessDaysBetween } from '../lib/dates.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { isJuliaGmailConfigured, juliaCreateDraft } from '../services/juliaGmail.js';
import { logger } from '../logger.js';
import { validateOutputCompliance } from '../lib/promptSafety.js';
import { extractFirstNameFromGreeting, buildReplySubject, renderFollowUp1Body, renderFollowUp2Body } from '../lib/outreachTemplates.js';

export const JOB_NAME = 'investor.followUpScheduler';

// Forbidden placeholders that must be filled in before creating a draft
const FORBIDDEN_PLACEHOLDERS = [
  '[PENDING FINANCIAL UPDATE]',
  '[First Name]',
  '[FIRST NAME]',
  '[Name]',
  '[NAME]',
  '[Firm]',
  '[FIRM]',
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

// Aligned to Julia's approved 4-email sequence (Day 1 -> Day 4 -> Day 9 -> Day 14):
// Follow-up 1 fires 3 business days after First Reach (Day 1 -> Day 4), Follow-up 2
// fires 5 business days after Follow-up 1 (Day 4 -> Day 9). Previously 5 and 7, which
// drifted the live cadence later than the documented/approved sequence.
const FOLLOW_UP_1_BUSINESS_DAYS = 3;
const FOLLOW_UP_2_BUSINESS_DAYS = 5;

// NOTE: the positioning guardrails and LLM-drafting prompt that used to live here were
// removed — Follow-up 1 and Follow-up 2 are now rendered from a fixed, founder-approved
// template (src/lib/outreachTemplates.ts) with no LLM call. See git history on commit
// 429a326 for the prior LLM-prompt version if ever needed for reference.

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

        // Fetch the original first_email for subject threading only — the body is now a
        // fixed, founder-approved template with no free-form generation (see below).
        const firstEmailDraft = await emailDraftRepo.findByInvestorAndDraftType(
          investor._id as Types.ObjectId,
          'first_email'
        );

        // Deterministic template rendering — no LLM call. Per @ham's cost/latency review of
        // commit 429a326: the template is fixed except for the greeting name, so paying for a
        // full Sonnet generation to reproduce a static string was pure overhead with non-zero
        // drift risk. See src/lib/outreachTemplates.ts.
        // investor.name is the FIRM name in this schema (e.g. "Lightspeed"), not a person's
        // name — pull the real contact first name back out of the first-email draft's own
        // greeting line instead (see extractFirstNameFromGreeting doc comment).
        const firstName = extractFirstNameFromGreeting(firstEmailDraft?.body);
        const draftContent: DraftResponse = {
          subject: buildReplySubject(firstEmailDraft?.subject),
          body: renderFollowUp1Body(firstName),
        };

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

        // Defense-in-depth: block on compliance-violating content even without a raw
        // placeholder (catches prompt-injection or model-drift outcomes). Per @vagho security review.
        const complianceCheck1 = validateOutputCompliance(draftContent.body);
        if (!complianceCheck1.valid) {
          logger.error({
            investorId: investor._id,
            investorName: investor.name,
            violation: complianceCheck1.violation,
            followUpStage: 'followup1',
          }, 'BLOCKED: AI-generated follow-up 1 draft failed output compliance check - not saving');

          const complianceBlockItem1 = new InboxItem({
            recipient: 'julia@aeda.internal',
            sender_email: 'system@aeda.internal',
            sender_name: 'aeda System',
            subject: `⚠️ Follow-up 1 BLOCKED for ${investor.name}: compliance violation`,
            body_raw: '',
            body_sanitized: '',
            body_hardened: '',
            body_text: `The AI-generated follow-up 1 for ${investor.name} was blocked because it failed the output compliance check: ${complianceCheck1.violation}\n\nThis usually means the draft contains disallowed content — possibly from prompt injection via investor notes or the prior email, or model drift. Review before regenerating.`,
            body_html: '',
            attachments: [],
            agent_commentary: `Draft blocked due to compliance violation: ${complianceCheck1.violation}`,
            received_at: new Date(),
            message_id: `compliance-block-fu1-${(investor._id as Types.ObjectId).toHexString()}-${Date.now()}`,
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
              artur_brief: `Follow-up 1 blocked for ${investor.name} — compliance violation`,
              lilit_task_id: null,
            },
            processing_status: 'blocked',
            processing_error: `Output compliance violation: ${complianceCheck1.violation}`,
            cost_usd: 0,
          });
          await complianceBlockItem1.save();
          continue;
        }

        // Determine recipient: testOverrideEmail takes precedence for test mode
        const recipientEmail = investor.testOverrideEmail || investor.email;

        // Create draft in os_email_drafts
        const emailDraft = await emailDraftRepo.create({
          drafted_by_agent: 'julia',
          to: recipientEmail,
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
        if (isJuliaGmailConfigured() && recipientEmail) {
          try {
            // Use first_email's threadId and rfc822MessageId for proper Gmail threading
            const threadId = firstEmailDraft?.gmail_thread_id ?? undefined;
            const inReplyToMessageId = firstEmailDraft?.gmail_rfc822_message_id ?? undefined;
            const gmailResult = await juliaCreateDraft(
              recipientEmail,
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
            costUsd: 0,
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

        // Fetch the original first_email for subject threading only — the body is now a
        // fixed, founder-approved template with no free-form generation (see below).
        const firstEmailDraft = await emailDraftRepo.findByInvestorAndDraftType(
          investor._id as Types.ObjectId,
          'first_email'
        );

        // Fetch followup1 draft for Gmail threading (continue the thread chain)
        const followup1Draft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup1'
        );

        // Deterministic template rendering — no LLM call. Per @ham's cost/latency review of
        // commit 429a326: the template is fixed except for the greeting name, so paying for a
        // full Sonnet generation to reproduce a static string was pure overhead with non-zero
        // drift risk. See src/lib/outreachTemplates.ts.
        // Same fix as follow-up 1 — real contact name lives in the first-email draft's
        // greeting, not on investor.name (which is the firm name).
        const firstName2 = extractFirstNameFromGreeting(firstEmailDraft?.body);
        const draftContent: DraftResponse = {
          subject: buildReplySubject(firstEmailDraft?.subject),
          body: renderFollowUp2Body(firstName2),
        };

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

        // Defense-in-depth: block on compliance-violating content even without a raw
        // placeholder (catches prompt-injection or model-drift outcomes). Per @vagho security review.
        const complianceCheck2 = validateOutputCompliance(draftContent.body);
        if (!complianceCheck2.valid) {
          logger.error({
            investorId: investor._id,
            investorName: investor.name,
            violation: complianceCheck2.violation,
            followUpStage: 'followup2',
          }, 'BLOCKED: AI-generated follow-up 2 draft failed output compliance check - not saving');

          const complianceBlockItem2 = new InboxItem({
            recipient: 'julia@aeda.internal',
            sender_email: 'system@aeda.internal',
            sender_name: 'aeda System',
            subject: `⚠️ Follow-up 2 BLOCKED for ${investor.name}: compliance violation`,
            body_raw: '',
            body_sanitized: '',
            body_hardened: '',
            body_text: `The AI-generated follow-up 2 for ${investor.name} was blocked because it failed the output compliance check: ${complianceCheck2.violation}\n\nThis usually means the draft contains disallowed content — possibly from prompt injection via investor notes or the prior email, or model drift. Review before regenerating.`,
            body_html: '',
            attachments: [],
            agent_commentary: `Draft blocked due to compliance violation: ${complianceCheck2.violation}`,
            received_at: new Date(),
            message_id: `compliance-block-fu2-${(investor._id as Types.ObjectId).toHexString()}-${Date.now()}`,
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
              artur_brief: `Follow-up 2 blocked for ${investor.name} — compliance violation`,
              lilit_task_id: null,
            },
            processing_status: 'blocked',
            processing_error: `Output compliance violation: ${complianceCheck2.violation}`,
            cost_usd: 0,
          });
          await complianceBlockItem2.save();
          continue;
        }

        // Determine recipient: testOverrideEmail takes precedence for test mode
        const recipientEmail2 = investor.testOverrideEmail || investor.email;

        // Create draft in os_email_drafts
        const emailDraft = await emailDraftRepo.create({
          drafted_by_agent: 'julia',
          to: recipientEmail2,
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
        if (isJuliaGmailConfigured() && recipientEmail2) {
          try {
            // Use followup1's threadId and rfc822MessageId to continue the thread chain (fall back to first_email's)
            const threadId = followup1Draft?.gmail_thread_id ?? firstEmailDraft?.gmail_thread_id ?? undefined;
            const inReplyToMessageId = followup1Draft?.gmail_rfc822_message_id ?? firstEmailDraft?.gmail_rfc822_message_id ?? undefined;
            const gmailResult = await juliaCreateDraft(
              recipientEmail2,
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
            costUsd: 0,
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
  // Read env vars at schedule time (not module load time) to pick up Railway changes
  const followup1TestMinutes = process.env['FOLLOWUP_1_TEST_MINUTES']
    ? parseInt(process.env['FOLLOWUP_1_TEST_MINUTES'], 10)
    : null;
  const followup2TestMinutes = process.env['FOLLOWUP_2_TEST_MINUTES']
    ? parseInt(process.env['FOLLOWUP_2_TEST_MINUTES'], 10)
    : null;
  const isTestMode = followup1TestMinutes !== null || followup2TestMinutes !== null;

  logger.info(`[followup-scheduler] startup config: FOLLOWUP_1_TEST_MINUTES=${followup1TestMinutes}, FOLLOWUP_2_TEST_MINUTES=${followup2TestMinutes}, isTestMode=${isTestMode}`);

  // Cancel ALL existing jobs with this name (scheduled or not) to ensure clean state
  const cancelledCount = await agenda.cancel({ name: JOB_NAME });
  logger.info(`[followup-scheduler] cancelled ${cancelledCount} existing job(s)`);

  // Schedule fresh
  const repeatInterval = isTestMode ? '1 minute' : '0 8 * * *';
  const options = isTestMode ? {} : { timezone: 'Europe/Prague' };
  await agenda.every(repeatInterval, JOB_NAME, {}, options);

  // Fetch the newly created job to log its nextRunAt
  const db = agenda._mdb;
  if (db) {
    const job = await db.collection('os_agenda_jobs').findOne({
      name: JOB_NAME,
      repeatInterval: { $exists: true },
    });
    if (job) {
      const nextRunAt = job['nextRunAt'];
      logger.info(`[followup-scheduler] scheduled: interval="${repeatInterval}", nextRunAt=${nextRunAt instanceof Date ? nextRunAt.toISOString() : nextRunAt}`);
    } else {
      logger.warn(`[followup-scheduler] job scheduled but not found in DB immediately after creation`);
    }
  } else {
    logger.info(`[followup-scheduler] scheduled: interval="${repeatInterval}" (DB not accessible for nextRunAt log)`);
  }
}
