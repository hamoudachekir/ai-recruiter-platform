import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "react-toastify";
import PublicLayout from "../../layouts/PublicLayout";
import "./JoinJobRoom.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

const JoinJobRoom = () => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const token = localStorage.getItem("token");

  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!token) {
        navigate(`/login?redirect=/join/${slug}`);
        return;
      }
      try {
        const res = await axios.get(
          `${API_BASE}/api/job-rooms/by-slug/${slug}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!cancelled) setRoom(res.data?.room || null);
      } catch (err) {
        if (!cancelled) {
          setError(
            err.response?.data?.message ||
              "We couldn't find this interview room.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, token, navigate]);

  const handleJoin = async () => {
    if (!room) return;
    setJoining(true);
    try {
      const res = await axios.post(
        `${API_BASE}/api/job-rooms/by-slug/${slug}/join`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const session = res.data?.room;
      if (!session?._id) {
        throw new Error("No session returned");
      }
      toast.success(
        res.data?.resumed
          ? "Resuming your interview…"
          : "Interview session created",
      );
      navigate(`/call-room/${session._id}`);
    } catch (err) {
      toast.error(err.response?.data?.message || "Could not join room");
    } finally {
      setJoining(false);
    }
  };

  return (
    <PublicLayout>
      <div className="jjr-page">
        {loading && <div className="jjr-card">Loading interview room…</div>}

        {!loading && error && (
          <div className="jjr-card jjr-error">
            <h2>Interview room unavailable</h2>
            <p>{error}</p>
            <button
              type="button"
              className="jjr-btn"
              onClick={() => navigate("/home")}
            >
              Go home
            </button>
          </div>
        )}

        {!loading && !error && room && (
          <div className="jjr-card">
            <div className="jjr-eyebrow">{room.company?.name || "Company"}</div>
            <h2>{room.title || `Interview — ${room.job?.title}`}</h2>
            <h3 className="jjr-job-title">{room.job?.title}</h3>

            {room.job?.description && (
              <p className="jjr-desc">{room.job.description}</p>
            )}

            <div className="jjr-meta">
              {room.job?.location && (
                <span>📍 {room.job.location}</span>
              )}
              {Array.isArray(room.job?.skills) && room.job.skills.length > 0 && (
                <span>🛠 {room.job.skills.slice(0, 4).join(", ")}</span>
              )}
              <span className={`jjr-status ${room.status}`}>{room.status}</span>
            </div>

            {room.description && (
              <div className="jjr-instructions">
                <strong>What to expect</strong>
                <p>{room.description}</p>
              </div>
            )}

            <ul className="jjr-checklist">
              <li>Quiet space with good lighting and a working webcam</li>
              <li>
                Allow microphone + camera access when prompted
              </li>
              <li>The AI interviewer will guide you through ~15-25 minutes</li>
              {room.settings?.requireFaceVerification && (
                <li>You'll be asked to verify your identity on camera</li>
              )}
            </ul>

            <button
              type="button"
              className="jjr-btn primary"
              disabled={joining || room.status !== "open"}
              onClick={handleJoin}
            >
              {joining
                ? "Preparing room…"
                : room.status === "open"
                ? "Start interview"
                : "Room closed"}
            </button>
            <p className="jjr-foot">
              Your session is securely linked to this job. The recruiter can
              compare your results against other candidates after you finish.
            </p>
          </div>
        )}
      </div>
    </PublicLayout>
  );
};

export default JoinJobRoom;
