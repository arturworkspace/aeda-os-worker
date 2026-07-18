import { MongoClient } from 'mongodb';

async function findEntries() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  // Find DolarApp entry
  console.log('=== SEARCHING FOR DolarApp ENTRY ===');
  const dolarApp = await db.collection('knowledges').find({
    $or: [
      { title: { $regex: /dolarapp/i } },
      { source: { $regex: /dolarapp/i } },
      { summary: { $regex: /dolarapp/i } }
    ]
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, signalScore: 1, sourceUrlVerified: 1, sourceUrlVerificationError: 1 }).toArray();

  if (dolarApp.length === 0) {
    console.log('No DolarApp entries found');
  } else {
    for (const e of dolarApp) {
      console.log(JSON.stringify(e, null, 2));
    }
  }

  // Find Jeremy Allaire LinkedIn entry
  console.log('\n=== SEARCHING FOR Jeremy Allaire ENTRY ===');
  const allaire = await db.collection('knowledges').find({
    $and: [
      { $or: [
        { title: { $regex: /allaire/i } },
        { source: { $regex: /allaire/i } },
        { authorName: { $regex: /allaire/i } }
      ]},
      { source: { $regex: /linkedin/i } }
    ]
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, signalScore: 1, sourceUrlVerified: 1, sourceUrlVerificationError: 1, authorName: 1 }).toArray();

  if (allaire.length === 0) {
    console.log('No Jeremy Allaire LinkedIn entries found');
    
    // Try broader search
    console.log('\nTrying broader search for LinkedIn entries with Circle/EURC...');
    const linkedinCircle = await db.collection('knowledges').find({
      source: { $regex: /linkedin\.com/i },
      $or: [
        { title: { $regex: /circle|eurc/i } },
        { summary: { $regex: /jeremy.*allaire|allaire.*jeremy/i } }
      ]
    }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, signalScore: 1, sourceUrlVerified: 1, authorName: 1 }).limit(5).toArray();
    
    for (const e of linkedinCircle) {
      console.log(JSON.stringify(e, null, 2));
    }
  } else {
    for (const e of allaire) {
      console.log(JSON.stringify(e, null, 2));
    }
  }

  // Find TechCrunch entries
  console.log('\n=== SEARCHING FOR TechCrunch ENTRIES ===');
  const techcrunch = await db.collection('knowledges').find({
    source: { $regex: /techcrunch\.com/i }
  }).project({ _id: 1, title: 1, source: 1, trustLevel: 1, signalScore: 1, sourceUrlVerified: 1, sourceUrlVerificationError: 1 }).limit(10).toArray();

  if (techcrunch.length === 0) {
    console.log('No TechCrunch entries found');
  } else {
    console.log(`Found ${techcrunch.length} TechCrunch entries:`);
    for (const e of techcrunch) {
      console.log(JSON.stringify(e, null, 2));
    }
  }

  await client.close();
}

findEntries().catch(console.error);
