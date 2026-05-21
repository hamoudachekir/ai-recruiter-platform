/**
 * Replays the /api/job-rooms/:id/sessions query and prints what comes back.
 *   node Backend/scripts/debugSessions.js feed000000000000000000e2
 */
const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));
require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");

async function main() {
  const jirArg = process.argv[2] || "feed000000000000000000e2";
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter");
  const db = mongoose.connection.db;
  const jirId = new mongoose.Types.ObjectId(jirArg);

  // Same query the endpoint runs, minus the populate.
  const sessions = await db.collection("callrooms")
    .find({ jobInterviewRoom: jirId })
    .sort({ createdAt: -1 })
    .toArray();

  console.log(`Found ${sessions.length} session(s) in callrooms for jobInterviewRoom=${jirArg}\n`);
  for (const s of sessions) {
    const cand = s.candidate
      ? await db.collection("users").findOne({ _id: s.candidate })
      : null;
    console.log(`  roomId    : ${s.roomId}`);
    console.log(`  _id       : ${s._id}`);
    console.log(`  status    : ${s.status}`);
    console.log(`  candidate : ${cand?.email || cand?.name || s.candidate || "—"}`);
    console.log(`  createdAt : ${s.createdAt}`);
    console.log(`  endedAt   : ${s.recordingEndedAt || "—"}`);
    console.log("");
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
