import mongoose, { Schema } from 'mongoose';

export interface ICostDaily {
  date: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
  byAgent: Record<string, { costUsd: number; calls: number }>;
  byTier: Record<string, { costUsd: number; calls: number }>;
  byModel: Record<string, { costUsd: number; calls: number }>;
}

export type ICostDailyDocument = mongoose.HydratedDocument<ICostDaily>;

const costDailySchema = new Schema<ICostDaily>(
  {
    date: { type: String, required: true },
    totalCostUsd: { type: Number, required: true },
    totalInputTokens: { type: Number, required: true },
    totalOutputTokens: { type: Number, required: true },
    callCount: { type: Number, required: true },
    byAgent: { type: Schema.Types.Mixed, default: {} },
    byTier: { type: Schema.Types.Mixed, default: {} },
    byModel: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'os_cost_daily',
    timestamps: true,
  }
);

costDailySchema.index({ date: 1 }, { unique: true });

export const CostDaily = mongoose.model<ICostDaily>('CostDaily', costDailySchema);
