import { MongoClient } from 'mongodb';

async function findLinkedInEntries() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  // Find ALL LinkedIn entries
  console.log('=== ALL LinkedIn ENTRIES IN KB ===');
  const linkedin = await db.collection('knowledges').find({
    $or: [
      { source: { $regex: /linkedin\.com/i } },
      { sourceType: 'linkedin_expert' }
    ],
    status: 'active'
  }).project({ 
    _id: 1, 
    title: 1, 
    source: 1, 
    trustLevel: 1, 
    signalScore: 1, 
    sourceUrlVerified: 1, 
    sourceUrlVerificationError: 1,
    authorName: 1,
    sourceType: 1
  }).toArray();

  console.log(`Found ${linkedin.length} LinkedIn entries:\n`);
  for (const e of linkedin) {
    console.log(JSON.stringify(e, null, 2));
    console.log('---');
  }

  // Find entries that might be Jeremy Allaire related
  console.log('\n=== JEREMY ALLAIRE ENTRIES (any source) ===');
  const allaire = await db.collection('knowledges').find({
    $or: [
      { title: { $regex: /allaire/i } },
      { authorName: { $regex: /allaire/i } },
      { summary: { $regex: /jeremy.*allaire|allaire.*jeremy/i } }
    ],
    status: 'active'
  }).project({ 
    _id: 1, 
    title: 1, 
    source: 1, 
    trustLevel: 1, 
    sourceUrlVerified: 1,
    authorName: 1
  }).limit(10).toArray();

  console.log(`Found ${allaire.length} Jeremy Allaire entries:`);
  for (const e of allaire) {
    console.log(JSON.stringify(e, null, 2));
  }

  await client.close();
}

findLinkedInEntries().catch(console.error);
