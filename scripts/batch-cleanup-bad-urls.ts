import { MongoClient, ObjectId } from 'mongodb';

async function verifyUrl(url: string): Promise<{ valid: boolean; reason?: string }> {
  if (!url || !url.startsWith('http')) {
    return { valid: false, reason: 'Invalid URL' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (response.status >= 200 && response.status < 400) {
      const finalPath = new URL(response.url).pathname;
      if (finalPath === '/' && new URL(url).pathname !== '/') {
        return { valid: false, reason: 'Soft 404' };
      }
      return { valid: true };
    }

    return { valid: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg.includes('abort')) {
      return { valid: false, reason: 'Timeout' };
    }
    // Try GET as fallback
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      if (response.status >= 200 && response.status < 400) {
        return { valid: true };
      }
      return { valid: false, reason: `HTTP ${response.status}` };
    } catch {
      return { valid: false, reason: msg };
    }
  }
}

interface KBEntry {
  _id: ObjectId;
  title: string;
  source: string;
  summary: string;
  trustLevel: string;
  signalScore: number;
  sourceUrlVerified?: boolean;
}

async function batchCleanup() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const hostMatch = uri.match(/@([^/]+)\//);
  console.log(`Connecting to MongoDB host: ${hostMatch?.[1] || 'unknown'}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  // Get all unverified Hasmik entries with URLs
  const entries = await collection.find({
    addedBy: 'hasmik',
    source: { $regex: /^https?:\/\// },
    status: 'active',
    sourceUrlVerified: { $ne: true }
  }).toArray() as unknown as KBEntry[];

  console.log(`\nProcessing ${entries.length} unverified Hasmik KB entries...\n`);

  let verified = 0;
  let downgraded = 0;
  let errors = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await verifyUrl(entry.source);

    if (result.valid) {
      // Mark as verified
      await collection.updateOne(
        { _id: entry._id },
        { $set: { sourceUrlVerified: true, sourceUrlVerificationError: null, updatedAt: new Date() } }
      );
      verified++;
      process.stdout.write(`\r[${i + 1}/${entries.length}] ✓ Verified: ${verified}, ✗ Downgraded: ${downgraded}`);
    } else {
      // Downgrade the entry
      const newSummary = entry.summary.includes('[Source URL unverifiable')
        ? entry.summary
        : `[Source URL unverifiable — treat as unconfirmed signal]: ${entry.summary}`;

      await collection.updateOne(
        { _id: entry._id },
        {
          $set: {
            source: '',
            trustLevel: 'signal',
            verificationStatus: 'pending',
            signalScore: Math.min(entry.signalScore || 5, 5),
            summary: newSummary,
            sourceUrlVerified: false,
            sourceUrlVerificationError: result.reason,
            updatedAt: new Date(),
          }
        }
      );
      downgraded++;
      process.stdout.write(`\r[${i + 1}/${entries.length}] ✓ Verified: ${verified}, ✗ Downgraded: ${downgraded}`);
    }
  }

  console.log(`\n\n=== CLEANUP COMPLETE ===`);
  console.log(`Total processed: ${entries.length}`);
  console.log(`Verified (URLs working): ${verified}`);
  console.log(`Downgraded (URLs broken): ${downgraded}`);

  await client.close();
}

batchCleanup().catch(console.error);
