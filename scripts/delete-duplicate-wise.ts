import { MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  
  // The two duplicate Wise entries
  const ids = [
    '6a5e54a45a6cfde1fbfd1acc',
    '6a5e56395a6cfde1fbfd1bd2',
  ];
  
  // Check both entries
  for (const id of ids) {
    const entry = await db.collection('knowledges').findOne({ _id: new ObjectId(id) });
    if (entry) {
      console.log(`Found: ${entry.title}`);
      console.log(`  Created: ${entry.createdAt}`);
      console.log(`  Status: ${entry.status}`);
    } else {
      console.log(`Not found: ${id}`);
    }
  }
  
  // Archive the second one (keep the first)
  const result = await db.collection('knowledges').updateOne(
    { _id: new ObjectId(ids[1]) },
    { $set: { status: 'archived', archivedReason: 'duplicate of ' + ids[0] } }
  );
  
  console.log(`\nArchived ${result.modifiedCount} entry (${ids[1]})`);
  
  await client.close();
}

main().catch(console.error);
