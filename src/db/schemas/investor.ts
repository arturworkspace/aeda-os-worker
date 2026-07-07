import mongoose, { Schema } from 'mongoose';

export interface IActivityLogEntry {
  action: string;
  at: Date;
}

export interface IInvestor {
  name: string;
  firm: string;
  email: string;
  website: string;
  type: 'VC' | 'Angel' | 'Family Office' | 'Corporate' | 'Accelerator';
  stage: 'Research' | 'Outreach' | 'First Contact' | 'Meeting' | 'Due Diligence' | 'Term Sheet' | 'Closed' | 'Passed';
  checkSize: number;
  priority: 1 | 2 | 3;
  source: string;
  lastContact: string;
  nextAction: string;
  nextDate: string;
  notes: string;
  owner: string;
  firstEmailSentAt?: Date;
  followUp1SentAt?: Date;
  followUp2SentAt?: Date;
  repliedAt?: Date;
  emailThreadId?: string;
  activityLog?: IActivityLogEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export type IInvestorDocument = mongoose.HydratedDocument<IInvestor>;

const activityLogSchema = new Schema<IActivityLogEntry>(
  {
    action: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const investorSchema = new Schema<IInvestor>(
  {
    name: { type: String, required: true },
    firm: { type: String, default: '' },
    email: { type: String, default: '' },
    website: { type: String, default: '' },
    type: {
      type: String,
      enum: ['VC', 'Angel', 'Family Office', 'Corporate', 'Accelerator'],
      default: 'VC',
    },
    stage: {
      type: String,
      enum: ['Research', 'Outreach', 'First Contact', 'Meeting', 'Due Diligence', 'Term Sheet', 'Closed', 'Passed'],
      default: 'Research',
    },
    checkSize: { type: Number, default: 0 },
    priority: { type: Number, enum: [1, 2, 3], default: 2 },
    source: { type: String, default: '' },
    lastContact: { type: String, default: '' },
    nextAction: { type: String, default: '' },
    nextDate: { type: String, default: '' },
    notes: { type: String, default: '' },
    owner: { type: String, default: 'artur' },
    firstEmailSentAt: { type: Date, required: false },
    followUp1SentAt: { type: Date, required: false },
    followUp2SentAt: { type: Date, required: false },
    repliedAt: { type: Date, required: false },
    emailThreadId: { type: String, required: false },
    activityLog: { type: [activityLogSchema], default: [] },
  },
  {
    collection: 'investors',
    timestamps: true,
  }
);

investorSchema.index({ email: 1 });
investorSchema.index({ firstEmailSentAt: 1, repliedAt: 1 });

export const Investor = mongoose.model<IInvestor>('Investor', investorSchema);
