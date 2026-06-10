import { Types } from 'mongoose';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import {
  executionPackageRepo,
  CreatePackageInput,
} from '../db/repos/executionPackage.repo.js';
import {
  PackageState,
  PackageType,
  IExecutionPackageDocument,
  IReview,
} from '../db/schemas/executionPackage.js';
import { writeAuditEvent } from './auditLog.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const approvalMatrixEntrySchema = z.object({
  requiredSigners: z.array(z.string()),
  vetoHolders: z.array(z.string()),
  addSignerIfCostBearing: z.string().optional(),
});

const approvalMatrixSchema = z.record(approvalMatrixEntrySchema);

type ApprovalMatrix = z.infer<typeof approvalMatrixSchema>;

let approvalMatrix: ApprovalMatrix | null = null;
let approvalMatrixHash: string | null = null;

export function loadApprovalMatrix(): ApprovalMatrix {
  const configPath = join(__dirname, '..', 'config', 'approvalMatrix.json');
  const content = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  const validated = approvalMatrixSchema.parse(parsed);

  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  if (hash !== approvalMatrixHash) {
    approvalMatrixHash = hash;
    logger.info({ hash }, 'approval matrix loaded');
  }

  approvalMatrix = validated;
  return validated;
}

export async function logApprovalMatrixLoaded(): Promise<void> {
  await writeAuditEvent({
    actor: 'system',
    actorType: 'system',
    eventType: 'config.loaded',
    payload: { config: 'approvalMatrix', hash: approvalMatrixHash },
  });
}

export function getApprovalMatrix(): ApprovalMatrix {
  if (!approvalMatrix) {
    return loadApprovalMatrix();
  }
  return approvalMatrix;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly packageId: string,
    public readonly fromState: PackageState,
    public readonly toState: PackageState,
    public readonly reason: string
  ) {
    super(`illegal transition for package ${packageId}: ${fromState} → ${toState} - ${reason}`);
    this.name = 'IllegalTransitionError';
  }
}

const LEGAL_TRANSITIONS: Record<PackageState, PackageState[]> = {
  PREPARED: ['C_LEVEL_REVIEW'],
  C_LEVEL_REVIEW: ['AWAITING_FOUNDER'],
  AWAITING_FOUNDER: ['APPROVED', 'REJECTED'],
  APPROVED: ['SCHEDULED', 'EXECUTING'],
  SCHEDULED: ['EXECUTING'],
  EXECUTING: ['COMPLETED', 'ROLLED_BACK'],
  COMPLETED: [],
  REJECTED: [],
  ROLLED_BACK: [],
};

function mentionsEurcOrEurAmd(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('eurc') || lower.includes('eur→amd') || lower.includes('eur-amd') || lower.includes('eur to amd');
}

export interface CreatePackageOptions {
  title: string;
  description: string;
  packageType: PackageType;
  preparedBy: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  riskNotes?: string;
  costEstimate?: { minUsd: number; maxUsd: number; capUsd: number };
  goalAncestry?: { mission?: string; goal?: string; project?: string; task?: string };
  smokeTest?: boolean;
}

export async function createPackage(
  options: CreatePackageOptions
): Promise<IExecutionPackageDocument> {
  const matrix = getApprovalMatrix();
  const config = matrix[options.packageType];

  if (!config) {
    throw new Error(`unknown package type: ${options.packageType}`);
  }

  const requiredSigners = [...config.requiredSigners];
  const vetoHolders = [...config.vetoHolders];

  if (mentionsEurcOrEurAmd(options.title) || mentionsEurcOrEurAmd(options.description)) {
    if (!requiredSigners.includes('narek')) {
      requiredSigners.push('narek');
    }
  }

  const input: CreatePackageInput = {
    title: options.title,
    description: options.description,
    packageType: options.packageType,
    preparedBy: options.preparedBy,
    riskLevel: options.riskLevel ?? 'low',
    riskNotes: options.riskNotes ?? '',
    costEstimate: options.costEstimate ?? null,
    goalAncestry: options.goalAncestry ?? {},
    requiredSigners,
    vetoHolders,
    smokeTest: options.smokeTest ?? false,
  };

  const pkg = await executionPackageRepo.create(input);

  await writeAuditEvent({
    actor: options.preparedBy,
    actorType: options.preparedBy === 'artur' ? 'founder' : 'agent',
    eventType: 'package.created',
    subjectId: pkg._id as Types.ObjectId,
    payload: {
      packageType: options.packageType,
      requiredSigners,
      vetoHolders,
    },
    smokeTest: options.smokeTest ?? false,
  });

  logger.info(
    { packageId: pkg._id, packageType: options.packageType, requiredSigners },
    'execution package created'
  );

  return pkg;
}

function canTransitionToAwaitingFounder(pkg: IExecutionPackageDocument): {
  allowed: boolean;
  reason?: string;
} {
  const requiredSigners = new Set(pkg.requiredSigners);
  const reviewsByAgent = new Map<string, IReview>();

  for (const review of pkg.reviews) {
    reviewsByAgent.set(review.agentId, review);
  }

  for (const signer of requiredSigners) {
    const review = reviewsByAgent.get(signer);
    if (!review) {
      return { allowed: false, reason: `missing review from required signer: ${signer}` };
    }
    if (review.verdict === 'reject') {
      return { allowed: false, reason: `rejected by required signer: ${signer}` };
    }
  }

  for (const review of pkg.reviews) {
    for (const condition of review.conditions) {
      if (!condition.resolved) {
        return {
          allowed: false,
          reason: `unresolved condition from ${review.agentId}: ${condition.text}`,
        };
      }
    }
  }

  if (pkg.riskLevel === 'high' || pkg.riskLevel === 'critical') {
    return {
      allowed: false,
      reason: `high/critical risk packages require explicit founder override (risk: ${pkg.riskLevel})`,
    };
  }

  return { allowed: true };
}

export async function transition(
  packageId: Types.ObjectId | string,
  toState: PackageState,
  actor: string,
  reason?: string,
  smokeTest?: boolean
): Promise<IExecutionPackageDocument> {
  const pkg = await executionPackageRepo.findById(packageId);
  if (!pkg) {
    throw new Error(`package not found: ${packageId}`);
  }

  const fromState = pkg.state;
  const pkgIdStr = pkg._id?.toString() ?? packageId.toString();

  if (toState === 'REJECTED' && actor === 'artur') {
    // founder can reject from any state
  } else {
    const allowedTargets = LEGAL_TRANSITIONS[fromState];
    if (!allowedTargets || !allowedTargets.includes(toState)) {
      throw new IllegalTransitionError(
        pkgIdStr,
        fromState,
        toState,
        `transition not allowed from ${fromState}`
      );
    }
  }

  if (fromState === 'C_LEVEL_REVIEW' && toState === 'AWAITING_FOUNDER') {
    const check = canTransitionToAwaitingFounder(pkg);
    if (!check.allowed) {
      throw new IllegalTransitionError(pkgIdStr, fromState, toState, check.reason ?? 'unknown');
    }
  }

  if (fromState === 'AWAITING_FOUNDER' && (toState === 'APPROVED' || toState === 'REJECTED')) {
    if (actor !== 'artur') {
      throw new IllegalTransitionError(
        pkgIdStr,
        fromState,
        toState,
        'only founder can approve or reject from AWAITING_FOUNDER'
      );
    }
  }

  const historyEntry = {
    from: fromState,
    to: toState,
    ts: new Date(),
    actor,
    reason: reason ?? null,
  };

  const updated = await executionPackageRepo.pushStateHistory(packageId, historyEntry, toState);
  if (!updated) {
    throw new Error(`failed to update package: ${packageId}`);
  }

  if (toState === 'EXECUTING') {
    await executionPackageRepo.setExecutedAt(packageId, new Date());
  } else if (toState === 'COMPLETED' || toState === 'ROLLED_BACK') {
    await executionPackageRepo.setCompletedAt(packageId, new Date());
  }

  await writeAuditEvent({
    actor,
    actorType: actor === 'artur' ? 'founder' : actor === 'system' ? 'system' : 'agent',
    eventType: 'package.transition',
    subjectId: pkg._id as Types.ObjectId,
    payload: { from: fromState, to: toState, reason },
    smokeTest: smokeTest ?? false,
  });

  logger.info({ packageId: pkgIdStr, from: fromState, to: toState, actor }, 'package transitioned');

  return updated;
}

export async function submitReview(
  packageId: Types.ObjectId | string,
  review: Omit<IReview, 'ts'>,
  smokeTest?: boolean
): Promise<IExecutionPackageDocument> {
  const pkg = await executionPackageRepo.findById(packageId);
  if (!pkg) {
    throw new Error(`package not found: ${packageId}`);
  }

  if (pkg.state !== 'C_LEVEL_REVIEW') {
    throw new Error(`can only submit reviews in C_LEVEL_REVIEW state, current: ${pkg.state}`);
  }

  const fullReview: IReview = {
    ...review,
    ts: new Date(),
  };

  const updated = await executionPackageRepo.pushReview(packageId, fullReview);
  if (!updated) {
    throw new Error(`failed to add review to package: ${packageId}`);
  }

  await writeAuditEvent({
    actor: review.agentId,
    actorType: 'agent',
    eventType: 'review.submitted',
    subjectId: pkg._id as Types.ObjectId,
    payload: { verdict: review.verdict, hasConditions: review.conditions.length > 0 },
    smokeTest: smokeTest ?? false,
  });

  logger.info(
    { packageId: packageId.toString(), reviewer: review.agentId, verdict: review.verdict },
    'review submitted'
  );

  return updated;
}
