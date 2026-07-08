export type Tier = 'frontier' | 'production' | 'background';

export const MODEL_IDS = {
  frontier: 'claude-opus-4-7',
  frontierFallback: 'claude-sonnet-4-6',
  production: 'claude-sonnet-4-6',
  background: 'claude-haiku-4-5-20251001',
  backgroundFallback: 'claude-sonnet-4-6',
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

export interface ModelPricing {
  inputPerMUsd: number;
  outputPerMUsd: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': { inputPerMUsd: 15.0, outputPerMUsd: 75.0 },
  'claude-sonnet-4-6': { inputPerMUsd: 3.0, outputPerMUsd: 15.0 },
  'claude-haiku-4-5-20251001': { inputPerMUsd: 0.80, outputPerMUsd: 4.0 },
};

export function getModelForTier(tier: Tier): { primary: string; fallback: string } {
  switch (tier) {
    case 'frontier':
      return { primary: MODEL_IDS.frontier, fallback: MODEL_IDS.frontierFallback };
    case 'production':
      return { primary: MODEL_IDS.production, fallback: MODEL_IDS.production };
    case 'background':
      return { primary: MODEL_IDS.background, fallback: MODEL_IDS.backgroundFallback };
  }
}

export interface UsageWithCache {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}

export function estimateCostUsd(
  modelId: string,
  inputTokensOrUsage: number | UsageWithCache,
  outputTokens?: number
): number {
  const pricing = PRICING[modelId];
  if (!pricing) {
    throw new Error(`unknown model id for pricing: ${modelId}`);
  }

  // Handle object-form usage (with cache fields)
  if (typeof inputTokensOrUsage === 'object') {
    const usage = inputTokensOrUsage;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const regularInput = usage.input_tokens - cacheCreation - cacheRead;

    const regularInputCost = (regularInput / 1_000_000) * pricing.inputPerMUsd;
    const cacheCreationCost = (cacheCreation / 1_000_000) * pricing.inputPerMUsd * 1.25;
    const cacheReadCost = (cacheRead / 1_000_000) * pricing.inputPerMUsd * 0.1;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMUsd;

    return regularInputCost + cacheCreationCost + cacheReadCost + outputCost;
  }

  // Handle legacy two-argument form (backward compatible)
  const inputCost = (inputTokensOrUsage / 1_000_000) * pricing.inputPerMUsd;
  const outputCost = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMUsd;
  return inputCost + outputCost;
}
