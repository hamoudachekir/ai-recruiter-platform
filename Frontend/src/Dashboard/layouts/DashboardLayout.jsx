import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Users, Building2, Briefcase, FileText,
  Video, CalendarCheck, ArrowRight, TrendingUp,
} from "lucide-react";
import "../AdminDashboard.css";
import "./DashboardLayout.css";
import "./DashboardLayout.css";

const API = "http://localhost:3001";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function MiniBarChart({ data }) {
  if (!data?.length) return <div style={{ color: "var(--adm-muted)", fontSize: "0.78rem" }}>No data yet</div>;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80 }}>
      {data.map((d) => (
        <div key={`${d._id.year}-${d._id.month}`} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}>
          <div
            style={{
              width: "100%",
              height: `${Math.round((d.count / max) * 70)}px`,
              minHeight: 4,
              background: "linear-gradient(180deg, #14b8a6, #0ea5e9)",
              borderRadius: "4px 4px 0 0",
              transition: "height 0.4s ease",
            }}
            title={`${d.count} applications`}
          />
          <span style={{ fontSize: "0.6rem", color: "var(--adm-muted)" }}>{MONTHS[(d._id.month || 1) - 1]}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segments, size = 110 }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <div style={{ color: "var(--adm-muted)", fontSize: "0.78rem" }}>No data</div>;
  const r = 40, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((seg) => {
    const dash = (seg.value / total) * circ;
    const arc = { dash, offset, color: seg.color };
    offset += dash;
    return arc;
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth={14} />
        {arcs.map((arc, i) => (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none"
            stroke={arc.color} strokeWidth={14}
            strokeDasharray={`${arc.dash} ${circ - arc.dash}`}
            strokeDashoffset={-arc.offset}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
            <span style={{ fontSize: "0.76rem", color: "var(--adm-text)" }}>{seg.label}</span>
            <span style={{ fontSize: "0.76rem", color: "var(--adm-muted)", marginLeft: "auto" }}>
              {Math.round((seg.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardLayout() {
  const [stats, setStats] = useState(null);
  const [recentJobs, setRecentJobs] = useState([]);
  const [recentCandidates, setRecentCandidates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/api/admin/stats`).then(r => r.json()).catch(() => ({})),
      fetch(`${API}/api/admin/jobs`).then(r => r.json()).catch(() => []),
      fetch(`${API}/api/admin/candidates`).then(r => r.json()).catch(() => ({ data: [] })),
    ]).then(([statsData, jobsData, candidatesData]) => {
      setStats(statsData);
      setRecentJobs((Array.isArray(jobsData) ? jobsData : []).slice(0, 5));
      setRecentCandidates((candidatesData.data || []).slice(0, 5));
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="adm-loading"><div className="adm-spinner" />Loading dashboard...</div>;

  const STAT_CARDS = [
    { label: "Candidates",    value: stats?.candidates  || 0, icon: Users,         color: "teal",   link: "/dashboard/manage-candidates" },
    { label: "Companies",     value: stats?.enterprises || 0, icon: Building2,     color: "violet", link: "/dashboard/manage-employees" },
    { label: "Jobs Posted",   value: stats?.jobs        || 0, icon: Briefcase,     color: "amber",  link: "/dashboard/jobs" },
    { label: "Applications",  value: stats?.applications|| 0, icon: FileText,      color: "green",  link: "/dashboard/jobs" },
    { label: "Interviews",    value: stats?.interviews  || 0, icon: Video,         color: "teal",   link: "/dashboard/calendar" },
    { label: "Scheduled",     value: stats?.schedules   || 0, icon: CalendarCheck, color: "violet", link: "/dashboard/calendar" },
  ];

  const jobStatusSegments = (stats?.jobsByStatus || []).map((s, i) => ({
    label: s._id || "Unknown",
    value: s.count,
    color: ["#14b8a6","#818cf8","#f59e0b","#ef4444","#22c55e"][i % 5],
  }));

  const scheduleSegments = [
    { label: "Confirmed", value: stats?.schedules || 0, color: "#14b8a6" },
    { label: "Interviews (total)", value: Math.max(0, (stats?.interviews || 0) - (stats?.schedules || 0)), color: "#818cf8" },
  ].filter(s => s.value > 0);

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Platform Overview</h1>
        <p className="adm-page-header__sub">Real-time stats across the NextHire AI recruiter platform.</p>
      </div>

      {/* Stat cards */}
      <div className="adm-stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        {STAT_CARDS.map((card) => (
          <Link key={card.label} to={card.link} style={{ textDecoration: "none" }}>
            <div className="adm-stat-card">
              <div className="adm-stat-card__top">
                <span className="adm-stat-card__label">{card.label}</span>
                <div className={`adm-stat-card__icon-wrap adm-stat-card__icon-wrap--${card.color}`}>
                  <card.icon size={16} />
                </div>
              </div>
              <div className="adm-stat-card__value">{card.value}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* Charts row */}
      <div className="dash-charts-row">

        {/* Applications over time bar chart */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <TrendingUp size={15} /> Applications per Month
            </h3>
            <span className="adm-section__hint">Last 6 months</span>
          </div>
          <div className="adm-section__body">
            <MiniBarChart data={stats?.monthly || []} />
          </div>
        </div>

        {/* Jobs by status donut */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Briefcase size={15} /> Jobs by Status
            </h3>
          </div>
          <div className="adm-section__body">
            <DonutChart segments={jobStatusSegments.length ? jobStatusSegments : [{ label: "No jobs", value: 1, color: "#334155" }]} />
          </div>
        </div>

        {/* Interview overview donut */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Video size={15} /> Interview Overview
            </h3>
          </div>
          <div className="adm-section__body">
            <DonutChart segments={scheduleSegments.length ? scheduleSegments : [{ label: "No data", value: 1, color: "#334155" }]} />
          </div>
        </div>

      </div>

      {/* Tables row */}
      <div className="dash-tables-row">

        {/* Recent Jobs */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title">Recent Jobs</h3>
            <Link to="/dashboard/jobs" className="adm-btn adm-btn--ghost adm-btn--sm">
              View all <ArrowRight size={13} />
            </Link>
          </div>
          {recentJobs.length === 0 ? (
            <div className="adm-empty"><Briefcase className="adm-empty__icon" /><p className="adm-empty__text">No jobs yet</p></div>
          ) : (
            <table className="adm-table">
              <thead><tr><th>Title</th><th>Company</th><th>Apps</th><th>Status</th></tr></thead>
              <tbody>
                {recentJobs.map((job) => (
                  <tr key={job._id}>
                    <td style={{ fontWeight: 600 }}>{job.title || "—"}</td>
                    <td style={{ color: "var(--adm-muted)" }}>{job.enterpriseName || "—"}</td>
                    <td><span className="adm-badge adm-badge--teal">{job.applicantsCount || 0}</span></td>
                    <td><span className={`adm-badge adm-badge--${job.status === "OPEN" ? "green" : "gray"}`}>{job.status || "N/A"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Candidates */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title">Recent Candidates</h3>
            <Link to="/dashboard/manage-candidates" className="adm-btn adm-btn--ghost adm-btn--sm">
              View all <ArrowRight size={13} />
            </Link>
          </div>
          {recentCandidates.length === 0 ? (
            <div className="adm-empty"><Users className="adm-empty__icon" /><p className="adm-empty__text">No candidates yet</p></div>
          ) : (
            <table className="adm-table">
              <thead><tr><th>Name</th><th>Email</th><th>Apps</th></tr></thead>
              <tbody>
                {recentCandidates.map((c) => (
                  <tr key={c._id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <div className="adm-avatar" style={{ width: 26, height: 26, fontSize: "0.68rem" }}>
                          {(c.name || c.email || "?")[0].toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 600 }}>{c.name || "—"}</span>
                      </div>
                    </td>
                    <td style={{ color: "var(--adm-muted)", fontSize: "0.78rem" }}>{c.email}</td>
                    <td><span className="adm-badge adm-badge--teal">{c.applicationsCount}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}
