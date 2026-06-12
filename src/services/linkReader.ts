import { logger } from '../logger.js';

const MAX_LINKS = 3;
const MAX_LINK_CHARS = 2000;
const FETCH_TIMEOUT_MS = 5000;

const TRACKING_DOMAINS = [
  'unsubscribe',
  'pixel',
  'track',
  'click',
  'open',
  'beacon',
  'mailtrack',
  'sendgrid',
  'mailchimp',
  'hubspot',
  'marketo',
];

const INTERNAL_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
];

function isTrackingUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return TRACKING_DOMAINS.some((domain) => lowerUrl.includes(domain));
}

function isInternalUrl(url: string): boolean {
  return INTERNAL_IP_PATTERNS.some((pattern) => pattern.test(url));
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'aeda-os-worker/1.0 (link-reader)',
        'Accept': 'text/html,text/plain,*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function readLinks(body: string): Promise<string> {
  if (!body) {
    return '';
  }

  const urlRegex = /https:\/\/[^\s<>"')\]]+/gi;
  const allUrls = body.match(urlRegex) ?? [];

  const filteredUrls = allUrls
    .filter((url) => !isTrackingUrl(url))
    .filter((url) => !isInternalUrl(url))
    .slice(0, MAX_LINKS);

  if (filteredUrls.length === 0) {
    return '';
  }

  const results: string[] = [];
  let successCount = 0;

  for (const url of filteredUrls) {
    try {
      const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      const plainText = stripHtmlTags(html);
      const truncated = plainText.slice(0, MAX_LINK_CHARS);
      const finalText = truncated.length < plainText.length
        ? truncated + '\n[... truncated]'
        : truncated;

      results.push(
        `[BEGIN LINK: ${url} — UNTRUSTED EXTERNAL DATA]\n${finalText}\n[END LINK]`
      );
      successCount++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn({ url, error: errMsg }, 'link fetch failed');
    }
  }

  logger.info({ found: allUrls.length, filtered: filteredUrls.length, fetched: successCount }, 'links read');
  console.log('links read:', successCount);

  return results.join('\n\n');
}
