import { useEffect, useState } from "react";
import { Briefcase, Search, Trash2, X, Check } from "lucide-react";
import "../AdminDashboard.css";

const API = "http://localhost:3001";

const formatDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export default function AllJobs() {
  const [jobs, setJobs] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editJob, setEditJob] = useState(null);

  useEffect(() => {
    fetch(`${API}/api/admin/jobs`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setJobs(list);
        setFiltered(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(jobs.filter((j) =>
      (j.title || "").toLowerCase().includes(q) ||
      (j.enterpriseName || "").toLowerCase().includes(q)
    ));
  }, [search, jobs]);

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this job?")) return;
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const userId = user?._id;
    if (!userId) { alert("User ID not found."); return; }

    try {
      const res = await fetch(`${API}/api/jobs/delete/${userId}/${id}`, { method: "DELETE" });
      if (res.ok) setJobs((prev) => prev.filter((j) => j._id !== id));
      else alert("Failed to delete job.");
    } catch (err) {
      console.error(err);
    }
  };

  const handleSave = async () => {
    if (!editJob) return;
    try {
      const res = await fetch(`${API}/api/jobs/${editJob._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editJob.title, status: editJob.status }),
      });
      if (res.ok) {
        setJobs((prev) => prev.map((j) => j._id === editJob._id ? { ...j, ...editJob } : j));
        setEditJob(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="adm-loading"><div className="adm-spinner" />Loading jobs...</div>;

  return (
    <div className="adm-content">
      <div className="adm-page-header">
        <h1 className="adm-page-header__title">Jobs</h1>
        <p className="adm-page-header__sub">{jobs.length} jobs posted on the platform</p>
      </div>

      <div className="adm-section">
        <div className="adm-section__header">
          <h3 className="adm-section__title">All Posted Jobs</h3>
          <div className="adm-topbar__search" style={{ width: 240 }}>
            <Search size={14} className="adm-topbar__search-icon" />
            <input
              placeholder="Search by title or company..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="adm-empty">
            <Briefcase className="adm-empty__icon" />
            <p className="adm-empty__text">No jobs found</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Company</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Applicants</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => (
                  <tr key={job._id}>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{job.title || "—"}</td>
                    <td style={{ color: "var(--adm-muted)" }}>{job.enterpriseName || "—"}</td>
                    <td style={{ color: "var(--adm-muted)" }}>{job.industry || "—"}</td>
                    <td style={{ color: "var(--adm-muted)" }}>{job.location || "—"}</td>
                    <td>
                      <span className="adm-badge adm-badge--violet">{job.applicantsCount ?? job.applicants ?? 0}</span>
                    </td>
                    <td>
                      <span className={`adm-badge adm-badge--${job.status === "OPEN" ? "green" : "gray"}`}>
                        {job.status || "N/A"}
                      </span>
                    </td>
                    <td style={{ color: "var(--adm-muted)", whiteSpace: "nowrap" }}>{formatDate(job.createdDate)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="adm-btn adm-btn--danger adm-btn--sm" onClick={() => handleDelete(job._id)} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editJob && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex",
          alignItems: "center", justifyContent: "center", zIndex: 999,
        }}>
          <div style={{
            background: "var(--adm-surface)", border: "1px solid var(--adm-border)",
            borderRadius: 14, padding: 28, width: 360,
          }}>
            <h3 style={{ color: "#f1f5f9", marginBottom: 20, fontSize: "1rem", fontWeight: 700 }}>Edit Job</h3>
            <label className="adm-login__label">Title</label>
            <input
              className="adm-input"
              style={{ marginBottom: 14 }}
              value={editJob.title || ""}
              onChange={(e) => setEditJob({ ...editJob, title: e.target.value })}
            />
            <label className="adm-login__label">Status</label>
            <select
              className="adm-input"
              style={{ marginBottom: 20 }}
              value={editJob.status || "OPEN"}
              onChange={(e) => setEditJob({ ...editJob, status: e.target.value })}
            >
              <option value="OPEN">OPEN</option>
              <option value="CLOSED">CLOSED</option>
            </select>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="adm-btn adm-btn--ghost" onClick={() => setEditJob(null)}>
                <X size={14} /> Cancel
              </button>
              <button className="adm-btn adm-btn--primary" onClick={handleSave}>
                <Check size={14} /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
