import Anthropic from '@anthropic-ai/sdk';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { Tier, getModelForTier, PRICING, estimateCostUsd } from '../config/pricing.js';
import { checkBudget, checkBudgetWarning, invalidateBudgetCache } from './budgetGuard.js';
import { writeAuditEvent } from './auditLog.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { logger } from '../logger.js';

const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
});

export interface RoutedCallInput {
  tier: Tier;
  agentOrJob: string;
  packageId?: Types.ObjectId | string | null;
  projectKey?: string | null;
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  smokeTest?: boolean;
}

export interface RoutedCallResult {
  response: Anthropic.Message;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedMaxUsd: number;
}

function estimateInputTokens(system: string, messages: Anthropic.MessageParam[]): number {
  let charCount = system.length;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          charCount += block.text.length;
        }
      }
    }
  }
  return Math.ceil(charCount / 4);
}

export async function routedCall(input: RoutedCallInput): Promise<RoutedCallResult> {
  const { primary, fallback } = getModelForTier(input.tier);
  const estimatedInputTokens = estimateInputTokens(input.system, input.messages);

  const primaryPricing = PRICING[primary];
  if (!primaryPricing) {
    throw new Error(`no pricing found for model: ${primary}`);
  }

  const estimatedMaxUsd = estimateCostUsd(primary, estimatedInputTokens, input.maxTokens);

  await checkBudget(estimatedMaxUsd, {
    packageId: input.packageId ?? null,
    projectKey: input.projectKey ?? null,
    smokeTest: input.smokeTest ?? false,
  });

  let model = primary;
  let response: Anthropic.Message;

  try {
    response = await anthropic.messages.create({
      model: primary,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: input.messages,
    });
  } catch (error) {
    if (
      error instanceof Anthropic.APIError &&
      (error.status === 404 || error.message.includes('model'))
    ) {
      logger.warn({ primary, fallback, error: error.message }, 'primary model unavailable, using fallback');

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'llm.call',
        payload: { modelFallback: true, primary, fallback, reason: error.message },
        smokeTest: input.smokeTest ?? false,
      });

      model = fallback;
      response = await anthropic.messages.create({
        model: fallback,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: input.messages,
      });
    } else {
      throw error;
    }
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const actualCostUsd = estimateCostUsd(model, inputTokens, outputTokens);

  await costLedgerRepo.insert({
    agentOrJob: input.agentOrJob,
    packageId: input.packageId ? new Types.ObjectId(input.packageId.toString()) : null,
    projectKey: input.projectKey ?? null,
    llmModel: model,
    inputTokens,
    outputTokens,
    costUsd: actualCostUsd,
    estimatedMaxUsd,
    tier: input.tier,
    smokeTest: input.smokeTest ?? false,
  });

  invalidateBudgetCache();

  await writeAuditEvent({
    actor: input.agentOrJob,
    actorType: input.agentOrJob === 'artur' ? 'founder' : input.agentOrJob.startsWith('system.') ? 'system' : 'agent',
    eventType: 'llm.call',
    subjectId: input.packageId ? new Types.ObjectId(input.packageId.toString()) : null,
    payload: {
      tier: input.tier,
      inputTokens,
      outputTokens,
    },
    llmModel: model,
    costUsd: actualCostUsd,
    smokeTest: input.smokeTest ?? false,
  });

  await checkBudgetWarning();

  logger.info(
    {
      agentOrJob: input.agentOrJob,
      model,
      tier: input.tier,
      inputTokens,
      outputTokens,
      costUsd: actualCostUsd,
    },
    'llm call completed'
  );

  return {
    response,
    model,
    inputTokens,
    outputTokens,
    costUsd: actualCostUsd,
    estimatedMaxUsd,
  };
}

export function getTextContent(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') {
      return block.text;
    }
  }
  return '';
}
