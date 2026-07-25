import { MongoClient } from 'mongodb';

async function stats() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  const totalActive = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active'
  });

  const withUrls = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    source: { $regex: /^https?:\/\// }
  });

  const verified = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: true
  });

  const downgraded = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlVerified: false,
    $or: [
      { source: '' },
      { source: { $exists: false } },
      { source: null }
    ]
  });

  const softRedirects = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlSoftRedirect: true
  });

  const botProtected = await collection.countDocuments({
    addedBy: 'hasmik',
    status: 'active',
    sourceUrlBotProtected: true
  });

  const byTrustLevel = await collection.aggregate([
    { $match: { addedBy: 'hasmik', status: 'active' } },
    { $group: { _id: '$trustLevel', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();

  console.log('=== FINAL KB STATUS ===\n');
  console.log(`Total active Hasmik entries: ${totalActive}`);
  console.log(`Entries with HTTP URLs: ${withUrls}`);
  console.log(`URL verified (genuine resolution): ${verified}`);
  console.log(`Downgraded (URL cleared): ${downgraded}`);
  console.log(`  - Soft redirects caught: ${softRedirects}`);
  console.log(`  - Bot-protected domains: ${botProtected}`);
  console.log(`\nBy trust level:`);
  for (const lvl of byTrustLevel) {
    console.log(`  ${lvl._id}: ${lvl.count}`);
  }

  await client.close();
}

stats();
