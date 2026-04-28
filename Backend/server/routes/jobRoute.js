const express = require('express');
const router = express.Router();
const User = require('../models/user');
const JobModel = require('../models/job');
const axios = require('axios');

const refreshRecommendationIndex = async () => {
  try {
    await axios.post('http://127.0.0.1:5001/refresh-index', {}, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.warn('Recommendation index refresh skipped:', error.message);
  }
};

// POST /api/jobs/create
router.post('/jobs/create', async (req, res) => {
  try {
    const { title, description, location, salary, enterpriseId, skills, languages, requiredExperience } = req.body;

    // Validate enterprise
    const enterprise = await User.findById(enterpriseId);
    if (!enterprise || enterprise.role !== 'ENTERPRISE') {
      return res.status(400).json({ message: "Invalid enterprise" });
    }

    // Create job — include skills and languages so the recommendation engine can match
    const job = new JobModel({
      title,
      description,
      location,
      salary,
      entrepriseId: enterpriseId,
      skills: Array.isArray(skills) ? skills : [],
      languages: Array.isArray(languages) ? languages : [],
    });
    await job.save();

    // Update enterprise's jobsPosted
    enterprise.jobsPosted.push({
      jobId: job._id,
      title: job.title,
      status: "OPEN",
      createdDate: job.createdAt,
    });
    await enterprise.save();

    await refreshRecommendationIndex();

    res.status(201).json({ message: "Job created", job });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/jobs
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await JobModel.aggregate([
      {
        $match: {
          status: { $ne: 'CLOSED' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'entrepriseId',
          foreignField: '_id',
          as: 'enterprise'
        }
      },
      { $unwind: '$enterprise' },
      {
        $project: {
          title: 1,
          description: 1,
          location: 1,
          salary: 1,
          createdAt: 1,
          applicants: {
            $size: {
              $filter: {
                input: '$enterprise.applications',
                as: 'app',
                cond: { $eq: ['$$app.jobId', '$_id'] }
              }
            }
          },
          enterpriseName: '$enterprise.enterprise.name',
          industry: '$enterprise.enterprise.industry',
          location: '$enterprise.enterprise.location',
        }
      }
    ]);

    res.status(200).json(jobs);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/job/:id
router.get('/job/:id', async (req, res) => {
  try {
    const job = await JobModel.findById(req.params.id)
      .populate({
        path: 'entrepriseId',
        select: 'enterprise.name enterprise.industry enterprise.website enterprise.employeeCount'
      });

    if (!job) return res.status(404).json({ message: "Job not found" });

    res.json({
      title: job.title,
      description: job.description,
      location: job.location,
      salary: job.salary,
      createdAt: job.createdAt,
      enterpriseName: job.entrepriseId?.enterprise?.name || "Unknown",
      industry: job.entrepriseId?.enterprise?.industry || "Unknown",
      website: job.entrepriseId?.enterprise?.website || "N/A",
      employeeCount: job.entrepriseId?.enterprise?.employeeCount || 0,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/jobs/delete/:userId/:jobId
router.delete('/jobs/delete/:userId/:jobId', async (req, res) => {
  try {
    const { userId, jobId } = req.params;

    // Check ownership
    const user = await User.findById(userId);
    const job = await JobModel.findById(jobId);
    
    if (user._id.toString() !== job.entrepriseId.toString()) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { jobsPosted: { jobId: jobId } }
    });

    await JobModel.findByIdAndDelete(jobId);

    await refreshRecommendationIndex();

    res.json({ message: "Job deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/apply/:jobId/:userId
router.post('/apply/:jobId/:userId', async (req, res) => {
  try {
    const { jobId, userId } = req.params;
    const job = await JobModel.findById(jobId);
    
    if (!job) return res.status(404).json({ message: "Job not found" });

    const application = {
      jobId,
      enterpriseId: job.entrepriseId,
      ...req.body,
      dateSubmitted: new Date(),
    };

    await User.findByIdAndUpdate(userId, {
      $push: { applications: application }
    });

    res.status(201).json({ message: "Application submitted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;