import mongoose, { Schema, Types } from 'mongoose';

export const DRAFT_STATUSES = ['pending', 'pushed_to_gmail', 'sent', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface IEmailDraft {
  inbox_item_id: Types.ObjectId | null;
  drafted_by_agent: string;
  to: string;
  subject: string;
  body: string;
  thread_context: string;
  gmail_draft_id: string | null;
  gmail_message_id: string | null;
  pending_send_label_applied: boolean;
  status: DraftStatus;
  created_at: Date;
  pushed_at: Date | null;
  // Investor follow-up metadata (optional)
  investorId?: Types.ObjectId;
  followUpStage?: 'followup1' | 'followup2';
}

export type IEmailDraftDocument = mongoose.HydratedDocument<IEmailDraft>;

const emailDraftSchema = new Schema<IEmailDraft>(
  {
    inbox_item_id: { type: Schema.Types.ObjectId, ref: 'InboxItem', required: false, default: null },
    drafted_by_agent: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    thread_context: { type: String, default: '' },
    gmail_draft_id: { type: String, default: null },
    gmail_message_id: { type: String, default: null },
    pending_send_label_applied: { type: Boolean, default: false },
    status: { type: String, enum: DRAFT_STATUSES, default: 'pending' },
    created_at: { type: Date, default: () => new Date() },
    pushed_at: { type: Date, default: null },
    // Investor follow-up metadata
    investorId: { type: Schema.Types.ObjectId, ref: 'Investor', required: false },
    followUpStage: { type: String, enum: ['followup1', 'followup2'], required: false },
  },
  {
    collection: 'os_email_drafts',
    timestamps: true,
  }
);

emailDraftSchema.index({ inbox_item_id: 1 });
emailDraftSchema.index({ status: 1 });
emailDraftSchema.index({ drafted_by_agent: 1 });
emailDraftSchema.index({ investorId: 1, followUpStage: 1 });

export const EmailDraft = mongoose.model<IEmailDraft>('EmailDraft', emailDraftSchema);
