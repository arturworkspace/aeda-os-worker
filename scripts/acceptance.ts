import 'dotenv/config';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { executionPackageRepo } from '../src/db/repos/executionPackage.repo.js';
import { auditLogRepo } from '../src/db/repos/auditLog.repo.js';
import { costLedgerRepo } from '../src/db/repos/costLedger.repo.js';
import { budgetRepo } from '../src/db/repos/budget.repo.js';
import { memoryRepo } from '../src/db/repos/memory.repo.js';
import {
  createPackage,
  transition,
  submitReview,
  loadApprovalMatrix,
} from '../src/core/stateMachine.js';
import { routedCall } from '../src/core/modelRouter.js';
import { BudgetExceededError, invalidateBudgetCache } from '../src/core/budgetGuard.js';
import { AuditLog } from '../src/db/schemas/auditLog.js';
import { ExecutionPackage } from '../src/db/schemas/executionPackage.js';
import { Memory } from '../src/db/schemas/memory.js';
import { CostLedger } from '../src/db/schemas/costLedger.js';
import { Budget } from '../src/db/schemas/budget.js';

interface ScenarioResult {
  name: string;
  passed: boolean;
  reason?: string;
}

const results: ScenarioResult[] = [];
const startTime = Date.now();

function log(message: string): void {
  console.log(`[acceptance] ${message}`);
}

function pass(name: string): void {
  results.push({ name, passed: true });
  log(`✓ PASS: ${name}`);
}

function fail(name: string, reason: string): void {
  results.push({ name, passed: false, reason });
  log(`✗ FAIL: ${name}`);
  log(`  Reason: ${reason}`);
}

// Use acceptanceTest tag instead of smokeTest for cleanup
const TEST_TAG = { acceptanceTest: true };

async function cleanup(): Promise<void> {
  log('cleaning up acceptance test documents...');

  const auditDeleted = await AuditLog.deleteMany({ acceptanceTest: true }).exec();
  const pkgDeleted = await ExecutionPackage.deleteMany({ acceptanceTest: true }).exec();
  const costDeleted = await CostLedger.deleteMany({ acceptanceTest: true }).exec();
  const memoryDeleted = await Memory.deleteMany({ acceptanceTest: true }).exec();
  await Budget.deleteMany({ scope: 'package', key: /^acceptance-test-/ }).exec();

  log(`cleaned up: audit=${auditDeleted.deletedCount}, packages=${pkgDeleted.deletedCount}, cost=${costDeleted.deletedCount}, memory=${memoryDeleted.deletedCount}`);
}

// ============================================================================
// SCENARIO 1 — Approval Matrix Enforcement
// ============================================================================
async function scenario1_ApprovalMatrixEnforcement(): Promise<void> {
  const name = 'Scenario 1: Approval Matrix Enforcement';

  try {
    loadApprovalMatrix();

    // Create external_comms package
    const pkg = await createPackage({
      title: 'test external communication',
      description: 'testing approval matrix for external_comms',
      packageType: 'external_comms',
      preparedBy: 'acceptance-test',
      smokeTest: true, // using smokeTest for compatibility with existing cleanup
    });

    // Mark for acceptance test cleanup
    await ExecutionPackage.updateOne({ _id: pkg._id }, { $set: { acceptanceTest: true } });

    // Assert requiredSigners includes tatev AND narek
    if (!pkg.requiredSigners.includes('tatev')) {
      fail(name, 'external_comms package missing "tatev" in requiredSigners');
      return;
    }
    if (!pkg.requiredSigners.includes('narek')) {
      fail(name, 'external_comms package missing "narek" in requiredSigners');
      return;
    }

    // Assert vetoHolders includes narek AND vagho
    if (!pkg.vetoHolders.includes('narek')) {
      fail(name, 'external_comms package missing "narek" in vetoHolders');
      return;
    }
    if (!pkg.vetoHolders.includes('vagho')) {
      fail(name, 'external_comms package missing "vagho" in vetoHolders');
      return;
    }

    // Create a package mentioning EURC - should auto-add narek
    const eurcPkg = await createPackage({
      title: 'EURC integration testing',
      description: 'testing eurc corridor',
      packageType: 'generic', // generic normally only has lilit as signer
      preparedBy: 'acceptance-test',
      smokeTest: true,
    });

    await ExecutionPackage.updateOne({ _id: eurcPkg._id }, { $set: { acceptanceTest: true } });

    // Assert narek is added for EURC mentions
    if (!eurcPkg.requiredSigners.includes('narek')) {
      fail(name, 'EURC package should auto-add "narek" to requiredSigners');
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// SCENARIO 2 — State Machine Governance
// ============================================================================
async function scenario2_StateMachineGovernance(): Promise<void> {
  const name = 'Scenario 2: State Machine Governance';

  try {
    // Create external_comms package (requires tatev and narek)
    const pkg = await createPackage({
      title: 'state machine governance test',
      description: 'testing conditional approval flow',
      packageType: 'external_comms',
      preparedBy: 'acceptance-test',
      smokeTest: true,
    });

    await ExecutionPackage.updateOne({ _id: pkg._id }, { $set: { acceptanceTest: true } });

    // Transition to C_LEVEL_REVIEW
    await transition(pkg._id as Types.ObjectId, 'C_LEVEL_REVIEW', 'acceptance-test', 'testing', true);

    // Submit approval from tatev
    await submitReview(
      pkg._id as Types.ObjectId,
      {
        agentId: 'tatev',
        verdict: 'approve',
        checkedItems: ['content reviewed'],
        conditions: [],
        reasoning: 'content is appropriate',
      },
      true
    );

    // Submit approval with unresolved condition from narek
    await submitReview(
      pkg._id as Types.ObjectId,
      {
        agentId: 'narek',
        verdict: 'approve_with_conditions',
        checkedItems: ['compliance checked'],
        conditions: [{ text: 'add disclaimer', resolved: false, resolvedBy: null, resolvedAt: null }],
        reasoning: 'needs disclaimer for regulatory compliance',
      },
      true
    );

    // Assert CANNOT transition to AWAITING_FOUNDER with unresolved condition
    let transitionBlocked = false;
    try {
      await transition(pkg._id as Types.ObjectId, 'AWAITING_FOUNDER', 'acceptance-test', 'testing', true);
    } catch (error) {
      if (error instanceof Error && error.message.includes('unresolved condition')) {
        transitionBlocked = true;
      } else {
        throw error;
      }
    }

    if (!transitionBlocked) {
      fail(name, 'transition to AWAITING_FOUNDER should be blocked with unresolved conditions');
      return;
    }

    // Resolve the condition by updating the review
    await ExecutionPackage.updateOne(
      { _id: pkg._id, 'reviews.agentId': 'narek' },
      {
        $set: {
          'reviews.$.conditions.0.resolved': true,
          'reviews.$.conditions.0.resolvedBy': 'acceptance-test',
          'reviews.$.conditions.0.resolvedAt': new Date(),
        },
      }
    );

    // Now transition should succeed
    const updated = await transition(pkg._id as Types.ObjectId, 'AWAITING_FOUNDER', 'acceptance-test', 'condition resolved', true);

    if (updated.state !== 'AWAITING_FOUNDER') {
      fail(name, `expected state AWAITING_FOUNDER, got ${updated.state}`);
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// SCENARIO 3 — Budget Hard Block
// ============================================================================
async function scenario3_BudgetHardBlock(): Promise<void> {
  const name = 'Scenario 3: Budget Hard Block';

  try {
    // Create a package for budget testing
    const pkg = await createPackage({
      title: 'budget test package',
      description: 'testing budget enforcement',
      packageType: 'generic',
      preparedBy: 'acceptance-test',
      smokeTest: true,
    });

    await ExecutionPackage.updateOne({ _id: pkg._id }, { $set: { acceptanceTest: true } });

    const packageId = (pkg._id as Types.ObjectId).toString();

    // Set an impossibly low package-level cap (below any possible call)
    await budgetRepo.upsert({
      scope: 'package',
      key: `acceptance-test-${packageId}`,
      capUsd: 0.000001,
    });

    // Update to use the actual package ID as key
    await Budget.updateOne(
      { scope: 'package', key: `acceptance-test-${packageId}` },
      { $set: { key: packageId } }
    );

    invalidateBudgetCache();

    // Count llm.call events before
    const llmCallsBefore = await AuditLog.countDocuments({
      eventType: 'llm.call',
      subjectId: pkg._id,
    });

    // Attempt a routedCall that would exceed the cap
    let budgetBlocked = false;
    try {
      await routedCall({
        tier: 'background',
        agentOrJob: 'acceptance-test',
        packageId: pkg._id as Types.ObjectId,
        system: 'You are a test assistant.',
        messages: [{ role: 'user', content: 'Say hello' }],
        maxTokens: 100,
        smokeTest: true,
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        budgetBlocked = true;
        // Mark the audit event for cleanup
        await AuditLog.updateMany(
          { eventType: 'budget.blocked', 'payload.key': packageId },
          { $set: { acceptanceTest: true } }
        );
      } else {
        throw error;
      }
    }

    if (!budgetBlocked) {
      fail(name, 'BudgetExceededError should have been thrown');
      return;
    }

    // Assert budget.blocked event exists
    const blockedEvents = await AuditLog.find({
      eventType: 'budget.blocked',
      'payload.key': packageId,
    });

    if (blockedEvents.length === 0) {
      fail(name, 'no budget.blocked audit event found for the package');
      return;
    }

    // Assert no llm.call event for this package (LLM was never called)
    const llmCallsAfter = await AuditLog.countDocuments({
      eventType: 'llm.call',
      subjectId: pkg._id,
    });

    if (llmCallsAfter > llmCallsBefore) {
      fail(name, 'llm.call event exists - LLM should not have been called when budget exceeded');
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// SCENARIO 4 — Memory Versioning
// ============================================================================
async function scenario4_MemoryVersioning(): Promise<void> {
  const name = 'Scenario 4: Memory Versioning';

  try {
    // Write first memory entry
    const firstEntry = await memoryRepo.writeMemory({
      kind: 'founder_preference',
      content: 'Always lead with data.',
      writtenBy: 'acceptance-test',
      smokeTest: true,
    });

    await Memory.updateOne({ _id: firstEntry._id }, { $set: { acceptanceTest: true } });

    // Supersede with second entry
    const secondEntry = await memoryRepo.supersedeMemory(
      firstEntry._id as Types.ObjectId,
      'Always lead with the strongest signal.',
      'acceptance-test',
      null,
      true
    );

    await Memory.updateOne({ _id: secondEntry._id }, { $set: { acceptanceTest: true } });

    // Mark related audit events
    await AuditLog.updateMany(
      { eventType: 'memory.written', subjectId: { $in: [firstEntry._id, secondEntry._id] } },
      { $set: { acceptanceTest: true } }
    );

    // Assert getActiveMemories returns the second entry (check content)
    const activeMemories = await Memory.find({
      kind: 'founder_preference',
      active: true,
      content: 'Always lead with the strongest signal.',
    });

    if (activeMemories.length === 0) {
      fail(name, 'superseding entry not found in active memories');
      return;
    }

    // Assert first entry still exists (append-only)
    const firstStillExists = await Memory.findById(firstEntry._id);
    if (!firstStillExists) {
      fail(name, 'first entry was deleted - violates append-only rule');
      return;
    }

    // Assert first entry has active: false
    if (firstStillExists.active !== false) {
      fail(name, 'first entry should have active: false after being superseded');
      return;
    }

    // Assert second entry has correct supersedes reference
    if (!secondEntry.supersedes?.equals(firstEntry._id as Types.ObjectId)) {
      fail(name, 'second entry should reference first entry in supersedes field');
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// SCENARIO 5 — Audit Log Immutability
// ============================================================================
async function scenario5_AuditLogImmutability(): Promise<void> {
  const name = 'Scenario 5: Audit Log Immutability';

  try {
    // Write an audit event
    const testPayload = { test: 'immutability check', timestamp: Date.now() };

    const eventDoc = await auditLogRepo.insert({
      actor: 'acceptance-test',
      actorType: 'system',
      eventType: 'config.loaded',
      payload: testPayload,
      smokeTest: true,
    });

    await AuditLog.updateOne({ _id: eventDoc._id }, { $set: { acceptanceTest: true } });

    // Check that auditLogRepo does NOT export update or delete functions
    // (except deleteTestDocs which is the only sanctioned delete path)
    const repoKeys = Object.keys(auditLogRepo);

    const forbiddenPatterns = ['update', 'modify', 'patch', 'remove'];
    const allowedDelete = 'deleteTestDocs';

    for (const key of repoKeys) {
      const lowerKey = key.toLowerCase();
      for (const pattern of forbiddenPatterns) {
        if (lowerKey.includes(pattern)) {
          fail(name, `auditLogRepo exports forbidden function: ${key}`);
          return;
        }
      }
      if (lowerKey.includes('delete') && key !== allowedDelete) {
        fail(name, `auditLogRepo exports unauthorized delete function: ${key}`);
        return;
      }
    }

    // Assert the event is still present and unchanged
    const retrieved = await AuditLog.findById(eventDoc._id);

    if (!retrieved) {
      fail(name, 'audit event was deleted or not found');
      return;
    }

    if (retrieved.actor !== 'acceptance-test') {
      fail(name, 'audit event actor was modified');
      return;
    }

    if ((retrieved.payload as Record<string, unknown>)?.['test'] !== 'immutability check') {
      fail(name, 'audit event payload was modified');
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// SCENARIO 6 — Founder Preferences Seeded
// ============================================================================
async function scenario6_FounderPreferencesSeeded(): Promise<void> {
  const name = 'Scenario 6: Founder Preferences Seeded';

  try {
    // Ensure founder preferences are seeded
    await memoryRepo.seedFounderPreferences();

    // Get active founder preferences
    const preferences = await memoryRepo.getActiveMemories('founder_preference');

    // Assert at least 5 entries exist
    if (preferences.length < 5) {
      fail(name, `expected at least 5 founder preferences, found ${preferences.length}`);
      return;
    }

    // Assert one entry contains "aeda" (lowercase brand rule)
    const hasAeda = preferences.some((p) => p.content.toLowerCase().includes('aeda'));
    if (!hasAeda) {
      fail(name, 'no founder preference mentions lowercase "aeda" brand rule');
      return;
    }

    // Assert one entry contains "technology network"
    const hasTechNetwork = preferences.some((p) =>
      p.content.toLowerCase().includes('technology network')
    );
    if (!hasTechNetwork) {
      fail(name, 'no founder preference mentions "technology network" positioning');
      return;
    }

    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main(): Promise<void> {
  log('starting acceptance test suite for aeda os slice 1');
  log('connecting to database...');

  await connectDb();
  log('connected');

  try {
    await scenario1_ApprovalMatrixEnforcement();
    await scenario2_StateMachineGovernance();
    await scenario3_BudgetHardBlock();
    await scenario4_MemoryVersioning();
    await scenario5_AuditLogImmutability();
    await scenario6_FounderPreferencesSeeded();
  } finally {
    // Get total cost before cleanup
    const totalCostResult = await CostLedger.aggregate([
      { $match: { acceptanceTest: true } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    const totalCostUsd = totalCostResult[0]?.total ?? 0;

    await cleanup();

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    log('');
    log('='.repeat(60));

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;

    log(`RESULTS: ${passed}/${total} scenarios passed`);
    log(`Total cost: $${totalCostUsd.toFixed(6)}`);
    log(`Time elapsed: ${elapsedSeconds}s`);

    if (passed < total) {
      log('');
      log('FAILURES:');
      for (const r of results.filter((r) => !r.passed)) {
        log(`  - ${r.name}: ${r.reason}`);
      }
    }

    await disconnectDb();

    if (passed < total) {
      process.exit(1);
    }

    log('');
    log('ALL SCENARIOS PASSED');
  }
}

main().catch((error) => {
  console.error('acceptance test failed:', error);
  process.exit(1);
});
