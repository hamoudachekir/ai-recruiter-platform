// End-to-end interview-agent test driven by REAL seeded DB data.
// Pulls a job + candidate (+ call room) from MongoDB and runs the agent
// start -> message -> end flow against http://127.0.0.1:8013.
// Run: $env:NODE_PATH="C:\Users\wh\ai-recruiter-platform\Backend\server\node_modules"; node Backend/scripts/testInterviewFlow.js
require("dotenv").config({ path: require("path").join(__dirname, "..", "server", ".env") });
const mongoose = require("mongoose");
const { UserModel: User, JobModel: Job } = require("../server/models/user");

const AGENT = "http://127.0.0.1:8013";

async function post(path, body) {
  const res = await fetch(AGENT + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Mongo connected:", process.env.MONGO_URI, "\n");

  // --- pull real data from our DB ---
  const job = await Job.findOne({ status: "OPEN" }) || await Job.findOne({});
  const candidate = await User.findOne({ role: "CANDIDATE" });
  if (!job || !candidate) throw new Error("No job/candidate found in DB — run migrate.js first.");

  let CallRoom;
  try { CallRoom = require("../server/models/CallRoom"); } catch {}
  const room = CallRoom ? await (CallRoom.models?.CallRoom || CallRoom).findOne({}).catch(() => null) : null;
  const roomId = room?.roomId || `test-room-${Date.now()}`;

  console.log("📄 Job:        ", job.title, "| skills:", (job.skills || []).slice(0, 6).join(", "));
  console.log("👤 Candidate:  ", candidate.name, `(${candidate._id})`);
  console.log("🚪 Room:       ", roomId, "\n");

  const startBody = {
    room_id: roomId,
    candidate_id: String(candidate._id),
    session_type: "intro",
    job_title: job.title,
    job_skills: job.skills || [],
    job_description: job.description || "",
    interview_style: "friendly",
    candidate_name: candidate.name,
    candidate_profile: candidate.profile || {},
    preferred_language: "en",
  };

  // --- 1) START ---
  console.log("──────── 1) /api/interview/start ────────");
  let r = await post("/api/interview/start", startBody);
  console.log("HTTP", r.status);
  const firstQ = r.json?.message || r.json?.question || r.json?.agent_message || JSON.stringify(r.json).slice(0, 400);
  console.log("🤖 Agent:", firstQ, "\n");

  // --- 2) MESSAGE (candidate answers) ---
  console.log("──────── 2) /api/interview/message ────────");
  r = await post("/api/interview/message", {
    room_id: roomId,
    candidate_id: String(candidate._id),
    message:
      "Hi! I'm a full-stack engineer with 5 years building React and Node.js apps backed by MongoDB. " +
      "Recently I led migrating a monolith to microservices with Docker and CI/CD.",
    response_time_sec: 7.5,
    sentiment_delta: 0.3,
  });
  console.log("HTTP", r.status);
  const followUp = r.json?.message || r.json?.question || r.json?.agent_message || JSON.stringify(r.json).slice(0, 400);
  console.log("🤖 Agent:", followUp, "\n");

  // --- 3) END ---
  console.log("──────── 3) /api/interview/end ────────");
  r = await post("/api/interview/end", { room_id: roomId, candidate_id: String(candidate._id) });
  console.log("HTTP", r.status);
  console.log("📋 End payload:", JSON.stringify(r.json).slice(0, 600), "\n");

  console.log("✅ Interview flow test complete.");
  await mongoose.disconnect();
})().catch((e) => { console.error("❌", e); process.exit(1); });
