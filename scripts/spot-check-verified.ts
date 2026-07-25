import { MongoClient } from 'mongodb';

async function spotCheck() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  const collection = db.collection('knowledges');

  // Get 5 random verified entries with HTTP URLs
  const entries = await collection.aggregate([
    { 
      $match: { 
        addedBy: 'hasmik', 
        status: 'active',
        trustLevel: 'verified',
        sourceUrlVerified: true,
        source: { $regex: /^https?:\/\// }
      }
    },
    { $sample: { size: 5 } }
  ]).toArray();

  console.log('=== SPOT CHECK: 5 RANDOM VERIFIED ENTRIES ===\n');

  for (const entry of entries) {
    console.log(`Title: ${entry.title}`);
    console.log(`URL: ${entry.source}`);
    
    // Actually fetch and check
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(entry.source, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AedaBot/1.0)' },
        redirect: 'follow',
      });
      
      clearTimeout(timeout);
      
      const html = await response.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : '(no title)';
      
      console.log(`HTTP: ${response.status}`);
      console.log(`Page title: ${pageTitle}`);
      console.log(`Final URL: ${response.url}`);
      
      // Check if page title seems related to entry title
      const entryWords = entry.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
      const pageTitleLower = pageTitle.toLowerCase();
      const matchingWords = entryWords.filter((w: string) => pageTitleLower.includes(w));
      
      if (matchingWords.length === 0 && !pageTitleLower.includes('404') && !pageTitleLower.includes('not found')) {
        console.log(`⚠️ WARNING: No title word overlap - may be wrong page`);
      } else {
        console.log(`✅ Title overlap OK`);
      }
    } catch (error) {
      console.log(`ERROR: ${error}`);
    }
    console.log('');
  }

  await client.close();
}

spotCheck();
