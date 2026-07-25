import { Types } from 'mongoose';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { budgetRepo } from '../db/repos/budget.repo.js';
import { founderInboxRepo } from '../db/repos/founderInbox.repo.js';
import { writeAuditEvent } from './auditLog.js';
import { logger } from '../logger.js';

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'global' | 'project' | 'package' | 'job',
    public readonly key: string,
    public readonly currentSpend: number,
    public readonly cap: number,
    public readonly estimatedCost: number
  ) {
    super(
      `budget exceeded: ${scope} ${key} - current: $${currentSpend.toFixed(4)}, cap: $${cap.toFixed(2)}, estimated: $${estimatedCost.toFixed(4)}`
    );
    this.name = 'BudgetExceededError';
  }
}

interface CachedAggregate {
  value: number;
  expiresAt: number;
}

const aggregateCache: Map<string, CachedAggregate> = new Map();
const CACHE_TTL_MS = 60_000;

async function getGlobalMonthToDate(): Promise<number> {
  const cacheKey = 'global_mtd';
  const cached = aggregateCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await costLedgerRepo.getMonthToDateTotal();
  aggregateCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function getProjectMonthToDate(projectKey: string): Promise<number> {
  const cacheKey = `project_mtd_${projectKey}`;
  const cached = aggregateCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await costLedgerRepo.getMonthToDateByProject(projectKey);
  aggregateCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function getPackageTotal(packageId: string): Promise<number> {
  const cacheKey = `package_total_${packageId}`;
  const cached = aggregateCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await costLedgerRepo.getPackageTotal(packageId);
  aggregateCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function getJobDayToDate(agentOrJob: string): Promise<number> {
  const cacheKey = `job_dtd_${agentOrJob}`;
  const cached = aggregateCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await costLedgerRepo.getDayToDateByAgentOrJob(agentOrJob);
  aggregateCache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function invalidateBudgetCache(): void {
  aggregateCache.clear();
}

// ============================================================================
// Per-Job Daily Ceilings
// ============================================================================
//
// Based on observed costs in os_cost_ledger:
// - hasmik.weeklyIntelligence: ~$0.30-0.40 per weekly run (single burst)
// - investor-research: ~$0.02-0.05 per call, ~10-20 calls/day on active days = ~$0.50/day
// - investor-email-draft: ~$0.01-0.03 per call, similar volume = ~$0.30/day
// - investor-email-compliance: ~$0.01 per call
// - outreach.gmailSendStatusSync: ~$0.01-0.02 per call, runs frequently
// - lilit (heartbeat): ~$0.01-0.02 per call
// - processInboundEmail routing: ~$0.01-0.05 per email
//
// Ceilings are set at ~5x typical daily max to catch runaways without
// blocking normal operation. For jobs that run weekly (hasmik), the
// ceiling is per-day so a runaway loop would still be caught quickly.
//
// DEFAULT_JOB_DAILY_CEILING applies to any job not explicitly listed.
// ============================================================================

const JOB_DAILY_CEILINGS: Record<string, number> = {
  // Weekly intelligence job — normally ~$0.40, ceiling $2.00
  'hasmik.weeklyIntelligence': 2.00,

  // Investor pipeline jobs — normally sub-$0.50/day each, ceiling $2.50
  'investor-research': 2.50,
  'investor-email-draft': 1.50,
  'investor-email-compliance': 0.50,
  'investor-linkedin-autofill': 1.00,
  'investor-linkedin-screenshot-autofill': 1.00,

  // Gmail sync — normally sub-$0.20/day, ceiling $1.00
  'outreach.gmailSendStatusSync': 1.00,

  // Lilit standup/heartbeat — normally sub-$0.10/day, ceiling $0.50
  'lilit': 0.50,

  // Inbound email processing — normally sub-$0.30/day, ceiling $1.50
  'artur': 1.50, // Artur's email processing
  'processInboundEmail': 1.50,
};

// Default for jobs not explicitly listed: $3.00/day
// This is generous enough to not block legitimate new jobs,
// but still catches major runaways well before $60/mo global cap.
const DEFAULT_JOB_DAILY_CEILING = 3.00;

function getJobDailyCeiling(agentOrJob: string): number {
  // Check exact match first
  if (JOB_DAILY_CEILINGS[agentOrJob] !== undefined) {
    return JOB_DAILY_CEILINGS[agentOrJob];
  }

  // Check prefix matches (e.g., "room:abc:lilit" matches "lilit" patterns)
  // This handles workspace-style agentOrJob values like "room:xyz:hasmik"
  for (const [pattern, ceiling] of Object.entries(JOB_DAILY_CEILINGS)) {
    if (agentOrJob.endsWith(`:${pattern}`)) {
      return ceiling;
    }
  }

  return DEFAULT_JOB_DAILY_CEILING;
}

// Track which jobs have already been alerted today to avoid spam
const alertedJobsToday = new Map<string, string>(); // key -> date string

export interface BudgetCheckScopeRefs {
  packageId: Types.ObjectId | string | null;
  projectKey: string | null;
  smokeTest: boolean;
  agentOrJob?: string; // Added for per-job ceiling check
}

export async function checkBudget(
  estimatedMaxUsd: number,
  scopeRefs: BudgetCheckScopeRefs
): Promise<void> {
  // -------------------------------------------------------------------------
  // Per-Job Daily Ceiling Check (NEW — runs first, before global)
  // -------------------------------------------------------------------------
  if (scopeRefs.agentOrJob && !scopeRefs.smokeTest) {
    const jobCeiling = getJobDailyCeiling(scopeRefs.agentOrJob);
    const jobSpend = await getJobDayToDate(scopeRefs.agentOrJob);

    if (jobSpend + estimatedMaxUsd > jobCeiling) {
      const today = new Date().toISOString().slice(0, 10);
      const alertKey = `${scopeRefs.agentOrJob}_${today}`;

      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'budget.blocked',
        payload: {
          scope: 'job',
          key: scopeRefs.agentOrJob,
          currentSpend: jobSpend,
          cap: jobCeiling,
          estimatedCost: estimatedMaxUsd,
        },
        smokeTest: false,
      });

      // Alert once per job per day
      if (alertedJobsToday.get(scopeRefs.agentOrJob) !== today) {
        alertedJobsToday.set(scopeRefs.agentOrJob, today);

        await founderInboxRepo.insert({
          source: 'budget-guard',
          title: `🛑 Job blocked — ${scopeRefs.agentOrJob} daily cap reached`,
          content: `AI call blocked: job "${scopeRefs.agentOrJob}" has spent $${jobSpend.toFixed(2)} today, exceeding its $${jobCeiling.toFixed(2)} daily ceiling.\n\nEstimated call cost: $${estimatedMaxUsd.toFixed(4)}.\n\nThis may indicate a runaway loop or unusual activity. The job will be unblocked tomorrow (Prague time). Other jobs are unaffected.\n\nTo investigate: check os_cost_ledger for recent entries from this job.`,
        });
      }

      throw new BudgetExceededError(
        'job',
        scopeRefs.agentOrJob,
        jobSpend,
        jobCeiling,
        estimatedMaxUsd
      );
    }
  }

  // -------------------------------------------------------------------------
  // Global Monthly Cap Check (existing)
  // -------------------------------------------------------------------------
  const globalBudget = await budgetRepo.getGlobal();
  if (globalBudget?.monthlyCapUsd) {
    const globalSpend = await getGlobalMonthToDate();
    if (globalSpend + estimatedMaxUsd > globalBudget.monthlyCapUsd) {
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'budget.blocked',
        payload: {
          scope: 'global',
          currentSpend: globalSpend,
          cap: globalBudget.monthlyCapUsd,
          estimatedCost: estimatedMaxUsd,
        },
        smokeTest: scopeRefs.smokeTest ?? false,
      });

      // Alert to Founder Inbox
      if (!scopeRefs.smokeTest) {
        await founderInboxRepo.insert({
          source: 'budget-guard',
          title: '🛑 Budget blocked — global cap reached',
          content: `AI call blocked: global monthly spend ($${globalSpend.toFixed(2)}) has reached the $${globalBudget.monthlyCapUsd} cap. Estimated call cost: $${estimatedMaxUsd.toFixed(4)}.\n\nAction: Check Anthropic Console for usage limits, or increase the cap in os_budgets collection.`,
        });
      }

      throw new BudgetExceededError(
        'global',
        'global',
        globalSpend,
        globalBudget.monthlyCapUsd,
        estimatedMaxUsd
      );
    }
  }

  // -------------------------------------------------------------------------
  // Project Monthly Cap Check (existing)
  // -------------------------------------------------------------------------
  if (scopeRefs.projectKey) {
    const projectBudget = await budgetRepo.getProject(scopeRefs.projectKey);
    if (projectBudget?.monthlyCapUsd) {
      const projectSpend = await getProjectMonthToDate(scopeRefs.projectKey);
      if (projectSpend + estimatedMaxUsd > projectBudget.monthlyCapUsd) {
        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'budget.blocked',
          payload: {
            scope: 'project',
            key: scopeRefs.projectKey,
            currentSpend: projectSpend,
            cap: projectBudget.monthlyCapUsd,
            estimatedCost: estimatedMaxUsd,
          },
          smokeTest: scopeRefs.smokeTest ?? false,
        });

        // Alert to Founder Inbox
        if (!scopeRefs.smokeTest) {
          await founderInboxRepo.insert({
            source: 'budget-guard',
            title: `🛑 Budget blocked — ${scopeRefs.projectKey} cap reached`,
            content: `AI call blocked: project "${scopeRefs.projectKey}" monthly spend ($${projectSpend.toFixed(2)}) has reached the $${projectBudget.monthlyCapUsd} cap. Estimated call cost: $${estimatedMaxUsd.toFixed(4)}.`,
          });
        }

        throw new BudgetExceededError(
          'project',
          scopeRefs.projectKey,
          projectSpend,
          projectBudget.monthlyCapUsd,
          estimatedMaxUsd
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Package Cap Check (existing)
  // -------------------------------------------------------------------------
  if (scopeRefs.packageId) {
    const packageIdStr =
      typeof scopeRefs.packageId === 'string'
        ? scopeRefs.packageId
        : scopeRefs.packageId.toString();
    const packageBudget = await budgetRepo.getPackage(packageIdStr);
    if (packageBudget?.capUsd) {
      const packageSpend = await getPackageTotal(packageIdStr);
      if (packageSpend + estimatedMaxUsd > packageBudget.capUsd) {
        await writeAuditEvent({
          actor: 'system',
          actorType: 'system',
          eventType: 'budget.blocked',
          payload: {
            scope: 'package',
            key: packageIdStr,
            currentSpend: packageSpend,
            cap: packageBudget.capUsd,
            estimatedCost: estimatedMaxUsd,
          },
          smokeTest: scopeRefs.smokeTest ?? false,
        });

        throw new BudgetExceededError(
          'package',
          packageIdStr,
          packageSpend,
          packageBudget.capUsd,
          estimatedMaxUsd
        );
      }
    }
  }

  logger.debug(
    { estimatedMaxUsd, packageId: scopeRefs.packageId?.toString(), projectKey: scopeRefs.projectKey, agentOrJob: scopeRefs.agentOrJob },
    'budget check passed'
  );
}

let lastWarningDate: string | null = null;

export async function checkBudgetWarning(): Promise<boolean> {
  const globalBudget = await budgetRepo.getGlobal();
  if (!globalBudget?.monthlyCapUsd || !globalBudget.warnAtPct) {
    return false;
  }

  const globalSpend = await getGlobalMonthToDate();
  const warnThreshold = globalBudget.monthlyCapUsd * (globalBudget.warnAtPct / 100);

  if (globalSpend >= warnThreshold) {
    const today = new Date().toISOString().slice(0, 10);
    if (lastWarningDate !== today) {
      lastWarningDate = today;
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: 'budget.warning',
        payload: {
          currentSpend: globalSpend,
          cap: globalBudget.monthlyCapUsd,
          warnAtPct: globalBudget.warnAtPct,
          threshold: warnThreshold,
        },
      });

      // Alert to Founder Inbox (once per day)
      await founderInboxRepo.insert({
        source: 'budget-guard',
        title: `⚠️ Budget warning — ${globalBudget.warnAtPct}% of monthly cap used`,
        content: `Global monthly spend ($${globalSpend.toFixed(2)}) has crossed the ${globalBudget.warnAtPct}% warning threshold ($${warnThreshold.toFixed(2)} of $${globalBudget.monthlyCapUsd} cap).\n\nThis alert fires once per day. Review spend in OS Dashboard.`,
      });

      logger.warn(
        { currentSpend: globalSpend, cap: globalBudget.monthlyCapUsd, warnAtPct: globalBudget.warnAtPct },
        'budget warning threshold crossed'
      );
      return true;
    }
  }

  return false;
}

// ============================================================================
// Debug / Testing Helpers
// ============================================================================

/**
 * Get current job ceiling configuration (for debug endpoint)
 */
export function getJobCeilings(): Record<string, number> {
  return { ...JOB_DAILY_CEILINGS, _default: DEFAULT_JOB_DAILY_CEILING };
}

/**
 * Get current day-to-date spend for a job (for debug endpoint)
 */
export async function getJobSpendToday(agentOrJob: string): Promise<{
  agentOrJob: string;
  spentToday: number;
  ceiling: number;
  remainingToday: number;
  percentUsed: number;
}> {
  const ceiling = getJobDailyCeiling(agentOrJob);
  const spentToday = await costLedgerRepo.getDayToDateByAgentOrJob(agentOrJob);
  const remainingToday = Math.max(0, ceiling - spentToday);

  return {
    agentOrJob,
    spentToday,
    ceiling,
    remainingToday,
    percentUsed: ceiling > 0 ? (spentToday / ceiling) * 100 : 0,
  };
}
