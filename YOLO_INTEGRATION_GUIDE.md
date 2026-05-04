# YOLOv8 Integration Guide

## Overview

This guide covers the YOLOv8 object detection integration for the AI Recruiter Platform's interview monitoring system. YOLO (You Only Look Once) provides objective visual detection of people and objects in the interview video feed.

## Safety & Ethics

**IMPORTANT**: This integration follows strict safety guidelines:

- Does **NOT** detect emotion (happy, sad, angry, stressed, nervous)
- Does **NOT** infer stress, honesty, personality, or mental state
- Does **NOT** identify race, gender, age, disability, or identity
- Only returns **objective object/person facts**
- The **recruiter remains the final decision-maker**

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│  Node Backend    │────▶│  YOLO Service   │
│  (React)        │     │  (Express)       │     │  (Python/FastAPI│
│                 │◄────│                  │◄────│  Ultralytics)   │
│ - MediaPipe     │     │ - yoloVisionService.js    │ - YOLOv8n       │
│ - useYoloVision │     │ - Routes         │     │ - Object Detect │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Files Created/Modified

### 1. Python YOLO Service

**Location**: `Backend/yolo-service/`

| File | Purpose |
|------|---------|
| `app.py` | FastAPI service with YOLOv8 inference |
| `requirements.txt` | Python dependencies |
| `README.md` | Service documentation |

**Endpoint**: `POST /detect-frame`

**Detected Classes**:
- `person` - Person count in frame
- `cell phone` - Mobile devices (confidence ≥ 0.55)
- `book` - Books/documents (confidence ≥ 0.55)
- `laptop` - Laptops (confidence ≥ 0.60)
- `keyboard` - External keyboards
- `mouse` - Computer mice
- `tv` - Monitors/TVs (confidence ≥ 0.60)
- `remote` - Remote controls

### 2. Node.js Backend Service

**Location**: `Backend/server/services/yoloVisionService.js`

**Functions**:
- `detectFrame()` - Send frame to YOLO service
- `checkHealth()` - Check YOLO service status
- `createIntegrityEvents()` - Convert YOLO results to integrity events

**Event Types Created**:
- `MULTIPLE_PEOPLE` - Multiple persons detected (+25 risk)
- `NO_PERSON_VISIBLE` - No person in frame (+12 risk)
- `PHONE_VISIBLE` - Phone detected (+15 risk)
- `REFERENCE_MATERIAL_VISIBLE` - Book detected (+8 risk)
- `SCREEN_DEVICE_VISIBLE` - Extra screen detected (+15 risk)

### 3. Backend Routes

**Location**: `Backend/server/routes/interviewRoute.js`

**New Routes**:
- `POST /api/interviews/:id/yolo-detect-frame` - Process frame for detection
- `GET /api/interviews/:id/yolo-health` - Check YOLO service health

### 4. Frontend Hook

**Location**: `Frontend/src/interview/hooks/useYoloVision.js`

**Features**:
- Captures video frames every 1500ms
- Sends to backend for YOLO detection
- Handles errors silently (no interview crash)
- Returns: `yoloEnabled`, `yoloStatus`, `latestYoloSummary`, `yoloError`

### 5. Updated VisionMonitor.jsx

**Location**: `Frontend/src/interview/VisionMonitor.jsx`

**Changes**:
- Added `useYoloVision` hook integration
- Added YOLO panel showing:
  - Person count status
  - Object detection status
  - YOLO service status
- New props: `candidateId`, `showYoloPanel`

### 6. Recruiter Dashboard Components

**Location**: `Frontend/src/Dashboard/components/IntegrityReport/`

| Component | Purpose |
|-----------|---------|
| `RecruiterIntegrityReport.jsx` | Main report view |
| `VisionSignalCards.jsx` | Objective visual signal cards |
| `EventTimeline.jsx` | Chronological event timeline |

**Report Sections**:
- Objective Visual Signals (face presence, phone detections, etc.)
- Interview Comfort Indicators (attention consistency, camera stability)
- Interview Pressure Indicator (experimental, based on objective signals only)
- Event Timeline (MediaPipe + YOLO events)

### 7. Updated Services

**Location**: `Backend/server/services/integrityReportService.js`

**Changes**:
- Added YOLO event weights to `SCORE_WEIGHTS`
- Updated `calculateIntegrityMetrics()` to include YOLO data
- Added YOLO findings to `buildFallbackReport()`

## Risk Scoring

### YOLO Event Weights

| Event | Weight | Severity |
|-------|--------|----------|
| MULTIPLE_PEOPLE | +25 | high |
| PHONE_VISIBLE | +15 | medium |
| SCREEN_DEVICE_VISIBLE | +15 | medium |
| NO_PERSON_VISIBLE | +12 | medium |
| REFERENCE_MATERIAL_VISIBLE | +8 | low |

### MediaPipe Event Weights (Existing)

| Event | Weight | Severity |
|-------|--------|----------|
| CAMERA_BLOCKED | +20 | high |
| MULTIPLE_FACES_DETECTED | +25 | high |
| NO_FACE_DETECTED | +15 | medium |
| LOOKING_AWAY_LONG | +10 | medium |
| TAB_SWITCH | +10 | medium |
| FULLSCREEN_EXIT | +10 | medium |
| POOR_LIGHTING | +5 | low |

**Maximum Score**: 100

## Configuration

### Environment Variables

Add to `.env` or `.env.local`:

```env
# YOLOv8 Vision Service
YOLO_ENABLED=true
YOLO_SERVICE_URL=http://localhost:8001/detect-frame
YOLO_FRAME_INTERVAL_MS=1500
YOLO_TIMEOUT_MS=3000
YOLO_CONFIDENCE=0.25
YOLO_PHONE_CONFIDENCE=0.55
YOLO_BOOK_CONFIDENCE=0.55
YOLO_SCREEN_CONFIDENCE=0.60
```

| Variable | Default | Description |
|----------|---------|-------------|
| `YOLO_ENABLED` | true | Enable/disable YOLO detection |
| `YOLO_SERVICE_URL` | http://localhost:8001/detect-frame | YOLO service endpoint |
| `YOLO_FRAME_INTERVAL_MS` | 1500 | Milliseconds between frame captures |
| `YOLO_TIMEOUT_MS` | 3000 | Request timeout in milliseconds |
| `YOLO_CONFIDENCE` | 0.25 | Minimum detection confidence |
| `YOLO_PHONE_CONFIDENCE` | 0.55 | Phone detection threshold |
| `YOLO_BOOK_CONFIDENCE` | 0.55 | Book detection threshold |
| `YOLO_SCREEN_CONFIDENCE` | 0.60 | Screen detection threshold |

## Installation & Setup

### 1. Install Python YOLO Service

```bash
cd Backend/yolo-service

# Create virtual environment
python -m venv venv

# Windows
venv\Scripts\activate

# macOS/Linux
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Start YOLO Service

```bash
# Development (with auto-reload)
uvicorn app:app --reload --host 0.0.0.0 --port 8001

# Production
uvicorn app:app --host 0.0.0.0 --port 8001
```

The YOLOv8n model will download automatically on first run (~6MB).

### 3. Start Node Backend

```bash
cd Backend/server
npm run dev
```

### 4. Start Frontend

```bash
cd Frontend
npm run dev
```

## Testing

### Test YOLO Service Health

```bash
curl http://localhost:8001/health
```

### Test Frame Detection

```bash
curl -X POST http://localhost:8001/detect-frame \
  -H "Content-Type: application/json" \
  -d '{
    "interviewId": "test-123",
    "candidateId": "candidate-456",
    "frameBase64": "data:image/jpeg;base64,/9j/4AAQ..."
  }'
```

### Test Backend Integration

```bash
curl -X POST http://localhost:3001/api/interviews/{interviewId}/yolo-detect-frame \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "frameBase64": "data:image/jpeg;base64,...",
    "questionId": "q1"
  }'
```

### Manual Test Steps

1. Start YOLO service (port 8001)
2. Start backend (port 3001)
3. Start frontend (port 5173)
4. Open interview call room
5. Check browser console for YOLO status
6. Check backend logs for detections
7. End interview and view recruiter report

## Error Handling

The system handles these errors gracefully:

- YOLO service offline → Continues with MediaPipe only
- YOLO model download fails → Returns fallback response
- Frame upload fails → Logs warning, continues monitoring
- Invalid base64 frame → Returns 400 error
- Backend route fails → Returns 500 with error message
- Camera permission denied → MediaPipe handles this

**Fallback Behavior**: If YOLO fails, the interview continues with MediaPipe monitoring only. The recruiter report will indicate "Object detection unavailable."

## Database Schema

YOLO data is stored in the CallRoom document:

```javascript
{
  visionMonitoring: {
    // Existing MediaPipe data
    summary: { ... },
    events: [ ... ],
    
    // New YOLO data
    yoloSummary: {
      totalFramesProcessed: Number,
      lastProcessedAt: Date,
      personCountIssues: Number,
      phoneDetections: Number,
      bookDetections: Number,
      screenDetections: Number
    }
  },
  integrityEvents: [
    {
      type: "PHONE_VISIBLE",
      source: "yolov8",
      severity: "medium",
      timestamp: Date,
      questionId: String,
      confidence: Number,
      evidence: String,
      detections: Array,
      needsRecruiterReview: Boolean
    }
  ]
}
```

## Why YOLO (Not Emotion Detection)

YOLOv8 was chosen for these reasons:

1. **Objective Detection**: Detects objects and people, not subjective states
2. **Open Source**: Free to use (Ultralytics AGPL-3.0)
3. **Fast**: YOLOv8n runs at 30+ FPS on CPU
4. **Local**: Can run entirely on-premises
5. **Proven**: Industry-standard for object detection
6. **Privacy-Respecting**: No facial recognition or identity inference

**What YOLO Does NOT Do**:
- Detect emotions (happy, sad, angry, stressed)
- Infer stress or anxiety levels
- Judge honesty or truthfulness
- Analyze personality traits
- Identify individuals by face
- Determine age, gender, race, or identity

## Troubleshooting

### YOLO Service Won't Start

1. Check Python version (3.8+ required)
2. Verify virtual environment is activated
3. Check port 8001 is not in use
4. Review error logs for missing dependencies

### Model Download Fails

1. Check internet connection
2. Download manually:
   ```bash
   wget https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt
   ```
3. Place in `Backend/yolo-service/` directory

### High Memory Usage

1. Reduce `YOLO_MAX_IMAGE_SIZE` in environment
2. Use smaller input frames from frontend
3. Consider YOLOv8n-p6 for better memory efficiency

### Slow Inference

1. Ensure YOLOv8n (nano) model is used
2. Reduce frame interval (e.g., 2000ms instead of 1500ms)
3. Consider GPU acceleration if available

## License

- YOLOv8: AGPL-3.0 (Ultralytics)
- This integration: Same as main project

Commercial use of YOLOv8 requires an Ultralytics Enterprise License.

## Support

For issues or questions:
1. Check YOLO service logs
2. Verify environment variables
3. Test with `curl` commands above
4. Review browser console for frontend errors
