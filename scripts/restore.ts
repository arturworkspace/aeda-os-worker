import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';
import mongoose from 'mongoose';

const envSchema = {
  MONGODB_URI: process.env['MONGODB_URI'],
  R2_ENDPOINT: process.env['R2_ENDPOINT'],
  R2_ACCESS_KEY_ID: process.env['R2_ACCESS_KEY_ID'],
  R2_SECRET_ACCESS_KEY: process.env['R2_SECRET_ACCESS_KEY'],
  R2_BUCKET: process.env['R2_BUCKET'],
};

for (const [key, value] of Object.entries(envSchema)) {
  if (!value) {
    console.error(`missing required env var: ${key}`);
    process.exit(1);
  }
}

const s3 = new S3Client({
  endpoint: envSchema.R2_ENDPOINT!,
  region: 'auto',
  credentials: {
    accessKeyId: envSchema.R2_ACCESS_KEY_ID!,
    secretAccessKey: envSchema.R2_SECRET_ACCESS_KEY!,
  },
});

function printUsage(): void {
  console.log(`
aeda os worker - restore collection from backup

usage:
  npx tsx scripts/restore.ts <collection-name> <backup-date>

arguments:
  collection-name   name of the collection to restore (e.g., os_audit_log)
  backup-date       date of the backup in YYYY-MM-DD format

example:
  npx tsx scripts/restore.ts os_audit_log 2024-01-15

notes:
  - the collection will be restored to restored_<collection-name>
  - the original collection is never modified
  - inspect the restored collection, then manually rename if satisfied
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    printUsage();
    process.exit(1);
  }

  const [collectionName, backupDate] = args as [string, string];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(backupDate)) {
    console.error('error: backup-date must be in YYYY-MM-DD format');
    process.exit(1);
  }

  const key = `backups/${backupDate}/${collectionName}.ndjson.gz`;
  const targetCollection = `restored_${collectionName}`;

  console.log(`restoring ${collectionName} from backup ${backupDate}`);
  console.log(`source: s3://${envSchema.R2_BUCKET}/${key}`);
  console.log(`target: ${targetCollection}`);
  console.log('');

  console.log('connecting to database...');
  await mongoose.connect(envSchema.MONGODB_URI!);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('database not connected');
  }
  console.log('connected');

  console.log('downloading backup...');
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: envSchema.R2_BUCKET!,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error('empty response body from S3');
  }

  const existing = await db.listCollections({ name: targetCollection }).toArray();
  if (existing.length > 0) {
    console.log(`dropping existing ${targetCollection}...`);
    await db.dropCollection(targetCollection);
  }

  const collection = db.collection(targetCollection);
  let docCount = 0;
  let buffer = '';

  const gunzip = createGunzip();
  const insertStream = new Writable({
    objectMode: true,
    async write(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      const docs: unknown[] = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            docs.push(JSON.parse(line));
          } catch {
            console.warn(`skipping invalid JSON line: ${line.slice(0, 50)}...`);
          }
        }
      }

      if (docs.length > 0) {
        await collection.insertMany(docs);
        docCount += docs.length;
        process.stdout.write(`\rinserted ${docCount} documents...`);
      }

      callback();
    },
    async final(callback) {
      if (buffer.trim()) {
        try {
          const doc = JSON.parse(buffer);
          await collection.insertOne(doc);
          docCount++;
        } catch {
          console.warn(`skipping invalid final JSON: ${buffer.slice(0, 50)}...`);
        }
      }
      callback();
    },
  });

  const bodyStream = response.Body as Readable;
  await pipeline(bodyStream, gunzip, insertStream);

  console.log('');
  console.log(`restore complete: ${docCount} documents inserted into ${targetCollection}`);
  console.log('');
  console.log('next steps:');
  console.log(`  1. inspect the restored data: db.${targetCollection}.find().limit(10)`);
  console.log(`  2. if satisfied, rename: db.${targetCollection}.renameCollection("${collectionName}", {dropTarget: true})`);
  console.log('  3. or drop if not needed: db.dropCollection("' + targetCollection + '")');

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('restore failed:', error);
  process.exit(1);
});
