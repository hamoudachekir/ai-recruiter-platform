# YOLOv8 Vision Service

A FastAPI-based microservice for objective object and person detection in interview monitoring.

## Purpose

This service provides **objective visual indicators** for the AI Recruiter Platform's interview integrity monitoring:

- **Person count detection** - Detects how many people are in frame
- **Phone/device detection** - Identifies cell phones in the camera view
- **Reference material detection** - Detects books and documents
- **Screen/device detection** - Identifies laptops, monitors, TVs

## Safety & Ethics

**IMPORTANT**: This service follows strict safety guidelines:

- Does **NOT** detect emotion (happy, sad, angry, stressed, nervous)
- Does **NOT** infer stress, honesty, personality, or mental state
- Does **NOT** identify race, gender, age, disability, or identity
- Only returns **objective object/person facts**
- The **recruiter remains the final decision-maker**

## Setup

### 1. Create Virtual Environment

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS/Linux
python -m venv venv
source venv/bin/activate
```

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

The Ultralytics YOLOv8 model will be automatically downloaded on first run.

### 3. Run the Service

```bash
# Development
uvicorn app:app --reload --host 0.0.0.0 --port 8001

# Production
uvicorn app:app --host 0.0.0.0 --port 8001
```

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8001 | Server port |
| `HOST` | 0.0.0.0 | Server host |
| `YOLO_MODEL` | yolov8n.pt | Model file (nano is fastest) |
| `YOLO_CONFIDENCE` | 0.25 | Minimum detection confidence |
| `YOLO_PHONE_CONFIDENCE` | 0.55 | Phone detection threshold |
| `YOLO_BOOK_CONFIDENCE` | 0.55 | Book detection threshold |
| `YOLO_SCREEN_CONFIDENCE` | 0.60 | Screen detection threshold |
| `YOLO_MAX_IMAGE_SIZE` | 1920 | Max image dimension (resizes if larger) |

## API Endpoints

### Health Check
```bash
GET /health
```

### Detect Objects in Frame
```bash
POST /detect-frame
Content-Type: application/json

{
  "interviewId": "room-123",
  "candidateId": "candidate-456",
  "questionId": "question-1",
  "frameBase64": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

**Response:**
```json
{
  "success": true,
  "detections": [
    {
      "label": "person",
      "confidence": 0.91,
      "bbox": [100.5, 200.3, 400.7, 600.2]
    }
  ],
  "summary": {
    "personCount": 1,
    "phoneDetected": false,
    "bookDetected": false,
    "laptopDetected": false,
    "keyboardDetected": false,
    "mouseDetected": false,
    "tvDetected": false,
    "remoteDetected": false,
    "suspiciousObjectDetected": false,
    "needsReview": false
  },
  "processingTimeMs": 45.23
}
```

## Detected Classes

The service detects these COCO classes:

- `person` - Number of people in frame
- `cell phone` - Mobile phones (confidence ≥ 0.55)
- `book` - Books and documents (confidence ≥ 0.55)
- `laptop` - Laptops (confidence ≥ 0.60)
- `keyboard` - External keyboards
- `mouse` - Computer mice
- `tv` - Monitors and TVs (confidence ≥ 0.60)
- `remote` - Remote controls

## Model Information

- **Model**: YOLOv8n (nano) - fastest variant
- **Framework**: Ultralytics
- **Dataset**: COCO (Common Objects in Context)
- **Input**: Base64-encoded JPEG images
- **Output**: Object detections with bounding boxes and confidence scores

## Integration

This service is designed to be called by the Node.js backend:

1. Frontend captures video frame
2. Backend receives frame and forwards to YOLO service
3. YOLO service returns detections
4. Backend creates integrity events from detections
5. Events are stored for recruiter review

## Testing

```bash
# Test health endpoint
curl http://localhost:8001/health

# Test detection (with a test image)
curl -X POST http://localhost:8001/detect-frame \
  -H "Content-Type: application/json" \
  -d '{
    "interviewId": "test-123",
    "candidateId": "candidate-456",
    "frameBase64": "data:image/jpeg;base64,/9j/4AAQ..."
  }'
```

## Troubleshooting

**Model download fails**: The model downloads automatically from Ultralytics on first run. If behind a firewall, you may need to download manually:
```bash
wget https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt
```

**High memory usage**: Reduce `YOLO_MAX_IMAGE_SIZE` to downscale large images before processing.

**Slow inference**: YOLOv8n (nano) is the fastest. For even faster inference, consider YOLOv8n-p6 or using a GPU.

## License

This service uses Ultralytics YOLOv8 (AGPL-3.0 license). Commercial use requires Ultralytics license.
