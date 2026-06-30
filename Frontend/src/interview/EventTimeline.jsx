import { summarizeByType, formatDuration } from './integrityEvents';

const formatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Per-type presentation: icon, friendly label, and whether duration is meaningful.
const TYPE_META = {
  TAB_SWITCH: { icon: '🗂️', label: 'Tab switches', durational: false },
  FULLSCREEN_EXIT: { icon: '↙️', label: 'Fullscreen exits', durational: false },
  COPY_PASTE: { icon: '📋', label: 'Copy / paste', durational: false },
  PHONE_VISIBLE: { icon: '📱', label: 'Phone visible', durational: true },
  REFERENCE_MATERIAL_VISIBLE: { icon: '📄', label: 'Reference materials', durational: true },
  SCREEN_DEVICE_VISIBLE: { icon: '🖥️', label: 'Extra screens', durational: true },
  MULTIPLE_PEOPLE: { icon: '👥', label: 'Multiple people', durational: true },
  NO_PERSON_VISIBLE: { icon: '🚫', label: 'No person visible', durational: true },
  NO_FACE: { icon: '🙈', label: 'No face', durational: true },
  LOOKING_AWAY_LONG: { icon: '↗️', label: 'Looking away', durational: true },
};

const metaFor = (type) => TYPE_META[type] || {
  icon: '•',
  label: String(type || '').replaceAll('_', ' '),
  durational: false,
};

const PRIORITY = ['MULTIPLE_PEOPLE', 'NO_PERSON_VISIBLE', 'NO_FACE', 'PHONE_VISIBLE',
  'REFERENCE_MATERIAL_VISIBLE', 'SCREEN_DEVICE_VISIBLE', 'TAB_SWITCH', 'COPY_PASTE', 'FULLSCREEN_EXIT'];

const priorityOf = (type) => {
  const i = PRIORITY.indexOf(type);
  return i === -1 ? 99 : i;
};

export default function EventTimeline({ events = [] }) {
  const list = Array.isArray(events) ? events : [];

  if (!list.length) {
    return (
      <div className="rir-section">
        <h4>Event summary</h4>
        <p className="rir-empty-inline">No integrity signals were detected during this interview.</p>
      </div>
    );
  }

  const rows = Object.values(summarizeByType(list)).sort(
    (a, b) => priorityOf(a.type) - priorityOf(b.type),
  );

  return (
    <div className="rir-section">
      <h4>Event summary</h4>
      <p className="rir-section__disclaimer">
        Signals grouped into distinct incidents. Frame counts reflect sampling frequency
        and are shown for reference only.
      </p>

      <div className="rir-signal-grid">
        {rows.map((row) => {
          const meta = metaFor(row.type);
          const range = row.firstTime === row.lastTime
            ? formatTime(row.firstTime)
            : `${formatTime(row.firstTime)} – ${formatTime(row.lastTime)}`;
          return (
            <div key={row.type} className={`rir-signal-card rir-signal-card--${row.highestSeverity}`}>
              <div className="rir-signal-card__head">
                <span className="rir-signal-card__icon" aria-hidden="true">{meta.icon}</span>
                <span className="rir-signal-card__label">{meta.label}</span>
              </div>
              <div className="rir-signal-card__value">
                {row.incidents}
                <small>{row.incidents === 1 ? 'incident' : 'incidents'}</small>
              </div>
              <div className="rir-signal-card__meta">
                {meta.durational && row.totalSeconds > 0 && (
                  <span className="rir-signal-card__chip">~{formatDuration(row.totalSeconds)}</span>
                )}
                <span className="rir-signal-card__frames">{row.frames} frame{row.frames === 1 ? '' : 's'}</span>
              </div>
              <div className="rir-signal-card__range">{range}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
