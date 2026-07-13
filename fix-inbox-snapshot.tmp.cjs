const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('aeda-workspace');
  const investors = db.collection('investors');
  const drafts = db.collection('os_email_drafts');
  const inbox = db.collection('os_inbox_items');

  for (const name of [/Lightspeed/i, /Fabric Ventures/i]) {
    const inv = await investors.findOne({ name });
    const followup1 = await drafts.findOne({
      $or: [{ investorId: inv._id }, { investorId: inv._id.toString() }],
      followUpStage: 'followup1',
    });
    if (!followup1) { console.log(inv.name, 'NO followup1 draft found'); continue; }

    const linkedInbox = await inbox.findOne({ draft_id: followup1._id });
    console.log(inv.name, '-> draft body starts:', followup1.body.slice(0, 20), '| linked inbox item found:', !!linkedInbox);

    if (linkedInbox) {
      await inbox.updateOne(
        { _id: linkedInbox._id },
        { $set: { body_text: followup1.body, draft_text: followup1.body } }
      );
      console.log('  patched inbox item', linkedInbox._id.toString());
    }
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
