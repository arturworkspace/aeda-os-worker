import Anthropic from '@anthropic-ai/sdk';
import { IComplianceFlag } from '../db/schemas/emailDraft.js';
import { estimateCostUsd } from '../config/pricing.js';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { logger } from '../logger.js';

const anthropic = new Anthropic();

const COMPLIANCE_CHECK_SYSTEM = `You are a compliance reviewer for aeda, a fintech startup. Your job is to check investor-facing email copy for regulatory and positioning compliance issues.

Review the provided email draft against the banned/required language rules below. Flag any violations found.

## HIGH SEVERITY (Never Use)
These terms must NEVER appear in investor emails:
- "CASP" or "Crypto-Asset Service Provider" → replace with "technology network"
- "VASP" or "Virtual Asset Service Provider" → replace with "technology network"
- "EMI" or "Electronic Money Institution" → replace with "technology infrastructure provider"
- "payment processor" or "we process payments" → replace with "cross-border payment infrastructure built on stablecoin rails and blockchain"
- "we send money" or "we transfer money" → replace with "connecting licensed partners" or "infrastructure enabling transfers"
- "we hold funds" or "we custody funds" → replace with "non-custodial" (state explicitly where relevant)
- "Armenia" (any form, e.g., Armenian, Yerevan) → replace with "EU/US ↔ EECA corridor"
- "EUR-AMD" (specific currency pair) → replace with "EU/US ↔ EECA"

## MEDIUM SEVERITY (Flag for Review)
These may be acceptable but should be reviewed:
- Specific stablecoin names/tickers (EURC, USDC, etc.) in investor-facing copy
- Unqualified speed claims ("instant", "in seconds") without qualification
- The "$81B" market-size figure used without source context
- Specific team-experience numbers/labels other than "former banking executives and engineers"

Return your findings as JSON with this exact structure:
{
  "flags": [
    {
      "severity": "HIGH" | "MEDIUM",
      "phrase": "the exact phrase found in the draft",
      "location": "subject" | "body" | "body (greeting)" | "body (paragraph N)",
      "suggestion": "the approved replacement or guidance"
    }
  ]
}

If no issues are found, return: {"flags": []}

Be precise: only flag actual violations. Do not flag acceptable uses of terms (e.g., "stablecoin rails" is fine, flagging individual stablecoin tickers like "USDC" is MEDIUM only).`;

interface ComplianceCheckResult {
  flags: IComplianceFlag[];
  costUsd: number;
}

export async function checkEmailCompliance(
  subject: string,
  body: string
): Promise<ComplianceCheckResult> {
  const emailContent = `SUBJECT: ${subject}\n\nBODY:\n${body}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: COMPLIANCE_CHECK_SYSTEM,
    messages: [{
      role: 'user',
      content: `Review this email draft for compliance issues:\n\n${emailContent}`,
    }],
  });

  const costUsd = estimateCostUsd('claude-haiku-4-5-20251001', {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
    cache_read_input_tokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
  });

  await costLedgerRepo.insert({
    agentOrJob: 'investor-email-compliance',
    packageId: null,
    projectKey: null,
    llmModel: 'claude-haiku-4-5-20251001',
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd,
    estimatedMaxUsd: costUsd,
    tier: 'background',
  });

  let flags: IComplianceFlag[] = [];

  const textBlock = response.content.find(b => b.type === 'text');
  if (textBlock && textBlock.type === 'text') {
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { flags?: unknown[] };
        if (Array.isArray(parsed.flags)) {
          flags = parsed.flags.filter((f): f is IComplianceFlag => {
            if (typeof f !== 'object' || f === null) return false;
            const flag = f as IComplianceFlag;
            return (
              (flag.severity === 'HIGH' || flag.severity === 'MEDIUM') &&
              typeof flag.phrase === 'string' &&
              typeof flag.location === 'string' &&
              typeof flag.suggestion === 'string'
            );
          });
        }
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'failed to parse compliance check response');
    }
  }

  if (flags.length > 0) {
    const highCount = flags.filter(f => f.severity === 'HIGH').length;
    const mediumCount = flags.filter(f => f.severity === 'MEDIUM').length;
    logger.info(
      { highCount, mediumCount, flags },
      'compliance check found issues'
    );
  }

  return { flags, costUsd };
}
