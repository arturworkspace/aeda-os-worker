import { getDb } from './db.js';

// Bot-defensive domains that block/challenge automated requests
// These need special handling - can't reliably verify via HTTP alone
const BOT_DEFENSIVE_DOMAINS = [
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'medium.com',      // Often returns 403 to bots
  'substack.com',    // Sometimes rate-limits
  'bloomberg.com',   // Paywall + bot detection
  'ft.com',          // Paywall + bot detection
  'wsj.com',         // Paywall + bot detection
  'reuters.com',     // Sometimes blocks bots
];

// URL patterns that indicate a specific content item (not just homepage)
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

interface UrlVerifyResult {
  valid: boolean;
  finalUrl?: string;
  reason?: string;
  botProtected?: boolean;  // True if URL is on a bot-defensive domain
  patternValid?: boolean;  // True if URL matches expected content pattern
}

/**
 * Verify a URL actually exists and returns content.
 * Returns { valid: true, finalUrl } if the URL resolves to real content,
 * or { valid: false, reason } if it 404s, redirects to unrelated page, or fails.
 * For bot-defensive domains, returns { botProtected: true, patternValid: bool }
 * instead of forcing a pass/fail verdict.
 */
async function verifyUrlExists(url: string): Promise<UrlVerifyResult> {
  if (!url || !url.startsWith('http')) {
    return { valid: false, reason: 'Invalid or missing URL' };
  }

  // Check if this is a bot-defensive domain
  const isBotDefensive = isBotDefensiveDomain(url);

  try {
    // Use fetch with a short timeout and follow redirects
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'HEAD',  // HEAD is faster, most servers support it
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0; +https://aedawallet.com)',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    // Check for success status
    if (response.status >= 200 && response.status < 400) {
      // Check if we were redirected to a generic error page or homepage
      const finalUrl = response.url;
      const originalHost = new URL(url).hostname;
      const finalHost = new URL(finalUrl).hostname;

      // If redirected to a different domain entirely, suspicious
      const originalBase = originalHost.split('.')[0];
      if (originalHost !== finalHost && originalBase && !finalHost.includes(originalBase)) {
        return { valid: false, reason: `Redirected to different domain: ${finalHost}` };
      }

      // If redirected to just the homepage (no path), likely a 404 soft-redirect
      const finalPath = new URL(finalUrl).pathname;
      if (finalPath === '/' && new URL(url).pathname !== '/') {
        return { valid: false, reason: 'Redirected to homepage (soft 404)' };
      }

      return { valid: true, finalUrl };
    }

    // For bot-defensive domains, a non-200 doesn't mean the URL is fake
    if (isBotDefensive) {
      const patternValid = hasValidContentUrlPattern(url);
      return {
        valid: false,
        reason: `Bot-protected domain (HTTP ${response.status})`,
        botProtected: true,
        patternValid,
      };
    }

    return { valid: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';

    // Some sites block HEAD requests, try GET as fallback
    if (msg.includes('Method Not Allowed') || msg.includes('405')) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0; +https://aedawallet.com)',
          },
          redirect: 'follow',
        });
        clearTimeout(timeout);

        if (response.status >= 200 && response.status < 400) {
          return { valid: true, finalUrl: response.url };
        }

        if (isBotDefensive) {
          return {
            valid: false,
            reason: `Bot-protected domain (HTTP ${response.status})`,
            botProtected: true,
            patternValid: hasValidContentUrlPattern(url),
          };
        }
        return { valid: false, reason: `HTTP ${response.status}` };
      } catch (e2) {
        if (isBotDefensive) {
          return {
            valid: false,
            reason: `Bot-protected domain (${e2 instanceof Error ? e2.message : 'request failed'})`,
            botProtected: true,
            patternValid: hasValidContentUrlPattern(url),
          };
        }
        return { valid: false, reason: e2 instanceof Error ? e2.message : 'GET fallback failed' };
      }
    }

    // For bot-defensive domains, network errors are common (bot blocking)
    if (isBotDefensive) {
      return {
        valid: false,
        reason: `Bot-protected domain (${msg})`,
        botProtected: true,
        patternValid: hasValidContentUrlPattern(url),
      };
    }

    return { valid: false, reason: msg };
  }
}

const OFFICIAL_DOMAINS = [
  'eba.europa.eu', 'esma.europa.eu', 'ec.europa.eu', 'ecb.europa.eu',
  'eur-lex.europa.eu', 'fatf-gafi.org', 'moneyval.coe.int',
  'sec.gov', 'cftc.gov', 'fincen.gov', 'occ.gov', 'federalreserve.gov',
  'cfpb.gov', 'cnb.cz', 'cba.am',
];

const MEDIA_DOMAINS = [
  'thepaypers.com', 'finextra.com', 'coindesk.com', 'dlnews.com',
  'sifted.eu', 'techcrunch.com', 'bloomberg.com', 'reuters.com',
  'ft.com', 'theblock.co', 'chainalysis.com', 'fireblocks.com',
];

const MONITORED_THOUGHT_LEADERS = [
  'Marcel van Oost', 'Arthur Bedel', 'Simon Taylor', 'Nic Carter',
  'Nathan Sexer', 'Jeremy Allaire', 'Linas Beliunas', 'Alex Johnson',
  'Patrick McKenzie', 'Lex Sokolin', 'Ron Shevlin', 'Jason Mikula',
  'Richard Turrin', 'Theodora Lau', 'Jake Chervinsky', 'Caitlin Long',
  'David Birch', 'Chris Skinner', 'Ghela Boskovich', 'Anne Boden',
  'Spiros Margaris', 'Efi Pylarinou', 'Brett King', 'Matt Harris',
  'Adrienne Harris', 'Karen Webster', 'Jason Henrichs', 'David Parker',
  'Leda Glyptis', 'Miranda Steinhauser',
];

function classifySourceUrl(url: string): 'official' | 'media' | 'other' {
  if (!url) return 'other';
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    if (OFFICIAL_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      return 'official';
    }
    if (MEDIA_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      return 'media';
    }
  } catch {
    // Invalid URL
  }
  return 'other';
}

export async function writeKnowledgeEntry(input: {
  title: string;
  content: string;
  category: 'regulation' | 'technology' | 'market' | 'competitor'
          | 'partner' | 'education' | 'general' | 'influencer' | 'product';
  permanence: 'permanent' | 'temporary';
  expiryDays?: number;
  trustLevel: 'verified' | 'informational' | 'signal';
  sourceType: 'official' | 'media' | 'research' | 'company'
            | 'linkedin_expert' | 'linkedin_general' | 'social' | 'inferred';
  sourceUrl?: string;
  tags?: string[];
  signalScore: number;
  isOpinion?: boolean;
  authorName?: string;
  agentScope?: string | string[];  // Single agent ID or array of agent IDs
  verificationStatus?: 'confirmed' | 'informational' | 'pending';
}): Promise<string> {
  const db = await getDb();
  const collection = db.collection('knowledges');

  if (['linkedin_general', 'social', 'inferred'].includes(input.sourceType)) {
    return `BLOCKED: sourceType '${input.sourceType}' is not permitted in the knowledge base. Use write_inbox_signal instead.`;
  }

  // URL VERIFICATION: For entries with sourceUrl, verify the URL actually exists
  // This prevents hallucinated/fabricated URLs from being stored as authoritative sources
  let urlVerified = false;
  let urlVerificationReason = '';
  let urlBotProtected = false;
  let urlPatternValid = false;
  let finalSourceUrl = input.sourceUrl || '';

  if (input.sourceUrl) {
    const verification = await verifyUrlExists(input.sourceUrl);
    urlVerified = verification.valid;
    urlVerificationReason = verification.reason || '';
    urlBotProtected = verification.botProtected || false;
    urlPatternValid = verification.patternValid || false;

    if (verification.valid && verification.finalUrl) {
      // Use the final URL after redirects (in case of URL shorteners, etc.)
      finalSourceUrl = verification.finalUrl;
    }
  }

  const urlClass = classifySourceUrl(finalSourceUrl);
  let enforcedTrustLevel = input.trustLevel;
  let enforcedVerificationStatus = input.verificationStatus || 'pending';

  // Handle bot-protected domains differently - don't auto-downgrade
  if (input.sourceUrl && urlBotProtected) {
    // If URL pattern matches expected format, keep it but mark as unverifiable
    if (urlPatternValid) {
      enforcedVerificationStatus = 'pending';
      // Keep the URL - it looks legitimate but we can't verify via HTTP
    } else {
      // Pattern doesn't match - likely fabricated
      enforcedTrustLevel = 'signal';
      enforcedVerificationStatus = 'pending';
      finalSourceUrl = '';
    }
  } else if (input.sourceUrl && !urlVerified) {
    // Non-bot-protected domain failed verification - definitely bad
    if (input.trustLevel === 'verified' || input.trustLevel === 'informational') {
      enforcedTrustLevel = 'signal';
      enforcedVerificationStatus = 'pending';
      // Clear the bad URL - don't store a 404 link
      finalSourceUrl = '';
    }
  }

  if (input.trustLevel === 'verified' && urlClass !== 'official') {
    enforcedTrustLevel = 'informational';
    enforcedVerificationStatus = 'pending';
  }
  if (urlClass === 'official' && urlVerified) {
    enforcedTrustLevel = 'verified';
    enforcedVerificationStatus = 'confirmed';
  }
  if (urlClass === 'media' && enforcedTrustLevel === 'signal') {
    enforcedTrustLevel = 'informational';
  }

  if (input.isOpinion || input.sourceType === 'linkedin_expert') {
    enforcedVerificationStatus = 'pending';
    enforcedTrustLevel = 'signal';
  }

  let score = Math.max(1, Math.min(10, Math.round(input.signalScore)));
  if (input.sourceType === 'linkedin_expert') score = Math.min(score, 6);
  if (input.sourceType === 'company') score = Math.min(score, 5);

  // Downgrade score if URL verification failed
  if (input.sourceUrl && !urlVerified && score > 5) {
    score = 5; // Cap at 5 for unverifiable sources
  }

  if (score <= 3) {
    return `BLOCKED: signalScore ${score} ≤ 3. Entry is noise. Do not write.`;
  }

  if (score >= 7 && !input.sourceUrl) {
    return `BLOCKED: signalScore ${score} requires a sourceUrl. Provide a direct source URL or lower the score.`;
  }

  // Block high-score entries with failed URL verification (unless bot-protected with valid pattern)
  if (score >= 7 && input.sourceUrl && !urlVerified && !(urlBotProtected && urlPatternValid)) {
    return `BLOCKED: sourceUrl "${input.sourceUrl}" failed verification (${urlVerificationReason}). High-score entries require working source URLs. Either find the correct URL or lower the score.`;
  }

  let finalContent = input.content;
  if (input.isOpinion && input.authorName) {
    finalContent = `[Opinion — ${input.authorName}]: ${input.content}`;
  }
  if (input.sourceType === 'company') {
    finalContent = `[Self-reported, unverified]: ${input.content}`;
  }
  // Add unverifiable warning to content if URL check failed (but not for bot-protected with valid pattern)
  if (input.sourceUrl && !urlVerified && !(urlBotProtected && urlPatternValid)) {
    finalContent = `[Source URL unverifiable]: ${finalContent}`;
  } else if (urlBotProtected && urlPatternValid) {
    finalContent = `[Bot-protected source — cannot verify automatically]: ${finalContent}`;
  }

  const doc = {
    title: input.title,
    summary: finalContent,
    category: input.category,
    permanent: input.permanence === 'permanent',
    expiresAt: input.permanence === 'temporary' && input.expiryDays
      ? new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000)
      : null,
    trustLevel: enforcedTrustLevel,
    verificationStatus: enforcedVerificationStatus,
    sourceType: input.sourceType,
    source: finalSourceUrl,
    sourceUrlVerified: urlVerified,
    sourceUrlBotProtected: urlBotProtected,
    sourceUrlPatternValid: urlPatternValid,
    sourceUrlVerificationError: urlVerified ? null : urlVerificationReason,
    isOpinion: input.isOpinion || false,
    authorName: input.authorName || '',
    tags: input.tags || [],
    signalScore: score,
    noiseFlag: score <= 3,
    scope: input.agentScope ? 'professional' : 'organization',
    // Support both single agent ID and array of agent IDs
    targetAgent: Array.isArray(input.agentScope)
      ? input.agentScope[0]
      : (input.agentScope || null),
    relevantAgents: Array.isArray(input.agentScope)
      ? input.agentScope
      : (input.agentScope ? [input.agentScope] : []),
    createdAt: new Date(),
    updatedAt: new Date(),
    addedBy: 'hasmik',
    status: 'active',
  };

  await collection.insertOne(doc);

  const verifyNote = input.sourceUrl
    ? (urlVerified ? ', URL verified' : `, URL FAILED: ${urlVerificationReason}`)
    : '';
  return `Saved: "${input.title}" — score:${score}, trust:${enforcedTrustLevel}, status:${enforcedVerificationStatus}, source:${input.sourceType}${verifyNote}`;
}

export async function writeFundraisingRound(input: {
  company: string;
  amount: string;
  round: 'Pre-Seed' | 'Seed' | 'Series A' | 'Series B' | 'Series C' | 'Other';
  investors: string[];
  sector: string;
  relevance: string;
  sourceUrl: string;
  announcedDate: string;
}): Promise<string> {
  if (!input.sourceUrl) {
    return `REJECTED: Fundraising rounds require a direct source URL (Crunchbase, TechCrunch, official press release). Do not write from inference.`;
  }

  if (input.sourceUrl.includes('linkedin.com')) {
    return `REJECTED: LinkedIn is not an acceptable source for fundraising rounds. Find a Crunchbase, TechCrunch, or official press release URL. A founder announcing their own round on LinkedIn is not verified intelligence.`;
  }

  // Verify the sourceUrl actually exists
  const sourceVerify = await verifyUrlExists(input.sourceUrl);
  if (!sourceVerify.valid) {
    return `REJECTED: sourceUrl "${input.sourceUrl}" failed verification (${sourceVerify.reason}). Fundraising rounds require working source URLs.`;
  }

  if (!input.investors.length ||
      input.investors.every(i => i.toLowerCase().includes('undisclosed'))) {
    return `REJECTED: Fundraising entries require at least one named investor. Undisclosed investor rounds do not qualify as actionable intelligence.`;
  }

  const announced = new Date(input.announcedDate);
  if (isNaN(announced.getTime())) {
    return `REJECTED: announcedDate "${input.announcedDate}" is not a valid ISO date. Provide the exact announcement date.`;
  }
  const daysSince = (Date.now() - announced.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 14) {
    return `REJECTED: Round announced ${input.announcedDate} is ${Math.round(daysSince)} days old. Only rounds from the past 14 days qualify as current intelligence.`;
  }

  const db = await getDb();
  const collection = db.collection('fundraisingrounds');

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const existing = await collection.findOne({
    companyName: input.company,
    createdAt: { $gte: weekStart },
  });
  if (existing) {
    return `SKIPPED: "${input.company}" already recorded this week.`;
  }

  const amountNum = parseFloat(input.amount.replace(/[^0-9.]/g, '')) || 0;
  const currency = input.amount.includes('€') ? 'EUR' : 'USD';

  await collection.insertOne({
    companyName: input.company,
    amount: amountNum,
    currency,
    roundType: input.round.toLowerCase().replace(/\s+/g, '-'),
    investors: input.investors.map(name => ({ name, firm: name })),
    category: input.sector,
    relevanceToAeda: input.relevance,
    sourceUrl: sourceVerify.finalUrl || input.sourceUrl,
    announcedDate: input.announcedDate,
    weekOf: weekStart,
    addedBy: 'hasmik',
    createdAt: new Date(),
    addedToPipeline: false,
    sourceUrlVerified: true,
  });

  return `Saved round: ${input.company} — ${input.amount} ${input.round} (announced: ${input.announcedDate}) — URL verified`;
}

export async function writeFundingOpportunity(input: {
  name: string;
  type: 'accelerator' | 'grant' | 'incubator' | 'studio' | 'ecosystem-fund';
  provider: string;
  deadline?: string;
  amount?: string;
  eligibility: string;
  website?: string;
  applyUrl?: string;
  sourceUrl: string;
  region: string;
}): Promise<string> {
  const db = await getDb();
  const collection = db.collection('fundingopportunities');

  const existing = await collection.findOne({ programName: input.name });
  if (existing) {
    return `SKIPPED: "${input.name}" already exists in funding opportunities.`;
  }

  // Verify sourceUrl actually exists (required field)
  const sourceVerify = await verifyUrlExists(input.sourceUrl);
  if (!sourceVerify.valid) {
    return `BLOCKED: sourceUrl "${input.sourceUrl}" failed verification (${sourceVerify.reason}). Funding opportunities require working source URLs.`;
  }

  // URL hygiene: applyUrl must trace back to something the model actually
  // saw in web_search results (sourceUrl is required for that reason). If
  // applyUrl was omitted, fall back to the verified homepage rather than
  // leaving the Apply button pointed at nothing.
  let applicationUrl = input.applyUrl || input.website || '';

  // Verify applyUrl if provided
  if (input.applyUrl) {
    const applyVerify = await verifyUrlExists(input.applyUrl);
    if (!applyVerify.valid) {
      // Fall back to website or sourceUrl instead of storing a bad link
      applicationUrl = input.website || input.sourceUrl;
    } else if (applyVerify.finalUrl) {
      applicationUrl = applyVerify.finalUrl;
    }
  }

  // Verify website if provided
  let verifiedWebsite = input.website || '';
  if (input.website) {
    const websiteVerify = await verifyUrlExists(input.website);
    if (websiteVerify.valid && websiteVerify.finalUrl) {
      verifiedWebsite = websiteVerify.finalUrl;
    } else if (!websiteVerify.valid) {
      verifiedWebsite = ''; // Clear bad website URL
    }
  }

  await collection.insertOne({
    weekOf: new Date(),
    programName: input.name,
    type: input.type,
    provider: input.provider,
    deadline: input.deadline || 'Rolling',
    fundingAmount: input.amount || '',
    eligibilityReasoning: input.eligibility,
    website: verifiedWebsite,
    applicationUrl,
    sourceUrl: sourceVerify.finalUrl || input.sourceUrl,
    geography: [input.region],
    status: 'open',
    dismissed: false,
    applied: false,
    isAedaEligible: true,
    recommendedAction: '',
    priority: 'Medium',
    archived: false,
    addedBy: 'hasmik',
    createdAt: new Date(),
    urlsVerified: true,
  });

  return `Saved opportunity: ${input.name} (${input.type} — ${input.provider}) — URLs verified`;
}

export async function writeInboxSignal(input: {
  title: string;
  content: string;
  sourceUrl?: string;
  sourceType: string;
  authorName?: string;
  reason: string;
  type: 'unverified-signal' | 'potential-misinformation' | 'opinion-signal';
}): Promise<string> {
  const db = await getDb();

  await db.collection('os_inbox_items').insertOne({
    recipient: 'artur',
    sender_email: 'hasmik@aeda.internal',
    sender_name: '@hasmik (Research Agent)',
    subject: `[${input.type}] ${input.title}`,
    body_text: [
      input.content,
      input.authorName ? `Author: ${input.authorName}` : '',
      input.sourceUrl ? `Source: ${input.sourceUrl}` : 'No source URL',
      `Flagged because: ${input.reason}`,
    ].filter(Boolean).join('\n\n'),
    body_sanitized: input.content,
    agent_commentary: `Flagged by @hasmik: ${input.reason}`,
    message_id: `hasmik-signal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    received_at: new Date(),
    processing_status: 'draft_created',
    routing: {
      artur_classification: input.type,
      routed_to_agent: 'artur',
      artur_brief: input.reason,
      lilit_task_id: null,
    },
    crm_match: { matched: false, investor_id: null, investor_name: null, matched_on: null },
    createdAt: new Date(),
  });

  return `Flagged to Artur inbox (${input.type}): "${input.title}"`;
}

interface KnowledgeEntry {
  category: string;
  title: string;
  signalScore: number;
  sourceType: string;
}

// ============================================================================
// INCREMENTAL RESEARCH STATE
// ============================================================================
// Tracks when each research domain was last surveyed, enabling the agent to
// request "news since [date]" rather than full re-survey. Reduces cost by
// avoiding redundant web_search calls on slowly-changing domains.

interface DomainResearchState {
  domain: string;
  lastResearchedAt: Date;
  lastFindingsCount: number;
  lastTopFindings: string[];
  lastWebSearchCount?: number;
  lastEstimatedCostUsd?: number;
  totalWebSearches?: number;
  totalFindings?: number;
}

export async function getDomainResearchState(input: {
  domain: string;
}): Promise<string> {
  const db = await getDb();
  const state = await db.collection('hasmik_research_state').findOne({
    domain: input.domain,
  }) as DomainResearchState | null;

  if (!state) {
    return `Domain "${input.domain}" has never been researched. Perform full survey.`;
  }

  const daysSince = Math.floor((Date.now() - new Date(state.lastResearchedAt).getTime()) / (1000 * 60 * 60 * 24));
  const dateStr = new Date(state.lastResearchedAt).toISOString().split('T')[0];

  return [
    `Domain: ${input.domain}`,
    `Last researched: ${dateStr} (${daysSince} days ago)`,
    `Findings that run: ${state.lastFindingsCount}`,
    state.lastTopFindings.length > 0
      ? `Top findings then: ${state.lastTopFindings.join('; ')}`
      : 'No prior findings recorded.',
    '',
    daysSince <= 3
      ? `GUIDANCE: Very recent. Search for "since:${dateStr}" or "this week" only. Skip if domain is slow-moving.`
      : daysSince <= 7
        ? `GUIDANCE: Search for news since ${dateStr}. Use "since:" or date filters in queries.`
        : `GUIDANCE: Over a week old. Perform standard survey but note prior findings to avoid duplicates.`,
  ].join('\n');
}

export async function updateDomainResearchState(input: {
  domain: string;
  findingsCount: number;
  topFindings: string[];
  webSearchCount?: number;
}): Promise<string> {
  const db = await getDb();
  const webSearches = input.webSearchCount ?? 0;
  const estimatedCost = webSearches * 0.03;  // ~$0.03 per web_search

  await db.collection('hasmik_research_state').updateOne(
    { domain: input.domain },
    {
      $set: {
        domain: input.domain,
        lastResearchedAt: new Date(),
        lastFindingsCount: input.findingsCount,
        lastTopFindings: input.topFindings.slice(0, 3),
        lastWebSearchCount: webSearches,
        lastEstimatedCostUsd: estimatedCost,
        updatedAt: new Date(),
      },
      $inc: {
        totalWebSearches: webSearches,
        totalFindings: input.findingsCount,
      },
    },
    { upsert: true }
  );

  const costNote = webSearches > 0 ? ` (~$${estimatedCost.toFixed(2)} in web searches)` : '';
  return `Updated research state for "${input.domain}": ${input.findingsCount} findings, ${webSearches} web searches${costNote}.`;
}

export async function listAllDomainStates(): Promise<string> {
  const db = await getDb();
  const states = await db.collection('hasmik_research_state')
    .find({})
    .sort({ lastResearchedAt: -1 })
    .toArray() as unknown as DomainResearchState[];

  if (states.length === 0) {
    return 'No prior research state. This appears to be first run — survey all domains.';
  }

  const lines = states.map(s => {
    const daysSince = Math.floor((Date.now() - new Date(s.lastResearchedAt).getTime()) / (1000 * 60 * 60 * 24));
    const dateStr = new Date(s.lastResearchedAt).toISOString().split('T')[0];
    const costNote = s.lastWebSearchCount ? `, ${s.lastWebSearchCount} searches (~$${(s.lastEstimatedCostUsd ?? 0).toFixed(2)})` : '';
    return `- ${s.domain}: ${dateStr} (${daysSince}d ago), ${s.lastFindingsCount} findings${costNote}`;
  });

  const totalSearches = states.reduce((sum, s) => sum + (s.totalWebSearches ?? 0), 0);
  const totalFindings = states.reduce((sum, s) => sum + (s.totalFindings ?? 0), 0);

  return [
    `Research state for ${states.length} domains:`,
    ...lines,
    '',
    `Cumulative: ${totalFindings} findings, ${totalSearches} web searches (~$${(totalSearches * 0.03).toFixed(2)})`,
    'Domains older than 7 days need fresh survey. Recent domains: incremental search only.',
  ].join('\n');
}

export async function readRecentKnowledgeTitles(input: {
  category?: string;
  daysBack?: number;
}): Promise<string> {
  const db = await getDb();
  const collection = db.collection('knowledges');

  const since = new Date();
  since.setDate(since.getDate() - (input.daysBack ?? 30));

  const query: Record<string, unknown> = { createdAt: { $gte: since } };
  if (input.category) query['category'] = input.category;

  const entries = await collection
    .find(query)
    .project({ title: 1, category: 1, signalScore: 1, sourceType: 1 })
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray() as unknown as KnowledgeEntry[];

  if (!entries.length) return 'No recent entries found in this category.';

  return entries
    .map(e => `[${e.category}] ${e.title} (score:${e.signalScore}, source:${e.sourceType})`)
    .join('\n');
}

export { MONITORED_THOUGHT_LEADERS };
