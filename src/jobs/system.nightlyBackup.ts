import { Agenda, Job } from 'agenda';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable, PassThrough } from 'stream';
import { env } from '../config/env.js';
import { writeAuditEvent } from '../core/auditLog.js';
import { logger } from '../logger.js';

export const JOB_NAME = 'system.nightlyBackup';

const s3 = new S3Client({
  endpoint: env.R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

interface CollectionLike {
  collectionName: string;
  find(filter: Record<string, unknown>): AsyncIterable<unknown>;
}

async function* streamCollection(
  collection: CollectionLike
): AsyncGenerator<string, void, unknown> {
  const cursor = collection.find({});
  for await (const doc of cursor) {
    yield JSON.stringify(doc) + '\n';
  }
}

async function uploadCollectionToR2(
  collection: CollectionLike,
  dateStr: string
): Promise<number> {
  const collectionName = collection.collectionName;
  const key = `backups/${dateStr}/${collectionName}.ndjson.gz`;

  const chunks: Buffer[] = [];
  const gzip = createGzip();
  const passThrough = new PassThrough();

  passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));

  const generator = streamCollection(collection);
  let docCount = 0;

  const readable = new Readable({
    async read() {
      const { value, done } = await generator.next();
      if (done) {
        this.push(null);
      } else {
        docCount++;
        this.push(value);
      }
    },
  });

  await pipeline(readable, gzip, passThrough);

  const body = Buffer.concat(chunks);

  await s3.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/gzip',
    })
  );

  logger.debug({ collectionName, docCount, sizeBytes: body.length }, 'collection backed up');
  return docCount;
}

async function deleteOldBackups(retentionDays: number): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const listResponse = await s3.send(
    new ListObjectsV2Command({
      Bucket: env.R2_BUCKET,
      Prefix: 'backups/',
      Delimiter: '/',
    })
  );

  const prefixesToDelete: string[] = [];
  for (const prefix of listResponse.CommonPrefixes ?? []) {
    if (prefix.Prefix) {
      const dateMatch = prefix.Prefix.match(/backups\/(\d{4}-\d{2}-\d{2})\//);
      if (dateMatch?.[1] && dateMatch[1] < cutoffStr) {
        prefixesToDelete.push(prefix.Prefix);
      }
    }
  }

  let deletedCount = 0;
  for (const prefix of prefixesToDelete) {
    const objectsResponse = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.R2_BUCKET,
        Prefix: prefix,
      })
    );

    const objectsToDelete = (objectsResponse.Contents ?? [])
      .filter((obj) => obj.Key)
      .map((obj) => ({ Key: obj.Key! }));

    if (objectsToDelete.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: env.R2_BUCKET,
          Delete: { Objects: objectsToDelete },
        })
      );
      deletedCount += objectsToDelete.length;
    }
  }

  if (deletedCount > 0) {
    logger.info({ deletedCount, prefixes: prefixesToDelete }, 'deleted old backups');
  }

  return deletedCount;
}

export function defineJob(agenda: Agenda): void {
  agenda.define(JOB_NAME, async (job: Job) => {
    const startTime = Date.now();
    let success = false;
    let errorMessage: string | undefined;
    const collectionCounts: Record<string, number> = {};

    try {
      const db = mongoose.connection.db;
      if (!db) {
        throw new Error('database not connected');
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const collections = await db.listCollections().toArray();

      for (const collInfo of collections) {
        const collection = db.collection(collInfo.name);
        const count = await uploadCollectionToR2(collection, dateStr);
        collectionCounts[collInfo.name] = count;
      }

      const deletedBackups = await deleteOldBackups(14);

      success = true;
      logger.info(
        { collectionCount: Object.keys(collectionCounts).length, deletedBackups },
        'nightly backup completed'
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'nightly backup failed');
      throw error;
    } finally {
      await writeAuditEvent({
        actor: 'system',
        actorType: 'system',
        eventType: success ? 'backup.completed' : 'job.run',
        payload: {
          jobName: JOB_NAME,
          success,
          durationMs: Date.now() - startTime,
          collectionCounts: success ? collectionCounts : undefined,
          error: errorMessage,
        },
      });
    }
  });
}

export async function scheduleJob(agenda: Agenda): Promise<void> {
  await agenda.every('0 3 * * *', JOB_NAME, {}, { timezone: 'Europe/Prague' });
  logger.info('scheduled nightly backup job for 03:00 Europe/Prague daily');
}
