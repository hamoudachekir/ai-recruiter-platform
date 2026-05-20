/**
 * Seed Test Comparison Data
 *
 * Inserts one test job, one interview room, 4 candidate users, 4 ended
 * call-room sessions, and 4 interview_final_reports into MongoDB so the
 * Candidate Comparison dashboard has realistic data without real interviews.
 *
 * Usage (run from repo root or from Backend/server):
 *   node Backend/scripts/seedTestComparison.js           # insert / skip if exists
 *   node Backend/scripts/seedTestComparison.js --reset   # delete then re-insert
 *
 * Prerequisites:
 *   MONGO_URI set in .env  (e.g. mongodb://localhost:27017/ai_recruiter)
 */

// Resolve node_modules from Backend/server regardless of where the script is invoked from
const path = require("path");
const serverDir = path.join(__dirname, "..", "server");
module.paths.unshift(path.join(serverDir, "node_modules"));

// Load .env from Backend/server (where MONGO_URI lives)
require("dotenv").config({ path: path.join(serverDir, ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// ─── Fixed ObjectIds ─────────────────────────────────────────────────────────
// 24-char hex strings; must be stable across re-runs so --reset cleans them up.

// Real recruiter account — must exist in the DB before seeding
const REAL_ENTERPRISE_ID = new mongoose.Types.ObjectId("69de57e33e5b115fe5cb2671");

const IDS = {
  enterprise:  REAL_ENTERPRISE_ID,
  job:         new mongoose.Types.ObjectId("feed000000000000000000e1"),
  room:        new mongoose.Types.ObjectId("feed000000000000000000e2"),
  ahmed:       new mongoose.Types.ObjectId("feed000000000000000000a1"),
  sarra:       new mongoose.Types.ObjectId("feed000000000000000000a2"),
  youssef:     new mongoose.Types.ObjectId("feed000000000000000000a3"),
  nadia:       new mongoose.Types.ObjectId("feed000000000000000000a4"),
  ahmedSess:   new mongoose.Types.ObjectId("feed000000000000000000c1"),
  sarraSess:   new mongoose.Types.ObjectId("feed000000000000000000c2"),
  youssefSess: new mongoose.Types.ObjectId("feed000000000000000000c3"),
  nadiaSess:   new mongoose.Types.ObjectId("feed000000000000000000c4"),
};

// Stable string roomIds used by interview_final_reports lookup
const ROOM_IDS = {
  ahmed:   "test-room-ahmed-001",
  sarra:   "test-room-sarra-002",
  youssef: "test-room-youssef-003",
  nadia:   "test-room-nadia-004",
};

// ─── Candidate profiles ───────────────────────────────────────────────────────

const CANDIDATES = [
  {
    _id: IDS.ahmed,
    email: "ahmed.bensalah.test@talan.dev",
    name: "Ahmed Ben Salah",
    firstName: "Ahmed",
    lastName: "Ben Salah",
    sessionId: IDS.ahmedSess,
    roomId: ROOM_IDS.ahmed,
    stack: "Python, FastAPI, PostgreSQL, Docker",
    theta: 0.91, techScore: 89, hrScore: 77, integrity: 95,
    resilience: 94, sentiment: 0.22, completeness: 92,
    stress: "moderate",
    strengths: ["System design expertise (93)", "Highest resilience after stress", "Fastest avg response time"],
    weaknesses: ["Communication needs development (68)", "Moderate stress peaks"],
    transcript: "Ahmed described designing a microservice handling 50k transactions/day with FastAPI and Redis queuing. Demonstrated systematic debugging (traced PostgreSQL deadlock at 2am, fixed in 40min). Strong CAP theorem understanding. Two comfort interventions during high-difficulty questions — recovered fully each time, correctly answered last 4 consecutive hard questions.",
  },
  {
    _id: IDS.sarra,
    email: "sarra.mansouri.test@talan.dev",
    name: "Sarra Mansouri",
    firstName: "Sarra",
    lastName: "Mansouri",
    sessionId: IDS.sarraSess,
    roomId: ROOM_IDS.sarra,
    stack: "Django, Python, PostgreSQL, REST APIs",
    theta: 0.74, techScore: 82, hrScore: 88, integrity: 90,
    resilience: 72, sentiment: 0.11, completeness: 85,
    stress: "mild",
    strengths: ["Strongest problem-solving score (85)", "Excellent communication (91)", "High HR fit (88)"],
    weaknesses: ["System design gap vs senior bar (75)", "Resilience lower than leader (72)"],
    transcript: "Sarra built a multi-tenant SaaS with Django and PostgreSQL RLS serving 200+ businesses. Fixed a 3-second page load with a composite index. Coordinated a 3-person team to deliver a feature in 72 hours. Strong event sourcing understanding with minor gap on projections. One comfort intervention — maintained strong communication throughout.",
  },
  {
    _id: IDS.youssef,
    email: "youssef.trabelsi.test@talan.dev",
    name: "Youssef Trabelsi",
    firstName: "Youssef",
    lastName: "Trabelsi",
    sessionId: IDS.youssefSess,
    roomId: ROOM_IDS.youssef,
    stack: "Node.js, Express, MongoDB, JavaScript",
    theta: 0.62, techScore: 71, hrScore: 80, integrity: 85,
    resilience: 69, sentiment: -0.05, completeness: 74,
    stress: "mild",
    strengths: ["Strong communicator (88)", "High HR fit (80)", "Self-aware about growth areas"],
    weaknesses: ["System design below senior bar (58)", "MongoDB-focused, limited SQL/distributed depth"],
    transcript: "Youssef shipped 3 side projects with real users, showing strong product sense. Solid Node.js fundamentals and MongoDB aggregation. Partial credit on notification system design (missing partitioning/delivery guarantees) and index internals (no selectivity/covering index discussion). Explicitly acknowledged distributed systems gap. One comfort intervention — confidence dipped slightly afterward.",
  },
  {
    _id: IDS.nadia,
    email: "nadia.chouaieb.test@talan.dev",
    name: "Nadia Chouaieb",
    firstName: "Nadia",
    lastName: "Chouaieb",
    sessionId: IDS.nadiaSess,
    roomId: ROOM_IDS.nadia,
    stack: "Java, Spring Boot, MySQL, REST",
    theta: 0.58, techScore: 67, hrScore: 90, integrity: 88,
    resilience: 81, sentiment: 0.08, completeness: 75,
    stress: "high",
    strengths: ["Outstanding communication (95)", "Highest HR fit (90)", "Strong resilience recovery despite 3 interventions"],
    weaknesses: ["Technical fundamentals below senior bar (67)", "High stress with 3 comfort interventions needed"],
    transcript: "Nadia built a production patient-management system (Spring Boot) used daily by clinic staff. Excellent Spring Security knowledge and circuit-breaker understanding. Three comfort interventions due to high stress on distributed systems questions — remarkable recovery each time. Communication quality remained exceptional throughout despite stress peaks. Missed refresh token/revocation detail and microservices observability.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = new Date("2025-05-01T10:00:00Z");

function sessionEnd(offsetMinutes) {
  return new Date(now.getTime() + offsetMinutes * 60_000);
}

// ─── Database Document Builders ───────────────────────────────────────────────

async function buildEnterprise(pwHash) {
  return {
    _id: IDS.enterprise,
    email: "hamoudachkir2000@gmail.com",
    name: "Hamouda Chekir",
    role: "ENTERPRISE",
    password: pwHash,
    isActive: true,
    createdDate: now,
    verificationStatus: {
      emailVerified: true,
      status: "APPROVED",
    },
  };
}

function buildJob() {
  return {
    _id: IDS.job,
    title: "Senior Backend Engineer",
    description: "We are looking for a Senior Backend Engineer with strong Python/FastAPI skills, experience with PostgreSQL and Redis, and the ability to design scalable microservices. The ideal candidate has 3+ years of experience, excellent problem-solving skills under pressure, and can communicate complex technical concepts clearly.",
    location: "Tunis, Tunisia",
    skills: ["Python", "FastAPI", "PostgreSQL", "Redis", "Docker", "Microservices"],
    languages: ["English", "French"],
    entrepriseId: IDS.enterprise,
    status: "OPEN",
    createdAt: now,
  };
}

function buildRoom() {
  return {
    _id: IDS.room,
    job: IDS.job,
    company: IDS.enterprise,
    createdBy: IDS.enterprise,
    slug: "test-room-senior-backend-2025",
    title: "Senior Backend Engineer — Interview Room",
    description: "AI-driven interviews for the Senior Backend Engineer position at TALAN.",
    status: "open",
    settings: {
      interviewStyle: "senior",
      maxCandidates: 0,
      requireFaceVerification: false,
      preferredLanguage: "en",
    },
    stats: {
      totalSessions: 4,
      completedSessions: 4,
      inProgressSessions: 0,
      lastSessionAt: sessionEnd(240),
    },
    createdAt: now,
    updatedAt: sessionEnd(240),
  };
}

function buildCandidateUser(c, pwHash) {
  return {
    _id: c._id,
    email: c.email,
    name: c.name,
    role: "CANDIDATE",
    password: pwHash,
    isActive: true,
    createdDate: now,
    profile: {
      skills: c.stack.split(", "),
      domain: "Software Engineering",
      availability: "Full-time",
    },
  };
}

function buildCallRoom(c, idx) {
  const start = sessionEnd(idx * 60);
  const end = sessionEnd(idx * 60 + 48);
  return {
    _id: c.sessionId,
    roomId: c.roomId,
    initiator: IDS.enterprise,
    initiatorRole: "enterprise",
    candidate: c._id,
    job: IDS.job,
    jobInterviewRoom: IDS.room,
    company: IDS.enterprise,
    status: "ended",
    candidateJoinRequestedAt: start,
    candidateJoinConfirmedAt: start,
    recordingStartedAt: start,
    recordingEndedAt: end,
    transcription: {
      text: c.transcript,
      segments: [],
      overallSentiment: {
        label: c.sentiment >= 0.1 ? "POSITIVE" : c.sentiment <= -0.05 ? "NEGATIVE" : "NEUTRAL",
        score: c.sentiment,
      },
    },
    recruiterReport: {
      scoreBreakdown: {
        technicalScore: c.techScore,
        hrScore: c.hrScore,
        integrityScore: c.integrity,
        answerCompleteness: c.completeness,
        totalScore: Math.round(
          c.techScore * 0.35 + c.hrScore * 0.25 + c.integrity * 0.20 + c.completeness * 0.20
        ),
      },
    },
    rhDecision: { status: "pending", notes: "", decidedAt: "" },
    createdAt: start,
    updatedAt: end,
  };
}

function buildFinalReport(c) {
  return {
    interviewId: c.roomId,
    candidateName: c.name,
    transcriptSummary: c.transcript,
    technicalEvaluation: {
      theta: c.theta,
      thetaScore: c.theta,
      score: c.techScore,
      resilienceIndex: c.resilience,
      answerCompleteness: c.completeness,
      stressProfile: c.stress,
      strengths: c.strengths,
      weaknesses: c.weaknesses,
      summary: c.transcript,
    },
    hrEvaluation: {
      score: c.hrScore,
      resilienceIndex: c.resilience,
      stressProfile: c.stress,
    },
    audioAnalysis: {
      sentimentScore: c.sentiment,
    },
    integrityScore: c.integrity,
    resilienceIndex: c.resilience,
    answerCompleteness: c.completeness,
    scoreBreakdown: {
      technicalScore: c.techScore,
      hrScore: c.hrScore,
      integrityScore: c.integrity,
      answerCompleteness: c.completeness,
      totalScore: Math.round(
        c.techScore * 0.35 + c.hrScore * 0.25 + c.integrity * 0.20 + c.completeness * 0.20
      ),
    },
    createdAt: new Date("2025-05-01T12:00:00Z"),
  };
}

// ─── Seed / Reset ─────────────────────────────────────────────────────────────

const ALL_SEED_IDS = Object.values(IDS);

async function resetTestData(db) {
  console.log("  Removing existing test records…");
  const collections = {
    users:                   ALL_SEED_IDS.filter((_, i) => i <= 7),  // enterprise + 4 candidates
    jobs:                    [IDS.job],
    jobinterviewrooms:       [IDS.room],
    callrooms:               [IDS.ahmedSess, IDS.sarraSess, IDS.youssefSess, IDS.nadiaSess],
    comparisonreports:       null, // by jobInterviewRoom
    interview_final_reports: null, // by interviewId
  };

  // Only delete seeded candidate accounts, NOT the real enterprise user
  await db.collection("users").deleteMany({
    _id: { $in: [IDS.ahmed, IDS.sarra, IDS.youssef, IDS.nadia] },
  });
  await db.collection("jobs").deleteMany({ _id: IDS.job });
  await db.collection("jobinterviewrooms").deleteMany({ _id: IDS.room });
  await db.collection("callrooms").deleteMany({
    _id: { $in: [IDS.ahmedSess, IDS.sarraSess, IDS.youssefSess, IDS.nadiaSess] },
  });
  await db.collection("comparisonreports").deleteMany({ jobInterviewRoom: IDS.room });
  await db.collection("interview_final_reports").deleteMany({
    interviewId: { $in: Object.values(ROOM_IDS) },
  });
  console.log("  Done.\n");
}

async function seed() {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter";

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB:", mongoUri.replace(/\/\/[^@]+@/, "//***@"));

  const db = mongoose.connection.db;

  // Verify the real enterprise user exists
  const enterpriseUser = await db.collection("users").findOne({ _id: IDS.enterprise });
  if (!enterpriseUser) {
    console.error(`\n❌ Enterprise user ${IDS.enterprise} not found in ${mongoUri}`);
    console.error("   Make sure the server DB is correct and the user is registered.\n");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log("✅ Enterprise user found:", enterpriseUser.email);

  const reset = process.argv.includes("--reset");
  if (reset) await resetTestData(db);

  // Check if already seeded (idempotent)
  const existing = await db.collection("jobinterviewrooms").findOne({ _id: IDS.room });
  if (existing && !reset) {
    console.log("Test data already exists. Use --reset to re-seed.\n");
    console.log("Room ID  :", String(IDS.room));
    console.log(`URL      : /entreprise/${IDS.enterprise}/interview-rooms/${IDS.room}/compare`);
    await mongoose.disconnect();
    return;
  }

  const pwHash = await bcrypt.hash("Test@1234", 10);

  // 1. Job (enterprise user already exists — skip creating them)
  await db.collection("jobs").updateOne(
    { _id: IDS.job },
    { $setOnInsert: buildJob() },
    { upsert: true }
  );

  // 3. JobInterviewRoom
  await db.collection("jobinterviewrooms").updateOne(
    { _id: IDS.room },
    { $setOnInsert: buildRoom() },
    { upsert: true }
  );

  // 4. Candidates + sessions + reports
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];

    await db.collection("users").updateOne(
      { _id: c._id },
      { $setOnInsert: buildCandidateUser(c, pwHash) },
      { upsert: true }
    );

    await db.collection("callrooms").updateOne(
      { _id: c.sessionId },
      { $setOnInsert: buildCallRoom(c, i) },
      { upsert: true }
    );

    await db.collection("interview_final_reports").updateOne(
      { interviewId: c.roomId },
      { $setOnInsert: buildFinalReport(c) },
      { upsert: true }
    );
  }

  console.log("\nSeeded: 1 job | 1 interview room | 4 candidates | 4 sessions | 4 analysis reports");
  console.log("────────────────────────────────────────────────────────────────");
  console.log("Job title  : Senior Backend Engineer");
  console.log("Room ID    :", String(IDS.room));
  console.log("Login      : hamoudachkir2000@gmail.com  (use your real password)");
  console.log(`Compare URL: /entreprise/${IDS.enterprise}/interview-rooms/${IDS.room}/compare`);
  console.log("────────────────────────────────────────────────────────────────");
  console.log("Mock endpoint: GET /api/job-rooms/" + IDS.room + "/mock-analyze");
  console.log("\nTo use mock mode, set VITE_USE_MOCK_COMPARISON=true in Frontend/.env.development");

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
