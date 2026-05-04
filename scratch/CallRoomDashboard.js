import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import AgentChatPanel from "./AgentChatPanel";
import PublicLayout from "../layouts/PublicLayout";
import RecruiterIntegrityReport from "./RecruiterIntegrityReport";
import "./CallRoomDashboard.css";
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const isTokenExpired = (jwtToken) => {
  if (!jwtToken) return true;
  try {
    const payload = JSON.parse(atob(jwtToken.split(".")[1] || ""));
    if (!payload?.exp) return true;
    return payload.exp * 1e3 <= Date.now();
  } catch {
    return true;
  }
};
const normalizeTranscriptText = (text) => String(text || "").replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/’/g, "'").trim();
const stripLeadingTranscriptNoise = (text) => normalizeTranscriptText(text).replace(/^(?:thank you(?: very much)?|thanks|positive|negative|neutral)(?:[.!?,:;\s]+)(?=\S)/i, "").trim();
const CallRoomDashboard = () => {
  const TAB_STORAGE_KEY = "rh-call-room-tabs-v1";
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [overallSentiment, setOverallSentiment] = useState({ label: "NEUTRAL", score: 0 });
  const [detailTab, setDetailTab] = useState("transcript");
  const [analysisByRoom, setAnalysisByRoom] = useState({});
  const [roomTabPrefs, setRoomTabPrefs] = useState(() => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [notification, setNotification] = useState(null);
  const [socketClient, setSocketClient] = useState(null);
  const socketRef = useRef(null);
  const notifyTimerRef = useRef(null);
  const token = localStorage.getItem("token");
  const selectedRoom = rooms.find((r) => r._id === selectedRoomId) || null;
  const notify = useCallback((msg, type = "info") => {
    setNotification({ msg, type });
    clearTimeout(notifyTimerRef.current);
    notifyTimerRef.current = setTimeout(() => setNotification(null), 3500);
  }, []);
  const defaultAnalysisState = {
    uploading: false,
    starting: false,
    statusLoading: false,
    status: null,
    report: null,
    error: ""
  };
  const getAnalysisState = useCallback(
    (roomId) => analysisByRoom[roomId] || defaultAnalysisState,
    [analysisByRoom]
  );
  const patchAnalysisState = useCallback((roomId, patch) => {
    if (!roomId) return;
    setAnalysisByRoom((prev) => ({
      ...prev,
      [roomId]: {
        ...prev[roomId] || defaultAnalysisState,
        ...patch
      }
    }));
  }, []);
  const resetTabPreferences = () => {
    try {
      localStorage.removeItem(TAB_STORAGE_KEY);
    } catch {
    }
    setRoomTabPrefs({});
    setDetailTab("transcript");
    notify("Tab preferences reset", "success");
  };
  const fetchRooms = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/rh/my-rooms`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.success) {
        setRooms(data.rooms);
      }
    } catch (error) {
      console.error("Failed to fetch rooms:", error);
    }
  }, [token]);
  useEffect(() => {
    fetchRooms().finally(() => setLoading(false));
  }, [fetchRooms]);
  useEffect(() => {
    const hasWaiting = rooms.some((r) => r.status === "waiting_confirmation");
    if (!hasWaiting) return void 0;
    const interval = setInterval(fetchRooms, 3e3);
    return () => clearInterval(interval);
  }, [rooms, fetchRooms]);
  useEffect(() => {
    if (!selectedRoom?._id || selectedRoom?.status !== "active") return void 0;
    const fetchRoomDetails = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/${selectedRoom._id}`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success && data.room) {
          setRooms((prev) => prev.map((r) => r._id === data.room._id ? data.room : r));
          if (Array.isArray(data.room?.transcription?.segments)) {
            setTranscription(data.room.transcription.segments);
          }
          if (data.room?.transcription?.overallSentiment) {
            setOverallSentiment(data.room.transcription.overallSentiment);
          }
        }
      } catch (_) {
      }
    };
    fetchRoomDetails();
    const intervalId = setInterval(fetchRoomDetails, 2500);
    return () => clearInterval(intervalId);
  }, [selectedRoom?._id, selectedRoom?.status, token]);
  useEffect(() => {
    if (!token || isTokenExpired(token)) return void 0;
    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1200
    });
    setSocketClient(socketRef.current);
    socketRef.current.on("connect_error", (error) => {
      if (error?.message === "TOKEN_EXPIRED") {
        socketRef.current?.disconnect();
      }
    });
    socketRef.current.on("candidate-join-request", ({ roomId: eventRoomId }) => {
      fetch(`${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(eventRoomId)}`, {
        headers: { "Authorization": `Bearer ${token}` }
      }).then((r) => r.json()).then((data) => {
        if (data.success && data.room) {
          setRooms((prev) => {
            const exists = prev.some((r) => r.roomId === eventRoomId);
            if (!exists) return prev;
            return prev.map((r) => r.roomId === eventRoomId ? data.room : r);
          });
          setSelectedRoomId((prev) => prev ?? data.room._id);
          notify(`Candidate ${data.room.candidate?.email || ""} is requesting to join`, "info");
        }
      }).catch(() => {
      });
    });
    socketRef.current.on("transcription-update", ({ segment, sentiment }) => {
      if (segment) {
        const cleanedSegment = {
          ...segment,
          text: stripLeadingTranscriptNoise(segment.text),
          corrected_text: stripLeadingTranscriptNoise(segment.corrected_text)
        };
        setTranscription((prev) => [...prev, cleanedSegment]);
        const text = String(cleanedSegment.text || "").trim();
        if (text) {
          globalThis.dispatchEvent(
            new CustomEvent("candidate-local-message", {
              detail: { text, sentiment: segment.sentiment || sentiment, ts: Date.now() }
            })
          );
        }
      }
      if (sentiment) {
        setOverallSentiment(sentiment);
      }
    });
    socketRef.current.on("call-room-ended", () => {
      fetchRooms();
    });
    return () => {
      socketRef.current?.off("candidate-join-request");
      socketRef.current?.off("transcription-update");
      socketRef.current?.off("call-room-ended");
      socketRef.current?.off("connect_error");
      socketRef.current?.disconnect();
      setSocketClient(null);
    };
  }, [token, notify, fetchRooms]);
  useEffect(() => {
    if (!selectedRoom?.roomId || !socketRef.current) return;
    socketRef.current.emit("join-room", { roomId: selectedRoom.roomId });
  }, [selectedRoom?.roomId]);
  useEffect(() => {
    if (!selectedRoomId) {
      setTranscription([]);
      setOverallSentiment({ label: "NEUTRAL", score: 0 });
    }
  }, [selectedRoomId]);
  useEffect(() => {
    if (!selectedRoomId) return;
    const savedTab = roomTabPrefs[selectedRoomId];
    if (savedTab === "transcript" || savedTab === "audio" || savedTab === "vision" || savedTab === "integrity") {
      setDetailTab(savedTab);
      return;
    }
    setDetailTab("transcript");
  }, [selectedRoomId, roomTabPrefs]);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(roomTabPrefs));
    } catch {
    }
  }, [roomTabPrefs]);
  const createRoom = async (jobId = null) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/create`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jobId })
      });
      const data = await response.json();
      if (data.success) {
        setRooms((prev) => [data.room, ...prev]);
        socketRef.current?.emit("call-room-created", {
          roomId: data.room.roomId,
          room: data.room
        });
        notify(`Room created: ${data.room.roomId}`, "success");
      }
    } catch (error) {
      console.error("Failed to create room:", error);
      notify("Failed to create room", "error");
    }
  };
  const confirmCandidateJoin = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/confirm-join`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.success) {
        setRooms((prev) => prev.map((r) => r._id === roomId ? data.room : r));
        const candidateId = data.room?.candidate?._id || data.room?.candidate;
        socketRef.current?.emit("confirm-candidate-join", {
          roomId: data.room.roomId,
          roomDbId: roomId,
          candidateId: String(candidateId)
        });
        socketRef.current?.emit("join-room", { roomId: data.room.roomId });
        setTranscription([]);
        setOverallSentiment({ label: "NEUTRAL", score: 0 });
        notify("Candidate confirmed \u2014 recording started", "success");
      }
    } catch (error) {
      console.error("Failed to confirm join:", error);
      notify("Failed to confirm", "error");
    }
  };
  const rejectCandidateJoin = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/reject-join`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.success) {
        setRooms((prev) => prev.map((r) => r._id === roomId ? data.room : r));
        const rejectedRoom = rooms.find((r) => r._id === roomId);
        const candidateId = rejectedRoom?.candidate?._id || rejectedRoom?.candidate;
        if (candidateId) {
          socketRef.current?.emit("reject-candidate-join", {
            roomId: data.room.roomId,
            roomDbId: roomId,
            candidateId: String(candidateId)
          });
        }
        notify("Candidate rejected", "info");
      }
    } catch (error) {
      console.error("Failed to reject:", error);
    }
  };
  const endCall = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/end-call`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.success) {
        setRooms((prev) => prev.map((r) => r._id === roomId ? data.room : r));
        socketRef.current?.emit("end-call-room", { roomId: data.room.roomId, roomDbId: roomId });
        setSelectedRoomId(null);
        setTranscription([]);
        notify("Call ended", "info");
      }
    } catch (error) {
      console.error("Failed to end call:", error);
    }
  };
  const deleteRoom = async (roomId) => {
    const shouldDelete = globalThis.confirm("Supprimer cette room ? Cette action est irreversible.");
    if (!shouldDelete) return;
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.success) {
        setRooms((prev) => prev.filter((r) => r._id !== roomId));
        if (selectedRoomId === roomId) {
          setSelectedRoomId(null);
          setTranscription([]);
          setOverallSentiment({ label: "NEUTRAL", score: 0 });
        }
        socketRef.current?.emit("call-room-status-update", {
          roomId: data.room?.roomId,
          roomDbId: roomId,
          status: "deleted"
        });
        notify("Room supprim\xE9e avec succ\xE8s", "success");
      } else {
        notify(data.message || "Impossible de supprimer la room", "error");
      }
    } catch (error) {
      console.error("Failed to delete room:", error);
      notify("Erreur lors de la suppression", "error");
    }
  };
  const renderRoomStatus = (room) => {
    if (room.status === "waiting_confirmation") {
      return /* @__PURE__ */ React.createElement("div", { className: "status-badge waiting" }, room.candidate ? "Candidate Requesting Join" : "Waiting for Candidate");
    }
    if (room.status === "active") {
      return /* @__PURE__ */ React.createElement("div", { className: "status-badge active" }, "Active Call");
    }
    if (room.status === "ended") {
      return /* @__PURE__ */ React.createElement("div", { className: "status-badge ended" }, "Ended");
    }
    return null;
  };
  const getSentimentColor = (label) => {
    if (label === "POSITIVE") return "#4CAF50";
    if (label === "NEGATIVE") return "#f44336";
    return "#9E9E9E";
  };
  const formatTranscriptTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  const getDisplayTranscriptText = (segment) => stripLeadingTranscriptNoise(segment?.corrected_text || segment?.text || "");
  const renderVisionMini = (room) => {
    const report = room?.visionMonitoring?.report;
    if (!report) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "vision-mini" }, /* @__PURE__ */ React.createElement("div", { className: "vision-mini__row" }, /* @__PURE__ */ React.createElement("span", { className: `vision-mini__quality vision-mini__quality--${String(report.cameraQuality || "").toLowerCase().replace(/\s+/g, "-")}` }, report.cameraQuality || "Unknown"), /* @__PURE__ */ React.createElement("span", { className: "vision-mini__metric" }, report.faceVisibilityRate || "0%", " visible")), /* @__PURE__ */ React.createElement("div", { className: "vision-mini__row vision-mini__row--subtle" }, /* @__PURE__ */ React.createElement("span", null, "No-face: ", report.absenceEvents || 0), /* @__PURE__ */ React.createElement("span", null, "Light: ", report.lightingIssues || 0), /* @__PURE__ */ React.createElement("span", null, "Position: ", report.positionIssues || 0)));
  };
  const renderVisionReport = (room) => {
    const report = room?.visionMonitoring?.report;
    if (!report) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "vision-report-card" }, /* @__PURE__ */ React.createElement("div", { className: "vision-report-card__header" }, /* @__PURE__ */ React.createElement("h4", null, "Vision Monitoring"), /* @__PURE__ */ React.createElement("span", { className: `vision-report-card__pill vision-report-card__pill--${String(report.cameraQuality || "").toLowerCase().replace(/\s+/g, "-")}` }, report.cameraQuality || "Unknown")), /* @__PURE__ */ React.createElement("div", { className: "vision-report-card__grid" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Face visibility"), /* @__PURE__ */ React.createElement("strong", null, report.faceVisibilityRate || "0%")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Multiple faces"), /* @__PURE__ */ React.createElement("strong", null, report.multipleFacesDetected ? "Yes" : "No")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Absence events"), /* @__PURE__ */ React.createElement("strong", null, report.absenceEvents || 0)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Lighting issues"), /* @__PURE__ */ React.createElement("strong", null, report.lightingIssues || 0)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Position issues"), /* @__PURE__ */ React.createElement("strong", null, report.positionIssues || 0)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Flags"), /* @__PURE__ */ React.createElement("strong", null, Array.isArray(report.suspiciousEvents) ? report.suspiciousEvents.length : 0))), Array.isArray(report.suspiciousEvents) && report.suspiciousEvents.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "vision-report-card__events" }, report.suspiciousEvents.slice(0, 5).map((event, index) => /* @__PURE__ */ React.createElement("div", { key: `${event.type}-${event.questionId || "na"}-${index}`, className: "vision-report-card__event" }, /* @__PURE__ */ React.createElement("span", null, event.type), /* @__PURE__ */ React.createElement("span", null, event.duration || "N/A"), /* @__PURE__ */ React.createElement("span", null, event.questionId || "No question id")))), /* @__PURE__ */ React.createElement("p", { className: "vision-report-card__recommendation" }, report.recommendation));
  };
  const renderTabs = (room) => /* @__PURE__ */ React.createElement("div", { className: "detail-tabs" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `detail-tab ${detailTab === "transcript" ? "detail-tab--active" : ""}`,
      onClick: () => {
        setDetailTab("transcript");
        if (room?._id) {
          setRoomTabPrefs((prev) => ({ ...prev, [room._id]: "transcript" }));
        }
      }
    },
    "Transcript"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `detail-tab ${detailTab === "audio" ? "detail-tab--active" : ""}`,
      onClick: () => {
        setDetailTab("audio");
        if (room?._id) {
          setRoomTabPrefs((prev) => ({ ...prev, [room._id]: "audio" }));
        }
      }
    },
    "Audio"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `detail-tab ${detailTab === "vision" ? "detail-tab--active" : ""}`,
      onClick: () => {
        setDetailTab("vision");
        if (room?._id) {
          setRoomTabPrefs((prev) => ({ ...prev, [room._id]: "vision" }));
        }
      }
    },
    "Vision Report"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `detail-tab ${detailTab === "integrity" ? "detail-tab--active" : ""}`,
      onClick: () => {
        setDetailTab("integrity");
        if (room?._id) {
          setRoomTabPrefs((prev) => ({ ...prev, [room._id]: "integrity" }));
        }
      }
    },
    "Integrity"
  ), room?.status === "active" && /* @__PURE__ */ React.createElement("span", { className: "detail-tabs__hint" }, "Live updates enabled"));
  const renderTranscriptPanel = (room) => {
    const conversation = room?.messages && room.messages.length > 0 ? room.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)) : Array.isArray(room?.transcription?.segments) ? room.transcription.segments.map((seg) => ({
      role: "candidate",
      text: seg.text,
      timestamp: seg.timestamp,
      sentiment: seg.sentiment
    })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)) : [];
    return /* @__PURE__ */ React.createElement("div", { className: "tab-pane" }, /* @__PURE__ */ React.createElement("div", { className: "speech-history-section" }, /* @__PURE__ */ React.createElement("h4", null, "Interview Conversation"), conversation.length === 0 ? /* @__PURE__ */ React.createElement("p", { className: "no-speech-history" }, room?.status === "active" ? "Waiting for conversation to begin..." : "No conversation history saved for this room.") : /* @__PURE__ */ React.createElement("div", { className: "speech-history-list", style: { display: "flex", flexDirection: "column", gap: "1rem" } }, conversation.map((msg, index) => {
      const isAgent = msg.role === "agent";
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          key: `${msg.timestamp || "msg"}-${index}`,
          style: {
            alignSelf: isAgent ? "flex-start" : "flex-end",
            maxWidth: "80%",
            background: isAgent ? "#f1f5f9" : "#eff6ff",
            padding: "12px 16px",
            borderRadius: "12px",
            borderBottomLeftRadius: isAgent ? "4px" : "12px",
            borderBottomRightRadius: !isAgent ? "4px" : "12px",
            border: isAgent ? "1px solid #e2e8f0" : "1px solid #bfdbfe"
          }
        },
        /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "4px", fontSize: "12px", color: "#64748b" } }, /* @__PURE__ */ React.createElement("strong", { style: { color: isAgent ? "#475569" : "#1d4ed8" } }, isAgent ? "AI Agent" : "Candidate"), /* @__PURE__ */ React.createElement("span", null, formatTranscriptTime(msg.timestamp) || `Message ${index + 1}`)),
        /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "14px", color: "#1e293b", lineHeight: "1.5" } }, msg.text || getDisplayTranscriptText(msg)),
        !isAgent && msg.sentiment?.label && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "6px" } }, /* @__PURE__ */ React.createElement("span", { style: {
          fontSize: "11px",
          padding: "2px 6px",
          borderRadius: "12px",
          color: "white",
          backgroundColor: getSentimentColor(msg.sentiment.label)
        } }, msg.sentiment.label))
      );
    }))), room?.transcription?.text && /* @__PURE__ */ React.createElement("div", { className: "full-transcript-section" }, /* @__PURE__ */ React.createElement("h4", null, "Full Transcript"), /* @__PURE__ */ React.createElement("p", null, room.transcription.text)));
  };
  const renderAudioPanel = (room) => /* @__PURE__ */ React.createElement("div", { className: "tab-pane" }, getAnalysisState(room?._id).report?.audioAnalysis && /* @__PURE__ */ React.createElement("div", { className: "audio-analysis-summary" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Transcription"), /* @__PURE__ */ React.createElement("strong", null, getAnalysisState(room?._id).report.audioAnalysis.transcriptionAvailable ? "Available" : "Not available")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Long silence events"), /* @__PURE__ */ React.createElement("strong", null, getAnalysisState(room?._id).report.audioAnalysis.longSilenceEvents || 0)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", null, "Speaker change detected"), /* @__PURE__ */ React.createElement("strong", null, getAnalysisState(room?._id).report.audioAnalysis.speakerChangeDetected ? "Yes" : "No"))), /* @__PURE__ */ React.createElement("div", { className: "audio-player-section" }, /* @__PURE__ */ React.createElement("div", { className: "audio-player-header" }, /* @__PURE__ */ React.createElement("span", { className: "audio-player-title" }, "Interview Recording"), room?.recordingUrl && /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-download btn-dl-wav",
      onClick: () => downloadAudio(room),
      title: "Download audio file"
    },
    "\u2B07 Download"
  )), room?.recordingUrl ? /* @__PURE__ */ React.createElement(
    "audio",
    {
      className: "audio-player",
      controls: true,
      src: `${API_BASE}${room.recordingUrl}`,
      preload: "metadata"
    },
    "Your browser does not support the audio element."
  ) : /* @__PURE__ */ React.createElement("p", { className: "audio-unavailable" }, room?.status === "active" ? "Recording will be available after the call ends and upload completes." : "No recording available. Audio is saved when the candidate ends the call using End Call.")));
  const renderVisionPanel = (room) => /* @__PURE__ */ React.createElement("div", { className: "tab-pane" }, getAnalysisState(room?._id).report?.visionMonitoring || room?.visionMonitoring?.report ? getAnalysisState(room?._id).report?.visionMonitoring ? renderVisionReport({
    ...room,
    visionMonitoring: { ...room?.visionMonitoring || {}, report: getAnalysisState(room?._id).report.visionMonitoring }
  }) : renderVisionReport(room) : /* @__PURE__ */ React.createElement("div", { className: "vision-report-empty" }, /* @__PURE__ */ React.createElement("p", null, "Vision report is not available yet.", room?.status === "active" ? " It will appear after enough monitoring data is collected and the call is finalized." : "")));
  const renderIntegrityPanel = (room) => {
    const report = getAnalysisState(room?._id).report?.visionMonitoring || room?.visionMonitoring?.report;
    return /* @__PURE__ */ React.createElement("div", { className: "tab-pane" }, /* @__PURE__ */ React.createElement(RecruiterIntegrityReport, { report }));
  };
  const uploadInterviewVideo = async (roomId, file) => {
    if (!roomId || !file) return;
    patchAnalysisState(roomId, { uploading: true, error: "" });
    try {
      const form = new FormData();
      form.append("video", file);
      const response = await fetch(`${API_BASE}/api/interviews/${roomId}/video/upload`, {
        method: "POST",
        body: form
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Upload failed");
      }
      notify("Interview video uploaded", "success");
      patchAnalysisState(roomId, { uploading: false });
    } catch (error) {
      patchAnalysisState(roomId, { uploading: false, error: error.message || "Upload failed" });
      notify(error.message || "Upload failed", "error");
    }
  };
  const startPostInterviewAnalysis = async (roomId) => {
    if (!roomId) return;
    patchAnalysisState(roomId, { starting: true, error: "" });
    try {
      const response = await fetch(`${API_BASE}/api/interviews/${roomId}/analyze-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to start analysis");
      }
      patchAnalysisState(roomId, { starting: false });
      notify("Analysis started", "success");
    } catch (error) {
      patchAnalysisState(roomId, { starting: false, error: error.message || "Failed to start analysis" });
      notify(error.message || "Failed to start analysis", "error");
    }
  };
  const fetchAnalysisStatus = useCallback(async (roomId) => {
    if (!roomId) return null;
    patchAnalysisState(roomId, { statusLoading: true });
    try {
      const response = await fetch(`${API_BASE}/api/interviews/${roomId}/analysis-status`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Status unavailable");
      }
      patchAnalysisState(roomId, { statusLoading: false, status: data.job });
      return data.job;
    } catch (error) {
      patchAnalysisState(roomId, { statusLoading: false, error: error.message || "Status unavailable" });
      return null;
    }
  }, [patchAnalysisState]);
  const fetchFinalAnalysisReport = useCallback(async (roomId) => {
    if (!roomId) return;
    try {
      const response = await fetch(`${API_BASE}/api/interviews/${roomId}/final-report`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        return;
      }
      patchAnalysisState(roomId, { report: data.report, error: "" });
    } catch (_) {
    }
  }, [patchAnalysisState]);
  const fetchAnalysisStatusForRooms = useCallback(async (roomList) => {
    if (!Array.isArray(roomList) || roomList.length === 0) return;
    await Promise.all(
      roomList.map(async (room) => {
        try {
          const response = await fetch(`${API_BASE}/api/interviews/${room._id}/analysis-status`);
          const data = await response.json();
          if (response.ok && data.success) {
            patchAnalysisState(room._id, { status: data.job, error: "" });
          }
        } catch (_) {
        }
      })
    );
  }, [patchAnalysisState]);
  useEffect(() => {
    if (!selectedRoomId) return void 0;
    let stopped = false;
    let intervalId = null;
    const tick = async () => {
      if (stopped) return;
      const job = await fetchAnalysisStatus(selectedRoomId);
      if (!job) return;
      if (job.status === "completed") {
        await fetchFinalAnalysisReport(selectedRoomId);
      }
    };
    tick();
    intervalId = setInterval(tick, 3e3);
    return () => {
      stopped = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [selectedRoomId, fetchAnalysisStatus, fetchFinalAnalysisReport]);
  useEffect(() => {
    if (!rooms.length) return void 0;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await fetchAnalysisStatusForRooms(rooms);
    };
    tick();
    const intervalId = setInterval(tick, 1e4);
    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [rooms, fetchAnalysisStatusForRooms]);
  const downloadTxt = (room) => {
    const segments = room.transcription?.segments || [];
    const duration = room.recordingEndedAt ? Math.round((new Date(room.recordingEndedAt) - new Date(room.recordingStartedAt)) / 1e3) : 0;
    const lines = [
      "INTERVIEW TRANSCRIPT REPORT",
      "============================",
      `Room ID   : ${room.roomId}`,
      `Candidate : ${room.candidate?.email || "N/A"}`,
      `Date      : ${room.recordingEndedAt ? new Date(room.recordingEndedAt).toLocaleString() : "N/A"}`,
      `Duration  : ${duration} seconds`,
      `Sentiment : ${room.transcription?.overallSentiment?.label || "NEUTRAL"} (${(room.transcription?.overallSentiment?.score || 0).toFixed(2)})`,
      "",
      "SPEECH SEGMENTS",
      "---------------",
      ...segments.map((s) => `[${formatTranscriptTime(s.timestamp) || "??:??"}] (${s.sentiment?.label || "NEUTRAL"}) ${getDisplayTranscriptText(s)}`),
      "",
      "FULL TRANSCRIPT",
      "---------------",
      room.transcription?.text || "(no transcript)"
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript-${room.roomId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const downloadPdf = (room) => {
    const segments = room.transcription?.segments || [];
    const duration = room.recordingEndedAt ? Math.round((new Date(room.recordingEndedAt) - new Date(room.recordingStartedAt)) / 1e3) : 0;
    const sentColor = (label) => {
      if (label === "POSITIVE") return "#16a34a";
      if (label === "NEGATIVE") return "#dc2626";
      return "#64748b";
    };
    const fmtTime = (val) => {
      if (!val) return "";
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    const overallLabel = room.transcription?.overallSentiment?.label || "NEUTRAL";
    const overallScore = (room.transcription?.overallSentiment?.score || 0).toFixed(2);
    const segmentsHtml = segments.length === 0 ? '<p style="color:#94a3b8;font-size:13px">No segments recorded.</p>' : segments.map((s) => `
          <div style="display:flex;gap:12px;align-items:flex-start;padding:10px;background:#f8fafc;border-left:3px solid #5b86e5;margin-bottom:8px;border-radius:0 6px 6px 0">
            <span style="color:#64748b;font-size:11px;white-space:nowrap;min-width:44px">${fmtTime(s.timestamp) || "??:??"}</span>
            <span style="padding:2px 8px;border-radius:10px;color:#fff;font-size:10px;font-weight:700;background:${sentColor(s.sentiment?.label)};white-space:nowrap">${s.sentiment?.label || "NEUTRAL"}</span>
            <span style="font-size:13px;flex:1;color:#1e293b">${s.text}</span>
          </div>`).join("");
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Transcript \u2013 ${room.roomId}</title>
  <style>
    body{font-family:'Segoe UI',Arial,sans-serif;margin:40px;color:#1e293b}
    h1{color:#1e3a5f;border-bottom:2px solid #5b86e5;padding-bottom:10px;font-size:22px}
    .meta{background:#f0f4ff;border-radius:8px;padding:16px;margin:20px 0}
    .meta p{margin:6px 0;font-size:13px}
    h2{color:#334155;margin-top:28px;font-size:13px;text-transform:uppercase;letter-spacing:1px}
    .full{background:#f8fafc;padding:16px;border-radius:8px;font-size:13px;line-height:1.7;white-space:pre-wrap;color:#1e293b}
    @media print{body{margin:20px}}
  </style>
</head>
<body>
  <h1>Interview Transcript Report</h1>
  <div class="meta">
    <p><strong>Room ID:</strong> ${room.roomId}</p>
    <p><strong>Candidate:</strong> ${room.candidate?.email || "N/A"}</p>
    <p><strong>Date:</strong> ${room.recordingEndedAt ? new Date(room.recordingEndedAt).toLocaleString() : "N/A"}</p>
    <p><strong>Duration:</strong> ${duration} seconds</p>
    <p><strong>Overall Sentiment:</strong>
      <span style="display:inline-block;padding:3px 12px;border-radius:12px;color:#fff;font-weight:700;font-size:12px;background:${sentColor(overallLabel)}">${overallLabel} (${overallScore})</span>
    </p>
  </div>
  <h2>Speech Segments</h2>
  ${segmentsHtml}
  <h2>Full Transcript</h2>
  <div class="full">${room.transcription?.text || "(no transcript)"}</div>
</body>
</html>`;
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;border:none;opacity:0;";
    document.body.appendChild(iframe);
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.onafterprint = () => document.body.removeChild(iframe);
    iframe.contentWindow.print();
  };
  const downloadAudio = (room) => {
    if (!room.recordingUrl) {
      notify("No audio recording available for this room.", "error");
      return;
    }
    const a = document.createElement("a");
    a.href = `${API_BASE}${room.recordingUrl}`;
    const ext = room.recordingUrl.split(".").pop() || "webm";
    a.download = `recording-${room.roomId}.${ext}`;
    a.click();
  };
  const selectedTranscriptSegments = Array.isArray(selectedRoom?.transcription?.segments) ? selectedRoom.transcription.segments : [];
  const displayedTranscriptSegments = transcription.length > 0 ? transcription : selectedTranscriptSegments;
  if (loading) {
    return /* @__PURE__ */ React.createElement(PublicLayout, null, /* @__PURE__ */ React.createElement("div", { className: "loading" }, "Loading rooms..."));
  }
  return /* @__PURE__ */ React.createElement(PublicLayout, null, /* @__PURE__ */ React.createElement("div", { className: "call-room-dashboard" }, notification && /* @__PURE__ */ React.createElement("div", { className: `call-room-notification call-room-notification--${notification.type}` }, notification.msg), /* @__PURE__ */ React.createElement("div", { className: "dashboard-header" }, /* @__PURE__ */ React.createElement("h1", null, "Interview Call Rooms"), /* @__PURE__ */ React.createElement("div", { className: "dashboard-header__actions" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-reset-tabs",
      onClick: resetTabPreferences,
      title: "Clear saved tab selection per room"
    },
    "Reset tab preferences"
  ), /* @__PURE__ */ React.createElement("button", { className: "btn-primary", onClick: () => createRoom() }, "+ Create New Room"))), /* @__PURE__ */ React.createElement("div", { className: "dashboard-content" }, /* @__PURE__ */ React.createElement("div", { className: "room-list-panel" }, /* @__PURE__ */ React.createElement("h2", null, "Your Rooms"), /* @__PURE__ */ React.createElement("div", { className: "rooms-container" }, rooms.length === 0 ? /* @__PURE__ */ React.createElement("p", { className: "empty-state" }, "No rooms yet. Create one to get started!") : rooms.map((room) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: room._id,
      className: `room-item ${selectedRoomId === room._id ? "active" : ""} ${room.status === "waiting_confirmation" && room.candidate ? "room-item--has-request" : ""}`,
      onClick: () => setSelectedRoomId(room._id)
    },
    /* @__PURE__ */ React.createElement("div", { className: "room-header" }, /* @__PURE__ */ React.createElement("span", { className: "room-id", title: room.roomId }, room.roomId), /* @__PURE__ */ React.createElement("div", { className: "room-header-actions" }, renderRoomStatus(room), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "btn-delete-room",
        onClick: (event) => {
          event.stopPropagation();
          deleteRoom(room._id);
        },
        title: "Supprimer la room"
      },
      "\u{1F5D1} Delete"
    ))),
    /* @__PURE__ */ React.createElement("div", { className: "room-details" }, room.candidate && /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Candidate"), " ", room.candidate.email), room.job && /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Job"), " ", room.job.title), /* @__PURE__ */ React.createElement("p", { className: "created-time" }, /* @__PURE__ */ React.createElement("strong", null, "Created"), " ", new Date(room.createdAt).toLocaleString()), getAnalysisState(room._id).status?.status && /* @__PURE__ */ React.createElement("div", { className: `analysis-badge analysis-badge--${String(getAnalysisState(room._id).status.status || "unknown").toLowerCase()}` }, "Analysis: ", String(getAnalysisState(room._id).status.status || "unknown"), typeof getAnalysisState(room._id).status.progress === "number" ? ` (${getAnalysisState(room._id).status.progress}%)` : ""), renderVisionMini(room))
  )))), selectedRoom && /* @__PURE__ */ React.createElement("div", { className: "room-details-panel" }, /* @__PURE__ */ React.createElement("div", { className: "panel-header" }, /* @__PURE__ */ React.createElement("h2", null, "Room: ", selectedRoom.roomId), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-close",
      onClick: () => setSelectedRoomId(null)
    },
    "\xD7"
  )), selectedRoom.status === "ended" && /* @__PURE__ */ React.createElement("div", { className: "download-toolbar" }, /* @__PURE__ */ React.createElement("span", { className: "download-label" }, "Download:"), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-download btn-dl-txt",
      onClick: () => downloadTxt(selectedRoom),
      title: "Download transcript as .txt"
    },
    "\u{1F4C4} TXT"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-download btn-dl-pdf",
      onClick: () => downloadPdf(selectedRoom),
      title: "Print / save transcript as PDF"
    },
    "\u{1F4D1} PDF"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `btn-download btn-dl-wav${selectedRoom.recordingUrl ? "" : " btn-dl-wav--unavailable"}`,
      onClick: () => downloadAudio(selectedRoom),
      title: selectedRoom.recordingUrl ? "Download audio recording" : "Audio not available"
    },
    "\u{1F3B5} Audio",
    !selectedRoom.recordingUrl && /* @__PURE__ */ React.createElement("span", { className: "dl-unavail-hint" }, " (N/A)")
  )), /* @__PURE__ */ React.createElement("div", { className: "analysis-toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "analysis-toolbar__left" }, /* @__PURE__ */ React.createElement("span", { className: "analysis-toolbar__title" }, "Post-Interview Multimodal Analysis"), getAnalysisState(selectedRoom._id).status ? /* @__PURE__ */ React.createElement("span", { className: "analysis-toolbar__status" }, String(getAnalysisState(selectedRoom._id).status.status || "unknown").toUpperCase(), typeof getAnalysisState(selectedRoom._id).status.progress === "number" ? ` \xB7 ${getAnalysisState(selectedRoom._id).status.progress}%` : "", getAnalysisState(selectedRoom._id).status.currentStep ? ` \xB7 ${getAnalysisState(selectedRoom._id).status.currentStep}` : "") : /* @__PURE__ */ React.createElement("span", { className: "analysis-toolbar__status" }, "No analysis job yet")), /* @__PURE__ */ React.createElement("div", { className: "analysis-toolbar__actions" }, /* @__PURE__ */ React.createElement("label", { className: `analysis-upload-btn ${getAnalysisState(selectedRoom._id).uploading ? "analysis-upload-btn--busy" : ""}` }, getAnalysisState(selectedRoom._id).uploading ? "Uploading..." : "Upload Interview Video", /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "file",
      accept: "video/*",
      onChange: (event) => {
        const file = event.target.files?.[0];
        if (file) {
          void uploadInterviewVideo(selectedRoom._id, file);
        }
        event.target.value = "";
      },
      disabled: getAnalysisState(selectedRoom._id).uploading
    }
  )), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "analysis-start-btn",
      onClick: () => startPostInterviewAnalysis(selectedRoom._id),
      disabled: getAnalysisState(selectedRoom._id).starting
    },
    getAnalysisState(selectedRoom._id).starting ? "Starting..." : "Start Analysis"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "analysis-refresh-btn",
      onClick: () => {
        void fetchAnalysisStatus(selectedRoom._id);
        void fetchFinalAnalysisReport(selectedRoom._id);
      }
    },
    "Refresh"
  )), getAnalysisState(selectedRoom._id).error && /* @__PURE__ */ React.createElement("div", { className: "analysis-toolbar__error" }, getAnalysisState(selectedRoom._id).error)), selectedRoom.status === "waiting_confirmation" && !selectedRoom.candidate && /* @__PURE__ */ React.createElement("div", { className: "waiting-section" }, /* @__PURE__ */ React.createElement("div", { className: "waiting-icon" }, "\u23F3"), /* @__PURE__ */ React.createElement("p", { className: "waiting-text" }, "Waiting for a candidate to request access\u2026"), /* @__PURE__ */ React.createElement("p", { className: "waiting-hint" }, "Share the room ID ", /* @__PURE__ */ React.createElement("strong", null, selectedRoom.roomId), " with the candidate.")), selectedRoom.status === "waiting_confirmation" && selectedRoom.candidate && /* @__PURE__ */ React.createElement("div", { className: "candidate-request-section" }, /* @__PURE__ */ React.createElement("h3", null, "Candidate Join Request"), /* @__PURE__ */ React.createElement("div", { className: "candidate-info" }, /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Email:"), " ", selectedRoom.candidate.email), /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Requested At:"), " ", new Date(selectedRoom.candidateJoinRequestedAt).toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "action-buttons" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-confirm",
      onClick: () => confirmCandidateJoin(selectedRoom._id)
    },
    "Confirm & Start Recording"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-reject",
      onClick: () => rejectCandidateJoin(selectedRoom._id)
    },
    "Reject"
  ))), selectedRoom.status === "active" && /* @__PURE__ */ React.createElement("div", { className: "active-call-section" }, /* @__PURE__ */ React.createElement("div", { className: "recording-indicator" }, /* @__PURE__ */ React.createElement("span", { className: "recording-dot" }), "Recording Active"), /* @__PURE__ */ React.createElement("div", { className: "sentiment-badge", style: { backgroundColor: getSentimentColor(overallSentiment.label) } }, overallSentiment.label, " (", (overallSentiment.score || 0).toFixed(2), ")"), renderTabs(selectedRoom), detailTab === "transcript" && renderTranscriptPanel(selectedRoom), detailTab === "audio" && renderAudioPanel(selectedRoom), detailTab === "vision" && renderVisionPanel(selectedRoom), detailTab === "integrity" && renderIntegrityPanel(selectedRoom), /* @__PURE__ */ React.createElement("div", { style: { margin: "16px 0" } }, /* @__PURE__ */ React.createElement(
    AgentChatPanel,
    {
      socket: socketClient,
      roomId: selectedRoom.roomId,
      roomDbId: selectedRoom._id,
      isRH: true
    }
  )), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn-end-call",
      onClick: () => endCall(selectedRoom._id)
    },
    "End Call"
  )), selectedRoom.status === "ended" && /* @__PURE__ */ React.createElement("div", { className: "ended-call-section" }, /* @__PURE__ */ React.createElement("h3", null, "Call Summary"), /* @__PURE__ */ React.createElement("div", { className: "summary-info" }, /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Duration:"), " ", selectedRoom.recordingEndedAt ? Math.round((new Date(selectedRoom.recordingEndedAt) - new Date(selectedRoom.recordingStartedAt)) / 1e3) : 0, " ", "seconds"), /* @__PURE__ */ React.createElement("p", null, /* @__PURE__ */ React.createElement("strong", null, "Final Sentiment:"), " ", /* @__PURE__ */ React.createElement("span", { style: { color: getSentimentColor(selectedRoom.transcription?.overallSentiment?.label) } }, selectedRoom.transcription?.overallSentiment?.label))), renderTabs(selectedRoom), detailTab === "transcript" && renderTranscriptPanel(selectedRoom), detailTab === "audio" && renderAudioPanel(selectedRoom), detailTab === "vision" && renderVisionPanel(selectedRoom), detailTab === "integrity" && renderIntegrityPanel(selectedRoom))))));
};
export default CallRoomDashboard;
