const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'interview_system';

async function checkFailedJob() {
  const client = new MongoClient(MONGO_URL);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    
    const job = await db.collection('video_analysis_jobs').findOne(
      { interviewId: 'room-1778581987634-a7ww3c2vz' },
      { sort: { createdAt: -1 } }
    );
    
    if (job) {
      console.log('Job Status:', job.status);
      console.log('Progress:', job.progress);
      console.log('Current Step:', job.currentStep);
      console.log('Error:', JSON.stringify(job.error, null, 2));
      console.log('\nFull Job:', JSON.stringify(job, null, 2));
    } else {
      console.log('No job found for this interview');
    }
  } finally {
    await client.close();
  }
}

checkFailedJob().catch(console.error);
