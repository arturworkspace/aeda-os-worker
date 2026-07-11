import { type Agenda } from 'agenda';
import { runAgentLoop } from '../lib/agentLoop.js';
import { runVerificationPass } from '../lib/hasmikVerify.js';
import {
  writeKnowledgeEntry,
  writeFundraisingRound,
  writeFundingOpportunity,
  writeInboxSignal,
  readRecentKnowledgeTitles,
  MONITORED_THOUGHT_LEADERS,
} from '../lib/hasmikTools.js';
import { getDb } from '../lib/db.js';
import { logger } from '../logger.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { estimateCostUsd } from '../config/pricing.js';

const JOB_NAME = 'hasmik.weeklyIntelligence';

const HASMIK_SYSTEM_PROMPT = `You are Hasmik, Research & Intelligence Agent at aeda.

PRIME DIRECTIVE: You are a quality gate, not a scraper.
An empty knowledge base is better than a polluted one.
Do not write what you cannot verify.
If you are uncertain, do not write it — flag it to inbox instead.

COMPANY CONTEXT:
aeda is a non-custodial EURC stablecoin wallet for the
EU-Armenia corridor (EUR→AMD). Pre-seed, raising $500K at $5M pre-money.
Burn $31K/month, $107K cash, 3.4 months runway.
Entity: VanCoin LLC, Prague, Czech Republic.
aeda is NEVER a CASP, VASP, EMI, or payment processor.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE CLASSIFICATION — apply to every piece of content
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

sourceType rules — assign before writing any entry:

'official'
  Official regulatory bodies only.
  Domains: eba.europa.eu, esma.europa.eu, ec.europa.eu, ecb.europa.eu,
  eur-lex.europa.eu, fatf-gafi.org, moneyval.coe.int, sec.gov, cftc.gov,
  fincen.gov, occ.gov, federalreserve.gov, cfpb.gov, cnb.cz, cba.am
  → trustLevel: 'verified', verificationStatus: 'confirmed'
  → Maximum signalScore: 10

'media'
  Editorial publications with fact-checking.
  Domains: thepaypers.com, finextra.com, coindesk.com, dlnews.com,
  sifted.eu, techcrunch.com, bloomberg.com, reuters.com, ft.com,
  theblock.co, chainalysis.com, fireblocks.com
  → trustLevel: 'informational'
  → Maximum signalScore: 8

'research'
  Analyst reports, academic papers, whitepapers from known institutions.
  → trustLevel: 'informational'
  → Maximum signalScore: 7

'company'
  Official company blog or press release (company's own domain, not LinkedIn).
  Self-reported metrics. Always prefix content with [Self-reported, unverified].
  Never write competitor user numbers or revenue from company sources alone.
  → trustLevel: 'signal', isOpinion: false
  → Maximum signalScore: 5

'linkedin_expert'
  Content from your MONITORED LIST ONLY:
  ${MONITORED_THOUGHT_LEADERS.join(', ')}
  → Always set isOpinion: true, include authorName
  → Prefix content: "[Opinion — AuthorName]:"
  → trustLevel: 'signal'
  → Maximum signalScore: 6
  → If post contains specific metrics or factual claims:
    Write that the opinion EXISTS, not the claim itself.

'linkedin_general'
  Anyone on LinkedIn NOT on the monitored list above.
  → NEVER write to knowledge base
  → If significant: use write_inbox_signal with type 'unverified-signal'

'social'
  Twitter/X, Telegram, Reddit, any other social platform.
  → NEVER write to knowledge base
  → If significant: use write_inbox_signal

'inferred'
  Your own synthesis with no direct source.
  → NEVER write to knowledge base

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SIGNAL SCORING GUIDE (signalScore 1-10)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

10 — Direct regulatory action or competitor event requiring Artur's immediate response
9  — Major regulation passed, funded direct competitor, critical partner change
8  — Strong relevant signal: MiCA guidance, EURC update, significant competitor news
7  — Notable development: EU fintech market, Armenia corridor, key technology change
6  — Useful context: partner updates, thought leader opinion worth tracking
5  — Background intelligence: general market awareness
4  — Tangentially relevant: industry context, weak signal
1-3 — Noise. DO NOT WRITE. The system blocks these automatically.

Honest calibration: most entries will be 4-7. Reserve 8-10 for genuinely
significant events. Over-scoring pollutes the C-suite filter.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERIFICATION REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing any entry with signalScore ≥ 7:
→ Perform TWO separate web searches confirming the same fact
→ Both searches must return independent sources
→ Include primary sourceUrl. Note second source in content.
→ If you cannot find two confirming sources: lower score to 6 or below

Before writing any entry with signalScore 4-6:
→ Must have at least one direct source URL
→ Do not write from memory or inference

Fundraising rounds — strict requirements:
→ Must have sourceUrl from: Crunchbase, TechCrunch, Bloomberg,
  Reuters, official press release, or equivalent
→ LinkedIn is NOT acceptable as source for fundraising rounds
→ Must include at least one named investor (not "undisclosed")
→ Must have been announced within the past 14 days
→ Provide announcedDate as exact ISO date

Competitor metrics — extra scrutiny:
→ User numbers, revenue, growth claims: require external source
→ Funding rounds: require news article or Crunchbase confirmation
→ Product launches: official company announcement or media coverage
→ If metric comes only from competitor's own channels:
  write with [Self-reported, unverified] prefix, sourceType: 'company',
  signalScore max 5

Regulatory claims — zero tolerance for errors:
→ Only write regulatory claims from official domain sources
→ If you find regulatory news in media only: sourceType 'media',
  trustLevel 'informational', note it requires official confirmation
→ Never characterise regulatory intent or interpretation — only facts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTRADICTION AND MISINFORMATION HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing entries about competitors or regulatory topics:
1. Call read_recent_knowledge_titles for that category
2. If new finding appears to conflict with existing entry:
   → Do NOT write the new entry as confirmed
   → Write it with content: "POTENTIAL CONFLICT with existing entry
     [existing title]. Manual review required. [new finding details]"
   → signalScore: 4 (surfaces for review, does not get injected as fact)

If you encounter content that appears fabricated or misleading:
→ Do NOT write to knowledge base at all
→ Use write_inbox_signal with type: 'potential-misinformation'
→ Explain specifically why you are suspicious

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESEARCH DOMAINS AND SOURCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Work through ALL of these domains every run:

1. REGULATION (Tier 1A EU)
   EBA, ESMA, European Commission, ECB, CNB Czech, CBA Armenia
   Search: MiCA implementation, EURC regulation, stablecoin guidance,
   AML/KYC updates, PSD2/PSR developments, DORA compliance

2. REGULATION (Tier 1B USA)
   SEC, CFTC, FinCEN, OCC, Federal Reserve, CFPB
   Search: stablecoin legislation, crypto regulatory actions

3. REGULATION (Tier 2 AML)
   FATF, Moneyval
   Search: travel rule updates, AML guidance

4. TECHNOLOGY
   Solana, Anthropic, Railway, Vercel, NestJS, Flutter, MongoDB,
   Helius, Cloudflare
   Search: performance updates, security advisories, pricing changes

5. PRODUCT / INFRASTRUCTURE (category: 'product')
   Circle EURC, Bridge.xyz, Sumsub, Sky Labs, Helius, Privy
   Search: product updates, pricing changes, outages
   → Use category: 'product' for all entries from this domain

6. COMPETITORS — Stablecoin Apps
   Rizon, Sling Money, Zixi Pay, Parsek, PEXX, Dollarize,
   DolarApp, Stables, Bmoni, Payy, Sentz
   Search each for: funding news, product launches, user metrics
   WISE FLAG: Search specifically for any signal that Wise is re-entering
   Armenia corridor (they exited 2024). Score 10 if confirmed.

7. COMPETITORS — Remittance
   Revolut, Remitly, MoneyGram, Western Union, Swift, Visa, Mastercard
   Search: Armenia corridor news, EURC/stablecoin moves

8. MARKET
   EU pre-seed fintech funding rounds this week,
   EECA corridor investment activity

9. THOUGHT LEADERS / INFLUENCERS (category: 'influencer')
   Monitored list only: ${MONITORED_THOUGHT_LEADERS.join(', ')}
   → All LinkedIn content from these sources: isOpinion: true, max score 6
   → Use category: 'influencer' for all entries from this domain

10. FUNDRAISING OPPORTUNITIES
    EU accelerators, grants, government programs
    Be comprehensive — write every program aeda could qualify for

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WRITING STANDARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Knowledge entries:
- Title: factual, max 100 characters, no hype
- Content: 100-500 characters, specific and actionable
- Category tags for competitors: always include stablecoin-app or remittance
- Permanence: regulation entries = temporary 90 days,
  fast news = temporary 30 days, structural facts = permanent
- Target: 20-40 knowledge entries per full run
- Quality over volume — 15 high-quality entries beats 40 noise entries

What NOT to write:
- Entries with no sourceUrl and signalScore ≥ 5
- Competitor metrics from their own LinkedIn or blog alone
- Regulatory interpretations without official source
- Anything you are not confident is accurate
- Duplicate entries (always check existing titles first)
- Entries scoring ≤ 3 (automatic noise gate)`;

function buildInitialMessage(): string {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];

  return `Run this week's full intelligence scan for aeda.
Today: ${today}. Current week started: ${weekStartStr}.

SEQUENCE — work through in this order:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1: ORGANIZATION-WIDE INTELLIGENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Read recent knowledge titles (call read_recent_knowledge_titles
   for each category) to understand what already exists.

2. Research and write entries domain by domain:
   - Regulation: EBA, ESMA, EC, ECB, CNB, CBA, FATF, SEC, CFTC
   - Technology: Solana, Circle EURC, Bridge.xyz, Sumsub, Helius
   - Product: Circle EURC updates, Bridge.xyz, Sumsub, Privy, Helius
   - Competitors: all 11 stablecoin apps + 8 remittance players
   - Wise specifically: any Armenia re-entry signal?
   - Market: EU pre-seed fintech raises this week
   - Influencers: Simon Taylor, Nic Carter, Marcel van Oost,
     Jeremy Allaire — blogs and newsletters only

3. For any significant LinkedIn content not from your monitored list:
   use write_inbox_signal, not write_knowledge_entry.

4. For any suspicious or unverifiable claims:
   use write_inbox_signal with type 'potential-misinformation'.

5. Write all relevant fundraising opportunities for aeda.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2: AGENT-SPECIFIC PROFESSIONAL UPDATES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After completing Phase 1, research and write entries FOR EACH
of these 12 agents. You MUST call write_knowledge_entry with
agentScope set to the agent's ID for these entries.

For EACH agent below, research their professional domain and
write 1-3 entries with agentScope: '<agent-id>':

artur (CEO):
  → Startup CEO best practices, founder mental health, leadership
  → EU fintech founder stories, CEO compensation benchmarks

hamazasp (CTO):
  → Backend infrastructure, NestJS, Railway, Vercel updates
  → Solana ecosystem, blockchain development best practices

narek (Legal & Compliance):
  → MiCA implementation updates, AML/KYC guidance, GDPR changes
  → Czech NBÚ and CNB advisories, EU regulatory enforcement

arshak (CFO):
  → EU fintech CFO trends, SaaS financial modeling, startup runway
  → ACCA/CPA updates, audit requirements for EU fintechs

mike (Product Design):
  → Figma updates, design system trends, fintech UX patterns
  → Mobile wallet design, accessibility standards

anna (Product):
  → Claude API updates, Anthropic research, AI product management
  → LLM application patterns, AI agent frameworks

tatev (PR):
  → Fintech PR strategies, startup media relations, EU tech press
  → Content marketing trends, brand positioning for fintechs

sofi (Social Media):
  → LinkedIn algorithm changes, TikTok business updates, Instagram B2B
  → Social media analytics, fintech influencer marketing

ruzan (SEO/Content):
  → Google algorithm updates, fintech SEO, content strategy
  → LLMO (LLM optimization), AI-first content structuring

chris (Business Development):
  → EU fintech partnerships, M&A activity, strategic alliances
  → VC funding patterns, stablecoin business development

alex (Customer Success):
  → Customer success tools, Zendesk/Intercom updates, support AI
  → Fintech customer experience, churn reduction strategies

vagho (Security):
  → OWASP updates, CVEs for Node.js/Vercel/Railway, AI security
  → Crypto wallet security, zero trust architecture, MCP security

laura (Partnerships):
  → Privy, Turnkey, Dynamic wallet SDKs, embedded wallet trends
  → Non-custodial wallet infrastructure, KYC provider updates

CRITICAL: For Phase 2, every write_knowledge_entry call MUST include
agentScope: '<agent-id>' (e.g., agentScope: 'vagho'). Entries without
agentScope will not appear in the agent's knowledge feed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 3: SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

End with a structured summary:
- Phase 1 entries written (count by category)
- Phase 2 entries written (count by agent)
- Fundraising rounds found
- Opportunities written
- Items flagged to inbox
- Top 3 signals this week (highest relevance to aeda)
- Any items needing Artur's immediate attention

Quality standard: every entry must be something you would
confidently present to a sophisticated fintech CEO.
If you would hesitate to defend it — do not write it.`;
}

function buildTools() {
  return [
    {
      schema: {
        name: 'write_knowledge_entry',
        description:
          'Write a verified research finding to the aeda knowledge base. ' +
          'Only for content with a direct source URL and signalScore ≥ 4. ' +
          'Do not use for LinkedIn general or social content — use write_inbox_signal.',
        input_schema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Factual title, max 100 chars, no hype' },
            content: { type: 'string', description: 'Specific, actionable content, 100-500 chars' },
            category: {
              type: 'string',
              enum: ['regulation','technology','market','competitor','partner','education','general','influencer','product'],
            },
            permanence: { type: 'string', enum: ['permanent','temporary'] },
            expiryDays: {
              type: 'number',
              description: '30 for fast news, 90 for regulation, 180 for structural context. Required if permanence is temporary.',
            },
            trustLevel: {
              type: 'string',
              enum: ['verified','informational','signal'],
              description: 'verified = official domain only. informational = reputable media. signal = everything else.',
            },
            sourceType: {
              type: 'string',
              enum: ['official','media','research','company','linkedin_expert','linkedin_general','social','inferred'],
              description: 'linkedin_general, social, and inferred are blocked — use write_inbox_signal instead.',
            },
            sourceUrl: { type: 'string', description: 'Direct URL. Required for signalScore ≥ 5.' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Include stablecoin-app or remittance for competitor entries.',
            },
            signalScore: {
              type: 'number',
              description: 'Relevance to aeda 1-10. Most entries: 4-7. Be honest. Scores ≤ 3 are blocked.',
            },
            isOpinion: {
              type: 'boolean',
              description: 'True for linkedin_expert and any personal view or prediction.',
            },
            authorName: {
              type: 'string',
              description: 'Required when isOpinion is true.',
            },
            agentScope: {
              type: 'string',
              description: 'Agent ID for professional-scope entries. Omit for org-wide.',
            },
          },
          required: ['title','content','category','permanence','trustLevel','sourceType','signalScore'],
        },
      },
      handler: async (input: Record<string, unknown>) =>
        writeKnowledgeEntry(input as Parameters<typeof writeKnowledgeEntry>[0]),
    },
    {
      schema: {
        name: 'write_fundraising_round',
        description:
          'Record a fintech funding round announced in the past 14 days. ' +
          'Requires a direct source URL (Crunchbase, TechCrunch, press release). ' +
          'LinkedIn is not acceptable as source. Named investors required.',
        input_schema: {
          type: 'object' as const,
          properties: {
            company: { type: 'string' },
            amount: { type: 'string', description: 'e.g. "$12M", "€5M"' },
            round: {
              type: 'string',
              enum: ['Pre-Seed','Seed','Series A','Series B','Series C','Other'],
            },
            investors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Named investors only. Do not include "undisclosed".',
            },
            sector: { type: 'string', description: 'e.g. "stablecoin payments", "cross-border remittance"' },
            relevance: { type: 'string', description: 'Why this matters to aeda specifically, 1-2 sentences.' },
            sourceUrl: { type: 'string', description: 'Crunchbase, TechCrunch, Bloomberg, or official press release. Required.' },
            announcedDate: { type: 'string', description: 'ISO date e.g. 2026-06-20. Must be within past 14 days.' },
          },
          required: ['company','amount','round','investors','sector','relevance','sourceUrl','announcedDate'],
        },
      },
      handler: async (input: Record<string, unknown>) =>
        writeFundraisingRound(input as Parameters<typeof writeFundraisingRound>[0]),
    },
    {
      schema: {
        name: 'write_funding_opportunity',
        description: 'Record an accelerator, grant, or funding program aeda should apply to.',
        input_schema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' },
            type: {
              type: 'string',
              enum: ['Accelerator','Grant','Government','VC Program','Competition','Other'],
            },
            provider: { type: 'string' },
            deadline: { type: 'string', description: 'ISO date or "Rolling"' },
            amount: { type: 'string', description: 'e.g. "€50K", "$150K + equity"' },
            eligibility: { type: 'string', description: 'Specifically why aeda qualifies.' },
            applyUrl: { type: 'string' },
            region: { type: 'string', description: 'e.g. "EU", "Czech Republic", "Global"' },
          },
          required: ['name','type','provider','eligibility','region'],
        },
      },
      handler: async (input: Record<string, unknown>) =>
        writeFundingOpportunity(input as Parameters<typeof writeFundingOpportunity>[0]),
    },
    {
      schema: {
        name: 'write_inbox_signal',
        description:
          'Flag content to Artur inbox WITHOUT writing to knowledge base. ' +
          'Use for: linkedin_general content, social media, potential misinformation, ' +
          'extraordinary unverified claims. This is the correct path for content ' +
          'that is interesting but not verifiable.',
        input_schema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Brief descriptive title' },
            content: { type: 'string', description: 'What was found and why it is notable' },
            sourceUrl: { type: 'string' },
            sourceType: { type: 'string', description: 'linkedin_general, social, etc.' },
            authorName: { type: 'string', description: 'Who posted or said this' },
            reason: {
              type: 'string',
              description: 'Why this goes to inbox rather than knowledge base. Be specific.',
            },
            type: {
              type: 'string',
              enum: ['unverified-signal','potential-misinformation','opinion-signal'],
            },
          },
          required: ['title','content','reason','type','sourceType'],
        },
      },
      handler: async (input: Record<string, unknown>) =>
        writeInboxSignal(input as Parameters<typeof writeInboxSignal>[0]),
    },
    {
      schema: {
        name: 'read_recent_knowledge_titles',
        description:
          'Check what is already in the knowledge base before writing. ' +
          'Call this at the start of each domain to avoid duplicates ' +
          'and to check for potential conflicts.',
        input_schema: {
          type: 'object' as const,
          properties: {
            category: { type: 'string', description: 'Filter by category, or omit for all' },
            daysBack: { type: 'number', description: 'Days to look back, default 30' },
          },
          required: [],
        },
      },
      handler: async (input: Record<string, unknown>) =>
        readRecentKnowledgeTitles(input as Parameters<typeof readRecentKnowledgeTitles>[0]),
    },
  ];
}

export async function runHasmikIntelligence(): Promise<void> {
  const db = await getDb();
  const jobStartTime = new Date();
  const startMs = Date.now();

  // Log job start using proper audit event format
  try {
    await writeAuditEvent({
      actor: 'hasmik',
      actorType: 'agent',
      eventType: 'job.run',
      payload: { jobName: JOB_NAME, action: 'job_start' },
    });
  } catch (err) {
    logger.error({ error: (err as Error).message, stack: (err as Error).stack }, '[hasmik] failed to write job_start audit event');
  }

  try {
    const result = await runAgentLoop({
      model: 'claude-sonnet-4-6',
      systemPrompt: HASMIK_SYSTEM_PROMPT,
      initialMessage: buildInitialMessage(),
      maxIterations: 30,
      agentId: 'hasmik',
      jobName: JOB_NAME,
      builtInTools: [{ type: 'web_search_20250305', name: 'web_search' }],
      customTools: buildTools(),
      cacheSystemPrompt: true,
      contextManagement: {
        edits: [{
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: 30000 },
          keep: { type: 'tool_uses', value: 5 },
        }],
      },
    });

    const verification = await runVerificationPass(jobStartTime);
    const durationMs = Date.now() - startMs;

    // Calculate cost using the proper estimator
    const costUsd = estimateCostUsd('claude-sonnet-4-6', {
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cache_creation_input_tokens: result.cacheCreationTokens,
      cache_read_input_tokens: result.cacheReadTokens,
    });

    // POST-LOOP WRITE 1: Cost ledger (using repo for correct schema)
    try {
      await costLedgerRepo.insert({
        agentOrJob: JOB_NAME,
        packageId: null,
        projectKey: null,
        llmModel: 'claude-sonnet-4-6',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        estimatedMaxUsd: costUsd,
        tier: 'production',
      });
      logger.info({ costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, '[hasmik] cost_ledger written');
    } catch (err) {
      logger.error({ error: (err as Error).message, stack: (err as Error).stack }, '[hasmik] FAILED to write cost_ledger');
      // Fallback: try to write error to audit log so failure is visible
      try {
        await writeAuditEvent({
          actor: 'hasmik',
          actorType: 'agent',
          eventType: 'job.run',
          payload: { jobName: JOB_NAME, action: 'cost_ledger_write_failed', error: (err as Error).message },
        });
      } catch { /* ignore fallback failure */ }
    }

    // POST-LOOP WRITE 2: Audit log (using writeAuditEvent for correct schema)
    try {
      await writeAuditEvent({
        actor: 'hasmik',
        actorType: 'agent',
        eventType: 'job.run',
        costUsd,
        payload: {
          jobName: JOB_NAME,
          action: 'job_complete',
          iterations: result.iterations,
          toolCallCount: result.toolCallCount,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd,
          durationMs,
          verificationResults: verification,
          contextManagement: {
            editsApplied: result.contextEditsApplied?.length ?? 0,
            tokensSavedByEdits: result.tokensSavedByEdits ?? 0,
          },
          promptCaching: {
            cacheCreationTokens: result.cacheCreationTokens ?? 0,
            cacheReadTokens: result.cacheReadTokens ?? 0,
          },
          summary: result.finalResponse.slice(0, 500),
        },
      });
      logger.info('[hasmik] audit_log written');
    } catch (err) {
      logger.error({ error: (err as Error).message, stack: (err as Error).stack }, '[hasmik] FAILED to write audit_log');
    }

    // POST-LOOP WRITE 3: Inbox item (weekly briefing)
    try {
      await db.collection('os_inbox_items').insertOne({
        recipient: 'artur',
        sender_email: 'hasmik@aeda.internal',
        sender_name: '@hasmik (Research Agent)',
        subject: `Intelligence Brief — ${new Date().toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        })}`,
        body_text: result.finalResponse,
        body_sanitized: result.finalResponse,
        agent_commentary: `Weekly intelligence run: ${result.iterations} iterations, ${result.toolCallCount} tool calls, ~$${costUsd.toFixed(3)}. Verification: ${verification.verified} confirmed, ${verification.contradicted} contradicted, ${verification.pending} pending. Context edits saved ~${result.tokensSavedByEdits ?? 0} tokens. Cache: ${result.cacheReadTokens ?? 0} read, ${result.cacheCreationTokens ?? 0} created.`,
        message_id: `hasmik-weekly-${Date.now()}`,
        received_at: new Date(),
        processing_status: 'draft_created',
        routing: {
          artur_classification: 'weekly-clevel-brief',
          routed_to_agent: 'artur',
          artur_brief: 'Weekly board brief from @hasmik — review top signals and recommended actions.',
          lilit_task_id: null,
        },
        crm_match: { matched: false, investor_id: null, investor_name: null, matched_on: null },
        createdAt: new Date(),
      });
      logger.info('[hasmik] inbox_item written');
    } catch (err) {
      logger.error({ error: (err as Error).message, stack: (err as Error).stack }, '[hasmik] FAILED to write inbox_item');
      // Fallback: try to write error to audit log
      try {
        await writeAuditEvent({
          actor: 'hasmik',
          actorType: 'agent',
          eventType: 'job.run',
          payload: { jobName: JOB_NAME, action: 'inbox_write_failed', error: (err as Error).message },
        });
      } catch { /* ignore fallback failure */ }
    }

    logger.info(
      {
        iterations: result.iterations,
        toolCallCount: result.toolCallCount,
        costUsd,
        verification,
        contextManagement: {
          editsApplied: result.contextEditsApplied?.length ?? 0,
          tokensSavedByEdits: result.tokensSavedByEdits ?? 0,
        },
        promptCaching: {
          cacheCreationTokens: result.cacheCreationTokens ?? 0,
          cacheReadTokens: result.cacheReadTokens ?? 0,
        },
      },
      `@hasmik complete`
    );

  } catch (err) {
    const errorMsg = (err as Error).message;
    const errorStack = (err as Error).stack;
    logger.error({ error: errorMsg, stack: errorStack, durationMs: Date.now() - startMs }, '[hasmik] job failed');

    // Try to write error to audit log
    try {
      await writeAuditEvent({
        actor: 'hasmik',
        actorType: 'agent',
        eventType: 'job.run',
        payload: {
          jobName: JOB_NAME,
          action: 'job_error',
          error: errorMsg,
          durationMs: Date.now() - startMs,
        },
      });
    } catch (auditErr) {
      logger.error({ error: (auditErr as Error).message }, '[hasmik] FAILED to write error audit event');
    }
    throw err;
  }
}

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, { concurrency: 1 }, async () => {
    logger.info('[hasmik] weekly intelligence job started');
    await runHasmikIntelligence();
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  await agenda.every('0 19 * * 1', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('[hasmik] weekly intelligence job scheduled — Monday 19:00 Prague');
}
