import { Types, FilterQuery } from 'mongoose';
import { CostLedger, ICostLedger, ICostLedgerDocument } from '../schemas/costLedger.js';
import type { Tier } from '../../config/pricing.js';

function getPragueOffset(date: Date): number {
  // Europe/Prague: CET (UTC+1) or CEST (UTC+2)
  // DST starts last Sunday of March, ends last Sunday of October
  const year = date.getUTCFullYear();
  const lastSunMarch = new Date(Date.UTC(year, 2, 31));
  lastSunMarch.setUTCDate(31 - lastSunMarch.getUTCDay());
  lastSunMarch.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 02:00 CET

  const lastSunOct = new Date(Date.UTC(year, 9, 31));
  lastSunOct.setUTCDate(31 - lastSunOct.getUTCDay());
  lastSunOct.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 03:00 CEST -> 02:00 CET

  const isDST = date >= lastSunMarch && date < lastSunOct;
  return isDST ? 2 * 60 * 60 * 1000 : 1 * 60 * 60 * 1000;
}

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

  async getDayToDateTotal(excludeSmokeTest = true): Promise<number> {
    // Use Europe/Prague timezone for day boundary (consistent with scheduled jobs)
    const now = new Date();
    const pragueOffset = getPragueOffset(now);
    const pragueNow = new Date(now.getTime() + pragueOffset);
    const startOfDayPrague = new Date(
      pragueNow.getFullYear(),
      pragueNow.getMonth(),
      pragueNow.getDate()
    );
    const startOfDayUtc = new Date(startOfDayPrague.getTime() - pragueOffset);

    const query: FilterQuery<ICostLedger> = {
      ts: { $gte: startOfDayUtc },
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
