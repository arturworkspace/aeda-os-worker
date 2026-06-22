import { google, gmail_v1 } from 'googleapis';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';

type OAuth2ClientType = InstanceType<typeof google.auth.OAuth2>;

let oauth2Client: OAuth2ClientType | null = null;
let gmailClient: gmail_v1.Gmail | null = null;
let pendingSendLabelId: string | null = null;

export function initGmailClient(): void {
  const clientId = process.env['GMAIL_CLIENT_ID'];
  const clientSecret = process.env['GMAIL_CLIENT_SECRET'];
  const refreshToken = process.env['GMAIL_REFRESH_TOKEN'];

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn('gmail credentials not configured, draft creation will be disabled');
    return;
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  oauth2Client = client;

  gmailClient = google.gmail({ version: 'v1', auth: client });

  logger.info('gmail client initialized');
}

export async function ensurePendingSendLabel(): Promise<void> {
  if (!gmailClient) {
    logger.warn('gmail client not initialized, skipping label lookup');
    return;
  }

  try {
    const response = await gmailClient.users.labels.list({ userId: 'me' });
    const labels = response.data.labels ?? [];

    const pendingSendLabel = labels.find((l) => l.name === 'Pending Send');
    if (pendingSendLabel?.id) {
      pendingSendLabelId = pendingSendLabel.id;
      logger.info({ labelId: pendingSendLabelId }, 'pending send label found');
    } else {
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'gmail.warning',
        payload: { warning: 'pending send label not found in gmail' },
      });
      logger.warn('pending send label not found in gmail');
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'gmail.error',
      payload: { error: errMsg, operation: 'label_lookup' },
    });
    logger.error({ error: errMsg }, 'failed to look up gmail labels');
  }
}

async function refreshAccessToken(): Promise<void> {
  if (!oauth2Client) {
    throw new Error('gmail oauth2 client not initialized');
  }

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'gmail.error',
      payload: { error: errMsg, operation: 'token_refresh' },
    });
    logger.error({ error: errMsg }, 'gmail token refresh failed');
    throw new Error(`gmail token refresh failed: ${errMsg}`);
  }
}

function createRawEmail(to: string, subject: string, body: string, inReplyTo?: string): string {
  const boundary = `boundary_${Date.now()}`;

  let headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  const rawEmail = headers.join('\r\n') + '\r\n\r\n' + body;

  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface CreateDraftResult {
  draftId: string;
  messageId: string | null;
  labelApplied: boolean;
}

export async function createDraft(
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string
): Promise<CreateDraftResult> {
  if (!gmailClient || !oauth2Client) {
    throw new Error('gmail client not initialized');
  }

  await refreshAccessToken();

  const raw = createRawEmail(to, subject, body, inReplyTo);

  const response = await gmailClient.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  });

  const draftId = response.data.id;
  const messageId = response.data.message?.id ?? null;

  if (!draftId) {
    throw new Error('gmail draft creation returned no draft id');
  }

  logger.info({ draftId, messageId }, 'gmail draft created');

  let labelApplied = false;

  if (!pendingSendLabelId) {
    logger.warn({ draftId, messageId }, 'pending send label id is null, skipping label apply');
  } else if (!messageId) {
    logger.warn({ draftId, pendingSendLabelId }, 'message id is null, cannot apply label');
  } else {
    logger.info(
      { draftId, messageId, pendingSendLabelId },
      'attempting to apply pending send label to draft message'
    );
    try {
      await gmailClient.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds: [pendingSendLabelId],
        },
      });
      labelApplied = true;
      logger.info({ draftId, messageId, labelId: pendingSendLabelId }, 'pending send label applied');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fullError = error instanceof Error ? error.stack : String(error);
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'gmail.warning',
        payload: {
          warning: 'failed to apply pending send label',
          error: errMsg,
          draftId,
          messageId,
          pendingSendLabelId,
        },
      });
      logger.error(
        { error: errMsg, fullError, draftId, messageId, pendingSendLabelId },
        'failed to apply pending send label'
      );
    }
  }

  return { draftId, messageId, labelApplied };
}

export function isGmailConfigured(): boolean {
  return gmailClient !== null;
}

export function getPendingSendLabelId(): string | null {
  return pendingSendLabelId;
}

export interface EmailContent {
  body_text: string;
  body_html: string;
  subject: string;
  from: string;
  date: string;
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf-8');
  } catch {
    return '';
  }
}

interface MessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MessagePart[] | null;
}

interface MessageHeader {
  name?: string | null;
  value?: string | null;
}

function extractBodyParts(payload: MessagePart | null | undefined): { text: string; html: string } {
  let text = '';
  let html = '';

  if (!payload) return { text, html };

  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/plain' && !text) {
      text = decoded;
    } else if (payload.mimeType === 'text/html' && !html) {
      html = decoded;
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const nested = extractBodyParts(part);
      if (nested.text && !text) text = nested.text;
      if (nested.html && !html) html = nested.html;
    }
  }

  return { text, html };
}

function getHeader(headers: MessageHeader[] | null | undefined, name: string): string {
  if (!headers) return '';
  const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? '';
}

export async function fetchEmailContentByMessageId(rfc5322MessageId: string): Promise<EmailContent> {
  const emptyResult: EmailContent = {
    body_text: '',
    body_html: '',
    subject: '',
    from: '',
    date: '',
  };

  if (!gmailClient || !oauth2Client) {
    logger.warn('gmail client not initialized, cannot fetch email content');
    return emptyResult;
  }

  if (!rfc5322MessageId) {
    logger.warn('empty message id provided, skipping gmail fetch');
    return emptyResult;
  }

  try {
    await refreshAccessToken();

    const cleanMessageId = rfc5322MessageId.replace(/^<|>$/g, '');
    const searchQuery = `rfc822msgid:${cleanMessageId}`;

    const searchResponse = await gmailClient.users.messages.list({
      userId: 'me',
      q: searchQuery,
      maxResults: 1,
    });

    const messages = searchResponse.data.messages;
    if (!messages || messages.length === 0) {
      logger.info({ rfc5322MessageId }, 'no gmail message found for message id');
      return emptyResult;
    }

    const firstMessage = messages[0];
    const gmailMessageId = firstMessage?.id;
    if (!gmailMessageId) {
      logger.warn({ rfc5322MessageId }, 'gmail search returned message without id');
      return emptyResult;
    }

    const messageResponse = await gmailClient.users.messages.get({
      userId: 'me',
      id: gmailMessageId,
      format: 'full',
    });

    const payload = messageResponse.data.payload;
    const headers = payload?.headers;

    const { text, html } = extractBodyParts(payload);

    return {
      body_text: text,
      body_html: html,
      subject: getHeader(headers, 'Subject'),
      from: getHeader(headers, 'From'),
      date: getHeader(headers, 'Date'),
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg, rfc5322MessageId }, 'failed to fetch email content from gmail');
    return emptyResult;
  }
}
