import mongoose, { Schema } from 'mongoose';

export const BUDGET_SCOPES = ['global', 'project', 'package'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export interface IBudget {
  scope: BudgetScope;
  key: string;
  monthlyCapUsd: number | undefined;
  capUsd: number | undefined;
  warnAtPct: number;
}

export type IBudgetDocument = mongoose.HydratedDocument<IBudget>;

const budgetSchema = new Schema<IBudget>(
  {
    scope: { type: String, required: true, enum: BUDGET_SCOPES },
    key: { type: String, required: true },
    monthlyCapUsd: { type: Number },
    capUsd: { type: Number },
    warnAtPct: { type: Number, default: 80 },
  },
  {
    collection: 'os_budgets',
    timestamps: true,
  }
);

budgetSchema.index({ scope: 1, key: 1 }, { unique: true });

export const Budget = mongoose.model<IBudget>('Budget', budgetSchema);
