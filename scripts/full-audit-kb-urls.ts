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
        return { valid: false, reason: 'Soft 404 (redirected to homepage)' };
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
  trustLevel: string;
  signalScore: number;
  createdAt: Date;
  sourceUrlVerified?: boolean;
}

async function fullAudit() {
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

  // Get ALL Hasmik entries with URLs that haven't been verified yet
  const entries = await collection.find({
    addedBy: 'hasmik',
    source: { $regex: /^https?:\/\// },
    status: 'active',
    sourceUrlVerified: { $ne: true }  // Skip already verified ones
  }).project({
    _id: 1,
    title: 1,
    source: 1,
    trustLevel: 1,
    signalScore: 1,
    createdAt: 1,
    sourceUrlVerified: 1
  }).toArray() as unknown as KBEntry[];

  console.log(`\nAuditing ${entries.length} unverified Hasmik KB entries with URLs...\n`);

  const failures: KBEntry[] = [];
  const successes: KBEntry[] = [];

  for (const entry of entries) {
    const result = await verifyUrl(entry.source);
    const status = result.valid ? '✓' : '✗';
    console.log(`${status} ${entry.title}`);
    console.log(`  ${entry.source}`);
    if (!result.valid) {
      console.log(`  FAILED: ${result.reason}`);
      failures.push(entry);
    } else {
      successes.push(entry);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total checked: ${entries.length}`);
  console.log(`Valid URLs: ${successes.length}`);
  console.log(`Invalid URLs: ${failures.length}`);

  if (failures.length > 0) {
    console.log(`\nFailed entry IDs (for cleanup script):`);
    console.log(`const BAD_ENTRY_IDS = [`);
    for (const f of failures) {
      console.log(`  '${f._id}',  // ${f.title.slice(0, 50)}`);
    }
    console.log(`];`);
  }

  await client.close();
  process.exit(0);
}

fullAudit().catch(err => {
  console.error(err);
  process.exit(1);
});
