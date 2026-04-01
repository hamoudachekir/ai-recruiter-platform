# Interview Scheduling Service

A Python/FastAPI microservice for automated interview scheduling integrated with the AI Recruiter Platform.

## Overview

This service handles the complete interview scheduling workflow after a candidate passes the quiz/preselection stage:

1. **Start Scheduling** - Generate recommended interview time slots
2. **Confirm Slot** - Candidate/recruiter confirms a proposed time
3. **Reschedule** - Change interview to a different time (Phase 2)
4. **Cancel** - Cancel scheduled interview (Phase 2)

## Architecture

### Phase 1 (Current)
- ✅ Scheduling schemas & validation
- ✅ MongoDB repositories for data persistence
- ✅ Recommendation engine for slot generation
- ✅ Orchestrator for workflow coordination
- ✅ FastAPI REST endpoints
- ✅ Email templates (Jinja2)
- ✅ Comprehensive logging

### Phase 2 (Future)
- ⏳ Google Calendar integration
- ⏳ Email sending (SMTP/SendGrid)
- ⏳ Meeting link generation
- ⏳ Rescheduling & cancellation flows
- ⏳ Frontend React components

## Project Structure

```
Backend/scheduling/
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI application entry point
│   ├── config.py               # Configuration management
│   ├── api/
│   │   ├── routes/
│   │   │   └── scheduling.py   # REST endpoints
│   ├── schemas/
│   │   └── scheduling.py       # Pydantic models
│   ├── repositories/
│   │   ├── interview_schedule_repository.py
│   │   └── schedule_log_repository.py
│   ├── services/
│   │   ├── recommendation_service.py  # Slot recommendation logic
│   │   └── scheduling_orchestrator.py # Workflow orchestration
│   └── templates/
│       ├── interview_invitation.html
│       ├── interview_rescheduled.html
│       └── interview_cancelled.html
├── main.py                     # Entry point
├── requirements.txt            # Python dependencies
├── .env.example                # Environment variables template
└── README.md                   # This file
```

## Setup & Installation

### 1. Prerequisites

- Python 3.9+
- MongoDB running (localhost:27017 by default)
- Node.js backend running (localhost:3001)

### 2. Create Virtual Environment

```bash
cd Backend/scheduling
python -m venv venv

# Activate (Linux/Mac)
source venv/bin/activate

# Activate (Windows)
venv\Scripts\activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure Environment

```bash
# Copy template
cp .env.example .env

# Edit .env with your settings (optional - defaults work for local development)
# Key variables:
# - MONGODB_URL: Your MongoDB connection string
# - NODE_BACKEND_URL: Your Node.js backend URL
# - Email settings (for Phase 2)
# - Google Calendar settings (for Phase 2)
```

### 5. Run the Service

```bash
# Development with auto-reload
python main.py

# Or using uvicorn directly
uvicorn app.main:app --reload --port 5004

# Production
uvicorn app.main:app --host 0.0.0.0 --port 5004
```

Service will be available at: `http://localhost:5004`

## API Endpoints

### Health Check
```
GET /health
```
Returns service status and database connection status.

### Documentation
```
GET /docs              # Interactive Swagger UI
GET /redoc             # ReDoc documentation
```

### Scheduling Endpoints

#### 1. Start Scheduling
```http
POST /api/scheduling/start

Body:
{
  "candidate_id": "candidate123",
  "recruiter_id": "recruiter456",
  "job_id": "job789",
  "application_id": "app001",
  "interview_type": "video",       # phone, video, in_person, assessment
  "interview_mode": "synchronous", # synchronous, asynchronous
  "duration_minutes": 60
}

Response (200):
{
  "interview_schedule_id": "schedule_id",
  "status": "suggested_slots_ready",
  "suggested_slots": [
    {
      "start_time": "2024-04-10T10:00:00",
      "end_time": "2024-04-10T11:00:00",
      "date": "2024-04-10",
      "time_start": "10:00:00",
      "time_end": "11:00:00",
      "score": 9.5
    },
    ...
  ],
  "recruiter_info": {...},
  "candidate_info": {...},
  "job_info": {...},
  "message": "Found 5 recommended interview slots"
}
```

#### 2. Confirm Slot
```http
POST /api/scheduling/confirm

Body:
{
  "interview_schedule_id": "schedule_id",
  "selected_slot": {
    "start_time": "2024-04-10T10:00:00",
    "end_time": "2024-04-10T11:00:00"
  },
  "location": "Room 401",  # Optional
  "notes": "Candidate prefers morning slots"  # Optional
}

Response (200):
{
  "interview_schedule_id": "schedule_id",
  "status": "confirmed",
  "calendar_event_id": "event123",  # Phase 2
  "meeting_link": "https://zoom.us/...",  # Phase 2
  "message": "Interview slot confirmed successfully"
}
```

#### 3. Get Schedule
```http
GET /api/scheduling/{interview_schedule_id}

Response (200):
{
  "id": "schedule_id",
  "candidate_id": "candidate123",
  "recruiter_id": "recruiter456",
  "job_id": "job789",
  "application_id": "app001",
  "interview_type": "video",
  "interview_mode": "synchronous",
  "duration_minutes": 60,
  "status": "confirmed",
  "email_status": "pending",
  "suggested_slots": [...],
  "confirmed_slot": {...},
  "calendar_event_id": null,
  "meeting_link": null,
  "location": "Room 401",
  "notes": "...",
  "created_at": "2024-04-09T...",
  "updated_at": "2024-04-09T..."
}
```

#### 4. Get Schedules by Candidate
```http
GET /api/scheduling/candidate/{candidate_id}

Response (200): Array of schedule objects
```

#### 5. Get Schedules by Recruiter
```http
GET /api/scheduling/recruiter/{recruiter_id}

Response (200): Array of schedule objects
```

#### 6. Reschedule (Phase 2)
```http
POST /api/scheduling/reschedule

Body:
{
  "interview_schedule_id": "schedule_id",
  "new_slot": {
    "start_time": "2024-04-11T14:00:00",
    "end_time": "2024-04-11T15:00:00"
  },
  "notes": "Moved due to recruiter unavailability"  # Optional
}
```

#### 7. Cancel (Phase 2)
```http
POST /api/scheduling/cancel

Body:
{
  "interview_schedule_id": "schedule_id",
  "reason": "Position filled"
}
```

## Database Schema

### Collections

#### interview_schedules
Stores interview scheduling information.

```javascript
{
  _id: ObjectId,
  candidate_id: String,
  recruiter_id: String,
  job_id: String,
  application_id: String,
  interview_type: String, // phone, video, in_person, assessment
  interview_mode: String, // synchronous, asynchronous
  duration_minutes: Number,
  status: String, // draft, suggested_slots_ready, confirmed, rescheduled, completed, cancelled
  email_status: String, // pending, sent, failed, bounced
  suggested_slots: [ // Array of recommended time slots
    {
      start_time: String (ISO),
      end_time: String (ISO),
      date: String (ISO date),
      time_start: String,
      time_end: String,
      score: Number // 1-10 recommendation score
    }
  ],
  confirmed_slot: { // Confirmed time slot
    start_time: String (ISO),
    end_time: String (ISO)
  },
  calendar_event_id: String, // Google Calendar event ID
  meeting_link: String, // Video conference link
  location: String, // Physical location or room
  notes: String,
  created_at: Date,
  updated_at: Date
}
```

#### schedule_logs
Audit trail for all scheduling actions.

```javascript
{
  _id: ObjectId,
  interview_schedule_id: String,
  action: String, // scheduling_started, slots_generated, slot_confirmed, etc.
  details: Object, // Action-specific details
  user_id: String, // Optional - who performed the action
  created_at: Date
}
```

## Recommendation Engine

The recommendation service generates interview time slots based on:

1. **Recruiter Availability** - Excludes busy times from calendar
2. **Working Hours** - Respects configured working hours (9-17 by default)
3. **Lunch Break** - Avoids lunch time (12-13 by default)
4. **Weekends** - Skips Saturday/Sunday
5. **Duration** - Generates slots for requested interview duration
6. **Scoring** - Recommends based on:
   - Proximity to today (closer = higher score)
   - Time of day (morning preferred)
   - Overall business logic score (1-10)

### Configuration

```python
working_hours_start = 9      # 09:00
working_hours_end = 17       # 17:00
lunch_start = 12             # 12:00
lunch_end = 13               # 13:00
scheduling_days_ahead = 7    # Look 7 days in advance
timezone = "UTC"
```

### Example Algorithm

1. Get recruiter busy slots (currently empty, Phase 2: from Google Calendar)
2. For each day in next 7 days (skip weekends):
   - For each 30-minute interval in working hours:
     - Check if slot avoids lunch break
     - Check if slot doesn't conflict with recruiter busy time
     - Calculate recommendation score
3. Sort by score descending
4. Return top 5 slots

## Integration with Node.js Backend

### Architecture
The scheduling service runs as a separate microservice. The Node.js backend can:

1. **Make requests** to the scheduling service when interview scheduling is needed
2. **Store references** to interview schedules in its application documents
3. **Listen for updates** via polling or webhooks (Phase 2)

### Integration Steps (Recommended)

#### 1. Add Route to Node Backend
```javascript
// Backend/server/routes/interviewSchedulingRoute.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL || 'http://localhost:5004';

// Proxy to scheduling service
router.post('/api/scheduling/start', async (req, res) => {
  try {
    const response = await axios.post(
      `${SCHEDULING_SERVICE_URL}/api/scheduling/start`,
      req.body
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: error.message
    });
  }
});

module.exports = router;
```

#### 2. Add to Existing Application Model
```javascript
// Backend/server/models/Application.js
const applicationSchema = new Schema({
  // ... existing fields ...
  interviewSchedule: {
    scheduleId: mongoose.Schema.Types.ObjectId,
    status: {
      type: String,
      enum: ["not_scheduled", "scheduling", "scheduled", "completed", "cancelled"],
      default: "not_scheduled"
    },
    suggestedSlots: Array,
    confirmedSlot: Object,
    createdAt: Date
  }
});
```

#### 3. Call from Recruiter Interface
```javascript
// When recruiter clicks "Schedule Interview"
const startScheduling = async (candidateId, recruiterId, jobId) => {
  const response = await axios.post('/api/scheduling/start', {
    candidate_id: candidateId,
    recruiter_id: recruiterId,
    job_id: jobId,
    application_id: applicationId,
    interview_type: 'video',
    interview_mode: 'synchronous',
    duration_minutes: 60
  });
  
  // Update UI with suggested slots
  setSuggestedSlots(response.data.suggested_slots);
};
```

## Environment Variables

All configuration is managed through environment variables (see `.env.example`):

```bash
# Service
SERVICE_PORT=5004
SERVICE_HOST=0.0.0.0
DEBUG=False

# MongoDB
MONGODB_URL=mongodb://localhost:27017
MONGODB_DATABASE=ai_recruiter_db

# Node Backend Integration
NODE_BACKEND_URL=http://localhost:3001

# Interview Configuration
INTERVIEW_DURATION_DEFAULT=60
WORKING_HOURS_START=9
WORKING_HOURS_END=17
LUNCH_START=12
LUNCH_END=13
SCHEDULING_DAYS_AHEAD=7
TIMEZONE_DEFAULT=UTC

# Phase 2: Google Calendar
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:5004/auth/google/callback

# Phase 2: Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
EMAIL_FROM=noreply@ai-recruiter.com

# Phase 2: Email (SendGrid Alternative)
SENDGRID_API_KEY=...
```

## Logging

Service provides comprehensive logging:

```
- scheduling_started: Workflow initiation
- slots_generated: Recommended slots created
- slot_confirmed: Time slot confirmed by recruiter/candidate
- calendar_event_created: Google Calendar event created (Phase 2)
- invitation_sent: Email sent to candidate (Phase 2)
- interview_rescheduled: Interview moved to new time (Phase 2)
- interview_cancelled: Interview cancelled (Phase 2)
- email_failed: Email delivery failed (Phase 2)
- calendar_error: Google Calendar API error (Phase 2)
```

All logs are stored in MongoDB `schedule_logs` collection for audit trail.

## Testing

### Using Swagger UI
1. Open: `http://localhost:5004/docs`
2. Expand endpoints and try them out directly

### Using cURL

```bash
# Health check
curl http://localhost:5004/health

# Start scheduling
curl -X POST http://localhost:5004/api/scheduling/start \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_id": "test123",
    "recruiter_id": "recruiter456",
    "job_id": "job789",
    "application_id": "app001",
    "interview_type": "video",
    "interview_mode": "synchronous",
    "duration_minutes": 60
  }'

# Get schedule
curl http://localhost:5004/api/scheduling/{schedule_id}
```

### Using Python
```python
import requests

response = requests.post(
    'http://localhost:5004/api/scheduling/start',
    json={
        'candidate_id': 'test123',
        'recruiter_id': 'recruiter456',
        'job_id': 'job789',
        'application_id': 'app001',
        'interview_type': 'video',
        'interview_mode': 'synchronous',
        'duration_minutes': 60
    }
)

print(response.json())
```

## Phase 2 - Implementation Roadmap

1. **Google Calendar Integration**
   - OAuth2 authentication for recruiters
   - Fetch recruiter busy time from calendar
   - Create interview events
   - Handle reschedule/cancellation of events

2. **Email Service**
   - SMTP or SendGrid integration
   - Send invitation emails using templates
   - Send rescheduling notifications
   - Send cancellation emails
   - Track email delivery status

3. **Meeting Link Generation**
   - Zoom, Google Meet, or Teams integration
   - Auto-generate conference links
   - Include in emails and calendar events

4. **Frontend React Components**
   - `<ScheduleInterviewButton />`
   - `<SuggestedSlotsModal />`
   - `<ConfirmInterviewForm />`
   - `<RescheduleInterviewForm />`
   - `<CancelInterviewForm />`
   - Interview status display

5. **Advanced Features**
   - Candidate availability preferences
   - Timezone handling
   - Interview panel scheduling
   - Waiting list and fallback slots
   - Automatic reminder emails
   - Calendar synchronization

## Troubleshooting

### MongoDB Connection Failed
```
Error: MongoDB connection failed
Solution: Ensure MongoDB is running and MONGODB_URL is correct
```

### Service won't start
```
Check logs for specific error
python main.py
```

### Routes not accessible
```
Ensure service is running on correct port
Check CORS settings if calling from browser
```

### Database operations fail
```
Check MongoDB is accessible
Verify collections exist or are auto-created
Check user permissions
```

## Performance Considerations

- Recommendation engine processes 7 days × 24 hours × 2 slots/hour = ~336 potential slots
- Typical query time: <100ms for 5 recommended slots
- Database queries are indexed on candidate_id, recruiter_id, job_id, status
- Logs are properly archived (90-day retention recommended)

## Security

- Input validation using Pydantic
- MongoDB injection prevention (using ODM)
- CORS properly configured
- Consider adding API authentication for Phase 2
- Environment variables for sensitive data
- Email addresses validated
- DateTime handling secure against timezone exploits

## Contributing

This is Phase 1 of interview scheduling. When contributing:

1. Maintain backward compatibility
2. Add tests for new functionality
3. Update documentation
4. Follow existing code patterns
5. Log significant operations

## License

Same as AI Recruiter Platform
