const formatType = (type) => String(type || '').replaceAll('_', ' ');

const formatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Deduplicate events by type + question combination, keeping first occurrence
const deduplicateEvents = (events) => {
  const seen = new Map();
  const counts = new Map();

  events.forEach((event) => {
    const key = `${event.type}-${event.questionId || 'general'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!seen.has(key)) {
      seen.set(key, { ...event, count: 1, key });
    }
  });

  return Array.from(seen.values()).map((event) => ({
    ...event,
    count: counts.get(event.key),
  }));
};

export default function FlaggedMoments({ events = [], recordingUrl = '', apiBase = '' }) {
  const flagged = (Array.isArray(events) ? events : []).filter(
    (event) => event.severity === 'medium' || event.severity === 'high' || event.snapshotUrl,
  );

  // Deduplicate to avoid showing the same event type for the same question multiple times
  const uniqueFlagged = deduplicateEvents(flagged);

  // Sort: snapshots first, then by severity (high > medium), then by time
  const sorted = uniqueFlagged.sort((a, b) => {
    if (a.snapshotUrl && !b.snapshotUrl) return -1;
    if (!a.snapshotUrl && b.snapshotUrl) return 1;
    if (a.severity === 'high' && b.severity !== 'high') return -1;
    if (a.severity !== 'high' && b.severity === 'high') return 1;
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });

  return (
    <div className="rir-section">
      <h4>Flagged Moments</h4>
      {recordingUrl && (
        <p className="rir-note">
          Recording is available for recruiter review. Use the event times as approximate pointers.
        </p>
      )}
      {!sorted.length ? (
        <p className="rir-empty-inline">No medium or high integrity signals were recorded.</p>
      ) : (
        <div className="rir-flag-grid">
          {sorted.slice(0, 12).map((event, index) => (
            <div key={`${event.type}-${event.timestamp}-${index}`} className="rir-flag-card">
              {event.snapshotUrl ? (
                <img
                  src={`${apiBase}${event.snapshotUrl}`}
                  alt="Flagged interview snapshot"
                  className="rir-flag-card__image"
                />
              ) : (
                <div className="rir-flag-card__placeholder">
                  <span>{event.count > 1 ? `×${event.count}` : '!'}</span>
                </div>
              )}
              <div className="rir-flag-card__body">
                <strong>{formatType(event.type)}</strong>
                <span className="rir-flag-time">{event.questionId || 'General'} • {formatTime(event.timestamp)}</span>
                <p>{event.llmAnalysis?.notes || event.evidence || 'Review this signal in context.'}</p>
              </div>
              <span className={`rir-flag-badge rir-flag-badge--${event.severity || 'low'}`}>
                {event.severity || 'low'}
              </span>
            </div>
          ))}
        </div>
      )}
      {sorted.length > 12 && (
        <p className="rir-more-events">+{sorted.length - 12} more unique flagged moments</p>
      )}
    </div>
  );
}
