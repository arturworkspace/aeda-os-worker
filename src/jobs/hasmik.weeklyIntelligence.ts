import mongoose from 'mongoose';
import { type Agenda } from 'agenda';
import Anthropic from '@anthropic-ai/sdk';
import { KnowledgeEntryModel, type IKnowledgeEntry } from '../db/schemas/knowledge.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { logger } from '../logger.js';
import { env } from '../config/env.js';

const JOB_NAME = 'hasmik.weeklyIntelligence';
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── Fundraising Round schema (mirrors workspace model) ──────────────
const FundraisingRoundSchema = new mongoose.Schema({
  weekOf:          { type: Date, default: () => new Date() },
  companyName:     String,
  companyUrl:      { type: String, default: "" },
  headquarters:    { type: String, default: "" },
  category:        { type: String, default: "fintech" },
  description:     { type: String, default: "" },
  amount:          { type: Number, default: 0 },
  currency:        { type: String, default: "USD" },
  roundType:       { type: String, default: "seed" },
  announcedDate:   { type: String, default: "" },
  valuation:       { type: Number, default: 0 },
  investors:       [{
    name:            { type: String, default: "" },
    firm:            { type: String, default: "" },
    website:         { type: String, default: "" },
    geography:       { type: String, default: "" },
    stagePreference: { type: String, default: "" },
    checkSize:       { type: String, default: "" },
    addedToCRM:      { type: Boolean, default: false },
  }],
  relevanceToAeda: { type: String, default: "" },
  sourceUrl:       { type: String, default: "" },
  addedBy:         { type: String, default: "hasmik" },
}, { timestamps: true, collection: 'fundraisingrounds' });

const FundraisingRoundModel =
  mongoose.models['FundraisingRound'] ??
  mongoose.model('FundraisingRound', FundraisingRoundSchema);

// ── Funding Opportunity schema ───────────────────────────────────────
const FundingOpportunitySchema = new mongoose.Schema({
  weekOf:               { type: Date, default: () => new Date() },
  programName:          String,
  website:              { type: String, default: "" },
  applicationUrl:       { type: String, default: "" },
  type:                 { type: String, default: "accelerator" },
  description:          { type: String, default: "" },
  fundingAmount:        { type: String, default: "" },
  equityRequired:       { type: String, default: "" },
  deadline:             { type: String, default: "" },
  geography:            [String],
  stageRequirements:    { type: String, default: "" },
  isAedaEligible:       { type: Boolean, default: false },
  eligibilityReasoning: { type: String, default: "" },
  recommendedAction:    { type: String, default: "" },
  priority:             { type: String, default: "Medium" },
  sourceUrl:            { type: String, default: "" },
  addedBy:              { type: String, default: "hasmik" },
  status:               { type: String, default: "open" },
}, { timestamps: true, collection: 'fundingopportunities' });

const FundingOpportunityModel =
  mongoose.models['FundingOpportunity'] ??
  mongoose.model('FundingOpportunity', FundingOpportunitySchema);

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
    id: 'security',
    category: 'technology',
    tags: ['security'],
    relevantAgents: ['vagho', 'hamazasp', 'artur', 'narek'],
    searchFocus: `Search for the most critical security developments
      this week relevant to aeda's infrastructure and AI workspace.
      aeda runs: Next.js on Vercel, Node.js/Express on Railway,
      MongoDB Atlas, Anthropic Claude API, Cloudflare Workers/R2,
      Solana blockchain, AWS ECS.

      MANDATORY: Every signal must include exact source URL.
      Only official security advisories, CVE databases,
      vendor security bulletins, and reputable security media.

      CRITICAL SOURCES TO CHECK:

      CVE & VULNERABILITY DATABASES:
      - NVD (nvd.nist.gov) — new CVEs for: Node.js, Express,
        MongoDB, Next.js, Vercel, Cloudflare, Solana, React
      - GitHub Security Advisories (github.com/advisories) —
        npm package vulnerabilities in our dependency tree
      - Snyk Vulnerability Database (security.snyk.io) —
        Node.js ecosystem vulnerabilities

      CLOUD & INFRASTRUCTURE SECURITY:
      - Vercel Security Blog (vercel.com/blog/security) —
        platform security updates, edge function security
      - Cloudflare Security Blog (blog.cloudflare.com) —
        Workers security, DDoS protection updates, R2 access
      - Railway Security Updates (railway.app/changelog) —
        deployment security, environment variable handling
      - MongoDB Security Advisories (mongodb.com/alerts) —
        Atlas security, driver vulnerabilities, auth changes
      - AWS Security Bulletins (aws.amazon.com/security/bulletins)
        ECS, IAM, S3 security updates

      AI & AGENT SECURITY (critical for aeda workspace):
      - Anthropic Security (anthropic.com/research/security) —
        Claude API security, prompt injection research
      - OWASP LLM Top 10 updates (owasp.org) —
        LLM-specific attack vectors, agent security
      - Simon Willison's blog (simonwillison.net) —
        prompt injection, LLM security research
      - AI security incidents: any reported jailbreaks,
        data leakage via LLMs, agent manipulation attacks

      FINTECH & CRYPTO SECURITY:
      - Solana Foundation Security (solana.com/news) —
        protocol vulnerabilities, validator security
      - Circle Security (circle.com/blog) —
        EURC/USDC smart contract audits, custody security
      - Chainalysis (chainalysis.com/blog) —
        crypto fraud techniques, wallet attack vectors
      - EU ENISA (enisa.europa.eu) —
        European fintech cybersecurity threats, incident reports

      PAYMENT SECURITY STANDARDS:
      - PCI DSS updates (pcisecuritystandards.org)
      - SWIFT security advisories
      - Any reported breaches at: payment processors,
        stablecoin platforms, crypto wallets, EU fintechs

      PRIORITY FLAGS (always report with source URL):
      - Any CVE affecting Node.js, Express, or Next.js rated 7.0+
      - Any Anthropic Claude API security advisory
      - Any Vercel or Railway platform security incident
      - Any MongoDB Atlas vulnerability
      - Any Solana protocol security issue
      - Any reported AI agent manipulation or prompt injection
        attack in production systems
      - Any EU fintech or stablecoin platform breach
      - Zero-day vulnerabilities in our stack dependencies
      - Any new LLM jailbreak technique that bypasses safety
        measures in production AI agents`,
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
    domain: `Weekly security training briefing for aeda's
      Security Officer. Research the following domains and
      provide a structured intelligence update.

      OWASP & APPLICATION SECURITY:
      - OWASP Top 10 Web (owasp.org/Top10) — any updates,
        new techniques for injection, broken auth, XSS,
        insecure design, security misconfiguration
      - OWASP API Security Top 10 — API-specific vulnerabilities
        critical for aeda's REST API surface
      - OWASP LLM Top 10 — AI-specific security for our
        14-agent workspace (prompt injection, training data
        poisoning, insecure output handling, model DoS)

      ZERO TRUST & INFRASTRUCTURE:
      - Zero Trust architecture developments — new frameworks,
        NIST guidance updates, practical implementation patterns
      - Identity and Access Management (IAM) best practices —
        session management, token security, OAuth2 updates
      - Secrets management — HashiCorp Vault updates,
        environment variable security patterns for Vercel/Railway
      - Container/serverless security — Vercel Edge security,
        Railway container hardening techniques

      CRYPTO & WALLET SECURITY:
      - Non-custodial wallet attack vectors — phishing campaigns
        targeting EURC/stablecoin wallets, private key exposure
        techniques, social engineering patterns
      - Solana ecosystem security incidents — smart contract
        vulnerabilities, RPC endpoint attacks, validator issues
      - Hardware Security Module (HSM) and key management
        best practices for non-custodial architecture
      - EURC/stablecoin specific security — Circle audit reports,
        bridge protocol vulnerabilities

      AI AGENT & WORKSPACE SECURITY:
      - Prompt injection attack research — new techniques,
        real-world exploits against production AI systems
      - Agent manipulation — multi-agent attack vectors,
        context poisoning, instruction hijacking
      - LLM data exfiltration — techniques attackers use to
        extract sensitive context from AI agents
      - Anthropic Claude API security best practices —
        system prompt protection, context window security
      - MCP (Model Context Protocol) security — new attack
        surfaces as MCP adoption grows

      INCIDENT RESPONSE & THREAT INTELLIGENCE:
      - Recent fintech security incidents this week —
        any breaches at payment companies, crypto platforms,
        EU financial services
      - New ransomware targeting financial infrastructure
      - DDoS patterns targeting financial APIs
      - Social engineering campaigns targeting fintech founders
        and startup teams (SIM swapping, business email compromise)

      COMPLIANCE SECURITY (MiCA/GDPR intersection):
      - GDPR security breach notifications — any EU financial
        company reporting incidents (learning opportunity)
      - MiCA operational resilience requirements —
        DORA technical standards updates for ICT security
      - EBA ICT Risk framework updates
      - Czech NBÚ (cybersecurity authority) advisories

      FORMAT: Provide a structured weekly security briefing
      with clear sections. Each finding must include:
      severity (Critical/High/Medium/Low), source URL,
      and a concrete recommendation for aeda's specific stack.`,
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

// ─── Signal Scoring + @chris Strategic Filter ───────────────────────────────

async function scoreSignal(signal: {
  title: string;
  summary: string;
  category: string;
  sourceUrl: string;
  trustLevel: string;
  verificationStatus: string;
}): Promise<{
  signalScore: number;
  noiseFlag: boolean;
  strategicImplication: string;
  actionRequired: boolean;
  arturAction: string;
}> {
  // Source gate: regulation/partner without official URL = noise
  const regulatoryCategories = ['regulation', 'partner'];
  if (
    regulatoryCategories.includes(signal.category) &&
    (!signal.sourceUrl || signal.sourceUrl.trim() === '') &&
    signal.trustLevel !== 'verified'
  ) {
    return {
      signalScore: 2,
      noiseFlag: true,
      strategicImplication: 'No official source — cannot verify regulatory claim.',
      actionRequired: false,
      arturAction: '',
    };
  }

  const SCORING_SYSTEM = `You are a signal analyst for aeda, a non-custodial EURC stablecoin wallet building the EU-Armenia payment corridor.
Score intelligence signals 1-10 for aeda relevance.
Return ONLY valid JSON: {"score": N} where N is 1-10.
No other text. No markdown.`;

  try {
    const scoreResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: SCORING_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `SCORING RUBRIC:
10 = Legislative deadline affecting aeda THIS WEEK
9  = Regulatory change directly affecting EURC/non-custodial wallets
8  = Partner (Bridge, Sky Labs, Sumsub, Circle) product change
7  = Competitor major move affecting Armenia corridor
6  = Market signal changing fundraising narrative
5  = Confirmed news, indirect but relevant to aeda
4  = Useful background context
3  = Unverified or low-confidence signal
2  = Duplicate or near-duplicate of existing knowledge
1  = General industry noise, no aeda relevance

Score this signal:
Title: ${signal.title}
Category: ${signal.category}
Summary: ${signal.summary}
Source: ${signal.sourceUrl || 'none'}
Trust: ${signal.trustLevel}`,
        },
      ],
    });

    const firstBlock = scoreResponse.content[0];
    const scoreText =
      firstBlock && firstBlock.type === 'text'
        ? firstBlock.text.trim()
        : '';

    // Log raw response for debugging
    logger.info({ raw: scoreText.slice(0, 200) }, '[hasmik] raw score response');

    // Parse JSON safely - never fallback to default score
    let parsed: { score?: unknown };
    try {
      parsed = JSON.parse(scoreText.replace(/```json\n?|```/g, '').trim());
    } catch (parseErr) {
      logger.error({ parseErr, raw: scoreText.slice(0, 100) }, '[hasmik] score JSON parse failed, skipping entry');
      throw new Error('score_parse_failed');
    }

    const signalScore = Number(parsed.score);
    if (isNaN(signalScore) || signalScore < 1 || signalScore > 10) {
      logger.warn({ raw: scoreText.slice(0, 100), parsedScore: parsed.score }, '[hasmik] invalid score value, skipping entry');
      throw new Error('invalid_score_value');
    }

    const noiseFlag = signalScore <= 3;

    // If score >= 5, run @chris strategic filter
    if (signalScore >= 5) {
      const CHRIS_SYSTEM = `You are @chris, Strategic Advisor at aeda.
aeda is raising $500K pre-seed at $5M valuation. Q3 2026 launch.
Your job: assess if this signal is actionable for fundraise or launch.

Respond with ONLY valid JSON:
{
  "strategicImplication": "<1-2 sentences: why this matters for aeda's $500K raise or Q3 launch>",
  "actionRequired": <true/false>,
  "arturAction": "<concrete next step for @artur, or empty string if none>"
}`;

      try {
        const chrisResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: CHRIS_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Assess this signal (score: ${signalScore}/10):\n\nTitle: ${signal.title}\nCategory: ${signal.category}\nSummary: ${signal.summary}`,
            },
          ],
        });

        const chrisBlock = chrisResponse.content[0];
        const chrisText =
          chrisBlock && chrisBlock.type === 'text'
            ? chrisBlock.text
            : '';
        const chrisJson = JSON.parse(chrisText.replace(/```json\n?|```/g, '').trim());

        return {
          signalScore,
          noiseFlag,
          strategicImplication: chrisJson.strategicImplication || '',
          actionRequired: chrisJson.actionRequired === true,
          arturAction: chrisJson.arturAction || '',
        };
      } catch (chrisErr) {
        logger.warn({ err: chrisErr }, '[hasmik] @chris filter failed, using score only');
        return {
          signalScore,
          noiseFlag,
          strategicImplication: '',
          actionRequired: false,
          arturAction: '',
        };
      }
    }

    return {
      signalScore,
      noiseFlag,
      strategicImplication: '',
      actionRequired: false,
      arturAction: '',
    };
  } catch (err) {
    // Re-throw to skip this entry entirely - never write a fallback score
    logger.warn({ err }, '[hasmik] signal scoring failed, entry will be skipped');
    throw err;
  }
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
  skipScoring?: boolean;
}): Promise<void> {
  const { signal, category, scope, relevantAgents, targetAgent, expiresInDays } = opts;

  // Score the signal unless skipped
  let scoring = {
    signalScore: 5,
    noiseFlag: false,
    strategicImplication: '',
    actionRequired: false,
    arturAction: '',
  };

  if (!opts.skipScoring) {
    scoring = await scoreSignal({
      title: signal.title,
      summary: signal.summary,
      category,
      sourceUrl: signal.sourceUrl,
      trustLevel: signal.trustLevel,
      verificationStatus: signal.verificationStatus,
    });
    logger.info(
      { title: signal.title.slice(0, 50), score: scoring.signalScore, noise: scoring.noiseFlag },
      '[hasmik] signal scored'
    );
  }

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
    signalScore: scoring.signalScore,
    noiseFlag: scoring.noiseFlag,
    strategicImplication: scoring.strategicImplication,
    actionRequired: scoring.actionRequired,
    arturAction: scoring.arturAction,
    scoredAt: new Date(),
  });
  await doc.save();
}

// ─── Fundraising Research ────────────────────────────────────────────────────

async function runFundraisingResearch(weekOf: Date): Promise<void> {
  logger.info('[hasmik] phase 3: fundraising intelligence');

  const FUNDRAISING_SYSTEM = `You are @hasmik, Research & Intelligence Agent at aeda.
aeda is a pre-seed non-custodial EURC stablecoin wallet
(EU-Armenia corridor, Prague, Czech Republic).
Raising $500K at $5M pre-money valuation.

Your job: find genuine fundraising news from the LAST 30 DAYS.

RELEVANT CATEGORIES for aeda:
stablecoins, cross-border payments, embedded wallets,
wallet infrastructure, BaaS, compliance/KYC, crypto infrastructure,
AI+payments, remittances, Solana ecosystem, fintech.

WHAT TO SEARCH FOR:
1. Fintech, stablecoin, crypto wallet startups that raised funding
   (pre-seed, seed, Series A, Series B, Series C) in last 30 days
2. Open accelerator programs, grants, ecosystem funds
   that aeda could apply to

aeda profile for eligibility assessment:
- Pre-seed stage, $500K target, $5M pre-money
- EU registered (Czech Republic), operating Armenia corridor
- Non-custodial EURC wallet (NOT a payment institution)
- Stack: Solana, NestJS, Flutter
- Partners: Bridge.xyz, Sky Labs, Sumsub
- MiCA compliant technology network

SOURCES TO CHECK:
Raises: TechCrunch, The Block, Fortune Crypto, Crunchbase News,
        EU-Startups, Sifted, CoinDesk, Decrypt

Opportunities: F6S, Seedstars, Solana Foundation grants,
               Circle grants, Techstars, Y Combinator`;

  // Step 1: Research
  let researchText = "";
  try {
    const res1 = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: FUNDRAISING_SYSTEM,
      tools: [{
        type: 'web_search_20250305' as const,
        name: 'web_search' as const,
        max_uses: 5,
      }],
      messages: [{
        role: 'user',
        content: `Search for RECENT fintech and crypto fundraising news:

1. Find 5-10 fintech, stablecoin, or crypto wallet startups that
   raised funding in the LAST 30 DAYS. Include: company name,
   amount raised, round type (pre-seed/seed/Series A/B/C),
   lead investors, headquarters, what they do, source URL.

2. Find 3-5 accelerator programs, grants, or funding opportunities
   currently accepting applications that a pre-seed EU stablecoin
   wallet startup could apply to. Include: program name, funding
   amount, deadline, eligibility, application URL.

Be thorough. List everything you find with source URLs.`,
      }],
    });
    researchText = res1.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n').trim();
  } catch (err) {
    logger.error({ err }, '[hasmik] fundraising research step 1 failed');
    return;
  }

  logger.info(
    { researchTextLen: researchText.length, preview: researchText.slice(0, 300) },
    '[hasmik] phase3 research text received'
  );

  if (!researchText || researchText.length < 100) {
    logger.info('[hasmik] no fundraising content found this week');
    return;
  }

  // Step 2: Structure
  let structured: {
    rounds: Array<{
      companyName: string;
      companyUrl: string;
      headquarters: string;
      category: string;
      description: string;
      amount: number;
      currency: string;
      roundType: string;
      announcedDate: string;
      valuation: number;
      investors: Array<{
        name: string;
        firm: string;
        website: string;
        geography: string;
        stagePreference: string;
        checkSize: string;
      }>;
      relevanceToAeda: string;
      sourceUrl: string;
    }>;
    opportunities: Array<{
      programName: string;
      type: string;
      provider: string;
      description: string;
      fundingAmount: string;
      deadline: string;
      applicationUrl: string;
      website: string;
      geography: string | string[];
      stageRequirements: string;
      isAedaEligible: boolean;
      eligibilityReasoning: string;
      recommendedAction: string;
      priority: string;
      sourceUrl: string;
    }>;
  } = { rounds: [], opportunities: [] };

  try {
    const res2 = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: `You are a structured data extractor. Return ONLY valid JSON. No markdown, no explanation, no backticks.
eligibilityReasoning and recommendedAction are REQUIRED fields for opportunities. Never leave them empty. If unsure about eligibility, explain why.`,
      messages: [{
        role: 'user',
        content: `Extract all fundraising rounds and opportunities from this research.
Return JSON with this exact structure:
{
  "rounds": [
    {
      "companyName": "Company Name",
      "amount": 5000000,
      "currency": "USD",
      "roundType": "seed",
      "headquarters": "City, Country",
      "description": "What they do",
      "investors": [{"firm": "Investor Name"}],
      "sourceUrl": "https://..."
    }
  ],
  "opportunities": [
    {
      "programName": "Full program name",
      "type": "accelerator | grant | competition | government",
      "provider": "Organisation name",
      "description": "2-3 sentences on what it offers",
      "fundingAmount": "€50K or equity-free etc",
      "deadline": "Month Year or Rolling",
      "applicationUrl": "https://direct-application-url.com",
      "geography": "EU / Global / Eastern Europe etc",
      "stageRequirements": "Pre-seed / Seed / Any",
      "isAedaEligible": true,
      "eligibilityReasoning": "REQUIRED: 1-2 sentences explaining WHY aeda qualifies or does not qualify. aeda is a non-custodial EURC stablecoin wallet for EU-Armenia corridor, Prague entity (VanCoin LLC), pre-seed stage, raising €500K. Be specific.",
      "recommendedAction": "REQUIRED: one concrete action e.g. Apply before [date], Register interest now, Watch for next cohort, Skip — not relevant",
      "priority": "High | Medium | Low"
    }
  ]
}

If no raises found, return {"rounds":[],"opportunities":[]}.
Extract EVERY raise and opportunity mentioned. Do not skip any.

Research text:
${researchText}`,
      }],
    });

    const raw = res2.content[0]?.type === 'text'
      ? res2.content[0].text.trim() : '';

    logger.info({ rawLen: raw.length, preview: raw.slice(0, 500) }, '[hasmik] phase3 raw LLM output');

    // Brace matching JSON extraction
    const start = raw.indexOf('{');
    if (start !== -1) {
      let depth = 0, end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) {
        structured = JSON.parse(raw.slice(start, end + 1));
        logger.info(
          { roundsCount: structured.rounds?.length ?? 0, oppsCount: structured.opportunities?.length ?? 0 },
          '[hasmik] phase3 parsed JSON'
        );
      } else {
        logger.warn('[hasmik] phase3 WARNING: could not find matching closing brace');
      }
    } else {
      logger.warn('[hasmik] phase3 WARNING: no opening brace found in LLM output');
    }
  } catch (err) {
    logger.error({ err }, '[hasmik] fundraising structure step failed');
    return;
  }

  // Log if nothing to write
  if (!structured.rounds || structured.rounds.length === 0) {
    logger.warn({ rawPreview: researchText.slice(0, 200) }, '[hasmik] phase3 WARNING: LLM returned no rounds');
  }
  if (!structured.opportunities || structured.opportunities.length === 0) {
    logger.warn('[hasmik] phase3 WARNING: LLM returned no opportunities');
  }

  // Log model availability
  logger.info(
    { FundraisingRoundModel: !!FundraisingRoundModel, FundingOpportunityModel: !!FundingOpportunityModel },
    '[hasmik] models loaded'
  );

  // Log rounds to write
  logger.info(
    { count: structured.rounds?.length ?? 0, rounds: JSON.stringify(structured.rounds ?? []).slice(0, 500) },
    '[hasmik] phase3 rounds to write'
  );

  // Save rounds
  let savedRounds = 0;
  for (const round of (structured.rounds ?? [])) {
    try {
      if (!round.companyName) {
        logger.warn({ round }, '[hasmik] skipping round without companyName');
        continue;
      }
      const doc = new FundraisingRoundModel({
        ...round,
        weekOf,
        addedBy: 'hasmik',
      });
      await doc.save();
      savedRounds++;
      logger.info({ company: round.companyName }, '[hasmik] saved round');
    } catch (err) {
      logger.error({ err, company: round.companyName },
        '[hasmik] failed to save round');
    }
  }

  // Log opps to write
  logger.info(
    { count: structured.opportunities?.length ?? 0, opps: JSON.stringify(structured.opportunities ?? []).slice(0, 500) },
    '[hasmik] phase3 opps to write'
  );

  // Save opportunities
  let savedOpps = 0;
  for (const opp of (structured.opportunities ?? [])) {
    try {
      if (!opp.programName) {
        logger.warn({ opp }, '[hasmik] skipping opportunity without programName');
        continue;
      }
      // Check if already exists (avoid duplicates)
      const exists = await (FundingOpportunityModel as mongoose.Model<unknown>).findOne({
        programName: opp.programName,
        status: 'open',
      }).exec();
      if (!exists) {
        const doc = new FundingOpportunityModel({
          ...opp,
          weekOf,
          addedBy: 'hasmik',
          status: 'open',
        });
        await doc.save();
        savedOpps++;
        logger.info({ program: opp.programName }, '[hasmik] saved opportunity');
      } else {
        logger.info({ program: opp.programName }, '[hasmik] opportunity already exists, skipping');
      }
    } catch (err) {
      logger.error({ err, program: opp.programName },
        '[hasmik] failed to save opportunity');
    }
  }

  logger.info(
    { savedRounds, savedOpps },
    '[hasmik] Phase 3 complete'
  );
}

// ─── Phase 4A: Score unscored entries ────────────────────────────────────────

async function scoreUnscoredEntries(): Promise<{ scoredCount: number; highScoreCount: number }> {
  logger.info('[hasmik] phase 4a: scoring unscored entries');

  // Find all entries with null signalScore
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unscoredEntries: any[] = await (KnowledgeEntryModel as any).find({
    status: 'active',
    addedBy: 'hasmik',
    $or: [
      { signalScore: null },
      { signalScore: { $exists: false } },
    ],
  })
    .limit(100) // Process in batches to avoid timeout
    .exec();

  if (unscoredEntries.length === 0) {
    logger.info('[hasmik] phase 4a: no unscored entries found');
    return { scoredCount: 0, highScoreCount: 0 };
  }

  logger.info({ count: unscoredEntries.length }, '[hasmik] phase 4a: found unscored entries');

  let scoredCount = 0;
  let highScoreCount = 0;

  for (const entry of unscoredEntries) {
    try {
      const scoring = await scoreSignal({
        title: entry.title || '',
        summary: entry.summary || '',
        category: entry.category || 'general',
        sourceUrl: entry.source || '',
        trustLevel: entry.trustLevel || 'signal',
        verificationStatus: entry.verificationStatus || 'unverifiable',
      });

      // Validate score
      const score = scoring.signalScore;
      if (typeof score !== 'number' || isNaN(score) || score < 1 || score > 10) {
        logger.warn({ entryId: entry._id, rawScore: score }, '[hasmik] invalid score, skipping');
        continue;
      }

      // Update the entry with $set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (KnowledgeEntryModel as any).findByIdAndUpdate(entry._id, {
        $set: {
          signalScore: score,
          noiseFlag: scoring.noiseFlag,
          strategicImplication: scoring.strategicImplication,
          actionRequired: scoring.actionRequired,
          arturAction: scoring.arturAction,
          scoredAt: new Date(),
        },
      });

      scoredCount++;
      if (score >= 6) highScoreCount++;

      logger.info(
        { entryId: entry._id, title: entry.title?.slice(0, 40), score },
        '[hasmik] entry scored'
      );

      // Rate limit protection
      await sleep(500);
    } catch (err) {
      logger.error({ err, entryId: entry._id }, '[hasmik] failed to score entry');
    }
  }

  logger.info(
    { scoredCount, highScoreCount },
    '[hasmik] phase 4a complete: scored entries'
  );

  return { scoredCount, highScoreCount };
}

// ─── Phase 4B: @chris Weekly Board Brief ─────────────────────────────────────

async function generateWeeklyBoardBrief(): Promise<void> {
  logger.info('[hasmik] phase 4b: generating @chris weekly board brief');

  // Get this week's high-score signals (score >= 6)
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const highSignals: any[] = await (KnowledgeEntryModel as any).find({
    status: 'active',
    addedBy: 'hasmik',
    signalScore: { $gte: 6 },
    createdAt: { $gte: oneWeekAgo },
  })
    .sort({ signalScore: -1, createdAt: -1 })
    .limit(20)
    .exec();

  if (highSignals.length === 0) {
    logger.info('[hasmik] phase 4b: no high-score signals (score >= 6) this week, skipping board brief');
    return;
  }

  logger.info(
    { highSignalCount: highSignals.length },
    '[hasmik] phase 4b: found high-score signals for board brief'
  );

  const signalSummaries = highSignals.map((s: any, i: number) =>
    `${i + 1}. [Score ${s.signalScore}] ${s.title}\n   ${s.summary}\n   Strategic: ${s.strategicImplication || 'N/A'}`
  ).join('\n\n');

  const CHRIS_BRIEF_SYSTEM = `You are @chris, Strategic Advisor at aeda.
aeda is a pre-seed non-custodial EURC stablecoin wallet (EU-Armenia corridor, Prague).
Raising $500K at $5M pre-money. Q3 2026 launch target.

Your job: produce a concise 1-page board brief from this week's intelligence signals.

FORMAT (strict):
# AEDA WEEKLY INTELLIGENCE BRIEF
Week of [date]

## TOP 5 SIGNALS (ranked by importance)
For each:
- **[Signal title]** (Score: X/10)
  - What happened: [1 sentence]
  - Why it matters for aeda: [1-2 sentences, specific to $500K raise or Q3 launch]
  - Recommended action: [concrete step for @artur, or "Monitor"]

## RECOMMENDED @ARTUR ACTIONS THIS WEEK
[Numbered list of 3-5 specific actions derived from signals]

## WHAT I'D CHALLENGE THIS WEEK
[1 contrarian take — something everyone assumes that might be wrong,
 or a risk nobody's discussing, or an opportunity being overlooked]

Keep it sharp. No filler. CEOs read fast.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: CHRIS_BRIEF_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Generate the weekly board brief from these ${highSignals.length} high-priority signals:\n\n${signalSummaries}`,
        },
      ],
    });

    const briefBlock = response.content[0];
    const briefContent =
      briefBlock && briefBlock.type === 'text' ? briefBlock.text : '';

    if (!briefContent) {
      logger.warn('[hasmik] phase 4: @chris returned empty brief');
      return;
    }

    // Save to @artur's inbox as weekly-clevel-brief
    const weekOf = new Date().toISOString().slice(0, 10);
    const messageId = `weekly-clevel-brief-${weekOf}`;

    await InboxItem.findOneAndUpdate(
      { message_id: messageId },
      {
        $set: {
          recipient: 'artur',
          sender_email: 'chris@aeda.internal',
          sender_name: '@chris (Strategic Advisor)',
          subject: `Weekly Board Brief — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
          body_text: briefContent,
          body_sanitized: briefContent,
          agent_commentary: `Weekly intelligence brief synthesized by @chris from ${highSignals.length} high-priority signals (score ≥6).`,
          received_at: new Date(),
          message_id: messageId,
          processing_status: 'draft_created',
          routing: {
            artur_classification: 'weekly-clevel-brief',
            routed_to_agent: 'artur',
            artur_brief: 'Weekly board brief from @chris — review top signals and recommended actions.',
            lilit_task_id: null,
          },
          crm_match: { matched: false, investor_id: null, investor_name: null, matched_on: null },
        },
      },
      { upsert: true }
    );

    logger.info(
      { signalCount: highSignals.length },
      '[hasmik] phase 4b: Board brief written to @artur inbox'
    );
  } catch (err) {
    logger.error({ err }, '[hasmik] phase 4: @chris brief generation failed');
  }
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

    // ── PHASE 3: Fundraising Intelligence ────────────────
    try {
      const weekOf = new Date();
      await runFundraisingResearch(weekOf);
    } catch (err) {
      logger.error({ err }, '[hasmik] phase 3 fundraising failed');
    }

    // ── PHASE 4A: Score unscored entries ────────────────
    try {
      const { scoredCount, highScoreCount } = await scoreUnscoredEntries();
      logger.info(
        { scoredCount, highScoreCount },
        '[hasmik] Phase 4A complete'
      );
    } catch (err) {
      logger.error({ err }, '[hasmik] phase 4a scoring failed');
    }

    // ── PHASE 4B: @chris Weekly Board Brief ────────────────
    try {
      await generateWeeklyBoardBrief();
    } catch (err) {
      logger.error({ err }, '[hasmik] phase 4b board brief failed');
    }

    logger.info(
      { totalSignals, domains: ORG_DOMAINS.length + AGENT_DOMAINS.length },
      '[hasmik] weekly intelligence job complete'
    );
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  // Monday 19:00 Prague time — requires TZ=Europe/Prague in Railway env vars
  await agenda.every('0 19 * * 1', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('[hasmik] weekly intelligence job scheduled — Monday 19:00 Prague');
}
