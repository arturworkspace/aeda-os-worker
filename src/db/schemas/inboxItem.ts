import mongoose, { Schema, Types } from 'mongoose';

export const PROCESSING_STATUSES = ['received', 'processing', 'draft_created', 'error', 'blocked'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export interface ICrmMatch {
  matched: boolean;
  investor_id: string | null;
  investor_name: string | null;
  matched_on: 'email' | 'domain' | null;
}

export interface IRouting {
  artur_classification: string;
  routed_to_agent: string;
  artur_brief: string;
  lilit_task_id: string | null;
}

export interface IAttachment {
  filename: string;
  mimeType: string;
  size: number;
  text_content: string;
}

export interface IInboxItem {
  recipient: string;
  sender_email: string;
  sender_name: string;
  subject: string;
  body_raw: string;
  body_sanitized: string;
  body_hardened: string;
  body_text: string;
  body_html: string;
  attachments: IAttachment[];
  agent_commentary: string;
  draft_text: string;
  received_at: Date;
  message_id: string;
  in_reply_to: string | null;
  crm_match: ICrmMatch;
  routing: IRouting;
  draft_id: Types.ObjectId | null;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  cost_usd: number;
}

export type IInboxItemDocument = mongoose.HydratedDocument<IInboxItem>;

const crmMatchSchema = new Schema<ICrmMatch>(
  {
    matched: { type: Boolean, required: true, default: false },
    investor_id: { type: String, default: null },
    investor_name: { type: String, default: null },
    matched_on: { type: String, enum: ['email', 'domain', null], default: null },
  },
  { _id: false }
);

const routingSchema = new Schema<IRouting>(
  {
    artur_classification: { type: String, default: '' },
    routed_to_agent: { type: String, default: '' },
    artur_brief: { type: String, default: '' },
    lilit_task_id: { type: String, default: null },
  },
  { _id: false }
);

const attachmentSchema = new Schema<IAttachment>(
  {
    filename: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    text_content: { type: String, default: '' },
  },
  { _id: false }
);

const inboxItemSchema = new Schema<IInboxItem>(
  {
    recipient: { type: String, required: true },
    sender_email: { type: String, required: true },
    sender_name: { type: String, default: '' },
    subject: { type: String, default: '' },
    body_raw: { type: String, default: '' },
    body_sanitized: { type: String, default: '' },
    body_hardened: { type: String, default: '' },
    body_text: { type: String, default: '' },
    body_html: { type: String, default: '' },
    attachments: { type: [attachmentSchema], default: [] },
    agent_commentary: { type: String, default: '' },
    draft_text: { type: String, default: '' },
    received_at: { type: Date, required: true },
    message_id: { type: String, required: true, unique: true },
    in_reply_to: { type: String, default: null },
    crm_match: { type: crmMatchSchema, default: () => ({ matched: false, investor_id: null, investor_name: null, matched_on: null }) },
    routing: { type: routingSchema, default: () => ({ artur_classification: '', routed_to_agent: '', artur_brief: '', lilit_task_id: null }) },
    draft_id: { type: Schema.Types.ObjectId, ref: 'EmailDraft', default: null },
    processing_status: { type: String, enum: PROCESSING_STATUSES, default: 'received' },
    processing_error: { type: String, default: null },
    cost_usd: { type: Number, default: 0 },
  },
  {
    collection: 'os_inbox_items',
    timestamps: true,
  }
);

inboxItemSchema.index({ sender_email: 1 });
inboxItemSchema.index({ processing_status: 1 });
inboxItemSchema.index({ received_at: -1 });

export const InboxItem = mongoose.model<IInboxItem>('InboxItem', inboxItemSchema);
