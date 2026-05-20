import { useState } from "react";
import { KeyRound, Bell, HelpCircle } from "lucide-react";
import "../AdminDashboard.css";

const API = "http://localhost:3001";

export default function SettingsPage() {
  const adminUser = JSON.parse(localStorage.getItem("admin") || "null");
  const [pw, setPw] = useState({ current: "", newPw: "", confirm: "" });
  const [notifs, setNotifs] = useState({ email: true, push: true });
  const [msg, setMsg] = useState(null);

  const handleChangePw = async (e) => {
    e.preventDefault();
    if (pw.newPw !== pw.confirm) {
      setMsg({ type: "error", text: "New passwords do not match." });
      return;
    }
    try {
      const res = await fetch(`${API}/api/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: adminUser?._id, currentPassword: pw.current, newPassword: pw.newPw }),
      });
      const data = await res.json();
      if (data.message === "Password changed successfully") {
        setMsg({ type: "success", text: "Password changed successfully!" });
        setPw({ current: "", newPw: "", confirm: "" });
      } else {
        setMsg({ type: "error", text: data.message || "Failed to change password." });
      }
    } catch {
      setMsg({ type: "error", text: "An error occurred. Please try again." });
    }
  };

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Settings</h1>
        <p className="adm-page-header__sub">Manage your admin account preferences</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, maxWidth: 860 }}>

        {/* Change Password */}
        <div className="adm-section">
          <div className="adm-section__header">
            <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <KeyRound size={16} /> Change Password
            </h3>
          </div>
          <div className="adm-section__body">
            {msg && (
              <div className={msg.type === "success" ? "adm-badge adm-badge--green" : "adm-login__error"}
                style={{ display: "block", marginBottom: 14 }}>
                {msg.text}
              </div>
            )}
            <form onSubmit={handleChangePw}>
              <div className="adm-login__field">
                <label className="adm-login__label">Current password</label>
                <input type="password" className="adm-input" value={pw.current}
                  onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} required />
              </div>
              <div className="adm-login__field">
                <label className="adm-login__label">New password</label>
                <input type="password" className="adm-input" value={pw.newPw}
                  onChange={(e) => setPw((p) => ({ ...p, newPw: e.target.value }))} required />
              </div>
              <div className="adm-login__field">
                <label className="adm-login__label">Confirm new password</label>
                <input type="password" className="adm-input" value={pw.confirm}
                  onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} required />
              </div>
              <button type="submit" className="adm-btn adm-btn--primary" style={{ marginTop: 6 }}>
                Update Password
              </button>
            </form>
          </div>
        </div>

        {/* Notifications + Help stacked */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Notifications */}
          <div className="adm-section">
            <div className="adm-section__header">
              <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Bell size={16} /> Notifications
              </h3>
            </div>
            <div className="adm-section__body">
              {[
                { key: "email", label: "Email notifications" },
                { key: "push",  label: "Push notifications" },
              ].map(({ key, label }) => (
                <label key={key} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  cursor: "pointer", marginBottom: 14, color: "var(--adm-text)", fontSize: "0.84rem",
                }}>
                  <div
                    onClick={() => setNotifs((p) => ({ ...p, [key]: !p[key] }))}
                    style={{
                      width: 38, height: 22, borderRadius: 999,
                      background: notifs[key] ? "var(--adm-accent)" : "rgba(148,163,184,0.2)",
                      position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0,
                    }}
                  >
                    <div style={{
                      position: "absolute", top: 3, left: notifs[key] ? 18 : 3,
                      width: 16, height: 16, borderRadius: "50%", background: "#fff",
                      transition: "left 0.2s",
                    }} />
                  </div>
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Help */}
          <div className="adm-section">
            <div className="adm-section__header">
              <h3 className="adm-section__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <HelpCircle size={16} /> Help & Support
              </h3>
            </div>
            <div className="adm-section__body" style={{ display: "flex", gap: 10 }}>
              <button className="adm-btn adm-btn--ghost" onClick={() => alert("Opening support...")}>
                Contact Support
              </button>
              <button className="adm-btn adm-btn--danger" onClick={() => alert("Reporting bug...")}>
                Report a Bug
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
