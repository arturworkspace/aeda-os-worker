import { Types } from 'mongoose';
import { AuditLog, AuditEventType, ActorType } from '../db/schemas/auditLog.js';
import { logger } from '../logger.js';

export interface WriteAuditEventInput {
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

export async function writeAuditEvent(input: WriteAuditEventInput): Promise<Types.ObjectId> {
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

  const saved = await doc.save();

  logger.debug(
    { eventType: input.eventType, actor: input.actor, subjectId: input.subjectId?.toString() },
    'audit event written'
  );

  return saved._id as Types.ObjectId;
}
