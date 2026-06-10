import mongoose, { Schema } from 'mongoose';

export interface IFounderInbox {
  ts: Date;
  source: string;
  title: string;
  content: string;
  read: boolean;
  smokeTest: boolean;
}

export type IFounderInboxDocument = mongoose.HydratedDocument<IFounderInbox>;

const founderInboxSchema = new Schema<IFounderInbox>(
  {
    ts: { type: Date, required: true, default: () => new Date() },
    source: { type: String, required: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    read: { type: Boolean, default: false },
    smokeTest: { type: Boolean, default: false },
  },
  {
    collection: 'os_founder_inbox',
    timestamps: false,
  }
);

founderInboxSchema.index({ ts: -1 });
founderInboxSchema.index({ read: 1, ts: -1 });

export const FounderInbox = mongoose.model<IFounderInbox>('FounderInbox', founderInboxSchema);
