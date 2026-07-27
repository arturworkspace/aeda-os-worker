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

  if (pendingEntries.length === 0) {
    return { verified: 0, contradicted: 0, pending: 0 };
  }

  let verified = 0;
  let contradicted = 0;
  let remaining = 0;

  // Cost fix (2026-07-27): this previously fired one Haiku call per pending
  // entry (typically 20-40/run), each re-paying the full instruction-prompt
  // overhead just to classify a single entry. Batching into chunks collapses
  // that to a handful of calls per run — same rules, same model, same
  // per-entry judgment, just fewer round-trips.
  const BATCH_SIZE = 20;

  for (let i = 0; i < pendingEntries.length; i += BATCH_SIZE) {
    const batch = pendingEntries.slice(i, i + BATCH_SIZE);

    try {
      const entriesBlock = batch
        .map(
          (entry, idx) => `
Entry ${idx}:
Title: ${entry.title}
Content: ${entry.summary || entry.content || ''}
Source URL: ${entry.source || 'none'}
Source type: ${entry.sourceType || 'unknown'}
Is opinion: ${entry.isOpinion || false}`
        )
        .join('\n---');

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150 * batch.length,
        messages: [{
          role: 'user',
          content: `Classify each of the following ${batch.length} intelligence entries for a fintech company, independently.
${entriesBlock}

Respond in JSON only, no markdown — a JSON array with exactly one object per entry, in the same order, each including its "index":
[
  { "index": 0, "status": "confirmed" | "informational" | "contradicted" | "opinion" | "pending", "reason": "one sentence" }
]

Rules (apply per-entry, independently — do not let one entry's classification bias another's):
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

      const parsedArray = JSON.parse(text.replace(/```json|```/g, '').trim()) as Array<{
        index?: number;
        status?: string;
        reason?: string;
      }>;

      const handledIndices = new Set<number>();

      for (const item of parsedArray) {
        if (typeof item.index !== 'number') continue;
        const entry = batch[item.index];
        if (!entry) continue;
        handledIndices.add(item.index);

        const newStatus = item.status || 'pending';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await collection.updateOne(
          { _id: entry._id as any },
          {
            $set: {
              verificationStatus: newStatus,
              verificationReason: item.reason || '',
              verifiedAt: new Date(),
              verifiedBy: 'haiku',
            }
          }
        );

        if (newStatus === 'confirmed' || newStatus === 'informational') verified++;
        else if (newStatus === 'contradicted') contradicted++;
        else remaining++;
      }

      // Any entry the model didn't return a verdict for stays pending
      // (matches the prior per-entry behavior's failure mode).
      for (let j = 0; j < batch.length; j++) {
        if (!handledIndices.has(j)) remaining++;
      }
    } catch {
      remaining += batch.length;
    }
  }

  return { verified, contradicted, pending: remaining };
}
