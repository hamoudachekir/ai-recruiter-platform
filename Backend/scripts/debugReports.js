/**
 * Show which CallRoom roomIds have matching interview_final_reports.
 *   node Backend/scripts/debugReports.js 6a0c3edec185c1c98b6bc82e
 */
const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));
require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");

async function main() {
  const jirArg = process.argv[2];
  if (!jirArg) {
    console.error("Usage: node debugReports.js <jobInterviewRoomId>");
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter");
  const db = mongoose.connection.db;

  const sessions = await db.collection("callrooms")
    .find({ jobInterviewRoom: new mongoose.Types.ObjectId(jirArg) })
    .toArray();

  console.log(`Sessions in jobInterviewRoom=${jirArg}:\n`);
  for (const s of sessions) {
    const cand = s.candidate
      ? await db.collection("users").findOne({ _id: s.candidate })
      : null;
    const report = await db.collection("interview_final_reports").findOne({
      interviewId: s.roomId || String(s._id),
    });
    const theta = report?.technicalEvaluation?.theta;
    const res = report?.technicalEvaluation?.resilienceIndex
            ?? report?.hrEvaluation?.resilienceIndex
            ?? report?.resilienceIndex;
    const techScore = report?.technicalEvaluation?.score;
    console.log(`  ${cand?.email || s.candidate || "?"}`);
    console.log(`    roomId   : ${s.roomId}`);
    console.log(`    report?  : ${Boolean(report)}`);
    console.log(`    theta    : ${theta ?? "—"}`);
    console.log(`    resilien.: ${res ?? "—"}`);
    console.log(`    techScore: ${techScore ?? "—"}`);
    console.log("");
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
