import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';

const client = new Anthropic();

interface PendingEntry {
  _id: unknown;
  title: string;
  summary?: string;
  content?: string;
  source?: string;
  sourceType?: string;
  isOpinion?: boolean;
}

export async function runVerificationPass(
  jobStartTime: Date
): Promise<{ verified: number; contradicted: number; pending: number }> {
  const db = await getDb();
  const collection = db.collection('knowledges');

  const pendingEntries = await collection.find({
    addedBy: 'hasmik',
    verificationStatus: 'pending',
    createdAt: { $gte: jobStartTime },
  }).toArray() as unknown as PendingEntry[];

  let verified = 0;
  let contradicted = 0;
  let remaining = 0;

  for (const entry of pendingEntries) {
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Classify this intelligence entry for a fintech company.

Title: ${entry.title}
Content: ${entry.summary || entry.content || ''}
Source URL: ${entry.source || 'none'}
Source type: ${entry.sourceType || 'unknown'}
Is opinion: ${entry.isOpinion || false}

Respond in JSON only, no markdown:
{
  "status": "confirmed" | "informational" | "contradicted" | "opinion" | "pending",
  "reason": "one sentence"
}

Rules:
- "confirmed": verifiable factual claim from credible source
- "informational": likely true but unverified or from secondary source
- "contradicted": demonstrably false, misleading, or conflicts with known facts
- "opinion": personal view, prediction, or interpretation — not a factual claim
- "pending": insufficient information to classify

Be strict. When in doubt: pending over confirmed.
Self-reported company metrics with no external source: informational at best.
LinkedIn posts from non-officials: opinion.
Extraordinary claims with no URL: contradicted.`
        }]
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      const newStatus = parsed.status || 'pending';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await collection.updateOne(
        { _id: entry._id as any },
        {
          $set: {
            verificationStatus: newStatus,
            verificationReason: parsed.reason || '',
            verifiedAt: new Date(),
            verifiedBy: 'haiku',
          }
        }
      );

      if (newStatus === 'confirmed' || newStatus === 'informational') verified++;
      else if (newStatus === 'contradicted') contradicted++;
      else remaining++;

    } catch {
      remaining++;
    }
  }

  return { verified, contradicted, pending: remaining };
}
