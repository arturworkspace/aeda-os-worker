import { Types, FilterQuery, UpdateQuery } from 'mongoose';
import { InboxItem, IInboxItem, IInboxItemDocument, ICrmMatch, IRouting, ProcessingStatus } from '../schemas/inboxItem.js';

export interface CreateInboxItemInput {
  recipient: string;
  sender_email: string;
  sender_name: string;
  subject: string;
  body_raw: string;
  received_at: Date;
  message_id: string;
  in_reply_to?: string | null;
}

export const inboxItemRepo = {
  async create(input: CreateInboxItemInput): Promise<IInboxItemDocument> {
    const doc = new InboxItem({
      recipient: input.recipient,
      sender_email: input.sender_email,
      sender_name: input.sender_name,
      subject: input.subject,
      body_raw: input.body_raw,
      body_sanitized: '',
      body_hardened: '',
      received_at: input.received_at,
      message_id: input.message_id,
      in_reply_to: input.in_reply_to ?? null,
      processing_status: 'received',
    });
    return doc.save();
  },

  async findById(id: Types.ObjectId | string): Promise<IInboxItemDocument | null> {
    return InboxItem.findById(id).exec();
  },

  async findByMessageId(messageId: string): Promise<IInboxItemDocument | null> {
    return InboxItem.findOne({ message_id: messageId }).exec();
  },

  async find(query: FilterQuery<IInboxItem>): Promise<IInboxItemDocument[]> {
    return InboxItem.find(query).sort({ received_at: -1 }).exec();
  },

  async updateStatus(
    id: Types.ObjectId | string,
    status: ProcessingStatus,
    error?: string | null
  ): Promise<IInboxItemDocument | null> {
    const update: UpdateQuery<IInboxItem> = { processing_status: status };
    if (error !== undefined) {
      update['processing_error'] = error;
    }
    return InboxItem.findByIdAndUpdate(id, update, { new: true }).exec();
  },

  async updateSanitizedBody(
    id: Types.ObjectId | string,
    sanitized: string,
    hardened: string
  ): Promise<IInboxItemDocument | null> {
    return InboxItem.findByIdAndUpdate(
      id,
      { body_sanitized: sanitized, body_hardened: hardened },
      { new: true }
    ).exec();
  },

  async updateCrmMatch(
    id: Types.ObjectId | string,
    crmMatch: ICrmMatch
  ): Promise<IInboxItemDocument | null> {
    return InboxItem.findByIdAndUpdate(id, { crm_match: crmMatch }, { new: true }).exec();
  },

  async updateRouting(
    id: Types.ObjectId | string,
    routing: Partial<IRouting>
  ): Promise<IInboxItemDocument | null> {
    const updateFields: Record<string, string | null> = {};
    if (routing.artur_classification !== undefined) {
      updateFields['routing.artur_classification'] = routing.artur_classification;
    }
    if (routing.routed_to_agent !== undefined) {
      updateFields['routing.routed_to_agent'] = routing.routed_to_agent;
    }
    if (routing.artur_brief !== undefined) {
      updateFields['routing.artur_brief'] = routing.artur_brief;
    }
    if (routing.lilit_task_id !== undefined) {
      updateFields['routing.lilit_task_id'] = routing.lilit_task_id;
    }
    return InboxItem.findByIdAndUpdate(id, { $set: updateFields }, { new: true }).exec();
  },

  async setDraftId(
    id: Types.ObjectId | string,
    draftId: Types.ObjectId
  ): Promise<IInboxItemDocument | null> {
    return InboxItem.findByIdAndUpdate(id, { draft_id: draftId }, { new: true }).exec();
  },

  async addCost(id: Types.ObjectId | string, costUsd: number): Promise<IInboxItemDocument | null> {
    return InboxItem.findByIdAndUpdate(id, { $inc: { cost_usd: costUsd } }, { new: true }).exec();
  },

  async getRecentByStatus(
    status: ProcessingStatus,
    limit = 50
  ): Promise<IInboxItemDocument[]> {
    return InboxItem.find({ processing_status: status })
      .sort({ received_at: -1 })
      .limit(limit)
      .exec();
  },
};
