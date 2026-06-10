import mongoose, { Schema, Types } from 'mongoose';

export const PACKAGE_TYPES = [
  'external_comms',
  'product_feature',
  'spend',
  'investor_material',
  'technical_change',
  'generic',
] as const;

export type PackageType = (typeof PACKAGE_TYPES)[number];

export const PACKAGE_STATES = [
  'PREPARED',
  'C_LEVEL_REVIEW',
  'AWAITING_FOUNDER',
  'APPROVED',
  'SCHEDULED',
  'EXECUTING',
  'COMPLETED',
  'REJECTED',
  'ROLLED_BACK',
] as const;

export type PackageState = (typeof PACKAGE_STATES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const REVIEW_VERDICTS = ['approve', 'approve_with_conditions', 'reject'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface IStateHistoryEntry {
  from: PackageState | null;
  to: PackageState;
  ts: Date;
  actor: string;
  reason: string | null;
}

export interface ICondition {
  text: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

export interface IReview {
  agentId: string;
  verdict: ReviewVerdict;
  checkedItems: string[];
  conditions: ICondition[];
  reasoning: string;
  ts: Date;
}

export interface IGoalAncestry {
  mission?: string;
  goal?: string;
  project?: string;
  task?: string;
}

export interface ICostEstimate {
  minUsd: number;
  maxUsd: number;
  capUsd: number;
}

export interface IExecutionPackage {
  title: string;
  description: string;
  packageType: PackageType;
  state: PackageState;
  stateHistory: IStateHistoryEntry[];
  preparedBy: string;
  goalAncestry: IGoalAncestry;
  riskLevel: RiskLevel;
  riskNotes: string;
  costEstimate: ICostEstimate | null;
  costActualUsd: number;
  reviews: IReview[];
  requiredSigners: string[];
  vetoHolders: string[];
  scheduledFor: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
  smokeTest: boolean;
}

export type IExecutionPackageDocument = mongoose.HydratedDocument<IExecutionPackage>;

const stateHistorySchema = new Schema<IStateHistoryEntry>(
  {
    from: { type: String, enum: [...PACKAGE_STATES, null], default: null },
    to: { type: String, required: true, enum: PACKAGE_STATES },
    ts: { type: Date, required: true, default: () => new Date() },
    actor: { type: String, required: true },
    reason: { type: String, default: null },
  },
  { _id: false }
);

const conditionSchema = new Schema<ICondition>(
  {
    text: { type: String, required: true },
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false }
);

const reviewSchema = new Schema<IReview>(
  {
    agentId: { type: String, required: true },
    verdict: { type: String, required: true, enum: REVIEW_VERDICTS },
    checkedItems: { type: [String], default: [] },
    conditions: { type: [conditionSchema], default: [] },
    reasoning: { type: String, required: true },
    ts: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false }
);

const goalAncestrySchema = new Schema<IGoalAncestry>(
  {
    mission: { type: String },
    goal: { type: String },
    project: { type: String },
    task: { type: String },
  },
  { _id: false }
);

const costEstimateSchema = new Schema<ICostEstimate>(
  {
    minUsd: { type: Number, required: true },
    maxUsd: { type: Number, required: true },
    capUsd: { type: Number, required: true },
  },
  { _id: false }
);

const executionPackageSchema = new Schema<IExecutionPackage>(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    packageType: { type: String, required: true, enum: PACKAGE_TYPES },
    state: { type: String, required: true, enum: PACKAGE_STATES, default: 'PREPARED' },
    stateHistory: { type: [stateHistorySchema], default: [] },
    preparedBy: { type: String, required: true },
    goalAncestry: { type: goalAncestrySchema, default: {} },
    riskLevel: { type: String, required: true, enum: RISK_LEVELS, default: 'low' },
    riskNotes: { type: String, default: '' },
    costEstimate: { type: costEstimateSchema, default: null },
    costActualUsd: { type: Number, default: 0 },
    reviews: { type: [reviewSchema], default: [] },
    requiredSigners: { type: [String], default: [] },
    vetoHolders: { type: [String], default: [] },
    scheduledFor: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    smokeTest: { type: Boolean, default: false },
  },
  {
    collection: 'os_execution_packages',
    timestamps: true,
  }
);

executionPackageSchema.index({ state: 1 });
executionPackageSchema.index({ packageType: 1 });
executionPackageSchema.index({ preparedBy: 1 });

export const ExecutionPackage = mongoose.model<IExecutionPackage>(
  'ExecutionPackage',
  executionPackageSchema
);
