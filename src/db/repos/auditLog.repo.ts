import { Types, FilterQuery } from 'mongoose';
import { AuditLog, IAuditLog, IAuditLogDocument, AuditEventType, ActorType } from '../schemas/auditLog.js';

export interface AuditLogInput {
  actor: string;
  actorType: ActorType;
  eventType: AuditEventType;
  subjectId?: Types.ObjectId | null;
  payload?: Record<string, unknown> | null;
  llmModel?: string | null;
  costUsd?: number | null;
  supersedes?: Types.ObjectId | null;
  smokeTest?: boolean;
}

export const auditLogRepo = {
  async insert(input: AuditLogInput): Promise<IAuditLogDocument> {
    const doc = new AuditLog({
      ts: new Date(),
      actor: input.actor,
      actorType: input.actorType,
      eventType: input.eventType,
      subjectId: input.subjectId ?? null,
      payload: input.payload ?? null,
      llmModel: input.llmModel ?? null,
      costUsd: input.costUsd ?? null,
      supersedes: input.supersedes ?? null,
      smokeTest: input.smokeTest ?? false,
    });
    return doc.save();
  },

  async find(query: FilterQuery<IAuditLog>): Promise<IAuditLogDocument[]> {
    return AuditLog.find(query).sort({ ts: -1 }).exec();
  },

  async findOne(query: FilterQuery<IAuditLog>): Promise<IAuditLogDocument | null> {
    return AuditLog.findOne(query).exec();
  },

  async countByEventType(
    eventType: AuditEventType,
    since: Date,
    until?: Date
  ): Promise<number> {
    const query: FilterQuery<IAuditLog> = {
      eventType,
      ts: { $gte: since },
    };
    if (until) {
      query['ts'] = { $gte: since, $lt: until };
    }
    return AuditLog.countDocuments(query).exec();
  },

  async getEventCountsByType(since: Date, until: Date): Promise<Record<string, number>> {
    const results = await AuditLog.aggregate([
      { $match: { ts: { $gte: since, $lt: until }, smokeTest: { $ne: true } } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
    ]).exec();

    const counts: Record<string, number> = {};
    for (const r of results) {
      counts[r._id as string] = r.count as number;
    }
    return counts;
  },

  async deleteTestDocs(): Promise<number> {
    const result = await AuditLog.deleteMany({ smokeTest: true }).exec();
    return result.deletedCount;
  },
};
