import mongoose, { Schema, Types } from 'mongoose';

// Do NOT invent data. Every non-null field must trace to a source in `sources`.
// Missing information stays null — surfaces as "Not found" in the UI, not an error.
// status tracks job lifecycle (pending/running/completed/failed), NOT content
// verification — trust signal comes from contact.confidence and null-vs-populated fields.

export interface IInvestorResearchContact {
  name: string | null;
  email: string | null;
  confidence: 'verified' | 'inferred' | null;
  linkedIn: string | null;
}

export interface IInvestorResearchSource {
  url: string;
  title: string;
  fetchedAt: Date;
}

export interface IDimensionScore {
  score: number;
  reasoning: string;
}

export interface IRelevanceScore {
  thesis: IDimensionScore | null;
  stage: IDimensionScore | null;
  geo: IDimensionScore | null;
  checkSize: IDimensionScore | null;
  portfolio: IDimensionScore | null;
  impact: IDimensionScore | null;
  network: IDimensionScore | null;
  overallPriority: 'High' | 'Medium' | 'Low' | null;
  bestOutreachAngle: string | null;
  bestContactPerson: string | null;
  scoredAt: Date | null;
}

export interface IInvestorResearch {
  investorId: Types.ObjectId;
  thesis: string | null;
  stage: string | null;
  checkSize: string | null;
  geoFocus: string[] | null;
  portfolioCompanies: string[];
  recentActivity: string | null;
  contact: IInvestorResearchContact;
  sources: IInvestorResearchSource[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string | null;
  relevanceScore: IRelevanceScore | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IInvestorResearchDocument = mongoose.HydratedDocument<IInvestorResearch>;

const contactSchema = new Schema<IInvestorResearchContact>(
  {
    name: { type: String, default: null },
    email: { type: String, default: null },
    confidence: { type: String, enum: ['verified', 'inferred', null], default: null },
    linkedIn: { type: String, default: null },
  },
  { _id: false }
);

const sourceSchema = new Schema<IInvestorResearchSource>(
  {
    url: { type: String, required: true },
    title: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
  },
  { _id: false }
);

const dimensionScoreSchema = new Schema<IDimensionScore>(
  {
    score: { type: Number, required: true, min: 1, max: 10 },
    reasoning: { type: String, required: true },
  },
  { _id: false }
);

const relevanceScoreSchema = new Schema<IRelevanceScore>(
  {
    thesis: { type: dimensionScoreSchema, default: null },
    stage: { type: dimensionScoreSchema, default: null },
    geo: { type: dimensionScoreSchema, default: null },
    checkSize: { type: dimensionScoreSchema, default: null },
    portfolio: { type: dimensionScoreSchema, default: null },
    impact: { type: dimensionScoreSchema, default: null },
    network: { type: dimensionScoreSchema, default: null },
    overallPriority: { type: String, enum: ['High', 'Medium', 'Low', null], default: null },
    bestOutreachAngle: { type: String, default: null },
    bestContactPerson: { type: String, default: null },
    scoredAt: { type: Date, default: null },
  },
  { _id: false }
);

const investorResearchSchema = new Schema<IInvestorResearch>(
  {
    investorId: { type: Schema.Types.ObjectId, required: true, index: true },
    thesis: { type: String, default: null },
    stage: { type: String, default: null },
    checkSize: { type: String, default: null },
    geoFocus: { type: [String], default: null },
    portfolioCompanies: { type: [String], default: [] },
    recentActivity: { type: String, default: null },
    contact: { type: contactSchema, default: () => ({ name: null, email: null, confidence: null, linkedIn: null }) },
    sources: { type: [sourceSchema], default: [] },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    error: { type: String, default: null },
    relevanceScore: { type: relevanceScoreSchema, default: null },
  },
  {
    collection: 'os_investor_research',
    timestamps: true,
  }
);

investorResearchSchema.index({ investorId: 1, createdAt: -1 });

export const InvestorResearch = mongoose.model<IInvestorResearch>('InvestorResearch', investorResearchSchema);
