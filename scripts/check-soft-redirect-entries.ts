import { MongoClient } from 'mongodb';

async function checkEntries() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  // Find Dealroom entries
  console.log('=== DEALROOM ENTRIES ===');
  const dealroom = await db.collection('knowledges').find({
    source: { $regex: /dealroom\.co/i }
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, signalScore: 1, sourceUrlVerified: 1, sourceUrlVerificationError: 1 }).toArray();

  console.log(`Found ${dealroom.length} Dealroom entries:`);
  for (const e of dealroom) {
    console.log(JSON.stringify(e, null, 2));
  }

  // Find ESMA MiCA Q&A entries
  console.log('\n=== ESMA ENTRIES ===');
  const esma = await db.collection('knowledges').find({
    source: { $regex: /esma\.europa\.eu/i },
    status: 'active'
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, sourceUrlVerified: 1 }).limit(10).toArray();

  console.log(`Found ${esma.length} ESMA entries:`);
  for (const e of esma) {
    console.log(JSON.stringify(e, null, 2));
  }

  // Find Amplitude entries
  console.log('\n=== AMPLITUDE ENTRIES ===');
  const amplitude = await db.collection('knowledges').find({
    source: { $regex: /amplitude/i }
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, sourceUrlVerified: 1 }).toArray();

  console.log(`Found ${amplitude.length} Amplitude entries:`);
  for (const e of amplitude) {
    console.log(JSON.stringify(e, null, 2));
  }

  await client.close();
}

checkEntries().catch(console.error);
