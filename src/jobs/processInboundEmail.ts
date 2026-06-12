import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { inboxItemRepo } from '../db/repos/inboxItem.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { sanitizeBody, hardenBody, parseRawEmail } from '../services/emailParser.js';
import { parseAttachments } from '../services/attachmentParser.js';
import { readLinks } from '../services/linkReader.js';
import { matchSender } from '../services/crmMatcher.js';
import { createDraft, isGmailConfigured } from '../services/gmail.js';
import { routedCall, getTextContent } from '../core/modelRouter.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { getPersona } from '../agents/personas.js';
import { logger } from '../logger.js';

const MONTHLY_EMAIL_BUDGET_USD = 20;

export const JOB_NAME = 'process-inbound-email';

interface ArturClassification {
  classification: string;
  urgency: string;
  routing_agent: string;
  brief_for_lilit: string;
  draft_reply_needed: boolean;
}

function parseArturResponse(text: string): ArturClassification {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('no json found');
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      classification: typeof parsed['classification'] === 'string' ? parsed['classification'] : 'unknown',
      urgency: typeof parsed['urgency'] === 'string' ? parsed['urgency'] : 'medium',
      routing_agent: typeof parsed['routing_agent'] === 'string' ? parsed['routing_agent'] : 'lilit',
      brief_for_lilit: typeof parsed['brief_for_lilit'] === 'string' ? parsed['brief_for_lilit'] : 'email requires review',
      draft_reply_needed: parsed['draft_reply_needed'] === true,
    };
  } catch {
    logger.warn({ text }, 'failed to parse artur classification, using defaults');
    return {
      classification: 'unknown',
      urgency: 'medium',
      routing_agent: 'lilit',
      brief_for_lilit: 'email requires review - classification failed',
      draft_reply_needed: false,
    };
  }
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
        subject: typeof parsed['subject'] === 'string' ? parsed['subject'] : 'Re: your email',
        body: typeof parsed['body'] === 'string' ? parsed['body'] : text,
      };
    }
  } catch {
    // fall through to plain text
  }
  return {
    subject: 'Re: your email',
    body: text,
  };
}

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (job: Job) => {
    const data = job.attrs.data as {
      inbox_item_id?: string;
      explicitly_routed_agent?: string;
      raw_email_base64?: string;
    } | undefined;
    const inboxItemId = data?.inbox_item_id;
    const explicitlyRoutedAgent = data?.explicitly_routed_agent ?? null;
    const rawEmailBase64 = data?.raw_email_base64 ?? null;

    console.log('job data:', { inboxItemId, explicitlyRoutedAgent, hasRawEmail: !!rawEmailBase64 });

    if (!inboxItemId) {
      logger.error('process-inbound-email job missing inbox_item_id');
      return;
    }

    let totalCostUsd = 0;
    const startTime = Date.now();

    try {
      const inboxItem = await inboxItemRepo.findById(inboxItemId);
      if (!inboxItem) {
        throw new Error(`inbox item not found: ${inboxItemId}`);
      }

      const sanitized = sanitizeBody(inboxItem.body_raw);
      const hardened = hardenBody(
        sanitized,
        inboxItem.sender_name,
        inboxItem.sender_email,
        inboxItem.subject,
        inboxItem.received_at
      );

      await inboxItemRepo.updateSanitizedBody(inboxItemId, sanitized, hardened);

      logger.info({ body_preview: sanitized?.slice(0, 500) }, 'email body preview');

      let attachmentContent = '';
      if (rawEmailBase64) {
        const parsedEmail = await parseRawEmail(rawEmailBase64);
        attachmentContent = await parseAttachments(
          parsedEmail.attachments,
          inboxItem.subject,
          sanitized
        );
        console.log('attachments processed:', parsedEmail.attachments.length);
      } else {
        attachmentContent = await parseAttachments([], inboxItem.subject, sanitized);
      }

      const linkContent = await readLinks(sanitized);
      console.log('links read:', linkContent ? 'yes' : 'none');

      const enrichedContext = [hardened, attachmentContent, linkContent]
        .filter(Boolean)
        .join('\n\n');

      const crmMatch = await matchSender(inboxItem.sender_email);
      await inboxItemRepo.updateCrmMatch(inboxItemId, crmMatch);

      await inboxItemRepo.updateStatus(inboxItemId, 'processing');

      const monthToDateEmailCost = await costLedgerRepo.getMonthToDateTotal();
      if (monthToDateEmailCost >= MONTHLY_EMAIL_BUDGET_USD) {
        logger.warn(
          { monthToDateEmailCost, budget: MONTHLY_EMAIL_BUDGET_USD },
          'monthly email budget exceeded'
        );
        console.log('monthly email budget exceeded:', monthToDateEmailCost, '>=', MONTHLY_EMAIL_BUDGET_USD);

        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'email_processed',
          payload: {
            inbox_item_id: inboxItemId,
            skipped: true,
            reason: 'monthly_budget_exceeded',
            cost_usd: monthToDateEmailCost,
          },
        });

        const budgetDraft = await emailDraftRepo.create({
          inbox_item_id: new Types.ObjectId(inboxItemId),
          drafted_by_agent: 'system',
          to: inboxItem.sender_email,
          subject: `Re: ${inboxItem.subject}`,
          body: '[Auto-reply paused — monthly processing budget reached. Artur will respond manually.]',
          thread_context: 'budget exceeded',
        });

        if (isGmailConfigured()) {
          try {
            const gmailResult = await createDraft(
              inboxItem.sender_email,
              `Re: ${inboxItem.subject}`,
              '[Auto-reply paused — monthly processing budget reached. Artur will respond manually.]',
              inboxItem.message_id
            );
            await emailDraftRepo.updateGmailInfo(
              budgetDraft._id as Types.ObjectId,
              gmailResult.draftId,
              gmailResult.messageId
            );
          } catch (gmailError) {
            logger.error({ error: gmailError }, 'failed to create budget exceeded draft in gmail');
          }
        }

        await inboxItemRepo.setDraftId(inboxItemId, budgetDraft._id as Types.ObjectId);
        await inboxItemRepo.updateStatus(inboxItemId, 'draft_created');
        return;
      }

      const arturPersona = getPersona('artur');
      if (!arturPersona) {
        throw new Error('artur persona not found');
      }

      const crmContext = crmMatch.matched
        ? `\n\nCRM CONTEXT: This sender matches investor "${crmMatch.investor_name}" (matched on ${crmMatch.matched_on}).`
        : '\n\nCRM CONTEXT: No CRM match found for this sender.';

      const arturResult = await routedCall({
        tier: 'background',
        agentOrJob: 'artur',
        system: arturPersona.systemPrompt + '\n\nYou are triaging inbound email. Your output must be valid JSON only, no prose.',
        messages: [
          {
            role: 'user',
            content: `Classify this email and decide routing. Return ONLY valid JSON with these exact fields:
{
  "classification": "investor_follow_up|legal_doc|partner|financial|technical|marketing|operations|unknown|spam",
  "urgency": "high|medium|low",
  "routing_agent": "artur|arshak|narek|hamazasp|tatev|alex|lilit",
  "brief_for_lilit": "one sentence: who sent this, what they want, what agent should do",
  "draft_reply_needed": true|false
}

ROUTING RULES:
- artur: investor emails, fundraising, VC follow-ups, term sheets, commercial proposals, new partnerships, collaboration offers
- arshak: invoices, financial statements, accounting, burn rate questions
- narek: legal documents, contracts, compliance, regulatory
- hamazasp: technical/API/infrastructure proposals
- tatev: marketing, events, brand, communications
- alex: general operations, support, anything else
- lilit: if truly unclear who should handle

${enrichedContext}${crmContext}`,
          },
        ],
        maxTokens: 300,
      });

      totalCostUsd += arturResult.costUsd;
      const arturText = getTextContent(arturResult.response);
      const classification = parseArturResponse(arturText);

      const ALWAYS_DRAFT = true;
      console.log('ALWAYS_DRAFT override: draft generation is ALWAYS enabled');

      const finalRoutingAgent = explicitlyRoutedAgent ?? classification.routing_agent;
      console.log('routing override:', { explicitlyRoutedAgent, arturAgent: classification.routing_agent, finalRoutingAgent });

      console.log(
        'routing decision: agent=%s draft=%s classification=%s urgency=%s mention=%s',
        finalRoutingAgent,
        ALWAYS_DRAFT,
        classification.classification,
        classification.urgency,
        explicitlyRoutedAgent
      );
      logger.info(
        {
          routing_agent: finalRoutingAgent,
          draft_reply_needed: ALWAYS_DRAFT,
          classification: classification.classification,
          urgency: classification.urgency,
          mention_found: explicitlyRoutedAgent,
        },
        'routing decision'
      );

      await inboxItemRepo.updateRouting(inboxItemId, {
        artur_classification: classification.classification,
        routed_to_agent: finalRoutingAgent,
        artur_brief: classification.brief_for_lilit,
      });

      const lilitPersona = getPersona('lilit');
      if (!lilitPersona) {
        throw new Error('lilit persona not found');
      }

      const lilitResult = await routedCall({
        tier: 'background',
        agentOrJob: 'lilit',
        system: lilitPersona.systemPrompt,
        messages: [
          {
            role: 'user',
            content: `New inbound email task. Create a task ID and acknowledge.

Classification: ${classification.classification}
Urgency: ${classification.urgency}
Assigned to: ${classification.routing_agent}
Brief: ${classification.brief_for_lilit}

Respond with a task ID in format TASK-XXXX and a one-sentence confirmation.`,
          },
        ],
        maxTokens: 150,
      });

      totalCostUsd += lilitResult.costUsd;
      const lilitText = getTextContent(lilitResult.response);
      const taskIdMatch = lilitText.match(/TASK-\d+/i);
      const taskId = taskIdMatch ? taskIdMatch[0] : `TASK-${Date.now()}`;

      await inboxItemRepo.updateRouting(inboxItemId, {
        lilit_task_id: taskId,
      });

      logger.info(
        { draft_reply_needed: ALWAYS_DRAFT, classification: classification.classification },
        'proceeding to draft generation check'
      );

      if (ALWAYS_DRAFT) {
        console.log('entering draft generation block, agent:', finalRoutingAgent);
        logger.info({ draft_reply_needed: ALWAYS_DRAFT }, 'proceeding to draft generation');
        const draftingAgent = getPersona(finalRoutingAgent) ?? lilitPersona;

        const agentName = draftingAgent.name.toUpperCase();

        const ghostwriterInstruction = `You are ghostwriting this email reply AS Artur Kartshikyan, CEO of aeda. Write entirely in first person using 'I', 'my', 'we' (for aeda). Never refer to 'Artur' in third person. Never mention your own agent name or role. You are Artur writing this email — not commenting on what Artur said.`;

        const draftResult = await routedCall({
          tier: 'production',
          agentOrJob: finalRoutingAgent,
          system: ghostwriterInstruction + `\n\n` + draftingAgent.systemPrompt + `\n\nYou are drafting a reply email. Return JSON with "subject" and "body" fields.`,
          messages: [
            {
              role: 'user',
              content: `Draft a reply to this email. Be professional, concise, and helpful. Always use lowercase "aeda".

Your response body must have TWO sections:

Section 1 — AGENT COMMENTARY (internal, for Artur only):
Write your professional assessment:
- Brief analysis of the email
- Key points to address
- Risks or opportunities identified
- Your recommendation

Section 2 — DRAFT REPLY (to be sent to external party):
The actual reply email body, professional and appropriate for sending.

Format the body field EXACTLY like this:

═══ ${agentName} — PROFESSIONAL COMMENTARY ═══

[your internal analysis here]

══════════════════════════════════════════════

═══ DRAFT REPLY ═══

[ready-to-send reply here]

IMPORTANT: Do NOT add any signature, sign-off, or closing (no "Best regards", no name, no title). End the draft reply section with the last sentence of the actual reply. Artur will add his own signature before sending.

${enrichedContext}${crmContext}

Brief from Artur: ${classification.brief_for_lilit}

Return JSON: {"subject": "Re: ...", "body": "..."}`,
            },
          ],
          maxTokens: 1200,
        });

        totalCostUsd += draftResult.costUsd;
        const draftText = getTextContent(draftResult.response);
        const draftContent = parseDraftResponse(draftText);

        const replySubject = draftContent.subject.startsWith('Re:')
          ? draftContent.subject
          : `Re: ${inboxItem.subject}`;

        const emailDraft = await emailDraftRepo.create({
          inbox_item_id: new Types.ObjectId(inboxItemId),
          drafted_by_agent: finalRoutingAgent,
          to: inboxItem.sender_email,
          subject: replySubject,
          body: draftContent.body,
          thread_context: classification.brief_for_lilit,
        });

        const emailDraftId = emailDraft._id as Types.ObjectId;

        if (isGmailConfigured()) {
          try {
            const gmailResult = await createDraft(
              inboxItem.sender_email,
              replySubject,
              draftContent.body,
              inboxItem.message_id
            );

            await emailDraftRepo.updateGmailInfo(
              emailDraftId,
              gmailResult.draftId,
              gmailResult.messageId
            );

            await emailDraftRepo.setPendingSendLabelApplied(emailDraftId, gmailResult.labelApplied);
          } catch (gmailError) {
            const errMsg = gmailError instanceof Error ? gmailError.message : String(gmailError);
            logger.error({ error: errMsg }, 'gmail draft creation failed');
            await writeAuditEvent({
              actor: 'system',
              actorType: 'system',
              eventType: 'gmail.error',
              payload: { error: errMsg, operation: 'create_draft', inboxItemId },
            });
          }
        }

        await inboxItemRepo.setDraftId(inboxItemId, emailDraftId);
      }

      await inboxItemRepo.addCost(inboxItemId, totalCostUsd);
      await inboxItemRepo.updateStatus(inboxItemId, 'draft_created');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'email_processed',
        payload: {
          inbox_item_id: inboxItemId,
          classification: classification.classification,
          cost_usd: totalCostUsd,
          duration_ms: Date.now() - startTime,
        },
      });

      logger.info(
        { inboxItemId, classification: classification.classification, costUsd: totalCostUsd },
        'email processing completed'
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ error: errMsg, inboxItemId }, 'email processing failed');

      await inboxItemRepo.updateStatus(inboxItemId, 'error', errMsg);
      await inboxItemRepo.addCost(inboxItemId, totalCostUsd);

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'email_processing_error',
        payload: {
          inbox_item_id: inboxItemId,
          error: errMsg,
          cost_usd: totalCostUsd,
        },
      });

      throw error;
    }
  });
}
