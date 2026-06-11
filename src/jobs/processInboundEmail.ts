import { Agenda, Job } from 'agenda';
import { Types } from 'mongoose';
import { inboxItemRepo } from '../db/repos/inboxItem.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { sanitizeBody, hardenBody } from '../services/emailParser.js';
import { matchSender } from '../services/crmMatcher.js';
import { createDraft, isGmailConfigured } from '../services/gmail.js';
import { routedCall, getTextContent } from '../core/modelRouter.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { getPersona } from '../agents/personas.js';
import { logger } from '../logger.js';

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
    const data = job.attrs.data as { inbox_item_id?: string } | undefined;
    const inboxItemId = data?.inbox_item_id;

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

      const crmMatch = await matchSender(inboxItem.sender_email);
      await inboxItemRepo.updateCrmMatch(inboxItemId, crmMatch);

      await inboxItemRepo.updateStatus(inboxItemId, 'processing');

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
  "classification": "investor_follow_up|legal_doc|partner|unknown|spam",
  "urgency": "high|medium|low",
  "routing_agent": "arshak|narek|alex|tatev|chris|lilit",
  "brief_for_lilit": "one sentence: who sent this, what they want, what agent should do",
  "draft_reply_needed": true|false
}

${hardened}${crmContext}`,
          },
        ],
        maxTokens: 300,
      });

      totalCostUsd += arturResult.costUsd;
      const arturText = getTextContent(arturResult.response);
      const classification = parseArturResponse(arturText);

      console.log(
        'routing decision: agent=%s draft=%s classification=%s urgency=%s',
        classification.routing_agent,
        classification.draft_reply_needed,
        classification.classification,
        classification.urgency
      );
      logger.info(
        {
          routing_agent: classification.routing_agent,
          draft_reply_needed: classification.draft_reply_needed,
          classification: classification.classification,
          urgency: classification.urgency,
        },
        'routing decision'
      );

      await inboxItemRepo.updateRouting(inboxItemId, {
        artur_classification: classification.classification,
        routed_to_agent: classification.routing_agent,
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
        { draft_reply_needed: classification.draft_reply_needed, classification: classification.classification },
        'proceeding to draft generation check'
      );

      if (classification.draft_reply_needed && classification.classification !== 'spam') {
        logger.info({ draft_reply_needed: true }, 'proceeding to draft generation');
        const draftingAgent = getPersona(classification.routing_agent) ?? lilitPersona;

        const agentName = draftingAgent.name.toUpperCase();

        const draftResult = await routedCall({
          tier: 'production',
          agentOrJob: classification.routing_agent,
          system: draftingAgent.systemPrompt + `\n\nYou are drafting a reply email. Return JSON with "subject" and "body" fields.`,
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

${hardened}${crmContext}

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
          drafted_by_agent: classification.routing_agent,
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
