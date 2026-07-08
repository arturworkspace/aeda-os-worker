import { google, gmail_v1 } from 'googleapis';
import { logger } from '../logger.js';

type OAuth2ClientType = InstanceType<typeof google.auth.OAuth2>;

let juliaOauth2Client: OAuth2ClientType | null = null;
let juliaGmailClient: gmail_v1.Gmail | null = null;

export function initJuliaGmailClient(): void {
  const clientId = process.env['JULIA_GMAIL_CLIENT_ID'];
  const clientSecret = process.env['JULIA_GMAIL_CLIENT_SECRET'];
  const refreshToken = process.env['JULIA_GMAIL_REFRESH_TOKEN'];

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn('julia gmail credentials not configured, draft push to gmail will be disabled');
    return;
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  juliaOauth2Client = client;

  juliaGmailClient = google.gmail({ version: 'v1', auth: client });

  logger.info('julia gmail client initialized (julia@aedawallet.com)');
}

async function refreshJuliaAccessToken(): Promise<void> {
  if (!juliaOauth2Client) {
    throw new Error('julia gmail oauth2 client not initialized');
  }

  try {
    await juliaOauth2Client.getAccessToken();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg }, 'julia gmail token refresh failed');
    throw new Error(`julia gmail token refresh failed: ${errMsg}`);
  }
}

function createRawEmail(to: string, subject: string, body: string): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  const rawEmail = headers.join('\r\n') + '\r\n\r\n' + body;

  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface JuliaCreateDraftResult {
  draftId: string;
  messageId: string | null;
}

export async function juliaCreateDraft(
  to: string,
  subject: string,
  body: string
): Promise<JuliaCreateDraftResult> {
  if (!juliaGmailClient || !juliaOauth2Client) {
    throw new Error('julia gmail client not initialized');
  }

  await refreshJuliaAccessToken();

  const raw = createRawEmail(to, subject, body);

  const response = await juliaGmailClient.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  });

  const draftId = response.data.id;
  const messageId = response.data.message?.id ?? null;

  if (!draftId) {
    throw new Error('julia gmail draft creation returned no draft id');
  }

  logger.info({ draftId, messageId, to }, 'julia gmail draft created');

  return { draftId, messageId };
}

export function isJuliaGmailConfigured(): boolean {
  return juliaGmailClient !== null;
}

export interface JuliaThreadMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
}

export interface JuliaThread {
  id: string;
  historyId: string | null;
  messages: JuliaThreadMessage[];
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

/**
 * Fetch a Gmail thread by its thread ID.
 * This is a foundational function for future reply-detection — will be used by
 * a scheduled job to check if investors have replied to Julia's outreach emails.
 * NOT YET WIRED TO A JOB — just the callable function.
 */
export async function getThreadById(threadId: string): Promise<JuliaThread | null> {
  if (!juliaGmailClient || !juliaOauth2Client) {
    logger.warn('julia gmail client not initialized, cannot fetch thread');
    return null;
  }

  try {
    await refreshJuliaAccessToken();

    const response = await juliaGmailClient.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const thread = response.data;
    if (!thread.id) {
      logger.warn({ threadId }, 'thread fetch returned no id');
      return null;
    }

    const messages: JuliaThreadMessage[] = [];

    for (const msg of thread.messages ?? []) {
      const payload = msg.payload;
      const headers = payload?.headers;
      const { text, html } = extractBodyParts(payload);

      messages.push({
        id: msg.id ?? '',
        threadId: msg.threadId ?? '',
        snippet: msg.snippet ?? '',
        labelIds: msg.labelIds ?? [],
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        date: getHeader(headers, 'Date'),
        bodyText: text,
        bodyHtml: html,
      });
    }

    logger.info({ threadId, messageCount: messages.length }, 'julia gmail thread fetched');

    return {
      id: thread.id,
      historyId: thread.historyId ?? null,
      messages,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg, threadId }, 'failed to fetch julia gmail thread');
    return null;
  }
}
