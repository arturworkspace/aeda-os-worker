import { MongoClient, ObjectId } from 'mongodb';

// Bot-defensive domains
const BOT_DEFENSIVE_DOMAINS = [
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
  'instagram.com', 'medium.com', 'substack.com',
  'bloomberg.com', 'ft.com', 'wsj.com', 'reuters.com',
];

// Content URL patterns
const CONTENT_URL_PATTERNS: Record<string, RegExp> = {
  'linkedin.com': /linkedin\.com\/(posts|pulse|feed\/update|in\/[^/]+\/recent-activity)/i,
  'twitter.com': /twitter\.com\/[^/]+\/status\/\d+/i,
  'x.com': /x\.com\/[^/]+\/status\/\d+/i,
  'medium.com': /medium\.com\/@?[^/]+\/[a-z0-9-]+-[a-f0-9]+$/i,
  'substack.com': /[^.]+\.substack\.com\/p\//i,
};

function isBotDefensiveDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return BOT_DEFENSIVE_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function hasValidContentUrlPattern(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const [domain, pattern] of Object.entries(CONTENT_URL_PATTERNS)) {
      if ((hostname === domain || hostname.endsWith('.' + domain)) && pattern.test(url)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyUrl(url: string): Promise<{
  valid: boolean;
  reason?: string;
  botProtected?: boolean;
  patternValid?: boolean;
}> {
  if (!url || !url.startsWith('http')) {
    return { valid: false, reason: 'Invalid URL' };
  }

  const isBotDefensive = isBotDefensiveDomain(url);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)' },
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

    if (isBotDefensive) {
      return {
        valid: false,
        reason: `Bot-protected (HTTP ${response.status})`,
        botProtected: true,
        patternValid: hasValidContentUrlPattern(url),
      };
    }

    return { valid: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';

    if (isBotDefensive) {
      return {
        valid: false,
        reason: `Bot-protected (${msg})`,
        botProtected: true,
        patternValid: hasValidContentUrlPattern(url),
      };
    }

    // Try GET fallback
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
  sourceUrlVerified?: boolean;
  sourceUrlVerificationError?: string;
  sourceUrlBotProtected?: boolean;
  summary?: string;
}

async function verifySpecificEntries() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  // 1. Check the DolarApp TechCrunch entry
  console.log('=== DOLARAPP ENTRY ===');
  const dolarApp = await collection.findOne({
    title: { $regex: /dolarapp.*expansion.*eu/i }
  }) as KBEntry | null;

  if (dolarApp) {
    console.log(JSON.stringify({
      _id: dolarApp._id?.toString(),
      title: dolarApp.title,
      source: dolarApp.source,
      trustLevel: dolarApp.trustLevel,
      signalScore: dolarApp.signalScore,
      sourceUrlVerified: dolarApp.sourceUrlVerified,
      sourceUrlVerificationError: dolarApp.sourceUrlVerificationError,
    }, null, 2));
  } else {
    console.log('DolarApp EU expansion entry not found');
  }

  // 2. Check Jeremy Allaire EURC entry
  console.log('\n=== JEREMY ALLAIRE EURC ENTRY ===');
  const allaire = await collection.findOne({
    title: { $regex: /allaire.*eurc.*growth/i }
  }) as KBEntry | null;

  if (allaire) {
    console.log(JSON.stringify({
      _id: allaire._id?.toString(),
      title: allaire.title,
      source: allaire.source,
      trustLevel: allaire.trustLevel,
      signalScore: allaire.signalScore,
      sourceUrlVerified: allaire.sourceUrlVerified,
      sourceUrlVerificationError: allaire.sourceUrlVerificationError,
    }, null, 2));
  } else {
    console.log('Jeremy Allaire EURC entry not found');
  }

  // 3. Get 5 random entries from different domains for spot-check
  console.log('\n=== 5 RANDOM ENTRIES FOR SPOT-CHECK ===');
  const randomEntries = await collection.aggregate([
    { $match: {
      addedBy: 'hasmik',
      status: 'active',
      source: { $regex: /^https?:\/\// }
    }},
    { $sample: { size: 10 } }
  ]).toArray() as unknown as KBEntry[];

  // Filter to get diverse domains
  const seenDomains = new Set<string>();
  const diverseEntries: KBEntry[] = [];

  for (const e of randomEntries) {
    try {
      const domain = new URL(e.source).hostname;
      if (!seenDomains.has(domain) && diverseEntries.length < 5) {
        seenDomains.add(domain);
        diverseEntries.push(e);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  for (const entry of diverseEntries) {
    const verification = await verifyUrl(entry.source);
    console.log(`\n${entry.title}`);
    console.log(`  URL: ${entry.source}`);
    console.log(`  DB status: verified=${entry.sourceUrlVerified}, error=${entry.sourceUrlVerificationError || 'none'}`);
    console.log(`  Live check: valid=${verification.valid}, reason=${verification.reason || 'OK'}${verification.botProtected ? `, botProtected=true, patternValid=${verification.patternValid}` : ''}`);
  }

  // 4. Get final counts
  console.log('\n=== FINAL COUNTS ===');
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
    source: ''  // URL was cleared
  });

  const unverifiedWithUrl = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: false,
    source: { $regex: /^https?:\/\// }  // Still has URL (bot-protected or unprocessed)
  });

  console.log(`Total entries with URLs: ${totalWithUrls}`);
  console.log(`Verified (URL confirmed working): ${verified}`);
  console.log(`Downgraded (URL cleared): ${downgraded}`);
  console.log(`Unverified but URL kept: ${unverifiedWithUrl}`);

  await client.close();
}

verifySpecificEntries().catch(console.error);
