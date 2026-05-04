const toTitle = (value) => {
  const text = String(value || 'low').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Low';
};

const countEvents = (events, type) => (
  Array.isArray(events) ? events.filter((event) => event.type === type).length : 0
);

const sumDuration = (events, type) => (
  Array.isArray(events)
    ? events
        .filter((event) => event.type === type)
        .reduce((sum, event) => sum + Number(event.durationSeconds || 0), 0)
    : 0
);

// Count YOLO events by source and type
const countYoloEvents = (events, type) => (
  Array.isArray(events)
    ? events.filter((event) => event.type === type && (event.source === 'yolov8' || !event.source)).length
    : 0
);

export default function IntegritySummaryCards({ report, events = [] }) {
  const metrics = report?.metrics || {};
  const objectiveVisualSignals = report?.objectiveVisualSignals || {};
  
  const cards = [
    {
      label: 'Overall risk',
      value: `${toTitle(report?.overallRiskLevel || report?.integrityRisk?.level)} (${Number(report?.riskScore ?? report?.integrityRisk?.score ?? 0)}/100)`,
    },
    {
      label: 'Face presence',
      value: `${Number(objectiveVisualSignals.facePresencePercentage ?? metrics.facePresencePercentage ?? 0)}%`,
    },
    {
      label: 'Looking away',
      value: `${Math.round(Number(objectiveVisualSignals.lookingAwayTotalSeconds ?? metrics.lookingAwayTotalSeconds ?? sumDuration(events, 'LOOKING_AWAY_LONG')))}s`,
    },
    {
      label: 'No face',
      value: `${Math.round(Number(metrics.noFaceTotalSeconds ?? sumDuration(events, 'NO_FACE') + sumDuration(events, 'NO_PERSON_VISIBLE')))}s`,
    },
    {
      label: 'Multiple people',
      value: Number(objectiveVisualSignals.personCountIssues ?? metrics.multiplePersonEvents ?? countEvents(events, 'MULTIPLE_PEOPLE') + countYoloEvents(events, 'MULTIPLE_PEOPLE')),
    },
    {
      label: 'Tab switches',
      value: Number(metrics.tabSwitchCount ?? countEvents(events, 'TAB_SWITCH')),
    },
    {
      label: 'Fullscreen exits',
      value: Number(metrics.fullscreenExitCount ?? countEvents(events, 'FULLSCREEN_EXIT')),
    },
    // YOLO Object Detection Cards
    {
      label: 'Phone detections',
      value: Number(objectiveVisualSignals.phoneDetections ?? metrics.phoneDetections ?? countYoloEvents(events, 'PHONE_VISIBLE')),
    },
    {
      label: 'Reference materials',
      value: Number(objectiveVisualSignals.referenceMaterialDetections ?? metrics.bookDetections ?? countYoloEvents(events, 'REFERENCE_MATERIAL_VISIBLE')),
    },
    {
      label: 'Screen devices',
      value: Number(objectiveVisualSignals.additionalScreenDetections ?? metrics.screenDetections ?? countYoloEvents(events, 'SCREEN_DEVICE_VISIBLE')),
    },
  ];

  return (
    <div className="rir-summary-grid">
      {cards.map((card) => (
        <div key={card.label} className="rir-summary-card">
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}
