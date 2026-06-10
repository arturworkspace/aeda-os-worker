import { Types, FilterQuery } from 'mongoose';
import { Memory, IMemory, IMemoryDocument, MemoryKind } from '../schemas/memory.js';
import { writeAuditEvent } from '../../core/auditLog.js';

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
  structured?: Record<string, unknown> | null;
  sourceRef?: string | null;
  writtenBy: string;
  smokeTest?: boolean;
}

export const memoryRepo = {
  async writeMemory(input: MemoryInput): Promise<IMemoryDocument> {
    const doc = new Memory({
      kind: input.kind,
      content: input.content,
      structured: input.structured ?? null,
      sourceRef: input.sourceRef ?? null,
      version: 1,
      supersedes: null,
      active: true,
      writtenBy: input.writtenBy,
      ts: new Date(),
      smokeTest: input.smokeTest ?? false,
    });
    const saved = await doc.save();

    await writeAuditEvent({
      actor: input.writtenBy,
      actorType: input.writtenBy === 'artur' ? 'founder' : input.writtenBy === 'system' ? 'system' : 'agent',
      eventType: 'memory.written',
      subjectId: saved._id as Types.ObjectId,
      payload: { kind: input.kind, action: 'create' },
      smokeTest: input.smokeTest ?? false,
    });

    return saved;
  },

  async supersedeMemory(
    oldMemoryId: Types.ObjectId | string,
    newContent: string,
    writtenBy: string,
    structured?: Record<string, unknown> | null,
    smokeTest?: boolean
  ): Promise<IMemoryDocument> {
    const oldMemory = await Memory.findById(oldMemoryId).exec();
    if (!oldMemory) {
      throw new Error(`memory not found: ${oldMemoryId}`);
    }

    const newDoc = new Memory({
      kind: oldMemory.kind,
      content: newContent,
      structured: structured ?? oldMemory.structured,
      sourceRef: oldMemory.sourceRef,
      version: oldMemory.version + 1,
      supersedes: oldMemory._id as Types.ObjectId,
      active: true,
      writtenBy,
      ts: new Date(),
      smokeTest: smokeTest ?? oldMemory.smokeTest,
    });
    const saved = await newDoc.save();

    oldMemory.active = false;
    await oldMemory.save();

    await writeAuditEvent({
      actor: writtenBy,
      actorType: writtenBy === 'artur' ? 'founder' : writtenBy === 'system' ? 'system' : 'agent',
      eventType: 'memory.written',
      subjectId: saved._id as Types.ObjectId,
      payload: { kind: oldMemory.kind, action: 'supersede', supersedes: oldMemoryId.toString() },
      smokeTest: smokeTest ?? false,
    });

    return saved;
  },

  async getActiveMemories(kind?: MemoryKind): Promise<IMemoryDocument[]> {
    const query: FilterQuery<IMemory> = { active: true, smokeTest: { $ne: true } };
    if (kind) {
      query['kind'] = kind;
    }
    return Memory.find(query).sort({ ts: -1 }).exec();
  },

  async findById(id: Types.ObjectId | string): Promise<IMemoryDocument | null> {
    return Memory.findById(id).exec();
  },

  async seedFounderPreferences(): Promise<void> {
    const preferences = [
      {
        content: 'always use lowercase "aeda" in all text, code, and communications - never "Aeda" or "AEDA"',
      },
      {
        content: 'aeda is a technology network - never describe it as a CASP, VASP, EMI, or payment processor in any context',
      },
      {
        content: 'prefer prose over bullets in formal documents - narrative flow communicates better than fragmented lists',
      },
      {
        content: 'lead with the strongest signal - the most important point goes first, not buried',
      },
      {
        content: 'provide single consolidated copy-paste outputs - no multiple versions or "here are your options"',
      },
      {
        content: 'data over opinions - every claim needs a number or source, not just assertion',
      },
      {
        content: 'anti-bureaucracy stance - only genuinely new capability clears the bar, not process for its own sake',
      },
      {
        content: 'agents prepare, only artur executes - research and drafts from agents, but final actions require founder approval',
      },
    ];

    for (const pref of preferences) {
      const existing = await Memory.findOne({
        kind: 'founder_preference',
        content: pref.content,
        active: true,
      }).exec();

      if (!existing) {
        await Memory.create({
          kind: 'founder_preference',
          content: pref.content,
          structured: null,
          sourceRef: 'system-seed',
          version: 1,
          supersedes: null,
          active: true,
          writtenBy: 'system',
          ts: new Date(),
          smokeTest: false,
        });
      }
    }
  },

  async deleteTestDocs(): Promise<number> {
    const result = await Memory.deleteMany({ smokeTest: true }).exec();
    return result.deletedCount;
  },
};
