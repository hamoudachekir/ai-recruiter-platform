const express = require('express');
const path = require('path');
const { verifyToken, requireCandidate } = require('../middleware/auth');
const { UserModel } = require('../models/user');
const Application = require('../models/Application');
const svc = require('../services/cvTailoringService');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'uploads');

async function loadCandidateCv(candidateId) {
  const user = await UserModel.findById(candidateId).select('name email profile').lean();
  const absPath = svc.resolveCvFilePath(user, uploadDir);
  try {
    if (!absPath) throw new Error('no CV file on disk');
    return await svc.parseCv(absPath);
  } catch (parseErr) {
    console.warn('[cvTailoring] parser unavailable, using stored profile:', parseErr.message);
    return svc.buildCvJsonFromProfile(user);
  }
}

// POST /api/cv/tailor  → reformulate (fast, JSON + changes, no PDF)
router.post('/tailor', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobId, jobText } = req.body;
    // Either a platform job (jobId) or a pasted job description (jobText) —
    // the standalone "Adapter mon CV" profile tab has no jobId in context.
    if (!jobId && !(jobText && jobText.trim())) {
      return res.status(400).json({ message: 'jobId or jobText is required' });
    }

    // Prefer re-parsing the uploaded CV PDF (richest source). If the parser
    // service (5002) is unavailable — e.g. PaddleOCR cannot be installed on the
    // host's Python — or there is no CV file on disk, fall back to the
    // candidate's stored structured profile so tailoring still works.
    const cvJson = await loadCandidateCv(req.user._id);

    if (!cvJson || !cvJson.profile || !(cvJson.profile.skills || []).length) {
      return res.status(400).json({ message: 'No CV data to tailor. Upload a CV or complete your profile first.' });
    }

    const result = await svc.callTailor({ candidateId: String(req.user._id), jobId, cvJson, jobText });
    // Return tailored JSON + the parsed original so the client can render both panels
    return res.json({ ...result, cv_json: cvJson });
  } catch (err) {
    return forward(err, res, 'tailor');
  }
});

// POST /api/cv/copilot/analyze → deterministic fit score + local tracking
router.post('/copilot/analyze', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobText, jobTitle, company, sourceUrl } = req.body;
    if (!jobText || jobText.trim().length < 20) {
      return res.status(400).json({ message: 'A job description of at least 20 characters is required' });
    }
    const cvJson = await loadCandidateCv(req.user._id);
    const result = await svc.analyzeJob({
      candidateId: String(req.user._id),
      cvJson,
      jobText,
      jobTitle,
      company,
      sourceUrl,
    });
    return res.json({ ...result, cv_json: cvJson });
  } catch (err) {
    return forward(err, res, 'copilot-analyze');
  }
});

// POST /api/cv/copilot/cover-letter → factual FR/EN letter from the stored CV
router.post('/copilot/cover-letter', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobText, jobTitle, company, language } = req.body;
    if (!jobText || jobText.trim().length < 20) {
      return res.status(400).json({ message: 'A job description of at least 20 characters is required' });
    }
    const cvJson = await loadCandidateCv(req.user._id);
    return res.json(await svc.generateCoverLetter({
      cvJson,
      jobText,
      jobTitle,
      company,
      language,
    }));
  } catch (err) {
    return forward(err, res, 'copilot-cover-letter');
  }
});

router.get('/copilot/applications', verifyToken, requireCandidate, async (req, res) => {
  try {
    return res.json(await svc.listCopilotApplications(String(req.user._id)));
  } catch (err) {
    return forward(err, res, 'copilot-applications');
  }
});

router.patch('/copilot/applications/:applicationId', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { status, notes } = req.body;
    return res.json(await svc.updateCopilotApplication({
      candidateId: String(req.user._id),
      applicationId: req.params.applicationId,
      status,
      notes,
    }));
  } catch (err) {
    return forward(err, res, 'copilot-application-update');
  }
});

// POST /api/cv/tailor/export  → generate PDF and attach to the Application
router.post('/tailor/export', verifyToken, requireCandidate, async (req, res) => {
  try {
    const { jobId, cv_json, tailored_cv_json, attach, template } = req.body;
    if (!cv_json || !tailored_cv_json) {
      return res.status(400).json({ message: 'cv_json and tailored_cv_json are required' });
    }
    if (attach && !jobId) {
      return res.status(400).json({ message: 'jobId is required to attach a tailored CV to an application' });
    }
    const candidateId = String(req.user._id);

    // PDF generation needs the self-hosted Reactive Resume instance. If it is
    // down and the candidate asked to ATTACH, degrade gracefully: attach the
    // tailored JSON without a PDF (the client offers print-to-PDF locally).
    let exported = null;
    try {
      exported = await svc.callExport({ candidateId, jobId, cvJson: cv_json, tailored: tailored_cv_json, template });
    } catch (exportErr) {
      if (!attach) return forward(exportErr, res, 'export');
      console.warn('[cvTailoring:export] PDF service unavailable, attaching JSON only:', exportErr.message);
    }

    let application = null;
    if (attach) {
      const update = svc.buildApplicationUpdate({
        pdf_path: exported?.pdf_path || null,
        tailored_cv_json,
        changes_applied: tailored_cv_json.changes_applied || [],
      });
      application = await Application.findOneAndUpdate(
        { jobId, candidateId: req.user._id },
        { $set: update },
        { new: true }
      ).lean();
    }
    return res.json({
      pdf_path: exported?.pdf_path || null,
      resume_id: exported?.resume_id || null,
      attached: Boolean(application),
      applicationId: application?._id || null,
      pdfUnavailable: exported ? undefined : true,
      noApplication: attach && !application ? true : undefined,
    });
  } catch (err) {
    return forward(err, res, 'export');
  }
});

// GET /api/cv/tailored/:applicationId  → candidate or the job's enterprise
router.get('/tailored/:applicationId', verifyToken, async (req, res) => {
  try {
    const app = await Application.findById(req.params.applicationId)
      .select('candidateId enterpriseId tailoredCvPath tailoredCvJson tailoredCvChanges tailoredCvGeneratedAt')
      .lean();
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const uid = String(req.user._id);
    if (uid !== String(app.candidateId) && uid !== String(app.enterpriseId)) {
      return res.status(403).json({ message: 'Not authorized to view this tailored CV' });
    }
    return res.json({
      tailoredCvPath: app.tailoredCvPath,
      tailoredCvJson: app.tailoredCvJson,
      tailoredCvChanges: app.tailoredCvChanges,
      tailoredCvGeneratedAt: app.tailoredCvGeneratedAt,
    });
  } catch (err) {
    return forward(err, res, 'tailored-get');
  }
});

function forward(err, res, where) {
  const status = err.response?.status || err.statusCode || 500;
  const detail = err.response?.data?.detail || err.response?.data || err.message;
  console.error(`[cvTailoring:${where}]`, status, detail);
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    message: 'CV tailoring failed', detail,
  });
}

module.exports = router;
