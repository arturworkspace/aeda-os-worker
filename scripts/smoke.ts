import 'dotenv/config';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { auditLogRepo } from '../src/db/repos/auditLog.repo.js';
import { executionPackageRepo } from '../src/db/repos/executionPackage.repo.js';
import { costLedgerRepo } from '../src/db/repos/costLedger.repo.js';
import { budgetRepo } from '../src/db/repos/budget.repo.js';
import { memoryRepo } from '../src/db/repos/memory.repo.js';
import { founderInboxRepo } from '../src/db/repos/founderInbox.repo.js';
import {
  createPackage,
  transition,
  submitReview,
  loadApprovalMatrix,
  IllegalTransitionError,
} from '../src/core/stateMachine.js';
import { routedCall, getTextContent } from '../src/core/modelRouter.js';
import { BudgetExceededError, invalidateBudgetCache } from '../src/core/budgetGuard.js';
import { Budget } from '../src/db/schemas/budget.js';
import { CostLedger } from '../src/db/schemas/costLedger.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function log(message: string): void {
  console.log(`[smoke] ${message}`);
}

function pass(name: string): void {
  results.push({ name, passed: true });
  log(`✓ ${name}`);
}

function fail(name: string, error: string): void {
  results.push({ name, passed: false, error });
  log(`✗ ${name}: ${error}`);
}

async function cleanup(): Promise<void> {
  log('cleaning up test documents...');
  const auditDeleted = await auditLogRepo.deleteTestDocs();
  const pkgDeleted = await executionPackageRepo.deleteTestDocs();
  const costDeleted = await costLedgerRepo.deleteTestDocs();
  const memoryDeleted = await memoryRepo.deleteTestDocs();
  const inboxDeleted = await founderInboxRepo.deleteTestDocs();

  await Budget.deleteMany({ scope: 'package', key: /^smoke-test-/ });

  log(`cleaned up: audit=${auditDeleted}, packages=${pkgDeleted}, cost=${costDeleted}, memory=${memoryDeleted}, inbox=${inboxDeleted}`);
}

async function test1_StateMachine(): Promise<void> {
  const testName = 'state machine transitions';

  try {
    loadApprovalMatrix();

    const pkg = await createPackage({
      title: 'smoke test package',
      description: 'testing state machine transitions',
      packageType: 'generic',
      preparedBy: 'smoke-test',
      smokeTest: true,
    });

    if (pkg.state !== 'PREPARED') {
      fail(testName, `expected PREPARED state, got ${pkg.state}`);
      return;
    }

    await transition(pkg._id as Types.ObjectId, 'C_LEVEL_REVIEW', 'smoke-test', 'testing', true);

    await submitReview(
      pkg._id as Types.ObjectId,
      {
        agentId: 'lilit',
        verdict: 'approve',
        checkedItems: ['test item'],
        conditions: [],
        reasoning: 'smoke test approval',
      },
      true
    );

    await transition(pkg._id as Types.ObjectId, 'AWAITING_FOUNDER', 'smoke-test', 'testing', true);

    const updatedPkg = await executionPackageRepo.findById(pkg._id as Types.ObjectId);
    if (updatedPkg?.state !== 'AWAITING_FOUNDER') {
      fail(testName, `expected AWAITING_FOUNDER state, got ${updatedPkg?.state}`);
      return;
    }

    pass(testName);
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function test2_IllegalTransition(): Promise<void> {
  const testName = 'illegal transition throws';

  try {
    const pkg = await createPackage({
      title: 'smoke test illegal transition',
      description: 'testing illegal transition detection',
      packageType: 'generic',
      preparedBy: 'smoke-test',
      smokeTest: true,
    });

    try {
      await transition(pkg._id as Types.ObjectId, 'EXECUTING', 'smoke-test', 'should fail', true);
      fail(testName, 'expected IllegalTransitionError but transition succeeded');
      return;
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        pass(testName);
      } else {
        fail(testName, `expected IllegalTransitionError, got: ${error}`);
      }
    }
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function test3_RoutedCall(): Promise<void> {
  const testName = 'routedCall with cost tracking';

  try {
    const beforeCount = await CostLedger.countDocuments({ smokeTest: true });

    const result = await routedCall({
      tier: 'background',
      agentOrJob: 'smoke-test',
      system: 'You are a test assistant. Respond with exactly one word.',
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 50,
      smokeTest: true,
    });

    const content = getTextContent(result.response);
    if (!content.toLowerCase().includes('ok')) {
      log(`warning: unexpected response content: ${content}`);
    }

    const afterCount = await CostLedger.countDocuments({ smokeTest: true });
    if (afterCount <= beforeCount) {
      fail(testName, 'cost ledger entry not created');
      return;
    }

    const auditEvents = await auditLogRepo.find({ eventType: 'llm.call', smokeTest: true });
    if (auditEvents.length === 0) {
      fail(testName, 'audit event not created');
      return;
    }

    log(`llm call cost: $${result.costUsd.toFixed(6)}`);
    pass(testName);
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function test4_BudgetBlocking(): Promise<void> {
  const testName = 'budget blocking';

  try {
    const pkg = await createPackage({
      title: 'smoke test budget',
      description: 'testing budget blocking',
      packageType: 'generic',
      preparedBy: 'smoke-test',
      smokeTest: true,
    });

    const packageId = (pkg._id as Types.ObjectId).toString();

    await budgetRepo.upsert({
      scope: 'package',
      key: `smoke-test-${packageId}`,
      capUsd: 0.000001,
    });

    await Budget.updateOne(
      { scope: 'package', key: `smoke-test-${packageId}` },
      { $set: { key: packageId } }
    );

    invalidateBudgetCache();

    try {
      await routedCall({
        tier: 'background',
        agentOrJob: 'smoke-test',
        packageId: pkg._id as Types.ObjectId,
        system: 'Test',
        messages: [{ role: 'user', content: 'Test' }],
        maxTokens: 50,
        smokeTest: true,
      });
      fail(testName, 'expected BudgetExceededError but call succeeded');
      return;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        const blockedEvents = await auditLogRepo.find({
          eventType: 'budget.blocked',
          smokeTest: true,
        });
        if (blockedEvents.length === 0) {
          fail(testName, 'budget.blocked audit event not created');
          return;
        }
        pass(testName);
      } else {
        fail(testName, `expected BudgetExceededError, got: ${error}`);
      }
    }
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function test5_MemorySupersede(): Promise<void> {
  const testName = 'memory write and supersede';

  try {
    const original = await memoryRepo.writeMemory({
      kind: 'fact',
      content: 'smoke test fact v1',
      writtenBy: 'smoke-test',
      smokeTest: true,
    });

    const superseded = await memoryRepo.supersedeMemory(
      original._id as Types.ObjectId,
      'smoke test fact v2',
      'smoke-test',
      null,
      true
    );

    if (superseded.version !== 2) {
      fail(testName, `expected version 2, got ${superseded.version}`);
      return;
    }

    if (!superseded.supersedes?.equals(original._id as Types.ObjectId)) {
      fail(testName, 'supersedes reference not set correctly');
      return;
    }

    const oldDoc = await memoryRepo.findById(original._id as Types.ObjectId);
    if (oldDoc?.active !== false) {
      fail(testName, 'old memory should be inactive');
      return;
    }

    pass(testName);
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function test6_GetActiveMemories(): Promise<void> {
  const testName = 'getActiveMemories returns only active';

  try {
    const activeMemories = await memoryRepo.getActiveMemories('founder_preference');

    for (const mem of activeMemories) {
      if (!mem.active) {
        fail(testName, 'inactive memory returned by getActiveMemories');
        return;
      }
    }

    if (activeMemories.length === 0) {
      fail(testName, 'no active founder_preference memories found (seeding may have failed)');
      return;
    }

    pass(testName);
  } catch (error) {
    fail(testName, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  log('starting smoke test');
  log('connecting to database...');

  await connectDb();
  log('connected');

  await memoryRepo.seedFounderPreferences();
  log('founder preferences seeded');

  try {
    await test1_StateMachine();
    await test2_IllegalTransition();
    await test3_RoutedCall();
    await test4_BudgetBlocking();
    await test5_MemorySupersede();
    await test6_GetActiveMemories();
  } finally {
    await cleanup();

    const totalCost = await CostLedger.aggregate([
      { $match: { smokeTest: true } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    const costUsd = totalCost[0]?.total ?? 0;
    log('');
    log(`total smoke test cost: $${costUsd.toFixed(6)}`);

    await disconnectDb();
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  log('');
  log('='.repeat(50));
  log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);

  if (failed > 0) {
    log('');
    log('FAILURES:');
    for (const r of results.filter((r) => !r.passed)) {
      log(`  - ${r.name}: ${r.error}`);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }

  log('');
  log('PASS');
}

main().catch((error) => {
  console.error('smoke test failed:', error);
  process.exit(1);
});
