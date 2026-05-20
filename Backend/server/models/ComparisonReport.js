const mongoose = require("mongoose");

const { Schema } = mongoose;

const CompositeBreakdownSchema = new Schema(
  {
    technical: { type: Number, default: null },
    theta_normalized: { type: Number, default: null },
    resilience: { type: Number, default: null },
    system_design: { type: Number, default: null },
    problem_solving: { type: Number, default: null },
    communication: { type: Number, default: null },
    hr_fit: { type: Number, default: null },
  },
  { _id: false }
);

const CandidateRankingSchema = new Schema(
  {
    candidate: { type: Schema.Types.ObjectId, ref: "User" },
    session: { type: Schema.Types.ObjectId, ref: "CallRoom" },
    candidateName: { type: String, default: "" },
    candidateEmail: { type: String, default: "" },

    rank: { type: Number, required: true },
    suitabilityScore: { type: Number, default: 0 }, // 0-100
    compositeScore: { type: Number, default: null }, // weighted formula result
    compositeBreakdown: { type: CompositeBreakdownSchema, default: () => ({}) },
    matchScore: { type: Number, default: null }, // job-requirement fit 0-100

    strengths: { type: [String], default: [] },
    gaps: { type: [String], default: [] },

    strongestPoint: { type: String, default: "" },
    mainWeakness: { type: String, default: "" },
    hiringRecommendation: { type: String, default: "" },
    justification: { type: String, default: "" },

    // Raw metrics fed to the agent — kept for table rendering / CSV export
    metrics: {
      technicalTheta: { type: Number, default: null },
      technicalScore: { type: Number, default: null },
      hrScore: { type: Number, default: null },
      integrityScore: { type: Number, default: null },
      resilienceIndex: { type: Number, default: null },
      sentimentScore: { type: Number, default: null },
      answerCompleteness: { type: Number, default: null },
      stressProfile: { type: String, default: "" },
    },
  },
  { _id: false }
);

const ComparisonReportSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    jobInterviewRoom: {
      type: Schema.Types.ObjectId,
      ref: "JobInterviewRoom",
      index: true,
    },
    company: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User" },

    status: {
      type: String,
      enum: ["pending", "running", "ready", "failed"],
      default: "pending",
      index: true,
    },

    sessionIds: [{ type: Schema.Types.ObjectId, ref: "CallRoom" }],
    candidateCount: { type: Number, default: 0 },

    rankings: { type: [CandidateRankingSchema], default: [] },
    executiveSummary: { type: String, default: "" },
    narrativeComparison: { type: String, default: "" },

    recommendedCandidateId: { type: String, default: "" }, // session_id of recommended
    confidencePct: { type: Number, default: null },
    isClosingCall: { type: Boolean, default: false },
    tiebreakerQuestion: { type: String, default: "" },

    llmProvider: { type: String, default: "" },
    error: { type: String, default: "" },
    generatedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.ComparisonReport ||
  mongoose.model("ComparisonReport", ComparisonReportSchema);
