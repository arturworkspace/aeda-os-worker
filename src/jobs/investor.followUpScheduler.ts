import { Agenda } from 'agenda';
import { Types } from 'mongoose';
import * as fs from 'fs';
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

// Test mode: env vars to use minute-based thresholds instead of business days.
// Values live only on Railway (never in .env / git) — confirmed via dashboard on
// 2026-07-14: FOLLOWUP_1_TEST_MINUTES=5, FOLLOWUP_2_TEST_MINUTES=14. Artur has
// designated this pair the baseline for pre-launch testing — do NOT change these
// on Railway (or suggest changing them) without his explicit approval first.
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
  // Bulletproof, fully-synchronous, zero-dependency entry diagnostic (added 2026-07-15,
  // 2nd attempt). The async writeAuditEvent-based "entered" diagnostic added earlier today
  // fired exactly ONCE (at the moment of a manual HTTP-triggered call) across 16 consecutive
  // scheduled ticks that all completed successfully per job.run (written later in this same
  // function's finally block) — an apparent contradiction. This line bypasses Mongoose,
  // async/await, and the audit log schema entirely: a raw synchronous fs write, so a missing
  // line here can only mean Agenda genuinely did not invoke this function body for that tick.
  try {
    fs.appendFileSync('/tmp/followup_ticks.log', `${new Date().toISOString()} pid=${process.pid}\n`);
  } catch {
    /* never let the diagnostic itself break the run */
  }

  const startTime = Date.now();
  let success = false;
  let errorMessage: string | undefined;
  let draftsCreated = 0;
  let totalCostUsd = 0;

  // Bulletproof entry diagnostic (added 2026-07-15): fires unconditionally as the very
  // first line, before the pause check, before any query. If this event is ever missing
  // for a tick where job.run DID fire, that proves Agenda is not really calling this
  // function body for that tick (e.g. a stale/duplicate job definition or lock issue) -
  // ruling in or out "the function never truly starts" vs. "it starts and exits early."
  writeAuditEvent({
    actor: 'system',
    actorType: 'system',
    eventType: 'investor.followup_scheduler_entered',
    payload: { startedAt: new Date(startTime) },
  }).catch(() => { /* never let entry diagnostic break the run */ });

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
    // Check global outreach pause flag.
    // Added .read('primary') 2026-07-15: found via direct comparison of scheduled-tick
    // durationMs (~440ms, constant, every single tick since the previous maxIdleTimeMS
    // fix) vs. a manual invocation of this exact function (3833ms, found+processed
    // Tatevik correctly). A ~440ms run is only long enough to do ONE query and return —
    // consistent with silently taking the early-return branch below on every scheduled
    // tick, despite os_settings.outreachPaused being false in the DB (verified directly)
    // the whole time. This query had never had .read('primary') applied (unlike the
    // investor/emailDraft queries hardened earlier the same day), making it the one
    // remaining unhardened read on the scheduler's hot path — and the most likely
    // explanation for a long-lived-connection-only stale read that a fresh connection
    // (every manual test) would never reproduce.
    const globalSettings = await OsSettings.findOne({ key: 'global' }).read('primary').lean();
    // Unconditional raw-read diagnostic — fires every tick regardless of the value,
    // so we can see exactly what this specific read saw without depending on the
    // early-exit branch also succeeding.
    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'investor.followup_scheduler_pause_flag_read',
      payload: {
        outreachPaused: globalSettings?.outreachPaused ?? null,
        found: !!globalSettings,
      },
    }).catch(() => { /* never let this diagnostic break the run */ });
    if (globalSettings?.outreachPaused) {
      logger.info({
        pausedBy: globalSettings.outreachPausedBy,
        pausedAt: globalSettings.outreachPausedAt,
      }, 'follow-up scheduler skipped - global outreach is PAUSED');
      // Persisted diagnostic: if this fires again after the .read('primary') hardening
      // above, it proves the early-exit theory wrong and the stale read lives elsewhere.
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'investor.followup_scheduler_paused_early_exit',
        payload: {
          outreachPaused: globalSettings.outreachPaused,
          pausedBy: globalSettings.outreachPausedBy,
          pausedAt: globalSettings.outreachPausedAt,
        },
      }).catch(() => { /* never let audit logging itself break the early return */ });
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

    // Persisted alongside the per-investor trigger-check event above — this is the
    // query RESULT itself (before any per-investor filtering), so we can tell whether
    // a "missing" investor was excluded by findNeedingFollowUp1() (query/connection
    // layer) vs. excluded by later logic (hasReply/outreachPaused/willTrigger).
    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'investor.followup1_query_result',
      payload: {
        count: needingFollowUp1.length,
        investorIds: needingFollowUp1.map(i => (i._id as Types.ObjectId).toString()),
      },
    });

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

      // Diagnostic: log the exact trigger computation for every eligible investor on
      // every tick, not just when it fires. Added 2026-07-14 after a ~17-minute gap
      // where a matching investor (Tatevik Simonyan) was silently not triggered by the
      // scheduled Agenda run despite identical query logic returning her correctly when
      // invoked manually via console — root cause was never conclusively identified
      // (env vars, compiled code, and query all verified correct in production). This
      // log line exists so the next occurrence is diagnosed in seconds, not hours.
      const willTrigger1 = shouldTriggerFollowUp1(investor.firstEmailSentAt, now);
      logger.info({
        investorId: investor._id,
        name: investor.name,
        firstEmailSentAt: investor.firstEmailSentAt,
        now,
        minutesSince: minutesBetween(investor.firstEmailSentAt, now),
        testMinutesThreshold: FOLLOWUP_1_TEST_MINUTES,
        businessDaysThreshold: FOLLOW_UP_1_BUSINESS_DAYS,
        willTrigger: willTrigger1,
      }, 'follow-up 1 trigger check');

      // Persisted, queryable diagnostic (added 2026-07-14 after Railway's Deploy Logs
      // search UI proved unreliable for repeated-template lines, AND tailing PID 1's
      // stdout via /proc/1/fd/1 from a sibling shell proved unreliable too — it's a
      // pipe with a single existing consumer (Railway's log shipper), so a second
      // reader races it and gets nothing. Writing straight to os_audit_log via our
      // existing writeAuditEvent() sidesteps both problems: it's the same channel we
      // already trust for job.run/followup_draft_created events, directly queryable,
      // and immune to log-capture quirks. This is the ONLY reliable way we've found
      // to prove, after the fact, whether the scheduled run actually evaluated a given
      // investor and what it computed — do not remove until the recurring gap
      // (4 occurrences as of this commit, including one AFTER the read('primary')
      // hardening) is conclusively root-caused.
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'investor.followup1_trigger_check',
        payload: {
          investorId: (investor._id as Types.ObjectId).toString(),
          investorName: investor.name,
          firstEmailSentAt: investor.firstEmailSentAt,
          now,
          minutesSince: minutesBetween(investor.firstEmailSentAt, now),
          testMinutesThreshold: FOLLOWUP_1_TEST_MINUTES,
          willTrigger: willTrigger1,
        },
      });

      if (!willTrigger1) continue;
      const daysSinceFirst = businessDaysBetween(investor.firstEmailSentAt, now);

      try {
        // Check if draft already exists (hard cap: never create duplicate)
        const existingDraft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup1'
        );
        if (existingDraft) {
          logger.info({ investorId: investor._id, name: investor.name }, 'follow-up 1 draft already exists, skipping');
          // Persisted: needed to distinguish "willTrigger was true but a stale/phantom
          // existingDraft read silently short-circuited creation" from "an exception
          // was thrown downstream" (see catch block below) or "draft genuinely created
          // but something else is wrong". emailDraftRepo has never had .read('primary')
          // applied — if THIS is where the recurring gap actually lives, it would look
          // exactly like what we've observed: success:true, draftsCreated:0, no error.
          await writeAuditEvent({
            actor: 'system',
            actorType: 'system',
            eventType: 'investor.followup1_existing_draft_skip',
            payload: {
              investorId: (investor._id as Types.ObjectId).toString(),
              investorName: investor.name,
              existingDraftId: (existingDraft._id as Types.ObjectId).toString(),
              existingDraftStatus: existingDraft.status,
              existingDraftCreatedAt: existingDraft.created_at,
            },
          });
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
      } catch (perInvestorError) {
        // Resilience: one investor's unexpected error must not silently abort the
        // whole run (previously an uncaught error here would bubble to the outer
        // catch, marking the ENTIRE job failed and skipping every other investor
        // and the follow-up 2 pass too). Log loudly and move on.
        const errMsg = perInvestorError instanceof Error ? perInvestorError.message : String(perInvestorError);
        logger.error({
          investorId: investor._id,
          name: investor.name,
          error: errMsg,
          stack: perInvestorError instanceof Error ? perInvestorError.stack : undefined,
        }, 'follow-up 1 processing failed for this investor - continuing with others');
        // Persisted twin of the logger.error above — this per-investor catch was the
        // one place in the whole draft-creation path with NO durable record, so if an
        // exception here is what's silently eating the recurring gap, we've never been
        // able to see it (logger.info/error to stdout has proven unreliable twice now).
        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'investor.followup1_processing_error',
          payload: {
            investorId: (investor._id as Types.ObjectId).toString(),
            investorName: investor.name,
            error: errMsg,
          },
        }).catch(() => { /* never let audit logging itself break the loop */ });
      }
    }

      // ═══════════════════════════════════════════════════════════════════
      // FOLLOW-UP 2: investors needing second follow-up
      // ═══════════════════════════════════════════════════════════════════
      const needingFollowUp2 = await investorRepo.findNeedingFollowUp2();
      logger.info({
        count: needingFollowUp2.length,
        investors: needingFollowUp2.map(i => ({ id: i._id, name: i.name, followUp1SentAt: i.followUp1SentAt })),
      }, 'investors checked for follow-up 2');

      // Mirrors the follow-up 1 query_result diagnostic (1911dec). Follow-up 1's own
      // recurring gap turned out to be a variable, sometimes very long delay rather
      // than a permanent miss (fired 26 min late on 2026-07-14 after being stuck since
      // the 5-min threshold) — and follow-up 2 is showing the same symptom live right
      // now (followUp1SentAt way past the 14-min threshold, no draft yet). This gives
      // the same before/after visibility for follow-up 2 that helped narrow follow-up 1.
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'investor.followup2_query_result',
        payload: {
          count: needingFollowUp2.length,
          investorIds: needingFollowUp2.map(i => (i._id as Types.ObjectId).toString()),
        },
      });

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

        // Diagnostic: same reasoning as the follow-up 1 trigger-check log above.
        const willTrigger2 = shouldTriggerFollowUp2(investor.followUp1SentAt, now);
        logger.info({
          investorId: investor._id,
          name: investor.name,
          followUp1SentAt: investor.followUp1SentAt,
          now,
          minutesSince: minutesBetween(investor.followUp1SentAt, now),
          testMinutesThreshold: FOLLOWUP_2_TEST_MINUTES,
          businessDaysThreshold: FOLLOW_UP_2_BUSINESS_DAYS,
          willTrigger: willTrigger2,
        }, 'follow-up 2 trigger check');

        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'investor.followup2_trigger_check',
          payload: {
            investorId: (investor._id as Types.ObjectId).toString(),
            investorName: investor.name,
            followUp1SentAt: investor.followUp1SentAt,
            now,
            minutesSince: minutesBetween(investor.followUp1SentAt, now),
            testMinutesThreshold: FOLLOWUP_2_TEST_MINUTES,
            willTrigger: willTrigger2,
          },
        });

        if (!willTrigger2) continue;
        const daysSinceFollowUp1 = businessDaysBetween(investor.followUp1SentAt, now);

        try {
        // Check if draft already exists (hard cap: never create duplicate)
        const existingDraft = await emailDraftRepo.findByInvestorAndStage(
          investor._id as Types.ObjectId,
          'followup2'
        );
        if (existingDraft) {
          logger.info({ investorId: investor._id, name: investor.name }, 'follow-up 2 draft already exists, skipping');
          await writeAuditEvent({
            actor: 'system',
            actorType: 'system',
            eventType: 'investor.followup2_existing_draft_skip',
            payload: {
              investorId: (investor._id as Types.ObjectId).toString(),
              investorName: investor.name,
              existingDraftId: (existingDraft._id as Types.ObjectId).toString(),
              existingDraftStatus: existingDraft.status,
              existingDraftCreatedAt: existingDraft.created_at,
            },
          });
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
        } catch (perInvestorError) {
          // Same resilience reasoning as follow-up 1's per-investor catch above.
          const errMsg = perInvestorError instanceof Error ? perInvestorError.message : String(perInvestorError);
          logger.error({
            investorId: investor._id,
            name: investor.name,
            error: errMsg,
            stack: perInvestorError instanceof Error ? perInvestorError.stack : undefined,
          }, 'follow-up 2 processing failed for this investor - continuing with others');
          await writeAuditEvent({
            actor: 'system',
            actorType: 'system',
            eventType: 'investor.followup2_processing_error',
            payload: {
              investorId: (investor._id as Types.ObjectId).toString(),
              investorName: investor.name,
              error: errMsg,
            },
          }).catch(() => { /* never let audit logging itself break the loop */ });
        }
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

// --------------------------------------------------------------------------
// 2026-07-15: Agenda-based scheduling for THIS job was removed and replaced
// with a self-managed setInterval loop. Root cause investigation (see commit
// 5d883c0 and the audit trail around it) proved, with a fully synchronous
// fs.appendFileSync diagnostic at the literal first line of
// runFollowUpScheduler, that Agenda's own job-locking/execution internals
// were NOT reliably invoking this function's body on every scheduled tick
// (1 real invocation logged vs. 7 "job.run" completions in the same
// 6-minute window) — while Agenda's own os_agenda_jobs bookkeeping
// (lastRunAt/lastFinishedAt) showed regular, healthy-looking activity the
// whole time. That contradiction is only possible if Agenda itself is doing
// something we can't fully explain or verify from the outside. Rather than
// keep trusting a black box that produces self-contradictory telemetry for
// a job Artur has explicitly called a "matter of principle" to get right,
// this job now runs on a plain, fully-inspectable interval timer owned by
// this process — no external locking, no DB-driven scheduling, nothing to
// silently disagree with itself. All other jobs (heartbeat, backups, cost
// rollup, hasmik intelligence, gmail send-status sync) are unaffected and
// still run on Agenda, since none of them showed this symptom.
// --------------------------------------------------------------------------

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastProdRunDateKey: string | null = null;

/** No-op kept only so existing defineAllJobs() call sites don't need to change. */
export function defineJob(_agenda: Agenda): void {
  logger.info('[followup-scheduler] defineJob() is a no-op — this job no longer runs via Agenda, see scheduleJob()');
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

  // Clean up any stale Agenda-scheduled job left over from before this change,
  // so there is no chance of a duplicate/competing execution path.
  const cancelledCount = await agenda.cancel({ name: JOB_NAME });
  logger.info(`[followup-scheduler] cancelled ${cancelledCount} legacy Agenda job(s) for ${JOB_NAME} (scheduling now handled by a local interval, not Agenda)`);

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  lastProdRunDateKey = null;

  // Test mode: tick every minute, exactly like before, but via a timer this
  // process owns directly. Production: tick every 5 minutes and self-gate to
  // once/day at 8am Europe/Prague inside runTick(), preserving the original
  // "0 8 * * * Europe/Prague" intent without depending on Agenda's cron parsing.
  const tickIntervalMs = isTestMode ? 60_000 : 5 * 60_000;

  const runTick = (): void => {
    void (async () => {
      if (!isTestMode) {
        const pragueDateKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Prague',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
        const pragueHour = parseInt(
          new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(new Date()),
          10
        );
        if (pragueHour !== 8 || lastProdRunDateKey === pragueDateKey) {
          return;
        }
        lastProdRunDateKey = pragueDateKey;
      }
      try {
        await runFollowUpScheduler();
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, '[followup-scheduler] interval tick threw unexpectedly');
      }
    })();
  };

  schedulerTimer = setInterval(runTick, tickIntervalMs);
  // Run one check immediately on boot/deploy instead of waiting a full interval.
  runTick();

  logger.info(`[followup-scheduler] scheduled via local setInterval: isTestMode=${isTestMode}, tickIntervalMs=${tickIntervalMs}`);
}
