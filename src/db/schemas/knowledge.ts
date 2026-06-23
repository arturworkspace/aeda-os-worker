import mongoose, { Schema, type Document } from 'mongoose';

export interface IKnowledgeEntry extends Document {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  relevantAgents: string[];
  source: string;
  sourceType: string;
  rawContent: string;
  actionItems: string[];
  permanent: boolean;
  expiresAt: Date;
  status: string;
  scope: string;
  targetAgent?: string;
  trustLevel: string;
  confidence?: string;
  verificationStatus: string;
  verificationSources: string[];
  verificationNotes: string;
  addedBy: string;
  signalScore?: number;
  noiseFlag?: boolean;
  strategicImplication?: string;
  actionRequired?: boolean;
  arturAction?: string;
  scoredAt?: Date;
}

const KnowledgeEntrySchema = new Schema<IKnowledgeEntry>(
  {
    title:              { type: String, required: true },
    summary:            { type: String, required: true },
    category:           { type: String, default: 'general' },
    tags:               [{ type: String }],
    relevantAgents:     [{ type: String }],
    source:             { type: String, default: 'hasmik' },
    sourceType:         { type: String, default: 'article' },
    rawContent:         { type: String, default: '' },
    actionItems:        [{ type: String }],
    permanent:          { type: Boolean, default: false },
    expiresAt:          { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    status:             { type: String, default: 'active' },
    scope:              { type: String, default: 'organization' },
    targetAgent:        { type: String },
    trustLevel:         { type: String, default: 'signal' },
    confidence:         { type: String },
    verificationStatus: { type: String, default: 'unverifiable' },
    verificationSources:[{ type: String }],
    verificationNotes:  { type: String, default: '' },
    addedBy:            { type: String, default: 'hasmik' },
    signalScore:        { type: Number, min: 1, max: 10 },
    noiseFlag:          { type: Boolean, default: false },
    strategicImplication: { type: String, default: '' },
    actionRequired:     { type: Boolean, default: false },
    arturAction:        { type: String, default: '' },
    scoredAt:           { type: Date },
  },
  { timestamps: true }
);

// Use existing collection name from workspace
const modelName = 'Knowledge';
export const KnowledgeEntryModel =
  mongoose.models[modelName] ??
  mongoose.model<IKnowledgeEntry>(modelName, KnowledgeEntrySchema);
