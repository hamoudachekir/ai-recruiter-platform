/**
 * seedCompareTest.js
 *
 * Seeds 4 completed CallRoom sessions for the 4 test candidates against
 * a given JobInterviewRoom so the recruiter can exercise the "Compare AI
 * Candidates" feature without running real interviews.
 *
 * Usage:
 *   node Backend/server/scripts/seedCompareTest.js [jobInterviewRoomId]
 *
 * If no roomId is passed the script looks for the most-recent
 * JobInterviewRoom whose linked Job title contains "Senior Full-Stack".
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });
require("dotenv").config();

const mongoose = require("mongoose");
const path = require("path");

const CallRoom = require(path.join(__dirname, "..", "models", "CallRoom"));
const JobInterviewRoom = require(path.join(
  __dirname,
  "..",
  "models",
  "JobInterviewRoom",
));
const Job = require(path.join(__dirname, "..", "models", "job"));

const TEST_CANDIDATES = [
  { id: "feed000000000000000000a1", name: "Ahmed Ben Salah" },
  { id: "feed000000000000000000a2", name: "Sarra Mansouri" },
  { id: "feed000000000000000000a3", name: "Youssef Trabelsi" },
  { id: "feed000000000000000000a4", name: "Nadia Chouaieb" },
];

const MOCK_METRICS = [
  { technicalScore: 89, hrScore: 77, technicalTheta: 0.91, resilienceIndex: 94, sentimentScore: 0.36, answerCompleteness: 85, integrityScore: 92 },
  { technicalScore: 82, hrScore: 88, technicalTheta: 0.74, resilienceIndex: 72, sentimentScore: 0.82, answerCompleteness: 91, integrityScore: 88 },
  { technicalScore: 71, hrScore: 80, technicalTheta: 0.62, resilienceIndex: 69, sentimentScore: 0.76, answerCompleteness: 88, integrityScore: 81 },
  { technicalScore: 67, hrScore: 90, technicalTheta: 0.58, resilienceIndex: 81, sentimentScore: 0.90, answerCompleteness: 95, integrityScore: 77 },
];

const buildRecruiterReport = (metrics) => ({
  scoreBreakdown: {
    technicalScore: metrics.technicalScore,
    hrScore: metrics.hrScore,
    integrityScore: metrics.integrityScore,
    answerCompleteness: metrics.answerCompleteness,
    totalScore: Math.round(
      metrics.technicalScore * 0.4 +
        metrics.hrScore * 0.3 +
        metrics.answerCompleteness * 0.3,
    ),
  },
  technicalEvaluation: {
    theta: metrics.technicalTheta,
    score: metrics.technicalScore,
    resilienceIndex: metrics.resilienceIndex,
    answerCompleteness: metrics.answerCompleteness,
  },
  hrEvaluation: { score: metrics.hrScore },
  integrityScore: metrics.integrityScore,
  finalRecommendation: { overallScore: metrics.technicalScore },
});

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  const argRoomId = process.argv[2];
  let room = null;

  if (argRoomId) {
    if (!mongoose.isValidObjectId(argRoomId)) {
      console.error(`Invalid JobInterviewRoom id: ${argRoomId}`);
      process.exit(1);
    }
    room = await JobInterviewRoom.findById(argRoomId).populate("job");
    if (!room) {
      console.error(`JobInterviewRoom ${argRoomId} not found`);
      process.exit(1);
    }
  } else {
    // Auto-find: pick the most-recently-created room linked to a job whose
    // title contains "Senior Full-Stack".
    const candidates = await JobInterviewRoom.find()
      .populate("job")
      .sort({ createdAt: -1 })
      .lean();
    room = candidates.find((r) =>
      (r.job?.title || "").toLowerCase().includes("senior full-stack"),
    );
    if (!room) {
      console.error(
        'No JobInterviewRoom found whose job title contains "Senior Full-Stack". ' +
          "Pass the room _id explicitly:\n  node seedCompareTest.js <roomId>",
      );
      process.exit(1);
    }
    // Re-fetch as a real document (the lean copy can't be saved).
    room = await JobInterviewRoom.findById(room._id).populate("job");
  }

  console.log(
    `→ Seeding into JobInterviewRoom ${room._id}  (job: ${room.job?.title || "?"})`,
  );

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < TEST_CANDIDATES.length; i++) {
    const cand = TEST_CANDIDATES[i];
    if (!mongoose.isValidObjectId(cand.id)) {
      console.warn(`  ⚠ skipping ${cand.name}: invalid id`);
      continue;
    }

    const existing = await CallRoom.findOne({
      jobInterviewRoom: room._id,
      candidate: cand.id,
      status: "ended",
    });
    if (existing) {
      console.log(`  • ${cand.name} already has a completed session — skipping`);
      skipped += 1;
      continue;
    }

    const metrics = MOCK_METRICS[i] || MOCK_METRICS[MOCK_METRICS.length - 1];
    const roomId = `room-seed-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}`;

    await CallRoom.create({
      roomId,
      initiator: room.company,
      initiatorRole: "enterprise",
      candidate: cand.id,
      job: room.job._id || room.job,
      company: room.company,
      jobInterviewRoom: room._id,
      status: "ended",
      recordingStartedAt: new Date(Date.now() - 3600000),
      recordingEndedAt: new Date(Date.now() - 3000000),
      transcription: {
        text: `Seeded test session for ${cand.name}.`,
        overallSentiment: {
          label: metrics.sentimentScore > 0.5 ? "POSITIVE" : "NEUTRAL",
          score: metrics.sentimentScore,
        },
      },
      recruiterReport: buildRecruiterReport(metrics),
      rhDecision: { status: "pending", notes: "", decidedAt: "" },
    });

    console.log(
      `  ✓ ${cand.name}  tech=${metrics.technicalScore} hr=${metrics.hrScore} theta=${metrics.technicalTheta}`,
    );
    created += 1;
  }

  // Refresh aggregate stats on the room.
  const sessions = await CallRoom.find({ jobInterviewRoom: room._id })
    .select("status recordingEndedAt updatedAt createdAt")
    .lean();
  const completed = sessions.filter((s) => s.status === "ended").length;
  const inProgress = sessions.filter(
    (s) => s.status === "active" || s.status === "waiting_confirmation",
  ).length;
  const lastSessionAt = sessions.reduce((acc, s) => {
    const ts = s.recordingEndedAt || s.updatedAt || s.createdAt;
    if (!acc || (ts && new Date(ts) > new Date(acc))) return ts;
    return acc;
  }, null);
  room.stats = {
    totalSessions: sessions.length,
    completedSessions: completed,
    inProgressSessions: inProgress,
    lastSessionAt,
  };
  await room.save();

  console.log("");
  console.log(
    `Done. created=${created}  skipped=${skipped}  total in room=${sessions.length}  completed=${completed}`,
  );
  console.log(
    `Open the compare page:  /entreprise/${room.company}/interview-rooms/${room._id}/compare`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
