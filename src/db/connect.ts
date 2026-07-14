import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let isConnected = false;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectDb(): Promise<typeof mongoose> {
  if (isConnected) {
    return mongoose;
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info({ attempt, maxRetries: MAX_RETRIES }, 'attempting mongodb connection');

      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        // Added 2026-07-14: the follow-up scheduler repeatedly showed the same
        // pattern — a long-idle connection lagging by 10-27 minutes before a
        // scheduled operation succeeded, immediately fixed by every fresh
        // container deploy (new connection). Classic symptom of network
        // infrastructure between Railway and Atlas silently dropping TCP
        // connections that sit idle too long between Agenda ticks (60s apart,
        // but most ticks find nothing to do and touch the DB only briefly).
        // No maxIdleTimeMS was set before, so the driver never proactively
        // recycled idle connections — it just kept reusing one until an
        // operation on it happened to hit the dead socket, then paid the
        // reconnect-and-retry cost silently. Setting this well under the
        // 60s tick interval keeps a connection from ever going stale enough
        // for external infra to kill it first.
        maxIdleTimeMS: 20000,
      });

      isConnected = true;
      logger.info('connected to mongodb');
      return mongoose;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message;

      logger.error(
        { attempt, maxRetries: MAX_RETRIES, errorMessage },
        `failed to connect to mongodb: ${errorMessage}`
      );

      if (attempt < MAX_RETRIES) {
        logger.info({ delayMs: RETRY_DELAY_MS }, 'retrying mongodb connection');
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  console.error('failed to connect to mongodb after all retries:', lastError?.message);
  throw lastError;
}

export async function disconnectDb(): Promise<void> {
  if (!isConnected) {
    return;
  }

  await mongoose.disconnect();
  isConnected = false;
  logger.info('disconnected from mongodb');
}

export function getConnection(): typeof mongoose {
  if (!isConnected) {
    throw new Error('database not connected - call connectDb first');
  }
  return mongoose;
}
