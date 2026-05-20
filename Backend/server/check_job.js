const mongoose = require('mongoose');
const VideoAnalysisJob = require('./models/VideoAnalysisJob');

mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/interview_system');

async function check() {
  const job = await VideoAnalysisJob.findOne({ 
    interviewId: 'room-1778581987634-a7ww3c2vz' 
  }).sort({ createdAt: -1 });
  
  if (job) {
    console.log('Status:', job.status);
    console.log('Progress:', job.progress);
    console.log('Current Step:', job.currentStep);
    console.log('Error:', JSON.stringify(job.error, null, 2));
  } else {
    console.log('No job found');
  }
  
  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
