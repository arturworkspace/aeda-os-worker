import { Types, FilterQuery } from 'mongoose';
import { EmailDraft, IEmailDraft, IEmailDraftDocument, DraftStatus } from '../schemas/emailDraft.js';

export interface CreateEmailDraftInput {
  inbox_item_id: Types.ObjectId;
  drafted_by_agent: string;
  to: string;
  subject: string;
  body: string;
  thread_context?: string;
}

export const emailDraftRepo = {
  async create(input: CreateEmailDraftInput): Promise<IEmailDraftDocument> {
    const doc = new EmailDraft({
      inbox_item_id: input.inbox_item_id,
      drafted_by_agent: input.drafted_by_agent,
      to: input.to,
      subject: input.subject,
      body: input.body,
      thread_context: input.thread_context ?? '',
      status: 'pending',
      created_at: new Date(),
    });
    return doc.save();
  },

  async findById(id: Types.ObjectId | string): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findById(id).exec();
  },

  async findByInboxItemId(inboxItemId: Types.ObjectId | string): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findOne({ inbox_item_id: new Types.ObjectId(inboxItemId.toString()) }).exec();
  },

  async find(query: FilterQuery<IEmailDraft>): Promise<IEmailDraftDocument[]> {
    return EmailDraft.find(query).sort({ created_at: -1 }).exec();
  },

  async updateGmailInfo(
    id: Types.ObjectId | string,
    gmailDraftId: string,
    gmailMessageId: string | null
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findByIdAndUpdate(
      id,
      {
        gmail_draft_id: gmailDraftId,
        gmail_message_id: gmailMessageId,
        status: 'pushed_to_gmail',
        pushed_at: new Date(),
      },
      { new: true }
    ).exec();
  },

  async setPendingSendLabelApplied(
    id: Types.ObjectId | string,
    applied: boolean
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findByIdAndUpdate(
      id,
      { pending_send_label_applied: applied },
      { new: true }
    ).exec();
  },

  async updateStatus(
    id: Types.ObjectId | string,
    status: DraftStatus
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findByIdAndUpdate(id, { status }, { new: true }).exec();
  },

  async getByStatus(status: DraftStatus, limit = 50): Promise<IEmailDraftDocument[]> {
    return EmailDraft.find({ status }).sort({ created_at: -1 }).limit(limit).exec();
  },

  async getByAgent(agent: string, limit = 50): Promise<IEmailDraftDocument[]> {
    return EmailDraft.find({ drafted_by_agent: agent }).sort({ created_at: -1 }).limit(limit).exec();
  },
};
