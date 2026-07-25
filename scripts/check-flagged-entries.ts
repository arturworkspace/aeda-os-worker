import { MongoClient } from 'mongodb';

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();

  // Check the specific entries that had no title overlap
  const suspectUrls = [
    'https://www.eba.europa.eu/regulation-and-policy/asset-referenced-and-e-money-tokens-mica',
    'https://eur-lex.europa.eu/eli/reg/2023/1114/oj',
    'https://www.circle.com/eurc',
  ];

  for (const url of suspectUrls) {
    const entry = await db.collection('knowledges').findOne({
      source: url,
      status: 'active'
    });

    if (!entry) continue;

    console.log(`\n=== ${entry.title} ===`);
    console.log(`URL: ${url}`);
    console.log(`trustLevel: ${entry.trustLevel}`);
    console.log(`Summary: ${entry.summary?.substring(0, 200)}...`);
    
    // These are actually OK - they're pointing to the correct authoritative source
    // even if the page title doesn't match word-for-word:
    // - EBA MiCA page IS the authoritative source for EBA MiCA guidance
    // - EUR-Lex MiCA regulation IS the official source
    // - Circle EURC page IS the product page
    // The difference from ESMA is: these pages exist and contain the cited info,
    // while the ESMA Q7 page redirects to a generic news listing
  }

  await client.close();
}

check();
