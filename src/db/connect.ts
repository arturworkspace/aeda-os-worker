import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let isConnected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (isConnected) {
    return mongoose;
  }

  try {
    await mongoose.connect(env.MONGODB_URI);
    isConnected = true;
    logger.info('connected to mongodb');
    return mongoose;
  } catch (error) {
    logger.error({ error }, 'failed to connect to mongodb');
    throw error;
  }
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
