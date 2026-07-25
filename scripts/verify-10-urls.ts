import { MongoClient } from 'mongodb';

// The 10 URLs from Step 3h test
const TEST_ENTRIES = [
  { name: 'OWASP', pattern: /owasp.*top.*10/i },
  { name: 'Circle', pattern: /circle.*developer.*grant|circle.*grant/i },
  { name: 'Node.js', pattern: /node\.?js/i },
  { name: 'Figma', pattern: /figma/i },
  { name: 'Turnkey', pattern: /turnkey/i },
  { name: 'DataReportal', pattern: /datareportal/i },
  { name: 'Dealroom EU M&A', pattern: /dealroom.*m&a|fintech.*partnership.*m&a/i },
  { name: 'Dealroom CEE Pre-Seed', pattern: /dealroom.*cee|pre-seed.*vc.*hot.*list/i },
  { name: 'ESMA MiCA', pattern: /esma.*mica.*q&a|esma.*mica/i },
  { name: 'Amplitude', pattern: /amplitude.*retention|fintech.*churn.*onboarding/i },
];

async function verify() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  console.log('=== 10-URL VERIFICATION CHECK ===\n');

  for (const test of TEST_ENTRIES) {
    const doc = await collection.findOne({
      addedBy: 'hasmik',
      status: 'active',
      title: { $regex: test.pattern }
    });

    if (!doc) {
      console.log(`❓ ${test.name}: NOT FOUND`);
      continue;
    }

    const hasUrl = doc.source && doc.source.startsWith('http');
    const verified = doc.sourceUrlVerified === true;
    const softRedirect = doc.sourceUrlSoftRedirect === true;
    const botProtected = doc.sourceUrlBotProtected === true;

    let status: string;
    if (hasUrl && verified) {
      status = '✅ PASS (URL verified)';
    } else if (softRedirect) {
      status = '⚠️ DOWNGRADED (soft 404)';
    } else if (botProtected) {
      status = '🔒 BOT-PROTECTED';
    } else if (!hasUrl && !verified) {
      status = '⚠️ DOWNGRADED (URL cleared)';
    } else {
      status = '❌ UNVERIFIED';
    }

    console.log(`${status} ${test.name}`);
    console.log(`   Title: ${doc.title}`);
    console.log(`   source: "${doc.source || '(cleared)'}"`);
    console.log(`   trustLevel: ${doc.trustLevel}`);
    console.log(`   sourceUrlVerified: ${doc.sourceUrlVerified}`);
    if (doc.sourceUrlSoftRedirect) console.log(`   sourceUrlSoftRedirect: ${doc.sourceUrlSoftRedirect}`);
    if (doc.sourceUrlVerificationError) console.log(`   error: ${doc.sourceUrlVerificationError}`);
    console.log('');
  }

  await client.close();
}

verify();
