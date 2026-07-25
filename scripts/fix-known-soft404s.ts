import { MongoClient, ObjectId } from 'mongodb';

// These are the specific entries identified as soft 404s
const SOFT_404_ENTRIES = [
  { id: '6a525a076223ae2eb36185fe', url: 'https://dealroom.co/reports/eu-fintech-ma-h1-2026' },
  { id: '6a551c4f9926d87ff3bb62d2', url: 'https://dealroom.co/reports/cee-fintech-pre-seed-q2-2026' },
  { id: '6a5259896223ae2eb36185d6', url: 'https://amplitude.com/blog/fintech-retention-benchmarks-2026' },
  { id: '6a551b829926d87ff3bb628a', url: 'https://amplitude.com/blog/fintech-retention-benchmarks-2026' },
];

async function fixKnownSoft404s() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  console.log('Fixing known soft 404 entries...\n');

  for (const entry of SOFT_404_ENTRIES) {
    const doc = await collection.findOne({ _id: new ObjectId(entry.id) });
    if (!doc) {
      console.log(`Entry ${entry.id} not found`);
      continue;
    }

    console.log(`Fixing: ${doc.title}`);
    console.log(`  Old source: ${doc.source}`);
    console.log(`  Old trust: ${doc.trustLevel}`);

    const newSummary = doc.summary?.includes('[Source URL')
      ? doc.summary
      : `[Source URL soft 404]: ${doc.summary || ''}`;

    await collection.updateOne(
      { _id: new ObjectId(entry.id) },
      {
        $set: {
          source: '',
          trustLevel: 'signal',
          verificationStatus: 'pending',
          signalScore: Math.min(doc.signalScore || 5, 5),
          summary: newSummary,
          sourceUrlVerified: false,
          sourceUrlSoftRedirect: true,
          sourceUrlVerificationError: 'Page content indicates not found (soft 404)',
          updatedAt: new Date(),
        }
      }
    );

    const updated = await collection.findOne({ _id: new ObjectId(entry.id) });
    console.log(`  New source: ${updated?.source || '(cleared)'}`);
    console.log(`  New trust: ${updated?.trustLevel}`);
    console.log(`  sourceUrlVerified: ${updated?.sourceUrlVerified}`);
    console.log('');
  }

  await client.close();
  console.log('Done!');
}

fixKnownSoft404s().catch(console.error);
