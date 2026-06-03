const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const CompanyContextModel = require('../models/companyContext');
const JobModel = require('../models/job');
const { UserModel } = require('../models/user');
const { verifyToken, requireEnterprise } = require('../middleware/auth');

// Seed a CompanyContext from the enterprise user's own profile so the wizard
// always shows the user's company as a selectable option on first run.
// Returns the created context, or null if the user has no usable name.
const seedFromUserEnterprise = async (userId) => {
  const user = await UserModel
    .findById(userId)
    .select('name enterprise')
    .lean();
  if (!user) return null;

  const ent = user.enterprise || {};
  const name = (ent.name || user.name || '').trim();
  if (!name) return null;

  try {
    return await CompanyContextModel.create({
      entrepriseId: userId,
      name,
      website:     (ent.website || '').trim() || undefined,
      industry:    (ent.industry || '').trim() || undefined,
      description: (ent.description || '').trim() || undefined,
    });
  } catch (err) {
    // If a context with this name was created concurrently, just fall through
    // and let the caller re-query.
    if (err && err.code === 11000) return null;
    throw err;
  }
};

const HEX_RE = /^#([0-9a-f]{3}){1,2}$/i;

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleDuplicate = (err, res) => {
  if (err && err.code === 11000) {
    res.status(409).json({ message: 'A company context with this name already exists' });
    return true;
  }
  return false;
};

const sanitizeBrandColors = (input) => {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { __error: 'brandColors must be an object' };
  }

  const out = {};
  for (const key of ['primary', 'secondary', 'accent']) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      return { __error: `brandColors.${key} must be a hex color (e.g. #6366f1)` };
    }
    out[key] = v;
  }
  return out;
};

const buildPayload = (body) => {
  const { name, website, industry, description, brandColors } = body || {};
  const payload = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return { __error: 'name must be a non-empty string' };
    }
    payload.name = name.trim();
  }

  for (const [key, value] of Object.entries({ website, industry, description })) {
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      return { __error: `${key} must be a string` };
    }
    payload[key] = typeof value === 'string' ? value.trim() : '';
  }

  if (brandColors !== undefined) {
    const colors = sanitizeBrandColors(brandColors);
    if (colors.__error) return { __error: colors.__error };
    payload.brandColors = colors;
  }

  return payload;
};

// GET /api/company-contexts
router.get('/', verifyToken, requireEnterprise, async (req, res) => {
  try {
    let contexts = await CompanyContextModel
      .find({ entrepriseId: req.user._id })
      .sort({ name: 1 });

    if (contexts.length === 0) {
      const seeded = await seedFromUserEnterprise(req.user._id);
      if (seeded) {
        contexts = await CompanyContextModel
          .find({ entrepriseId: req.user._id })
          .sort({ name: 1 });
      }
    }
    res.json({ contexts });
  } catch (err) {
    console.error('GET /api/company-contexts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/company-contexts/:id
router.get('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Company context not found' });
  }
  try {
    const context = await CompanyContextModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!context) return res.status(404).json({ message: 'Company context not found' });
    res.json({ context });
  } catch (err) {
    console.error('GET /api/company-contexts/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/company-contexts
router.post('/', verifyToken, requireEnterprise, async (req, res) => {
  const payload = buildPayload(req.body);
  if (payload.__error) return res.status(400).json({ message: payload.__error });
  if (!payload.name) return res.status(400).json({ message: 'name is required' });

  try {
    const context = await CompanyContextModel.create({
      ...payload,
      entrepriseId: req.user._id,
    });
    res.status(201).json({ context });
  } catch (err) {
    if (handleDuplicate(err, res)) return;
    console.error('POST /api/company-contexts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/company-contexts/:id
router.put('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Company context not found' });
  }

  const payload = buildPayload(req.body);
  if (payload.__error) return res.status(400).json({ message: payload.__error });
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  try {
    const context = await CompanyContextModel.findOneAndUpdate(
      { _id: req.params.id, entrepriseId: req.user._id },
      payload,
      { new: true, runValidators: true }
    );
    if (!context) return res.status(404).json({ message: 'Company context not found' });
    res.json({ context });
  } catch (err) {
    if (handleDuplicate(err, res)) return;
    console.error('PUT /api/company-contexts/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/company-contexts/:id
router.delete('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Company context not found' });
  }

  try {
    const context = await CompanyContextModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!context) return res.status(404).json({ message: 'Company context not found' });

    const inUseCount = await JobModel.countDocuments({
      companyContextId: context._id,
      entrepriseId: req.user._id,
    });
    if (inUseCount > 0) {
      return res.status(409).json({
        message: `Cannot delete: company context is in use by ${inUseCount} job${inUseCount === 1 ? '' : 's'}`,
        inUseCount,
      });
    }

    await CompanyContextModel.deleteOne({ _id: context._id });
    res.json({ message: 'Company context deleted' });
  } catch (err) {
    console.error('DELETE /api/company-contexts/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
