# Integration Guide: Connecting Node.js Backend to Scheduling Service

This guide walks you through integrating the Interview Scheduling Service into your existing Node.js backend and recruiter interface.

---

## Architecture Overview

```
┌─────────────────────┐
│  Recruiter UI       │
│  (React Component)  │
└──────────┬──────────┘
           │ "Schedule Interview"
           ▼
┌─────────────────────────────┐
│  Node.js Backend            │
│  /api/interviews/...        │
│  (Proxy Routes)             │
└──────────┬──────────────────┘
           │ HTTP Call
           ▼
┌──────────────────────────────────┐
│  Scheduling Service (FastAPI)    │
│  POST /api/scheduling/start      │
│  POST /api/scheduling/confirm    │
└──────────┬───────────────────────┘
           │ Read/Write
           ▼
        MongoDB
```

---

## Step 1: Ensure Services Are Running

### Start Interview Scheduling Service

```bash
# Terminal 1
cd Backend/scheduling
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

Check: `curl http://localhost:5004/health`

### Verify Node Backend

```bash
# Terminal 2
cd Backend/server
npm start
```

Check: Service running on port 3001

### MongoDB

```bash
# Ensure MongoDB is running
mongod  # or docker run -d -p 27017:27017 mongo:6.0
```

---

## Step 2: Add Scheduling Routes to Node Backend

Create new file: `Backend/server/routes/schedulingProxy.js`

```javascript
/**
 * Proxy routes for Interview Scheduling Service
 * These routes forward requests to the FastAPI scheduling service
 */

const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');

const router = express.Router();

const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL || 'http://localhost:5004';

// Middleware to handle scheduling service errors
const handleSchedulingError = (res, error, context = '') => {
  console.error(`Scheduling Service Error (${context}):`, error.message);
  
  if (error.response) {
    return res.status(error.response.status).json({
      error: error.response.data.error || 'Scheduling service error',
      detail: error.response.data.detail || error.message,
      code: error.response.data.code
    });
  }
  
  res.status(503).json({
    error: 'Scheduling service unavailable',
    detail: error.message,
    code: 'SERVICE_UNAVAILABLE'
  });
};

/**
 * POST /api/interviews/schedule-start
 * Initiate interview scheduling workflow
 * 
 * Body:
 * {
 *   candidateId,
 *   recruiterId,
 *   jobId,
 *   applicationId,
 *   interviewType: (optional) 'video' | 'phone' | 'in_person'
 *   durationMinutes: (optional) default 60
 * }
 * 
 * Returns: Suggested time slots
 */
router.post('/schedule-start', auth, async (req, res) => {
  try {
    const {
      candidateId,
      recruiterId,
      jobId,
      applicationId,
      interviewType = 'video',
      durationMinutes = 60
    } = req.body;

    // Validate required fields
    if (!candidateId || !recruiterId || !jobId || !applicationId) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['candidateId', 'recruiterId', 'jobId', 'applicationId']
      });
    }

    console.log(`[Scheduling] Starting interview schedule for candidate ${candidateId}`);

    // Call scheduling service
    const response = await axios.post(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/start`,
      {
        candidate_id: candidateId,
        recruiter_id: recruiterId,
        job_id: jobId,
        application_id: applicationId,
        interview_type: interviewType,
        interview_mode: 'synchronous',
        duration_minutes: durationMinutes
      },
      { timeout: 10000 }
    );

    // Update Application model with schedule reference
    const ApplicationModel = require('../models/Application');
    await ApplicationModel.findByIdAndUpdate(
      applicationId,
      {
        'interviewSchedule.scheduleId': response.data.interview_schedule_id,
        'interviewSchedule.status': 'scheduling',
        'interviewSchedule.suggestedSlots': response.data.suggested_slots,
        'interviewSchedule.createdAt': new Date()
      },
      { new: true }
    );

    console.log(`[Scheduling] Generated ${response.data.suggested_slots.length} slots`);

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'schedule-start');
  }
});

/**
 * POST /api/interviews/schedule-confirm
 * Confirm a selected interview time slot
 * 
 * Body:
 * {
 *   interviewScheduleId,
 *   selectedSlot: {
 *     start_time: ISO string,
 *     end_time: ISO string
 *   },
 *   location: (optional) room/address,
 *   notes: (optional) internal notes
 * }
 * 
 * Returns: Confirmation details
 */
router.post('/schedule-confirm', auth, async (req, res) => {
  try {
    const {
      interviewScheduleId,
      selectedSlot,
      location,
      notes
    } = req.body;

    if (!interviewScheduleId || !selectedSlot) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['interviewScheduleId', 'selectedSlot']
      });
    }

    console.log(`[Scheduling] Confirming slot for schedule ${interviewScheduleId}`);

    // Call scheduling service
    const response = await axios.post(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/confirm`,
      {
        interview_schedule_id: interviewScheduleId,
        selected_slot: selectedSlot,
        location: location || '',
        notes: notes || ''
      },
      { timeout: 10000 }
    );

    // Update Application model
    const ApplicationModel = require('../models/Application');
    await ApplicationModel.findOneAndUpdate(
      { 'interviewSchedule.scheduleId': interviewScheduleId },
      {
        'interviewSchedule.status': 'confirmed',
        'interviewSchedule.confirmedSlot': selectedSlot,
        'interviewSchedule.updatedAt': new Date()
      },
      { new: true }
    );

    console.log(`[Scheduling] Confirmed slot: ${response.data.message}`);

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'schedule-confirm');
  }
});

/**
 * GET /api/interviews/schedule/:interviewScheduleId
 * Get details of a specific schedule
 * 
 * Returns: Complete schedule details
 */
router.get('/schedule/:interviewScheduleId', auth, async (req, res) => {
  try {
    const { interviewScheduleId } = req.params;

    const response = await axios.get(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/${interviewScheduleId}`,
      { timeout: 5000 }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'get-schedule');
  }
});

/**
 * GET /api/interviews/schedules/candidate/:candidateId
 * Get all schedules for a candidate
 * 
 * Returns: Array of schedules
 */
router.get('/schedules/candidate/:candidateId', auth, async (req, res) => {
  try {
    const { candidateId } = req.params;

    const response = await axios.get(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/candidate/${candidateId}`,
      { timeout: 5000 }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'get-candidate-schedules');
  }
});

/**
 * GET /api/interviews/schedules/recruiter/:recruiterId
 * Get all schedules for a recruiter
 * 
 * Returns: Array of schedules
 */
router.get('/schedules/recruiter/:recruiterId', auth, async (req, res) => {
  try {
    const { recruiterId } = req.params;

    const response = await axios.get(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/recruiter/${recruiterId}`,
      { timeout: 5000 }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'get-recruiter-schedules');
  }
});

/**
 * POST /api/interviews/schedule-reschedule
 * Reschedule an interview (Phase 2)
 * 
 * Body:
 * {
 *   interviewScheduleId,
 *   newSlot: { start_time, end_time },
 *   notes: (optional)
 * }
 */
router.post('/schedule-reschedule', auth, async (req, res) => {
  try {
    const { interviewScheduleId, newSlot, notes } = req.body;

    if (!interviewScheduleId || !newSlot) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['interviewScheduleId', 'newSlot']
      });
    }

    const response = await axios.post(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/reschedule`,
      {
        interview_schedule_id: interviewScheduleId,
        new_slot: newSlot,
        notes: notes || ''
      },
      { timeout: 10000 }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'schedule-reschedule');
  }
});

/**
 * POST /api/interviews/schedule-cancel
 * Cancel an interview (Phase 2)
 * 
 * Body:
 * {
 *   interviewScheduleId,
 *   reason
 * }
 */
router.post('/schedule-cancel', auth, async (req, res) => {
  try {
    const { interviewScheduleId, reason } = req.body;

    if (!interviewScheduleId || !reason) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['interviewScheduleId', 'reason']
      });
    }

    const response = await axios.post(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/cancel`,
      {
        interview_schedule_id: interviewScheduleId,
        reason
      },
      { timeout: 10000 }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    handleSchedulingError(res, error, 'schedule-cancel');
  }
});

module.exports = router;
```

---

## Step 3: Register Routes in Node Backend

In `Backend/server/index.js`, add these lines (typically after other route imports):

```javascript
// ... existing imports ...

const schedulingProxy = require('./routes/schedulingProxy');

// ... existing app setup ...

// Interview Scheduling routes
app.use('/api/interviews', schedulingProxy);

// ... rest of routes ...
```

---

## Step 4: Update Application Model

Add scheduling fields to `Backend/server/models/Application.js`:

```javascript
const applicationSchema = new Schema({
  // ... existing fields ...
  
  interviewSchedule: {
    scheduleId: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['not_scheduled', 'scheduling', 'scheduled', 'confirmed', 'completed', 'cancelled'],
      default: 'not_scheduled'
    },
    suggestedSlots: [
      {
        start_time: String,
        end_time: String,
        score: Number
      }
    ],
    confirmedSlot: {
      start_time: String,
      end_time: String,
      _id: false
    },
    location: String,
    notes: String,
    createdAt: {
      type: Date,
      default: null
    },
    updatedAt: {
      type: Date,
      default: null
    }
  }
});
```

---

## Step 5: Update Node .env

Add to `Backend/server/.env`:

```bash
# Interview Scheduling Service
SCHEDULING_SERVICE_URL=http://localhost:5004
SCHEDULING_SERVICE_TIMEOUT=10000
```

---

## Step 6: Create Frontend Component

Create `Frontend/src/components/ScheduleInterviewButton.jsx`:

```javascript
import React, { useState } from 'react';
import axios from 'axios';

const ScheduleInterviewButton = ({
  candidateId,
  recruiterId,
  jobId,
  applicationId,
  onSchedulingComplete
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleStartScheduling = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.post('/api/interviews/schedule-start', {
        candidateId,
        recruiterId,
        jobId,
        applicationId,
        interviewType: 'video',
        durationMinutes: 60
      });

      // Pass data to parent for modal display
      if (onSchedulingComplete) {
        onSchedulingComplete(response.data.data);
      }

    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start scheduling');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleStartScheduling}
        disabled={loading}
        className="btn btn-primary"
      >
        {loading ? 'Loading Slots...' : 'Schedule Interview'}
      </button>
      
      {error && (
        <div className="alert alert-danger mt-2">{error}</div>
      )}
    </div>
  );
};

export default ScheduleInterviewButton;
```

---

## Step 7: Display Suggested Slots

Create `Frontend/src/components/SuggestedSlotsModal.jsx`:

```javascript
import React, { useState } from 'react';
import axios from 'axios';

const SuggestedSlotsModal = ({ 
  scheduleId,
  suggestedSlots,
  recruiterName,
  candidateName,
  jobTitle,
  onConfirm
}) => {
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirmSlot = async () => {
    if (!selectedSlot) {
      setError('Please select a time slot');
      return;
    }

    setConfirming(true);
    setError(null);

    try {
      await axios.post('/api/interviews/schedule-confirm', {
        interviewScheduleId: scheduleId,
        selectedSlot,
        location,
        notes
      });

      alert('Interview scheduled successfully!');
      if (onConfirm) onConfirm();

    } catch (err) {
      setError(err.response?.data?.error || 'Failed to confirm slot');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="modal">
      <div className="modal-content">
        <h3>Select Interview Time</h3>
        
        <p>
          <strong>Candidate:</strong> {candidateName}<br/>
          <strong>Recruiter:</strong> {recruiterName}<br/>
          <strong>Position:</strong> {jobTitle}
        </p>

        <h5>Suggested Slots:</h5>
        
        {suggestedSlots.map((slot, index) => (
          <div key={index} className="slot-option">
            <input
              type="radio"
              name="slot"
              value={JSON.stringify(slot)}
              onChange={(e) => setSelectedSlot(JSON.parse(e.target.value))}
            />
            <label>
              {new Date(slot.start_time).toLocaleString()} - {new Date(slot.end_time).toLocaleTimeString()}
              {' '}
              <span className="badge badge-info">Score: {slot.score}/10</span>
            </label>
          </div>
        ))}

        <div className="form-group">
          <label>Location/Room (Optional):</label>
          <input
            type="text"
            className="form-control"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g., Room 401"
          />
        </div>

        <div className="form-group">
          <label>Notes (Optional):</label>
          <textarea
            className="form-control"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes about this interview..."
          />
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        <button
          onClick={handleConfirmSlot}
          disabled={confirming || !selectedSlot}
          className="btn btn-success"
        >
          {confirming ? 'Confirming...' : 'Confirm Interview'}
        </button>
      </div>
    </div>
  );
};

export default SuggestedSlotsModal;
```

---

## Step 8: Update Recruiter Dashboard

In your recruiter dashboard (e.g., `Frontend/src/pages/RecruiterDashboard.jsx`):

```javascript
import ScheduleInterviewButton from '../components/ScheduleInterviewButton';
import SuggestedSlotsModal from '../components/SuggestedSlotsModal';
import { useState } from 'react';

const RecruiterDashboard = () => {
  const [schedulingData, setSchedulingData] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const handleSchedulingComplete = (data) => {
    setSchedulingData(data);
    setShowModal(true);
  };

  return (
    <div className="recruiter-dashboard">
      {/* ... existing content ... */}
      
      {/* In candidate row */}
      <ScheduleInterviewButton
        candidateId={candidate._id}
        recruiterId={recruiter._id}
        jobId={job._id}
        applicationId={application._id}
        onSchedulingComplete={handleSchedulingComplete}
      />
      
      {/* Modal for slot selection */}
      {showModal && schedulingData && (
        <SuggestedSlotsModal
          scheduleId={schedulingData.interview_schedule_id}
          suggestedSlots={schedulingData.suggested_slots}
          recruiterName={recruiter.fullName}
          candidateName={candidate.fullName}
          jobTitle={job.title}
          onConfirm={() => {
            setShowModal(false);
            // Refresh candidate list or application details
          }}
        />
      )}
    </div>
  );
};

export default RecruiterDashboard;
```

---

## Step 9: Test the Integration

### Test via CLI

```bash
# 1. Ensure all services running
curl http://localhost:5004/health  # Scheduling service
curl http://localhost:3001/health  # Node backend (if you have this endpoint)

# 2. Call through Node backend
curl -X POST http://localhost:3001/api/interviews/schedule-start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "candidateId": "candidate123",
    "recruiterId": "recruiter456",
    "jobId": "job789",
    "applicationId": "app001"
  }'

# 3. Should get back suggested slots
```

### Test via UI

1. Navigate to recruiter dashboard
2. Find a candidate who passed the quiz
3. Click "Schedule Interview" button
4. Select a time slot from modal
5. Click "Confirm Interview"
6. Check MongoDB that data was saved to both interview_schedules and application

---

## Troubleshooting

### Connection Refused (5004)
```bash
# Check scheduling service is running
ps aux | grep main.py
# Or start it:
cd Backend/scheduling && python main.py
```

### MongoDB Error
```bash
# Check MongoDB is running
mongo admin --eval "db.adminCommand('ping')" || mongod
```

### CORS Error
```javascript
// The scheduling service CORS is already configured
// If calling from different origin, update app/main.py:
app.add_middleware(
    CORSMiddleware,
    allow_origins=["YOUR_FRONTEND_URL"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### Timeout (Service slow)
```javascript
// Increase timeout in schedulingProxy.js
{ timeout: 30000 }  // 30 seconds
```

---

## Environment Variables Checklist

```bash
# Backend/server/.env
SCHEDULING_SERVICE_URL=http://localhost:5004
SCHEDULING_SERVICE_TIMEOUT=10000

# Backend/scheduling/.env
SERVICE_PORT=5004
MONGODB_URL=mongodb://localhost:27017
NODE_BACKEND_URL=http://localhost:3001
WORKING_HOURS_START=9
WORKING_HOURS_END=17
DEBUG=false
```

---

## Next Steps (Phase 2)

Once basic integration works:

1. **Add Google Calendar** - Fetch recruiter actual availability
2. **Send Emails** - Notify candidates of scheduled interviews
3. **Generate Meeting Links** - Create Zoom/Meet links
4. **Reschedule/Cancel** - Use PUT and DELETE endpoints
5. **Advanced UI** - Show interview history, reschedule form, etc.

---

## Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/interviews/schedule-start` | POST | Generate slot suggestions |
| `/api/interviews/schedule-confirm` | POST | Confirm selected slot |
| `/api/interviews/schedule/{id}` | GET | Get schedule details |
| `/api/interviews/schedules/candidate/{id}` | GET | Candidate's interviews |
| `/api/interviews/schedules/recruiter/{id}` | GET | Recruiter's interviews |
| `/api/interviews/schedule-reschedule` | POST | Reschedule (Phase 2) |
| `/api/interviews/schedule-cancel` | POST | Cancel (Phase 2) |

---

**Done!** Your Node backend is now fully integrated with the Scheduling Service. 🎉

Proceed to Phase 2 when you're ready for Google Calendar and email integration.
