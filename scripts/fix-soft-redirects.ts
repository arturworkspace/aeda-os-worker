import { MongoClient, ObjectId } from 'mongodb';

// Soft 404 indicators
const SOFT_404_INDICATORS = [
  'page not found',
  'report not found',
  'article not found',
  'post not found',
  'content not found',
  'this page doesn\'t exist',
  'this page does not exist',
  'we couldn\'t find',
  'we could not find',
  'the page you requested',
  'the page you\'re looking for',
  'the page you are looking for',
  'sorry, we can\'t find',
  'sorry, we cannot find',
  'oops! page not found',
  'error 404',
  '404 error',
  '404 - ',
  ' 404 ',
];

function isSoft404Content(html: string): boolean {
  // Check up to 100KB of content since "not found" can be anywhere in the page
  const lowerHtml = html.toLowerCase().slice(0, 100000);
  for (const indicator of SOFT_404_INDICATORS) {
    if (lowerHtml.includes(indicator)) {
      return true;
    }
  }
  return false;
}

function isGenericRedirect(originalUrl: string, finalUrl: string): boolean {
  try {
    const originalPath = new URL(originalUrl).pathname;
    const finalPath = new URL(finalUrl).pathname;
    if (originalPath === finalPath) return false;
    if (finalPath === '/' || finalPath === '') return true;
    const genericPaths = ['/blog', '/blog/', '/reports', '/reports/', '/news', '/news/'];
    if (genericPaths.some(p => finalPath === p || finalPath.endsWith(p))) return true;
    const originalSegments = originalPath.split('/').filter(Boolean).length;
    const finalSegments = finalPath.split('/').filter(Boolean).length;
    if (originalSegments > 1 && finalSegments < originalSegments) return true;
    return false;
  } catch {
    return false;
  }
}

async function verifyUrlWithSoftRedirectCheck(url: string): Promise<{
  valid: boolean;
  reason?: string;
  softRedirect?: boolean;
}> {
  if (!url || !url.startsWith('http')) {
    return { valid: false, reason: 'Invalid URL' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (response.status >= 200 && response.status < 400) {
      // Check for generic redirect
      if (isGenericRedirect(url, response.url)) {
        return { valid: false, reason: 'Redirected to generic page (soft 404)', softRedirect: true };
      }

      // Check page content for soft 404 indicators
      const html = await response.text();
      if (isSoft404Content(html)) {
        return { valid: false, reason: 'Page content indicates not found (soft 404)', softRedirect: true };
      }

      return { valid: true };
    }

    return { valid: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Request failed' };
  }
}

interface KBEntry {
  _id: ObjectId;
  title: string;
  source: string;
  trustLevel: string;
  signalScore: number;
  summary?: string;
  sourceUrlVerified?: boolean;
}

async function fixSoftRedirects() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  // Get all "verified" entries that have a source URL
  const entries = await collection.find({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: true,
    source: { $regex: /^https?:\/\// }
  }).toArray() as unknown as KBEntry[];

  console.log(`\nRe-checking ${entries.length} "verified" entries for soft redirects...\n`);

  let stillValid = 0;
  let newlyDowngraded = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await verifyUrlWithSoftRedirectCheck(entry.source);

    if (result.valid) {
      stillValid++;
      process.stdout.write(`\r[${i + 1}/${entries.length}] ✓ Valid: ${stillValid}, ✗ Downgraded: ${newlyDowngraded}`);
    } else {
      // Downgrade this entry
      const newSummary = entry.summary?.includes('[Source URL')
        ? entry.summary
        : `[Source URL soft 404]: ${entry.summary || ''}`;

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
            sourceUrlSoftRedirect: true,
            sourceUrlVerificationError: result.reason,
            updatedAt: new Date(),
          }
        }
      );

      newlyDowngraded++;
      console.log(`\n  ✗ Downgraded: ${entry.title}`);
      console.log(`    Reason: ${result.reason}`);
      console.log(`    URL was: ${entry.source}`);
    }
  }

  console.log(`\n\n=== SOFT REDIRECT FIX COMPLETE ===`);
  console.log(`Still valid: ${stillValid}`);
  console.log(`Newly downgraded: ${newlyDowngraded}`);

  // Now show final counts
  const totalWithUrls = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    source: { $regex: /^https?:\/\// }
  });

  const verified = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: true
  });

  const downgraded = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: false,
    source: ''
  });

  console.log(`\n=== FINAL KB STATUS ===`);
  console.log(`Total entries with URLs: ${totalWithUrls}`);
  console.log(`Verified (URL confirmed working): ${verified}`);
  console.log(`Downgraded (URL cleared): ${downgraded}`);

  await client.close();
}

fixSoftRedirects().catch(console.error);
