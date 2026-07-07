import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { InvestorResearch } from '../db/schemas/investorResearch.js';
import { Investor } from '../db/schemas/investor.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { estimateCostUsd } from '../config/pricing.js';
import { logger } from '../logger.js';

const MONTHLY_RESEARCH_BUDGET_USD = 5;
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

IMPORTANT: Only report information you can cite. Missing data is acceptable; fabricated data is not.`;

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

const AEDA_COMPANY_PROFILE = `aeda is a non-custodial EURC stablecoin infrastructure company for the EU-Armenia corridor.
Pre-seed stage startup based in Prague, Czech Republic.
Geographic focus: EU and EECA (Eastern Europe, Caucasus, Armenia).
Technology-network positioning — NOT a payment processor, CASP, VASP, or EMI.
Business model: infrastructure layer enabling EUR-AMD corridor transfers via EURC stablecoin.`;

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
- network: Do they have connections relevant to EU-Armenia corridor or fintech/crypto sector?

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

  const scoringResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SCORING_SYSTEM_PROMPT,
    tools: [SCORING_TOOL],
    tool_choice: { type: 'tool', name: 'score_investor_fit' },
    messages: [{ role: 'user', content: `Score this investor's fit for aeda:\n\n${researchSummary}` }],
  });

  const scoringCost = estimateCostUsd(
    'claude-haiku-4-5-20251001',
    scoringResponse.usage.input_tokens,
    scoringResponse.usage.output_tokens
  );

  await costLedgerRepo.insert({
    agentOrJob: JOB_NAME,
    packageId: null,
    projectKey: null,
    llmModel: 'claude-haiku-4-5-20251001',
    inputTokens: scoringResponse.usage.input_tokens,
    outputTokens: scoringResponse.usage.output_tokens,
    costUsd: scoringCost,
    estimatedMaxUsd: scoringCost,
    tier: 'background',
  });

  let scoringData: ScoringOutput | null = null;
  for (const block of scoringResponse.content) {
    if (block.type === 'tool_use' && block.name === 'score_investor_fit') {
      scoringData = block.input as ScoringOutput;
      break;
    }
  }

  if (!scoringData) {
    logger.warn({ investorId }, 'scoring tool output not found');
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
      system: RESEARCH_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: researchQuery }],
    });

    const researchCost = estimateCostUsd(
      'claude-sonnet-4-6',
      researchResponse.usage.input_tokens,
      researchResponse.usage.output_tokens
    );
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

    const structureCost = estimateCostUsd(
      'claude-haiku-4-5-20251001',
      structureResponse.usage.input_tokens,
      structureResponse.usage.output_tokens
    );
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
      const monthToDateCost = await costLedgerRepo.getMonthToDateTotal();
      if (monthToDateCost >= MONTHLY_RESEARCH_BUDGET_USD) {
        logger.warn({ monthToDateCost, budget: MONTHLY_RESEARCH_BUDGET_USD }, 'monthly research budget exceeded');
        await upsertFailed(investorObjId, 'Monthly budget cap reached');
        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'budget.blocked',
          payload: {
            jobName: JOB_NAME,
            investorId,
            monthToDateCost,
            budget: MONTHLY_RESEARCH_BUDGET_USD,
          },
        });
        res.json({ status: 'failed', investorId, error: 'Monthly budget cap reached' });
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
