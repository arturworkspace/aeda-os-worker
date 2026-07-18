import { getDb } from '../src/lib/db.js';

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
  _id: string;
  title: string;
  source: string;
  trustLevel: string;
  signalScore: number;
  createdAt: Date;
}

async function auditKBUrls() {
  const db = await getDb();

  const entries = await db.collection('knowledges').find({
    addedBy: 'hasmik',
    source: { $regex: /^https?:\/\// },
    status: 'active'
  }).project({
    title: 1,
    source: 1,
    trustLevel: 1,
    signalScore: 1,
    createdAt: 1
  }).sort({ createdAt: -1 }).limit(30).toArray() as unknown as KBEntry[];

  console.log(`\nAuditing ${entries.length} Hasmik KB entries with URLs...\n`);
  
  const failures: KBEntry[] = [];

  for (const entry of entries) {
    const result = await verifyUrl(entry.source);
    const status = result.valid ? '✓' : '✗';
    console.log(`${status} ${entry.title}`);
    console.log(`  ${entry.source}`);
    if (!result.valid) {
      console.log(`  FAILED: ${result.reason}`);
      failures.push(entry);
    }
    console.log();
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total checked: ${entries.length}`);
  console.log(`Failures: ${failures.length}`);
  
  if (failures.length > 0) {
    console.log(`\nFailed entries to clean up:`);
    for (const f of failures) {
      console.log(`  - ${f._id}: ${f.title}`);
    }
  }

  process.exit(0);
}

auditKBUrls().catch(err => {
  console.error(err);
  process.exit(1);
});
