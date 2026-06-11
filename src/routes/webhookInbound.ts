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
      const parsed = await parseRawEmail(rawEmail);

      const emailMatch = from.match(/<(.+)>/);
      const fromEmail = (emailMatch?.[1] ?? from).trim();
      const fromNamePart = from.split('<')[0];
      const fromName = from.includes('<') && fromNamePart ? fromNamePart.trim() : from.trim();

      const senderEmail = parsed.sender_email || fromEmail;
      const senderName = parsed.sender_name || fromName;

      const existing = await inboxItemRepo.findByMessageId(parsed.message_id);
      if (existing) {
        logger.info({ messageId: parsed.message_id }, 'duplicate email received, returning 200');
        res.status(200).json({ status: 'duplicate', message_id: parsed.message_id });
        return;
      }

      const inboxItem = await inboxItemRepo.create({
        recipient: to,
        sender_email: senderEmail,
        sender_name: senderName,
        subject: parsed.subject,
        body_raw: parsed.body_raw,
        received_at: new Date(timestamp),
        message_id: parsed.message_id,
        in_reply_to: parsed.in_reply_to,
      });

      const inboxItemId = inboxItem._id?.toString();

      await agenda.now('process-inbound-email', { inbox_item_id: inboxItemId });

      logger.info({ inboxItemId, messageId: parsed.message_id }, 'inbound email queued for processing');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'email.received',
        payload: {
          inboxItemId,
          sender: senderEmail,
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
