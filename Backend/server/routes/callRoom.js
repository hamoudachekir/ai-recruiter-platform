const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const CallRoom = require("../models/CallRoom");
const { verifyToken } = require("../middleware/auth");
const { UserModel, JobModel } = require("../models/user");
require("../models/department"); // register Department schema for populate
const interviewAgent = require("../services/interviewAgentService");
const {
  generateIntegrityReport,
} = require("../services/integrityReportService");
const {
  buildRecruiterReport,
  buildMockRecruiterReport,
  buildWeightedEvaluation,
} = require("../services/recruiterReportService");

const ANALYSIS_SERVICE_URL =
  process.env.ANALYSIS_SERVICE_URL || "http://localhost:8090";

function triggerBehavioralTimeline(interviewId) {
  // Fire-and-forget kick of the recruiter-only behavioral timeline /
  // emotion analysis pipeline. Independent of the main /analyze-video
  // graph — used so the candidate self-review and recruiter dashboard
  // both have emotion data ready by the time the report is opened.
  axios
    .post(
      `${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/behavioral-timeline/analyze`,
      {},
      { timeout: 5000 },
    )
    .then((resp) => {
      console.log(
        `[behavioral-timeline] queued for ${interviewId}: status=${resp.data?.status || "unknown"}`,
      );
    })
    .catch((err) => {
      const msg =
        err?.response?.data?.detail || err?.message || "unknown error";
      console.warn(
        `[behavioral-timeline] trigger failed for ${interviewId}: ${msg}`,
      );
    });
}

function triggerAnalysis(interviewId) {
  if (!interviewId) {
    console.error(
      "[analysis] triggerAnalysis called with empty interviewId — skipping",
    );
    return;
  }
  // Kick off the behavioral-timeline / emotion pipeline alongside the
  // main analyze-video graph so both finish around the same time.
  triggerBehavioralTimeline(interviewId);
  axios
    .post(
      `${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/analyze-video`,
      { force: false },
    )
    .then((resp) => {
      console.log(
        `[analysis] triggered for ${interviewId}: status=${resp.data?.status || "unknown"}`,
      );
    })
    .catch((err) => {
      const msg =
        err?.response?.data?.detail || err?.message || "unknown error";
      console.error(`[analysis] trigger failed for ${interviewId}: ${msg}`);
      // Persist the trigger error so the recruiter dashboard can surface it
      // instead of showing a perpetual spinner.
      CallRoom.findOneAndUpdate(
        { roomId: interviewId },
        {
          $set: {
            analysisTriggerError: msg,
            analysisTriggerFailedAt: new Date(),
          },
        },
      ).catch((dbErr) =>
        console.error(
          "[analysis] could not persist trigger error:",
          dbErr?.message,
        ),
      );
    });
}

// ── Multer storage for call recordings ────────────────
// Keep temporary uploads under Backend/server/uploads/tmp-recordings, then move
// them to Backend/uploads/interviews/<interviewId>/raw/recording.webm so the
// analysis_service graph can find them at a deterministic location.
const tempRecordingsDir = path.join(__dirname, "../uploads/tmp-recordings");
if (!fs.existsSync(tempRecordingsDir)) {
  fs.mkdirSync(tempRecordingsDir, { recursive: true });
}

const recordingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempRecordingsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `tmp-recording-${Date.now()}${ext}`);
  },
});

const uploadRecordingMiddleware = multer({
  storage: recordingStorage,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB max
});

const interviewsUploadsRoot = path.resolve(
  __dirname,
  "../../uploads/interviews",
);
const buildInterviewRecordingPaths = (interviewId) => {
  const rawDir = path.join(interviewsUploadsRoot, String(interviewId), "raw");
  const absolutePath = path.join(rawDir, "recording.webm");
  return {
    rawDir,
    absolutePath,
    // Served by the dedicated backend route below.
    publicUrl: `/api/call-rooms/${interviewId}/recording`,
  };
};

const VISION_EVENT_TYPES = new Set([
  "CAMERA_UNAVAILABLE",
  "NO_FACE_DETECTED",
  "MULTIPLE_FACES_DETECTED",
  "FACE_NOT_CENTERED",
  "BAD_FACE_DISTANCE",
  "POOR_LIGHTING",
  "LOOKING_AWAY_LONG",
  "CAMERA_BLOCKED",
  "TAB_SWITCH",
  "FULLSCREEN_EXIT",
  "COPY_PASTE",
  // YOLO vision events
  "MULTIPLE_PEOPLE",
  "NO_PERSON_VISIBLE",
  "PHONE_VISIBLE",
  "REFERENCE_MATERIAL_VISIBLE",
  "SCREEN_DEVICE_VISIBLE",
]);

const toDurationLabel = (durationMs) => {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const buildVisionReport = (room) => {
  const vision = room.visionMonitoring || {};
  const summary = vision.summary || {};
  const events = Array.isArray(vision.events) ? vision.events : [];
  const yoloSummary = vision.yoloSummary || {};

  // Also check integrityEvents for YOLO events
  const integrityEvents = Array.isArray(room.integrityEvents)
    ? room.integrityEvents
    : [];
  const allYoloEvents = integrityEvents.filter((e) => e.source === "yolov8");

  const faceVisibilityRateValue =
    summary.totalChecks > 0
      ? Math.round(
          (Number(summary.faceDetectedChecks || 0) /
            Number(summary.totalChecks || 1)) *
            100,
        )
      : 0;

  const absenceEvents = events.filter((e) => e.type === "NO_FACE_DETECTED");
  const lightingIssues = events.filter((e) => e.type === "POOR_LIGHTING");
  const positionIssues = events.filter(
    (e) => e.type === "FACE_NOT_CENTERED" || e.type === "BAD_FACE_DISTANCE",
  );
  const multipleFacesEvents = events.filter(
    (e) => e.type === "MULTIPLE_FACES_DETECTED",
  );
  const lookingAwayEvents = events.filter(
    (e) => e.type === "LOOKING_AWAY_LONG",
  );
  const cameraBlockedEvents = events.filter((e) => e.type === "CAMERA_BLOCKED");
  const tabSwitchEvents = events.filter((e) => e.type === "TAB_SWITCH");
  const fullscreenExitEvents = events.filter(
    (e) => e.type === "FULLSCREEN_EXIT",
  );

  // YOLO events from integrityEvents
  const phoneDetections = allYoloEvents.filter(
    (e) => e.type === "PHONE_VISIBLE",
  );
  const referenceMaterialDetections = allYoloEvents.filter(
    (e) => e.type === "REFERENCE_MATERIAL_VISIBLE",
  );
  const screenDetections = allYoloEvents.filter(
    (e) => e.type === "SCREEN_DEVICE_VISIBLE",
  );
  const multiplePeopleDetections = allYoloEvents.filter(
    (e) => e.type === "MULTIPLE_PEOPLE",
  );
  const noPersonDetections = allYoloEvents.filter(
    (e) => e.type === "NO_PERSON_VISIBLE",
  );

  let riskScore = 0;
  riskScore += absenceEvents.length * 15;
  riskScore += multipleFacesEvents.length * 25;
  riskScore += lookingAwayEvents.length * 10;
  riskScore += cameraBlockedEvents.length * 20;
  riskScore += tabSwitchEvents.length * 10;
  riskScore += fullscreenExitEvents.length * 10;
  riskScore += lightingIssues.length * 5;
  // YOLO event weights
  riskScore += phoneDetections.length * 15;
  riskScore += referenceMaterialDetections.length * 8;
  riskScore += screenDetections.length * 15;
  riskScore += multiplePeopleDetections.length * 25;
  riskScore += noPersonDetections.length * 12;
  riskScore = Math.min(100, riskScore);

  let riskLevel = "Low";
  if (riskScore >= 66) riskLevel = "High";
  else if (riskScore >= 31) riskLevel = "Medium";

  let explanationParts = [];
  if (absenceEvents.length > 0)
    explanationParts.push(`${absenceEvents.length} face absence events.`);
  if (multipleFacesEvents.length > 0)
    explanationParts.push(
      `${multipleFacesEvents.length} multiple-people events.`,
    );
  if (lookingAwayEvents.length > 0)
    explanationParts.push(`${lookingAwayEvents.length} looking-away events.`);
  if (cameraBlockedEvents.length > 0)
    explanationParts.push(
      `${cameraBlockedEvents.length} camera blocked events.`,
    );
  if (tabSwitchEvents.length > 0)
    explanationParts.push(
      `Browser lost focus ${tabSwitchEvents.length} times.`,
    );
  if (fullscreenExitEvents.length > 0)
    explanationParts.push(
      `Exited fullscreen ${fullscreenExitEvents.length} times.`,
    );
  // YOLO explanation parts
  if (phoneDetections.length > 0)
    explanationParts.push(`${phoneDetections.length} phone detection(s).`);
  if (referenceMaterialDetections.length > 0)
    explanationParts.push(
      `${referenceMaterialDetections.length} reference material detection(s).`,
    );
  if (screenDetections.length > 0)
    explanationParts.push(
      `${screenDetections.length} extra screen detection(s).`,
    );

  const riskExplanation =
    explanationParts.length > 0
      ? `Risk detected due to: ${explanationParts.join(" ")}`
      : "No significant integrity risks detected.";

  let cameraQuality = "Good";
  if (
    faceVisibilityRateValue < 70 ||
    multipleFacesEvents.length > 0 ||
    absenceEvents.length >= 4
  ) {
    cameraQuality = "Needs Review";
  } else if (
    faceVisibilityRateValue < 85 ||
    lightingIssues.length >= 3 ||
    positionIssues.length >= 5
  ) {
    cameraQuality = "Acceptable";
  }

  // YOLO object detection quality
  const yoloEnabled = yoloSummary.totalFramesProcessed > 0;
  const yoloStatus = yoloEnabled
    ? `YOLO analyzed ${yoloSummary.totalFramesProcessed} frame(s)`
    : "Object detection unavailable";

  return {
    generatedAt: new Date(),
    cameraQuality,
    faceVisibilityRate: `${faceVisibilityRateValue}%`,
    multipleFacesDetected:
      multipleFacesEvents.length > 0 || multiplePeopleDetections.length > 0,
    absenceEvents: absenceEvents.length + noPersonDetections.length,
    lightingIssues: lightingIssues.length,
    positionIssues: positionIssues.length,
    yoloEnabled,
    yoloStatus,
    yoloSummary,
    suspiciousEvents: events
      .filter((e) =>
        [
          "NO_FACE_DETECTED",
          "MULTIPLE_FACES_DETECTED",
          "LOOKING_AWAY_LONG",
          "TAB_SWITCH",
          "CAMERA_BLOCKED",
          "FULLSCREEN_EXIT",
        ].includes(e.type),
      )
      .slice(-10)
      .map((e) => ({
        type: e.type,
        duration: toDurationLabel(e.durationMs),
        questionId: e.questionId || "",
      })),
    recommendation:
      riskLevel === "High" || cameraQuality === "Needs Review"
        ? "Review flagged moments manually. Do not make automatic rejection decisions."
        : "Interview session appears normal. Standard review applies.",
    integrityRisk: {
      level: riskLevel,
      score: riskScore,
      explanation: riskExplanation,
    },
  };
};

const finalizeAgentSessionSnapshot = async (callRoomId) => {
  try {
    const interviewId = String(callRoomId || "");
    if (!interviewId) return;

    const snapshot = await interviewAgent.endSession({ interviewId });
    await CallRoom.findByIdAndUpdate(interviewId, {
      $set: { agentSnapshot: snapshot },
    });
  } catch (error) {
    // Ending the room must not fail just because the Python agent service is
    // unavailable. The socket path may also finalize the session; this is a
    // server-side safety net for candidate leave/end-call navigation.
    console.warn("Agent session finalize skipped:", error?.message || error);
  }
};

// Create a new call room (RH initiates)
router.post("/create", verifyToken, async (req, res) => {
  try {
    const { jobId } = req.body;

    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || (role !== "rh" && role !== "enterprise")) {
      return res
        .status(403)
        .json({ message: "Only RH/Enterprise users can create rooms" });
    }

    // Generate unique room ID
    const roomId = `room-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const callRoom = new CallRoom({
      roomId,
      initiator: req.user._id,
      initiatorRole: role,
      job: jobId || undefined,
      status: "waiting_confirmation",
    });

    await callRoom.save();
    await callRoom.populate("initiator", "email firstName lastName");
    if (callRoom.job) {
      await callRoom.populate({
        path: "job",
        select: "title company location status seniorityLevel departmentId",
        populate: { path: "departmentId", select: "name" },
      });
    }

    res.status(201).json({
      success: true,
      message: "Call room created successfully",
      room: callRoom,
    });
  } catch (error) {
    console.error("Create call room error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get available rooms for candidates to join
router.get("/available", verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || role !== "candidate") {
      return res
        .status(403)
        .json({ message: "Only candidates can view available rooms" });
    }

    // Return rooms still open to join (no candidate yet) PLUS any room this
    // candidate has already requested but isn't confirmed/rejected on. Without
    // the second clause, a candidate who clicked "Request to Join" loses sight
    // of the room on page reload (its candidate field is no longer null), even
    // though they're the one waiting for the recruiter to confirm.
    const waitingRooms = await CallRoom.find({
      status: "waiting_confirmation",
      $or: [{ candidate: { $eq: null } }, { candidate: req.user._id }],
    })
      .populate("initiator", "email firstName lastName")
      .populate("job", "title company")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      rooms: waitingRooms,
    });
  } catch (error) {
    console.error("Get available rooms error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get room details by public roomId slug (e.g. room-1775729693597-6hp5799xp)
router.get("/by-room/:publicRoomId", verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findOne({ roomId: req.params.publicRoomId })
      .populate(
        "initiator",
        "email name firstName lastName role domain enterprise profile",
      )
      .populate(
        "candidate",
        "email firstName lastName faceProfile.enrolled faceProfile.model faceProfile.status faceProfile.reason faceProfile.photoUrl faceProfile.sourcePhotoUrl faceProfile.quality faceProfile.updatedAt",
      )
      .populate("job", "title description skills languages location");

    if (!callRoom) {
      return res.status(404).json({ message: "Room not found" });
    }

    const isInitiator = callRoom.initiator._id.equals(req.user._id);
    const isCandidate =
      callRoom.candidate && callRoom.candidate._id.equals(req.user._id);

    if (!isInitiator && !isCandidate) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this room" });
    }

    res.json({
      success: true,
      room: callRoom,
    });
  } catch (error) {
    console.error("Get room by public id error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Candidate requests to join a room
router.post(
  "/:roomId([0-9a-fA-F]{24})/request-join",
  verifyToken,
  async (req, res) => {
    try {
      const user = await UserModel.findById(req.user._id);
      const role = user?.role?.toLowerCase();
      if (!user || role !== "candidate") {
        return res
          .status(403)
          .json({ message: "Only candidates can request to join" });
      }

      const callRoom = await CallRoom.findById(req.params.roomId);
      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      if (callRoom.status !== "waiting_confirmation") {
        return res
          .status(400)
          .json({ message: "Room is not available for joining" });
      }

      if (callRoom.candidate) {
        return res
          .status(400)
          .json({ message: "Someone already requested to join this room" });
      }

      callRoom.candidate = req.user._id;
      callRoom.candidateJoinRequestedAt = new Date();
      await callRoom.save();
      await callRoom.populate("candidate", "email firstName lastName");

      res.json({
        success: true,
        message: "Join request sent",
        room: callRoom,
      });
    } catch (error) {
      console.error("Request join error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// RH confirms candidate join
router.post(
  "/:roomId([0-9a-fA-F]{24})/confirm-join",
  verifyToken,
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId);
      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      if (!callRoom.initiator.equals(req.user._id)) {
        return res
          .status(403)
          .json({ message: "Only room initiator can confirm" });
      }

      if (!callRoom.candidate) {
        return res
          .status(400)
          .json({ message: "No candidate has requested to join" });
      }

      callRoom.status = "active";
      callRoom.candidateJoinConfirmedAt = new Date();
      callRoom.recordingStartedAt = new Date();
      await callRoom.save();
      await callRoom.populate("candidate", "email firstName lastName");

      res.json({
        success: true,
        message: "Candidate confirmed, recording started",
        room: callRoom,
      });
    } catch (error) {
      console.error("Confirm join error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// RH rejects candidate join
router.post(
  "/:roomId([0-9a-fA-F]{24})/reject-join",
  verifyToken,
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId);
      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      if (!callRoom.initiator.equals(req.user._id)) {
        return res
          .status(403)
          .json({ message: "Only room initiator can reject" });
      }

      callRoom.candidate = null;
      callRoom.candidateJoinRequestedAt = null;
      callRoom.status = "waiting_confirmation";
      await callRoom.save();

      res.json({
        success: true,
        message: "Candidate rejected",
        room: callRoom,
      });
    } catch (error) {
      console.error("Reject join error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Get room details (both RH and candidate)
router.get("/rh/my-rooms", verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || (role !== "rh" && role !== "enterprise")) {
      return res
        .status(403)
        .json({ message: "Only RH/Enterprise users can access this" });
    }

    const myRooms = await CallRoom.find({
      initiator: req.user._id,
    })
      .populate("candidate", "email firstName lastName")
      .populate({
        path: "job",
        select: "title company location status seniorityLevel departmentId",
        populate: { path: "departmentId", select: "name" },
      })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      rooms: myRooms,
    });
  } catch (error) {
    console.error("Get RH rooms error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Jobs the recruiter can link a room to (for the "Related Job" picker).
// Returns the authenticated recruiter's own jobs with the fields the dropdown
// needs: title, location, department name, and status.
router.get("/selectable-jobs", verifyToken, async (req, res) => {
  try {
    const jobs = await JobModel.find({ entrepriseId: req.user._id })
      .select("title location status seniorityLevel companyName departmentId")
      .populate("departmentId", "name")
      .sort({ createdAt: -1 })
      .lean();

    const items = jobs.map((j) => ({
      id: String(j._id),
      title: j.title || "Untitled job",
      location: j.location || "",
      department: j.departmentId?.name || "",
      seniority: j.seniorityLevel || "",
      status: j.status || "",
    }));

    res.json({ success: true, jobs: items });
  } catch (error) {
    console.error("Get selectable jobs error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Change (or clear) the job a room is linked to.
// Body: { jobId: "<id>" | null }
router.patch("/:roomId([0-9a-fA-F]{24})/job", verifyToken, async (req, res) => {
  try {
    const { jobId } = req.body || {};
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) return res.status(404).json({ message: "Room not found" });
    if (!callRoom.initiator.equals(req.user._id)) {
      return res
        .status(403)
        .json({ message: "Only the room initiator can change its job link" });
    }

    if (jobId) {
      const job = await JobModel.findOne({ _id: jobId, entrepriseId: req.user._id }).select("_id");
      if (!job) {
        return res.status(400).json({ message: "Job not found or not owned by this recruiter" });
      }
      callRoom.job = jobId;
    } else {
      callRoom.job = undefined;
    }
    await callRoom.save();
    await callRoom.populate({
      path: "job",
      select: "title company location status seniorityLevel departmentId",
      populate: { path: "departmentId", select: "name" },
    });

    res.json({ success: true, room: callRoom });
  } catch (error) {
    console.error("Update room job error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Delete room from RH dashboard
router.delete("/:roomId([0-9a-fA-F]{24})", verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: "Room not found" });
    }

    if (!callRoom.initiator.equals(req.user._id)) {
      return res
        .status(403)
        .json({ message: "Only room initiator can delete this room" });
    }

    const deletedRoom = {
      _id: callRoom._id,
      roomId: callRoom.roomId,
      status: callRoom.status,
    };

    await callRoom.deleteOne();

    res.json({
      success: true,
      message: "Room deleted successfully",
      room: deletedRoom,
    });
  } catch (error) {
    console.error("Delete room error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Get room details (both RH and candidate)
router.get("/:roomId([0-9a-fA-F]{24})", verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId)
      .populate("initiator", "email firstName lastName")
      .populate("candidate", "email firstName lastName")
      .populate("job", "title company");

    if (!callRoom) {
      return res.status(404).json({ message: "Room not found" });
    }

    // Check authorization
    const isInitiator = callRoom.initiator._id.equals(req.user._id);
    const isCandidate =
      callRoom.candidate && callRoom.candidate._id.equals(req.user._id);

    if (!isInitiator && !isCandidate) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this room" });
    }

    res.json({
      success: true,
      room: callRoom,
    });
  } catch (error) {
    console.error("Get room error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Update room with transcription data
router.post(
  "/:roomId([0-9a-fA-F]{24})/update-transcription",
  verifyToken,
  async (req, res) => {
    try {
      const { text, segments, overallSentiment, segment, sentiment } = req.body;
      const callRoom = await CallRoom.findById(req.params.roomId);

      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      const isInitiator = callRoom.initiator.equals(req.user._id);
      const isCandidate =
        callRoom.candidate && callRoom.candidate.equals(req.user._id);
      if (!isInitiator && !isCandidate) {
        return res
          .status(403)
          .json({ message: "Only room participants can update transcription" });
      }

      if (text) callRoom.transcription.text = text;
      if (segments) callRoom.transcription.segments = segments;
      if (overallSentiment)
        callRoom.transcription.overallSentiment = overallSentiment;

      if (segment?.text) {
        const normalizedSegment = {
          text: segment.text,
          timestamp: segment.timestamp
            ? new Date(segment.timestamp)
            : new Date(),
          sentiment: sentiment ||
            segment.sentiment || { label: "NEUTRAL", score: 0 },
        };
        callRoom.transcription.segments.push(normalizedSegment);
        callRoom.transcription.text =
          `${callRoom.transcription.text || ""} ${segment.text}`.trim();
        if (sentiment) {
          callRoom.transcription.overallSentiment = sentiment;
        }
      }

      await callRoom.save();

      res.json({
        success: true,
        message: "Transcription updated",
        room: callRoom,
      });
    } catch (error) {
      console.error("Update transcription error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Save candidate webcam quality/integrity metadata - supports both roomId string and ObjectId
router.post("/:roomId/vision-monitoring", verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    // Try to find room by roomId string first, then by _id (ObjectId)
    let callRoom = await CallRoom.findOne({ roomId });
    if (!callRoom && roomId.match(/^[0-9a-fA-F]{24}$/)) {
      callRoom = await CallRoom.findById(roomId);
    }
    if (!callRoom) {
      return res.status(404).json({ message: "Room not found" });
    }

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate =
      callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res
        .status(403)
        .json({
          message: "Only room participants can update vision monitoring",
        });
    }

    const { precheck, event, summaryDelta, currentQuestionId } = req.body || {};

    if (!callRoom.visionMonitoring) {
      callRoom.visionMonitoring = {};
    }
    if (!callRoom.visionMonitoring.summary) {
      callRoom.visionMonitoring.summary = {};
    }
    if (!Array.isArray(callRoom.visionMonitoring.events)) {
      callRoom.visionMonitoring.events = [];
    }

    if (precheck) {
      callRoom.visionMonitoring.precheck = {
        cameraAvailable:
          precheck.cameraAvailable ??
          callRoom.visionMonitoring.precheck?.cameraAvailable ??
          null,
        faceDetected:
          precheck.faceDetected ??
          callRoom.visionMonitoring.precheck?.faceDetected ??
          null,
        faceCentered:
          precheck.faceCentered ??
          callRoom.visionMonitoring.precheck?.faceCentered ??
          null,
        lightingOk:
          precheck.lightingOk ??
          callRoom.visionMonitoring.precheck?.lightingOk ??
          null,
        multipleFacesDetected:
          precheck.multipleFacesDetected ??
          callRoom.visionMonitoring.precheck?.multipleFacesDetected ??
          false,
        checkedAt: new Date(),
      };
    }

    if (summaryDelta) {
      const summary = callRoom.visionMonitoring.summary;
      summary.totalChecks =
        Number(summary.totalChecks || 0) +
        Number(summaryDelta.totalChecks || 0);
      summary.faceDetectedChecks =
        Number(summary.faceDetectedChecks || 0) +
        Number(summaryDelta.faceDetectedChecks || 0);
      summary.noFaceChecks =
        Number(summary.noFaceChecks || 0) +
        Number(summaryDelta.noFaceChecks || 0);
      summary.multipleFacesChecks =
        Number(summary.multipleFacesChecks || 0) +
        Number(summaryDelta.multipleFacesChecks || 0);
      summary.lightingIssueChecks =
        Number(summary.lightingIssueChecks || 0) +
        Number(summaryDelta.lightingIssueChecks || 0);
      summary.positionIssueChecks =
        Number(summary.positionIssueChecks || 0) +
        Number(summaryDelta.positionIssueChecks || 0);
      summary.distanceIssueChecks =
        Number(summary.distanceIssueChecks || 0) +
        Number(summaryDelta.distanceIssueChecks || 0);
      summary.lastUpdatedAt = new Date();
    }

    if (event) {
      if (!VISION_EVENT_TYPES.has(event.type)) {
        return res
          .status(400)
          .json({ message: `Unsupported vision event type: ${event.type}` });
      }
      callRoom.visionMonitoring.events.push({
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        type: event.type,
        severity: event.severity || "info",
        message: event.message || "",
        questionId: event.questionId || currentQuestionId || "",
        durationMs: Number(event.durationMs || 0),
        meta: {
          brightness:
            Number(event.meta?.brightness ?? event.brightness ?? 0) ||
            undefined,
          faceCount:
            Number(event.meta?.faceCount ?? event.faceCount ?? 0) || undefined,
          faceRatio:
            Number(event.meta?.faceRatio ?? event.faceRatio ?? 0) || undefined,
          centerOffsetX: Number(event.meta?.centerOffsetX ?? 0) || undefined,
          centerOffsetY: Number(event.meta?.centerOffsetY ?? 0) || undefined,
        },
      });
    }

    await callRoom.save();

    res.json({
      success: true,
      message: "Vision monitoring updated",
      visionMonitoring: callRoom.visionMonitoring,
    });
  } catch (error) {
    console.error("Vision monitoring update error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post(
  "/:roomId/vision-report/finalize",
  verifyToken,
  async (req, res) => {
    try {
      const { roomId } = req.params;
      // Try to find room by roomId string first, then by _id (ObjectId)
      let callRoom = await CallRoom.findOne({ roomId });
      if (!callRoom && roomId.match(/^[0-9a-fA-F]{24}$/)) {
        callRoom = await CallRoom.findById(roomId);
      }
      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      const isInitiator = callRoom.initiator.equals(req.user._id);
      const isCandidate =
        callRoom.candidate && callRoom.candidate.equals(req.user._id);
      if (!isInitiator && !isCandidate) {
        return res
          .status(403)
          .json({
            message: "Only room participants can finalize the vision report",
          });
      }

      callRoom.visionMonitoring = callRoom.visionMonitoring || {};
      callRoom.visionMonitoring.report = buildVisionReport(callRoom);
      callRoom.integrityReport = await generateIntegrityReport({
        room: callRoom,
        events: callRoom.integrityEvents || [],
      });
      await callRoom.save();
      void finalizeAgentSessionSnapshot(callRoom._id);

      res.json({
        success: true,
        report: callRoom.visionMonitoring.report,
        integrityReport: callRoom.integrityReport,
      });
    } catch (error) {
      console.error("Finalize vision report error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// End call
router.post(
  "/:roomId([0-9a-fA-F]{24})/end-call",
  verifyToken,
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId);
      if (!callRoom) {
        return res.status(404).json({ message: "Room not found" });
      }

      const isInitiator = callRoom.initiator.equals(req.user._id);
      const isCandidate =
        callRoom.candidate && callRoom.candidate.equals(req.user._id);
      if (!isInitiator && !isCandidate) {
        return res
          .status(403)
          .json({ message: "Only room participants can end call" });
      }

      callRoom.status = "ended";
      callRoom.recordingEndedAt = new Date();
      callRoom.visionMonitoring = callRoom.visionMonitoring || {};
      callRoom.visionMonitoring.report = buildVisionReport(callRoom);
      callRoom.integrityReport = await generateIntegrityReport({
        room: callRoom,
        events: callRoom.integrityEvents || [],
      });
      await callRoom.save();

      res.json({
        success: true,
        message: "Call ended",
        room: callRoom,
      });
    } catch (error) {
      console.error("End call error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Upload audio recording for a call room
router.post(
  "/:roomId([0-9a-fA-F]{24})/upload-audio",
  verifyToken,
  uploadRecordingMiddleware.single("audio"),
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId);
      if (!callRoom) return res.status(404).json({ message: "Room not found" });

      const isInitiator = callRoom.initiator.equals(req.user._id);
      const isCandidate =
        callRoom.candidate && callRoom.candidate.equals(req.user._id);
      if (!isInitiator && !isCandidate) {
        return res
          .status(403)
          .json({ message: "Not authorized to upload audio for this room" });
      }

      if (!req.file)
        return res.status(400).json({ message: "No audio file provided" });

      const interviewId = callRoom.roomId;
      if (!interviewId) {
        console.error(
          `[upload-audio] callRoom ${callRoom._id} has no roomId. ` +
            "Cannot determine recording path for analysis service. Aborting trigger.",
        );
        return res.status(500).json({
          success: false,
          message:
            "Interview room ID is missing — cannot trigger analysis. Please contact support.",
        });
      }
      const target = buildInterviewRecordingPaths(interviewId);
      fs.mkdirSync(target.rawDir, { recursive: true });

      // Move the temporary upload into the deterministic LangGraph path.
      try {
        fs.renameSync(req.file.path, target.absolutePath);
      } catch (moveError) {
        // Cross-device rename fallback.
        fs.copyFileSync(req.file.path, target.absolutePath);
        fs.unlinkSync(req.file.path);
      }

      // Store a backend-accessible URL (never a browser blob URL).
      callRoom.recordingUrl = target.publicUrl;
      await callRoom.save();

      res.json({
        success: true,
        recordingUrl: callRoom.recordingUrl,
        storedPath: target.absolutePath,
      });

      // Fire-and-forget: kick off post-interview analysis pipeline.
      triggerAnalysis(interviewId);
    } catch (error) {
      console.error("Upload audio error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Serve the saved interview recording from Backend/uploads/interviews/<id>/raw.
router.get("/:interviewId/recording", async (req, res) => {
  try {
    const interviewId = String(req.params.interviewId || "").trim();
    if (!interviewId) {
      return res.status(400).json({ message: "Invalid interviewId" });
    }

    const callRoom = await CallRoom.findOne({ roomId: interviewId });
    if (!callRoom) {
      return res.status(404).json({ message: "Room not found" });
    }

    const target = buildInterviewRecordingPaths(interviewId);
    if (!fs.existsSync(target.absolutePath)) {
      return res.status(404).json({ message: "Recording not found" });
    }

    res.type("audio/webm");
    return res.sendFile(target.absolutePath);
  } catch (error) {
    console.error("Get recording error:", error);
    return res.status(500).json({ message: error.message });
  }
});

// ── Recruiter Report ──────────────────────────────────────────────────────────

/**
 * GET /api/call-rooms/:roomId/report
 * Returns the stored recruiterReport (or a mock if not yet generated).
 * Only the room initiator (RH) can access this.
 */
// ── Transcript sanitization ────────────────────────────────────────────────
// Whisper STT hallucinates Arabic / Chinese / Russian fragments during
// silence or noisy audio, which leaks into the "Transcript Preview" the
// recruiter sees. We strip standalone runs of non-Latin script when the
// interview is being conducted in English/French. The check is conservative:
// individual non-ASCII characters mixed inside Latin words (accents, é, ï)
// are preserved.
const FOREIGN_SCRIPT_RUN = /[؀-ۿݐ-ݿࢠ-ࣿऀ-ॿ一-鿿぀-ヿ㐀-䶿Ѐ-ӿ]+(?:[\s\p{P}]+[؀-ۿݐ-ݿࢠ-ࣿऀ-ॿ一-鿿぀-ヿ㐀-䶿Ѐ-ӿ]+)*/gu;

function sanitizeTranscriptText(text) {
  if (!text) return "";
  // Strip standalone non-Latin script runs (Arabic, CJK, Cyrillic, Devanagari).
  let out = String(text).replace(FOREIGN_SCRIPT_RUN, " ");
  // Collapse the gap left behind to a single space.
  out = out.replace(/[ \t]{2,}/g, " ");
  // Drop empty lines and leading whitespace.
  out = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return out.trim();
}

// Skill lexicon for transcript-based detection. Mirrors the one in
// recruiterReportService.js — kept here for the analysis_pipeline adapter
// path so reports built via the Python pipeline still surface skills.
const _SKILL_LEXICON = [
  ['react', /\breact(?:\.?js)?\b/i],
  ['vue', /\bvue(?:\.?js)?\b/i],
  ['angular', /\bangular(?:\.?js)?\b/i],
  ['next.js', /\bnext\.?js\b/i],
  ['node.js', /\bnode(?:\.?js)?\b/i],
  ['express', /\bexpress(?:\.?js)?\b/i],
  ['nestjs', /\bnest(?:\.?js)?\b/i],
  ['javascript', /\bjavascript\b|\bjs\b/i],
  ['typescript', /\btypescript\b|\bts\b/i],
  ['python', /\bpython\b/i],
  ['java', /\bjava\b(?!script)/i],
  ['c#', /\bc#|c sharp\b/i],
  ['c++', /\bc\+\+|cpp\b/i],
  ['go', /\bgolang\b/i],
  ['rust', /\brust\b/i],
  ['php', /\bphp\b/i],
  ['mongodb', /\bmongo\s?db\b|\bmongo\b/i],
  ['postgresql', /\bpostgres(?:ql)?\b/i],
  ['mysql', /\bmysql\b/i],
  ['redis', /\bredis\b/i],
  ['sql', /\bsql\b/i],
  ['aws', /\baws\b/i],
  ['azure', /\bazure\b/i],
  ['gcp', /\bgcp\b/i],
  ['docker', /\bdocker\b/i],
  ['kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['git', /\bgit(?:hub)?\b/i],
  ['rest', /\brest(?:ful)?\b/i],
  ['graphql', /\bgraphql\b/i],
  ['microservices', /\bmicro\s?services?\b/i],
  ['agile', /\bagile\b/i],
  ['scrum', /\bscrum\b/i],
  ['machine learning', /\bmachine learning\b|\bml\b/i],
  ['django', /\bdjango\b/i],
  ['flask', /\bflask\b/i],
  ['fastapi', /\bfastapi\b/i],
  ['tailwind', /\btailwind\b/i],
  ['html', /\bhtml5?\b/i],
  ['css', /\bcss3?\b|\bsass\b|\bscss\b/i],
];

function _extractSkillsFromText(text) {
  const t = String(text || '');
  if (!t) return [];
  const found = new Set();
  for (const [name, rx] of _SKILL_LEXICON) {
    if (rx.test(t)) found.add(name);
  }
  return [...found];
}

// Pull a Q/A pair list from whichever transcript source is populated.
function _resolveTurnsFromRoom(callRoom) {
  if (!callRoom) return [];
  const live = Array.isArray(callRoom.messages) ? callRoom.messages : [];
  if (live.length > 0) return live;

  const snap = callRoom.agentSnapshot && typeof callRoom.agentSnapshot === 'object'
    ? callRoom.agentSnapshot
    : null;
  const transcript = Array.isArray(snap?.transcript) ? snap.transcript : [];
  if (transcript.length > 0) {
    return transcript.map((t) => ({ role: t.role, text: t.text }));
  }
  const evals = Array.isArray(snap?.evaluations) ? snap.evaluations : [];
  if (evals.length > 0) {
    const out = [];
    for (const e of evals) {
      const q = String(e.question || e.prompt || '').trim();
      const a = String(e.candidate_answer || e.answer || e.response || '').trim();
      if (q) out.push({ role: 'agent', text: q });
      if (a) out.push({ role: 'candidate', text: a });
    }
    return out;
  }
  return [];
}

function _buildQuestionEvaluationsFromRoom(callRoom) {
  const snap = callRoom?.agentSnapshot || {};
  const agentEvals = Array.isArray(snap.evaluations) ? snap.evaluations : [];

  if (agentEvals.length > 0) {
    return agentEvals.map((e, idx) => {
      const questionText = String(e.question || e.prompt || '').trim();
      const answerText = String(
        e.candidate_answer || e.answer || e.response || '',
      ).trim();
      const wordCount = answerText.split(/\s+/).filter(Boolean).length;
      const rawScore = Number(e.score);
      const score10 = Number.isFinite(rawScore)
        ? Math.max(1, Math.min(10, Math.round(rawScore <= 1 ? rawScore * 10 : rawScore)))
        : Math.max(1, Math.min(10, Math.round(2 + wordCount / 25)));
      return {
        questionId: `Q${idx + 1}`,
        question: questionText,
        answer: answerText,
        category: String(e.category || e.skill_focus || 'General'),
        score: score10,
        feedback: String(e.feedback || e.reasoning || ''),
        detectedSkills: Array.isArray(e.detected_skills)
          ? e.detected_skills.map(String)
          : _extractSkillsFromText(answerText),
        answerQuality:
          score10 >= 8 ? 'good' : score10 >= 5 ? 'average' : 'weak',
      };
    });
  }

  // Pair up agent → candidate messages from whichever source is available.
  const turns = _resolveTurnsFromRoom(callRoom);
  if (turns.length === 0) return [];

  const pairs = [];
  let lastAgent = null;
  let idx = 0;
  for (const m of turns) {
    if (m.role === 'agent') {
      lastAgent = m;
    } else if (m.role === 'candidate' && lastAgent) {
      idx += 1;
      const q = String(lastAgent.text || '').trim();
      const a = String(m.text || '').trim();
      const wordCount = a.split(/\s+/).filter(Boolean).length;
      const score = Math.max(1, Math.min(10, Math.round(2 + wordCount / 25)));
      pairs.push({
        questionId: `Q${idx}`,
        question: q,
        answer: a,
        category: 'General',
        score,
        feedback: '',
        detectedSkills: _extractSkillsFromText(a),
        answerQuality: score >= 8 ? 'good' : score >= 5 ? 'average' : 'weak',
      });
      lastAgent = null;
    }
  }
  return pairs;
}

function _adaptAnalysisReport(ar, callRoom) {
  const tech = ar.technicalEvaluation || {};
  const hr = ar.hrEvaluation || {};
  const vision = ar.visionMonitoring || {};
  const audio = ar.audioAnalysis || {};
  const recDecision = callRoom?.recruiterDecision || null;
  const reportQuality = ar.reportQuality || {};
  const recruiterDecisionSummary = ar.recruiterDecisionSummary || null;

  // ── Build derived data from the raw room ────────────────────────────────
  const questionEvaluations = _buildQuestionEvaluationsFromRoom(callRoom);

  // Combine all candidate-side text for skill scanning.
  const turns = _resolveTurnsFromRoom(callRoom);
  const candidateText = turns
    .filter((t) => t.role === 'candidate')
    .map((t) => String(t.text || ''))
    .concat(questionEvaluations.map((q) => String(q.answer || '')))
    .join(' \n ');

  const jobSkills = Array.isArray(callRoom?.job?.skills)
    ? callRoom.job.skills.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  const detectedSkills = [
    ...new Set(
      [
        ...questionEvaluations.flatMap((q) => q.detectedSkills || []),
        ..._extractSkillsFromText(candidateText),
      ]
        .map((s) => String(s).toLowerCase().trim())
        .filter(Boolean),
    ),
  ];
  const matchedSkills = detectedSkills.filter((s) => jobSkills.includes(s));
  const missingSkills = jobSkills.filter(
    (s) => !detectedSkills.some((d) => d.includes(s) || s.includes(d)),
  );
  const strongSkills = questionEvaluations
    .filter((q) => q.answerQuality === 'good' && q.detectedSkills?.length > 0)
    .flatMap((q) => q.detectedSkills);
  const weakSkills = questionEvaluations
    .filter((q) => q.answerQuality === 'weak' && q.detectedSkills?.length > 0)
    .flatMap((q) => q.detectedSkills);

  // ── Communication sub-metrics (clarity, relevance, …) ───────────────────
  const candidateMsgs = turns.filter((t) => t.role === 'candidate');
  const totalWords = candidateMsgs.reduce(
    (sum, m) => sum + String(m.text || '').split(/\s+/).filter(Boolean).length,
    0,
  );
  const avgWords = candidateMsgs.length > 0
    ? Math.round(totalWords / candidateMsgs.length)
    : 0;
  const goodAnswers = questionEvaluations.filter((q) => q.answerQuality === 'good').length;
  const totalAnswers = questionEvaluations.length || 1;
  const goodRatio = goodAnswers / totalAnswers;

  const clarityLabel =
    avgWords >= 40 && goodRatio >= 0.5 ? 'Clear and articulate' :
    avgWords >= 20 ? 'Generally clear' :
    avgWords > 0 ? 'Clarity needs improvement' : 'Insufficient transcript';
  const relevanceLabel =
    goodRatio >= 0.7 ? 'Highly relevant answers' :
    goodRatio >= 0.4 ? 'Mostly relevant' :
    candidateMsgs.length > 0 ? 'Some answers need more focus' : 'Insufficient transcript';
  const structureLabel =
    goodRatio >= 0.7 ? 'Well-structured responses' :
    candidateMsgs.length > 0 ? 'Responses could benefit from better structure' : 'Insufficient transcript';
  const completenessLabel =
    avgWords >= 60 ? 'Comprehensive answers provided' :
    avgWords >= 30 ? 'Adequate detail in most answers' :
    avgWords > 0 ? 'Answers were brief' : 'Insufficient transcript';
  const examplesLabel =
    goodAnswers >= 2 ? 'Supported answers with relevant examples' :
    candidateMsgs.length > 0 ? 'Limited use of concrete examples' : 'Insufficient transcript';

  // ── Aggregate YOLO + integrity event counts from the raw events ─────────
  const integrityEvents = Array.isArray(callRoom?.integrityEvents)
    ? callRoom.integrityEvents
    : [];
  const yoloSum = callRoom?.visionMonitoring?.yoloSummary || {};
  const countEvents = (type) => integrityEvents.filter((e) => e.type === type).length;
  const phoneCount = yoloSum.phoneDetections || countEvents('PHONE_VISIBLE');
  const referenceCount = yoloSum.bookDetections || countEvents('REFERENCE_MATERIAL_VISIBLE');
  const screenCount = yoloSum.screenDetections || countEvents('SCREEN_DEVICE_VISIBLE');
  const multiplePeopleCount =
    yoloSum.personCountIssues || countEvents('MULTIPLE_PEOPLE');

  const finalRec =
    typeof ar.finalRecommendation === "object" && ar.finalRecommendation
      ? ar.finalRecommendation
      : {
          status: ar.humanReviewRequired ? "manual_review" : "proceed",
          summary:
            typeof ar.finalRecommendation === "string"
              ? ar.finalRecommendation
              : "Report requires recruiter review.",
          nextStep:
            "Review deterministic metrics and transcript evidence before deciding.",
        };

  // Parse "22.4%" → 22.4
  const facePresencePct =
    parseFloat(String(vision.faceVisibilityRate || "0")) || 0;
  const absenceCount = vision.absenceEvents || 0;
  const hasMultipleFaces = vision.multipleFacesDetected || false;
  const cameraQualityStr = (vision.cameraQuality || "").toLowerCase();

  // Derive riskLevel from vision signals
  let riskLevel = "low";
  if (
    hasMultipleFaces ||
    absenceCount >= 5 ||
    cameraQualityStr.includes("high")
  ) {
    riskLevel = "high";
  } else if (
    absenceCount >= 1 ||
    cameraQualityStr.includes("review") ||
    cameraQualityStr.includes("needs")
  ) {
    riskLevel = "medium";
  }

  // Map integrityAlerts → flaggedMoments shape for EventTimeline / VisionIntegritySummary
  const flaggedMoments = (ar.integrityAlerts || []).map((alert) => ({
    timestamp: alert.timestamp || null,
    type: alert.type || "UNKNOWN",
    severity: alert.severity || "low",
    durationSeconds: alert.duration ? parseFloat(alert.duration) || 0 : 0,
    questionId: alert.questionId || "",
  }));

  return {
    weightedEvaluation: buildWeightedEvaluation(callRoom),
    candidateInfo: {
      candidateName: ar.candidateName || "Unknown Candidate",
      jobTitle:
        !ar.jobTitle || String(ar.jobTitle).toLowerCase() === "role"
          ? "Job not linked"
          : ar.jobTitle,
      interviewDate: ar.generatedAt || null,
      duration: ar.duration || null,
      interviewStatus: "ended",
    },
    finalRecommendation: {
      status: finalRec.status === "proceed" ? "recommended" : "needs_review",
      overallScore: finalRec.overallScore ?? ar.overallScore ?? null,
      summary:
        finalRec.summary ||
        ar.recommendationText ||
        "Report requires recruiter review.",
      nextStep: finalRec.nextStep,
      recruiterNotes: finalRec.recruiterNotes,
    },
    recruiterDecisionSummary,
    reportQuality,
    scoreBreakdown: ar.scoreBreakdown || {
      totalScore: ar.overallScore ?? null,
      technicalScore: tech.score ?? null,
      hrScore: hr.score ?? null,
      integrityScore: ar.integrityScore ?? null,
    },
    questionEvaluations,
    technicalAnalysis: {
      score: tech.score ?? null,
      source: tech.source || "unavailable",
      confidence: tech.confidence || "low",
      summary: tech.summary || "",
      explanation: tech.explanation || "",
      detectedSkills,
      matchedSkills,
      missingSkills,
      strengths:
        strongSkills.length > 0
          ? [...new Set(strongSkills)]
          : (tech.strengths && tech.strengths.length > 0
              ? tech.strengths
              : detectedSkills.slice(0, 5)),
      weaknesses:
        weakSkills.length > 0
          ? [...new Set(weakSkills)]
          : tech.weaknesses || [],
    },
    communicationAnalysis: {
      transcriptionAvailable: audio.transcriptionAvailable || false,
      longSilenceEvents: audio.longSilenceEvents || 0,
      summary: sanitizeTranscriptText(ar.transcriptSummary || ""),
      transcriptPreview: ar.transcript?.fullText
        ? sanitizeTranscriptText(String(ar.transcript.fullText)).slice(0, 700)
        : "",
      score: hr.score ?? null,
      source: hr.source || "unavailable",
      confidence: hr.confidence || "low",
      clarity: clarityLabel,
      relevance: relevanceLabel,
      structure: structureLabel,
      completeness: completenessLabel,
      examplesQuality: examplesLabel,
    },
    // Field names match what VisionIntegritySummary.jsx destructures
    visionIntegrityReport: {
      riskLevel,
      facePresencePercentage: Math.round(facePresencePct * 10) / 10,
      lookingAwayTotalSeconds: 0,
      multiplePeopleEvents:
        multiplePeopleCount || (hasMultipleFaces ? 1 : 0),
      phoneDetections: phoneCount,
      referenceMaterialDetections: referenceCount,
      additionalScreenDetections: screenCount,
      cameraBlockedEvents: absenceCount,
      lightingQuality: (vision.lightingIssues || 0) > 0 ? "Poor" : "Good",
      tabSwitchCount: 0,
      fullscreenExitCount: 0,
      summary: `Face visible ${facePresencePct.toFixed(1)}% of interview. ${absenceCount} absence event(s) detected.${
        hasMultipleFaces ? " Multiple faces were detected." : ""
      }${phoneCount > 0 ? ` ${phoneCount} phone detection(s).` : ""}${
        referenceCount > 0 ? ` ${referenceCount} reference material detection(s).` : ""
      }`,
      flaggedMoments,
    },
    aiInterviewerNotes: (() => {
      const followUps = [];
      if (missingSkills.length > 0) {
        followUps.push(
          `Ask the candidate to explain hands-on experience with ${missingSkills.slice(0, 3).join(', ')}.`,
        );
      }
      const weakCats = [...new Set(
        questionEvaluations.filter((q) => q.answerQuality === 'weak').map((q) => q.category),
      )];
      for (const c of weakCats.slice(0, 2)) {
        followUps.push(`Consider a follow-up question on "${c}" to assess depth.`);
      }
      if (followUps.length === 0 && questionEvaluations.length > 0) {
        followUps.push('Review the transcript and recording before deciding.');
      }
      const summary = ar.transcriptSummary
        || (questionEvaluations.length > 0
          ? `Candidate answered ${questionEvaluations.length} question(s), ${goodAnswers} at high quality. Skills surfaced: ${detectedSkills.slice(0, 6).join(', ') || 'none detected'}.`
          : 'No transcript was captured for AI analysis.');
      return {
        summary,
        strengths:
          strongSkills.length > 0
            ? [...new Set(strongSkills)].slice(0, 5)
            : detectedSkills.slice(0, 5),
        weaknesses:
          weakSkills.length > 0
            ? [...new Set(weakSkills)].slice(0, 5)
            : missingSkills.slice(0, 5),
        recommendedFollowUpQuestions: followUps,
      };
    })(),
    transcript: ar.transcript || null,
    transcriptSummary: ar.transcriptSummary || "",
    evidence: ar.evidence || [],
    integrityScore: ar.integrityScore ?? null,
    integrityAlerts: ar.integrityAlerts || [],
    humanReviewRequired: ar.humanReviewRequired || false,
    ethicsNote: ar.ethicsNote || "",
    recruiterDecision: recDecision,
    _source: "analysis_pipeline",
  };
}

router.get(
  "/:roomId([0-9a-fA-F]{24})/report",
  verifyToken,
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId)
        .populate("candidate", "email firstName lastName")
        .populate("initiator", "email firstName lastName")
        .populate("job", "title skills");

      if (!callRoom) return res.status(404).json({ message: "Room not found" });

      // Only initiator (RH) may read the report
      if (!callRoom.initiator._id.equals(req.user._id)) {
        return res
          .status(403)
          .json({ message: "Only the recruiter can access this report" });
      }

      // Try the analysis pipeline report first (stored in interview_final_reports collection).
      const interviewId = callRoom.roomId || String(callRoom._id);
      try {
        const mongoose = require("mongoose");
        const analysisReport = await mongoose.connection.db
          .collection("interview_final_reports")
          .findOne({ interviewId });
        if (analysisReport) {
          const adapted = _adaptAnalysisReport(analysisReport, callRoom);
          return res.json({
            success: true,
            report: adapted,
            source: "analysis_pipeline",
          });
        }
      } catch (dbErr) {
        console.warn(
          "[report] analysis collection lookup failed:",
          dbErr.message,
        );
      }

      // Fall back to stored recruiter report
      if (callRoom.recruiterReport) {
        return res.json({
          success: true,
          report: callRoom.recruiterReport,
          source: "stored",
        });
      }

      // Auto-build on first access if the interview has ended
      if (callRoom.status === "ended") {
        try {
          const report = buildRecruiterReport(callRoom);
          callRoom.recruiterReport = report;
          await callRoom.save();
          return res.json({ success: true, report, source: "generated" });
        } catch (buildError) {
          console.warn(
            "Report build failed, returning mock:",
            buildError.message,
          );
          return res.json({
            success: true,
            report: buildMockRecruiterReport(),
            source: "mock",
          });
        }
      }

      // Interview not ended yet
      return res.json({ success: true, report: null, source: "not_ready" });
    } catch (error) {
      console.error("GET report error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

/**
 * POST /api/call-rooms/:roomId/generate-report
 * (Re-)generates and stores the full recruiter report.
 * Only the initiator (RH) may trigger this.
 */
router.post(
  "/:roomId([0-9a-fA-F]{24})/generate-report",
  verifyToken,
  async (req, res) => {
    try {
      const callRoom = await CallRoom.findById(req.params.roomId)
        .populate("candidate", "email firstName lastName")
        .populate("initiator", "email firstName lastName")
        .populate("job", "title skills");

      if (!callRoom) return res.status(404).json({ message: "Room not found" });

      if (!callRoom.initiator._id.equals(req.user._id)) {
        return res
          .status(403)
          .json({ message: "Only the recruiter can generate a report" });
      }

      let report;
      let source = "generated";
      try {
        report = buildRecruiterReport(callRoom);
      } catch (buildError) {
        console.warn("Report build failed, using mock:", buildError.message);
        report = buildMockRecruiterReport();
        source = "mock";
      }

      callRoom.recruiterReport = report;
      await callRoom.save();

      res.json({ success: true, report, source });
    } catch (error) {
      console.error("Generate report error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

/**
 * PATCH /api/call-rooms/:roomId/recruiter-decision
 * Saves the recruiter's final decision (accept / reject / needs_review).
 * Body: { status: 'accepted'|'rejected'|'needs_review', notes?: string }
 */
router.patch(
  "/:roomId([0-9a-fA-F]{24})/recruiter-decision",
  verifyToken,
  async (req, res) => {
    try {
      const { status, notes } = req.body || {};
      const allowedStatuses = ["accepted", "rejected", "needs_review"];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          message: `status must be one of: ${allowedStatuses.join(", ")}`,
        });
      }

      const callRoom = await CallRoom.findById(req.params.roomId).populate(
        "initiator",
        "email firstName lastName",
      );

      if (!callRoom) return res.status(404).json({ message: "Room not found" });

      if (!callRoom.initiator._id.equals(req.user._id)) {
        return res
          .status(403)
          .json({ message: "Only the recruiter can submit a decision" });
      }

      const decision = {
        status,
        notes: String(notes || ""),
        decidedAt: new Date().toISOString(),
      };

      // Patch the decision inside the stored report if present
      if (callRoom.recruiterReport) {
        callRoom.recruiterReport = {
          ...callRoom.recruiterReport,
          recruiterDecision: decision,
        };
      }

      // Also store at room level for quick lookups
      callRoom.rhDecision = decision;
      callRoom.markModified("recruiterReport");
      await callRoom.save();

      res.json({ success: true, decision });
    } catch (error) {
      console.error("Recruiter decision error:", error);
      res.status(500).json({ message: error.message });
    }
  },
);

// Mount face-verify sub-routes — accepts both public slug and MongoDB ObjectID
router.use("/:roomId/face-verify", require("./faceVerify"));

module.exports = router;
