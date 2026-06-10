import mongoose, { Schema, Types } from 'mongoose';
import type { Tier } from '../../config/pricing.js';

export interface ICostLedger {
  ts: Date;
  agentOrJob: string;
  packageId: Types.ObjectId | null;
  projectKey: string | null;
  llmModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedMaxUsd: number;
  tier: Tier;
  smokeTest: boolean;
}

export type ICostLedgerDocument = mongoose.HydratedDocument<ICostLedger>;

const costLedgerSchema = new Schema<ICostLedger>(
  {
    ts: { type: Date, required: true, default: () => new Date() },
    agentOrJob: { type: String, required: true },
    packageId: { type: Schema.Types.ObjectId, default: null },
    projectKey: { type: String, default: null },
    llmModel: { type: String, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
    costUsd: { type: Number, required: true },
    estimatedMaxUsd: { type: Number, required: true },
    tier: { type: String, required: true, enum: ['frontier', 'production', 'background'] },
    smokeTest: { type: Boolean, default: false },
  },
  {
    collection: 'os_cost_ledger',
    timestamps: false,
  }
);

costLedgerSchema.index({ ts: -1 });
costLedgerSchema.index({ agentOrJob: 1, ts: -1 });
costLedgerSchema.index({ packageId: 1, ts: -1 });
costLedgerSchema.index({ projectKey: 1, ts: -1 });

export const CostLedger = mongoose.model<ICostLedger>('CostLedger', costLedgerSchema);
