/**
 * Link an existing call room to a job + jobInterviewRoom so the real
 * candidate appears in the Candidate Roster comparison alongside other
 * candidates (seeded test users or otherwise).
 *
 * Why this exists
 * ───────────────
 * The recruiter dashboard's "Candidate Roster" is built from CallRoom
 * documents whose `jobInterviewRoom` matches the open comparison's room.
 * Real candidate interviews started via /api/interview-rooms join links
 * already get linked automatically; rooms created via the older path
 * (or before the linking change landed) end up with `job: null` and show
 * up as "Job not linked" on the recruiter view — they never make it
 * into the comparison roster, even with a complete report.
 *
 * This script patches the link on an existing CallRoom in-place.
 *
 * Usage
 * ─────
 *   # Link to the seeded test job/room used by the 4 demo candidates
 *   # (Ahmed, Sarra, Youssef, Nadia):
 *   node Backend/scripts/linkCallRoomToJob.js \
 *       --room room-1779351725930-u4kz53eqq
 *
 *   # Link to a specific job + jobInterviewRoom:
 *   node Backend/scripts/linkCallRoomToJob.js \
 *       --room room-1779351725930-u4kz53eqq \
 *       --job <jobObjectId> \
 *       --jobInterviewRoom <jobInterviewRoomObjectId>
 *
 *   # Link by job title (resolves to the most recent job with that title):
 *   node Backend/scripts/linkCallRoomToJob.js \
 *       --room room-1779351725930-u4kz53eqq \
 *       --jobTitle "Senior Full-Stack Engineer (React + Node.js)"
 *
 * Prerequisites
 * ─────────────
 *   MONGO_URI set in Backend/server/.env
 */

const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));

require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// Default to the IDs used by seedTestComparison.js so the linked room
// drops straight into the demo comparison roster.
const SEEDED_JOB_ID                = "feed000000000000000000e1";
const SEEDED_JOB_INTERVIEW_ROOM_ID = "feed000000000000000000e2";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const roomId = String(args.room || "").trim();
  if (!roomId) {
    console.error("ERROR: --room <roomId> is required.\n");
    console.error("Example:");
    console.error("  node Backend/scripts/linkCallRoomToJob.js --room room-1779351725930-u4kz53eqq");
    process.exit(2);
  }

  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter";
  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB:", mongoUri.replace(/\/\/[^@]+@/, "//***@"));

  const db = mongoose.connection.db;
  const callRooms        = db.collection("callrooms");
  const jobs             = db.collection("jobs");
  const jobInterviewRooms = db.collection("jobinterviewrooms");

  // ── 1. Locate the call room ────────────────────────────────────────────
  const room = await callRooms.findOne({ roomId });
  if (!room) {
    console.error(`ERROR: CallRoom with roomId="${roomId}" not found.`);
    await mongoose.disconnect();
    process.exit(3);
  }
  console.log(`Found call room: _id=${room._id}, candidate=${room.candidate}, status=${room.status}`);
  console.log(`  Currently linked to: job=${room.job || "—"}  jobInterviewRoom=${room.jobInterviewRoom || "—"}`);

  // ── 2. Resolve the target job + jobInterviewRoom ───────────────────────
  let jobId = args.job ? new mongoose.Types.ObjectId(args.job) : null;
  let jirId = args.jobInterviewRoom ? new mongoose.Types.ObjectId(args.jobInterviewRoom) : null;

  if (!jobId && args.jobTitle) {
    const job = await jobs
      .find({ title: { $regex: new RegExp(`^${escapeRegex(args.jobTitle)}$`, "i") } })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    if (job.length === 0) {
      console.error(`ERROR: No job found with title="${args.jobTitle}".`);
      await mongoose.disconnect();
      process.exit(4);
    }
    jobId = job[0]._id;
    console.log(`Resolved jobTitle="${args.jobTitle}" → jobId=${jobId}`);
  }

  // Fall back to the seeded comparison set when nothing was specified.
  if (!jobId && !jirId) {
    jobId = new mongoose.Types.ObjectId(SEEDED_JOB_ID);
    jirId = new mongoose.Types.ObjectId(SEEDED_JOB_INTERVIEW_ROOM_ID);
    console.log(`No --job/--jobInterviewRoom given. Defaulting to the seeded`);
    console.log(`comparison set (Ahmed / Sarra / Youssef / Nadia):`);
    console.log(`  job              = ${jobId}`);
    console.log(`  jobInterviewRoom = ${jirId}`);
  }

  // If only jobId was given, try to find the JobInterviewRoom that hosts it.
  if (jobId && !jirId) {
    const jir = await jobInterviewRooms.findOne({ job: jobId });
    if (jir) {
      jirId = jir._id;
      console.log(`Found jobInterviewRoom for this job: ${jirId}`);
    } else {
      console.log("WARN: No jobInterviewRoom found for this job. The room");
      console.log("      will be linked to the job but may not show up in");
      console.log("      a job-room comparison roster.");
    }
  }

  // ── 3. Sanity-check the job + jir actually exist ───────────────────────
  if (jobId) {
    const job = await jobs.findOne({ _id: jobId });
    if (!job) {
      console.error(`ERROR: Job ${jobId} does not exist in the database.`);
      console.error("       Did you run `node Backend/scripts/seedTestComparison.js`?");
      await mongoose.disconnect();
      process.exit(5);
    }
    console.log(`Target job: "${job.title}" (id=${jobId})`);
  }
  if (jirId) {
    const jir = await jobInterviewRooms.findOne({ _id: jirId });
    if (!jir) {
      console.error(`ERROR: JobInterviewRoom ${jirId} does not exist.`);
      await mongoose.disconnect();
      process.exit(6);
    }
    console.log(`Target jobInterviewRoom: id=${jirId} company=${jir.company || "—"}`);
  }

  // ── 4. Patch the call room ─────────────────────────────────────────────
  const update = { updatedAt: new Date() };
  if (jobId) update.job = jobId;
  if (jirId) {
    update.jobInterviewRoom = jirId;
    // Carry the company ref over from the jobInterviewRoom so the
    // candidate roster lookup (which keys on company in some routes)
    // also matches without an extra hop.
    const jir = await jobInterviewRooms.findOne({ _id: jirId });
    if (jir && jir.company) update.company = jir.company;
  }

  const result = await callRooms.updateOne({ _id: room._id }, { $set: update });
  console.log(`\nUpdated callrooms: matched=${result.matchedCount}, modified=${result.modifiedCount}`);

  const after = await callRooms.findOne({ _id: room._id });
  console.log(`Now linked to:    job=${after.job || "—"}  jobInterviewRoom=${after.jobInterviewRoom || "—"}  company=${after.company || "—"}`);

  // ── 5. If a ComparisonReport already exists for that jobInterviewRoom,
  //      remind the recruiter to regenerate it so the new candidate is
  //      picked up.
  if (jirId) {
    const cmp = await db.collection("comparisonreports").findOne({ jobInterviewRoom: jirId });
    if (cmp) {
      console.log("\nNOTE: A ComparisonReport already exists for this jobInterviewRoom.");
      console.log("      To include this candidate in the ranking, the recruiter");
      console.log("      should click \"Re-analyze\" on the Candidate Comparison page");
      console.log("      (or POST /api/job-rooms/:id/comparison again).");
    }
  }

  await mongoose.disconnect();
  console.log("\n✓ Done.");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
