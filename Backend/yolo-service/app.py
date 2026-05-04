"""
YOLOv8 Object Detection Service for AI Recruitment Platform

This service provides objective visual detection for interview monitoring:
- Person count detection
- Phone/device detection
- Reference material detection
- Screen/device detection

IMPORTANT SAFETY RULES:
- Does NOT detect emotion
- Does NOT infer stress, honesty, personality, mental state
- Does NOT identify race, gender, age, disability, or identity
- Only returns objective object/person facts
- Recruiter remains the final decision-maker
"""

import base64
import io
import os
import time
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field
from ultralytics import YOLO

# Configuration from environment
MODEL_NAME = os.getenv("YOLO_MODEL", "yolov8n.pt")
CONFIDENCE_THRESHOLD = float(os.getenv("YOLO_CONFIDENCE", "0.25"))
PHONE_CONFIDENCE = float(os.getenv("YOLO_PHONE_CONFIDENCE", "0.55"))
BOOK_CONFIDENCE = float(os.getenv("YOLO_BOOK_CONFIDENCE", "0.55"))
SCREEN_CONFIDENCE = float(os.getenv("YOLO_SCREEN_CONFIDENCE", "0.60"))
MAX_IMAGE_SIZE = int(os.getenv("YOLO_MAX_IMAGE_SIZE", "1920"))

# COCO class indices we care about
TARGET_CLASSES = {
    "person": 0,
    "cell phone": 67,
    "book": 73,
    "laptop": 63,
    "keyboard": 66,
    "mouse": 64,
    "tv": 62,
    "remote": 65,
}

# Reverse mapping for quick lookup
CLASS_ID_TO_NAME = {v: k for k, v in TARGET_CLASSES.items()}

app = FastAPI(
    title="YOLOv8 Vision Service",
    description="Objective object/person detection for interview monitoring. No emotion detection.",
    version="1.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model instance
model: Optional[YOLO] = None
model_load_time: Optional[float] = None


class Detection(BaseModel):
    label: str = Field(..., description="Detected object class name")
    confidence: float = Field(..., description="Detection confidence (0-1)", ge=0, le=1)
    bbox: List[float] = Field(..., description="Bounding box [x1, y1, x2, y2]")


class DetectionSummary(BaseModel):
    personCount: int = Field(0, description="Number of persons detected")
    phoneDetected: bool = Field(False, description="Phone-like object detected")
    bookDetected: bool = Field(False, description="Book/document-like object detected")
    laptopDetected: bool = Field(False, description="Laptop detected")
    keyboardDetected: bool = Field(False, description="Keyboard detected")
    mouseDetected: bool = Field(False, description="Mouse detected")
    tvDetected: bool = Field(False, description="TV/monitor detected")
    remoteDetected: bool = Field(False, description="Remote control detected")
    suspiciousObjectDetected: bool = Field(False, description="Any suspicious object detected")
    needsReview: bool = Field(False, description="Whether this frame needs recruiter review")


class DetectFrameRequest(BaseModel):
    interviewId: str = Field(..., description="Interview/call room identifier")
    candidateId: Optional[str] = Field(None, description="Candidate identifier")
    questionId: Optional[str] = Field(None, description="Current question identifier")
    frameBase64: str = Field(..., description="Base64-encoded JPEG image (data:image/jpeg;base64,...)")


class DetectFrameResponse(BaseModel):
    success: bool = Field(True, description="Whether detection succeeded")
    detections: List[Detection] = Field([], description="List of detections")
    summary: DetectionSummary = Field(..., description="Detection summary")
    processingTimeMs: float = Field(0, description="Processing time in milliseconds")
    error: Optional[str] = Field(None, description="Error message if failed")


class HealthResponse(BaseModel):
    status: str = Field("healthy", description="Service status")
    modelLoaded: bool = Field(False, description="Whether YOLO model is loaded")
    modelName: str = Field(MODEL_NAME, description="Model being used")
    modelLoadTime: Optional[float] = Field(None, description="Model load time in seconds")


def load_model():
    """Load YOLOv8 model on startup."""
    global model, model_load_time
    try:
        start_time = time.time()
        print(f"Loading YOLO model: {MODEL_NAME}...")
        model = YOLO(MODEL_NAME)
        model_load_time = time.time() - start_time
        print(f"YOLO model loaded in {model_load_time:.2f}s")
    except Exception as e:
        print(f"Failed to load YOLO model: {e}")
        raise


def decode_base64_image(frame_base64: str) -> np.ndarray:
    """Decode base64 image string to OpenCV image."""
    # Remove data URL prefix if present
    if "," in frame_base64:
        frame_base64 = frame_base64.split(",")[1]
    
    # Decode base64
    image_bytes = base64.b64decode(frame_base64)
    
    # Convert to numpy array
    nparr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if image is None:
        raise ValueError("Failed to decode image")
    
    # Resize if too large (to prevent memory issues)
    height, width = image.shape[:2]
    max_dim = max(height, width)
    if max_dim > MAX_IMAGE_SIZE:
        scale = MAX_IMAGE_SIZE / max_dim
        new_width = int(width * scale)
        new_height = int(height * scale)
        image = cv2.resize(image, (new_width, new_height))
    
    return image


def run_detection(image: np.ndarray) -> tuple[List[dict], DetectionSummary]:
    """Run YOLO detection on image and return detections + summary."""
    detections = []
    summary = DetectionSummary()
    
    if model is None:
        raise RuntimeError("YOLO model not loaded")
    
    # Run inference
    results = model(image, verbose=False)
    
    person_count = 0
    phone_detected = False
    book_detected = False
    laptop_detected = False
    keyboard_detected = False
    mouse_detected = False
    tv_detected = False
    remote_detected = False
    
    for result in results:
        if result.boxes is None:
            continue
        
        for box in result.boxes:
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            
            # Skip if not in our target classes
            if cls_id not in CLASS_ID_TO_NAME:
                continue
            
            class_name = CLASS_ID_TO_NAME[cls_id]
            
            # Get bounding box
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            bbox = [float(x1), float(y1), float(x2), float(y2)]
            
            detections.append({
                "label": class_name,
                "confidence": round(conf, 3),
                "bbox": bbox
            })
            
            # Update summary counts
            if class_name == "person":
                person_count += 1
            elif class_name == "cell phone" and conf >= PHONE_CONFIDENCE:
                phone_detected = True
            elif class_name == "book" and conf >= BOOK_CONFIDENCE:
                book_detected = True
            elif class_name == "laptop" and conf >= SCREEN_CONFIDENCE:
                laptop_detected = True
            elif class_name == "keyboard":
                keyboard_detected = True
            elif class_name == "mouse":
                mouse_detected = True
            elif class_name == "tv" and conf >= SCREEN_CONFIDENCE:
                tv_detected = True
            elif class_name == "remote":
                remote_detected = True
    
    # Build summary
    summary = DetectionSummary(
        personCount=person_count,
        phoneDetected=phone_detected,
        bookDetected=book_detected,
        laptopDetected=laptop_detected,
        keyboardDetected=keyboard_detected,
        mouseDetected=mouse_detected,
        tvDetected=tv_detected,
        remoteDetected=remote_detected,
        suspiciousObjectDetected=phone_detected or book_detected or laptop_detected or tv_detected,
        needsReview=person_count > 1 or phone_detected or book_detected or laptop_detected or tv_detected,
    )
    
    return detections, summary


@app.on_event("startup")
async def startup_event():
    """Load model on startup."""
    load_model()


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(
        status="healthy" if model is not None else "degraded",
        modelLoaded=model is not None,
        modelName=MODEL_NAME,
        modelLoadTime=model_load_time,
    )


@app.post("/detect-frame", response_model=DetectFrameResponse)
async def detect_frame(request: DetectFrameRequest):
    """
    Detect objects in a video frame.
    
    Returns objective detections only - no emotion, no stress inference.
    """
    start_time = time.time()
    
    try:
        # Decode image
        try:
            image = decode_base64_image(request.frameBase64)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid image data: {str(e)}"
            )
        
        # Run detection
        detections, summary = run_detection(image)
        
        processing_time = (time.time() - start_time) * 1000
        
        return DetectFrameResponse(
            success=True,
            detections=detections,
            summary=summary,
            processingTimeMs=round(processing_time, 2),
        )
    
    except HTTPException:
        raise
    except Exception as e:
        processing_time = (time.time() - start_time) * 1000
        return DetectFrameResponse(
            success=False,
            detections=[],
            summary=DetectionSummary(),
            processingTimeMs=round(processing_time, 2),
            error=str(e),
        )


@app.get("/")
async def root():
    """Root endpoint with service info."""
    return {
        "service": "YOLOv8 Vision Service",
        "version": "1.0.0",
        "purpose": "Objective object/person detection for interview monitoring",
        "safety": "Does NOT detect emotion, stress, or identity. Only objective visual facts.",
        "endpoints": {
            "health": "/health",
            "detect": "POST /detect-frame",
        },
        "model": MODEL_NAME,
        "modelLoaded": model is not None,
    }


if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("PORT", "8001"))
    host = os.getenv("HOST", "0.0.0.0")
    
    uvicorn.run(app, host=host, port=port)
