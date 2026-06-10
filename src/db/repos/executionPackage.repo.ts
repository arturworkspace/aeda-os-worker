import { Types, FilterQuery } from 'mongoose';
import {
  ExecutionPackage,
  IExecutionPackage,
  IExecutionPackageDocument,
  PackageType,
  PackageState,
  IStateHistoryEntry,
  IReview,
} from '../schemas/executionPackage.js';

export interface CreatePackageInput {
  title: string;
  description: string;
  packageType: PackageType;
  preparedBy: string;
  riskLevel?: IExecutionPackage['riskLevel'];
  riskNotes?: string;
  costEstimate?: IExecutionPackage['costEstimate'];
  goalAncestry?: IExecutionPackage['goalAncestry'];
  requiredSigners: string[];
  vetoHolders: string[];
  smokeTest?: boolean;
}

export const executionPackageRepo = {
  async create(input: CreatePackageInput): Promise<IExecutionPackageDocument> {
    const initialHistoryEntry: IStateHistoryEntry = {
      from: null,
      to: 'PREPARED',
      ts: new Date(),
      actor: input.preparedBy,
      reason: 'package created',
    };

    const doc = new ExecutionPackage({
      title: input.title,
      description: input.description,
      packageType: input.packageType,
      state: 'PREPARED',
      stateHistory: [initialHistoryEntry],
      preparedBy: input.preparedBy,
      goalAncestry: input.goalAncestry ?? {},
      riskLevel: input.riskLevel ?? 'low',
      riskNotes: input.riskNotes ?? '',
      costEstimate: input.costEstimate ?? null,
      costActualUsd: 0,
      reviews: [],
      requiredSigners: input.requiredSigners,
      vetoHolders: input.vetoHolders,
      scheduledFor: null,
      executedAt: null,
      completedAt: null,
      smokeTest: input.smokeTest ?? false,
    });
    return doc.save();
  },

  async findById(id: Types.ObjectId | string): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findById(id).exec();
  },

  async find(query: FilterQuery<IExecutionPackage>): Promise<IExecutionPackageDocument[]> {
    return ExecutionPackage.find(query).exec();
  },

  async findByState(state: PackageState): Promise<IExecutionPackageDocument[]> {
    return ExecutionPackage.find({ state, smokeTest: { $ne: true } }).exec();
  },

  async getOpenPackagesByState(): Promise<Record<PackageState, number>> {
    const openStates: PackageState[] = [
      'PREPARED',
      'C_LEVEL_REVIEW',
      'AWAITING_FOUNDER',
      'APPROVED',
      'SCHEDULED',
      'EXECUTING',
    ];

    const results = await ExecutionPackage.aggregate([
      { $match: { state: { $in: openStates }, smokeTest: { $ne: true } } },
      { $group: { _id: '$state', count: { $sum: 1 } } },
    ]).exec();

    const counts = {} as Record<PackageState, number>;
    for (const state of openStates) {
      counts[state] = 0;
    }
    for (const r of results) {
      counts[r._id as PackageState] = r.count as number;
    }
    return counts;
  },

  async pushStateHistory(
    id: Types.ObjectId | string,
    entry: IStateHistoryEntry,
    newState: PackageState
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      {
        $push: { stateHistory: entry },
        $set: { state: newState },
      },
      { new: true }
    ).exec();
  },

  async pushReview(
    id: Types.ObjectId | string,
    review: IReview
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      { $push: { reviews: review } },
      { new: true }
    ).exec();
  },

  async setScheduledFor(
    id: Types.ObjectId | string,
    scheduledFor: Date
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      { $set: { scheduledFor } },
      { new: true }
    ).exec();
  },

  async setExecutedAt(
    id: Types.ObjectId | string,
    executedAt: Date
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      { $set: { executedAt } },
      { new: true }
    ).exec();
  },

  async setCompletedAt(
    id: Types.ObjectId | string,
    completedAt: Date
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      { $set: { completedAt } },
      { new: true }
    ).exec();
  },

  async incrementCostActual(
    id: Types.ObjectId | string,
    amount: number
  ): Promise<IExecutionPackageDocument | null> {
    return ExecutionPackage.findByIdAndUpdate(
      id,
      { $inc: { costActualUsd: amount } },
      { new: true }
    ).exec();
  },

  async deleteTestDocs(): Promise<number> {
    const result = await ExecutionPackage.deleteMany({ smokeTest: true }).exec();
    return result.deletedCount;
  },
};
