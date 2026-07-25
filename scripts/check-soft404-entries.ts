import { MongoClient, ObjectId } from 'mongodb';

const ENTRIES = [
  '6a525a076223ae2eb36185fe',  // Dealroom EU M&A
  '6a551c4f9926d87ff3bb62d2',  // Dealroom CEE Pre-Seed
  '6a5259896223ae2eb36185d6',  // Amplitude 1
  '6a551b829926d87ff3bb628a',  // Amplitude 2
];

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();

  console.log('=== FIXED SOFT 404 ENTRIES ===\n');

  for (const id of ENTRIES) {
    const doc = await db.collection('knowledges').findOne({ _id: new ObjectId(id) });
    console.log(`Title: ${doc?.title}`);
    console.log(`  source: "${doc?.source || '(cleared)'}"`);
    console.log(`  trustLevel: ${doc?.trustLevel}`);
    console.log(`  sourceUrlVerified: ${doc?.sourceUrlVerified}`);
    console.log(`  sourceUrlSoftRedirect: ${doc?.sourceUrlSoftRedirect}`);
    console.log(`  sourceUrlVerificationError: ${doc?.sourceUrlVerificationError}`);
    console.log('');
  }

  await client.close();
}

check();
