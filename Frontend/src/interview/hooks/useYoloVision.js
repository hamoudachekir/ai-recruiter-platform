import { useEffect, useRef, useState, useCallback } from 'react';

const DEFAULT_FRAME_INTERVAL_MS = 1500;

/**
 * Hook for YOLOv8 object detection in video interviews
 * 
 * Captures frames from video and sends to backend for YOLO detection.
 * Does NOT detect emotion - only objective object/person facts.
 * 
 * @param {Object} options - Hook options
 * @param {boolean} options.active - Whether detection is active
 * @param {string} options.interviewId - Interview/call room ID
 * @param {string} options.candidateId - Candidate ID
 * @param {string} options.questionId - Current question ID
 * @param {string} options.token - Auth token
 * @param {string} options.apiBase - API base URL
 * @param {string} options.roomStatus - Room status ('waiting', 'active', 'ended')
 * @param {React.RefObject<HTMLVideoElement>} options.videoRef - Reference to video element
 */
const useYoloVision = ({
  active = false,
  interviewId,
  candidateId,
  questionId = '',
  token = '',
  apiBase = '',
  roomStatus = 'waiting',
  videoRef,
}) => {
  const [yoloEnabled, setYoloEnabled] = useState(false);
  const [yoloStatus, setYoloStatus] = useState('unknown'); // 'unknown' | 'available' | 'unavailable'
  const [latestYoloSummary, setLatestYoloSummary] = useState(null);
  const [yoloError, setYoloError] = useState(null);
  
  const timerRef = useRef(null);
  const isSendingRef = useRef(false);
  const frameCountRef = useRef(0);

  const isInterviewLive = roomStatus === 'active' || roomStatus === 'ended';

  /**
   * Capture current video frame as base64 JPEG
   */
  const captureFrame = useCallback(() => {
    const video = videoRef?.current;
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    try {
      // Scale down for network efficiency
      const maxWidth = 640;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      
      // Draw video frame
      ctx.drawImage(video, 0, 0, width, height);
      
      // Convert to base64 JPEG (quality 0.7 for balance)
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch (error) {
      console.warn('YOLO frame capture failed:', error);
      return null;
    }
  }, [videoRef]);

  /**
   * Send frame to backend for YOLO detection
   */
  const sendFrame = useCallback(async () => {
    if (!active || !interviewId || !token || !apiBase || isSendingRef.current) {
      return;
    }

    // Only send frames during active interview
    if (!isInterviewLive) {
      return;
    }

    const frameBase64 = captureFrame();
    if (!frameBase64) {
      return;
    }

    isSendingRef.current = true;
    frameCountRef.current += 1;

    try {
      const response = await fetch(`${apiBase}/api/interviews/${interviewId}/yolo-detect-frame`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          frameBase64,
          candidateId,
          questionId,
        }),
      });

      if (!response.ok) {
        // Silently handle errors - don't crash interview
        console.warn('YOLO detection request failed:', response.status);
        setYoloStatus('unavailable');
        return;
      }

      const result = await response.json();

      if (result.success) {
        setYoloEnabled(result.yoloEnabled ?? false);
        setYoloStatus(result.yoloAvailable ? 'available' : 'unavailable');
        setLatestYoloSummary(result.summary || null);
        setYoloError(result.error || null);
      } else {
        setYoloStatus('unavailable');
        setYoloError(result.message || 'Unknown error');
      }
    } catch (error) {
      // Silently handle errors - don't crash interview
      console.warn('YOLO detection error:', error.message);
      setYoloStatus('unavailable');
      setYoloError(error.message);
    } finally {
      isSendingRef.current = false;
    }
  }, [active, interviewId, candidateId, questionId, token, apiBase, isInterviewLive, captureFrame]);

  /**
   * Check YOLO service health on mount
   */
  useEffect(() => {
    if (!active || !interviewId || !token || !apiBase) {
      return;
    }

    const checkHealth = async () => {
      try {
        const response = await fetch(`${apiBase}/api/interviews/${interviewId}/yolo-health`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const result = await response.json();
          setYoloEnabled(result.enabled ?? false);
          setYoloStatus(result.available ? 'available' : 'unavailable');
        } else {
          setYoloStatus('unavailable');
        }
      } catch (error) {
        console.warn('YOLO health check failed:', error.message);
        setYoloStatus('unavailable');
      }
    };

    checkHealth();
  }, [active, interviewId, token, apiBase]);

  /**
   * Start frame capture interval
   */
  useEffect(() => {
    if (!active || !isInterviewLive) {
      return;
    }

    // Clear any existing timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    // Start new timer - send frame every interval
    timerRef.current = setInterval(() => {
      void sendFrame();
    }, DEFAULT_FRAME_INTERVAL_MS);

    // Send first frame immediately
    void sendFrame();

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, isInterviewLive, sendFrame]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return {
    yoloEnabled,
    yoloStatus, // 'unknown' | 'available' | 'unavailable'
    latestYoloSummary,
    yoloError,
    frameCount: frameCountRef.current,
  };
};

export default useYoloVision;
