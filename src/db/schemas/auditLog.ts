import mongoose, { Schema, Document, Types } from 'mongoose';

export const AUDIT_EVENT_TYPES = [
  'package.created',
  'package.transition',
  'review.submitted',
  'llm.call',
  'budget.blocked',
  'budget.warning',
  'memory.written',
  'backup.completed',
  'job.run',
  'config.loaded',
  'email.received',
  'email_processed',
  'email_processing_error',
  'webhook.error',
  'webhook.auth_failed',
  'gmail.warning',
  'gmail.error',
  'investor.followup_draft_created',
  'investor.first_email_draft_created',
  'investor.reply_detected',
  'investor.followup1_trigger_check',
  'investor.followup1_query_result',
  'investor.followup1_existing_draft_skip',
  'investor.followup1_processing_error',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['agent', 'system', 'founder'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface IAuditLog {
  ts: Date;
  actor: string;
  actorType: ActorType;
  eventType: AuditEventType;
  subjectId: Types.ObjectId | null;
  payload: Record<string, unknown> | null;
  llmModel: string | null;
  costUsd: number | null;
  supersedes: Types.ObjectId | null;
  smokeTest: boolean;
}

export type IAuditLogDocument = mongoose.HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog>(
  {
    ts: { type: Date, required: true, default: () => new Date() },
    actor: { type: String, required: true },
    actorType: { type: String, required: true, enum: ACTOR_TYPES },
    eventType: { type: String, required: true, enum: AUDIT_EVENT_TYPES },
    subjectId: { type: Schema.Types.ObjectId, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
    llmModel: { type: String, default: null },
    costUsd: { type: Number, default: null },
    supersedes: { type: Schema.Types.ObjectId, default: null },
    smokeTest: { type: Boolean, default: false },
  },
  {
    collection: 'os_audit_log',
    timestamps: false,
  }
);

auditLogSchema.index({ ts: -1 });
auditLogSchema.index({ subjectId: 1, ts: -1 });
auditLogSchema.index({ eventType: 1, ts: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
