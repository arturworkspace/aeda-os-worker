import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { InvestorResearch, IInvestorResearchDocument } from '../db/schemas/investorResearch.js';
import { Investor, IInvestorDocument } from '../db/schemas/investor.js';
import { InboxItem } from '../db/schemas/inboxItem.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { emailDraftRepo } from '../db/repos/emailDraft.repo.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { estimateCostUsd } from '../config/pricing.js';
import { logger } from '../logger.js';
import { getPersona } from '../agents/personas.js';
import { isJuliaGmailConfigured, juliaCreateDraft } from '../services/juliaGmail.js';

const RESEARCH_DAILY_BUDGET_USD = Number(process.env['RESEARCH_DAILY_BUDGET_USD']) || 5;
const JOB_NAME = 'investor-research';

const anthropic = new Anthropic();

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

const FIRST_EMAIL_DRAFTING_SYSTEM = `You are Julia, aeda's Senior Fundraising & Investor Relations Agent. You draft investor outreach emails in Artur's voice.

When drafting first-outreach emails:
- Write in first person as Artur (CEO) — direct, evidence-driven, no hype
- Always use lowercase "aeda"
- Personalize based on the investor's portfolio, thesis, recent activity, or geographic focus

COMPANY PROFILE:
${AEDA_COMPANY_PROFILE}

LENGTH — 100-130 WORDS TOTAL:
The email body must be 100-130 words. Cut any sentence that doesn't directly serve: (a) why this investor specifically, (b) what aeda does in one sentence, (c) the ask. Remove extended market-timing paragraphs unless reduced to one clause.

CORE DESCRIPTION:
Describe aeda as "cross-border payment infrastructure built on stablecoin rails and blockchain for individuals and businesses." Do NOT name specific stablecoins (EURC, USDC, etc.) anywhere in the email. Do NOT use "stablecoin infrastructure" as the core descriptor.

EMAIL STRUCTURE — six beats, in this order:
1. Investor relevance (why this investor specifically — portfolio, thesis, or recent activity)
2. What aeda is (the core description, one sentence)
3. Why now (one clause, picking the ONE or TWO most relevant of these four momentum drivers based on the specific investor's thesis/focus — do not list all four, choose the best fit):
   - Regulation: regulatory clarity emerging in EU (MiCA) and US (GENIUS Act)
   - Fragmentation: geopolitical disruption (wars, sanctions) breaking traditional cross-border transfer rails
   - Market: fast-growing remittance market still served by uncompetitive, expensive legacy rails
   - 24/7: real-time settlement via stablecoins, anytime, anywhere — vs. legacy multi-day settlement windows
   Pick whichever driver(s) best match the investor's stated thesis or portfolio pattern from the research. Keep this to one clause or short sentence — do not expand into a paragraph.
4. Market (the $81B corridor context)
5. Team/traction (the team-credibility clause, since traction metrics are placeholder-gated)
6. CTA (the closing ask)
Beats 2-5 can be combined into 1-2 sentences each — the goal is that all six elements are present, not that each gets its own paragraph. Total length stays 100-130 words.

TEAM CREDIBILITY:
Since specific traction metrics are placeholder-gated, include one brief, factual clause noting the team's background: "aeda is built by a team of former banking executives and engineers." Keep this natural, factual, not boastful — woven into the company-description sentence, not a separate credential-drop paragraph.

SUBJECT LINE PERSONALIZATION:
At least one of the 3 subject options must reference something specific to the recipient (their firm name, a relevant portfolio company, or their stated thesis). All subject options must be under 60 characters. Avoid buzzwords, numbers-as-hype, or promotional framing — keep subject lines grounded and recognizable, not clever.

CTA:
End every email with exactly this line (adjust only "pre-seed" if the round stage changes in the future): "We're currently raising our pre-seed round. Open to receiving the short deck?" Do not use "Would it be useful if I sent..." or other CTA phrasing — use this exact sentence as the closing ask every time.

VARIED OPENINGS:
Avoid defaulting to the same "Your [Firm]'s investment in X caught my attention" structure every time. Vary the opening across drafts — sometimes lead with the aeda one-liner, sometimes the investor-specific hook, sometimes a direct question.

MARKET CONTEXT:
You may mention "an $81B annual corridor" or "$81B market" when relevant.

CRITICAL — FINANCIAL FIGURES:
For any specific financial metric (burn rate, cash position, runway months, revenue, funding target amount, traction numbers), you MUST use the exact placeholder text "[PENDING FINANCIAL UPDATE]" instead of inventing or inferring a number. This placeholder will be filled in by a human before sending. Do NOT guess, estimate, or make up any financial figures.

CRITICAL — GEOGRAPHIC POSITIONING:
Never name Armenia specifically in the email. aeda's positioning is the broader EU/US <> Eastern Europe & Central Asia (EECA) corridor, not a single country. Do not say "EU-Armenia corridor," "EUR-AMD," or reference Armenia by name.

Return your response as JSON with exactly these fields:
{
  "subjectOptions": ["Subject line option 1", "Subject line option 2", "Subject line option 3"],
  "body": "The email body text...",
  "personalizationReasoning": "1-2 sentences explaining what specific research fact motivated the angle taken"
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
  research: IInvestorResearchDocument
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

    // Determine email address and contact confidence
    const toEmail = research.contact?.email || investor.email || '';
    const contactConfidence = research.contact?.confidence || null;

    // Skip if no email address available
    if (!toEmail) {
      logger.warn({ investorId, investorName: investor.name }, 'no email address available, cannot create draft');
      return;
    }

    // Save draft
    const emailDraft = await emailDraftRepo.create({
      drafted_by_agent: 'julia',
      to: toEmail,
      subject: parsedDraft.subjectOptions[0] || 'Introduction from aeda',
      body: parsedDraft.body,
      thread_context: `First outreach to ${investor.name} (${investor.firm || 'Unknown'})`,
      investorId: investorObjId,
      draftType: 'first_email',
      subjectOptions: parsedDraft.subjectOptions,
      personalizationReasoning: parsedDraft.personalizationReasoning,
      qualityScore: qualityResult.score,
      contactConfidence,
    });

    // Create InboxItem so draft appears in Julia's inbox
    const inboxItem = new InboxItem({
      recipient: 'julia@aeda.internal',
      sender_email: 'system@aeda.internal',
      sender_name: 'aeda System',
      subject: `First outreach email drafted for ${investor.name}`,
      body_raw: '',
      body_sanitized: '',
      body_hardened: '',
      body_text: parsedDraft.body,
      body_html: '',
      attachments: [],
      agent_commentary: `First outreach email ready for review. Investor: ${investor.name} (${investor.firm || 'Unknown'}). Quality score: ${qualityResult.score}/10.`,
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
        artur_brief: `First outreach draft for ${investor.name}`,
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
        // Update the email draft with Gmail IDs
        await emailDraftRepo.updateGmailInfo(
          emailDraft._id as Types.ObjectId,
          gmailResult.draftId,
          gmailResult.messageId
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

    const { investorId } = req.body as { investorId?: string };
    if (!investorId || !Types.ObjectId.isValid(investorId)) {
      res.status(400).json({ error: 'Invalid investorId' });
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
      res.json({ status: 'drafting', investorId });

      // Fire-and-forget: run draft generation in background
      runFirstEmailDraftAsync(investorObjId, investorId, investor, research).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), investorId }, 'unhandled error in async draft generation');
      });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg, investorId }, 'draft-email endpoint failed');
      res.status(500).json({ status: 'failed', investorId, error: errorMsg });
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
