const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('aeda-workspace');
  const investors = db.collection('investors');
  const drafts = db.collection('os_email_drafts');
  const now = new Date();
  for (const name of [/Lightspeed/i, /Fabric Ventures/i]) {
    const inv = await investors.findOne({ name }, { projection: { name: 1, firstEmailSentAt: 1, followUp1SentAt: 1, followUp2SentAt: 1 } });
    const fu2 = await drafts.findOne({ $or: [{ investorId: inv._id }, { investorId: inv._id.toString() }], followUpStage: 'followup2' });
    const minutesSinceFU1 = inv.followUp1SentAt ? ((now - new Date(inv.followUp1SentAt)) / 60000).toFixed(1) : null;
    console.log(JSON.stringify({ name: inv.name, followUp1SentAt: inv.followUp1SentAt, followUp2SentAt: inv.followUp2SentAt, minutesSinceFU1, fu2DraftExists: !!fu2 }, null, 2));
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
