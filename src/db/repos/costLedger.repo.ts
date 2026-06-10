import { Types, FilterQuery } from 'mongoose';
import { CostLedger, ICostLedger, ICostLedgerDocument } from '../schemas/costLedger.js';
import type { Tier } from '../../config/pricing.js';

export interface CostLedgerInput {
  agentOrJob: string;
  packageId?: Types.ObjectId | null;
  projectKey?: string | null;
  llmModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedMaxUsd: number;
  tier: Tier;
  smokeTest?: boolean;
}

export const costLedgerRepo = {
  async insert(input: CostLedgerInput): Promise<ICostLedgerDocument> {
    const doc = new CostLedger({
      ts: new Date(),
      agentOrJob: input.agentOrJob,
      packageId: input.packageId ?? null,
      projectKey: input.projectKey ?? null,
      llmModel: input.llmModel,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd,
      estimatedMaxUsd: input.estimatedMaxUsd,
      tier: input.tier,
      smokeTest: input.smokeTest ?? false,
    });
    return doc.save();
  },

  async find(query: FilterQuery<ICostLedger>): Promise<ICostLedgerDocument[]> {
    return CostLedger.find(query).sort({ ts: -1 }).exec();
  },

  async getMonthToDateTotal(excludeSmokeTest = true): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const query: FilterQuery<ICostLedger> = {
      ts: { $gte: startOfMonth },
    };
    if (excludeSmokeTest) {
      query['smokeTest'] = { $ne: true };
    }

    const result = await CostLedger.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]).exec();

    return result[0]?.total ?? 0;
  },

  async getMonthToDateByProject(
    projectKey: string,
    excludeSmokeTest = true
  ): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const query: FilterQuery<ICostLedger> = {
      ts: { $gte: startOfMonth },
      projectKey,
    };
    if (excludeSmokeTest) {
      query['smokeTest'] = { $ne: true };
    }

    const result = await CostLedger.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]).exec();

    return result[0]?.total ?? 0;
  },

  async getPackageTotal(packageId: Types.ObjectId | string): Promise<number> {
    const result = await CostLedger.aggregate([
      { $match: { packageId: new Types.ObjectId(packageId) } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]).exec();

    return result[0]?.total ?? 0;
  },

  async getYesterdayAggregates(): Promise<{
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    callCount: number;
    byAgent: Record<string, { costUsd: number; calls: number }>;
    byTier: Record<string, { costUsd: number; calls: number }>;
    byModel: Record<string, { costUsd: number; calls: number }>;
  }> {
    const now = new Date();
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const docs = await CostLedger.find({
      ts: { $gte: startOfYesterday, $lt: startOfToday },
      smokeTest: { $ne: true },
    }).exec();

    const result = {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      callCount: docs.length,
      byAgent: {} as Record<string, { costUsd: number; calls: number }>,
      byTier: {} as Record<string, { costUsd: number; calls: number }>,
      byModel: {} as Record<string, { costUsd: number; calls: number }>,
    };

    for (const doc of docs) {
      result.totalCostUsd += doc.costUsd;
      result.totalInputTokens += doc.inputTokens;
      result.totalOutputTokens += doc.outputTokens;

      if (!result.byAgent[doc.agentOrJob]) {
        result.byAgent[doc.agentOrJob] = { costUsd: 0, calls: 0 };
      }
      result.byAgent[doc.agentOrJob]!.costUsd += doc.costUsd;
      result.byAgent[doc.agentOrJob]!.calls += 1;

      if (!result.byTier[doc.tier]) {
        result.byTier[doc.tier] = { costUsd: 0, calls: 0 };
      }
      result.byTier[doc.tier]!.costUsd += doc.costUsd;
      result.byTier[doc.tier]!.calls += 1;

      if (!result.byModel[doc.llmModel]) {
        result.byModel[doc.llmModel] = { costUsd: 0, calls: 0 };
      }
      result.byModel[doc.llmModel]!.costUsd += doc.costUsd;
      result.byModel[doc.llmModel]!.calls += 1;
    }

    return result;
  },

  async deleteTestDocs(): Promise<number> {
    const result = await CostLedger.deleteMany({ smokeTest: true }).exec();
    return result.deletedCount;
  },
};
