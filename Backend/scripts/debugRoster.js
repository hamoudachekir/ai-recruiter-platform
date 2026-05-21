/**
 * Quick diagnostic — replays the exact CallRoom.find query that the
 * candidate-roster endpoint uses and prints which rooms come back.
 *
 *   node Backend/scripts/debugRoster.js feed000000000000000000e2
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
  const jir = await db.collection("jobinterviewrooms").findOne({ _id: jirId });
  console.log("JobInterviewRoom:");
  console.log("  _id     :", jir?._id);
  console.log("  company :", jir?.company);
  console.log("  job     :", jir?.job);

  console.log("\nQuerying callrooms with: { jobInterviewRoom, status: 'ended' }");
  const rooms = await db.collection("callrooms").find({
    jobInterviewRoom: jirId,
    status: "ended",
  }).toArray();
  console.log(`Found ${rooms.length} room(s):`);
  for (const r of rooms) {
    const cand = await db.collection("users").findOne({ _id: r.candidate });
    console.log(`  ─ roomId=${r.roomId}`);
    console.log(`    _id=${r._id}  status=${r.status}`);
    console.log(`    candidate=${cand?.email || cand?._id || "—"}`);
    console.log(`    job=${r.job}  company=${r.company}`);
  }

  // Same query without status filter, in case the user's room ended != "ended"
  const roomsAny = await db.collection("callrooms").find({
    jobInterviewRoom: jirId,
  }).toArray();
  if (roomsAny.length !== rooms.length) {
    console.log(`\nWith NO status filter: ${roomsAny.length} room(s).`);
    for (const r of roomsAny) {
      if (r.status !== "ended") {
        console.log(`  ⚠  roomId=${r.roomId}  status="${r.status}"  ← excluded by status filter`);
      }
    }
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
