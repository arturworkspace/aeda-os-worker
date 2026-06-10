import { Budget, IBudget, IBudgetDocument, BudgetScope } from '../schemas/budget.js';

export interface BudgetInput {
  scope: BudgetScope;
  key: string;
  monthlyCapUsd?: number;
  capUsd?: number;
  warnAtPct?: number;
}

export const budgetRepo = {
  async upsert(input: BudgetInput): Promise<IBudgetDocument> {
    const existing = await Budget.findOne({ scope: input.scope, key: input.key }).exec();

    if (existing) {
      if (input.monthlyCapUsd !== undefined) existing.monthlyCapUsd = input.monthlyCapUsd;
      if (input.capUsd !== undefined) existing.capUsd = input.capUsd;
      if (input.warnAtPct !== undefined) existing.warnAtPct = input.warnAtPct;
      return existing.save();
    }

    const doc = new Budget({
      scope: input.scope,
      key: input.key,
      monthlyCapUsd: input.monthlyCapUsd,
      capUsd: input.capUsd,
      warnAtPct: input.warnAtPct ?? 80,
    });
    return doc.save();
  },

  async findByScope(scope: BudgetScope, key: string): Promise<IBudgetDocument | null> {
    return Budget.findOne({ scope, key }).exec();
  },

  async getGlobal(): Promise<IBudgetDocument | null> {
    return Budget.findOne({ scope: 'global', key: 'global' }).exec();
  },

  async getProject(projectKey: string): Promise<IBudgetDocument | null> {
    return Budget.findOne({ scope: 'project', key: projectKey }).exec();
  },

  async getPackage(packageId: string): Promise<IBudgetDocument | null> {
    return Budget.findOne({ scope: 'package', key: packageId }).exec();
  },

  async seedGlobalBudget(): Promise<IBudgetDocument> {
    const existing = await Budget.findOne({ scope: 'global', key: 'global' }).exec();
    if (existing) {
      return existing;
    }

    const doc = new Budget({
      scope: 'global',
      key: 'global',
      monthlyCapUsd: 60,
      warnAtPct: 80,
    });
    return doc.save();
  },
};
