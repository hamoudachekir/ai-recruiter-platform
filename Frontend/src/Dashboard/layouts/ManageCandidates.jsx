import { useEffect, useState } from "react";
import { Users, Search, Pencil, Trash2, Check, X } from "lucide-react";
import "../AdminDashboard.css";

const API = "http://localhost:3001";

export default function ManageCandidates() {
  const [candidates, setCandidates] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editedCandidate, setEditedCandidate] = useState({});

  useEffect(() => {
    fetch(`${API}/api/admin/candidates`)
      .then((r) => r.json())
      .then((body) => {
        const data = body.data || [];
        setCandidates(data);
        setFiltered(data);
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(
      candidates.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.email || "").toLowerCase().includes(q)
      )
    );
  }, [search, candidates]);

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this candidate?")) return;
    try {
      await fetch(`${API}/api/users/${id}`, { method: "DELETE" });
      setCandidates((prev) => prev.filter((c) => String(c._id) !== String(id)));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleEdit = (candidate) => {
    setEditingId(candidate._id);
    setEditedCandidate({
      name: candidate.name || "",
      skills: candidate.profile?.skills?.join(", ") || "",
      availability: candidate.profile?.availability || "",
    });
  };

  const handleSave = async (id) => {
    try {
      const res = await fetch(`${API}/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editedCandidate.name,
          profile: {
            skills: editedCandidate.skills.split(",").map((s) => s.trim()).filter(Boolean),
            availability: editedCandidate.availability,
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setCandidates((prev) =>
        prev.map((c) =>
          c._id === id
            ? {
                ...c,
                name: editedCandidate.name,
                profile: {
                  ...c.profile,
                  skills: editedCandidate.skills.split(",").map((s) => s.trim()).filter(Boolean),
                  availability: editedCandidate.availability,
                },
              }
            : c
        )
      );
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <div className="adm-loading"><div className="adm-spinner" />Loading candidates...</div>;

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Candidates</h1>
        <p className="adm-page-header__sub">{candidates.length} registered candidates on the platform</p>
      </div>

      {error && <div className="adm-login__error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="adm-section">
        <div className="adm-section__header">
          <h3 className="adm-section__title">All Candidates</h3>
          {/* Search */}
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
            <Users className="adm-empty__icon" />
            <p className="adm-empty__text">No candidates found</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Skills</th>
                  <th>Availability</th>
                  <th>Apps</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c._id}>
                    {editingId === c._id ? (
                      <>
                        <td>
                          <input
                            className="adm-input"
                            style={{ padding: "6px 10px" }}
                            value={editedCandidate.name}
                            onChange={(e) => setEditedCandidate((p) => ({ ...p, name: e.target.value }))}
                            placeholder="Full name"
                          />
                        </td>
                        <td>
                          <input
                            className="adm-input"
                            style={{ padding: "6px 10px" }}
                            value={editedCandidate.skills}
                            onChange={(e) => setEditedCandidate((p) => ({ ...p, skills: e.target.value }))}
                            placeholder="skill1, skill2"
                          />
                        </td>
                        <td>
                          <input
                            className="adm-input"
                            style={{ padding: "6px 10px" }}
                            value={editedCandidate.availability}
                            onChange={(e) => setEditedCandidate((p) => ({ ...p, availability: e.target.value }))}
                            placeholder="Full-time"
                          />
                        </td>
                        <td>—</td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="adm-btn adm-btn--primary adm-btn--sm" onClick={() => handleSave(c._id)}>
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
                            <div className="adm-avatar" style={{ width: 30, height: 30, fontSize: "0.72rem" }}>
                              {(c.name || c.email || "?")[0].toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600 }}>{c.name || "—"}</div>
                              <div style={{ fontSize: "0.74rem", color: "var(--adm-muted)" }}>{c.email}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {(c.profile?.skills || []).slice(0, 4).map((s) => (
                              <span key={s} className="adm-badge adm-badge--teal">{s}</span>
                            ))}
                            {(c.profile?.skills?.length || 0) > 4 && (
                              <span className="adm-badge adm-badge--gray">+{c.profile.skills.length - 4}</span>
                            )}
                            {!c.profile?.skills?.length && <span style={{ color: "var(--adm-muted)", fontSize: "0.8rem" }}>—</span>}
                          </div>
                        </td>
                        <td>
                          {c.profile?.availability
                            ? <span className="adm-badge adm-badge--green">{c.profile.availability}</span>
                            : <span style={{ color: "var(--adm-muted)" }}>—</span>}
                        </td>
                        <td>
                          <span className="adm-badge adm-badge--violet">{c.applicationsCount ?? 0}</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => handleEdit(c)}>
                              <Pencil size={13} />
                            </button>
                            <button className="adm-btn adm-btn--danger adm-btn--sm" onClick={() => handleDelete(c._id)}>
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
