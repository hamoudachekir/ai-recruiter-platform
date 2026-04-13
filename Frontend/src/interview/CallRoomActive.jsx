import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import PublicLayout from '../layouts/PublicLayout';
import './CallRoomActive.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const SPEECH_STACK_URL = import.meta.env.VITE_SPEECH_STACK_URL || 'http://localhost:8012';
const RECORDING_SLICE_MS = 6000;
const MIN_AUDIO_BLOB_BYTES = 4096;

const isTokenExpired = (jwtToken) => {
  if (!jwtToken) return true;

  try {
    const payload = JSON.parse(atob(jwtToken.split('.')[1] || ''));
    if (!payload?.exp) return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
};

const CallRoomActive = () => {
  const { roomId } = useParams();
  const [room, setRoom] = useState(null);
  const [roomDbId, setRoomDbId] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isRH, setIsRH] = useState(false);
  const [loading, setLoading] = useState(true);
  
  const mediaRecorderRef = useRef(null);  // per-cycle recorder (transcription)
  const fullRecorderRef = useRef(null);   // single long-running recorder (full call)
  const audioChunksRef = useRef([]);
  const allAudioChunksRef = useRef([]);  // chunks from the full recorder
  const allMimeTypeRef = useRef('');     // mimeType for the full recording blob
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const recordingActiveRef = useRef(false);
  const cycleTimerRef = useRef(null);
  const lastTranscriptRef = useRef('');

  const token = localStorage.getItem('token');
  const userId = localStorage.getItem('userId');

  // Fetch room details
  useEffect(() => {
    const fetchRoom = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(roomId)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success) {
          setRoom(data.room);
          setRoomDbId(data.room._id);
          setIsRH(data.room.initiator._id === userId);
          setLoading(false);
        }
      } catch (error) {
        console.error('Failed to fetch room:', error);
      }
    };

    fetchRoom();
  }, [roomId, token, userId]);

  // Set up Socket.IO
  useEffect(() => {
    if (!token || isTokenExpired(token)) {
      return undefined;
    }

    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1200,
    });

    socketRef.current.on('connect_error', (error) => {
      if (error?.message === 'TOKEN_EXPIRED') {
        console.warn('Socket session expired in active room. Please login again.');
        socketRef.current?.disconnect();
      }
    });

    // Join room-specific channel
    socketRef.current.emit('join-room', { roomId });

    // Listen for transcription updates
    socketRef.current.on('transcription-update', ({ segment, sentiment }) => {
      console.log('Received transcription update:', segment);
    });

    // Listen for call end
    socketRef.current.on('call-room-ended', () => {
      alert('Call ended by other party');
      // Redirect or close
    });

    return () => {
      recordingActiveRef.current = false;
      if (cycleTimerRef.current) {
        clearTimeout(cycleTimerRef.current);
        cycleTimerRef.current = null;
      }
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (fullRecorderRef.current?.state === 'recording') {
        fullRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach(track => track.stop());
      socketRef.current?.off('connect_error');
      socketRef.current?.disconnect();
    };
  }, [roomId, token]);

  const stopMicrophoneStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const getRecorderMimeType = () => {
    const preferredTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/ogg',
    ];
    return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  };

  const startRecorderCycle = () => {
    if (!streamRef.current || !recordingActiveRef.current) {
      return;
    }

    const mimeType = getRecorderMimeType();
    const mediaRecorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);

    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunksRef.current.push(event.data);
        // NOTE: full recording is handled by fullRecorderRef, not here
      }
    };

    mediaRecorder.onstop = async () => {
      const chunkBlob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
      audioChunksRef.current = [];

      if (chunkBlob.size >= MIN_AUDIO_BLOB_BYTES) {
        await sendAudioToSpeechStack(chunkBlob);
      }

      if (recordingActiveRef.current) {
        startRecorderCycle();
      } else {
        stopMicrophoneStream();
      }
    };

    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.start();

    cycleTimerRef.current = setTimeout(() => {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, RECORDING_SLICE_MS);
  };

  // Start audio recording
  const startRecording = async () => {
    try {
      if (recordingActiveRef.current) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordingActiveRef.current = true;
      lastTranscriptRef.current = '';

      // ── Full-call recorder (one continuous session = valid single WebM) ──
      const mimeType = getRecorderMimeType();
      allMimeTypeRef.current = mimeType || 'audio/webm';
      allAudioChunksRef.current = [];

      const fullRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      fullRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          allAudioChunksRef.current.push(event.data);
        }
      };
      fullRecorderRef.current = fullRecorder;
      fullRecorder.start();   // no timeslice → one big blob on stop()

      // ── Per-cycle recorder for transcription ───────────────────────────
      startRecorderCycle();
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to access microphone');
    }
  };

  const stopRecording = () => {
    recordingActiveRef.current = false;
    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      stopMicrophoneStream();
    }

    // Stop the full-call recorder — triggers ondataavailable then onstop
    if (fullRecorderRef.current?.state === 'recording') {
      fullRecorderRef.current.stop();
    }

    setIsRecording(false);
  };

  // Resolves once the full-call recorder's onstop fires (data is ready)
  const waitForFullRecording = () =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      const rec = fullRecorderRef.current;
      if (!rec || rec.state === 'inactive') { done(); return; }

      rec.addEventListener('stop', done, { once: true });
      setTimeout(done, 8000); // safety fallback
    });

  const sendAudioToSpeechStack = async (audioBlob) => {
    try {
      const formData = new FormData();
      const ext = audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
      formData.append('audio', audioBlob, `recording.${ext}`);

      const response = await fetch(`${SPEECH_STACK_URL}/api/transcribe-sentiment`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Speech stack request failed:', response.status, errText);
        return;
      }

      const data = await response.json();
      const text = (data?.transcription?.text || '').trim();
      const sentiment = data?.overall_sentiment || { label: 'NEUTRAL', score: 0 };

      if (text && roomDbId) {
        lastTranscriptRef.current = text;

        // Send transcription to backend
        await fetch(`${API_BASE}/api/call-rooms/${roomDbId}/update-transcription`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            segment: { text, timestamp: new Date() },
            sentiment
          })
        });

        // Emit via socket
        socketRef.current?.emit('update-call-transcription', {
          roomId,
          roomDbId,
          segment: { text, timestamp: new Date() },
          sentiment
        });
      }
    } catch (error) {
      console.error('Failed to send audio to Speech Stack:', error);
    }
  };

  const uploadRecording = async (dbId) => {
    if (!allAudioChunksRef.current.length) return;
    try {
      const mimeType = allMimeTypeRef.current || 'audio/webm';
      const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
      const fullBlob = new Blob(allAudioChunksRef.current, { type: mimeType });
      const formData = new FormData();
      formData.append('audio', fullBlob, `recording.${ext}`);
      await fetch(`${API_BASE}/api/call-rooms/${dbId}/upload-audio`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
    } catch (error) {
      console.error('Failed to upload recording:', error);
    }
  };

  const endCall = async () => {
    try {
      // Stop both recorders, then wait until the full-call recorder has
      // flushed its data (ondataavailable + onstop) before we upload.
      if (recordingActiveRef.current || fullRecorderRef.current?.state === 'recording') {
        stopRecording();
        await waitForFullRecording();
      }

      const response = await fetch(`${API_BASE}/api/call-rooms/${roomDbId}/end-call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        // allAudioChunksRef is fully populated now — upload in background
        uploadRecording(roomDbId);
        socketRef.current?.emit('end-call-room', { roomId, roomDbId });
        alert('Call ended');
        globalThis.history.back();
      }
    } catch (error) {
      console.error('Failed to end call:', error);
    }
  };

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading">Loading call room...</div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="call-room-active">
        <div className="call-header">
          <h1>Interview Call - {room?.roomId}</h1>
          <div className="call-info">
            <span className="badge-recording">🔴 Recording</span>
            <span className="call-duration">Duration: {room?.recordingStartedAt ? Math.round((new Date() - new Date(room.recordingStartedAt)) / 1000) : 0}s</span>
          </div>
        </div>

        <div className="call-container">
          {/* Audio Controls */}
          <div className="audio-section">
            <div className="microphone-indicator">
              <div className={`indicator-dot ${isRecording ? 'recording' : ''}`}></div>
              {isRecording ? 'Microphone Active' : 'Microphone Off'}
            </div>

            <div className="control-buttons">
              {!isRecording ? (
                <button className="btn-start-recording" onClick={startRecording}>
                  🎤 Start Recording
                </button>
              ) : (
                <button className="btn-stop-recording" onClick={stopRecording}>
                  ⏹ Stop Recording
                </button>
              )}

              <button className="btn-end-call" onClick={endCall} disabled={!roomDbId}>
                📞 End Call
              </button>
            </div>
          </div>

          {/* RH Dashboard - Transcription View */}
          {isRH && (
            <div className="rh-dashboard">
              <div className="dashboard-header">
                <h2>Interview Dashboard</h2>
                <span className="candidate-info">
                  Candidate: {room?.candidate?.email}
                </span>
              </div>

              <div className="transcription-panel">
                <h3>Live Transcription & Sentiment</h3>
                <div className="transcription-feed">
                  {room?.transcription?.segments?.length === 0 ? (
                    <p className="placeholder">Waiting for audio...</p>
                  ) : (
                    room?.transcription?.segments?.map((segment, idx) => (
                      <div key={idx} className="transcript-item">
                        <span className="segment-text">{segment.text}</span>
                        <span
                          className="segment-sentiment"
                          style={{
                            backgroundColor: segment.sentiment?.label === 'POSITIVE' ? '#4CAF50' :
                                           segment.sentiment?.label === 'NEGATIVE' ? '#f44336' : '#9E9E9E'
                          }}
                        >
                          {segment.sentiment?.label}
                        </span>
                        <span className="segment-time">
                          {new Date(segment.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {room?.transcription?.overallSentiment && (
                  <div className="overall-sentiment">
                    <p><strong>Overall Sentiment:</strong></p>
                    <div
                      className="sentiment-badge"
                      style={{
                        backgroundColor: room.transcription.overallSentiment.label === 'POSITIVE' ? '#4CAF50' :
                                       room.transcription.overallSentiment.label === 'NEGATIVE' ? '#f44336' : '#9E9E9E'
                      }}
                    >
                      {room.transcription.overallSentiment.label} ({(room.transcription.overallSentiment.score || 0).toFixed(2)})
                    </div>
                  </div>
                )}

                {room?.transcription?.text && (
                  <div className="full-transcript">
                    <p><strong>Full Transcript:</strong></p>
                    <textarea readOnly value={room.transcription.text} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Candidate View */}
          {!isRH && (
            <div className="candidate-view">
              <div className="interviewer-avatar">
                <div className="avatar-circle">
                  {(room?.initiator?.firstName?.[0] ?? '') + (room?.initiator?.lastName?.[0] ?? '')}
                </div>
                <div className="avatar-status"></div>
              </div>

              <h2 className="interviewer-name">
                {room?.initiator?.firstName} {room?.initiator?.lastName}
              </h2>
              <p className="interviewer-role">Interviewer</p>

              <div className="call-status-badge">
                <span className="status-live-dot"></span>
                Interview in Progress
              </div>

              {isRecording && (
                <div className="waveform">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className={`wave-bar wave-bar-${i}`}></div>
                  ))}
                </div>
              )}

              <p className="candidate-hint">
                {isRecording
                  ? 'Your audio is being captured and analyzed in real time'
                  : 'Click "Start Recording" when ready to begin the interview'}
              </p>
            </div>
          )}
        </div>
      </div>
    </PublicLayout>
  );
};

export default CallRoomActive;
