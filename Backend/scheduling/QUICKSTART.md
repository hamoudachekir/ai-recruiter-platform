# Quick Start Guide - Interview Scheduling Service

> This is Phase 1 of the Interview Scheduling module. Quick setup instructions for local development.

## Prerequisites

- Python 3.9+
- MongoDB (running locally or via Docker)
- Node.js backend (running on port 3001)

## Option 1: Quick Local Setup (5 minutes)

### 1. Navigate to scheduling directory
```bash
cd Backend/scheduling
```

### 2. Create virtual environment
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or
venv\Scripts\activate     # Windows
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Run the service
```bash
python main.py
```

Service will start on: **http://localhost:5004**

Check health: `curl http://localhost:5004/health`

## Option 2: Using Docker Compose (10 minutes)

### 1. From project root
```bash
cd Backend/scheduling
docker-compose up --build
```

This starts:
- Interview Scheduling Service on port 5004
- MongoDB on port 27017

### 2. Check if running
```bash
curl http://localhost:5004/health
```

## Testing the Service

### 1. Open Interactive API Docs
```
http://localhost:5004/docs
```

### 2. Try "Start Scheduling" Endpoint
Click on `POST /api/scheduling/start` and execute:

```json
{
  "candidate_id": "cand123",
  "recruiter_id": "rec456",
  "job_id": "job789",
  "application_id": "app001",
  "interview_type": "video",
  "interview_mode": "synchronous",
  "duration_minutes": 60
}
```

Expected response:
```json
{
  "interview_schedule_id": "...",
  "status": "suggested_slots_ready",
  "suggested_slots": [
    {
      "start_time": "2024-04-10T10:00:00",
      "end_time": "2024-04-10T11:00:00",
      "score": 9.5
    },
    ...
  ],
  "message": "Found 5 recommended interview slots"
}
```

### 3. Confirm a Slot
Use the `interview_schedule_id` from step 2:

```bash
curl -X POST http://localhost:5004/api/scheduling/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "interview_schedule_id": "<schedule_id_from_step_2>",
    "selected_slot": {
      "start_time": "2024-04-10T10:00:00",
      "end_time": "2024-04-10T11:00:00"
    },
    "location": "Room 401",
    "notes": "Candidate available anytime"
  }'
```

### 4. Retrieve Schedule
```bash
curl http://localhost:5004/api/scheduling/<schedule_id>
```

## Integrate with Node Backend

### Option A: Direct HTTPS Calls (Recommended for Phase 1)

In your Node.js backend (`Backend/server/index.js` or routes):

```javascript
const axios = require('axios');

const SCHEDULING_SERVICE = 'http://localhost:5004';

// When recruiter clicks "Schedule Interview"
app.post('/api/scheduling/initialize', async (req, res) => {
  try {
    const response = await axios.post(
      `${SCHEDULING_SERVICE}/api/scheduling/start`,
      {
        candidate_id: req.body.candidateId,
        recruiter_id: req.body.recruiterId,
        job_id: req.body.jobId,
        application_id: req.body.applicationId,
        interview_type: 'video',
        interview_mode: 'synchronous',
        duration_minutes: 60
      }
    );
    
    // Save schedule reference in application
    const application = await ApplicationModel.findByIdAndUpdate(
      req.body.applicationId,
      {
        'interviewSchedule.scheduleId': response.data.interview_schedule_id,
        'interviewSchedule.status': 'scheduling'
      },
      { new: true }
    );
    
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Option B: Create Proxy Route (Alternative)

Create a new route file: `Backend/server/routes/schedulingProxy.js`

```javascript
const express = require('express');
const axios = require('axios');
const router = express.Router();

const API_URL = process.env.SCHEDULING_SERVICE_URL || 'http://localhost:5004';

// Proxy all scheduling requests
router.post('/start', async (req, res) => {
  try {
    const response = await axios.post(`${API_URL}/api/scheduling/start`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

router.post('/confirm', async (req, res) => {
  try {
    const response = await axios.post(`${API_URL}/api/scheduling/confirm`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

module.exports = router;
```

Then in `Backend/server/index.js`:
```javascript
const schedulingProxy = require('./routes/schedulingProxy');
app.use('/api/scheduling', schedulingProxy);
```

## Environment Configuration

If not using defaults, create `.env` in `Backend/scheduling/`:

```bash
SERVICE_PORT=5004
MONGODB_URL=mongodb://localhost:27017
MONGODB_DATABASE=ai_recruiter_db
NODE_BACKEND_URL=http://localhost:3001
WORKING_HOURS_START=9
WORKING_HOURS_END=17
DEBUG=False
```

## Common Issues

### MongoDB Connection Error
```
Solution: Make sure MongoDB is running
docker run -d -p 27017:27017 --name mongo mongo:6.0
```

### Service already in use
```
Solution: Change port in .env or kill existing process
lsof -i :5004  # Find process
kill -9 <PID>  # Kill it
```

### CORS Issues
```
Solution: Service is configured for localhost development
Add your frontend URL to app.py CORS list if needed
```

## Next Steps

### For Phase 1 Testing
1. ✅ Service runs and generates slots
2. ✅ Endpoints respond correctly
3. ✅ Data persists in MongoDB
4. ✅ Logs are created

### For Phase 2 (Future)
- [ ] Integrate Google Calendar
- [ ] Send emails via SMTP/SendGrid
- [ ] Generate meeting links
- [ ] Implement reschedule/cancel
- [ ] Create React UI components

## Documentation

Full documentation: [README.md](./README.md)

API Reference: [http://localhost:5004/docs](http://localhost:5004/docs)

## Architecture Diagram

```
┌──────────────────┐
│  Frontend React  │
└────────┬─────────┘
         │ HTTP Requests
         ▼
┌──────────────────────────┐
│  Node.js Backend (3001)  │
│  Express + MongoDB       │
└────────┬─────────────────┘
         │ Calls
         ▼
┌──────────────────────────────────┐
│ Interview Scheduling Service     │ ← YOU ARE HERE
│ FastAPI (5004)                   │
│ ├─ Recommendation Engine         │
│ ├─ Orchestrator                  │
│ ├─ MongoDB Repositories          │
│ └─ Email Templates (Phase 2)     │
└────────┬─────────────────────────┘
         │ Reads/Writes
         ▼
┌──────────────────┐
│  MongoDB         │
│  (ai_recruiter)  │
└──────────────────┘
```

## Stopping the Service

**Local:**
```bash
Ctrl+C  # Stop Python process
```

**Docker:**
```bash
docker-compose down
# To also remove data:
docker-compose down -v
```

## Need Help?

1. Check logs: `docker logs interview-scheduling-service`
2. Health endpoint: `http://localhost:5004/health`
3. Full docs: Open `/docs` in browser
4. See README.md for detailed documentation

---

**Ready for Phase 2?** See the roadmap in README.md for Google Calendar and email integration.
