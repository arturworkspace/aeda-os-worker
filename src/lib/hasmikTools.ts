import { getDb } from './db.js';

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

  const urlClass = classifySourceUrl(input.sourceUrl || '');
  let enforcedTrustLevel = input.trustLevel;
  let enforcedVerificationStatus = input.verificationStatus || 'pending';

  if (input.trustLevel === 'verified' && urlClass !== 'official') {
    enforcedTrustLevel = 'informational';
    enforcedVerificationStatus = 'pending';
  }
  if (urlClass === 'official') {
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
  if (score <= 3) {
    return `BLOCKED: signalScore ${score} ≤ 3. Entry is noise. Do not write.`;
  }

  if (score >= 7 && !input.sourceUrl) {
    return `BLOCKED: signalScore ${score} requires a sourceUrl. Provide a direct source URL or lower the score.`;
  }

  let finalContent = input.content;
  if (input.isOpinion && input.authorName) {
    finalContent = `[Opinion — ${input.authorName}]: ${input.content}`;
  }
  if (input.sourceType === 'company') {
    finalContent = `[Self-reported, unverified]: ${input.content}`;
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
    source: input.sourceUrl || '',
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
  return `Saved: "${input.title}" — score:${score}, trust:${enforcedTrustLevel}, status:${enforcedVerificationStatus}, source:${input.sourceType}`;
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
    sourceUrl: input.sourceUrl,
    announcedDate: input.announcedDate,
    weekOf: weekStart,
    addedBy: 'hasmik',
    createdAt: new Date(),
    addedToPipeline: false,
  });

  return `Saved round: ${input.company} — ${input.amount} ${input.round} (announced: ${input.announcedDate})`;
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

  // URL hygiene: applyUrl must trace back to something the model actually
  // saw in web_search results (sourceUrl is required for that reason). If
  // applyUrl was omitted, fall back to the verified homepage rather than
  // leaving the Apply button pointed at nothing.
  const applicationUrl = input.applyUrl || input.website || '';

  await collection.insertOne({
    weekOf: new Date(),
    programName: input.name,
    type: input.type,
    provider: input.provider,
    deadline: input.deadline || 'Rolling',
    fundingAmount: input.amount || '',
    eligibilityReasoning: input.eligibility,
    website: input.website || '',
    applicationUrl,
    sourceUrl: input.sourceUrl,
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
  });

  return `Saved opportunity: ${input.name} (${input.type} — ${input.provider})`;
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
