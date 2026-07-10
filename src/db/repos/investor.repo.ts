import { Types } from 'mongoose';
import { Investor, IInvestorDocument } from '../schemas/investor.js';

export const investorRepo = {
  /**
   * Find investors needing follow-up 1:
   * - firstEmailSentAt is set
   * - repliedAt is NOT set
   * - followUp1SentAt is NOT set
   */
  async findNeedingFollowUp1(): Promise<IInvestorDocument[]> {
    return Investor.find({
      firstEmailSentAt: { $exists: true, $ne: null },
      repliedAt: { $exists: false },
      followUp1SentAt: { $exists: false },
    }).exec();
  },

  /**
   * Find investors needing follow-up 2:
   * - followUp1SentAt is set
   * - repliedAt is NOT set
   * - followUp2SentAt is NOT set
   */
  async findNeedingFollowUp2(): Promise<IInvestorDocument[]> {
    return Investor.find({
      followUp1SentAt: { $exists: true, $ne: null },
      repliedAt: { $exists: false },
      followUp2SentAt: { $exists: false },
    }).exec();
  },

  /**
   * Mark follow-up 1 as sent
   */
  async markFollowUp1Sent(id: Types.ObjectId | string): Promise<IInvestorDocument | null> {
    const now = new Date();
    return Investor.findByIdAndUpdate(
      id,
      {
        followUp1SentAt: now,
        $push: { activityLog: { action: 'followup1_draft_created', at: now } },
      },
      { new: true }
    ).exec();
  },

  /**
   * Mark follow-up 2 as sent
   */
  async markFollowUp2Sent(id: Types.ObjectId | string): Promise<IInvestorDocument | null> {
    const now = new Date();
    return Investor.findByIdAndUpdate(
      id,
      {
        followUp2SentAt: now,
        $push: { activityLog: { action: 'followup2_draft_created', at: now } },
      },
      { new: true }
    ).exec();
  },

  /**
   * Get investor by ID
   */
  async findById(id: Types.ObjectId | string): Promise<IInvestorDocument | null> {
    return Investor.findById(id).exec();
  },

  /**
   * Find investors with emailThreadId set but no reply yet
   */
  async findAwaitingReply(): Promise<IInvestorDocument[]> {
    return Investor.find({
      emailThreadId: { $exists: true, $nin: [null, ''] },
      hasReply: { $ne: true },
    }).exec();
  },

  /**
   * Mark investor as having received a reply (stops cadence)
   */
  async markReplyReceived(
    id: Types.ObjectId | string,
    sentiment: 'positive' | 'negative'
  ): Promise<IInvestorDocument | null> {
    const now = new Date();
    return Investor.findByIdAndUpdate(
      id,
      {
        hasReply: true,
        replyReceivedAt: now,
        replySentiment: sentiment,
        stageConfirmed: false,
        $push: { activityLog: { action: `reply_received_${sentiment}`, at: now } },
      },
      { new: true }
    ).exec();
  },

  /**
   * Confirm the sentiment classification (Artur reviewed it)
   */
  async confirmStage(id: Types.ObjectId | string): Promise<IInvestorDocument | null> {
    const now = new Date();
    return Investor.findByIdAndUpdate(
      id,
      {
        stageConfirmed: true,
        $push: { activityLog: { action: 'stage_confirmed', at: now } },
      },
      { new: true }
    ).exec();
  },

  /**
   * Correct sentiment classification (move between Answered <-> Rejected)
   */
  async correctSentiment(
    id: Types.ObjectId | string,
    newSentiment: 'positive' | 'negative'
  ): Promise<IInvestorDocument | null> {
    const now = new Date();
    return Investor.findByIdAndUpdate(
      id,
      {
        replySentiment: newSentiment,
        stageConfirmed: true,
        $push: { activityLog: { action: `sentiment_corrected_to_${newSentiment}`, at: now } },
      },
      { new: true }
    ).exec();
  },

  /**
   * Find investors with gmail_thread_id on their drafts (for reply detection)
   */
  async findWithGmailThread(): Promise<IInvestorDocument[]> {
    return Investor.find({
      firstEmailSentAt: { $exists: true, $ne: null },
      hasReply: { $ne: true },
    }).exec();
  },
};
