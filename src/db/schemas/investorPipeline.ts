import mongoose, { Schema } from 'mongoose';

export interface ITouchpoint {
  type: 'email_inbound' | 'email_outbound' | 'meeting' | 'call' | 'other';
  date: Date;
  notes: string;
}

export interface IInvestorPipeline {
  name: string;
  email: string;
  domain: string;
  firm: string;
  stage: 'lead' | 'contacted' | 'meeting' | 'due_diligence' | 'term_sheet' | 'closed' | 'passed';
  last_contact: Date | null;
  touchpoints: ITouchpoint[];
  notes: string;
}

export type IInvestorPipelineDocument = mongoose.HydratedDocument<IInvestorPipeline>;

const touchpointSchema = new Schema<ITouchpoint>(
  {
    type: { type: String, enum: ['email_inbound', 'email_outbound', 'meeting', 'call', 'other'], required: true },
    date: { type: Date, required: true },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const investorPipelineSchema = new Schema<IInvestorPipeline>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    domain: { type: String, required: true },
    firm: { type: String, default: '' },
    stage: {
      type: String,
      enum: ['lead', 'contacted', 'meeting', 'due_diligence', 'term_sheet', 'closed', 'passed'],
      default: 'lead',
    },
    last_contact: { type: Date, default: null },
    touchpoints: { type: [touchpointSchema], default: [] },
    notes: { type: String, default: '' },
  },
  {
    collection: 'investor_pipeline',
    timestamps: true,
  }
);

investorPipelineSchema.index({ email: 1 });
investorPipelineSchema.index({ domain: 1 });

export const InvestorPipeline = mongoose.model<IInvestorPipeline>('InvestorPipeline', investorPipelineSchema);
