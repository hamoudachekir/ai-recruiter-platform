import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Building2,
  Briefcase,
  CalendarDays,
  Settings,
  LogOut,
  BrainCircuit,
} from "lucide-react";
import "../../../AdminDashboard.css";

const NAV_ITEMS = [
  { label: "Overview",    icon: LayoutDashboard, path: "/dashboard",                  end: true },
  { label: "Candidates",  icon: Users,            path: "/dashboard/manage-candidates" },
  { label: "Companies",   icon: Building2,        path: "/dashboard/manage-employees" },
  { label: "Jobs",        icon: Briefcase,        path: "/dashboard/jobs" },
  { label: "Calendar",    icon: CalendarDays,     path: "/dashboard/calendar" },
  { label: "Settings",    icon: Settings,         path: "/dashboard/settings" },
];

export default function SideNav() {
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem("admin");
    navigate("/dashboard/login");
  };

  return (
    <aside className="adm-sidebar">
      {/* Brand */}
      <div className="adm-sidebar__brand">
        <div className="adm-sidebar__brand-icon">
          <BrainCircuit size={18} />
        </div>
        <div className="adm-sidebar__brand-text">
          <span className="adm-sidebar__brand-name">NextHire</span>
          <span className="adm-sidebar__brand-badge">Admin Panel</span>
        </div>
      </div>

      <span className="adm-sidebar__section-label">Main Menu</span>

      <nav className="adm-sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.end}
            className={({ isActive }) =>
              `adm-nav-item${isActive ? " adm-nav-item--active" : ""}`
            }
          >
            <item.icon className="adm-nav-item__icon" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="adm-sidebar__bottom">
        <button className="adm-nav-item" onClick={handleLogout} style={{ color: "#f87171" }}>
          <LogOut className="adm-nav-item__icon" />
          Logout
        </button>
      </div>
    </aside>
  );
}
