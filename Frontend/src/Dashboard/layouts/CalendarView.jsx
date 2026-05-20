import { useState, useEffect } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { CalendarDays, Clock, Video, MapPin, User, Briefcase } from "lucide-react";
import "../AdminDashboard.css";
import "./CalendarView.css";

const API = "http://localhost:3001";

const isSameDay = (a, b) =>
  a.getDate() === b.getDate() &&
  a.getMonth() === b.getMonth() &&
  a.getFullYear() === b.getFullYear();

const fmt = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const STATUS_COLOR = {
  confirmed:    "adm-badge--green",
  rescheduled:  "adm-badge--amber",
  cancelled:    "adm-badge--red",
  draft:        "adm-badge--gray",
  pending:      "adm-badge--violet",
};

export default function CalendarView() {
  const [interviews, setInterviews] = useState([]);
  const [date, setDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/api/admin/calendar`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json();
      })
      .then((data) => { setInterviews(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const datesWithInterviews = new Set(
    interviews.map((i) => {
      const d = new Date(i.date);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    })
  );

  const selectedInterviews = interviews.filter((i) =>
    i.date && isSameDay(new Date(i.date), date)
  );

  if (loading) return <div className="adm-loading"><div className="adm-spinner" />Loading calendar...</div>;

  if (error) return (
    <div className="adm-content">
      <div className="adm-login__error" style={{ maxWidth: 500 }}>
        Could not load calendar: {error}
      </div>
    </div>
  );

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Interview Calendar</h1>
        <p className="adm-page-header__sub">
          {interviews.length} scheduled interview{interviews.length !== 1 ? "s" : ""} total
        </p>
      </div>

      <div className="calv-grid">
        {/* Calendar picker */}
        <div className="adm-section calv-cal-wrap">
          <div className="adm-section__header">
            <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CalendarDays size={16} /> Pick a date
            </h3>
          </div>
          <div className="adm-section__body calv-cal-body">
            <Calendar
              onChange={setDate}
              value={date}
              tileContent={({ date: d }) => {
                const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                return datesWithInterviews.has(key)
                  ? <span className="calv-dot" />
                  : null;
              }}
            />
          </div>
        </div>

        {/* Interview list for selected day */}
        <div className="adm-section calv-list">
          <div className="adm-section__header">
            <h3 className="adm-section__title">
              {date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            </h3>
            <span className="adm-section__hint">
              {selectedInterviews.length} interview{selectedInterviews.length !== 1 ? "s" : ""}
            </span>
          </div>

          {selectedInterviews.length === 0 ? (
            <div className="adm-empty">
              <CalendarDays className="adm-empty__icon" />
              <p className="adm-empty__text">No interviews scheduled on this day</p>
            </div>
          ) : (
            <div className="calv-cards">
              {selectedInterviews.map((iv) => (
                <div key={String(iv._id)} className="calv-card">
                  <div className="calv-card__top">
                    <div className="calv-card__time">
                      <Clock size={13} />
                      {fmt(iv.date)} – {fmt(iv.endDate)}
                      {iv.duration && <span className="calv-card__duration">{iv.duration} min</span>}
                    </div>
                    <span className={`adm-badge ${STATUS_COLOR[iv.status] || "adm-badge--gray"}`}>
                      {iv.status || "unknown"}
                    </span>
                  </div>

                  <div className="calv-card__title">
                    <Briefcase size={14} />
                    {iv.jobTitle || "Unknown position"}
                    {iv.enterpriseName && (
                      <span className="calv-card__company"> · {iv.enterpriseName}</span>
                    )}
                  </div>

                  <div className="calv-card__meta">
                    <span><User size={12} /> {iv.candidate?.name || iv.candidate?.email || "—"}</span>
                    {iv.interviewType && (
                      <span><Video size={12} /> {iv.interviewType}</span>
                    )}
                    {iv.meetingLink && (
                      <a href={iv.meetingLink} target="_blank" rel="noreferrer" className="calv-card__link">
                        <MapPin size={12} /> Join meeting
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Upcoming list */}
      <div className="adm-section" style={{ marginTop: 20 }}>
        <div className="adm-section__header">
          <h3 className="adm-section__title">All Upcoming Interviews</h3>
          <span className="adm-section__hint">{interviews.filter(i => new Date(i.date) >= new Date()).length} upcoming</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Candidate</th>
                <th>Position</th>
                <th>Company</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {interviews
                .slice()
                .sort((a, b) => new Date(a.date) - new Date(b.date))
                .map((iv) => (
                  <tr key={String(iv._id)}>
                    <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                      {iv.date
                        ? new Date(iv.date).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) +
                          " " + fmt(iv.date)
                        : "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div className="adm-avatar" style={{ width: 26, height: 26, fontSize: "0.68rem" }}>
                          {(iv.candidate?.name || iv.candidate?.email || "?")[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.82rem" }}>{iv.candidate?.name || "—"}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--adm-muted)" }}>{iv.candidate?.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{iv.jobTitle || "—"}</td>
                    <td style={{ color: "var(--adm-muted)" }}>{iv.enterpriseName || "—"}</td>
                    <td>
                      {iv.interviewType && (
                        <span className="adm-badge adm-badge--teal">{iv.interviewType}</span>
                      )}
                    </td>
                    <td>
                      <span className={`adm-badge ${STATUS_COLOR[iv.status] || "adm-badge--gray"}`}>
                        {iv.status || "—"}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
