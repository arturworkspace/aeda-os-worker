import { Types } from 'mongoose';
import { costLedgerRepo } from '../db/repos/costLedger.repo.js';
import { budgetRepo } from '../db/repos/budget.repo.js';
import { founderInboxRepo } from '../db/repos/founderInbox.repo.js';
import { writeAuditEvent } from './auditLog.js';
import { logger } from '../logger.js';

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'global' | 'project' | 'package',
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

export function invalidateBudgetCache(): void {
  aggregateCache.clear();
}

export interface BudgetCheckScopeRefs {
  packageId: Types.ObjectId | string | null;
  projectKey: string | null;
  smokeTest: boolean;
}

export async function checkBudget(
  estimatedMaxUsd: number,
  scopeRefs: BudgetCheckScopeRefs
): Promise<void> {
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
    { estimatedMaxUsd, packageId: scopeRefs.packageId?.toString(), projectKey: scopeRefs.projectKey },
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
