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
Never name Armenia specifically in the email. aeda's positioning is the broader EU/US <> Eastern Europe & Central Asia (EECA) corridor, not a single country. Do not say "EU-Armenia corridor," "EUR-AMD," or reference Armenia by name. Always say "EU/US–EECA corridor" or "Eastern Europe and Central Asia."

CRITICAL — COMPANY DESCRIPTION:
Describe aeda as a routing and connectivity layer that connects licensed financial partners and user-controlled wallets, enabling digital money to move through more efficient cross-border rails. Never name specific stablecoins (EURC, USDC, etc.), and never say "VASP," "MiCA," or "GENIUS Act" — if regulation needs mentioning, say "regulation" generically. "Onchain," "blockchain," and "agentic commerce" are permitted when discussing the longer-term technology thesis (as in the approved Follow-up 2 template), but never attribute custody, fund holding, or direct money transmission to aeda — aeda connects and routes; licensed partners execute the regulated transfer.

CRITICAL — POSITIONING VS OTHER PLAYERS:
aeda complements banks and fintechs rather than competing with them. Never frame this as displacing or beating a named competitor.

CRITICAL — MARKET SIZE AND TRACTION FIGURES (use exactly, do not alter or invent others):
$81B annual corridor, growing 11% a year. MVP completed. Service partnerships signed. 200+ person waitlist. $75K bootstrapped. $500K pre-seed round. If a number is needed beyond this approved list, use the exact placeholder text "[PENDING FINANCIAL UPDATE]" instead of inventing or inferring one.
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

This follows an approved, fixed template (final-approved by the founder — do not deviate from its structure, claims, or tone). Personalize only the greeting name; every other sentence should closely match the reference text below, near word-for-word.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}${firstEmailContext}

REFERENCE TEMPLATE:

Hi [Name],

A quick follow-up with the simplest way to think about aeda.

Most cross-border products improve the customer interface while continuing to rely on the same underlying correspondent infrastructure. aeda addresses the infrastructure gap.

Our routing layer connects licensed partners and identifies more efficient paths across fragmented markets. For individuals, that can mean lower costs and shorter waiting times. For businesses, more reliable cross-border flows. For financial institutions, access to new corridors without rebuilding the infrastructure themselves.

Would a short call this week be useful?

Best,
Julia Maklakova
Fundraising Manager

Rules:
- Use the investor's first name if known, otherwise "Hi,". NEVER output a bracketed placeholder token like "[First Name]" or "[Name]" in the final email text.
- Keep the body text unchanged from the template above — this is an approved, founder-signed-off template, not a fresh draft. Do not add new data points or rewrite sentences.
- Signature is always exactly (blank line before it):

Best,
Julia Maklakova
Fundraising Manager

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

This follows an approved, fixed template (final-approved by the founder — do not deviate from its structure, claims, or tone). Personalize only the greeting name; every other sentence should closely match the reference text below, near word-for-word.

Investor: ${investor.name}
Firm: ${investor.firm || 'Unknown'}
Type: ${investor.type}
Notes: ${investor.notes || 'None'}${firstEmailContext}

REFERENCE TEMPLATE:

Hi [Name],

One final note on the broader opportunity behind aeda.

The immediate problem is clear: an $81B corridor remains underserved because it still depends on correspondent banking infrastructure built in the 1970s — SWIFT rails that are slow, costly, and fragmented. The longer-term opportunity is larger.

As onchain settlement, programmable money, and agentic commerce develop, more transactions will be initiated by platforms and software rather than manually by individuals. These transactions will require infrastructure that can route value securely, intelligently, and continuously across markets.

aeda is building that routing layer — starting with today's cross-border payment gap and designed for the next generation of digital commerce.

We have completed the MVP, signed service partnerships, built a 200+ person waitlist, and bootstrapped $75K. We are raising a $500K pre-seed round.

Happy to send the deck or walk you through the model in a short call.

Best,
Julia Maklakova
Fundraising Manager

Rules:
- Use the investor's first name if known, otherwise "Hi,". NEVER output a bracketed placeholder token like "[First Name]" or "[Name]" in the final email text.
- Keep the body text unchanged from the template above — this is an approved, founder-signed-off template, not a fresh draft. Do not shorten it into a graceful-exit note; it is the bold closing email, not a check-in.
- Signature is always exactly (blank line before it):

Best,
Julia Maklakova
Fundraising Manager

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 450,
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
