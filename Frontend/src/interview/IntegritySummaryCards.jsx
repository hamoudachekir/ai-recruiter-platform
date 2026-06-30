import './IntegritySummaryCards.css';
import { summarizeByType } from './integrityEvents';

const toTitle = (value) => {
  const text = String(value || 'low').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Low';
};

const countEvents = (events, type) => (
  Array.isArray(events) ? events.filter((event) => event.type === type).length : 0
);

// Distinct incidents for a type (consecutive frames collapsed) — far more
// meaningful than raw frame counts, which just reflect the sampling rate.
const countIncidents = (incidentsByType, ...types) => (
  types.reduce((sum, type) => sum + (incidentsByType[type]?.incidents || 0), 0)
);

const sumDuration = (events, type) => (
  Array.isArray(events)
    ? events
        .filter((event) => event.type === type)
        .reduce((sum, event) => sum + Number(event.durationSeconds || 0), 0)
    : 0
);

const countYoloEvents = (events, type) => (
  Array.isArray(events)
    ? events.filter((event) => event.type === type && (event.source === 'yolov8' || event.source === 'opencv_paper' || !event.source)).length
    : 0
);

// Map a numeric/percentage value + thresholds → tone ("ok" | "warn" | "bad").
// Used to color the card header and the value.
const tone = (value, { ok, warn }) => {
  const n = Number(value || 0);
  if (warn !== undefined && n >= warn) return 'bad';
  if (ok !== undefined && n >= ok) return 'warn';
  return 'ok';
};

// Inverse direction (higher = better, e.g. face presence %).
const toneHigh = (value, { ok, warn }) => {
  const n = Number(value || 0);
  if (warn !== undefined && n < warn) return 'bad';
  if (ok !== undefined && n < ok) return 'warn';
  return 'ok';
};

const riskTone = (level) => {
  const v = String(level || '').toLowerCase();
  if (v === 'high' || v === 'critical') return 'bad';
  if (v === 'medium' || v === 'moderate') return 'warn';
  return 'ok';
};

export default function IntegritySummaryCards({ report, events = [] }) {
  const metrics = report?.metrics || {};
  const objectiveVisualSignals = report?.objectiveVisualSignals || {};
  const incidentsByType = summarizeByType(events);

  const riskLevel = report?.overallRiskLevel || report?.integrityRisk?.level || 'low';
  const riskScore = Number(report?.riskScore ?? report?.integrityRisk?.score ?? 0);
  const facePresence = Number(objectiveVisualSignals.facePresencePercentage ?? metrics.facePresencePercentage ?? 0);
  const lookingAway = Math.round(Number(objectiveVisualSignals.lookingAwayTotalSeconds ?? metrics.lookingAwayTotalSeconds ?? sumDuration(events, 'LOOKING_AWAY_LONG')));
  const noFace = Math.round(Number(metrics.noFaceTotalSeconds ?? sumDuration(events, 'NO_FACE') + sumDuration(events, 'NO_PERSON_VISIBLE')));
  // Distinct incidents, not raw flagged frames — a single person lingering on
  // camera produces dozens of frames but is one incident for the recruiter.
  const multiplePeople = countIncidents(incidentsByType, 'MULTIPLE_PEOPLE', 'MULTIPLE_FACES_DETECTED')
    || Number(objectiveVisualSignals.personCountIssues ?? metrics.multiplePersonEvents ?? 0);
  const tabSwitches = Number(metrics.tabSwitchCount ?? countEvents(events, 'TAB_SWITCH'));
  const fullscreenExits = Number(metrics.fullscreenExitCount ?? countEvents(events, 'FULLSCREEN_EXIT'));
  const phoneDetections = Number(objectiveVisualSignals.phoneDetections ?? metrics.phoneDetections ?? countYoloEvents(events, 'PHONE_VISIBLE'));
  const referenceMaterials = Number(objectiveVisualSignals.referenceMaterialDetections ?? metrics.bookDetections ?? countYoloEvents(events, 'REFERENCE_MATERIAL_VISIBLE'));
  const screenDevices = Number(objectiveVisualSignals.additionalScreenDetections ?? metrics.screenDetections ?? countYoloEvents(events, 'SCREEN_DEVICE_VISIBLE'));

  const overallTone = riskTone(riskLevel);

  const groups = [
    {
      key: 'identity',
      title: 'Identity & Presence',
      icon: '👤',
      cards: [
        { label: 'Face presence',  value: `${facePresence}%`, icon: '👁️', tone: toneHigh(facePresence, { ok: 90, warn: 70 }) },
        { label: 'Looking away',   value: `${lookingAway}s`, icon: '↗️', tone: tone(lookingAway, { ok: 10, warn: 30 }) },
        { label: 'No face',        value: `${noFace}s`, icon: '🚫', tone: tone(noFace, { ok: 5, warn: 20 }) },
        { label: 'Multiple people', value: multiplePeople, icon: '👥', tone: tone(multiplePeople, { ok: 1, warn: 3 }) },
      ],
    },
    {
      key: 'objects',
      title: 'Objects in Frame',
      icon: '📦',
      cards: [
        { label: 'Phone detections', value: phoneDetections, icon: '📱', tone: tone(phoneDetections, { ok: 1, warn: 5 }) },
        { label: 'Reference materials', value: referenceMaterials, icon: '📄', tone: tone(referenceMaterials, { ok: 1, warn: 3 }), hint: 'Includes paper, notebooks, books & documents' },
        { label: 'Screen devices', value: screenDevices, icon: '🖥️', tone: tone(screenDevices, { ok: 1, warn: 3 }) },
      ],
    },
    {
      key: 'system',
      title: 'Browser Activity',
      icon: '💻',
      cards: [
        { label: 'Tab switches', value: tabSwitches, icon: '🗂️', tone: tone(tabSwitches, { ok: 1, warn: 5 }) },
        { label: 'Fullscreen exits', value: fullscreenExits, icon: '↙️', tone: tone(fullscreenExits, { ok: 1, warn: 3 }) },
      ],
    },
  ];

  return (
    <div className="isc-root">
      {/* ── Headline risk pill ────────────────────────────────────────── */}
      <div className={`isc-headline isc-headline--${overallTone}`}>
        <div className="isc-headline__pulse" />
        <div className="isc-headline__body">
          <div className="isc-headline__label">Overall integrity risk</div>
          <div className="isc-headline__value">
            <span className="isc-headline__level">{toTitle(riskLevel)}</span>
            <span className="isc-headline__score">{riskScore}<small>/100</small></span>
          </div>
        </div>
        <div className={`isc-headline__bar isc-headline__bar--${overallTone}`}>
          <div className="isc-headline__bar-fill" style={{ width: `${Math.min(100, riskScore)}%` }} />
        </div>
      </div>

      {/* ── Grouped metric cards ─────────────────────────────────────── */}
      {groups.map((group) => (
        <section key={group.key} className="isc-group">
          <header className="isc-group__head">
            <span className="isc-group__icon">{group.icon}</span>
            <h4 className="isc-group__title">{group.title}</h4>
          </header>
          <div className="isc-grid">
            {group.cards.map((card) => (
              <div
                key={card.label}
                className={`isc-card isc-card--${card.tone}`}
                title={card.hint || ''}
              >
                <div className="isc-card__top">
                  <span className="isc-card__icon" aria-hidden="true">{card.icon}</span>
                  <span className="isc-card__label">{card.label}</span>
                </div>
                <div className="isc-card__value">{card.value}</div>
                {card.hint && <div className="isc-card__hint">{card.hint}</div>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
