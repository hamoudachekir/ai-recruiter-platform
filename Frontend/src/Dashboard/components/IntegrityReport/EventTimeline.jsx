/**
 * Event Timeline Component
 * 
 * Displays chronological timeline of integrity events.
 * Includes both MediaPipe and YOLO events.
 */

import React from 'react';
import './EventTimeline.css';

const SEVERITY_COLORS = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#3b82f6',
  info: '#64748b',
};

const EVENT_TYPE_LABELS = {
  // MediaPipe events
  'NO_FACE': 'No Face Detected',
  'NO_FACE_DETECTED': 'No Face Detected',
  'MULTIPLE_PEOPLE': 'Multiple People',
  'MULTIPLE_FACES_DETECTED': 'Multiple Faces',
  'LOOKING_AWAY_LONG': 'Looking Away',
  'BAD_LIGHTING': 'Poor Lighting',
  'POOR_LIGHTING': 'Poor Lighting',
  'CAMERA_BLOCKED': 'Camera Blocked',
  'TAB_SWITCH': 'Tab Switch',
  'FULLSCREEN_EXIT': 'Fullscreen Exit',
  'COPY_PASTE': 'Copy/Paste',
  'FACE_TOO_FAR': 'Face Too Far',
  'BAD_FACE_DISTANCE': 'Face Distance Issue',
  
  // YOLO events
  'PHONE_VISIBLE': 'Phone Detected',
  'REFERENCE_MATERIAL_VISIBLE': 'Reference Material',
  'SCREEN_DEVICE_VISIBLE': 'Extra Screen',
  'NO_PERSON_VISIBLE': 'No Person',
};

const SOURCE_ICONS = {
  yolov8: '🎯',
  mediapipe: '👁️',
  browser: '🌐',
  default: '📋',
};

const formatTimestamp = (timestamp) => {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

const EventTimeline = ({ events = [], maxItems = 50 }) => {
  // Sort events by timestamp (newest first)
  const sortedEvents = [...events]
    .filter(e => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, maxItems);

  if (sortedEvents.length === 0) {
    return (
      <div className="event-timeline">
        <h4 className="event-timeline__title">Event Timeline</h4>
        <div className="event-timeline__empty">
          No integrity events recorded during this interview.
        </div>
      </div>
    );
  }

  return (
    <div className="event-timeline">
      <h4 className="event-timeline__title">Event Timeline</h4>
      <p className="event-timeline__disclaimer">
        Showing {sortedEvents.length} event{sortedEvents.length !== 1 ? 's' : ''}. 
        Review flagged moments in context.
      </p>
      
      <div className="event-timeline__list">
        {sortedEvents.map((event, index) => {
          const severity = event.severity || 'info';
          const type = event.type || 'UNKNOWN';
          const label = EVENT_TYPE_LABELS[type] || type.replace(/_/g, ' ');
          const source = event.source || 'default';
          const icon = SOURCE_ICONS[source] || SOURCE_ICONS.default;
          
          return (
            <div 
              key={index} 
              className={`event-item event-item--${severity}`}
              style={{ borderLeftColor: SEVERITY_COLORS[severity] || SEVERITY_COLORS.info }}
            >
              <div className="event-item__header">
                <span className="event-item__icon">{icon}</span>
                <span className="event-item__time">{formatTimestamp(event.timestamp)}</span>
                <span 
                  className="event-item__severity"
                  style={{ color: SEVERITY_COLORS[severity] || SEVERITY_COLORS.info }}
                >
                  {severity.toUpperCase()}
                </span>
              </div>
              
              <div className="event-item__body">
                <div className="event-item__type">{label}</div>
                {event.questionId && (
                  <div className="event-item__question">{event.questionId}</div>
                )}
                {event.evidence && (
                  <div className="event-item__evidence">{event.evidence}</div>
                )}
                {event.durationSeconds > 0 && (
                  <div className="event-item__duration">
                    Duration: {formatDuration(event.durationSeconds)}
                  </div>
                )}
                {event.confidence > 0 && (
                  <div className="event-item__confidence">
                    Confidence: {Math.round(event.confidence * 100)}%
                  </div>
                )}
              </div>
              
              {event.detections && event.detections.length > 0 && (
                <div className="event-item__detections">
                  {event.detections.map((det, i) => (
                    <span key={i} className="event-item__detection">
                      {det.label} ({Math.round(det.confidence * 100)}%)
                    </span>
                  ))}
                </div>
              )}
              
              {event.snapshotUrl && (
                <div className="event-item__snapshot">
                  <a 
                    href={event.snapshotUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="event-item__snapshot-link"
                  >
                    View Snapshot
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EventTimeline;
