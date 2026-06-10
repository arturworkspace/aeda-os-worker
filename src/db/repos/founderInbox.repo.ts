import { FounderInbox, IFounderInboxDocument } from '../schemas/founderInbox.js';

export interface FounderInboxInput {
  source: string;
  title: string;
  content: string;
  smokeTest?: boolean;
}

export const founderInboxRepo = {
  async insert(input: FounderInboxInput): Promise<IFounderInboxDocument> {
    const doc = new FounderInbox({
      ts: new Date(),
      source: input.source,
      title: input.title,
      content: input.content,
      read: false,
      smokeTest: input.smokeTest ?? false,
    });
    return doc.save();
  },

  async getUnread(): Promise<IFounderInboxDocument[]> {
    return FounderInbox.find({ read: false, smokeTest: { $ne: true } })
      .sort({ ts: -1 })
      .exec();
  },

  async markRead(id: string): Promise<IFounderInboxDocument | null> {
    return FounderInbox.findByIdAndUpdate(id, { $set: { read: true } }, { new: true }).exec();
  },

  async deleteTestDocs(): Promise<number> {
    const result = await FounderInbox.deleteMany({ smokeTest: true }).exec();
    return result.deletedCount;
  },
};
