import { MongoClient, ObjectId } from 'mongodb';

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const db = client.db();
  
  const entry = await db.collection('knowledges').findOne({ 
    _id: new ObjectId('6a551b0e9926d87ff3bb625f') 
  });
  
  console.log('=== ESMA ENTRY CURRENT STATE ===');
  console.log(JSON.stringify(entry, null, 2));
  
  await client.close();
}

check();
