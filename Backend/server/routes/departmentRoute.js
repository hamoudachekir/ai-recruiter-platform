const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const DepartmentModel = require('../models/department');
const JobModel = require('../models/job');
const { verifyToken, requireEnterprise } = require('../middleware/auth');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleDuplicate = (err, res) => {
  if (err && err.code === 11000) {
    res.status(409).json({ message: 'A department with this name already exists' });
    return true;
  }
  return false;
};

const buildPayload = (body) => {
  const { name, description } = body || {};
  const payload = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return { __error: 'name must be a non-empty string' };
    }
    payload.name = name.trim();
  }

  if (description !== undefined) {
    if (description !== null && typeof description !== 'string') {
      return { __error: 'description must be a string' };
    }
    payload.description = typeof description === 'string' ? description.trim() : '';
  }

  return payload;
};

// GET /api/departments
router.get('/', verifyToken, requireEnterprise, async (req, res) => {
  try {
    const departments = await DepartmentModel
      .find({ entrepriseId: req.user._id })
      .sort({ name: 1 });
    res.json({ departments });
  } catch (err) {
    console.error('GET /api/departments error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/departments
router.post('/', verifyToken, requireEnterprise, async (req, res) => {
  const payload = buildPayload(req.body);
  if (payload.__error) return res.status(400).json({ message: payload.__error });
  if (!payload.name) return res.status(400).json({ message: 'name is required' });

  try {
    const department = await DepartmentModel.create({
      ...payload,
      entrepriseId: req.user._id,
    });
    res.status(201).json({ department });
  } catch (err) {
    if (handleDuplicate(err, res)) return;
    console.error('POST /api/departments error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/departments/:id
router.put('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Department not found' });
  }

  const payload = buildPayload(req.body);
  if (payload.__error) return res.status(400).json({ message: payload.__error });
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  try {
    const department = await DepartmentModel.findOneAndUpdate(
      { _id: req.params.id, entrepriseId: req.user._id },
      payload,
      { new: true, runValidators: true }
    );
    if (!department) return res.status(404).json({ message: 'Department not found' });
    res.json({ department });
  } catch (err) {
    if (handleDuplicate(err, res)) return;
    console.error('PUT /api/departments/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/departments/:id
router.delete('/:id', verifyToken, requireEnterprise, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Department not found' });
  }

  try {
    const dept = await DepartmentModel.findOne({
      _id: req.params.id,
      entrepriseId: req.user._id,
    });
    if (!dept) return res.status(404).json({ message: 'Department not found' });

    const inUseCount = await JobModel.countDocuments({
      departmentId: dept._id,
      entrepriseId: req.user._id,
    });
    if (inUseCount > 0) {
      return res.status(409).json({
        message: `Cannot delete: department is in use by ${inUseCount} job${inUseCount === 1 ? '' : 's'}`,
        inUseCount,
      });
    }

    await DepartmentModel.deleteOne({ _id: dept._id });
    res.json({ message: 'Department deleted' });
  } catch (err) {
    console.error('DELETE /api/departments/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
