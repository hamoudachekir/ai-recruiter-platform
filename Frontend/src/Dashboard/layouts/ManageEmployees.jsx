import { useEffect, useState } from "react";
import { Building2, Search, Pencil, Trash2, CheckCircle, XCircle, Check, X } from "lucide-react";
import "../AdminDashboard.css";

const API = "http://localhost:3001";

const STATUS_BADGE = {
  APPROVED: "green",
  REJECTED:  "red",
  PENDING:   "amber",
};

export default function ManageEmployees() {
  const [enterprises, setEnterprises] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editedData, setEditedData] = useState({});

  useEffect(() => {
    fetch(`${API}/api/admin/companies`)
      .then((r) => r.json())
      .then((body) => {
        const users = body.data || [];
        setEnterprises(users);
        setFiltered(users);
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(enterprises.filter((e) =>
      (e.email || "").toLowerCase().includes(q) ||
      (e.enterprise?.name || "").toLowerCase().includes(q)
    ));
  }, [search, enterprises]);

  const updateStatus = async (id, status) => {
    try {
      await fetch(`${API}/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationStatus: { status, updatedDate: new Date().toISOString() } }),
      });
      setEnterprises((prev) =>
        prev.map((e) => e._id === id ? { ...e, verificationStatus: { ...e.verificationStatus, status } } : e)
      );
    } catch (err) { setError(err.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this company?")) return;
    try {
      await fetch(`${API}/api/users/${id}`, { method: "DELETE" });
      setEnterprises((prev) => prev.filter((e) => e._id !== id));
    } catch (err) { setError(err.message); }
  };

  const handleEdit = (e) => {
    setEditingId(e._id);
    setEditedData({
      name: e.enterprise?.name || "",
      industry: e.enterprise?.industry || "",
      location: e.enterprise?.location || "",
      employeeCount: e.enterprise?.employeeCount || "",
    });
  };

  const handleSave = async (id) => {
    try {
      await fetch(`${API}/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enterprise: editedData }),
      });
      setEnterprises((prev) =>
        prev.map((e) => e._id === id ? { ...e, enterprise: editedData } : e)
      );
      setEditingId(null);
    } catch (err) { setError(err.message); }
  };

  if (loading) return <div className="adm-loading"><div className="adm-spinner" />Loading companies...</div>;

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Companies</h1>
        <p className="adm-page-header__sub">{enterprises.length} enterprise accounts on the platform</p>
      </div>

      {error && <div className="adm-login__error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="adm-section">
        <div className="adm-section__header">
          <h3 className="adm-section__title">All Companies</h3>
          <div className="adm-topbar__search" style={{ width: 240 }}>
            <Search size={14} className="adm-topbar__search-icon" />
            <input
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="adm-empty">
            <Building2 className="adm-empty__icon" />
            <p className="adm-empty__text">No companies found</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Employees</th>
                  <th>Verification</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ent) => (
                  <tr key={ent._id}>
                    {editingId === ent._id ? (
                      <>
                        <td>
                          <input className="adm-input" style={{ padding: "6px 10px" }}
                            value={editedData.name}
                            onChange={(e) => setEditedData((p) => ({ ...p, name: e.target.value }))}
                            placeholder="Company name" />
                        </td>
                        <td>
                          <input className="adm-input" style={{ padding: "6px 10px" }}
                            value={editedData.industry}
                            onChange={(e) => setEditedData((p) => ({ ...p, industry: e.target.value }))}
                            placeholder="Industry" />
                        </td>
                        <td>
                          <input className="adm-input" style={{ padding: "6px 10px" }}
                            value={editedData.location}
                            onChange={(e) => setEditedData((p) => ({ ...p, location: e.target.value }))}
                            placeholder="Location" />
                        </td>
                        <td>
                          <input className="adm-input" style={{ padding: "6px 10px", width: 80 }}
                            type="number"
                            value={editedData.employeeCount}
                            onChange={(e) => setEditedData((p) => ({ ...p, employeeCount: e.target.value }))}
                            placeholder="Count" />
                        </td>
                        <td>—</td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="adm-btn adm-btn--primary adm-btn--sm" onClick={() => handleSave(ent._id)}>
                              <Check size={13} /> Save
                            </button>
                            <button className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => setEditingId(null)}>
                              <X size={13} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div className="adm-avatar" style={{ width: 30, height: 30, fontSize: "0.72rem", borderRadius: 8 }}>
                              {(ent.enterprise?.name || ent.email || "?")[0].toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600 }}>{ent.enterprise?.name || "—"}</div>
                              <div style={{ fontSize: "0.74rem", color: "var(--adm-muted)" }}>{ent.email}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ color: "var(--adm-muted)" }}>{ent.enterprise?.industry || "—"}</td>
                        <td style={{ color: "var(--adm-muted)" }}>{ent.enterprise?.location || "—"}</td>
                        <td style={{ color: "var(--adm-muted)" }}>{ent.enterprise?.employeeCount || "—"}</td>
                        <td>
                          <span className={`adm-badge adm-badge--${STATUS_BADGE[ent.verificationStatus?.status] || "gray"}`}>
                            {ent.verificationStatus?.status || "PENDING"}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => handleEdit(ent)} title="Edit">
                              <Pencil size={13} />
                            </button>
                            {ent.verificationStatus?.status !== "APPROVED" && (
                              <button className="adm-btn adm-btn--sm" style={{ background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.3)" }}
                                onClick={() => updateStatus(ent._id, "APPROVED")} title="Approve">
                                <CheckCircle size={13} />
                              </button>
                            )}
                            {ent.verificationStatus?.status !== "REJECTED" && (
                              <button className="adm-btn adm-btn--sm" style={{ background: "rgba(245,158,11,0.1)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.3)" }}
                                onClick={() => updateStatus(ent._id, "REJECTED")} title="Reject">
                                <XCircle size={13} />
                              </button>
                            )}
                            <button className="adm-btn adm-btn--danger adm-btn--sm" onClick={() => handleDelete(ent._id)} title="Delete">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
