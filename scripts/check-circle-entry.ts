import { MongoClient, ObjectId } from 'mongodb';

async function checkCircleEntry() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  // Log which database we're connecting to (host only, not credentials)
  const hostMatch = uri.match(/@([^/]+)\//);
  console.log(`Connecting to MongoDB host: ${hostMatch?.[1] || 'unknown'}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  
  // Check total count to verify we're on production
  const totalCount = await db.collection('knowledges').countDocuments();
  console.log(`Total documents in knowledges collection: ${totalCount}`);

  // Check the specific Circle Developer Grants entry
  const circleId = '6a551a9a9926d87ff3bb6237';
  const entry = await db.collection('knowledges').findOne({ _id: new ObjectId(circleId) });
  
  console.log('\n=== Circle Developer Grants Entry ===');
  if (entry) {
    console.log(`_id: ${entry._id}`);
    console.log(`title: ${entry.title}`);
    console.log(`trustLevel: ${entry.trustLevel}`);
    console.log(`source: ${entry.source}`);
    console.log(`sourceUrlVerified: ${entry.sourceUrlVerified ?? '(not set)'}`);
    console.log(`sourceUrlVerificationError: ${entry.sourceUrlVerificationError ?? '(not set)'}`);
    console.log(`signalScore: ${entry.signalScore}`);
    console.log(`summary: ${entry.summary?.slice(0, 100)}...`);
  } else {
    console.log('Entry NOT FOUND');
  }

  // Also check Chainalysis EURC entry
  console.log('\n=== Searching for Chainalysis EURC entries ===');
  const chainalysisEntries = await db.collection('knowledges').find({
    title: { $regex: /chainalysis.*eurc/i }
  }).project({ _id: 1, title: 1, trustLevel: 1, source: 1 }).toArray();
  
  if (chainalysisEntries.length === 0) {
    console.log('No Chainalysis EURC entries found');
  } else {
    for (const e of chainalysisEntries) {
      console.log(`- ${e._id}: ${e.title} (trust: ${e.trustLevel}, source: ${e.source})`);
    }
  }

  await client.close();
}

checkCircleEntry().catch(console.error);
