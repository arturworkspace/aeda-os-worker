import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { google } from 'googleapis';
import { InvestorResearch, IInvestorResearchDocument } from '../db/schemas/investorResearch.js';
import { Investor, IInvestorDocument } from '../db/schemas/investor.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { investorRepo } from '../db/repos/investor.repo.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { estimateCostUsd } from '../config/pricing.js';
import { logger } from '../logger.js';
import { getPersona } from '../agents/personas.js';
import { isJuliaGmailConfigured, juliaCreateDraft, juliaSendDraft, searchThreads, getThreadById } from '../services/juliaGmail.js';
import { checkEmailCompliance } from '../services/complianceCheck.js';

const RESEARCH_DAILY_BUDGET_USD = Number(process.env['RESEARCH_DAILY_BUDGET_USD']) || 5;
const JOB_NAME = 'investor-research';

const anthropic = new Anthropic();

// Forbidden placeholders that must be filled in before creating a draft
// This validation runs BEFORE saving to DB, not just at Gmail push time
const FORBIDDEN_PLACEHOLDERS = [
  '[PENDING FINANCIAL UPDATE]',
  '[First Name]',
  '[FIRST NAME]',
];

interface PlaceholderValidationResult {
  valid: boolean;
  foundPlaceholder?: string;
}

function validateNoForbiddenPlaceholders(subject: string, body: string, investorName?: string): PlaceholderValidationResult {
  for (const placeholder of FORBIDDEN_PLACEHOLDERS) {
    if (body.includes(placeholder) || subject.includes(placeholder)) {
      console.log(`[placeholder-gate] BLOCKED draft for "${investorName || 'unknown'}" - found: ${placeholder}`);
      return { valid: false, foundPlaceholder: placeholder };
    }
  }
  console.log(`[placeholder-gate] PASSED validation for "${investorName || 'unknown'}"`);
  return { valid: true };
}

const RESEARCH_SYSTEM_PROMPT = `You are a research assistant for aeda, a fintech startup.

Research this investor for fit assessment. Find:
- Investment thesis (what they look for)
- Typical stage (pre-seed, seed, Series A, etc.)
- Check size (typical investment amount)
- Geographic focus (regions they invest in)
- Portfolio companies (notable investments)
- Most recent activity (recent deals, announcements)
- Best contact (partner name, email, LinkedIn if publicly listed)

Cite every claim with a source URL. If you cannot find something after thorough search, say so explicitly — do not guess or invent data.

IMPORTANT: Only report information you can cite. Missing data is acceptable; fabricated data is not.

SOURCE URLs: Every source you cite must have a real, valid http:// or https:// URL. If you cannot confirm the URL for a source, omit that source entry entirely — do NOT use placeholder strings like "<UNKNOWN>", "N/A", "unknown", or similar. An empty sources list is acceptable; placeholder URLs are not.`;

const STRUCTURING_TOOL = {
  name: 'structure_research',
  description: 'Structure the research findings into the required format',
  input_schema: {
    type: 'object' as const,
    properties: {
      thesis: {
        type: ['string', 'null'] as const,
        description: 'Investment thesis. Null if not found.',
      },
      stage: {
        type: ['string', 'null'] as const,
        description: 'Typical investment stage (e.g., "Pre-seed to Seed", "Series A"). Null if not found.',
      },
      checkSize: {
        type: ['string', 'null'] as const,
        description: 'Typical check size (e.g., "$250K-$1M", "€500K"). Null if not found.',
      },
      geoFocus: {
        type: ['array', 'null'] as const,
        items: { type: 'string' },
        description: 'Geographic regions they focus on. Null if not found.',
      },
      portfolioCompanies: {
        type: 'array' as const,
        items: { type: 'string' },
        description: 'List of notable portfolio companies. Empty array if none found.',
      },
      recentActivity: {
        type: ['string', 'null'] as const,
        description: 'Most recent public activity or deals. Null if not found.',
      },
      contactName: {
        type: ['string', 'null'] as const,
        description: 'Best contact person name. Null if not found.',
      },
      contactEmail: {
        type: ['string', 'null'] as const,
        description: 'Contact email. Null if not found.',
      },
      contactConfidence: {
        type: ['string', 'null'] as const,
        enum: ['verified', 'inferred', null],
        description: '"verified" only if the research cited an actual source for this specific email. "inferred" if guessed from pattern. Null if no email.',
      },
      contactLinkedIn: {
        type: ['string', 'null'] as const,
        description: 'LinkedIn profile URL. Null if not found.',
      },
      sources: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['url', 'title'],
        },
        description: 'List of sources cited in the research.',
      },
    },
    required: ['thesis', 'stage', 'checkSize', 'geoFocus', 'portfolioCompanies', 'recentActivity', 'contactName', 'contactEmail', 'contactConfidence', 'contactLinkedIn', 'sources'],
  },
};

const AEDA_COMPANY_PROFILE = `aeda is a non-custodial EURC stablecoin infrastructure company for the EU/US <> Eastern Europe & Central Asia (EECA) corridor.
Pre-seed stage startup based in Prague, Czech Republic.
Geographic focus: EU, US, and EECA (Eastern Europe, Caucasus, Central Asia).
Technology-network positioning — NOT a payment processor, CASP, VASP, or EMI.
Business model: infrastructure layer enabling cross-border corridor transfers via EURC stablecoin.`;

const SCORING_SYSTEM_PROMPT = `You are an investor fit analyst for aeda.

Score how well this investor fits aeda based on the research data provided.

COMPANY PROFILE:
${AEDA_COMPANY_PROFILE}

Score each dimension 1-10 with mandatory one-sentence reasoning:
- thesis: How well does the investor's stated thesis align with aeda's business?
- stage: Does the investor invest at pre-seed stage?
- geo: Does the investor focus on EU, EECA, or global (inclusive of these regions)?
- checkSize: Is their typical check size appropriate for pre-seed (~$100K-$500K ideal)?
- portfolio: Do they have relevant portfolio companies (fintech, crypto, payments, infrastructure)?
- impact: How much could they help beyond capital (intros, expertise, reputation)?
- network: Do they have connections relevant to EU/EECA corridor or fintech/crypto sector?

Also provide:
- overallPriority: High/Medium/Low holistic assessment
- bestOutreachAngle: 1-2 sentences citing a specific hook from the research
- bestContactPerson: Name from contact field or null`;

const SCORING_TOOL = {
  name: 'score_investor_fit',
  description: 'Score investor fit across 7 dimensions with reasoning',
  input_schema: {
    type: 'object' as const,
    properties: {
      thesis: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string', description: 'One sentence explaining the score' },
        },
        required: ['score', 'reasoning'],
      },
      stage: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      geo: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      checkSize: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      portfolio: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      impact: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      network: {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
      },
      overallPriority: {
        type: 'string' as const,
        enum: ['High', 'Medium', 'Low'],
        description: 'Holistic priority assessment based on all dimensions',
      },
      bestOutreachAngle: {
        type: ['string', 'null'] as const,
        description: '1-2 sentences: the single most compelling hook citing specific research',
      },
      bestContactPerson: {
        type: ['string', 'null'] as const,
        description: 'Name from contact field, or null if not found',
      },
    },
    required: ['thesis', 'stage', 'geo', 'checkSize', 'portfolio', 'impact', 'network', 'overallPriority', 'bestOutreachAngle', 'bestContactPerson'],
  },
};

interface DimensionScoreOutput {
  score: number;
  reasoning: string;
}

interface ScoringOutput {
  thesis: DimensionScoreOutput;
  stage: DimensionScoreOutput;
  geo: DimensionScoreOutput;
  checkSize: DimensionScoreOutput;
  portfolio: DimensionScoreOutput;
  impact: DimensionScoreOutput;
  network: DimensionScoreOutput;
  overallPriority: 'High' | 'Medium' | 'Low';
  bestOutreachAngle: string | null;
  bestContactPerson: string | null;
}

interface StructuredResearchOutput {
  thesis: string | null;
  stage: string | null;
  checkSize: string | null;
  geoFocus: string[] | null;
  portfolioCompanies: string[];
  recentActivity: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactConfidence: 'verified' | 'inferred' | null;
  contactLinkedIn: string | null;
  sources: { url: string; title: string }[];
}

function isValidDimensionScore(val: unknown): val is DimensionScoreOutput {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as DimensionScoreOutput).score === 'number' &&
    typeof (val as DimensionScoreOutput).reasoning === 'string'
  );
}

function isValidScoringOutput(data: unknown): data is ScoringOutput {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  const dimensions = ['thesis', 'stage', 'geo', 'checkSize', 'portfolio', 'impact', 'network'];
  for (const dim of dimensions) {
    if (!isValidDimensionScore(d[dim])) return false;
  }
  if (!['High', 'Medium', 'Low'].includes(d['overallPriority'] as string)) return false;
  return true;
}

async function scoreInvestorFit(
  investorObjId: Types.ObjectId,
  investorId: string,
  investorName: string,
  researchData: StructuredResearchOutput
): Promise<void> {
  const researchSummary = `
INVESTOR: ${investorName}

THESIS: ${researchData.thesis || 'Not found'}

STAGE FOCUS: ${researchData.stage || 'Not found'}

CHECK SIZE: ${researchData.checkSize || 'Not found'}

GEOGRAPHIC FOCUS: ${researchData.geoFocus?.join(', ') || 'Not found'}

PORTFOLIO COMPANIES: ${researchData.portfolioCompanies.length > 0 ? researchData.portfolioCompanies.join(', ') : 'None found'}

RECENT ACTIVITY: ${researchData.recentActivity || 'Not found'}

CONTACT: ${researchData.contactName || 'Not found'}
`.trim();

  const scoringRequest = {
    model: 'claude-haiku-4-5-20251001' as const,
    max_tokens: 1024,
    system: [
      {
        type: 'text' as const,
        text: SCORING_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    tools: [SCORING_TOOL],
    tool_choice: { type: 'tool' as const, name: 'score_investor_fit' },
    messages: [{ role: 'user' as const, content: `Score this investor's fit for aeda:\n\n${researchSummary}` }],
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let scoringData: ScoringOutput | null = null;
  let attemptCount = 0;
  let lastRawInput: unknown = null;
  const maxAttempts = 3;

  while (attemptCount < maxAttempts && !scoringData) {
    attemptCount++;
    const scoringResponse = await anthropic.messages.create(scoringRequest);

    totalInputTokens += scoringResponse.usage.input_tokens;
    totalOutputTokens += scoringResponse.usage.output_tokens;
    totalCacheCreationTokens += (scoringResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += (scoringResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;

    lastRawInput = null;
    for (const block of scoringResponse.content) {
      if (block.type === 'tool_use' && block.name === 'score_investor_fit') {
        lastRawInput = block.input;
        break;
      }
    }

    if (lastRawInput && isValidScoringOutput(lastRawInput)) {
      scoringData = lastRawInput;
    } else {
      const rawContentPreview = JSON.stringify(scoringResponse.content).slice(0, 500);
      logger.warn(
        { investorId, attempt: attemptCount, rawContentPreview },
        'malformed scoring tool_use response, ' + (attemptCount < maxAttempts ? 'retrying' : 'attempting repair')
      );
    }
  }

  // Regex-repair fallback for known malformed pattern (any number of dimensions as string)
  if (!scoringData && lastRawInput && typeof lastRawInput === 'object' && lastRawInput !== null) {
    const raw = lastRawInput as Record<string, unknown>;
    const dimensions = ['thesis', 'stage', 'geo', 'checkSize', 'portfolio', 'impact', 'network'] as const;
    const scoreRegex = /<parameter name="score">(\d+)/;

    const malformedDims: typeof dimensions[number][] = [];
    let canRepair = true;

    for (const dim of dimensions) {
      if (isValidDimensionScore(raw[dim])) {
        // Already valid, no repair needed
      } else if (typeof raw[dim] === 'string' && scoreRegex.test(raw[dim] as string)) {
        malformedDims.push(dim);
      } else {
        // Unknown malformed shape — abort repair entirely
        canRepair = false;
        break;
      }
    }

    if (canRepair && malformedDims.length > 0) {
      const topLevelReasoning = typeof raw['reasoning'] === 'string' ? raw['reasoning'] : null;
      const repairedRaw = { ...raw };
      const extractedScores: Record<string, number> = {};
      let repairSuccess = true;

      for (let i = 0; i < malformedDims.length; i++) {
        const dim = malformedDims[i]!;
        const match = (raw[dim] as string).match(scoreRegex);
        if (match && match[1]) {
          const extractedScore = parseInt(match[1], 10);
          extractedScores[dim] = extractedScore;
          const reasoning = (i === 0 && topLevelReasoning)
            ? topLevelReasoning
            : 'Reasoning not available due to a model formatting issue for this dimension.';
          repairedRaw[dim] = { score: extractedScore, reasoning };
        } else {
          repairSuccess = false;
          break;
        }
      }

      if (repairSuccess && isValidScoringOutput(repairedRaw)) {
        scoringData = repairedRaw as ScoringOutput;
        logger.info(
          { investorId, repairedDimensions: malformedDims, extractedScores },
          `repaired ${malformedDims.length} malformed dimension(s) via regex extraction: ${malformedDims.join(', ')}`
        );
      }
    }
  }

  const scoringCost = estimateCostUsd('claude-haiku-4-5-20251001', {
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_creation_input_tokens: totalCacheCreationTokens,
    cache_read_input_tokens: totalCacheReadTokens,
  });

  await costLedgerRepo.insert({
    agentOrJob: JOB_NAME,
    packageId: null,
    projectKey: null,
    llmModel: 'claude-haiku-4-5-20251001',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: scoringCost,
    estimatedMaxUsd: scoringCost,
    tier: 'background',
  });

  if (!scoringData) {
    logger.warn({ investorId, attempts: attemptCount }, 'scoring failed after all attempts, leaving relevanceScore null');
    return;
  }

  const scoredAt = new Date();
  await InvestorResearch.findOneAndUpdate(
    { investorId: investorObjId },
    {
      $set: {
        relevanceScore: {
          thesis: scoringData.thesis,
          stage: scoringData.stage,
          geo: scoringData.geo,
          checkSize: scoringData.checkSize,
          portfolio: scoringData.portfolio,
          impact: scoringData.impact,
          network: scoringData.network,
          overallPriority: scoringData.overallPriority,
          bestOutreachAngle: scoringData.bestOutreachAngle,
          bestContactPerson: scoringData.bestContactPerson,
          scoredAt,
        },
        updatedAt: scoredAt,
      },
    }
  );

  logger.info(
    {
      investorId,
      investorName,
      overallPriority: scoringData.overallPriority,
      scoringCost,
      attempts: attemptCount,
    },
    'investor scoring completed'
  );
}

async function runResearchAsync(
  investorObjId: Types.ObjectId,
  investorId: string,
  investorName: string,
  investorFirm: string
): Promise<void> {
  const startTime = Date.now();
  let totalCostUsd = 0;

  try {
    const researchQuery = investorFirm
      ? `Research the investor "${investorName}" at "${investorFirm}" for startup investment fit assessment.`
      : `Research the investor "${investorName}" for startup investment fit assessment.`;

    logger.info({ investorId, investorName, investorFirm }, 'starting investor research (async)');

    const researchResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: RESEARCH_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: researchQuery }],
    });

    const researchCost = estimateCostUsd('claude-sonnet-4-6', {
      input_tokens: researchResponse.usage.input_tokens,
      output_tokens: researchResponse.usage.output_tokens,
      cache_creation_input_tokens: (researchResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      cache_read_input_tokens: (researchResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
    });
    totalCostUsd += researchCost;

    await costLedgerRepo.insert({
      agentOrJob: JOB_NAME,
      packageId: null,
      projectKey: null,
      llmModel: 'claude-sonnet-4-6',
      inputTokens: researchResponse.usage.input_tokens,
      outputTokens: researchResponse.usage.output_tokens,
      costUsd: researchCost,
      estimatedMaxUsd: researchCost,
      tier: 'production',
    });

    let researchText = '';
    for (const block of researchResponse.content) {
      if (block.type === 'text') {
        researchText += block.text + '\n';
      }
    }

    if (!researchText.trim()) {
      await upsertFailed(investorObjId, 'Research returned no content');
      return;
    }

    const structureResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: 'You are a data extraction assistant. Parse the research findings and call the structure_research tool with the extracted data. Use null for fields that were not found in the research. Only mark contactConfidence as "verified" if the email was explicitly cited from a source.',
      tools: [STRUCTURING_TOOL],
      tool_choice: { type: 'tool', name: 'structure_research' },
      messages: [{ role: 'user', content: `Extract structured data from this investor research:\n\n${researchText}` }],
    });

    const structureCost = estimateCostUsd('claude-haiku-4-5-20251001', {
      input_tokens: structureResponse.usage.input_tokens,
      output_tokens: structureResponse.usage.output_tokens,
      cache_creation_input_tokens: (structureResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      cache_read_input_tokens: (structureResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
    });
    totalCostUsd += structureCost;

    await costLedgerRepo.insert({
      agentOrJob: JOB_NAME,
      packageId: null,
      projectKey: null,
      llmModel: 'claude-haiku-4-5-20251001',
      inputTokens: structureResponse.usage.input_tokens,
      outputTokens: structureResponse.usage.output_tokens,
      costUsd: structureCost,
      estimatedMaxUsd: structureCost,
      tier: 'background',
    });

    let structuredData: StructuredResearchOutput | null = null;
    for (const block of structureResponse.content) {
      if (block.type === 'tool_use' && block.name === 'structure_research') {
        structuredData = block.input as StructuredResearchOutput;
        break;
      }
    }

    if (!structuredData) {
      await upsertFailed(investorObjId, 'Failed to structure research data');
      return;
    }

    const now = new Date();
    await InvestorResearch.findOneAndUpdate(
      { investorId: investorObjId },
      {
        $set: {
          thesis: structuredData.thesis,
          stage: structuredData.stage,
          checkSize: structuredData.checkSize,
          geoFocus: structuredData.geoFocus,
          portfolioCompanies: structuredData.portfolioCompanies || [],
          recentActivity: structuredData.recentActivity,
          contact: {
            name: structuredData.contactName,
            email: structuredData.contactEmail,
            confidence: structuredData.contactConfidence,
            linkedIn: structuredData.contactLinkedIn,
          },
          sources: (structuredData.sources || []).map(s => ({
            url: s.url,
            title: s.title,
            fetchedAt: now,
          })),
          status: 'completed',
          error: null,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'job.run',
      subjectId: investorObjId,
      payload: {
        jobName: JOB_NAME,
        investorId,
        investorName,
        durationMs: Date.now() - startTime,
        totalCostUsd,
        sourcesFound: structuredData.sources?.length || 0,
        hasContact: !!structuredData.contactEmail,
      },
    });

    logger.info(
      {
        investorId,
        investorName,
        durationMs: Date.now() - startTime,
        totalCostUsd,
        sourcesFound: structuredData.sources?.length || 0,
      },
      'investor research completed'
    );

    // Chain scoring step — errors here don't fail the research result
    try {
      await scoreInvestorFit(investorObjId, investorId, investorName, structuredData);
    } catch (scoringErr) {
      const scoringErrMsg = scoringErr instanceof Error ? scoringErr.message : String(scoringErr);
      logger.error({ error: scoringErrMsg, investorId }, 'investor scoring failed (research still completed)');
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMsg, investorId }, 'investor research failed (async)');

    await upsertFailed(investorObjId, errorMsg);

    await writeAuditEvent({
      actor: 'system',
      actorType: 'system',
      eventType: 'job.run',
      subjectId: investorObjId,
      payload: {
        jobName: JOB_NAME,
        investorId,
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
        totalCostUsd,
      },
    });
  }
}

async function processBulkResearch(
  investors: { _id: Types.ObjectId; name: string; firm: string }[]
): Promise<void> {
  const CONCURRENCY = 2;
  const startTime = Date.now();
  let processed = 0;
  let skippedAlreadyDone = 0;
  let budgetBlocked = 0;
  let totalCostUsd = 0;

  const processOne = async (inv: { _id: Types.ObjectId; name: string; firm: string }) => {
    const investorId = inv._id.toHexString();

    // Check budget before each investor
    const dayToDateCost = await costLedgerRepo.getDayToDateTotal();
    if (dayToDateCost >= RESEARCH_DAILY_BUDGET_USD) {
      budgetBlocked++;
      logger.warn({ investorId, dayToDateCost, budget: RESEARCH_DAILY_BUDGET_USD }, 'bulk: budget exceeded, skipping investor');
      return 'budget';
    }

    // Double-check status (may have changed since initial query)
    const research = await InvestorResearch.findOne({ investorId: inv._id }).lean().exec();
    if (research?.status === 'running') {
      skippedAlreadyDone++;
      return 'skip';
    }
    if (research?.status === 'completed' && research.relevanceScore) {
      skippedAlreadyDone++;
      return 'skip';
    }

    // Mark as running
    await InvestorResearch.findOneAndUpdate(
      { investorId: inv._id },
      {
        $set: { status: 'running', error: null, updatedAt: new Date() },
        $setOnInsert: {
          investorId: inv._id,
          thesis: null,
          stage: null,
          checkSize: null,
          geoFocus: null,
          portfolioCompanies: [],
          recentActivity: null,
          contact: { name: null, email: null, confidence: null, linkedIn: null },
          sources: [],
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Run the actual research (reuses existing logic)
    try {
      await runResearchAsync(inv._id, investorId, inv.name, inv.firm);
      processed++;
      return 'done';
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), investorId }, 'bulk: research failed for investor');
      return 'error';
    }
  };

  // Process with concurrency limit of 2
  const queue = [...investors];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    // Check if we should stop due to budget
    if (budgetBlocked > 0 && queue.length > 0) {
      // Budget exceeded, skip remaining
      budgetBlocked += queue.length;
      queue.length = 0;
    }

    // Fill up to CONCURRENCY
    while (running.length < CONCURRENCY && queue.length > 0) {
      const inv = queue.shift()!;
      const promise = processOne(inv).then(() => {
        const idx = running.indexOf(promise);
        if (idx >= 0) running.splice(idx, 1);
      });
      running.push(promise);
    }

    // Wait for at least one to complete
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  // Get final cost for this batch
  const endCost = await costLedgerRepo.getDayToDateTotal();
  totalCostUsd = endCost;

  await writeAuditEvent({
    actor: 'system',
    actorType: 'system',
    eventType: 'job.run',
    payload: {
      jobName: JOB_NAME,
      action: 'bulk-research',
      processed,
      skippedAlreadyDone,
      budgetBlocked,
      totalCostUsd,
      durationMs: Date.now() - startTime,
    },
  });

  logger.info(
    { processed, skippedAlreadyDone, budgetBlocked, totalCostUsd, durationMs: Date.now() - startTime },
    'bulk research batch completed'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIRST-OUTREACH EMAIL DRAFTING
// ═══════════════════════════════════════════════════════════════════════════════

const FIRST_EMAIL_DRAFTING_SYSTEM = `You are drafting a cold email to a VC investor on behalf of Artur, CEO of aeda. The goal is a short, natural email that sounds like a human founder wrote it, not like an AI or a pitch deck.

VOICE — Write like Artur actually writes:
- Short sentences. Direct. Slightly informal business English.
- Non-native speaker cadence is fine. Not polished corporate English.
- No AI-tell phrases. BANNED: "genuine appetite", "tailwinds", "compelling", "signals", "positions them uniquely", "directly aligns with", "caught my attention", "resonates deeply", "excited to", em-dashes used for dramatic effect.
- No setup paragraphs like "Two tailwinds make this moment compelling..." — get to the point.
- Not textbook-perfect grammar, but not broken either.

LENGTH — 60-90 WORDS MAX:
This is a cold email a busy VC partner would actually read in full. Shorter is better. Cut ruthlessly.

PERSONALIZATION — Ground it in their actual research:
Look at the "Best Outreach Angle" field. That's the specific hook for THIS investor. Reference something real and verifiable about their firm, portfolio, or thesis. Not generic "you invest in fintech" — something specific only to them.

If the research mentions a specific portfolio company, partner name, or recent deal that connects to aeda's space, use it. If not, use their stated thesis or geographic focus.

STRUCTURE — Three parts only:
1. One sentence: why you're reaching out to THEM specifically (the personalized hook from research)
2. One sentence: what aeda is — "cross-border payment infrastructure on stablecoin rails for the EU/EECA corridor"
3. One sentence: the ask — "Raising our pre-seed. Open to the deck?"

That's it. No "why now" paragraph. No market size unless it fits naturally in one clause. No team credentials paragraph.

GREETING:
Use first name if known from research contact info. Otherwise just "Hi," — never brackets like "[First Name]".

SIGNATURE:
End with exactly this (blank line before):

Best,
Julia

CTA:
The last line before signature must be: "Raising our pre-seed. Open to the deck?" — or natural variation like "Open to receiving the short deck?"

CRITICAL RULES:
- Never name Armenia specifically. Say "EU/EECA corridor" or "Eastern Europe" if geography needed.
- Never name specific stablecoins (EURC, USDC).
- For any financial figure (revenue, burn, runway, etc.), use "[PENDING FINANCIAL UPDATE]" placeholder.
- Always lowercase "aeda".

SUBJECT LINES — 3 options:
- Under 50 characters each
- At least one must reference something specific to this investor
- No buzzwords, no numbers-as-hype, no "Quick intro" generic templates
- Sound like a human wrote it, not a sales automation tool

Return JSON:
{
  "subjectOptions": ["Subject 1", "Subject 2", "Subject 3"],
  "body": "The email body...",
  "personalizationReasoning": "One sentence: what specific research fact drove the angle"
}`;

interface FirstEmailDraftOutput {
  subjectOptions: string[];
  body: string;
  personalizationReasoning: string;
}

function parseFirstEmailDraftResponse(text: string): FirstEmailDraftOutput | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const subjectOptions = Array.isArray(parsed['subjectOptions'])
        ? (parsed['subjectOptions'] as string[]).filter(s => typeof s === 'string')
        : [];
      const body = typeof parsed['body'] === 'string' ? parsed['body'] : '';
      const personalizationReasoning = typeof parsed['personalizationReasoning'] === 'string'
        ? parsed['personalizationReasoning']
        : '';

      if (subjectOptions.length === 0 || !body) {
        return null;
      }

      return { subjectOptions, body, personalizationReasoning };
    }
  } catch {
    // fall through
  }
  return null;
}

async function scoreEmailPersonalizationQuality(
  body: string,
  personalizationReasoning: string
): Promise<{ score: number; reasoning: string; costUsd: number }> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: `You are an email quality reviewer. Score the personalization quality of this investor outreach email on a scale of 1-10.

A high score (8-10) means:
- The email references specific, verifiable facts about the investor (portfolio companies, thesis, recent deals)
- The connection to aeda is clearly articulated based on these facts
- It does NOT use generic phrases like "I noticed you invest in fintech" without specifics

A low score (1-4) means:
- Generic template language with no investor-specific details
- Vague claims of "fit" without evidence
- Could be sent to any investor without changes

Return JSON: {"score": <1-10>, "reasoning": "<one sentence explanation>"}`,
    messages: [{
      role: 'user',
      content: `Email body:\n${body}\n\nPersonalization reasoning:\n${personalizationReasoning}`,
    }],
  });

  const costUsd = estimateCostUsd('claude-haiku-4-5-20251001', {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
    cache_read_input_tokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
  });

  let score = 5;
  let reasoning = 'Could not parse quality score';

  const textBlock = response.content.find(b => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        if (typeof parsed['score'] === 'number') {
          score = Math.max(1, Math.min(10, parsed['score']));
        }
        if (typeof parsed['reasoning'] === 'string') {
          reasoning = parsed['reasoning'];
        }
      }
    } catch {
      // keep defaults
    }
  }

  return { score, reasoning, costUsd };
}

async function runFirstEmailDraftAsync(
  investorObjId: Types.ObjectId,
  investorId: string,
  investor: IInvestorDocument,
  research: IInvestorResearchDocument,
  testModeEmail?: string
): Promise<void> {
  const startTime = Date.now();
  let totalCostUsd = 0;

  try {
    const julia = getPersona('julia');
    if (!julia) {
      logger.error({ investorId }, 'julia persona not found');
      return;
    }

    // Build context from research
    const relevanceScore = research.relevanceScore;
    const researchContext = `
INVESTOR: ${investor.name}
FIRM: ${investor.firm || 'Unknown'}
TYPE: ${investor.type || 'VC'}

RESEARCH FINDINGS:
- Thesis: ${research.thesis || 'Not found'}
- Stage focus: ${research.stage || 'Not found'}
- Check size: ${research.checkSize || 'Not found'}
- Geographic focus: ${research.geoFocus?.join(', ') || 'Not found'}
- Portfolio companies: ${research.portfolioCompanies?.length ? research.portfolioCompanies.join(', ') : 'None found'}
- Recent activity: ${research.recentActivity || 'Not found'}

RELEVANCE SCORING:
- Overall priority: ${relevanceScore?.overallPriority || 'Not scored'}
- Best outreach angle: ${relevanceScore?.bestOutreachAngle || 'Not available'}
- Best contact: ${relevanceScore?.bestContactPerson || research.contact?.name || 'Not found'}

CONTACT:
- Name: ${research.contact?.name || 'Not found'}
- Email: ${research.contact?.email || investor.email || 'Not found'}
- Confidence: ${research.contact?.confidence || 'unknown'}
`.trim();

    // Generate draft via Sonnet
    const draftResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: FIRST_EMAIL_DRAFTING_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{
        role: 'user',
        content: `Draft a first-outreach email to this investor:\n\n${researchContext}`,
      }],
    });

    const draftCost = estimateCostUsd('claude-sonnet-4-6', {
      input_tokens: draftResponse.usage.input_tokens,
      output_tokens: draftResponse.usage.output_tokens,
      cache_creation_input_tokens: (draftResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      cache_read_input_tokens: (draftResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
    });
    totalCostUsd += draftCost;

    await costLedgerRepo.insert({
      agentOrJob: 'investor-email-draft',
      packageId: null,
      projectKey: null,
      llmModel: 'claude-sonnet-4-6',
      inputTokens: draftResponse.usage.input_tokens,
      outputTokens: draftResponse.usage.output_tokens,
      costUsd: draftCost,
      estimatedMaxUsd: draftCost,
      tier: 'production',
    });

    // Parse response
    let draftText = '';
    for (const block of draftResponse.content) {
      if (block.type === 'text') {
        draftText += block.text;
      }
    }

    const parsedDraft = parseFirstEmailDraftResponse(draftText);
    if (!parsedDraft) {
      logger.error({ investorId, rawResponse: draftText.slice(0, 500) }, 'failed to parse draft response');
      return;
    }

    // Run quality-gate scoring
    const qualityResult = await scoreEmailPersonalizationQuality(
      parsedDraft.body,
      parsedDraft.personalizationReasoning
    );
    totalCostUsd += qualityResult.costUsd;

    await costLedgerRepo.insert({
      agentOrJob: 'investor-email-draft',
      packageId: null,
      projectKey: null,
      llmModel: 'claude-haiku-4-5-20251001',
      inputTokens: 0, // Already counted in qualityResult.costUsd
      outputTokens: 0,
      costUsd: qualityResult.costUsd,
      estimatedMaxUsd: qualityResult.costUsd,
      tier: 'background',
    });

    // Log warning if quality is low but still save
    if (qualityResult.score < 6) {
      logger.warn(
        { investorId, qualityScore: qualityResult.score, reasoning: qualityResult.reasoning },
        'first-email draft has low personalization quality score'
      );
    }

    // Run compliance pre-filter check (Haiku-based, flag-only — does NOT block or rewrite)
    const draftSubject = parsedDraft.subjectOptions[0] || 'Introduction from aeda';
    const complianceResult = await checkEmailCompliance(draftSubject, parsedDraft.body);
    totalCostUsd += complianceResult.costUsd;

    if (complianceResult.flags.length > 0) {
      const highCount = complianceResult.flags.filter(f => f.severity === 'HIGH').length;
      const mediumCount = complianceResult.flags.filter(f => f.severity === 'MEDIUM').length;
      logger.warn(
        { investorId, investorName: investor.name, highCount, mediumCount, flags: complianceResult.flags },
        'compliance pre-filter flagged issues in draft'
      );
    }

    // Determine email address and contact confidence
    const realEmail = research.contact?.email || investor.email || '';
    const contactConfidence = research.contact?.confidence || null;

    // Skip if no email address available
    if (!realEmail) {
      logger.warn({ investorId, investorName: investor.name }, 'no email address available, cannot create draft');
      return;
    }

    // Test mode: override recipient with test email address
    const toEmail = testModeEmail || realEmail;
    const isTestMode = !!testModeEmail;
    if (isTestMode) {
      logger.info({ investorId, investorName: investor.name, testModeEmail }, 'TEST MODE: redirecting draft to test address');
    }

    // Validate no forbidden placeholders BEFORE saving draft
    const placeholderCheck = validateNoForbiddenPlaceholders(draftSubject, parsedDraft.body, investor.name);
    if (!placeholderCheck.valid) {
      logger.error({
        investorId,
        investorName: investor.name,
        placeholder: placeholderCheck.foundPlaceholder,
      }, 'BLOCKED: AI-generated draft contains unfilled placeholder - not saving to DB');

      // Create an InboxItem to surface the error to Julia
      const errorInboxItem = new InboxItem({
        recipient: 'julia@aeda.internal',
        sender_email: 'system@aeda.internal',
        sender_name: 'aeda System',
        subject: `⚠️ Draft BLOCKED for ${investor.name}: unfilled placeholder`,
        body_raw: '',
        body_sanitized: '',
        body_hardened: '',
        body_text: `The AI-generated draft for ${investor.name} was blocked because it contains an unfilled placeholder: ${placeholderCheck.foundPlaceholder}\n\nThis typically means the AI couldn't find certain information. Please manually draft this email or update the investor research with the missing info.`,
        body_html: '',
        attachments: [],
        agent_commentary: `Draft blocked due to placeholder: ${placeholderCheck.foundPlaceholder}`,
        received_at: new Date(),
        message_id: `placeholder-block-${investorObjId.toHexString()}-${Date.now()}`,
        in_reply_to: null,
        crm_match: {
          matched: true,
          investor_id: investorObjId.toHexString(),
          investor_name: investor.name,
          matched_on: null,
        },
        routing: {
          artur_classification: 'system_alert',
          routed_to_agent: 'julia',
          artur_brief: `Draft blocked for ${investor.name}`,
          lilit_task_id: null,
        },
        processing_status: 'blocked',
        processing_error: `Unfilled placeholder: ${placeholderCheck.foundPlaceholder}`,
        cost_usd: 0,
      });
      await errorInboxItem.save();
      return;
    }

    // Save draft (with compliance flags if any were found)
    const emailDraft = await emailDraftRepo.create({
      drafted_by_agent: 'julia',
      to: toEmail,
      subject: draftSubject,
      body: parsedDraft.body,
      thread_context: `First outreach to ${investor.name} (${investor.firm || 'Unknown'})`,
      investorId: investorObjId,
      draftType: 'first_email',
      subjectOptions: parsedDraft.subjectOptions,
      personalizationReasoning: parsedDraft.personalizationReasoning,
      qualityScore: qualityResult.score,
      contactConfidence,
      ...(complianceResult.flags.length > 0 ? { complianceFlags: complianceResult.flags } : {}),
      ...(isTestMode ? { isTestMode: true, realRecipient: realEmail } : {}),
    });

    // Create InboxItem so draft appears in Julia's inbox
    const testModePrefix = isTestMode ? '🧪 [TEST] ' : '';
    const testModeNote = isTestMode ? ` (TEST MODE: sends to ${testModeEmail}, real recipient: ${realEmail})` : '';

    // Build compliance flag summary for inbox commentary
    let complianceNote = '';
    if (complianceResult.flags.length > 0) {
      const highFlags = complianceResult.flags.filter(f => f.severity === 'HIGH');
      const mediumFlags = complianceResult.flags.filter(f => f.severity === 'MEDIUM');
      if (highFlags.length > 0) {
        complianceNote = ` ⚠️ COMPLIANCE: ${highFlags.length} HIGH severity flag(s) — review required before sending.`;
      } else if (mediumFlags.length > 0) {
        complianceNote = ` ⚡ Compliance: ${mediumFlags.length} MEDIUM flag(s) for review.`;
      }
    }

    const inboxItem = new InboxItem({
      recipient: 'julia@aeda.internal',
      sender_email: 'system@aeda.internal',
      sender_name: 'aeda System',
      subject: `${testModePrefix}First outreach email drafted for ${investor.name}`,
      body_raw: '',
      body_sanitized: '',
      body_hardened: '',
      body_text: parsedDraft.body,
      body_html: '',
      attachments: [],
      agent_commentary: `${testModePrefix}First outreach email ready for review. Investor: ${investor.name} (${investor.firm || 'Unknown'}). Quality score: ${qualityResult.score}/10.${complianceNote}${testModeNote}`,
      draft_text: parsedDraft.body,
      received_at: new Date(),
      message_id: `investor-first-email-draft-${(emailDraft._id as Types.ObjectId).toHexString()}`,
      in_reply_to: null,
      crm_match: {
        matched: true,
        investor_id: investorObjId.toHexString(),
        investor_name: investor.name,
        matched_on: null,
      },
      routing: {
        artur_classification: 'investor_outreach',
        routed_to_agent: 'julia',
        artur_brief: `${testModePrefix}First outreach draft for ${investor.name}`,
        lilit_task_id: null,
      },
      draft_id: emailDraft._id as Types.ObjectId,
      processing_status: 'draft_created',
      processing_error: null,
      cost_usd: 0,
    });
    await inboxItem.save();

    // Push draft to Julia's Gmail account (best-effort, non-blocking)
    if (isJuliaGmailConfigured() && toEmail) {
      try {
        const gmailResult = await juliaCreateDraft(
          toEmail,
          parsedDraft.subjectOptions[0] || 'Introduction from aeda',
          parsedDraft.body
        );
        // Update the email draft with Gmail IDs (including threadId and rfc822MessageId for follow-up linking)
        await emailDraftRepo.updateGmailInfo(
          emailDraft._id as Types.ObjectId,
          gmailResult.draftId,
          gmailResult.messageId,
          gmailResult.threadId,
          gmailResult.rfc822MessageId
        );
        logger.info(
          { investorId, gmailDraftId: gmailResult.draftId },
          'first-email draft pushed to julia gmail'
        );
      } catch (gmailErr) {
        const gmailErrMsg = gmailErr instanceof Error ? gmailErr.message : String(gmailErr);
        logger.error(
          { error: gmailErrMsg, investorId },
          'failed to push first-email draft to julia gmail (continuing without gmail)'
        );
      }
    }

    await writeAuditEvent({
      actor: 'julia',
      actorType: 'agent',
      eventType: 'investor.first_email_draft_created',
      subjectId: investorObjId,
      payload: {
        investorId,
        investorName: investor.name,
        qualityScore: qualityResult.score,
        qualityReasoning: qualityResult.reasoning,
        complianceFlagsCount: complianceResult.flags.length,
        complianceHighCount: complianceResult.flags.filter(f => f.severity === 'HIGH').length,
        contactConfidence,
        totalCostUsd,
        durationMs: Date.now() - startTime,
      },
    });

    logger.info(
      {
        investorId,
        investorName: investor.name,
        qualityScore: qualityResult.score,
        totalCostUsd,
        durationMs: Date.now() - startTime,
      },
      'first-email draft created'
    );

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMsg, investorId }, 'first-email draft generation failed');

    await writeAuditEvent({
      actor: 'julia',
      actorType: 'agent',
      eventType: 'investor.first_email_draft_created',
      subjectId: investorObjId,
      payload: {
        investorId,
        success: false,
        error: errorMsg,
        totalCostUsd,
        durationMs: Date.now() - startTime,
      },
    });
  }
}

export function createInvestorResearchRouter(): Router {
  const router = Router();

  router.post('/rescore', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId } = req.body as { investorId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }

    const investorObjId = new Types.ObjectId(investorId);

    try {
      const existingResearch = await InvestorResearch.findOne({ investorId: investorObjId }).exec();

      if (!existingResearch || existingResearch.status !== 'completed') {
        res.status(400).json({ status: 'failed', error: 'No completed research found to score' });
        return;
      }

      if (!existingResearch.thesis && !existingResearch.stage && !existingResearch.checkSize) {
        res.status(400).json({ status: 'failed', error: 'No completed research found to score' });
        return;
      }

      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ status: 'failed', error: 'Investor not found' });
        return;
      }

      const researchData: StructuredResearchOutput = {
        thesis: existingResearch.thesis,
        stage: existingResearch.stage,
        checkSize: existingResearch.checkSize,
        geoFocus: existingResearch.geoFocus,
        portfolioCompanies: existingResearch.portfolioCompanies || [],
        recentActivity: existingResearch.recentActivity,
        contactName: existingResearch.contact?.name || null,
        contactEmail: existingResearch.contact?.email || null,
        contactConfidence: existingResearch.contact?.confidence || null,
        contactLinkedIn: existingResearch.contact?.linkedIn || null,
        sources: (existingResearch.sources || []).map(s => ({ url: s.url, title: s.title })),
      };

      res.json({ status: 'scoring', investorId });

      scoreInvestorFit(investorObjId, investorId, investor.name, researchData).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), investorId }, 'rescore failed');
      });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'rescore endpoint failed');
      res.status(500).json({ status: 'failed', error: errorMsg });
    }
  });

router.post('/bulk-trigger', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const allInvestors = await Investor.find({}, { _id: 1, name: 1, firm: 1 }).lean().exec();
      const totalInvestors = allInvestors.length;

      const investorsNeedingWork: { _id: Types.ObjectId; name: string; firm: string }[] = [];

      for (const inv of allInvestors) {
        const research = await InvestorResearch.findOne({ investorId: inv._id }).lean().exec();
        if (research?.status === 'running') continue;
        if (research?.status === 'completed' && research.relevanceScore) continue;
        investorsNeedingWork.push({ _id: inv._id, name: inv.name, firm: inv.firm || '' });
      }

      const count = investorsNeedingWork.length;
      res.json({ status: 'queued', totalInvestors, count });

      if (count === 0) return;

      // Fire-and-forget: process batch async with concurrency limit
      processBulkResearch(investorsNeedingWork).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'bulk research batch failed');
      });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, 'bulk-trigger endpoint failed');
      res.status(500).json({ status: 'failed', error: errorMsg });
    }
  });

  router.post('/trigger', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId } = req.body as { investorId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }

    const investorObjId = new Types.ObjectId(investorId);

    try {
      // Step 1: Upsert running status immediately
      await InvestorResearch.findOneAndUpdate(
        { investorId: investorObjId },
        {
          $set: {
            status: 'running',
            error: null,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            investorId: investorObjId,
            thesis: null,
            stage: null,
            checkSize: null,
            geoFocus: null,
            portfolioCompanies: [],
            recentActivity: null,
            contact: { name: null, email: null, confidence: null, linkedIn: null },
            sources: [],
            createdAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      // Step 2: Look up investor name/firm
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        await upsertFailed(investorObjId, 'Investor not found');
        res.status(404).json({ status: 'failed', investorId, error: 'Investor not found' });
        return;
      }

      const investorName = investor.name;
      const investorFirm = investor.firm || '';

      // Step 3: Check budget
      const dayToDateCost = await costLedgerRepo.getDayToDateTotal();
      if (dayToDateCost >= RESEARCH_DAILY_BUDGET_USD) {
        logger.warn({ dayToDateCost, budget: RESEARCH_DAILY_BUDGET_USD }, 'daily research budget exceeded');
        await upsertFailed(investorObjId, 'Daily budget cap reached');
        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'budget.blocked',
          payload: {
            jobName: JOB_NAME,
            investorId,
            dayToDateCost,
            budget: RESEARCH_DAILY_BUDGET_USD,
          },
        });
        res.json({ status: 'failed', investorId, error: 'Daily budget cap reached' });
        return;
      }

      // Step 4: Respond immediately, then run research async
      res.json({ status: 'running', investorId });

      // Fire-and-forget: run research in background
      runResearchAsync(investorObjId, investorId, investorName, investorFirm).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), investorId }, 'unhandled error in async research');
      });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'investor research trigger failed');

      await upsertFailed(investorObjId, errorMsg);

      res.status(500).json({ status: 'failed', investorId, error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAFT-EMAIL: Generate first-outreach email draft for an investor
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/draft-email', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId, testModeEmail } = req.body as { investorId?: string; testModeEmail?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }

    // Validate testModeEmail if provided (must be a valid email)
    const isTestMode = !!testModeEmail;
    if (isTestMode && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testModeEmail)) {
      res.status(400).json({ error: 'Invalid testModeEmail address' });
      return;
    }

    const investorObjId = new Types.ObjectId(investorId);

    try {
      // Step 1: Look up investor
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ status: 'failed', error: 'Investor not found' });
        return;
      }

      // Step 2: Look up research — must exist and be completed with relevanceScore
      const research = await InvestorResearch.findOne({ investorId: investorObjId }).exec();
      if (!research || research.status !== 'completed') {
        res.status(400).json({
          status: 'failed',
          error: 'Research must be completed before drafting an email',
        });
        return;
      }

      if (!research.relevanceScore) {
        res.status(400).json({
          status: 'failed',
          error: 'Research must be completed before drafting an email',
        });
        return;
      }

      // Step 3: Check if draft already exists
      const existingDraft = await emailDraftRepo.findByInvestorAndDraftType(investorObjId, 'first_email');
      if (existingDraft) {
        res.json({
          status: 'exists',
          investorId,
          message: 'First-email draft already exists for this investor',
        });
        return;
      }

      // Step 4: Check budget
      const dayToDateCost = await costLedgerRepo.getDayToDateTotal();
      if (dayToDateCost >= RESEARCH_DAILY_BUDGET_USD) {
        logger.warn({ dayToDateCost, budget: RESEARCH_DAILY_BUDGET_USD }, 'daily budget exceeded for draft-email');
        res.json({ status: 'failed', investorId, error: 'Daily budget cap reached' });
        return;
      }

      // Step 5: Check email availability — fail synchronously if missing
      const toEmail = research.contact?.email || investor.email || '';
      if (!toEmail) {
        res.json({
          status: 'failed',
          investorId,
          error: 'No email address found for this investor — add one manually before drafting',
        });
        return;
      }

      // Step 6: Respond immediately, then run drafting async
      res.json({ status: 'drafting', investorId, testMode: isTestMode });

      // Fire-and-forget: run draft generation in background
      runFirstEmailDraftAsync(investorObjId, investorId, investor, research, testModeEmail).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), investorId }, 'unhandled error in async draft generation');
      });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'draft-email endpoint failed');
      res.status(500).json({ status: 'failed', investorId, error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BACKFILL-THREAD-IDS: One-time backfill for drafts missing gmail_thread_id
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/backfill-thread-ids', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      // Find all drafts that have gmail_draft_id but missing gmail_thread_id
      const draftsNeedingBackfill = await emailDraftRepo.find({
        gmail_draft_id: { $exists: true, $ne: null },
        $or: [
          { gmail_thread_id: { $exists: false } },
          { gmail_thread_id: null },
        ],
      });

      logger.info({ count: draftsNeedingBackfill.length }, 'found drafts needing thread_id backfill');

      if (draftsNeedingBackfill.length === 0) {
        res.json({ status: 'complete', backfilled: 0, message: 'No drafts need backfill' });
        return;
      }

      // Respond immediately, then process async
      res.json({
        status: 'processing',
        count: draftsNeedingBackfill.length,
        drafts: draftsNeedingBackfill.map(d => ({
          id: d._id.toString(),
          investorId: d.investorId?.toString() || 'none',
          gmailDraftId: d.gmail_draft_id,
        })),
      });

      // Initialize Gmail client for backfill
      const clientId = process.env['JULIA_GMAIL_CLIENT_ID'];
      const clientSecret = process.env['JULIA_GMAIL_CLIENT_SECRET'];
      const refreshToken = process.env['JULIA_GMAIL_REFRESH_TOKEN'];

      if (!clientId || !clientSecret || !refreshToken) {
        logger.error('julia gmail credentials not configured for backfill');
        return;
      }

      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      let backfilled = 0;
      let errors = 0;

      for (const draft of draftsNeedingBackfill) {
        if (!draft.gmail_draft_id) continue;

        try {
          // Call Gmail API to get the draft and extract threadId
          const draftResponse = await gmail.users.drafts.get({
            userId: 'me',
            id: draft.gmail_draft_id,
          });

          const threadId = draftResponse.data.message?.threadId;

          if (threadId) {
            // Update the draft record with the threadId
            await emailDraftRepo.updateGmailInfo(
              draft._id,
              draft.gmail_draft_id,
              draft.gmail_message_id || null,
              threadId,
              draft.gmail_rfc822_message_id || null
            );

            logger.info({
              draftId: draft._id.toString(),
              gmailDraftId: draft.gmail_draft_id,
              threadId,
              investorId: draft.investorId?.toString(),
            }, 'backfilled gmail_thread_id');

            backfilled++;
          } else {
            logger.warn({
              draftId: draft._id.toString(),
              gmailDraftId: draft.gmail_draft_id,
            }, 'draft found in gmail but no threadId returned');
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errCode = (err as { code?: number }).code;

          if (errCode === 404) {
            logger.info({
              draftId: draft._id.toString(),
              gmailDraftId: draft.gmail_draft_id,
            }, 'draft not found in gmail (may have been sent), skipping backfill');
          } else {
            logger.error({
              error: errMsg,
              draftId: draft._id.toString(),
              gmailDraftId: draft.gmail_draft_id,
            }, 'error fetching draft from gmail for backfill');
            errors++;
          }
        }
      }

      logger.info({ backfilled, errors, total: draftsNeedingBackfill.length }, 'thread_id backfill completed');

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, 'backfill-thread-ids endpoint failed');
      res.status(500).json({ status: 'failed', error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST-PLACEHOLDER-GATE: Test endpoint to verify placeholder blocking works
  // This creates real InboxItems that you can verify in the UI
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/test-placeholder-gate', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { testCase } = req.body as { testCase?: string };
    const testInvestorName = 'Placeholder Gate Test';
    const testInvestorId = new Types.ObjectId();

    const testCases: Record<string, { subject: string; body: string }> = {
      'pending_financial': {
        subject: 'Re: Introduction from aeda',
        body: 'Hi there, We are raising [PENDING FINANCIAL UPDATE] for our Series A round.',
      },
      'first_name': {
        subject: 'Re: Following up',
        body: 'Hi [First Name], I wanted to follow up on my previous email about aeda.',
      },
      'FIRST_NAME': {
        subject: 'Re: aeda Partnership',
        body: 'Hello [FIRST NAME], Thank you for your time last week.',
      },
      'clean': {
        subject: 'Re: Introduction from aeda',
        body: 'Hi there, I wanted to follow up. We are building cross-border payment infrastructure on stablecoin rails.',
      },
    };

    const selectedCase = testCases[testCase || 'pending_financial'];
    if (!selectedCase) {
      res.status(400).json({ error: `Unknown testCase. Valid: ${Object.keys(testCases).join(', ')}` });
      return;
    }

    console.log(`[test-placeholder-gate] Running test case: ${testCase || 'pending_financial'}`);

    const placeholderCheck = validateNoForbiddenPlaceholders(selectedCase.subject, selectedCase.body, testInvestorName);

    if (!placeholderCheck.valid) {
      // Create the error inbox item (this is what the real code does)
      const errorInboxItem = new InboxItem({
        recipient: 'julia@aeda.internal',
        sender_email: 'system@aeda.internal',
        sender_name: 'aeda System',
        subject: `⚠️ TEST: Draft BLOCKED for ${testInvestorName}: ${placeholderCheck.foundPlaceholder}`,
        body_raw: '',
        body_sanitized: '',
        body_hardened: '',
        body_text: `TEST: The draft was blocked because it contains: ${placeholderCheck.foundPlaceholder}\n\nOriginal body: ${selectedCase.body}`,
        body_html: '',
        attachments: [],
        agent_commentary: `TEST: Draft blocked due to placeholder: ${placeholderCheck.foundPlaceholder}`,
        received_at: new Date(),
        message_id: `test-placeholder-block-${testCase}-${Date.now()}`,
        in_reply_to: null,
        crm_match: {
          matched: false,
          investor_id: testInvestorId.toHexString(),
          investor_name: testInvestorName,
          matched_on: null,
        },
        routing: {
          artur_classification: 'system_alert',
          routed_to_agent: 'julia',
          artur_brief: `TEST: Draft blocked for ${testInvestorName}`,
          lilit_task_id: null,
        },
        processing_status: 'blocked',
        processing_error: `Unfilled placeholder: ${placeholderCheck.foundPlaceholder}`,
        cost_usd: 0,
      });
      await errorInboxItem.save();

      res.json({
        status: 'blocked',
        testCase: testCase || 'pending_financial',
        placeholder: placeholderCheck.foundPlaceholder,
        inboxItemId: (errorInboxItem._id as Types.ObjectId).toHexString(),
        message: 'InboxItem created - check Julia inbox in UI',
      });
      return;
    }

    // Clean case - would normally create draft, but for test we just confirm
    res.json({
      status: 'passed',
      testCase: testCase || 'pending_financial',
      message: 'Validation passed - draft would be created normally',
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH-GMAIL-THREADS: Search Julia's Gmail for threads by query
  // Used to find correct thread IDs for backfill/repair
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/search-gmail-threads', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { query, maxResults } = req.body as { query?: string; maxResults?: number };
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    try {
      const threads = await searchThreads(query, maxResults || 10);

      // Optionally fetch full thread details for each result
      const detailedThreads = await Promise.all(
        threads.map(async (t) => {
          const full = await getThreadById(t.threadId);
          return {
            threadId: t.threadId,
            snippet: t.snippet,
            messageCount: full?.messages.length ?? 0,
            messages: full?.messages.map((m) => ({
              from: m.from,
              to: m.to,
              subject: m.subject,
              date: m.date,
              snippet: m.snippet,
            })) ?? [],
          };
        })
      );

      res.json({ threads: detailedThreads });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, query }, 'search-gmail-threads failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX-THREAD-ID: Update an investor's draft thread ID after manual recompose
  // Used to repair stale thread IDs when user discards system draft and recomposes in Gmail
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/fix-thread-id', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId, newThreadId } = req.body as { investorId?: string; newThreadId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }
    if (!newThreadId) {
      res.status(400).json({ error: 'newThreadId is required' });
      return;
    }

    try {
      const investorObjId = new Types.ObjectId(investorId);

      // Find the latest draft for this investor
      const drafts = await emailDraftRepo.find({
        investorId: investorObjId,
        status: { $in: ['pushed_to_gmail', 'sent'] },
      });

      if (drafts.length === 0) {
        res.status(404).json({ error: 'No drafts found for this investor' });
        return;
      }

      // Update all drafts for this investor to use the new thread ID
      const updateResult = await Promise.all(
        drafts.map(async (draft) => {
          const oldThreadId = draft.gmail_thread_id;
          draft.gmail_thread_id = newThreadId;
          await draft.save();
          return { draftId: draft._id.toString(), oldThreadId, newThreadId };
        })
      );

      logger.info({ investorId, newThreadId, draftsUpdated: updateResult.length }, 'thread ID fixed for investor drafts');

      res.json({
        status: 'success',
        investorId,
        newThreadId,
        draftsUpdated: updateResult,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId, newThreadId }, 'fix-thread-id failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RESET-INVESTOR-OUTREACH: Reset an investor to pre-outreach state
  // Used to clean up test investors without touching Gmail
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/reset-investor-outreach', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId } = req.body as { investorId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }

    try {
      const investorObjId = new Types.ObjectId(investorId);

      // 1. Find investor
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ error: 'Investor not found' });
        return;
      }

      const investorName = investor.name;

      // 2. Delete all drafts for this investor
      const drafts = await emailDraftRepo.find({ investorId: investorObjId });
      const deletedDraftIds: string[] = [];
      for (const draft of drafts) {
        deletedDraftIds.push(draft._id.toString());
        await draft.deleteOne();
      }

      // 3. Delete any inbox items related to this investor
      const inboxDeleteResult = await InboxItem.deleteMany({
        'crm_match.investor_id': investorId,
      });

      // 4. Reset investor document to pre-outreach state
      // Must $unset repliedAt (not just null) because findNeedingFollowUp1 uses { $exists: false }
      await Investor.findByIdAndUpdate(investorObjId, {
        $set: {
          stage: 'Research',
          email: '',
          hasReply: false,
          replyReceivedAt: null,
          replySentiment: null,
          stageConfirmed: false,
          stageOverride: false,
          firstEmailSentAt: null,
          followUp1SentAt: null,
          followUp2SentAt: null,
          lastContact: '',
          nextAction: '',
          nextDate: '',
          activityLog: [],
        },
        $unset: {
          repliedAt: 1,
        },
      });

      logger.info({
        investorId,
        investorName,
        draftsDeleted: deletedDraftIds.length,
        inboxItemsDeleted: inboxDeleteResult.deletedCount,
      }, 'investor reset to pre-outreach state');

      res.json({
        status: 'success',
        investorId,
        investorName,
        draftsDeleted: deletedDraftIds,
        inboxItemsDeleted: inboxDeleteResult.deletedCount,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'reset-investor-outreach failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX-REPLIED-AT: One-time fix to unset stale repliedAt field
  // The findNeedingFollowUp1 query uses { $exists: false } which fails if repliedAt exists
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/fix-replied-at', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId } = req.body as { investorId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }

    try {
      const investorObjId = new Types.ObjectId(investorId);
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ error: 'Investor not found' });
        return;
      }

      // Unset repliedAt field so the investor is eligible for follow-up queries
      await Investor.findByIdAndUpdate(investorObjId, {
        $unset: { repliedAt: 1 },
      });

      logger.info({ investorId, investorName: investor.name }, 'unset repliedAt field for follow-up eligibility');

      res.json({
        status: 'success',
        investorId,
        investorName: investor.name,
        message: 'repliedAt field unset - investor should now be eligible for follow-up queries',
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'fix-replied-at failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REDIRECT-AND-SEND-DRAFT: Send a draft via Gmail API with optional To redirect
  // Used when Gmail web UI won't render a draft editable (thread corruption workaround)
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/redirect-and-send-draft', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId, draftGmailId, toEmail } = req.body as {
      investorId?: string;
      draftGmailId?: string;
      toEmail?: string;
    };

    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }
    if (!draftGmailId) {
      res.status(400).json({ error: 'draftGmailId is required' });
      return;
    }
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      res.status(400).json({ error: 'Valid toEmail is required' });
      return;
    }

    try {
      const investorObjId = new Types.ObjectId(investorId);
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ error: 'Investor not found' });
        return;
      }

      // Find the latest draft for this investor and verify gmailDraftId matches
      const drafts = await emailDraftRepo.find({
        investorId: investorObjId,
        gmail_draft_id: { $exists: true, $ne: null },
      });

      if (drafts.length === 0) {
        res.status(404).json({ error: 'No drafts with gmail_draft_id found for this investor' });
        return;
      }

      // Find the draft that matches the provided draftGmailId
      const matchingDraft = drafts.find(d => d.gmail_draft_id === draftGmailId);
      if (!matchingDraft) {
        res.status(400).json({
          error: 'draftGmailId does not match any stored draft for this investor',
          storedDraftIds: drafts.map(d => d.gmail_draft_id),
        });
        return;
      }

      if (!isJuliaGmailConfigured()) {
        res.status(500).json({ error: 'Julia Gmail client not configured' });
        return;
      }

      // Send the draft via Gmail API
      const sendResult = await juliaSendDraft(draftGmailId, toEmail);

      // Update the draft record to reflect it was sent
      matchingDraft.status = 'sent';
      matchingDraft.sent_at = new Date();
      await matchingDraft.save();

      logger.info({
        investorId,
        investorName: investor.name,
        draftGmailId,
        toEmail,
        sentMessageId: sendResult.messageId,
        threadId: sendResult.threadId,
      }, 'draft sent via redirect-and-send-draft endpoint');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'job.run',
        subjectId: investorObjId,
        payload: {
          jobName: 'redirect-and-send-draft',
          investorId,
          investorName: investor.name,
          draftGmailId,
          toEmail,
          sentMessageId: sendResult.messageId,
          threadId: sendResult.threadId,
          draftType: matchingDraft.draftType || matchingDraft.followUpStage,
        },
      });

      res.json({
        status: 'sent',
        investorId,
        investorName: investor.name,
        sentMessageId: sendResult.messageId,
        threadId: sendResult.threadId,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId, draftGmailId }, 'redirect-and-send-draft failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CORRECT-SENTIMENT: Manually correct reply sentiment classification
  // Used when LLM misclassifies a reply (e.g., polite rejection as positive)
  // ═══════════════════════════════════════════════════════════════════════════
  router.post('/correct-sentiment', async (req: Request, res: Response) => {
    const provided = req.headers['x-trigger-secret'];
    const expected = process.env['TRIGGER_SECRET'];
    if (!expected || provided !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { investorId, newSentiment, reason } = req.body as {
      investorId?: string;
      newSentiment?: 'positive' | 'negative';
      reason?: string;
    };

    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
      return;
    }
    if (!newSentiment || !['positive', 'negative'].includes(newSentiment)) {
      res.status(400).json({ error: 'newSentiment must be "positive" or "negative"' });
      return;
    }

    try {
      const investorObjId = new Types.ObjectId(investorId);
      const investor = await Investor.findById(investorObjId).exec();
      if (!investor) {
        res.status(404).json({ error: 'Investor not found' });
        return;
      }

      const oldSentiment = investor.replySentiment;

      // Use the repo method which adds activity log entry
      const updatedInvestor = await investorRepo.correctSentiment(investorObjId, newSentiment);

      logger.info({
        investorId,
        investorName: investor.name,
        oldSentiment,
        newSentiment,
        reason: reason || 'Manual correction',
      }, 'sentiment corrected');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'job.run',
        subjectId: investorObjId,
        payload: {
          jobName: 'correct-sentiment',
          investorId,
          investorName: investor.name,
          oldSentiment,
          newSentiment,
          reason: reason || 'Manual correction',
        },
      });

      res.json({
        status: 'corrected',
        investorId,
        investorName: investor.name,
        oldSentiment,
        newSentiment,
        derivedStage: newSentiment === 'positive' ? 'Answered' : 'Rejected',
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'correct-sentiment failed');
      res.status(500).json({ error: errorMsg });
    }
  });

  return router;
}

async function upsertFailed(investorObjId: Types.ObjectId, errorMsg: string): Promise<void> {
  await InvestorResearch.findOneAndUpdate(
    { investorId: investorObjId },
    {
      $set: {
        status: 'failed',
        error: errorMsg,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        investorId: investorObjId,
        thesis: null,
        stage: null,
        checkSize: null,
        geoFocus: null,
        portfolioCompanies: [],
        recentActivity: null,
        contact: { name: null, email: null, confidence: null, linkedIn: null },
        sources: [],
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}
