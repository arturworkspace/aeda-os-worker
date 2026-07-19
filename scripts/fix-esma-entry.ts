import { MongoClient, ObjectId } from 'mongodb';

async function fix() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  const id = '6a551b0e9926d87ff3bb625f';
  
  // Get current entry
  const entry = await collection.findOne({ _id: new ObjectId(id) });
  console.log('BEFORE:');
  console.log(`  title: ${entry?.title}`);
  console.log(`  trustLevel: ${entry?.trustLevel}`);
  console.log(`  source: ${entry?.source}`);
  console.log(`  sourceUrlVerified: ${entry?.sourceUrlVerified}`);
  
  // Fix: The underlying legal proposition (non-custodial wallets outside CASP scope) 
  // is a real legal reading, but the "ESMA Q7 confirmed in writing" claim is fabricated.
  // Downgrade to informational with corrected summary citing the legal basis, not fake ESMA Q&A.
  
  const newSummary = `[Source unverifiable — no ESMA Q&A confirming this claim found]: The legal position that non-custodial wallet providers who do not hold client assets or execute orders on behalf of clients fall outside MiCA Article 3(1)(16) CASP definition is a widely-discussed legal interpretation (see legal analyses from firms like DFNS, Lexology). However, no ESMA Q&A "seventh batch" confirming this in writing has been published. aeda's architecture (user holds own keys, aeda facilitates UI/UX only) may fall outside CASP licensing scope under this reading, but this is legal interpretation, not official ESMA confirmation.`;
  
  await collection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        title: 'MiCA Article 3: Non-Custodial Wallet Providers May Be Outside CASP Scope (Legal Interpretation)',
        summary: newSummary,
        source: '',
        trustLevel: 'informational',
        verificationStatus: 'pending',
        sourceType: 'analysis',
        signalScore: 7,
        sourceUrlVerified: false,
        sourceUrlSoftRedirect: true,
        sourceUrlVerificationError: 'Claimed ESMA Q&A does not exist — page shows generic listing',
        updatedAt: new Date(),
      }
    }
  );
  
  // Verify
  const updated = await collection.findOne({ _id: new ObjectId(id) });
  console.log('\nAFTER:');
  console.log(JSON.stringify(updated, null, 2));
  
  await client.close();
}

fix();
