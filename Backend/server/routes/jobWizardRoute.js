const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const router = express.Router();

const JobModel = require('../models/job');
const DepartmentModel = require('../models/department');
const CompanyContextModel = require('../models/companyContext');
// `require('../models/user')` exports { UserModel, JobModel, InterviewModel,
// ApplicationModel } — destructure UserModel here so `.findById(...)` etc.
// resolve to actual Mongoose calls instead of `undefined.findById(...)`.
const { UserModel } = require('../models/user');
const { verifyToken, requireEnterprise } = require('../middleware/auth');
const aiGenerationRateLimiter = require('../middleware/aiGenerationRateLimit');
const { generateJson } = require('../services/aiContentService');
const { buildJobDescriptionPrompt } = require('../prompts/jobDescription');
const { buildQuestionSuggestionPrompt } = require('../prompts/questionSuggestion');

const { INTERVIEW_STYLES } = JobModel;

// LLM error codes that should surface to the client as a clean 502.
const AI_RECOVERABLE_ERRORS = new Set([
  'AI_TIMEOUT',
  'AI_PARSE_ERROR',
  'AI_HTTP_ERROR',
  'AI_FETCH_FAILED',
]);

function handleAiError(err, res, label) {
  if (err && AI_RECOVERABLE_ERRORS.has(err.code)) {
    console.warn(`${label} ${err.code}:`, err.message);
    return res.status(502).json({ message: 'AI generation failed, try again' });
  }
  if (err && err.code === 'AI_NOT_CONFIGURED') {
    console.error(`${label} AI_NOT_CONFIGURED:`, err.message);
    return res.status(503).json({ message: 'AI service is not configured' });
  }
  console.error(`${label} error:`, err);
  return res.status(500).json({ message: 'Server error' });
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Whitelist of fields the client may write through this router. Everything
// else (status, entrepriseId, brandColorsSnapshot, timestamps) is set server-side.
const WRITABLE_FIELDS = [
  'title',
  'description',
  'location',
  'salary',
  'languages',
  'skills',
  'departmentId',
  'companyContextId',
  'companyName',
  'seniorityLevel',
  'employmentType',
  'workspaceType',
  'interviewLanguage',
  'recordApplicantVideo',
  'descriptionSource',
  'interviewType',
  'predefinedQuestions',
  'evaluationConfig',
];

// Fields that must be set for a job to be published (DRAFT -> OPEN).
const PUBLISH_REQUIRED_FIELDS = [
  'title',
  'description',
  'location',
  'interviewLanguage',
  'seniorityLevel',
  'employmentType',
  'workspaceType',
  'departmentId',
  'companyContextId',
];

const SENIORITY_LEVELS    = ['Intern', 'Junior', 'Mid', 'Senior', 'Lead'];
const EMPLOYMENT_TYPES    = ['Full-time', 'Part-time', 'Contract', 'Internship'];
const WORKSPACE_TYPES     = ['On-site', 'Remote', 'Hybrid'];
const INTERVIEW_TYPES     = ['ai_dynamic', 'hybrid', 'predefined'];
const DESCRIPTION_SOURCES = ['manual', 'ai'];
const QUESTION_STAGES     = ['beginning', 'middle', 'end'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const refreshRecommendationIndex = async () => {
  try {
    await axios.post(
      'http://127.0.0.1:5001/refresh-index',
      {},
      { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.warn('Recommendation index refresh skipped:', error.message);
  }
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray    = (v) => Array.isArray(v) && v.every((item) => typeof item === 'string');

// Pick only writable fields from the body. Returns { payload, error? }.
function buildPayload(body) {
  const payload = {};
  if (!body || typeof body !== 'object') return { payload };

  for (const key of WRITABLE_FIELDS) {
    if (!(key in body)) continue;
    payload[key] = body[key];
  }

  // Per-field shape & enum validation. Trim strings.
  for (const key of ['title', 'description', 'location', 'companyName', 'interviewLanguage']) {
    if (payload[key] === null) continue;
    if (payload[key] === undefined) continue;
    if (typeof payload[key] !== 'string') return { error: `${key} must be a string` };
    payload[key] = payload[key].trim();
  }

  if ('salary' in payload && payload.salary !== null && payload.salary !== undefined && payload.salary !== '') {
    const num = Number(payload.salary);
    if (!Number.isFinite(num) || num < 0) return { error: 'salary must be a non-negative number' };
    payload.salary = num;
  } else if (payload.salary === '' || payload.salary === null) {
    payload.salary = undefined;
  }

  for (const key of ['languages', 'skills']) {
    if (payload[key] === undefined) continue;
    if (payload[key] === null) { payload[key] = []; continue; }
    if (!isStringArray(payload[key])) return { error: `${key} must be an array of strings` };
    payload[key] = payload[key].map((s) => s.trim()).filter(Boolean);
  }

  if ('recordApplicantVideo' in payload) {
    if (typeof payload.recordApplicantVideo !== 'boolean') {
      return { error: 'recordApplicantVideo must be a boolean' };
    }
  }

  const enumChecks = [
    ['seniorityLevel',    SENIORITY_LEVELS],
    ['employmentType',    EMPLOYMENT_TYPES],
    ['workspaceType',     WORKSPACE_TYPES],
    ['interviewType',     INTERVIEW_TYPES],
    ['descriptionSource', DESCRIPTION_SOURCES],
  ];
  for (const [key, allowed] of enumChecks) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (!allowed.includes(payload[key])) {
      return { error: `${key} must be one of: ${allowed.join(', ')}` };
    }
  }

  for (const key of ['departmentId', 'companyContextId']) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (!isValidObjectId(payload[key])) return { error: `${key} is not a valid id` };
  }

  if (payload.predefinedQuestions !== undefined && payload.predefinedQuestions !== null) {
    if (!Array.isArray(payload.predefinedQuestions)) {
      return { error: 'predefinedQuestions must be an array' };
    }
    if (payload.predefinedQuestions.length > 10) {
      return { error: 'predefinedQuestions cannot exceed 10 entries' };
    }
    for (const [i, q] of payload.predefinedQuestions.entries()) {
      if (!q || typeof q !== 'object') {
        return { error: `predefinedQuestions[${i}] must be an object` };
      }
      if (!isNonEmptyString(q.id))   return { error: `predefinedQuestions[${i}].id is required` };
      if (!isNonEmptyString(q.text)) return { error: `predefinedQuestions[${i}].text is required` };
      if (!QUESTION_STAGES.includes(q.stage)) {
        return { error: `predefinedQuestions[${i}].stage must be one of: ${QUESTION_STAGES.join(', ')}` };
      }
      if (!Number.isFinite(Number(q.order)) || Number(q.order) < 0) {
        return { error: `predefinedQuestions[${i}].order must be a non-negative number` };
      }
    }
  }

  if (payload.evaluationConfig !== undefined && payload.evaluationConfig !== null) {
    const ec = payload.evaluationConfig;
    if (typeof ec !== 'object' || Array.isArray(ec)) {
      return { error: 'evaluationConfig must be an object' };
    }
    if (ec.interviewStyle !== undefined && ec.interviewStyle !== null) {
      if (!INTERVIEW_STYLES.includes(ec.interviewStyle)) {
        return { error: `evaluationConfig.interviewStyle must be one of: ${INTERVIEW_STYLES.join(', ')}` };
      }
    }
    for (const key of ['minDifficulty', 'maxDifficulty']) {
      if (ec[key] === undefined || ec[key] === null) continue;
      const n = Number(ec[key]);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return { error: `evaluationConfig.${key} must be an integer 1–5` };
      }
      ec[key] = n;
    }
    if (typeof ec.minDifficulty === 'number' && typeof ec.maxDifficulty === 'number' && ec.minDifficulty > ec.maxDifficulty) {
      return { error: 'evaluationConfig.minDifficulty must be <= maxDifficulty' };
    }
    if (ec.trackResilience !== undefined && typeof ec.trackResilience !== 'boolean') {
      return { error: 'evaluationConfig.trackResilience must be a boolean' };
    }
    if (ec.criteria !== undefined && ec.criteria !== null) {
      if (!Array.isArray(ec.criteria)) {
        return { error: 'evaluationConfig.criteria must be an array' };
      }
      for (const [i, c] of ec.criteria.entries()) {
        if (!c || typeof c !== 'object') {
          return { error: `evaluationConfig.criteria[${i}] must be an object` };
        }
        if (!isNonEmptyString(c.name)) {
          return { error: `evaluationConfig.criteria[${i}].name is required` };
        }
        const w = Number(c.weight);
        if (!Number.isFinite(w) || w < 0 || w > 100) {
          return { error: `evaluationConfig.criteria[${i}].weight must be 0–100` };
        }
        c.weight = w;
      }
      // Sum-100 is also enforced by the Mongoose pre-validate hook, but we
      // surface the error early with a clearer message.
      if (ec.criteria.length > 0) {
        const sum = ec.criteria.reduce((acc, c) => acc + c.weight, 0);
        if (Math.abs(sum - 100) > 0.01) {
          return { error: `evaluationConfig.criteria weights must sum to 100 (got ${sum})` };
        }
      }
    }
  }

  return { payload };
}

// Resolve the company-context snapshot. Mutates payload in place.
async function resolveContextSnapshot(payload, entrepriseId) {
  if (!('companyContextId' in payload)) return { ok: true };

  if (payload.companyContextId === null || payload.companyContextId === '') {
    payload.companyContextId = null;
    payload.brandColorsSnapshot = undefined;
    return { ok: true };
  }

  const ctx = await CompanyContextModel.findOne({
    _id: payload.companyContextId,
    entrepriseId,
  });
  if (!ctx) return { error: 'companyContextId not found' };

  // Always snapshot brand colors. Snapshot name only if the client didn't
  // override it (Step 3 allows manual override).
  if (!('companyName' in payload) || payload.companyName === undefined) {
    payload.companyName = ctx.name;
  }
  payload.brandColorsSnapshot = ctx.brandColors && Object.keys(ctx.brandColors.toObject ? ctx.brandColors.toObject() : ctx.brandColors).length
    ? ctx.brandColors
    : undefined;

  return { ok: true };
}

// Verify the department belongs to this enterprise.
async function validateDepartment(payload, entrepriseId) {
  if (!('departmentId' in payload)) return { ok: true };
  if (payload.departmentId === null || payload.departmentId === '') {
    payload.departmentId = null;
    return { ok: true };
  }
  const dept = await DepartmentModel.findOne({
    _id: payload.departmentId,
    entrepriseId,
  });
  if (!dept) return { error: 'departmentId not found' };
  return { ok: true };
}

// Check publish readiness against the persisted job (not the payload).
function validatePublishReadiness(job) {
  const missing = [];
  for (const field of PUBLISH_REQUIRED_FIELDS) {
    const value = job[field];
    if (value === undefined || value === null) { missing.push(field); continue; }
    if (typeof value === 'string' && !value.trim()) { missing.push(field); continue; }
  }
  // predefinedQuestions only required when interviewType is 'predefined'
  if (job.interviewType === 'predefined') {
    if (!Array.isArray(job.predefinedQuestions) || job.predefinedQuestions.length === 0) {
      missing.push('predefinedQuestions');
    }
  }
  return missing;
}

async function pushJobToUserPosted(user, job) {
  if (!Array.isArray(user.jobsPosted)) user.jobsPosted = [];
  if (user.jobsPosted.some((entry) => String(entry.jobId) === String(job._id))) return;
  user.jobsPosted.push({
    jobId:       job._id,
    title:       job.title,
    status:      'OPEN',
    createdDate: job.createdAt,
  });
  user.markModified('jobsPosted');
  await user.save();
}

async function removeJobFromUserPosted(userId, jobId) {
  await UserModel.findByIdAndUpdate(userId, {
    $pull: { jobsPosted: { jobId } },
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/wizard/jobs/drafts
// IMPORTANT: must be declared before '/:id' so Express doesn't treat 'drafts'
// as an :id parameter.
router.get('/drafts', verifyToken, requireEnterprise, async (req, res) => {
  try {
    const drafts = await JobModel
      .find({ entrepriseId: req.user._id, status: 'DRAFT' })
      .sort({ updatedAt: -1 });
    res.json({ drafts });
  } catch (err) {
    console.error('GET /api/wizard/jobs/drafts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/wizard/jobs/generate-description
// Body: { companyContextId, userRequirements, title, seniorityLevel,
//         employmentType, workspaceType, location, salary, skills, languages, count? }
// Resolves the CompanyContext server-side (scoped to caller). Returns 2–3 candidates.
router.post(
  '/generate-description',
  verifyToken,
  requireEnterprise,
  aiGenerationRateLimiter,
  async (req, res) => {
    try {
      const body = req.body || {};

      // Resolve CompanyContext server-side, scoped to the calling enterprise.
      // We never trust context fields from the body — only the ID.
      let context = null;
      if (body.companyContextId) {
        if (!isValidObjectId(body.companyContextId)) {
          return res.status(400).json({ message: 'Invalid companyContextId' });
        }
        context = await CompanyContextModel.findOne({
          _id: body.companyContextId,
          entrepriseId: req.user._id,
        });
        if (!context) {
          return res.status(400).json({ message: 'companyContextId not found' });
        }
      }

      // Whitelist incoming job fields.
      const jobFields = {};
      for (const key of [
        'title', 'seniorityLevel', 'employmentType', 'workspaceType',
        'location', 'salary', 'skills', 'languages',
      ]) {
        if (body[key] !== undefined) jobFields[key] = body[key];
      }

      const count = Math.min(Math.max(Number.parseInt(body.count, 10) || 3, 2), 3);
      const userRequirements = typeof body.userRequirements === 'string'
        ? body.userRequirements.trim().slice(0, 1000)
        : '';

      const prompt = buildJobDescriptionPrompt({
        context: context ? {
          name:        context.name,
          industry:    context.industry,
          description: context.description,
          website:     context.website,
        } : null,
        job: jobFields,
        userRequirements,
        count,
      });

      const parsed = await generateJson({ prompt, temperature: 0.7 });
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      if (candidates.length === 0) {
        return res.status(502).json({ message: 'AI generation failed, try again' });
      }

      res.json({ candidates });
    } catch (err) {
      return handleAiError(err, res, 'POST /api/wizard/jobs/generate-description');
    }
  }
);

// POST /api/wizard/jobs/suggest-questions
// Body: { title?, seniorityLevel?, skills?, languages?, description?, interviewType?, count? }
router.post(
  '/suggest-questions',
  verifyToken,
  requireEnterprise,
  aiGenerationRateLimiter,
  async (req, res) => {
    try {
      const body = req.body || {};

      const jobFields = {};
      for (const key of ['title', 'seniorityLevel', 'skills', 'languages', 'description']) {
        if (body[key] !== undefined) jobFields[key] = body[key];
      }

      const interviewType = ['ai_dynamic', 'hybrid', 'predefined'].includes(body.interviewType)
        ? body.interviewType
        : 'hybrid';
      const count = Math.min(Math.max(Number.parseInt(body.count, 10) || 8, 3), 12);

      const prompt = buildQuestionSuggestionPrompt({ job: jobFields, count, interviewType });
      const parsed = await generateJson({ prompt, temperature: 0.5 });

      const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];

      // Normalize each suggestion. Drop invalid entries instead of failing the
      // whole request — the wizard can still show a non-empty subset.
      const suggestions = raw
        .map((q) => ({
          text:     typeof q?.text === 'string' ? q.text.trim() : '',
          stage:    ['beginning', 'middle', 'end'].includes(q?.stage) ? q.stage : 'middle',
          category: typeof q?.category === 'string' ? q.category : 'general',
        }))
        .filter((q) => q.text.length > 0);

      if (suggestions.length === 0) {
        return res.status(502).json({ message: 'AI generation failed, try again' });
      }

      res.json({ suggestions });
    } catch (err) {
      return handleAiError(err, res, 'POST /api/wizard/jobs/suggest-questions');
    }
  }
);

// POST /api/wizard/jobs
// Creates a new job, default status DRAFT.
router.post('/', verifyToken, requireEnterprise, async (req, res) => {
  const { payload, error } = buildPayload(req.body);
  if (error) return res.status(400).json({ message: error });

  const ctxResult = await resolveContextSnapshot(payload, req.user._id);
  if (ctxResult.error) return res.status(400).json({ message: ctxResult.error });

  const deptResult = await validateDepartment(payload, req.user._id);
  if (deptResult.error) return res.status(400).json({ message: deptResult.error });

  try {
    const job = await JobModel.create({
      ...payload,
      entrepriseId: req.user._id,
      status: 'DRAFT',
    });
    res.status(201).json({ job });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    console.error('POST /api/wizard/jobs error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/wizard/jobs/:id
router.get('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Job not found' });
  }
  try {
    const job = await JobModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    res.json({ job });
  } catch (err) {
    console.error('GET /api/wizard/jobs/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/wizard/jobs/:id
// Partial update. Status transitions are NOT allowed via this endpoint:
// use POST /:id/publish to go DRAFT -> OPEN.
router.put('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Job not found' });
  }

  if (req.body && 'status' in req.body) {
    return res.status(400).json({
      message: 'status cannot be set via PUT. Use POST /:id/publish to publish a draft.',
    });
  }

  const { payload, error } = buildPayload(req.body);
  if (error) return res.status(400).json({ message: error });
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  try {
    const existing = await JobModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!existing) return res.status(404).json({ message: 'Job not found' });

    const ctxResult = await resolveContextSnapshot(payload, req.user._id);
    if (ctxResult.error) return res.status(400).json({ message: ctxResult.error });

    const deptResult = await validateDepartment(payload, req.user._id);
    if (deptResult.error) return res.status(400).json({ message: deptResult.error });

    Object.assign(existing, payload);
    await existing.save();

    // If the underlying job is published, keep the reco index in sync.
    if (existing.status === 'OPEN') {
      await refreshRecommendationIndex();
    }

    res.json({ job: existing });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    console.error('PUT /api/wizard/jobs/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/wizard/jobs/:id/publish
// Transition DRAFT -> OPEN. Validates required wizard fields, pushes the
// job to user.jobsPosted, and refreshes the recommendation index.
router.post('/:id/publish', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Job not found' });
  }

  try {
    const job = await JobModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    if (job.status === 'OPEN') {
      return res.status(409).json({ message: 'Job is already published' });
    }
    if (job.status === 'CLOSED') {
      return res.status(409).json({ message: 'Cannot publish a closed job' });
    }

    const missing = validatePublishReadiness(job);
    if (missing.length > 0) {
      return res.status(400).json({
        message: 'Missing required fields',
        missing,
      });
    }

    job.status = 'OPEN';
    await job.save();

    const user = await UserModel.findById(req.user._id);
    if (user) await pushJobToUserPosted(user, job);

    await refreshRecommendationIndex();

    res.json({ job });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    console.error('POST /api/wizard/jobs/:id/publish error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/wizard/jobs/:id
// Deletes any job owned by the calling enterprise. If the job was OPEN,
// also removes it from user.jobsPosted and refreshes the reco index.
router.delete('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Job not found' });
  }

  try {
    const job = await JobModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const wasOpen = job.status === 'OPEN';
    await JobModel.deleteOne({ _id: job._id });

    if (wasOpen) {
      await removeJobFromUserPosted(req.user._id, job._id);
      await refreshRecommendationIndex();
    }

    res.json({ message: 'Job deleted' });
  } catch (err) {
    console.error('DELETE /api/wizard/jobs/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
