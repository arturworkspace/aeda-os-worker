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
