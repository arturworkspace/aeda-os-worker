import { MongoClient, ObjectId } from 'mongodb';

// IDs from the audit that failed URL verification
const BAD_ENTRY_IDS = [
  '6a551c4f9926d87ff3bb62d4',
  '6a551c4e9926d87ff3bb62ce',
  '6a551c2d9926d87ff3bb62c7',
  '6a551c2d9926d87ff3bb62c3',
  '6a551c2c9926d87ff3bb62c1',
  '6a551bfb9926d87ff3bb62b6',
  '6a551bfa9926d87ff3bb62b4',
  '6a551bdc9926d87ff3bb62ac',
  '6a551bdc9926d87ff3bb62aa',
  '6a551bdc9926d87ff3bb62a8',
  '6a551bbd9926d87ff3bb62a1',
  '6a551bbd9926d87ff3bb629f',
  '6a551bbd9926d87ff3bb629d',
  '6a551bbc9926d87ff3bb629b',
  '6a551ba19926d87ff3bb6297',
  '6a551ba09926d87ff3bb6295',
  '6a551b829926d87ff3bb6288',
  '6a551b669926d87ff3bb6285',
  '6a551b669926d87ff3bb6283',
  '6a551b669926d87ff3bb6281',
];

interface KBEntry {
  _id: ObjectId;
  title: string;
  summary: string;
  signalScore: number;
}

async function cleanupBadEntries() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  console.log(`\nProcessing ${BAD_ENTRY_IDS.length} entries with fabricated URLs...\n`);

  let updated = 0;
  for (const id of BAD_ENTRY_IDS) {
    const entry = await collection.findOne({ _id: new ObjectId(id) }) as KBEntry | null;
    if (!entry) {
      console.log(`  SKIP: ${id} not found`);
      continue;
    }

    // Downgrade: clear bad URL, set trust to signal, add warning to summary
    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          source: '',  // Clear fabricated URL
          trustLevel: 'signal',
          verificationStatus: 'pending',
          signalScore: Math.min(entry.signalScore || 5, 5), // Cap at 5
          summary: `[Source URL unverifiable — treat as unconfirmed signal]: ${entry.summary}`,
          sourceUrlVerified: false,
          sourceUrlVerificationError: 'URL returned 404/403 during audit',
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`  ✓ Downgraded: ${entry.title}`);
      updated++;
    } else {
      console.log(`  - No change: ${entry.title}`);
    }
  }

  console.log(`\n=== CLEANUP COMPLETE ===`);
  console.log(`Entries downgraded: ${updated}`);
  console.log(`Entries skipped: ${BAD_ENTRY_IDS.length - updated}`);

  await client.close();
  process.exit(0);
}

cleanupBadEntries().catch(err => {
  console.error(err);
  process.exit(1);
});
