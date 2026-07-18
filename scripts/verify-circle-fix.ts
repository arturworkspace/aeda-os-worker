import { MongoClient, ObjectId } from 'mongodb';

async function verifyCircleFix() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  // Check the specific Circle entry
  const circleId = '6a551a9a9926d87ff3bb6237';
  const entry = await db.collection('knowledges').findOne({ _id: new ObjectId(circleId) });

  console.log('=== Circle Developer Grants Entry (Production) ===');
  console.log(JSON.stringify({
    _id: entry?._id?.toString(),
    title: entry?.title,
    trustLevel: entry?.trustLevel,
    source: entry?.source,
    sourceUrl: entry?.sourceUrl,
    sourceUrlVerified: entry?.sourceUrlVerified,
    sourceUrlVerificationError: entry?.sourceUrlVerificationError,
    signalScore: entry?.signalScore,
    verificationStatus: entry?.verificationStatus,
  }, null, 2));

  // Verify the URL is accessible
  if (entry?.source) {
    try {
      const response = await fetch(entry.source, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      console.log(`\nURL verification: ${entry.source}`);
      console.log(`Status: ${response.status} ${response.statusText}`);
    } catch (err) {
      console.log(`\nURL check failed: ${err}`);
    }
  }

  await client.close();
}

verifyCircleFix().catch(console.error);
