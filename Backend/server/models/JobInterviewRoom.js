const mongoose = require("mongoose");
const crypto = require("crypto");

const { Schema } = mongoose;

const JobInterviewRoomSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Shareable, URL-safe identifier handed to candidates.
    slug: { type: String, unique: true, required: true, index: true },

    title: { type: String, default: "" },
    description: { type: String, default: "" },

    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
      index: true,
    },

    settings: {
      interviewStyle: {
        type: String,
        enum: ["friendly", "strict", "senior", "junior", "fast_screening"],
        default: "friendly",
      },
      maxCandidates: { type: Number, default: 0 }, // 0 = unlimited
      requireFaceVerification: { type: Boolean, default: false },
      preferredLanguage: { type: String, default: "en" },
    },

    // Pre-aggregated counters kept in sync as candidate sessions move through
    // the lifecycle. Cheap to read for live dashboards; recomputed when stale.
    stats: {
      totalSessions: { type: Number, default: 0 },
      completedSessions: { type: Number, default: 0 },
      inProgressSessions: { type: Number, default: 0 },
      lastSessionAt: { type: Date },
    },

    closedAt: { type: Date },

    // Recruiter's final pick from the comparison view. Stored on the room so a
    // single recruiter decision survives across re-runs of the AI ranking.
    selectedCandidate: {
      candidate: { type: Schema.Types.ObjectId, ref: "User" },
      session: { type: Schema.Types.ObjectId, ref: "CallRoom" },
      selectedBy: { type: Schema.Types.ObjectId, ref: "User" },
      selectedAt: { type: Date },
      reason: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

JobInterviewRoomSchema.statics.generateSlug = function generateSlug() {
  // 18 chars of URL-safe entropy — plenty for a shareable invite link.
  return crypto.randomBytes(13).toString("base64url").slice(0, 18);
};

module.exports =
  mongoose.models.JobInterviewRoom ||
  mongoose.model("JobInterviewRoom", JobInterviewRoomSchema);
