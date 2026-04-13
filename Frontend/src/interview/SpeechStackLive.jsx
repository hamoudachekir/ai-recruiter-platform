import { useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_SPEECH_STACK_API || "http://127.0.0.1:8012";

const pickMimeType = () => {
  if (typeof MediaRecorder === "undefined") return "";
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || "";
};

const extractDeltaText = (previous, current) => {
  const prev = String(previous || "").trim();
  const curr = String(current || "").trim();
  if (!curr) return "";
  if (!prev) return curr;
  if (curr.startsWith(prev)) return curr.slice(prev.length).trim();

  // Fallback for recognition drift: find longest suffix/prefix overlap.
  const maxOverlap = Math.min(prev.length, curr.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.slice(-overlap) === curr.slice(0, overlap)) {
      return curr.slice(overlap).trim();
    }
  }

  return curr;
};

const SpeechStackLive = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [segments, setSegments] = useState([]);
  const [overallSentiment, setOverallSentiment] = useState(null);
  const [ttsText, setTtsText] = useState("");
  const [ttsAudioUrl, setTtsAudioUrl] = useState("");

  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const audioChunksRef = useRef([]);
  const uploadInFlightRef = useRef(false);
  const uploadIntervalRef = useRef(null);
  const lastTranscriptRef = useRef("");
  const recordingStartTsRef = useRef(0);
  const mimeTypeRef = useRef("audio/webm");

  const fullText = useMemo(() => {
    return segments.map((s) => s.text).filter(Boolean).join(" ").trim();
  }, [segments]);

  const sentimentSummary = useMemo(() => {
    const counts = {
      POSITIVE: 0,
      NEUTRAL: 0,
      NEGATIVE: 0,
    };

    for (const segment of segments) {
      const rawLabel = String(segment?.sentiment?.label || "NEUTRAL").toUpperCase();
      if (rawLabel === "POSITIVE" || rawLabel === "NEUTRAL" || rawLabel === "NEGATIVE") {
        counts[rawLabel] += 1;
      } else {
        counts.NEUTRAL += 1;
      }
    }

    const total = counts.POSITIVE + counts.NEUTRAL + counts.NEGATIVE;
    const dominant =
      total > 0
        ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
        : String(overallSentiment?.label || "NEUTRAL").toUpperCase();

    return { counts, total, dominant };
  }, [segments, overallSentiment]);

  const sentimentBadgeStyles = {
    POSITIVE: { background: "#e8f7ef", color: "#0b7a3a", border: "#bde6ce" },
    NEUTRAL: { background: "#eff2f7", color: "#3d4a5d", border: "#d6dce7" },
    NEGATIVE: { background: "#fdeeee", color: "#a22222", border: "#f4caca" },
  };

  const percentFor = (value) => {
    if (!sentimentSummary.total) return 0;
    return Math.round((value / sentimentSummary.total) * 100);
  };

  const appendDeltaSegment = (text, sentiment) => {
    if (!text) return;

    const now = Date.now();
    const sinceStart = recordingStartTsRef.current
      ? (now - recordingStartTsRef.current) / 1000
      : 0;
    const duration = Math.max(0.8, Math.min(2.0, text.split(/\s+/).filter(Boolean).length * 0.35));

    setSegments((previous) => [
      ...previous,
      {
        start: Math.max(0, sinceStart - duration),
        end: sinceStart,
        text,
        sentiment: sentiment || { label: "NEUTRAL", score: 0 },
      },
    ]);
  };

  const analyzeDeltaSentiment = async (text) => {
    const clean = String(text || "").trim();
    if (!clean) return { label: "NEUTRAL", score: 0 };

    const response = await fetch(`${API_BASE}/api/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();
    return payload || { label: "NEUTRAL", score: 0 };
  };

  const uploadSnapshot = async (blob) => {
    const formData = new FormData();
    const ext = mimeTypeRef.current.includes("ogg") ? "ogg" : "webm";
    formData.append("audio", blob, `chunk-${chunkIndexRef.current++}.${ext}`);

    const response = await fetch(`${API_BASE}/api/transcribe-sentiment`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();
    setOverallSentiment(payload?.overall_sentiment || null);

    const currentText = String(payload?.transcription?.text || "").trim();
    const deltaText = extractDeltaText(lastTranscriptRef.current, currentText);
    lastTranscriptRef.current = currentText;

    if (deltaText) {
      let deltaSentiment = payload?.overall_sentiment || null;
      try {
        deltaSentiment = await analyzeDeltaSentiment(deltaText);
      } catch {
        // Keep rolling even if one sentiment call fails.
      }

      appendDeltaSegment(deltaText, deltaSentiment);
      setOverallSentiment(deltaSentiment);
      setTtsText((prev) => {
        if (!prev) return deltaText;
        return `${prev} ${deltaText}`.trim();
      });
    }
  };

  const processRollingUpload = async () => {
    if (uploadInFlightRef.current) return;
    if (audioChunksRef.current.length === 0) return;

    uploadInFlightRef.current = true;
    try {
      const blob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current || "audio/webm" });
      setStatus("Recording... (live analyzing)");
      await uploadSnapshot(blob);
      setStatus("Recording...");
    } catch (err) {
      setError(String(err?.message || err));
      setStatus("Recording... (chunk skipped)");
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  const startRecording = async () => {
    setError("");
    setStatus("Requesting microphone...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = pickMimeType();
      mimeTypeRef.current = mimeType || "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        audioChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        setStatus("Stopped");
      };

      setSegments([]);
      setOverallSentiment(null);
      setTtsAudioUrl("");
      chunkIndexRef.current = 0;
      audioChunksRef.current = [];
      uploadInFlightRef.current = false;
      lastTranscriptRef.current = "";
      recordingStartTsRef.current = Date.now();

      recorder.start(1500);
      mediaRecorderRef.current = recorder;
      if (uploadIntervalRef.current) {
        clearInterval(uploadIntervalRef.current);
      }
      uploadIntervalRef.current = setInterval(() => {
        processRollingUpload();
      }, 1700);
      setIsRecording(true);
      setStatus("Recording...");
    } catch (err) {
      setError(String(err?.message || err));
      setStatus("Microphone access failed");
    }
  };

  const stopRecording = () => {
    if (uploadIntervalRef.current) {
      clearInterval(uploadIntervalRef.current);
      uploadIntervalRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.requestData();
      } catch {
        // requestData may fail depending on recorder state; stopping still works.
      }
      mediaRecorderRef.current.stop();
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    setIsRecording(false);

    // Try one final upload from accumulated audio after stopping.
    processRollingUpload();
  };

  const generateTts = async () => {
    const text = ttsText.trim();
    if (!text) {
      setError("TTS text is empty.");
      return;
    }

    setError("");
    setStatus("Generating TTS...");

    try {
      const response = await fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || `HTTP ${response.status}`);
      }

      const wavBlob = await response.blob();
      const nextUrl = URL.createObjectURL(wavBlob);
      setTtsAudioUrl(nextUrl);
      setStatus("TTS ready");
    } catch (err) {
      setError(String(err?.message || err));
      setStatus("TTS failed");
    }
  };

  const currentLabel = String(overallSentiment?.label || sentimentSummary.dominant || "NEUTRAL").toUpperCase();
  const currentBadge = sentimentBadgeStyles[currentLabel] || sentimentBadgeStyles.NEUTRAL;

  return (
    <div style={{ maxWidth: 1180, margin: "24px auto", padding: 16 }}>
      <h2>Speech Stack Live (STT + Sentiment)</h2>
      <p>API: {API_BASE}</p>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 700px", minWidth: 320 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={startRecording} disabled={isRecording}>
              Start Recording
            </button>
            <button type="button" onClick={stopRecording} disabled={!isRecording}>
              Stop Recording
            </button>
          </div>

          <p><strong>Status:</strong> {status}</p>
          {error ? <p style={{ color: "#b00020" }}><strong>Error:</strong> {error}</p> : null}

          <div style={{ marginBottom: 12 }}>
            <strong>Overall sentiment:</strong>{" "}
            {overallSentiment
              ? `${overallSentiment.label} (${Number(overallSentiment.score || 0).toFixed(2)})`
              : "N/A"}
          </div>

          <div style={{ marginBottom: 12 }}>
            <strong>Live segments</strong>
            <pre style={{ background: "#f5f6f8", padding: 12, maxHeight: 300, overflow: "auto" }}>
              {segments.length === 0
                ? "No segments yet."
                : segments
                    .map(
                      (s) =>
                        `[${s.start.toFixed(2)}s -> ${s.end.toFixed(2)}s] ${s.text} | sentiment=${s.sentiment.label} (${Number(
                          s.sentiment.score || 0,
                        ).toFixed(2)})`,
                    )
                    .join("\n")}
            </pre>
          </div>

          <div style={{ marginBottom: 12 }}>
            <strong>Final text</strong>
            <textarea
              value={ttsText || fullText}
              onChange={(e) => setTtsText(e.target.value)}
              style={{ width: "100%", minHeight: 120 }}
            />
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" onClick={generateTts}>Generate TTS</button>
            {ttsAudioUrl ? <audio controls src={ttsAudioUrl} /> : null}
          </div>
        </div>

        <aside
          style={{
            flex: "0 1 320px",
            minWidth: 280,
            background: "#f8f9fc",
            border: "1px solid #e2e6ef",
            borderRadius: 12,
            padding: 14,
          }}
        >
          <h3 style={{ margin: "0 0 10px" }}>User sentiment</h3>
          <div
            style={{
              display: "inline-block",
              padding: "6px 12px",
              borderRadius: 999,
              fontWeight: 700,
              background: currentBadge.background,
              color: currentBadge.color,
              border: `1px solid ${currentBadge.border}`,
            }}
          >
            {currentLabel}
          </div>
          <div style={{ marginTop: 10, color: "#556070", fontSize: 14 }}>
            Score: {Number(overallSentiment?.score || 0).toFixed(2)}
          </div>

          <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
            {[
              { key: "POSITIVE", label: "Positive" },
              { key: "NEUTRAL", label: "Neutral" },
              { key: "NEGATIVE", label: "Negative" },
            ].map((item) => {
              const count = sentimentSummary.counts[item.key];
              const pct = percentFor(count);
              const tones = sentimentBadgeStyles[item.key] || sentimentBadgeStyles.NEUTRAL;

              return (
                <div key={item.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                    <span>{item.label}</span>
                    <span>{count} ({pct}%)</span>
                  </div>
                  <div style={{ height: 8, background: "#e9edf5", borderRadius: 999, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: tones.color,
                        transition: "width 150ms ease",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default SpeechStackLive;
