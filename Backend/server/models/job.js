const mongoose = require('mongoose');
const { Schema } = mongoose;

const HEX_RE = /^#([0-9a-f]{3}){1,2}$/i;

// ── Embedded sub-schemas ──────────────────────────────────────────────────────

const PredefinedQuestionSchema = new Schema(
  {
    id:    { type: String, required: true },
    text:  { type: String, required: true, trim: true, maxlength: 500 },
    stage: { type: String, enum: ['beginning', 'middle', 'end'], required: true },
    order: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const EvaluationCriterionSchema = new Schema(
  {
    name:   { type: String, required: true, trim: true, maxlength: 80 },
    weight: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

// Interview-engine vocabulary — keep these enums in sync with
// voice_engine/interview_agent/irt_engine.py:STYLE_DIFFICULTY_RANGES.
const INTERVIEW_STYLES = ['friendly', 'strict', 'senior', 'junior', 'fast_screening'];

const EvaluationConfigSchema = new Schema(
  {
    criteria:        { type: [EvaluationCriterionSchema], default: undefined },
    interviewStyle:  { type: String, enum: INTERVIEW_STYLES },
    minDifficulty:   { type: Number, min: 1, max: 5 },
    maxDifficulty:   { type: Number, min: 1, max: 5 },
    trackResilience: { type: Boolean, default: false },
  },
  { _id: false }
);

const BrandColorsSchema = new Schema(
  {
    primary:   { type: String, match: HEX_RE },
    secondary: { type: String, match: HEX_RE },
    accent:    { type: String, match: HEX_RE },
  },
  { _id: false }
);

// ── Job ───────────────────────────────────────────────────────────────────────

const JobSchema = new Schema(
  {
    // Original fields
    title: {
      type: String,
      trim: true,
      // Required only when the job is being published — drafts may have an
      // empty title while the wizard is partially filled.
      required: function () { return this.status !== 'DRAFT'; },
    },
    description:  { type: String },
    location:     { type: String, trim: true },
    salary:       { type: Number },
    languages:    [{ type: String }],
    skills:       [{ type: String }],
    entrepriseId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status:       { type: String, enum: ['DRAFT', 'OPEN', 'CLOSED'], default: 'OPEN' },

    // Wizard: Step 1 — Department
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },

    // Wizard: Step 2 — Company Context (snapshot of name onto the Job)
    companyContextId: { type: Schema.Types.ObjectId, ref: 'CompanyContext' },
    companyName:      { type: String, trim: true, maxlength: 120 },

    // Wizard: Step 3 — Job Details
    seniorityLevel:       { type: String, enum: ['Intern', 'Junior', 'Mid', 'Senior', 'Lead'] },
    employmentType:       { type: String, enum: ['Full-time', 'Part-time', 'Contract', 'Internship'] },
    workspaceType:        { type: String, enum: ['On-site', 'Remote', 'Hybrid'] },
    interviewLanguage:    { type: String, trim: true },
    recordApplicantVideo: { type: Boolean, default: false },

    // Wizard: Step 4 — Job Description
    descriptionSource: { type: String, enum: ['manual', 'ai'], default: 'manual' },

    // Wizard: Step 5 — Interview Type
    interviewType: { type: String, enum: ['ai_dynamic', 'hybrid', 'predefined'], default: 'ai_dynamic' },

    // Wizard: Step 6 — Questions (max 10, enforced in pre-validate hook)
    predefinedQuestions: { type: [PredefinedQuestionSchema], default: undefined },

    // Wizard: Step 7 — Evaluation
    evaluationConfig: { type: EvaluationConfigSchema, default: undefined },

    // Brand-colors snapshot (optional; convenience for rendering on job detail
    // without joining CompanyContext)
    brandColorsSnapshot: { type: BrandColorsSchema },
  },
  { timestamps: true }
);

// ── Cross-field validation ────────────────────────────────────────────────────

JobSchema.pre('validate', function (next) {
  // Max 10 predefined questions
  if (Array.isArray(this.predefinedQuestions) && this.predefinedQuestions.length > 10) {
    return next(new Error('predefinedQuestions cannot exceed 10 entries'));
  }

  // predefinedQuestions only allowed when interviewType is hybrid or predefined
  if (
    Array.isArray(this.predefinedQuestions) &&
    this.predefinedQuestions.length > 0 &&
    this.interviewType === 'ai_dynamic'
  ) {
    return next(
      new Error("predefinedQuestions is not allowed when interviewType is 'ai_dynamic'")
    );
  }

  // Evaluation config validation
  if (this.evaluationConfig) {
    const ec = this.evaluationConfig;

    // Criteria weights must sum to 100 (only if criteria is non-empty)
    if (Array.isArray(ec.criteria) && ec.criteria.length > 0) {
      const sum = ec.criteria.reduce((acc, c) => acc + (Number(c.weight) || 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        return next(
          new Error(`evaluationConfig.criteria weights must sum to 100 (got ${sum})`)
        );
      }
    }

    // minDifficulty <= maxDifficulty if both set
    if (
      typeof ec.minDifficulty === 'number' &&
      typeof ec.maxDifficulty === 'number' &&
      ec.minDifficulty > ec.maxDifficulty
    ) {
      return next(
        new Error('evaluationConfig.minDifficulty must be <= maxDifficulty')
      );
    }
  }

  return next();
});

// ── Indexes ───────────────────────────────────────────────────────────────────

JobSchema.index({ entrepriseId: 1, status: 1 });
JobSchema.index({ status: 1, createdAt: -1 });

// ── Module export ─────────────────────────────────────────────────────────────

const JobModel = mongoose.models.Job || mongoose.model('Job', JobSchema);

module.exports = JobModel;
module.exports.INTERVIEW_STYLES = INTERVIEW_STYLES;
