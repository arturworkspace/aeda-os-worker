import mongoose from 'mongoose';
import { type Agenda } from 'agenda';
import Anthropic from '@anthropic-ai/sdk';
import { KnowledgeEntryModel } from '../db/schemas/knowledge.js';
import { logger } from '../logger.js';
import { env } from '../config/env.js';

const JOB_NAME = 'hasmik.weeklyIntelligence';
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ─── Org intelligence domains ────────────────────────────────────────────────

const ORG_DOMAINS = [
  {
    id: 'regulation',
    category: 'regulation',
    relevantAgents: ['narek', 'vagho', 'arshak', 'artur'],
    searchFocus: `Scan these regulatory sources for aeda-relevant
      updates this week. aeda is a non-custodial EURC stablecoin
      wallet (EU-Armenia corridor, Prague, Czech Republic).
      Focus on: stablecoins, EMT, MiCA, AML/KYC, CASP,
      Travel Rule, blockchain/DLT regulation.
      IMPORTANT: For every signal, include the exact source URL.

      TIER 1A — EU PRIMARY REGULATORS:
      - EBA (eba.europa.eu) — MiCA implementation, stablecoin/EMT
        guidance, CASP requirements, AML updates, Q&As, Guidelines
      - ESMA (esma.europa.eu) — MiCA technical standards,
        CASP oversight, crypto-assets regulation
      - European Commission Digital Finance
        (finance.ec.europa.eu/digital-finance_en) —
        new legislative proposals, Digital Finance Package updates
      - ECB (ecb.europa.eu) — stablecoin policy, Digital Euro,
        payments infrastructure future
      - Czech National Bank / CNB (cnb.cz) — MiCA interpretation
        for Czech entities, crypto licensing, fintech regulatory updates
      - Central Bank of Armenia / CBA (cba.am) — Armenian fintech
        policy, sandbox initiatives, AML/KYC rule changes

      TIER 1B — USA REGULATORS (global stablecoin precedent):
      - SEC (sec.gov) — crypto asset securities classification,
        stablecoin enforcement, exchange regulation
      - CFTC (cftc.gov) — crypto derivatives, stablecoin commodity
        classification, enforcement against payment protocols
      - FinCEN (fincen.gov) — AML/BSA for crypto, Travel Rule
        enforcement, non-custodial wallet guidance
      - OCC (occ.gov) — bank crypto custody, stablecoin reserve
        requirements, fintech charter updates
      - Federal Reserve (federalreserve.gov) — stablecoin
        legislation, CBDC research, payment system oversight
      - CFPB (consumerfinance.gov) — digital wallet consumer
        protection, payment app regulation, open banking
      NOTE: Circle (EURC issuer) is US-based — US regulatory
      shifts directly affect EURC compliance and availability.

      TIER 2 — AML / COMPLIANCE:
      - FATF (fatf-gafi.org) — Travel Rule updates, Virtual Assets
        guidance, AML international standards
      - Moneyval (coe.int/moneyval) — Armenia AML assessments,
        European AML evaluation reports

      TIER 3 — MARKET INTELLIGENCE:
      - The Paypers (thepaypers.com) — payments regulation,
        stablecoins, open banking, fintech compliance
      - Finextra (finextra.com) — banking, wallets, CBDC, stablecoins
      - CoinDesk Policy (coindesk.com/policy) — crypto regulation
      - DL News (dlnews.com) — MiCA, stablecoins, Circle, Revolut
      - Circle Policy Hub — EURC/USDC regulatory changes
      - Fireblocks Blog (fireblocks.com/blog) — institutional crypto
      - Chainalysis Blog (chainalysis.com/blog) — AML, sanctions

      PRIORITY FLAGS (always report with source URL):
      - Any EBA/ESMA guidance on non-custodial wallets
      - CNB statement on MiCA licensing in Czech Republic
      - CBA sandbox or fintech licensing update in Armenia
      - FATF Travel Rule threshold changes
      - Digital Euro update affecting EURC positioning
      - USA stablecoin legislation advancing (GENIUS Act, STABLE Act)
      - SEC/CFTC enforcement against stablecoin wallet or payment app
      - FinCEN guidance on Travel Rule for non-custodial wallets
      - Circle facing any US regulatory action
      - Any enforcement action against stablecoin wallet in EU/USA`,
  },
  {
    id: 'technology',
    category: 'technology',
    relevantAgents: ['hamazasp', 'anna', 'vagho', 'artur'],
    searchFocus: `Search for OFFICIAL engineering and infrastructure
      updates this week. aeda stack: NestJS, Flutter, Solana,
      MongoDB, AWS, Railway, Vercel, Anthropic API.

      MANDATORY: Every signal must include the exact official
      source URL (changelog, release notes, official blog,
      GitHub release). No unofficial sources.

      SOURCES TO CHECK (official only):
      - Solana (solana.com/news, github.com/solana-labs,
        solana.com/developers/changelog) —
        protocol updates, TPS, fee changes, outages,
        new validator features, RPC changes
      - Helius (helius.dev/blog) — RPC updates,
        new APIs, webhook changes
      - Anthropic (anthropic.com/news, docs.anthropic.com/changelog) —
        Claude API changes, new models, pricing,
        new capabilities, MCP updates
      - Railway (railway.app/changelog) —
        platform updates, pricing, new regions, features
      - Vercel (vercel.com/changelog) —
        Next.js updates, edge functions, deployment changes
      - NestJS (github.com/nestjs/nest/releases) —
        framework releases, breaking changes
      - Flutter (flutter.dev/docs/release/release-notes) —
        SDK releases, breaking changes, new APIs
      - MongoDB (mongodb.com/blog/channel/products) —
        Atlas updates, driver changes, new features
      - AWS (aws.amazon.com/new, aws.amazon.com/blogs) —
        ECS, S3, relevant service updates
      - Cloudflare (blog.cloudflare.com) —
        Workers, R2, Email Routing updates
      - Node.js (nodejs.org/en/blog) —
        LTS releases, security patches

      PRIORITY FLAGS:
      - Any Solana outage or major performance issue
      - Anthropic API breaking change or deprecation
      - Security vulnerability in any stack component
      - Railway pricing or plan change
      - Helius RPC API change affecting our integration`,
  },
  {
    id: 'product',
    category: 'technology',
    relevantAgents: ['laura', 'artur', 'narek', 'arshak', 'chris', 'hamazasp'],
    searchFocus: `Search for OFFICIAL product news and infrastructure
      announcements relevant to building a non-custodial EURC
      stablecoin wallet (EU-Armenia corridor).

      MANDATORY: Every signal must include the exact official
      source URL (official blog, press release, official announcement,
      changelog). No unofficial or secondary sources.

      SOURCES TO CHECK (official announcements only):

      EMBEDDED WALLET INFRASTRUCTURE:
      - Privy (privy.io/blog) — wallet SDK updates, new features
      - Turnkey (turnkey.com/blog) — MPC wallet updates
      - Dynamic (dynamic.xyz/blog) — embedded wallet features
      - Crossmint (crossmint.com/blog) — wallet-as-a-service updates
      - Coinbase Developer Platform (docs.cdp.coinbase.com/changelog)
      - DFNS (dfns.co/blog) — institutional wallet updates
      - Fireblocks (fireblocks.com/blog) — custody infrastructure

      STABLECOIN INFRASTRUCTURE:
      - Circle (circle.com/blog, developers.circle.com/changelog) —
        EURC/USDC updates, new APIs, new countries, policy changes
      - Bridge (bridge.xyz/blog) — new corridors, API updates,
        pricing changes, country support
      - BVNK (bvnk.com/blog) — stablecoin payment updates
      - Paxos (paxos.com/newsroom) — stablecoin infrastructure
      - Stripe (stripe.com/newsroom, stripe.com/blog) —
        stablecoin product updates, payment features

      ONRAMP / OFFRAMP:
      - Transak (transak.com/blog) — new country support,
        new payment methods, fee changes
      - Ramp Network (ramp.network/blog) — new corridors, features
      - MoonPay (moonpay.com/blog) — new features, country support
      - Sardine (sardine.ai/blog) — fraud/KYC updates
      - Mercuryo (mercuryo.io/blog) — new corridors, payment methods
      - Kado (kado.money/blog) — stablecoin onramp updates

      CROSS-BORDER PAYMENTS:
      - Conduit (getconduit.app/blog) — stablecoin payouts
      - Mural Pay (muralpay.com/blog) — treasury/payouts
      - Arf (arf.one/blog) — cross-border stablecoin

      COMPLIANCE / KYC:
      - Sumsub (sumsub.com/blog) — KYC/AML updates, new features,
        new country support, pricing changes
      - Chainalysis (chainalysis.com/blog) — AML/compliance tools
      - TRM Labs (trmlabs.com/blog) — blockchain intelligence

      WALLET TRENDS:
      - Phantom (phantom.app/blog) — UX innovations, new features
      - Safe (safe.global/blog) — smart wallet updates
      - Coinbase Wallet (coinbase.com/blog) — smart wallet features
      - Argent (argent.xyz/blog) — wallet UX, account abstraction

      AI + FINANCE:
      - Any official announcement of AI agent + payments integration
      - Any stablecoin + AI infrastructure startup funding announcement
        from TechCrunch, Bloomberg, or official company blog

      PRIORITY FLAGS (always report with source URL):
      - Circle announcing new EURC country support or API change
      - Bridge.xyz adding Armenia or EECA corridor
      - Sumsub pricing or policy change affecting our KYC integration
      - Any embedded wallet provider adding Solana support
      - Any competitor (Rizon, Sling, Parsek, PEXX) raising funding
        or launching in Europe (official source only)
      - Any new stablecoin wallet launching in EU with regulatory approval
      - Transak or Ramp adding Armenia onramp support`,
  },
  {
    id: 'market',
    category: 'market',
    relevantAgents: ['arshak', 'chris', 'artur'],
    searchFocus: `EU fintech fundraising signals: pre-seed and seed rounds closed this week,
      VC activity in EU payments and stablecoin startups, EECA corridor fintech deals,
      valuation benchmarks for EU fintech pre-seed, investor appetite signals.
      Focus on deals under $2M in EU or EECA markets.`,
  },
  {
    id: 'competitor-stablecoin',
    category: 'competitor',
    tags: ['stablecoin-app'],
    relevantAgents: ['tatev', 'chris', 'alex', 'artur'],
    searchFocus: `Monitor these direct stablecoin wallet competitors to aeda:
      - Rizon (getrizon.com) — stablecoin wallet
      - Sling Money (sling.money) — stablecoin payments
      - Zixi Pay (zixipay.com) — cross-border stablecoin payments
      - Parsek (parsekapp.com) — stablecoin payments app
      - PEXX (pexx.com) — crypto/fiat stablecoin transfers
      - Dollarize (dollarize.me) — dollar stablecoin wallet
      - DolarApp (dolarapp.com) — dollar wallet
      - Stables (stables.money) — stablecoin personal finance
      - Bmoni (bmoni.com) — stablecoin money transfer
      - Payy (payy.link) — stablecoin payment links
      - Sentz (sentz.com) — stablecoin send money app

      FOR EACH: check product launches, new corridors, funding rounds,
      regulatory approvals, pricing changes, partnership announcements,
      app store updates.

      PRIORITY FLAGS (always report):
      - Any entering EUR→AMD corridor
      - Any raising funding above $500K
      - Any receiving EU regulatory approval (EMI, CASP, PI)
      - Any partnering with Bridge.xyz, Sky Labs, or Sumsub`,
  },
  {
    id: 'competitor-remittance',
    category: 'competitor',
    tags: ['remittance'],
    relevantAgents: ['tatev', 'chris', 'alex', 'artur'],
    searchFocus: `Monitor these established remittance and payment network competitors:
      - Wise — pricing changes, corridor updates, Armenia status
        (NOTE: Wise exited Armenia 2024 — flag IMMEDIATELY if they return)
      - Revolut — new features, EECA corridor expansion, stablecoin moves
      - Remitly — pricing, Armenia/EECA coverage changes
      - MoneyGram — corridor updates, crypto/stablecoin integration
      - Western Union — EECA corridor, digital product updates
      - Swift — gpi updates, new payment rails
      - Visa — stablecoin settlement, B2B payments, EECA
      - Mastercard — stablecoin products, Send platform updates

      FOR EACH: check product launches, pricing changes, corridor entries/exits,
      stablecoin integration announcements, regulatory news.`,
  },
  {
    id: 'partner',
    category: 'partner',
    relevantAgents: ['alex', 'hamazasp', 'artur'],
    searchFocus: `Partner ecosystem updates: Bridge.xyz (EU on-ramp), Sky Labs (Armenia off-ramp),
      Sumsub (KYC), Circle (EURC issuer), Solana Foundation grants or partnerships.
      New API versions, pricing changes, outages, policy updates, new corridor support.`,
  },
  {
    id: 'influencer',
    category: 'education',
    sourceType: 'linkedin',
    relevantAgents: ['artur', 'chris', 'tatev', 'arshak'],
    searchFocus: `Search for RECENT insights from these fintech/stablecoin thought leaders.
      Check their newsletters, blogs, and public posts from THIS WEEK.
      MANDATORY: Include exact URL to the article, newsletter, or post.

      STABLECOIN & CRYPTO PAYMENTS:
      - Jeremy Allaire (Circle CEO) — circle.com/blog, substack
      - Nic Carter — medium.com/@nic__carter, Castle Island VC blog
      - Nathan Sexer — nathansexer.substack.com
      - Jake Chervinsky — variant.fund/writing, twitter threads
      - Caitlin Long — caitlin-long.com, Custodia Bank blog

      FINTECH / PAYMENTS:
      - Simon Taylor (11:FS) — sytaylor.substack.com, 11fs.com/blog
      - Lex Sokolin — fintechblueprint.substack.com
      - Ron Shevlin — forbes.com/sites/ronshevlin
      - Jason Mikula — fintechbusinessweekly.substack.com
      - Alex Johnson — alexhjohnson.substack.com (Fintech Takes)
      - Patrick McKenzie (patio11) — kalzumeus.com, bits about money
      - Matt Harris — bain.com/insights (Bain Capital Ventures)

      DIGITAL BANKING / NEOBANKS:
      - Anne Boden (Starling) — anneboden.com
      - Brett King — brettking.com, Breaking Banks podcast
      - Chris Skinner — thefinanser.com
      - Leda Glyptis — ledaglyptis.com, 11:FS

      EU / REGULATION FOCUS:
      - Marcel van Oost — marcelvanOost.substack.com
      - Arthur Bedel — arthurbedel.substack.com
      - David Birch — dgwbirch.com, 15Mb blog
      - Ghela Boskovich — femtechglobal.org

      AI + FINANCE:
      - Theodora Lau — unconventionalventures.com
      - Spiros Margaris — margaris.ai
      - Efi Pylarinou — efipylarinou.com

      PAYMENTS / COMMERCE:
      - Karen Webster — pymnts.com (PYMNTS CEO)
      - Richard Turrin — richardturrin.com (Digital Yuan expert)
      - Adrienne Harris — if regulatory angle from OCC era

      PRIORITY FLAGS (always report with URL):
      - Any post about EURC or Circle's euro stablecoin
      - Any post about non-custodial wallets
      - Any post about MiCA implications
      - Any post about EU-EECA corridor payments
      - Any post about stablecoin vs CBDC debate
      - Any post about embedded finance for startups`,
  },
];

// ─── Professional domains per agent ─────────────────────────────────────────

const AGENT_DOMAINS = [
  {
    agentId: 'hamazasp',
    category: 'technology',
    domain: `Solana v2 official changelog and GitHub releases,
      NestJS official releases and breaking changes,
      Flutter SDK official release notes,
      Helius RPC official API changelog,
      Anthropic API official changelog and new capabilities,
      MCP protocol updates and new server specifications,
      Railway and Vercel official changelogs,
      MongoDB Atlas official release notes,
      AWS ECS and S3 official service updates,
      Cloudflare Workers and R2 official changelog,
      Node.js LTS official releases and security patches,
      GitHub security advisories for our stack dependencies`,
  },
  {
    agentId: 'arshak',
    category: 'market',
    domain: 'EU fintech VC rounds, ACCA regulatory updates, CFO SaaS tools, pre-seed valuation benchmarks, cap table management tools, fundraising metrics',
  },
  {
    agentId: 'narek',
    category: 'regulation',
    domain: 'EU Official Journal publications, EBA and ESMA guidance papers, Czech AMLZ updates, MiCA technical standards, GDPR enforcement decisions, Travel Rule updates',
  },
  {
    agentId: 'tatev',
    category: 'general',
    domain: 'Fintech PR campaigns and brand strategy, communications best practices, startup media coverage trends, investor relations communications, LinkedIn thought leadership for fintech founders',
  },
  {
    agentId: 'laura',
    category: 'technology',
    domain: `Embedded wallet product trends (Privy, Dynamic, Turnkey),
      stablecoin wallet UX research and benchmarks,
      KYC/AML onboarding flow optimization,
      non-custodial wallet product launches and feature updates,
      go-to-market strategies for stablecoin payment apps,
      user onboarding conversion benchmarks for crypto/fintech apps,
      account abstraction UX improvements,
      passkey and biometric authentication in financial apps,
      product management frameworks for regulated fintech,
      official product changelogs from Privy, Dynamic, Crossmint, Bridge`,
  },
  {
    agentId: 'alex',
    category: 'general',
    domain: 'Customer support platform updates (Intercom, Zendesk), SLA benchmarks for fintech, ops automation tools, payment dispute resolution best practices, partner SLA management',
  },
  {
    agentId: 'anna',
    category: 'technology',
    domain: 'Claude API and Anthropic product updates, MCP ecosystem new servers and capabilities, AI agent framework updates (LangGraph, CrewAI), Cursor IDE updates, Vercel AI SDK, Linear updates',
  },
  {
    agentId: 'vagho',
    category: 'technology',
    domain: 'OWASP top 10 updates, Zero Trust architecture developments, crypto wallet security vulnerabilities, API security best practices, Railway and Vercel security features, new CVEs relevant to Node.js stack',
  },
  {
    agentId: 'mike',
    category: 'technology',
    domain: 'Figma product releases and changelog, Canva AI new features, design system trends, fintech UI/UX patterns and research, Adobe Creative Cloud updates, Framer updates',
  },
  {
    agentId: 'ruzan',
    category: 'education',
    domain: 'SEO algorithm updates (Google, Bing), fintech copywriting trends, email marketing benchmarks, conversion copywriting research, landing page optimization studies, content marketing for B2B fintech',
  },
  {
    agentId: 'sofi',
    category: 'technology',
    domain: 'LinkedIn algorithm changes, Instagram and TikTok updates for B2B, AI content creation tools (Midjourney, Runway, Canva AI), social media trends for EU fintech brands, newsletter growth tactics',
  },
  {
    agentId: 'chris',
    category: 'market',
    domain: 'EU fintech M&A activity, stablecoin startup VC deals, Series A multiples for payments companies, LP/GP dynamics in EU tech, emerging market fintech exits, EECA startup ecosystem news',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RESEARCH_SYSTEM = `You are @hasmik, Research & Intelligence Agent at aeda.
aeda is a non-custodial EURC stablecoin wallet (EU-Armenia corridor, Prague, Czech Republic).

KNOWN FACTS (use for contradiction detection):
- Wise exited Armenia corridor 2024, has not returned
- aeda is a technology network, NOT a CASP/VASP/EMI under MiCA
- MiCA entered into force January 2024, full application December 2024
- EURC is Circle's euro stablecoin, regulated as EMT under MiCA
- aeda partners: Bridge.xyz (EU on-ramp), Sky Labs (Armenia), Sumsub (KYC)

RULES:
- Only report what changed THIS WEEK
- No hallucination — only verifiable recent developments
- If nothing material changed, return empty signals array
- Max 3 signals per research call
- trustLevel: "verified" only for official .gov/.eu sources
  "informational" for Reuters/Bloomberg/official blogs
  "signal" for everything else

Respond ONLY with valid JSON, no markdown:
{
  "signals": [
    {
      "title": "max 80 chars",
      "summary": "factual, what the agent should know, max 150 words",
      "trustLevel": "verified" | "informational" | "signal",
      "confidence": "High" | "Medium" | "Low",
      "verificationStatus": "confirmed" | "unverifiable" | "signal",
      "sourceUrl": "REQUIRED — exact URL of the official source article, changelog, or announcement. If no official URL available, set verificationStatus to unverifiable and confidence to Low.",
      "sourceLabel": "human-readable source name e.g. 'Anthropic Changelog', 'Circle Blog', 'Solana Foundation News'"
    }
  ],
  "weekSummaryLine": "1-2 sentence summary of this domain this week"
}`;

async function runResearchCall(prompt: string): Promise<{
  signals: Array<{
    title: string;
    summary: string;
    trustLevel: string;
    confidence: string;
    verificationStatus: string;
    sourceUrl: string;
    sourceLabel: string;
  }>;
  weekSummaryLine: string;
}> {
  try {
    // Step 1: Research with web search — free-form response
    const researchResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `You are @hasmik, Research & Intelligence Agent at aeda.
aeda is a non-custodial EURC stablecoin wallet (EU-Armenia corridor, Prague).
Research the topic and provide a detailed factual summary of the most recent developments.
Write in plain prose. Include specific facts, dates, numbers where available.
Focus only on what is genuinely new or changed recently.`,
      tools: [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
    });

    const researchText = researchResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();

    if (!researchText || researchText.length < 50) {
      return { signals: [], weekSummaryLine: 'No significant updates this week.' };
    }

    // Step 2: Structure into JSON — no web search, pure formatting
    const structureResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: `Convert research findings into structured JSON signals for aeda's knowledge base.
Output ONLY valid JSON, no markdown fences, no explanation.

Known facts (for contradiction checking):
- Wise exited Armenia corridor 2024, has not returned
- aeda is a technology network, NOT a CASP/VASP/EMI
- MiCA entered into force January 2024

trustLevel rules:
- "verified": official .gov/.eu sources only
- "informational": Reuters, Bloomberg, official company blogs
- "signal": everything else, unverified claims

Required JSON format:
{
  "signals": [
    {
      "title": "max 80 chars",
      "summary": "what agents should know, max 150 words, factual",
      "trustLevel": "verified" | "informational" | "signal",
      "confidence": "High" | "Medium" | "Low",
      "verificationStatus": "confirmed" | "unverifiable" | "signal",
      "sourceUrl": "REQUIRED — exact URL of the official source article, changelog, or announcement. If no official URL available, set verificationStatus to unverifiable and confidence to Low.",
      "sourceLabel": "human-readable source name e.g. 'Anthropic Changelog', 'Circle Blog', 'Solana Foundation News'"
    }
  ],
  "weekSummaryLine": "1 sentence summary of this domain this week"
}

Rules:
- Maximum 3 signals
- Only include genuinely material developments
- If nothing significant: return { "signals": [], "weekSummaryLine": "No material updates this week." }
- Never hallucinate specific dates or numbers not in the research`,
      messages: [
        {
          role: 'user',
          content: `Convert these research findings into JSON signals:\n\n${researchText}`,
        },
      ],
    });

    const raw =
      structureResponse.content[0]?.type === 'text'
        ? structureResponse.content[0].text.trim()
        : '';

    if (!raw) return { signals: [], weekSummaryLine: 'No updates this week.' };

    // Extract JSON using brace matching
    const start = raw.indexOf('{');
    if (start === -1) return { signals: [], weekSummaryLine: 'Parse failed.' };

    let depth = 0;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) return { signals: [], weekSummaryLine: 'Parse failed.' };

    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      weekSummaryLine: parsed.weekSummaryLine || 'Updates processed.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, '[hasmik] research call failed');
    return { signals: [], weekSummaryLine: 'Research call failed.' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveSignal(opts: {
  signal: {
    title: string;
    summary: string;
    trustLevel: string;
    confidence: string;
    verificationStatus: string;
    sourceUrl: string;
    sourceLabel: string;
  };
  category: string;
  sourceType?: string;
  tags?: string[];
  scope: 'organization' | 'professional';
  relevantAgents?: string[];
  targetAgent?: string;
  expiresInDays: number;
}): Promise<void> {
  const { signal, category, scope, relevantAgents, targetAgent, expiresInDays } = opts;

  const doc = new KnowledgeEntryModel({
    title: signal.title,
    summary: signal.summary,
    category,
    tags: opts.tags ?? [],
    scope,
    relevantAgents: scope === 'organization' ? (relevantAgents ?? []) : [targetAgent],
    targetAgent: scope === 'professional' ? targetAgent : undefined,
    source: signal.sourceUrl || 'hasmik-weekly',
    sourceType: opts.sourceType ?? 'article',
    trustLevel: signal.trustLevel || 'signal',
    confidence: signal.confidence || 'Low',
    verificationStatus: signal.verificationStatus || 'unverifiable',
    verificationSources: signal.sourceUrl ? [signal.sourceUrl] : [],
    verificationNotes: `Auto-researched by @hasmik weekly intelligence job. Source: ${signal.sourceLabel || 'web search'}`,
    addedBy: 'hasmik',
    permanent: false,
    status: 'active',
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
  });
  await doc.save();
}

// ─── Job definition ──────────────────────────────────────────────────────────

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, { concurrency: 1 }, async () => {
    logger.info('[hasmik] weekly intelligence job started');

    const weekLabel = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    const masterBriefLines: string[] = [`AEDA WEEKLY INTELLIGENCE BRIEF — ${weekLabel}\n`];
    let totalSignals = 0;

    // ── PHASE 1: Organization intelligence (5 domains) ───────────────────────
    logger.info('[hasmik] phase 1: organization intelligence');

    for (const domain of ORG_DOMAINS) {
      logger.info({ domain: domain.id }, '[hasmik] researching org domain');

      const result = await runResearchCall(
        `Research the latest developments this week in: ${domain.searchFocus}`
      );

      masterBriefLines.push(`\n[${domain.id.toUpperCase()}] ${result.weekSummaryLine}`);

      for (const signal of result.signals) {
        try {
          await saveSignal({
            signal,
            category: domain.category,
            sourceType: (domain as { sourceType?: string }).sourceType ?? 'article',
            tags: (domain as { tags?: string[] }).tags ?? [],
            scope: 'organization',
            relevantAgents: domain.relevantAgents,
            expiresInDays: 7,
          });
          totalSignals++;
        } catch (err) {
          logger.error({ err, title: signal.title }, '[hasmik] failed to save org signal');
        }
      }

      logger.info(
        { domain: domain.id, signalCount: result.signals.length },
        '[hasmik] org domain complete'
      );

      // Rate limit protection between calls
      await sleep(3000);
    }

    // ── PHASE 2: Professional updates (12 agents) ────────────────────────────
    logger.info('[hasmik] phase 2: professional updates');

    for (const agent of AGENT_DOMAINS) {
      logger.info({ agentId: agent.agentId }, '[hasmik] researching professional domain');

      const result = await runResearchCall(
        `Research the latest developments this week specifically for a ${agent.agentId} professional whose domain covers: ${agent.domain}.
        Focus on tool updates, methodology changes, best practices, and news that would help them do their job better this week.`
      );

      for (const signal of result.signals) {
        try {
          await saveSignal({
            signal,
            category: agent.category,
            scope: 'professional',
            targetAgent: agent.agentId,
            expiresInDays: 7,
          });
          totalSignals++;
        } catch (err) {
          logger.error(
            { err, agentId: agent.agentId, title: signal.title },
            '[hasmik] failed to save professional signal'
          );
        }
      }

      masterBriefLines.push(
        `[@${agent.agentId}] ${result.weekSummaryLine}`
      );

      logger.info(
        { agentId: agent.agentId, signalCount: result.signals.length },
        '[hasmik] professional domain complete'
      );

      await sleep(3000);
    }

    // ── Write master brief to Artur's inbox ──────────────────────────────────
    const masterBriefText = masterBriefLines.join('\n');

    try {
      // Use the inboxItem schema that already exists in the worker
      const inboxSchema = new mongoose.Schema({
        agentId:   String,
        type:      String,
        subject:   String,
        body:      String,
        status:    { type: String, default: 'unread' },
        source:    String,
        priority:  { type: String, default: 'normal' },
        createdAt: { type: Date, default: Date.now },
      }, { collection: 'os_inbox_items' });

      const InboxItem = mongoose.models['OsInboxItem'] ??
        mongoose.model('OsInboxItem', inboxSchema);

      const inboxDoc = new InboxItem({
        agentId: 'artur',
        type: 'weekly-intelligence',
        subject: `Weekly Intelligence Brief — ${weekLabel}`,
        body: masterBriefText,
        status: 'unread',
        source: 'hasmik-weekly',
        priority: 'normal',
      });
      await inboxDoc.save();

      logger.info('[hasmik] master brief written to artur inbox');
    } catch (err) {
      logger.error({ err }, '[hasmik] failed to write master brief to inbox');
    }

    logger.info(
      { totalSignals, domains: ORG_DOMAINS.length + AGENT_DOMAINS.length },
      '[hasmik] weekly intelligence job complete'
    );
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  // Monday 07:00 Prague time — requires TZ=Europe/Prague in Railway env vars
  await agenda.every('0 7 * * 1', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('[hasmik] weekly intelligence job scheduled — Monday 07:00 Prague');
}
