import { Types } from 'mongoose';
import { InvestorPipeline, IInvestorPipelineDocument, ITouchpoint } from '../schemas/investorPipeline.js';

export interface CrmMatchResult {
  matched: boolean;
  investor_id: string | null;
  investor_name: string | null;
  matched_on: 'email' | 'domain' | null;
}

export const investorPipelineRepo = {
  async findByEmail(email: string): Promise<IInvestorPipelineDocument | null> {
    return InvestorPipeline.findOne({ email: email.toLowerCase() }).exec();
  },

  async findByDomain(domain: string): Promise<IInvestorPipelineDocument | null> {
    return InvestorPipeline.findOne({ domain: domain.toLowerCase() }).exec();
  },

  async matchSenderEmail(email: string): Promise<CrmMatchResult> {
    const normalizedEmail = email.toLowerCase();

    const exactMatch = await InvestorPipeline.findOne({ email: normalizedEmail }).exec();
    if (exactMatch) {
      return {
        matched: true,
        investor_id: (exactMatch._id as Types.ObjectId).toString(),
        investor_name: exactMatch.name,
        matched_on: 'email',
      };
    }

    const domain = normalizedEmail.split('@')[1];
    if (domain) {
      const domainMatch = await InvestorPipeline.findOne({ domain: domain.toLowerCase() }).exec();
      if (domainMatch) {
        return {
          matched: true,
          investor_id: (domainMatch._id as Types.ObjectId).toString(),
          investor_name: domainMatch.name,
          matched_on: 'domain',
        };
      }
    }

    return {
      matched: false,
      investor_id: null,
      investor_name: null,
      matched_on: null,
    };
  },

  async updateLastContact(id: Types.ObjectId | string): Promise<IInvestorPipelineDocument | null> {
    return InvestorPipeline.findByIdAndUpdate(
      id,
      { last_contact: new Date() },
      { new: true }
    ).exec();
  },

  async addTouchpoint(
    id: Types.ObjectId | string,
    touchpoint: ITouchpoint
  ): Promise<IInvestorPipelineDocument | null> {
    return InvestorPipeline.findByIdAndUpdate(
      id,
      {
        $push: { touchpoints: touchpoint },
        $set: { last_contact: new Date() },
      },
      { new: true }
    ).exec();
  },

  async logInboundEmail(
    id: Types.ObjectId | string,
    notes = ''
  ): Promise<IInvestorPipelineDocument | null> {
    const touchpoint: ITouchpoint = {
      type: 'email_inbound',
      date: new Date(),
      notes,
    };
    return this.addTouchpoint(id, touchpoint);
  },
};
