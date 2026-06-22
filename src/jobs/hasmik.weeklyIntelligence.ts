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
    searchFocus: `EU fintech regulation: MiCA implementation updates, EBA/ESMA guidance,
      Czech NBÚ or CNB fintech regulatory news, DORA compliance updates,
      AML/KYC regulation changes, stablecoin/EMT regulatory developments in EU.
      Focus on what changed THIS WEEK that is actionable for a non-custodial EURC wallet startup.`,
  },
  {
    id: 'technology',
    category: 'technology',
    relevantAgents: ['hamazasp', 'anna', 'vagho', 'artur'],
    searchFocus: `Solana blockchain updates (performance, fees, outages, new features),
      Circle EURC ecosystem news, Bridge.xyz API updates, Sumsub KYC platform updates,
      Helius RPC updates, Anthropic Claude API changes, Railway platform updates.
      Focus on what changed THIS WEEK relevant to a NestJS/Flutter/Solana stack.`,
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
    id: 'competitor',
    category: 'competitor',
    relevantAgents: ['tatev', 'chris', 'alex', 'artur'],
    searchFocus: `Competitor moves: Wise, Revolut, Remitly, MoneyGram, Western Union
      in Armenia/EECA corridor. New product launches, pricing changes, corridor entries/exits,
      regulatory issues. Any new stablecoin wallet or EUR-AMD transfer product announced.
      Note: Wise exited Armenia corridor in 2024 — flag immediately if they return.`,
  },
  {
    id: 'partner',
    category: 'partner',
    relevantAgents: ['alex', 'hamazasp', 'artur'],
    searchFocus: `Partner ecosystem updates: Bridge.xyz (EU on-ramp), Sky Labs (Armenia off-ramp),
      Sumsub (KYC), Circle (EURC issuer), Solana Foundation grants or partnerships.
      New API versions, pricing changes, outages, policy updates, new corridor support.`,
  },
];

// ─── Professional domains per agent ─────────────────────────────────────────

const AGENT_DOMAINS = [
  {
    agentId: 'hamazasp',
    category: 'technology',
    domain: 'Solana v2 changelog, NestJS releases, Flutter updates, AWS ECS changes, Helius RPC, Anthropic API, Railway deployment platform',
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
    domain: 'Fintech product management practices, KYC/AML UX patterns, stablecoin wallet UX research, go-to-market for payment apps, user onboarding conversion benchmarks',
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
      "sourceUrl": "url or empty string",
      "sourceLabel": "source name"
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
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: RESEARCH_SYSTEM,
      tools: [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();

    if (!text) return { signals: [], weekSummaryLine: 'No updates this week.' };

    // Strip markdown fences if present
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
      return JSON.parse(clean);
    } catch {
      logger.warn({ text: text.slice(0, 200) }, '[hasmik] failed to parse research JSON');
      return { signals: [], weekSummaryLine: 'Research parsing failed.' };
    }
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
    scope,
    relevantAgents: scope === 'organization' ? (relevantAgents ?? []) : [targetAgent],
    targetAgent: scope === 'professional' ? targetAgent : undefined,
    source: signal.sourceUrl || 'hasmik-weekly',
    sourceType: 'article',
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
      await sleep(2000);
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

      await sleep(2000);
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
