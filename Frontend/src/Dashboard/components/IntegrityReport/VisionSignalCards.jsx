/**
 * Vision Signal Cards Component
 * 
 * Displays summary cards for objective visual signals detected during interview.
 * Does NOT show emotion or stress detection - only objective facts.
 */

import React from 'react';
import './VisionSignalCards.css';

const VisionSignalCards = ({ report = {}, events = [] }) => {
  const metrics = report?.metrics || {};
  const yoloSummary = report?.yoloSummary || {};
  const objectiveSignals = report?.objectiveVisualSignals || {};
  
  // Count YOLO events as fallback
  const yoloEventCounts = events.reduce((acc, event) => {
    if (event.source === 'yolov8' || event.type?.includes('VISIBLE') || event.type === 'MULTIPLE_PEOPLE') {
      acc[event.type] = (acc[event.type] || 0) + 1;
    }
    return acc;
  }, {});

  // Use objectiveVisualSignals from report if available, fall back to metrics/yoloSummary
  const facePresencePercentage = objectiveSignals.facePresencePercentage ?? metrics.facePresencePercentage ?? 0;
  const personCountIssues = objectiveSignals.personCountIssues ?? yoloSummary.personCountIssues ?? yoloEventCounts.MULTIPLE_PEOPLE ?? 0;
  const phoneDetections = objectiveSignals.phoneDetections ?? yoloSummary.phoneDetections ?? yoloEventCounts.PHONE_VISIBLE ?? 0;
  const referenceMaterialDetections = objectiveSignals.referenceMaterialDetections ?? yoloSummary.bookDetections ?? yoloEventCounts.REFERENCE_MATERIAL_VISIBLE ?? 0;
  const screenDetections = objectiveSignals.additionalScreenDetections ?? yoloSummary.screenDetections ?? yoloEventCounts.SCREEN_DEVICE_VISIBLE ?? 0;
  const lookingAwaySeconds = objectiveSignals.lookingAwayTotalSeconds ?? metrics.lookingAwayTotalSeconds ?? 0;

  const cards = [
    {
      title: 'Face Presence',
      value: `${facePresencePercentage}%`,
      subtitle: 'Time face was visible',
      type: facePresencePercentage >= 80 ? 'good' : facePresencePercentage >= 50 ? 'warning' : 'critical',
      icon: '👤',
    },
    {
      title: 'Person Count Issues',
      value: personCountIssues,
      subtitle: 'Multiple people detected',
      type: personCountIssues === 0 ? 'good' : 'critical',
      icon: '👥',
    },
    {
      title: 'Phone Detections',
      value: phoneDetections,
      subtitle: 'Phone-like objects',
      type: phoneDetections === 0 ? 'good' : 'warning',
      icon: '📱',
    },
    {
      title: 'Reference Materials',
      value: referenceMaterialDetections,
      subtitle: 'Books/documents detected',
      type: referenceMaterialDetections === 0 ? 'good' : 'info',
      icon: '📚',
    },
    {
      title: 'Extra Screens',
      value: screenDetections,
      subtitle: 'Additional monitors/devices',
      type: screenDetections === 0 ? 'good' : 'warning',
      icon: '🖥️',
    },
    {
      title: 'Looking Away',
      value: formatDuration(lookingAwaySeconds),
      subtitle: 'Time gaze was away',
      type: lookingAwaySeconds < 10 ? 'good' : lookingAwaySeconds < 30 ? 'warning' : 'info',
      icon: '👀',
    },
  ];

  return (
    <div className="vision-signal-cards">
      <h4 className="vision-signal-cards__title">Objective Visual Signals</h4>
      <p className="vision-signal-cards__disclaimer">
        These signals indicate moments that may require recruiter review. 
        They are not proof of misconduct.
      </p>
      <div className="vision-signal-cards__grid">
        {cards.map((card, index) => (
          <div key={index} className={`vision-card vision-card--${card.type}`}>
            <div className="vision-card__icon">{card.icon}</div>
            <div className="vision-card__content">
              <div className="vision-card__value">{card.value}</div>
              <div className="vision-card__title">{card.title}</div>
              <div className="vision-card__subtitle">{card.subtitle}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export default VisionSignalCards;
