import { MongoClient, ObjectId } from 'mongodb';

async function fixCircleEntry() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  const hostMatch = uri.match(/@([^/]+)\//);
  console.log(`Connecting to MongoDB host: ${hostMatch?.[1] || 'unknown'}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  // The specific Circle Developer Grants entry
  const circleId = '6a551a9a9926d87ff3bb6237';

  console.log(`\n=== BEFORE FIX ===`);
  const before = await collection.findOne({ _id: new ObjectId(circleId) });
  if (!before) {
    console.log('Circle entry not found!');
    await client.close();
    process.exit(1);
  }
  console.log(`_id: ${before._id}`);
  console.log(`title: ${before.title}`);
  console.log(`trustLevel: ${before.trustLevel}`);
  console.log(`source: ${before.source}`);
  console.log(`signalScore: ${before.signalScore}`);

  // Fix: The real Circle grants page is circle.com/grant (mentioned by Syuzi)
  // But we should verify that URL first
  const realUrl = 'https://www.circle.com/grant';
  let urlValid = false;
  try {
    const response = await fetch(realUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)' },
      redirect: 'follow',
    });
    urlValid = response.status >= 200 && response.status < 400;
    console.log(`\nReal URL check (${realUrl}): ${urlValid ? 'VALID' : 'INVALID'} (${response.status})`);
  } catch (err) {
    console.log(`\nReal URL check failed: ${err}`);
  }

  // Apply fix - either correct the URL or downgrade
  const update = urlValid
    ? {
        source: realUrl,
        sourceUrlVerified: true,
        sourceUrlVerificationError: null,
        summary: before.summary.replace('[Source URL unverifiable — treat as unconfirmed signal]: ', ''),
        updatedAt: new Date(),
      }
    : {
        source: '',
        trustLevel: 'signal',
        verificationStatus: 'pending',
        signalScore: Math.min(before.signalScore || 5, 5),
        summary: before.summary.includes('[Source URL unverifiable')
          ? before.summary
          : `[Source URL unverifiable — treat as unconfirmed signal]: ${before.summary}`,
        sourceUrlVerified: false,
        sourceUrlVerificationError: 'Original URL returned 404; no valid alternative found',
        updatedAt: new Date(),
      };

  const result = await collection.updateOne(
    { _id: new ObjectId(circleId) },
    { $set: update }
  );

  console.log(`\nUpdate result: ${result.modifiedCount > 0 ? 'SUCCESS' : 'NO CHANGE'}`);

  console.log(`\n=== AFTER FIX ===`);
  const after = await collection.findOne({ _id: new ObjectId(circleId) });
  console.log(`_id: ${after?._id}`);
  console.log(`title: ${after?.title}`);
  console.log(`trustLevel: ${after?.trustLevel}`);
  console.log(`source: ${after?.source}`);
  console.log(`signalScore: ${after?.signalScore}`);
  console.log(`sourceUrlVerified: ${after?.sourceUrlVerified}`);
  console.log(`sourceUrlVerificationError: ${after?.sourceUrlVerificationError}`);

  await client.close();
}

fixCircleEntry().catch(console.error);
