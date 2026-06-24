import mongoose from 'mongoose';
import { connectDb } from '../db/connect.js';

export async function getDb(): Promise<mongoose.mongo.Db> {
  const conn = await connectDb();
  return conn.connection.db!;
}
