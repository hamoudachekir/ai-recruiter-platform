// Helpers for turning raw per-frame vision events into meaningful, recruiter-facing
// signals. The vision pipeline emits ONE event per sampled frame, so a single
// real incident (e.g. a second person on screen for a minute) produces dozens of
// raw events. Showing those raw counts ("105 MULTIPLE PEOPLE") is misleading —
// we collapse consecutive frames of the same type into incidents and estimate
// their duration instead.

// Frames closer than this belong to the same incident. Kept wide because some
// signals (e.g. "no person visible") are only sampled once per minute, so a
// narrow window would shatter one continuous absence into dozens of "incidents".
const SAME_INCIDENT_GAP_MS = 90000;

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

const higherSeverity = (a, b) => (
  (SEVERITY_RANK[b] || 0) > (SEVERITY_RANK[a] || 0) ? b : a
);

// Estimate the frame sampling interval (seconds) from the median gap between
// consecutive events. Used so single-frame incidents get a sensible duration
// rather than 0s. Falls back to 2s when there isn't enough data.
const estimateSampleIntervalSeconds = (sorted) => {
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp);
    if (gap > 0 && gap < SAME_INCIDENT_GAP_MS) gaps.push(gap);
  }
  if (!gaps.length) return 2;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(5, Math.max(1, Math.round(median / 1000)));
};

// Collapse a sorted event list into incidents: runs of the same type where each
// frame is within SAME_INCIDENT_GAP_MS of the previous one.
export const groupIncidents = (events = []) => {
  const sorted = [...(Array.isArray(events) ? events : [])]
    .filter((e) => e && e.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (!sorted.length) return [];

  const intervalMs = estimateSampleIntervalSeconds(sorted) * 1000;
  const incidents = [];
  let current = null;

  sorted.forEach((event) => {
    const ts = new Date(event.timestamp).getTime();
    if (
      current
      && event.type === current.type
      && ts - new Date(current.endTime).getTime() < SAME_INCIDENT_GAP_MS
    ) {
      current.frames += 1;
      current.endTime = event.timestamp;
      current.severity = higherSeverity(current.severity, event.severity || 'low');
    } else {
      if (current) incidents.push(current);
      current = {
        type: event.type,
        startTime: event.timestamp,
        endTime: event.timestamp,
        frames: 1,
        severity: event.severity || 'low',
        questionId: event.questionId,
        evidence: event.evidence || event.message,
        durationSeconds: Number(event.durationSeconds || 0),
      };
    }
  });
  if (current) incidents.push(current);

  // Finalise duration. For multi-frame runs the elapsed span is the truthful
  // measure (a person away for 10 min should read ~10 min, not 2s per frame).
  // A single isolated frame falls back to its own durationSeconds or one sample.
  const intervalSeconds = Math.round(intervalMs / 1000);
  return incidents.map((incident) => {
    const spanSeconds = Math.round(
      (new Date(incident.endTime) - new Date(incident.startTime)) / 1000,
    );
    const duration = incident.frames > 1
      ? spanSeconds + intervalSeconds
      : Math.max(incident.durationSeconds, intervalSeconds);
    return { ...incident, durationSeconds: duration };
  });
};

// Per-type rollup keyed by event type: how many distinct incidents, how many raw
// frames, total flagged seconds, and the highest severity seen.
export const summarizeByType = (events = []) => {
  const incidents = groupIncidents(events);
  const summary = {};
  incidents.forEach((incident) => {
    const entry = summary[incident.type] || {
      type: incident.type,
      incidents: 0,
      frames: 0,
      totalSeconds: 0,
      highestSeverity: 'low',
      firstTime: incident.startTime,
      lastTime: incident.endTime,
    };
    entry.incidents += 1;
    entry.frames += incident.frames;
    entry.totalSeconds += incident.durationSeconds;
    entry.highestSeverity = higherSeverity(entry.highestSeverity, incident.severity);
    if (new Date(incident.startTime) < new Date(entry.firstTime)) entry.firstTime = incident.startTime;
    if (new Date(incident.endTime) > new Date(entry.lastTime)) entry.lastTime = incident.endTime;
    summary[incident.type] = entry;
  });
  return summary;
};

// Human-friendly duration, e.g. 8s, 2m 5s, 1h 3m.
export const formatDuration = (totalSeconds = 0) => {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
};
