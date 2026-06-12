import { Router, Request, Response } from 'express';
import { Agenda } from 'agenda';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { inboxItemRepo } from '../db/repos/inboxItem.repo.js';
import { parseRawEmail } from '../services/emailParser.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';

const webhookBodySchema = z.object({
  from: z.string(),
  to: z.string(),
  rawEmail: z.string(),
  timestamp: z.number(),
});

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function createWebhookRouter(agenda: Agenda): Router {
  const router = Router();

  router.post('/inbound-email', async (req: Request, res: Response) => {
    console.log('webhook received:', JSON.stringify(req.body).slice(0, 200));

    const webhookSecret = process.env['WEBHOOK_SECRET'];
    const providedSecret = req.headers['x-webhook-secret'];

    if (!webhookSecret) {
      logger.error('WEBHOOK_SECRET not configured');
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'webhook.error',
        payload: { error: 'webhook_secret not configured' },
      });
      res.status(500).json({ error: 'server misconfigured' });
      return;
    }

    if (typeof providedSecret !== 'string' || !safeCompare(providedSecret, webhookSecret)) {
      logger.warn('webhook auth failed');
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'webhook.auth_failed',
        payload: { ip: req.ip },
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const parseResult = webhookBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn({ errors: parseResult.error.issues }, 'invalid webhook payload');
      res.status(400).json({ error: 'invalid payload' });
      return;
    }

    const { from, to, rawEmail, timestamp } = parseResult.data;

    try {
      const rawFrom = from || '';
      const emailMatch = rawFrom.match(/<([^>]+)>/);
      const sender_email = emailMatch && emailMatch[1] ? emailMatch[1].trim() : rawFrom.trim();
      const namePart = rawFrom.split('<')[0];
      const sender_name = rawFrom.includes('<') && namePart
        ? namePart.trim()
        : rawFrom.trim();

      console.log('parsed sender:', { sender_email, sender_name, rawFrom });

      const rawText = Buffer.from(rawEmail, 'base64').toString('utf-8');
      const decodedText = rawText
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/=\r?\n/g, '');
      console.log('raw text first 300 chars:', rawText.slice(0, 300));
      console.log('decoded text first 300 chars:', decodedText.slice(0, 300));
      console.log('mention scan text sample:', decodedText.slice(0, 500));

      const mentionMatch = decodedText.match(/@(arshak|narek|alex|tatev|hamazasp|chris|laura|anna|vagho|mike|ruzan|sofi|lilit)/i);
      const explicitly_routed_agent = mentionMatch && mentionMatch[1] ? mentionMatch[1].toLowerCase() : null;
      console.log('mention detection:', { mentionMatch: mentionMatch?.[0], explicitly_routed_agent });

      const parsed = await parseRawEmail(rawEmail);
      console.log('parsed email text length:', parsed.body_raw?.length);
      console.log('parsed email subject:', parsed.subject);

      const existing = await inboxItemRepo.findByMessageId(parsed.message_id);
      if (existing) {
        logger.info({ messageId: parsed.message_id }, 'duplicate email received, returning 200');
        res.status(200).json({ status: 'duplicate', message_id: parsed.message_id });
        return;
      }

      const inboxItem = await inboxItemRepo.create({
        recipient: to,
        sender_email: sender_email,
        sender_name: sender_name,
        subject: parsed.subject,
        body_raw: parsed.body_raw,
        received_at: new Date(timestamp),
        message_id: parsed.message_id,
        in_reply_to: parsed.in_reply_to,
      });

      const inboxItemId = inboxItem._id?.toString();

      await agenda.now('process-inbound-email', {
        inbox_item_id: inboxItemId,
        explicitly_routed_agent: explicitly_routed_agent,
        raw_email_base64: rawEmail,
      });

      logger.info({ inboxItemId, messageId: parsed.message_id }, 'inbound email queued for processing');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'email.received',
        payload: {
          inboxItemId,
          sender: sender_email,
          subject: parsed.subject,
        },
      });

      res.status(200).json({ status: 'queued', inbox_item_id: inboxItemId });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      const errName = error instanceof Error ? error.name : 'UnknownError';

      console.error('webhook processing error:', errMsg);
      console.error('stack:', errStack);

      logger.error(
        {
          error: errMsg,
          errorName: errName,
          stack: errStack,
          body: req.body ? {
            from: req.body.from,
            to: req.body.to,
            hasRawEmail: !!req.body.rawEmail,
            rawEmailLength: req.body.rawEmail?.length,
            timestamp: req.body.timestamp
          } : 'no body'
        },
        'webhook processing error'
      );

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'webhook.error',
        payload: {
          error: errMsg,
          errorName: errName,
          stack: errStack,
        },
      });

      res.status(500).json({ error: 'processing failed', message: errMsg });
    }
  });

  return router;
}
