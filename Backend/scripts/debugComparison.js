/**
 * Replays the POST /api/job-rooms/:id/comparison flow against the real
 * data so we can see exactly which step in compareAndRank() blows up.
 *
 *   node Backend/scripts/debugComparison.js 6a0c3edec185c1c98b6bc82e
 */
const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));
require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");

async function main() {
  const jirArg = process.argv[2];
  if (!jirArg) {
    console.error("Usage: node debugComparison.js <jobInterviewRoomId>");
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter");

  // Lazy-require so dotenv is loaded first. Importing User registers its
  // schema so .populate("candidate", ...) below doesn't blow up.
  require(path.join(serverDir, "models", "user"));
  const CallRoom = require(path.join(serverDir, "models", "CallRoom"));
  const JobInterviewRoom = require(path.join(serverDir, "models", "JobInterviewRoom"));
  const Job = require(path.join(serverDir, "models", "Job"));
  // The route uses a buildCandidatePayload helper exported nowhere — rebuild
  // a minimal version here so we surface the same downstream payload.
  const { compareAndRank } = require(path.join(serverDir, "services", "candidateComparisonService"));

  const jir = await JobInterviewRoom.findById(jirArg).populate("job");
  if (!jir) {
    console.error("JobInterviewRoom not found:", jirArg);
    process.exit(3);
  }
  console.log(`Job: "${jir.job?.title}" (id=${jir.job?._id})`);

  const sessions = await CallRoom.find({ jobInterviewRoom: jir._id, status: "ended" })
    .populate("candidate", "email name firstName lastName")
    .lean();
  console.log(`Sessions found: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`  - ${s.candidate?.email || s.candidate?._id || "?"}  status=${s.status}  hasReport=${Boolean(s.recruiterReport)}`);
  }

  // Minimal candidate payload — covers what compareAndRank needs.
  const candidates = sessions.map((s) => {
    const c = s.candidate || {};
    const r = s.recruiterReport?.scoreBreakdown || {};
    return {
      sessionId: String(s._id),
      candidateId: c?._id ? String(c._id) : null,
      candidateName:
        `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
        c.name ||
        (c.email ? c.email.split("@")[0] : "Unknown"),
      candidateEmail: c.email || "",
      metrics: {
        technicalScore: r.technicalScore ?? null,
        hrScore: r.hrScore ?? null,
        integrityScore: r.integrityScore ?? null,
        answerCompleteness: r.answerCompleteness ?? null,
      },
    };
  });

  console.log("\nCalling compareAndRank ...");
  const t0 = Date.now();
  try {
    const result = await compareAndRank({
      jobId: jir.job?._id,
      job: {
        title: jir.job?.title || "",
        description: jir.job?.description || "",
        skills: jir.job?.skills || [],
        languages: jir.job?.languages || [],
      },
      candidates,
      useCache: false,
    });
    console.log(`OK in ${Date.now() - t0}ms — provider=${result.provider}, rankings=${result.rankings?.length}`);
    console.log("First ranking:", JSON.stringify(result.rankings?.[0], null, 2).slice(0, 600));
  } catch (e) {
    console.error("compareAndRank threw:", e.message);
    console.error(e.stack);
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error("debug script failed:", e); process.exit(1); });
