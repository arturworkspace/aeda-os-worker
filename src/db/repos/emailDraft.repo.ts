import { Types, FilterQuery } from 'mongoose';
import { EmailDraft, IEmailDraft, IEmailDraftDocument, DraftStatus, IComplianceFlag } from '../schemas/emailDraft.js';

export interface CreateEmailDraftInput {
  inbox_item_id?: Types.ObjectId | null;
  drafted_by_agent: string;
  to: string;
  subject: string;
  body: string;
  thread_context?: string;
  investorId?: Types.ObjectId;
  followUpStage?: 'followup1' | 'followup2';
  // First-outreach email fields
  draftType?: 'first_email' | 'followup';
  subjectOptions?: string[];
  personalizationReasoning?: string;
  qualityScore?: number;
  contactConfidence?: 'verified' | 'inferred' | null;
  // Compliance pre-filter flags
  complianceFlags?: IComplianceFlag[];
  // Test mode fields
  isTestMode?: boolean;
  realRecipient?: string;
}

export const emailDraftRepo = {
  async create(input: CreateEmailDraftInput): Promise<IEmailDraftDocument> {
    const doc = new EmailDraft({
      inbox_item_id: input.inbox_item_id ?? null,
      drafted_by_agent: input.drafted_by_agent,
      to: input.to,
      subject: input.subject,
      body: input.body,
      thread_context: input.thread_context ?? '',
      status: 'pending',
      created_at: new Date(),
      investorId: input.investorId,
      followUpStage: input.followUpStage,
      draftType: input.draftType,
      subjectOptions: input.subjectOptions,
      personalizationReasoning: input.personalizationReasoning,
      qualityScore: input.qualityScore,
      contactConfidence: input.contactConfidence,
      complianceFlags: input.complianceFlags,
      isTestMode: input.isTestMode,
      realRecipient: input.realRecipient,
    });
    return doc.save();
  },

  /**
   * Atomically create a first_email draft only if one doesn't already exist.
   * Returns { created: true, draft } if newly created, { created: false, draft } if exists.
   * Uses findOneAndUpdate with upsert to prevent race conditions.
   */
  async createFirstEmailIfNotExists(
    input: CreateEmailDraftInput
  ): Promise<{ created: boolean; draft: IEmailDraftDocument }> {
    if (!input.investorId || input.draftType !== 'first_email') {
      throw new Error('createFirstEmailIfNotExists requires investorId and draftType=first_email');
    }

    // First check if a draft already exists
    const existingDraft = await EmailDraft.findOne({
      investorId: input.investorId,
      draftType: 'first_email',
      status: { $ne: 'sent' },
    }).exec();

    if (existingDraft) {
      return { created: false, draft: existingDraft };
    }

    // Try to create a new draft - the unique partial index will prevent duplicates
    try {
      const doc = new EmailDraft({
        inbox_item_id: input.inbox_item_id ?? null,
        drafted_by_agent: input.drafted_by_agent,
        to: input.to,
        subject: input.subject,
        body: input.body,
        thread_context: input.thread_context ?? '',
        status: 'pending',
        created_at: new Date(),
        investorId: input.investorId,
        draftType: input.draftType,
        subjectOptions: input.subjectOptions,
        personalizationReasoning: input.personalizationReasoning,
        qualityScore: input.qualityScore,
        contactConfidence: input.contactConfidence,
        complianceFlags: input.complianceFlags,
        isTestMode: input.isTestMode,
        realRecipient: input.realRecipient,
      });
      const draft = await doc.save();
      return { created: true, draft };
    } catch (err: unknown) {
      // E11000 duplicate key error = another request just created this draft
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        const draft = await EmailDraft.findOne({
          investorId: input.investorId,
          draftType: 'first_email',
          status: { $ne: 'sent' },
        }).exec();
        if (draft) {
          return { created: false, draft };
        }
      }
      throw err;
    }
  },

  async findByInvestorAndStage(
    investorId: Types.ObjectId | string,
    followUpStage: 'followup1' | 'followup2'
  ): Promise<IEmailDraftDocument | null> {
    // Force primary read. Added 2026-07-14: this is the "existing draft" duplicate
    // check gating follow-up creation in investor.followUpScheduler.ts. It had no
    // readPreference override (unlike investor.repo.ts's findNeedingFollowUp1/2,
    // hardened earlier the same day) and is a plausible narrower home for the same
    // long-lived-connection-vs-fresh-connection staleness pattern we've been chasing:
    // a stale/phantom read here would silently skip draft creation with no error,
    // exactly matching the observed symptom (success:true, draftsCreated:0).
    return EmailDraft.findOne({
      investorId: new Types.ObjectId(investorId.toString()),
      followUpStage,
    })
      .read('primary')
      .exec();
  },

  async findByInvestorAndDraftType(
    investorId: Types.ObjectId | string,
    draftType: 'first_email' | 'followup'
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findOne({
      investorId: new Types.ObjectId(investorId.toString()),
      draftType,
    }).exec();
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
    gmailMessageId: string | null,
    gmailThreadId?: string | null,
    gmailRfc822MessageId?: string | null
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findByIdAndUpdate(
      id,
      {
        gmail_draft_id: gmailDraftId,
        gmail_message_id: gmailMessageId,
        gmail_thread_id: gmailThreadId ?? null,
        gmail_rfc822_message_id: gmailRfc822MessageId ?? null,
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

  async findPendingSendStatus(): Promise<IEmailDraftDocument[]> {
    return EmailDraft.find({
      status: 'pushed_to_gmail',
      gmail_draft_id: { $exists: true, $ne: null },
    }).exec();
  },

  async markAsSent(
    id: Types.ObjectId | string,
    sentAt: Date
  ): Promise<IEmailDraftDocument | null> {
    return EmailDraft.findByIdAndUpdate(
      id,
      {
        status: 'sent',
        sent_at: sentAt,
      },
      { new: true }
    ).exec();
  },
};
