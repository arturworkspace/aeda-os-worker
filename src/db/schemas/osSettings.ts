import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IOsSettings extends Document {
  key: string;
  outreachPaused: boolean;
  outreachPausedAt?: Date;
  outreachPausedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OsSettingsSchema = new Schema<IOsSettings>(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    outreachPaused: { type: Boolean, default: false },
    outreachPausedAt: { type: Date, required: false },
    outreachPausedBy: { type: String, required: false },
  },
  { timestamps: true, collection: 'os_settings' }
);

export const OsSettings: Model<IOsSettings> =
  mongoose.models['OsSettings'] ||
  mongoose.model<IOsSettings>('OsSettings', OsSettingsSchema);
