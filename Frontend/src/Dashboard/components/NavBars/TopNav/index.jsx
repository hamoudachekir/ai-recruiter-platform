import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Search, Bell, Settings, LogOut, X, LayoutDashboard, Users, Building2, Briefcase, CalendarDays } from "lucide-react";
import "../../../AdminDashboard.css";
import "./TopNav.css";
import "./TopNav.css";

const PAGE_TITLES = {
  "/dashboard":                   "Overview",
  "/dashboard/manage-candidates": "Candidates",
  "/dashboard/manage-employees":  "Companies",
  "/dashboard/jobs":              "Jobs",
  "/dashboard/calendar":          "Calendar",
  "/dashboard/settings":          "Settings",
};

const SEARCH_PAGES = [
  { label: "Overview",    desc: "Platform stats & charts",     path: "/dashboard",                   icon: LayoutDashboard },
  { label: "Candidates",  desc: "Manage candidate profiles",   path: "/dashboard/manage-candidates", icon: Users },
  { label: "Companies",   desc: "Manage enterprise accounts",  path: "/dashboard/manage-employees",  icon: Building2 },
  { label: "Jobs",        desc: "View & delete posted jobs",   path: "/dashboard/jobs",              icon: Briefcase },
  { label: "Calendar",    desc: "Interview schedule calendar", path: "/dashboard/calendar",           icon: CalendarDays },
  { label: "Settings",    desc: "Account & preferences",       path: "/dashboard/settings",          icon: Settings },
];

// Static notifications — in a real app these would come from /api/admin/notifications
const MOCK_NOTIFICATIONS = [
  { id: 1, type: "candidate", text: "New candidate registered", time: "2 min ago",  read: false },
  { id: 2, type: "job",       text: "New job posted by Talan",  time: "15 min ago", read: false },
  { id: 3, type: "interview", text: "Interview confirmed for tomorrow", time: "1 hr ago", read: true },
  { id: 4, type: "company",   text: "Company account approved", time: "3 hr ago",   read: true },
];

const NOTIF_ICONS = { candidate: "👤", job: "💼", interview: "🎥", company: "🏢" };

export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [admin, setAdmin] = useState(null);

  // Search
  const [search, setSearch]           = useState("");
  const [showResults, setShowResults] = useState(false);
  const searchRef                     = useRef(null);

  // Notifications
  const [showNotif, setShowNotif]     = useState(false);
  const [notifs, setNotifs]           = useState(MOCK_NOTIFICATIONS);
  const notifRef                      = useRef(null);

  const unread = notifs.filter((n) => !n.read).length;

  useEffect(() => {
    const stored = localStorage.getItem("admin");
    if (stored) setAdmin(JSON.parse(stored));
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setShowResults(false);
      if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotif(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Filter pages by search query
  const results = search.trim()
    ? SEARCH_PAGES.filter(
        (p) =>
          p.label.toLowerCase().includes(search.toLowerCase()) ||
          p.desc.toLowerCase().includes(search.toLowerCase())
      )
    : SEARCH_PAGES;

  const handleSelect = (path) => {
    navigate(path);
    setSearch("");
    setShowResults(false);
  };

  const markAllRead = () => setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
  const dismiss = (id) => setNotifs((prev) => prev.filter((n) => n.id !== id));

  const title = PAGE_TITLES[location.pathname] || "Admin Panel";
  const initials = admin?.name
    ? admin.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : "A";

  const handleLogout = () => {
    localStorage.removeItem("admin");
    navigate("/dashboard/login");
  };

  return (
    <header className="adm-topbar">
      <span className="adm-topbar__title">{title}</span>

      {/* ── Search ── */}
      <div className="topnav-search-wrap" ref={searchRef}>
        <div className="adm-topbar__search" onClick={() => setShowResults(true)}>
          <Search className="adm-topbar__search-icon" />
          <input
            placeholder="Search pages..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowResults(true); }}
            onFocus={() => setShowResults(true)}
          />
          {search && (
            <button className="topnav-search-clear" onClick={() => { setSearch(""); setShowResults(false); }}>
              <X size={13} />
            </button>
          )}
        </div>

        {showResults && (
          <div className="topnav-dropdown topnav-search-results">
            <div className="topnav-dropdown__label">Pages</div>
            {results.length === 0 ? (
              <div className="topnav-empty">No pages match "{search}"</div>
            ) : (
              results.map((page) => (
                <button
                  key={page.path}
                  className={`topnav-result-item${location.pathname === page.path ? " topnav-result-item--active" : ""}`}
                  onClick={() => handleSelect(page.path)}
                >
                  <div className="topnav-result-icon">
                    <page.icon size={15} />
                  </div>
                  <div className="topnav-result-text">
                    <span className="topnav-result-label">{page.label}</span>
                    <span className="topnav-result-desc">{page.desc}</span>
                  </div>
                  {location.pathname === page.path && (
                    <span className="topnav-result-current">Current</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="adm-topbar__actions">

        {/* ── Notifications ── */}
        <div className="topnav-notif-wrap" ref={notifRef}>
          <button
            className="adm-topbar__btn adm-topbar__btn--notif"
            title="Notifications"
            onClick={() => setShowNotif((v) => !v)}
          >
            <Bell size={16} />
            {unread > 0 && <span className="adm-topbar__notif-dot" />}
          </button>

          {showNotif && (
            <div className="topnav-dropdown topnav-notif-panel">
              <div className="topnav-dropdown__header">
                <span className="topnav-dropdown__label" style={{ margin: 0 }}>
                  Notifications
                  {unread > 0 && <span className="topnav-notif-badge">{unread}</span>}
                </span>
                {unread > 0 && (
                  <button className="topnav-mark-read" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>

              <div className="topnav-notif-list">
                {notifs.length === 0 ? (
                  <div className="topnav-empty">No notifications</div>
                ) : (
                  notifs.map((n) => (
                    <div key={n.id} className={`topnav-notif-item${n.read ? "" : " topnav-notif-item--unread"}`}>
                      <span className="topnav-notif-icon">{NOTIF_ICONS[n.type] || "🔔"}</span>
                      <div className="topnav-notif-body">
                        <span className="topnav-notif-text">{n.text}</span>
                        <span className="topnav-notif-time">{n.time}</span>
                      </div>
                      <button className="topnav-notif-dismiss" onClick={() => dismiss(n.id)} title="Dismiss">
                        <X size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Settings */}
        <button
          className="adm-topbar__btn"
          title="Settings"
          onClick={() => navigate("/dashboard/settings")}
        >
          <Settings size={16} />
        </button>

        {/* Profile */}
        {admin && (
          <div className="adm-topbar__profile" title={admin.email}>
            {admin.picture ? (
              <img src={admin.picture} alt="avatar" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <div className="adm-topbar__avatar">{initials}</div>
            )}
            <span className="adm-topbar__profile-name">{admin.name || "Admin"}</span>
          </div>
        )}

        {/* Logout */}
        <button className="adm-topbar__btn" title="Logout" onClick={handleLogout}>
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
