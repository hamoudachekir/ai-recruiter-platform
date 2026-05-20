const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const { verifyToken } = require("../middleware/auth");
const JobInterviewRoom = require("../models/JobInterviewRoom");
const ComparisonReport = require("../models/ComparisonReport");
const CallRoom = require("../models/CallRoom");
const Job = require("../models/job");
const { UserModel } = require("../models/user");

const { compareAndRank } = require("../services/candidateComparisonService");

const isEnterpriseRole = (role) => {
  const r = String(role || "").toLowerCase();
  return r === "enterprise" || r === "rh";
};

const computeStats = async (jobInterviewRoomId) => {
  const sessions = await CallRoom.find({ jobInterviewRoom: jobInterviewRoomId })
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

  return {
    totalSessions: sessions.length,
    completedSessions: completed,
    inProgressSessions: inProgress,
    lastSessionAt,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Company-facing endpoints
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/job-rooms/seed-test
// Creates (or reuses) a JobInterviewRoom for a job, then inserts completed
// CallRoom sessions for each candidateId in the array so the compare
// dashboard has data to work with without running real interviews.
// Body: { jobId, candidateIds: [ObjectId, ...] }
router.post("/seed-test", verifyToken, async (req, res) => {
  try {
    const { UserModel: UserMod } = require("../models/user");
    const user = await UserMod.findById(req.user._id);
    if (!user || !isEnterpriseRole(user.role)) {
      return res.status(403).json({ message: "Only enterprise users can seed test data" });
    }

    const { jobId, candidateIds } = req.body || {};
    if (!jobId || !mongoose.isValidObjectId(jobId)) {
      return res.status(400).json({ message: "jobId is required" });
    }
    const ids = Array.isArray(candidateIds) ? candidateIds.filter(Boolean) : [];
    if (ids.length < 1) {
      return res.status(400).json({ message: "candidateIds array must not be empty" });
    }

    const job = await Job.findById(jobId).lean();
    if (!job) return res.status(404).json({ message: "Job not found" });

    // Find or create the JobInterviewRoom for this job + company.
    let room = await JobInterviewRoom.findOne({ job: jobId, company: req.user._id });
    if (!room) {
      room = await JobInterviewRoom.create({
        job: jobId,
        company: req.user._id,
        createdBy: req.user._id,
        slug: JobInterviewRoom.generateSlug(),
        title: `AI Interviews — ${job.title || "Job"}`,
      });
    }

    // Mock metric sets indexed by position in the candidateIds array.
    const MOCK_METRICS = [
      { technicalScore: 89, hrScore: 77, technicalTheta: 0.91, resilienceIndex: 94, sentimentScore: 0.36, answerCompleteness: 85, integrityScore: 92 },
      { technicalScore: 82, hrScore: 88, technicalTheta: 0.74, resilienceIndex: 72, sentimentScore: 0.82, answerCompleteness: 91, integrityScore: 88 },
      { technicalScore: 71, hrScore: 80, technicalTheta: 0.62, resilienceIndex: 69, sentimentScore: 0.76, answerCompleteness: 88, integrityScore: 81 },
      { technicalScore: 67, hrScore: 90, technicalTheta: 0.58, resilienceIndex: 81, sentimentScore: 0.90, answerCompleteness: 95, integrityScore: 77 },
    ];

    const createdSessions = [];
    for (let i = 0; i < ids.length; i++) {
      const candidateId = ids[i];
      if (!mongoose.isValidObjectId(candidateId)) continue;

      // Skip if an ended session for this candidate + room already exists.
      const existing = await CallRoom.findOne({
        jobInterviewRoom: room._id,
        candidate: candidateId,
        status: "ended",
      });
      if (existing) { createdSessions.push(existing._id); continue; }

      const metrics = MOCK_METRICS[i] || MOCK_METRICS[MOCK_METRICS.length - 1];
      const roomId = `room-seed-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}`;
      const session = await CallRoom.create({
        roomId,
        initiator: req.user._id,
        initiatorRole: "enterprise",
        candidate: candidateId,
        job: jobId,
        company: req.user._id,
        jobInterviewRoom: room._id,
        status: "ended",
        recordingStartedAt: new Date(Date.now() - 3600000),
        recordingEndedAt: new Date(Date.now() - 3000000),
        transcription: {
          text: "Seeded test session — no real transcript.",
          overallSentiment: {
            label: metrics.sentimentScore > 0.5 ? "POSITIVE" : "NEUTRAL",
            score: metrics.sentimentScore,
          },
        },
        recruiterReport: {
          scoreBreakdown: {
            technicalScore: metrics.technicalScore,
            hrScore: metrics.hrScore,
            integrityScore: metrics.integrityScore,
            answerCompleteness: metrics.answerCompleteness,
            totalScore: Math.round(
              (metrics.technicalScore * 0.4 + metrics.hrScore * 0.3 + metrics.answerCompleteness * 0.3)
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
        },
        rhDecision: { status: "pending", notes: "", decidedAt: "" },
      });
      createdSessions.push(session._id);
    }

    const stats = await computeStats(room._id);
    room.stats = stats;
    await room.save();

    return res.json({
      success: true,
      room: { _id: room._id, slug: room.slug, title: room.title, stats: room.stats },
      sessionsCreated: createdSessions.length,
      compareUrl: `/entreprise/${req.user._id}/interview-rooms/${room._id}/compare`,
    });
  } catch (err) {
    console.error("Seed test error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// POST /api/job-rooms — create a shareable interview room for a job
router.post("/", verifyToken, async (req, res) => {
  try {
    const { jobId, title, description, settings } = req.body || {};
    if (!jobId || !mongoose.isValidObjectId(jobId)) {
      return res.status(400).json({ message: "jobId is required" });
    }

    const job = await Job.findById(jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });

    const user = await UserModel.findById(req.user._id);
    if (!user || !isEnterpriseRole(user.role)) {
      return res
        .status(403)
        .json({ message: "Only enterprise users can create interview rooms" });
    }

    // The job's enterpriseId must match the requester (or be unset legacy data)
    if (
      job.entrepriseId &&
      String(job.entrepriseId) !== String(req.user._id)
    ) {
      return res
        .status(403)
        .json({ message: "You can only create rooms for your own jobs" });
    }

    const slug = JobInterviewRoom.generateSlug();
    const room = await JobInterviewRoom.create({
      job: job._id,
      company: req.user._id,
      createdBy: req.user._id,
      slug,
      title: title || `Interviews — ${job.title}`,
      description: description || "",
      settings: {
        interviewStyle: settings?.interviewStyle || "friendly",
        maxCandidates: Number(settings?.maxCandidates || 0),
        requireFaceVerification: Boolean(settings?.requireFaceVerification),
        preferredLanguage: settings?.preferredLanguage || "en",
      },
    });

    return res.status(201).json({ success: true, room });
  } catch (error) {
    console.error("Create JobInterviewRoom error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms — list rooms for the current company (optionally by job)
router.get("/", verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    if (!user || !isEnterpriseRole(user.role)) {
      return res
        .status(403)
        .json({ message: "Only enterprise users can list interview rooms" });
    }

    const filter = { company: req.user._id };
    if (req.query.jobId && mongoose.isValidObjectId(req.query.jobId)) {
      filter.job = req.query.jobId;
    }

    const rooms = await JobInterviewRoom.find(filter)
      .populate("job", "title skills languages location status")
      .sort({ createdAt: -1 })
      .lean();

    // Cheap stat refresh — for dashboard-sized result sets (<200 rooms) this is
    // fine; the heavier per-session payload stays out of the response.
    const enriched = await Promise.all(
      rooms.map(async (room) => {
        const stats = await computeStats(room._id);
        return { ...room, stats };
      }),
    );

    return res.json({ success: true, rooms: enriched });
  } catch (error) {
    console.error("List JobInterviewRooms error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id — full detail for company dashboard
router.get("/:id", verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid room id" });
    }

    const room = await JobInterviewRoom.findById(req.params.id)
      .populate("job", "title description skills languages location")
      .populate("createdBy", "email name firstName lastName");
    if (!room) return res.status(404).json({ message: "Room not found" });

    if (String(room.company) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this room" });
    }

    const stats = await computeStats(room._id);
    room.stats = stats;
    await room.save();

    return res.json({ success: true, room });
  } catch (error) {
    console.error("Get JobInterviewRoom error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id/sessions — list candidate sessions for a room
router.get("/:id/sessions", verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid room id" });
    }

    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const sessions = await CallRoom.find({ jobInterviewRoom: room._id })
      .populate("candidate", "email name firstName lastName profile.domain")
      .select(
        "roomId status candidate candidateJoinRequestedAt candidateJoinConfirmedAt " +
          "recordingStartedAt recordingEndedAt createdAt updatedAt " +
          "transcription.overallSentiment agentSnapshot rhDecision recruiterReport",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Trim heavy nested data — UI only needs counters + final score for the list.
    const trimmed = sessions.map((s) => ({
      _id: s._id,
      roomId: s.roomId,
      status: s.status,
      candidate: s.candidate,
      candidateJoinRequestedAt: s.candidateJoinRequestedAt,
      candidateJoinConfirmedAt: s.candidateJoinConfirmedAt,
      recordingStartedAt: s.recordingStartedAt,
      recordingEndedAt: s.recordingEndedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      sentiment: s.transcription?.overallSentiment || null,
      rhDecision: s.rhDecision || null,
      overallScore: s.recruiterReport?.finalRecommendation?.overallScore ?? null,
    }));

    return res.json({ success: true, sessions: trimmed });
  } catch (error) {
    console.error("List room sessions error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id/stats — counters for live dashboard
router.get("/:id/stats", verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid room id" });
    }
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const stats = await computeStats(room._id);
    room.stats = stats;
    await room.save();

    return res.json({ success: true, stats });
  } catch (error) {
    console.error("Get room stats error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// PATCH /api/job-rooms/:id/close — close room to new candidates
router.patch("/:id/close", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    room.status = "closed";
    room.closedAt = new Date();
    await room.save();
    return res.json({ success: true, room });
  } catch (error) {
    console.error("Close room error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// PATCH /api/job-rooms/:id/reopen
router.patch("/:id/reopen", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    room.status = "open";
    room.closedAt = null;
    await room.save();
    return res.json({ success: true, room });
  } catch (error) {
    console.error("Reopen room error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Candidate-facing endpoints (slug based)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/job-rooms/by-slug/:slug — public-ish: details for join page
router.get("/by-slug/:slug", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findOne({ slug: req.params.slug })
      .populate("job", "title description skills languages location")
      .populate("company", "firstName lastName name email enterprise");

    if (!room) return res.status(404).json({ message: "Room not found" });

    return res.json({
      success: true,
      room: {
        _id: room._id,
        slug: room.slug,
        title: room.title,
        description: room.description,
        status: room.status,
        job: room.job,
        company: {
          _id: room.company?._id,
          name:
            room.company?.enterprise?.name ||
            (`${room.company?.firstName || ""} ${room.company?.lastName || ""}`.trim() || room.company?.name || "") ||
            "",
        },
        settings: room.settings,
      },
    });
  } catch (error) {
    console.error("Get room by slug error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// POST /api/job-rooms/by-slug/:slug/join — candidate creates a CallRoom session
router.post("/by-slug/:slug/join", verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = String(user?.role || "").toLowerCase();
    if (!user || role !== "candidate") {
      return res
        .status(403)
        .json({ message: "Only candidates can join interview rooms" });
    }

    const room = await JobInterviewRoom.findOne({ slug: req.params.slug });
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (room.status !== "open") {
      return res
        .status(400)
        .json({ message: "This interview room is closed." });
    }

    if (
      room.settings?.maxCandidates &&
      room.stats?.totalSessions >= room.settings.maxCandidates
    ) {
      return res
        .status(400)
        .json({ message: "This interview room is full." });
    }

    // Reuse the most recent active or waiting session for this candidate so a
    // refresh on the join page doesn't create duplicates.
    const existing = await CallRoom.findOne({
      jobInterviewRoom: room._id,
      candidate: req.user._id,
      status: { $in: ["waiting_confirmation", "active"] },
    });
    if (existing) {
      return res.json({
        success: true,
        room: existing,
        resumed: true,
      });
    }

    const publicRoomId = `room-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 11)}`;

    const callRoom = await CallRoom.create({
      roomId: publicRoomId,
      initiator: room.createdBy,
      initiatorRole: "enterprise",
      candidate: req.user._id,
      candidateJoinRequestedAt: new Date(),
      candidateJoinConfirmedAt: new Date(),
      job: room.job,
      jobInterviewRoom: room._id,
      company: room.company,
      status: "active",
      recordingStartedAt: new Date(),
    });

    room.stats.totalSessions += 1;
    room.stats.inProgressSessions += 1;
    room.stats.lastSessionAt = new Date();
    await room.save();

    return res.status(201).json({ success: true, room: callRoom });
  } catch (error) {
    console.error("Join room error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Comparison + Leaderboard
// ─────────────────────────────────────────────────────────────────────────────

const extractReportMetrics = (callRoom, analysisReport) => {
  const ar = analysisReport || {};
  const tech = ar.technicalEvaluation || {};
  const hr = ar.hrEvaluation || {};
  const audio = ar.audioAnalysis || {};
  const integrity = ar.integrityScore;
  const recruiterReport = callRoom.recruiterReport || {};
  const breakdown = recruiterReport.scoreBreakdown || ar.scoreBreakdown || {};

  return {
    technicalTheta: tech.theta ?? tech.thetaScore ?? null,
    technicalScore: tech.score ?? breakdown.technicalScore ?? null,
    hrScore: hr.score ?? breakdown.hrScore ?? null,
    integrityScore: integrity ?? breakdown.integrityScore ?? null,
    resilienceIndex:
      tech.resilienceIndex ?? hr.resilienceIndex ?? ar.resilienceIndex ?? null,
    sentimentScore:
      callRoom.transcription?.overallSentiment?.score ??
      audio.sentimentScore ??
      null,
    answerCompleteness:
      tech.answerCompleteness ??
      breakdown.answerCompleteness ??
      ar.answerCompleteness ??
      null,
    stressProfile: tech.stressProfile || hr.stressProfile || "",
    overallScore: breakdown.totalScore ?? ar.overallScore ?? null,
    candidateName: ar.candidateName || "",
    summary: ar.transcriptSummary || tech.summary || "",
    strengths: tech.strengths || [],
    weaknesses: tech.weaknesses || [],
  };
};

const buildCandidatePayload = async (callRoom) => {
  // Pull the analysis-pipeline report from the dedicated collection — that's
  // where IRT theta, stress profile, sentiment trends, etc. live. Falls back
  // gracefully when only the inline recruiterReport is available.
  let analysisReport = null;
  try {
    analysisReport = await mongoose.connection.db
      .collection("interview_final_reports")
      .findOne({ interviewId: callRoom.roomId || String(callRoom._id) });
  } catch (err) {
    console.warn("[comparison] interview_final_reports lookup failed:", err.message);
  }

  const metrics = extractReportMetrics(callRoom, analysisReport);
  const candidate = callRoom.candidate || {};
  // Some seed/test users only have a single `name` field; real users have
  // firstName/lastName. Try first/last → then `name` → finally pretty-print
  // from the email local-part so the radar legend never shows raw emails.
  const fullName =
    `${candidate.firstName || ""} ${candidate.lastName || ""}`.trim() ||
    candidate.name ||
    "";
  const fromEmail = candidate.email
    ? candidate.email
        .split("@")[0]
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (m) => m.toUpperCase())
    : "";
  const candidateName =
    metrics.candidateName ||
    fullName ||
    fromEmail ||
    "Unknown candidate";

  return {
    sessionId: String(callRoom._id),
    candidateId: candidate?._id ? String(candidate._id) : null,
    candidateName,
    candidateEmail: candidate.email || "",
    metrics,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/job-rooms/:id/mock-analyze  — instant hardcoded comparison (no LLM)
// Use with VITE_USE_MOCK_COMPARISON=true during development/testing.
// Saves the result to MongoDB so subsequent GET /comparison and GET /candidates
// calls show the same data as a real analysis.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/mock-analyze", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id).populate("job");
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const sessions = await CallRoom.find({
      jobInterviewRoom: room._id,
      status: "ended",
    })
      .populate("candidate", "email name firstName lastName")
      .lean();

    if (sessions.length < 2) {
      return res.status(400).json({
        message: "At least 2 completed sessions required for mock comparison.",
        eligibleSessions: sessions.length,
      });
    }

    // Build candidate payloads using the same helper as the real comparison
    const candidatePayloads = await Promise.all(
      sessions.map((s) => buildCandidatePayload(s))
    );

    // Sort sessions by creation time — this is the order hardcoded scores apply
    const sorted = sessions.slice().sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    // Hardcoded scores aligned to the 4 seeded candidates by position:
    //   pos 0 → Ahmed (rank 1), pos 1 → Sarra (rank 2),
    //   pos 2 → Youssef (rank 3), pos 3 → Nadia (rank 4)
    const MOCK_SCORES = [
      {
        rank: 1, suitabilityScore: 83, compositeScore: 84.65,
        compositeBreakdown: { technical: 89, theta_normalized: 91, resilience: 94, system_design: 91, problem_solving: 87, communication: 68, hr_fit: 77 },
        matchScore: 83,
        strengths: ["Top system design score (93)", "Highest resilience after stress (94)", "Fastest avg response time (38s)"],
        gaps: ["Communication needs development (68)", "Moderate stress peaks in session 2"],
        strongestPoint: "Demonstrated adaptive reasoning under high-difficulty questions with full stress recovery.",
        mainWeakness: "Communication score (68) is below the team collaboration bar expected at senior level.",
        hiringRecommendation: "Strongly Recommend",
        justification: "Ahmed leads on the three highest-weighted dimensions: technical accuracy (89), IRT theta (0.91), and system design (93). His resilience of 94 is the highest in the cohort — he recovered fully after two comfort interventions.",
      },
      {
        rank: 2, suitabilityScore: 79, compositeScore: 80.2,
        compositeBreakdown: { technical: 82, theta_normalized: 74, resilience: 72, system_design: 79, problem_solving: 85, communication: 91, hr_fit: 88 },
        matchScore: 79,
        strengths: ["Strongest problem-solving score (85)", "Excellent communication (91)", "High HR fit (88)"],
        gaps: ["System design gap vs senior bar (75)", "Resilience lower than cohort leader (72)"],
        strongestPoint: "Superior communication and stakeholder bridging skills; built multi-tenant SaaS serving 200+ businesses.",
        mainWeakness: "System design (75) is 18 points behind the cohort leader, below the senior architecture bar.",
        hiringRecommendation: "Recommend",
        justification: "Sarra's problem-solving (85) and communication (91) make her a strong second. For roles bridging product and engineering she deserves equal consideration.",
      },
      {
        rank: 3, suitabilityScore: 68, compositeScore: 70.1,
        compositeBreakdown: { technical: 71, theta_normalized: 62, resilience: 69, system_design: 68, problem_solving: 74, communication: 88, hr_fit: 80 },
        matchScore: 68,
        strengths: ["Strong communicator (88)", "High HR fit (80)", "Self-aware about growth areas"],
        gaps: ["System design significantly below senior bar (58)", "MongoDB-focused — limited SQL/distributed experience"],
        strongestPoint: "Exceptional product intuition and communication clarity; shipped real-world side projects.",
        mainWeakness: "System design score (58) is 35 points below the senior bar; needs 12–18 months of mentoring.",
        hiringRecommendation: "Consider",
        justification: "Youssef is a strong mid-level hire. His self-awareness about distributed systems gaps and eagerness to grow are assets. Better suited for a mid-level role with mentoring.",
      },
      {
        rank: 4, suitabilityScore: 61, compositeScore: 63.3,
        compositeBreakdown: { technical: 67, theta_normalized: 58, resilience: 81, system_design: 62, problem_solving: 70, communication: 95, hr_fit: 90 },
        matchScore: 61,
        strengths: ["Outstanding communication (95)", "Highest HR fit in cohort (90)", "Strong resilience recovery despite 3 interventions"],
        gaps: ["Technical fundamentals below senior bar (67)", "High stress level — 3 comfort interventions needed"],
        strongestPoint: "Communication quality (95) never degraded under stress — rare and valuable in team-facing roles.",
        mainWeakness: "Technical score (67) and IRT theta (0.58) are below the senior bar; strong candidate for a junior-to-mid track.",
        hiringRecommendation: "Consider",
        justification: "Nadia's extraordinary soft skills and HR fit would make her a cultural asset. Technical fundamentals need 1–2 years of structured growth before senior-level autonomy.",
      },
    ];

    const byId = new Map(candidatePayloads.map((c) => [c.sessionId, c]));

    const rankings = sorted.map((s, i) => {
      const source = byId.get(String(s._id)) || {};
      const scores = MOCK_SCORES[i] || MOCK_SCORES[MOCK_SCORES.length - 1];
      return {
        session: s._id,
        candidate: s.candidate?._id || undefined,
        candidateName: source.candidateName || "",
        candidateEmail: source.candidateEmail || s.candidate?.email || "",
        rank: scores.rank,
        suitabilityScore: scores.suitabilityScore,
        compositeScore: scores.compositeScore,
        compositeBreakdown: scores.compositeBreakdown,
        matchScore: scores.matchScore,
        strengths: scores.strengths,
        gaps: scores.gaps,
        strongestPoint: scores.strongestPoint,
        mainWeakness: scores.mainWeakness,
        hiringRecommendation: scores.hiringRecommendation,
        justification: scores.justification,
        metrics: source.metrics || {},
      };
    }).sort((a, b) => a.rank - b.rank);

    const recommendedSessionId = String(sorted[0]?._id || "");

    // Upsert the ComparisonReport so GET /comparison and GET /candidates reflect mock data
    await ComparisonReport.deleteMany({ jobInterviewRoom: room._id });
    const comparison = await ComparisonReport.create({
      job: room.job._id || room.job,
      jobInterviewRoom: room._id,
      company: room.company,
      requestedBy: req.user._id,
      status: "ready",
      sessionIds: sessions.map((s) => s._id),
      candidateCount: sessions.length,
      rankings,
      executiveSummary: "Ahmed Ben Salah leads across all high-weight technical dimensions. Sarra Mansouri is a close second and preferred for cross-functional roles. Youssef and Nadia are strong mid-level candidates.",
      narrativeComparison: "This cohort shows a clear technical leader (Ahmed) and an interesting technical-vs-communication tradeoff. Ahmed dominates IRT-weighted technical dimensions, particularly system design (93), which is 18 points above the next candidate. Sarra is Ahmed's closest rival — her problem-solving (85) exceeds his, and her communication (91 vs 68) makes her significantly more effective in stakeholder-facing scenarios. The recruiter's core decision: does this role require more deep system architecture or cross-team communication? Youssef's Node.js background and self-awareness make him a strong mid-level hire. Nadia's empathy and communication (95) are extraordinary — she would thrive with structured technical mentoring.",
      recommendedCandidateId: recommendedSessionId,
      confidencePct: 91,
      isClosingCall: true,
      tiebreakerQuestion: "Describe a time you debugged a production incident under pressure — walk me through your exact steps.",
      llmProvider: "mock/hardcoded",
      generatedAt: new Date(),
    });

    return res.json({ success: true, comparison, _mock: true });
  } catch (error) {
    console.error("Mock analyze error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// POST /api/job-rooms/:id/comparison — trigger an AI ranking
// NVIDIA Llama 3.3 70B free-tier can take 2-3 minutes — extend socket timeout
router.post("/:id/comparison", verifyToken, (req, res, next) => {
  req.socket.setTimeout(300_000); // 5 minutes
  res.setTimeout(300_000);
  next();
}, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id).populate("job");
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const sessionFilter = { jobInterviewRoom: room._id };
    const onlyCompleted = req.body?.includeOnlyCompleted !== false;
    if (onlyCompleted) sessionFilter.status = "ended";

    const sessions = await CallRoom.find(sessionFilter)
      .populate("candidate", "email name firstName lastName")
      .lean();

    if (sessions.length < 2) {
      return res.status(400).json({
        message:
          "At least 2 completed candidate sessions are required for a comparison.",
        eligibleSessions: sessions.length,
      });
    }

    const candidatePayloads = await Promise.all(
      sessions.map((s) => buildCandidatePayload(s)),
    );

    const comparison = await ComparisonReport.create({
      job: room.job._id,
      jobInterviewRoom: room._id,
      company: room.company,
      requestedBy: req.user._id,
      status: "running",
      sessionIds: sessions.map((s) => s._id),
      candidateCount: sessions.length,
    });

    // Call Claude AI directly. Synchronous so the recruiter sees the ranking
    // immediately. On timeout/failure we persist the error and let the client retry.
    try {
      const payload = await compareAndRank({
        jobId: room.job._id,
        job: {
          title: room.job?.title || "",
          description: room.job?.description || "",
          skills: room.job?.skills || [],
          languages: room.job?.languages || [],
          company: "",
        },
        candidates: candidatePayloads,
      });

      const rankings = Array.isArray(payload.rankings) ? payload.rankings : [];
      const byId = new Map(candidatePayloads.map((c) => [c.sessionId, c]));

      comparison.rankings = rankings
        .map((r) => {
          const source = byId.get(String(r.session_id)) || {};
          return {
            session: source.sessionId
              ? new mongoose.Types.ObjectId(source.sessionId)
              : undefined,
            candidate: source.candidateId
              ? new mongoose.Types.ObjectId(source.candidateId)
              : undefined,
            candidateName: source.candidateName || r.candidateName || "",
            candidateEmail: source.candidateEmail || "",
            rank: Number(r.rank) || 0,
            suitabilityScore: Number(r.suitability_score ?? r.suitabilityScore) || 0,
            compositeScore: Number(r.composite_score) || null,
            compositeBreakdown: r.composite_breakdown || {},
            matchScore: Number(r.match_score) || null,
            strengths: Array.isArray(r.strengths) ? r.strengths : [],
            gaps: Array.isArray(r.gaps) ? r.gaps : [],
            strongestPoint: String(r.strongest_point || r.strongestPoint || ""),
            mainWeakness: String(r.main_weakness || r.mainWeakness || ""),
            hiringRecommendation: String(r.hiring_recommendation || r.hiringRecommendation || ""),
            justification: String(r.justification || ""),
            metrics: source.metrics || {},
          };
        })
        .sort((a, b) => a.rank - b.rank);

      comparison.executiveSummary = String(payload.executive_summary || payload.executiveSummary || "");
      comparison.narrativeComparison = String(payload.narrative_comparison || "");
      comparison.recommendedCandidateId = String(payload.recommended_candidate_id || "");
      comparison.confidencePct = Number(payload.confidence_pct) || null;
      comparison.isClosingCall = Boolean(payload.close_call);
      comparison.tiebreakerQuestion = String(payload.tiebreaker_question || "");
      comparison.llmProvider = String(payload.provider || "");
      comparison.status = "ready";
      comparison.generatedAt = new Date();
      await comparison.save();

      return res.json({ success: true, comparison });
    } catch (err) {
      const detail = err?.message || "LLM failed";
      console.error("[comparison] LLM call failed:", detail);
      comparison.status = "failed";
      comparison.error = String(detail).slice(0, 1000);
      await comparison.save();
      return res
        .status(502)
        .json({ message: "Comparison agent failed", error: detail });
    }
  } catch (error) {
    console.error("Trigger comparison error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id/comparison — fetch latest ranking
router.get("/:id/comparison", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const comparison = await ComparisonReport.findOne({
      jobInterviewRoom: room._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, comparison: comparison || null });
  } catch (error) {
    console.error("Get comparison error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id/candidates — side-by-side comparison payload
// Returns one row per completed candidate session with full metrics + the
// AI's per-row ranking (when available) and the recruiter's current pick.
router.get("/:id/candidates", verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid room id" });
    }
    const room = await JobInterviewRoom.findById(req.params.id).populate(
      "job",
      "title description skills languages",
    );
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const sessions = await CallRoom.find({
      jobInterviewRoom: room._id,
      status: "ended",
    })
      .populate("candidate", "email name firstName lastName profile.domain profile.skills")
      .lean();

    const payloads = await Promise.all(
      sessions.map((s) => buildCandidatePayload(s)),
    );

    const comparison = await ComparisonReport.findOne({
      jobInterviewRoom: room._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    const rankingBySession = new Map();
    (comparison?.rankings || []).forEach((r) => {
      if (r.session) rankingBySession.set(String(r.session), r);
    });

    const candidates = sessions.map((s, idx) => {
      const base = payloads[idx];
      const ai = rankingBySession.get(String(s._id)) || null;
      return {
        sessionId: String(s._id),
        roomId: s.roomId,
        candidateId: s.candidate?._id ? String(s.candidate._id) : null,
        candidate: {
          firstName: s.candidate?.firstName || "",
          lastName: s.candidate?.lastName || "",
          email: s.candidate?.email || "",
          domain: s.candidate?.profile?.domain || "",
          skills: s.candidate?.profile?.skills || [],
        },
        candidateName: base.candidateName,
        endedAt: s.recordingEndedAt || s.updatedAt,
        durationSeconds:
          s.recordingEndedAt && s.recordingStartedAt
            ? Math.max(
                0,
                Math.round(
                  (new Date(s.recordingEndedAt) -
                    new Date(s.recordingStartedAt)) /
                    1000,
                ),
              )
            : null,
        metrics: base.metrics,
        rhDecision: s.rhDecision || null,
        aiRank: ai
          ? {
              rank: ai.rank,
              suitabilityScore: ai.suitabilityScore,
              compositeScore: ai.compositeScore,
              compositeBreakdown: ai.compositeBreakdown || {},
              matchScore: ai.matchScore,
              strengths: ai.strengths || [],
              gaps: ai.gaps || [],
              strongestPoint: ai.strongestPoint,
              mainWeakness: ai.mainWeakness,
              hiringRecommendation: ai.hiringRecommendation,
              justification: ai.justification,
            }
          : null,
      };
    });

    return res.json({
      success: true,
      room: {
        _id: room._id,
        slug: room.slug,
        title: room.title,
        job: room.job,
        status: room.status,
        selectedCandidate: room.selectedCandidate || null,
      },
      comparison: comparison
        ? {
            _id: comparison._id,
            status: comparison.status,
            generatedAt: comparison.generatedAt,
            executiveSummary: comparison.executiveSummary,
            narrativeComparison: comparison.narrativeComparison,
            recommendedCandidateId: comparison.recommendedCandidateId,
            confidencePct: comparison.confidencePct,
            isClosingCall: comparison.isClosingCall,
            tiebreakerQuestion: comparison.tiebreakerQuestion,
            llmProvider: comparison.llmProvider,
          }
        : null,
      candidates,
    });
  } catch (error) {
    console.error("Get candidates payload error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// POST /api/job-rooms/:id/select-winner — recruiter picks a candidate
router.post("/:id/select-winner", verifyToken, async (req, res) => {
  try {
    const { sessionId, reason } = req.body || {};
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      return res.status(400).json({ message: "sessionId is required" });
    }
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const session = await CallRoom.findOne({
      _id: sessionId,
      jobInterviewRoom: room._id,
    });
    if (!session) {
      return res
        .status(404)
        .json({ message: "Session not found in this room" });
    }

    room.selectedCandidate = {
      candidate: session.candidate,
      session: session._id,
      selectedBy: req.user._id,
      selectedAt: new Date(),
      reason: String(reason || "").slice(0, 1000),
    };
    await room.save();

    return res.json({
      success: true,
      selectedCandidate: room.selectedCandidate,
    });
  } catch (error) {
    console.error("Select winner error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// DELETE /api/job-rooms/:id/select-winner — clear the recruiter pick
router.delete("/:id/select-winner", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    room.selectedCandidate = undefined;
    await room.save();
    return res.json({ success: true });
  } catch (error) {
    console.error("Clear winner error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// GET /api/job-rooms/:id/comparison/pdf — export latest ranking as PDF
router.get("/:id/comparison/pdf", verifyToken, async (req, res) => {
  try {
    const room = await JobInterviewRoom.findById(req.params.id).populate(
      "job",
      "title description skills languages",
    );
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (String(room.company) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const comparison = await ComparisonReport.findOne({
      jobInterviewRoom: room._id,
      status: "ready",
    }).sort({ createdAt: -1 });

    if (!comparison) {
      return res
        .status(404)
        .json({ message: "No ready comparison report to export" });
    }

    const { buildComparisonPdf } = require("../services/comparisonPdfService");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="comparison-${room.slug}.pdf"`,
    );
    buildComparisonPdf({ room, comparison }, res);
  } catch (error) {
    console.error("Comparison PDF error:", error);
    if (!res.headersSent) {
      return res.status(500).json({ message: error.message });
    }
    return null;
  }
});

module.exports = router;
