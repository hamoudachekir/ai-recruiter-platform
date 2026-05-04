const formatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatType = (type) => String(type || '').replaceAll('_', ' ');

const getEventPriority = (type) => {
  const priorities = {
    'TAB_SWITCH': 1,
    'PHONE_VISIBLE': 2,
    'REFERENCE_MATERIAL_VISIBLE': 3,
    'SCREEN_DEVICE_VISIBLE': 4,
    'MULTIPLE_PEOPLE': 5,
    'NO_PERSON_VISIBLE': 6,
    'NO_FACE': 7,
  };
  return priorities[type] || 99;
};

// Group consecutive similar events and count them
const groupEvents = (events) => {
  if (!events.length) return [];

  const groups = [];
  let currentGroup = { ...events[0], count: 1, endTime: events[0].timestamp };

  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    const prevEvent = events[i - 1];
    const timeDiff = new Date(event.timestamp) - new Date(prevEvent.timestamp);
    const isSameType = event.type === currentGroup.type;
    const isWithinTimeWindow = timeDiff < 30000; // 30 seconds

    if (isSameType && isWithinTimeWindow) {
      currentGroup.count++;
      currentGroup.endTime = event.timestamp;
    } else {
      groups.push(currentGroup);
      currentGroup = { ...event, count: 1, endTime: event.timestamp };
    }
  }
  groups.push(currentGroup);

  return groups;
};

export default function EventTimeline({ events = [] }) {
  const sorted = [...(Array.isArray(events) ? events : [])].sort(
    (a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0),
  );

  if (!sorted.length) {
    return (
      <div className="rir-section">
        <h4>Event Timeline</h4>
        <p className="rir-empty-inline">No integrity signals were detected during this interview.</p>
      </div>
    );
  }

  // Group events to reduce clutter
  const grouped = groupEvents(sorted);

  // Count by type for summary
  const typeCounts = sorted.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  }, {});

  const uniqueTypes = Object.keys(typeCounts).sort((a, b) => getEventPriority(a) - getEventPriority(b));

  return (
    <div className="rir-section">
      <h4>Event Summary</h4>

      {/* Summary Cards */}
      <div className="rir-event-summary">
        {uniqueTypes.map((type) => (
          <div key={type} className="rir-event-summary__item">
            <span className="rir-event-summary__count">{typeCounts[type]}</span>
            <span className="rir-event-summary__label">{formatType(type)}</span>
          </div>
        ))}
      </div>

      {/* Grouped Timeline - only first occurrence of each group */}
      <div className="rir-event-list rir-event-list--condensed">
        {grouped.slice(0, 20).map((event, index) => (
          <div key={`${event.type}-${event.timestamp}-${index}`} className="rir-event-item">
            <div>
              <span className="rir-event-type">{formatType(event.type)}</span>
              {event.count > 1 && (
                <span className="rir-event-count">×{event.count}</span>
              )}
              <p>{event.evidence || event.message || 'Integrity signal recorded for recruiter review.'}</p>
            </div>
            <div className="rir-event-meta">
              <span className={`rir-severity rir-severity--${event.severity || 'low'}`}>
                {event.severity || 'low'}
              </span>
              <span>{formatTime(event.timestamp)}</span>
              {event.count > 1 && (
                <span className="rir-duration">~{Math.round((new Date(event.endTime) - new Date(event.timestamp)) / 1000)}s</span>
              )}
              {Number(event.durationSeconds || 0) > 0 && event.count === 1 && (
                <span>{Math.round(Number(event.durationSeconds))}s</span>
              )}
            </div>
          </div>
        ))}
        {grouped.length > 20 && (
          <p className="rir-more-events">+{grouped.length - 20} more events (see full report)</p>
        )}
      </div>
    </div>
  );
}
