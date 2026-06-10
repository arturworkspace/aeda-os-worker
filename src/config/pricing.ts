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

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = PRICING[modelId];
  if (!pricing) {
    throw new Error(`unknown model id for pricing: ${modelId}`);
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMUsd;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMUsd;
  return inputCost + outputCost;
}
