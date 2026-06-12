import { Attachment } from 'mailparser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { logger } from '../logger.js';

const MAX_ATTACHMENT_CHARS = 5000;

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({ data }).promise;
    const textParts: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: unknown) => (item as { str?: string }).str ?? '')
        .join(' ');
      textParts.push(pageText);
    }

    return textParts.join('\n\n');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errMsg }, 'pdf text extraction failed');
    return '[PDF text extraction failed]';
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errMsg }, 'docx text extraction failed');
    return '[DOCX text extraction failed]';
  }
}

function extractPlainText(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

const ATTACHMENT_INDICATORS = [
  'attachment',
  'attached',
  'enclosed',
  'please find',
  'see attached',
  'document attached',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
];

function mayContainAttachments(subject: string, body: string): boolean {
  const combined = `${subject} ${body}`.toLowerCase();
  return ATTACHMENT_INDICATORS.some((indicator) => combined.includes(indicator));
}

export async function parseAttachments(
  attachments: Attachment[],
  subject?: string,
  body?: string
): Promise<string> {
  if (!attachments || attachments.length === 0) {
    if (subject && body && mayContainAttachments(subject, body)) {
      logger.warn(
        'email may contain attachments that exceeded the 200KB raw email cap and could not be extracted'
      );
      console.log('WARNING: attachments may have been truncated by 200KB email cap');
    }
    return '';
  }

  const results: string[] = [];
  const typeCounts: Record<string, number> = {};

  for (const attachment of attachments) {
    const filename = attachment.filename ?? 'unknown';
    const contentType = attachment.contentType ?? 'application/octet-stream';
    const buffer = attachment.content;

    typeCounts[contentType] = (typeCounts[contentType] ?? 0) + 1;

    let extractedText: string;

    if (contentType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      extractedText = await extractPdfText(buffer);
    } else if (
      contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.toLowerCase().endsWith('.docx')
    ) {
      extractedText = await extractDocxText(buffer);
    } else if (contentType.startsWith('text/')) {
      extractedText = extractPlainText(buffer);
    } else {
      extractedText = `[Attachment: ${filename} — type not supported]`;
    }

    const truncated = extractedText.slice(0, MAX_ATTACHMENT_CHARS);
    const finalText = truncated.length < extractedText.length
      ? truncated + '\n[... truncated]'
      : truncated;

    results.push(
      `[BEGIN ATTACHMENT: ${filename} — UNTRUSTED EXTERNAL DATA]\n${finalText}\n[END ATTACHMENT]`
    );
  }

  logger.info({ count: attachments.length, types: typeCounts }, 'attachments processed');
  console.log('attachments processed:', attachments.length);

  return results.join('\n\n');
}
