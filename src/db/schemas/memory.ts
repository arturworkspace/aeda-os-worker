import mongoose, { Schema, Types } from 'mongoose';

export const MEMORY_KINDS = ['founder_preference', 'decision', 'fact', 'episode'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface IMemory {
  kind: MemoryKind;
  content: string;
  structured: Record<string, unknown> | null;
  sourceRef: string | null;
  version: number;
  supersedes: Types.ObjectId | null;
  active: boolean;
  writtenBy: string;
  ts: Date;
  smokeTest: boolean;
}

export type IMemoryDocument = mongoose.HydratedDocument<IMemory>;

const memorySchema = new Schema<IMemory>(
  {
    kind: { type: String, required: true, enum: MEMORY_KINDS },
    content: { type: String, required: true },
    structured: { type: Schema.Types.Mixed, default: null },
    sourceRef: { type: String, default: null },
    version: { type: Number, required: true, default: 1 },
    supersedes: { type: Schema.Types.ObjectId, default: null },
    active: { type: Boolean, required: true, default: true },
    writtenBy: { type: String, required: true },
    ts: { type: Date, required: true, default: () => new Date() },
    smokeTest: { type: Boolean, default: false },
  },
  {
    collection: 'os_memory',
    timestamps: false,
  }
);

memorySchema.index({ kind: 1, active: 1 });
memorySchema.index({ supersedes: 1 });
memorySchema.index({ ts: -1 });

export const Memory = mongoose.model<IMemory>('Memory', memorySchema);
