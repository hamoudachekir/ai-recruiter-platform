import { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import PublicLayout from '../layouts/PublicLayout';
import './CallRoomDashboard.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

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

const CallRoomDashboard = () => {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [overallSentiment, setOverallSentiment] = useState({ label: 'NEUTRAL', score: 0 });
  const socketRef = useRef(null);

  const token = localStorage.getItem('token');

  // Fetch RH's rooms
  useEffect(() => {
    const fetchRooms = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/rh/my-rooms`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success) {
          setRooms(data.rooms);
        }
      } catch (error) {
        console.error('Failed to fetch rooms:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchRooms();
  }, [token]);

  // Socket.IO for real-time updates
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
        console.warn('Socket session expired on dashboard. Please login again.');
        socketRef.current?.disconnect();
      }
    });

    socketRef.current.on('candidate-join-request', ({ roomId, candidateId }) => {
      console.log(`Candidate ${candidateId} requesting to join room ${roomId}`);
      // Refresh room details
      setRooms(prev => prev.map(r => r._id === roomId ? { ...r, reload: true } : r));
    });

    socketRef.current.on('transcription-update', ({ text, segment, sentiment }) => {
      if (segment) {
        setTranscription(prev => [...prev, segment]);
      }
      if (sentiment) {
        setOverallSentiment(sentiment);
      }
    });

    return () => {
      socketRef.current?.off('connect_error');
      socketRef.current?.disconnect();
    };
  }, [token]);

  // Poll selected active room as a fallback so RH always sees updates,
  // even if a socket event is missed.
  useEffect(() => {
    if (!selectedRoom?._id || selectedRoom?.status !== 'active') {
      return undefined;
    }

    const fetchRoomDetails = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/${selectedRoom._id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success && data.room) {
          setSelectedRoom(data.room);
          if (Array.isArray(data.room?.transcription?.segments)) {
            setTranscription(data.room.transcription.segments);
          }
          if (data.room?.transcription?.overallSentiment) {
            setOverallSentiment(data.room.transcription.overallSentiment);
          }
        }
      } catch (error) {
        // Keep UI resilient if one polling call fails.
      }
    };

    fetchRoomDetails();
    const intervalId = setInterval(fetchRoomDetails, 2500);

    return () => clearInterval(intervalId);
  }, [selectedRoom?._id, selectedRoom?.status, token]);

  const createRoom = async (jobId = null) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jobId })
      });

      const data = await response.json();
      if (data.success) {
        setRooms(prev => [data.room, ...prev]);
        socketRef.current?.emit('call-room-created', { 
          roomId: data.room.roomId, 
          room: data.room 
        });
        alert(`Room created! ID: ${data.room.roomId}`);
      }
    } catch (error) {
      console.error('Failed to create room:', error);
      alert('Failed to create room');
    }
  };

  const confirmCandidateJoin = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/confirm-join`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setRooms(prev => prev.map(r => r._id === roomId ? data.room : r));
        const candidateId = data.room?.candidate?._id || data.room?.candidate;
        socketRef.current?.emit('confirm-candidate-join', { 
          roomId: data.room.roomId,
          roomDbId: roomId,
          candidateId
        });
        alert('Candidate confirmed! Recording started.');
      }
    } catch (error) {
      console.error('Failed to confirm join:', error);
      alert('Failed to confirm');
    }
  };

  const rejectCandidateJoin = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/reject-join`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setRooms(prev => prev.map(r => r._id === roomId ? data.room : r));
        alert('Candidate rejected');
      }
    } catch (error) {
      console.error('Failed to reject:', error);
    }
  };

  const endCall = async (roomId) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}/end-call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setRooms(prev => prev.map(r => r._id === roomId ? data.room : r));
        socketRef.current?.emit('end-call-room', { roomId: data.room.roomId, roomDbId: roomId });
        setSelectedRoom(null);
        setTranscription([]);
        alert('Call ended');
      }
    } catch (error) {
      console.error('Failed to end call:', error);
    }
  };

  const deleteRoom = async (roomId) => {
    const shouldDelete = globalThis.confirm('Supprimer cette room ? Cette action est irreversible.');
    if (!shouldDelete) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${roomId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setRooms(prev => prev.filter(r => r._id !== roomId));
        if (selectedRoom?._id === roomId) {
          setSelectedRoom(null);
          setTranscription([]);
          setOverallSentiment({ label: 'NEUTRAL', score: 0 });
        }

        socketRef.current?.emit('call-room-status-update', {
          roomId: data.room?.roomId,
          roomDbId: roomId,
          status: 'deleted',
        });

        alert('Room supprimee avec succes');
      } else {
        alert(data.message || 'Impossible de supprimer la room');
      }
    } catch (error) {
      console.error('Failed to delete room:', error);
      alert('Erreur lors de la suppression');
    }
  };

  const renderRoomStatus = (room) => {
    if (room.status === 'waiting_confirmation') {
      return (
        <div className="status-badge waiting">
          {room.candidate ? 'Candidate Requesting Join' : 'Waiting for Candidate'}
        </div>
      );
    }
    if (room.status === 'active') {
      return <div className="status-badge active">Active Call</div>;
    }
    if (room.status === 'ended') {
      return <div className="status-badge ended">Ended</div>;
    }
  };

  const getSentimentColor = (label) => {
    if (label === 'POSITIVE') return '#4CAF50';
    if (label === 'NEGATIVE') return '#f44336';
    return '#9E9E9E';
  };

  const formatTranscriptTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // ── Download helpers ──────────────────────────────────────────────────────────

  const downloadTxt = (room) => {
    const segments = room.transcription?.segments || [];
    const duration = room.recordingEndedAt
      ? Math.round((new Date(room.recordingEndedAt) - new Date(room.recordingStartedAt)) / 1000)
      : 0;
    const lines = [
      'INTERVIEW TRANSCRIPT REPORT',
      '============================',
      `Room ID   : ${room.roomId}`,
      `Candidate : ${room.candidate?.email || 'N/A'}`,
      `Date      : ${room.recordingEndedAt ? new Date(room.recordingEndedAt).toLocaleString() : 'N/A'}`,
      `Duration  : ${duration} seconds`,
      `Sentiment : ${room.transcription?.overallSentiment?.label || 'NEUTRAL'} (${(room.transcription?.overallSentiment?.score || 0).toFixed(2)})`,
      '',
      'SPEECH SEGMENTS',
      '---------------',
      ...segments.map(s => `[${formatTranscriptTime(s.timestamp) || '??:??'}] (${s.sentiment?.label || 'NEUTRAL'}) ${s.text}`),
      '',
      'FULL TRANSCRIPT',
      '---------------',
      room.transcription?.text || '(no transcript)',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${room.roomId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = (room) => {
    const segments = room.transcription?.segments || [];
    const duration = room.recordingEndedAt
      ? Math.round((new Date(room.recordingEndedAt) - new Date(room.recordingStartedAt)) / 1000)
      : 0;

    const sentColor = (label) => {
      if (label === 'POSITIVE') return '#16a34a';
      if (label === 'NEGATIVE') return '#dc2626';
      return '#64748b';
    };

    const fmtTime = (val) => {
      if (!val) return '';
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const overallLabel = room.transcription?.overallSentiment?.label || 'NEUTRAL';
    const overallScore = (room.transcription?.overallSentiment?.score || 0).toFixed(2);

    const segmentsHtml = segments.length === 0
      ? '<p style="color:#94a3b8;font-size:13px">No segments recorded.</p>'
      : segments.map(s => `
          <div style="display:flex;gap:12px;align-items:flex-start;padding:10px;background:#f8fafc;border-left:3px solid #5b86e5;margin-bottom:8px;border-radius:0 6px 6px 0">
            <span style="color:#64748b;font-size:11px;white-space:nowrap;min-width:44px">${fmtTime(s.timestamp) || '??:??'}</span>
            <span style="padding:2px 8px;border-radius:10px;color:#fff;font-size:10px;font-weight:700;background:${sentColor(s.sentiment?.label)};white-space:nowrap">${s.sentiment?.label || 'NEUTRAL'}</span>
            <span style="font-size:13px;flex:1;color:#1e293b">${s.text}</span>
          </div>`).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Transcript – ${room.roomId}</title>
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
    <p><strong>Candidate:</strong> ${room.candidate?.email || 'N/A'}</p>
    <p><strong>Date:</strong> ${room.recordingEndedAt ? new Date(room.recordingEndedAt).toLocaleString() : 'N/A'}</p>
    <p><strong>Duration:</strong> ${duration} seconds</p>
    <p><strong>Overall Sentiment:</strong>
      <span style="display:inline-block;padding:3px 12px;border-radius:12px;color:#fff;font-weight:700;font-size:12px;background:${sentColor(overallLabel)}">${overallLabel} (${overallScore})</span>
    </p>
  </div>
  <h2>Speech Segments</h2>
  ${segmentsHtml}
  <h2>Full Transcript</h2>
  <div class="full">${room.transcription?.text || '(no transcript)'}</div>
</body>
</html>`;

    // Use a hidden iframe so no new tab is ever opened
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:none;opacity:0;';
    document.body.appendChild(iframe);
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.onafterprint = () => document.body.removeChild(iframe);
    iframe.contentWindow.print();
  };

  const downloadAudio = (room) => {
    if (!room.recordingUrl) {
      alert('No audio recording available for this room.\nAudio is saved when the candidate ends the call using the End Call button.');
      return;
    }
    const a = document.createElement('a');
    a.href = `${API_BASE}${room.recordingUrl}`;
    const ext = room.recordingUrl.split('.').pop() || 'webm';
    a.download = `recording-${room.roomId}.${ext}`;
    a.click();
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const selectedTranscriptSegments = Array.isArray(selectedRoom?.transcription?.segments)
    ? selectedRoom.transcription.segments
    : [];

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading">Loading rooms...</div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="call-room-dashboard">
        <div className="dashboard-header">
          <h1>Interview Call Rooms</h1>
          <button className="btn-primary" onClick={() => createRoom()}>
            + Create New Room
          </button>
        </div>

        <div className="dashboard-content">
          {/* Room List Panel */}
          <div className="room-list-panel">
            <h2>Your Rooms</h2>
            <div className="rooms-container">
              {rooms.length === 0 ? (
                <p className="empty-state">No rooms yet. Create one to get started!</p>
              ) : (
                rooms.map(room => (
                  <div
                    key={room._id}
                    className={`room-item ${selectedRoom?._id === room._id ? 'active' : ''}`}
                    onClick={() => setSelectedRoom(room)}
                  >
                    <div className="room-header">
                      <span className="room-id" title={room.roomId}>{room.roomId}</span>
                      <div className="room-header-actions">
                        {renderRoomStatus(room)}
                        <button
                          className="btn-delete-room"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteRoom(room._id);
                          }}
                          title="Supprimer la room"
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </div>
                    <div className="room-details">
                      {room.candidate && (
                        <p><strong>Candidate</strong> {room.candidate.email}</p>
                      )}
                      {room.job && (
                        <p><strong>Job</strong> {room.job.title}</p>
                      )}
                      <p className="created-time">
                        <strong>Created</strong> {new Date(room.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Room Details Panel */}
          {selectedRoom && (
            <div className="room-details-panel">
              <div className="panel-header">
                <h2>Room: {selectedRoom.roomId}</h2>
                <button
                  className="btn-close"
                  onClick={() => setSelectedRoom(null)}
                >×</button>
              </div>

              {/* Download Toolbar — visible for ended rooms */}
              {selectedRoom.status === 'ended' && (
                <div className="download-toolbar">
                  <span className="download-label">Download:</span>
                  <button
                    className="btn-download btn-dl-txt"
                    onClick={() => downloadTxt(selectedRoom)}
                    title="Download transcript as .txt"
                  >
                    📄 TXT
                  </button>
                  <button
                    className="btn-download btn-dl-pdf"
                    onClick={() => downloadPdf(selectedRoom)}
                    title="Print / save transcript as PDF"
                  >
                    📑 PDF
                  </button>
                  <button
                    className={`btn-download btn-dl-wav${selectedRoom.recordingUrl ? '' : ' btn-dl-wav--unavailable'}`}
                    onClick={() => downloadAudio(selectedRoom)}
                    title={selectedRoom.recordingUrl ? 'Download audio recording' : 'Audio not available'}
                  >
                    🎵 Audio{!selectedRoom.recordingUrl && <span className="dl-unavail-hint"> (N/A)</span>}
                  </button>
                </div>
              )}

              {/* Candidate Join Request Section */}
              {selectedRoom.status === 'waiting_confirmation' && selectedRoom.candidate && (
                <div className="candidate-request-section">
                  <h3>Candidate Join Request</h3>
                  <div className="candidate-info">
                    <p><strong>Email:</strong> {selectedRoom.candidate.email}</p>
                    <p><strong>Requested At:</strong> {new Date(selectedRoom.candidateJoinRequestedAt).toLocaleString()}</p>
                  </div>
                  <div className="action-buttons">
                    <button
                      className="btn-confirm"
                      onClick={() => confirmCandidateJoin(selectedRoom._id)}
                    >
                      Confirm & Start Recording
                    </button>
                    <button
                      className="btn-reject"
                      onClick={() => rejectCandidateJoin(selectedRoom._id)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {/* Active Call Section */}
              {selectedRoom.status === 'active' && (
                <div className="active-call-section">
                  <div className="recording-indicator">
                    <span className="recording-dot"></span>
                    Recording Active
                  </div>

                  {/* Real-time Transcription */}
                  <div className="transcription-section">
                    <h3>Live Transcription</h3>
                    <div className="sentiment-badge" style={{ backgroundColor: getSentimentColor(overallSentiment.label) }}>
                      {overallSentiment.label} ({(overallSentiment.score || 0).toFixed(2)})
                    </div>

                    <div className="transcription-display">
                      {transcription.length === 0 ? (
                        <p className="no-transcription">Waiting for audio...</p>
                      ) : (
                        transcription.map((seg, idx) => (
                          <div key={idx} className="transcript-segment">
                            <span className="segment-text">{seg.text}</span>
                            <span
                              className="segment-sentiment"
                              style={{ backgroundColor: getSentimentColor(seg.sentiment?.label) }}
                            >
                              {seg.sentiment?.label}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <button
                    className="btn-end-call"
                    onClick={() => endCall(selectedRoom._id)}
                  >
                    End Call
                  </button>
                </div>
              )}

              {/* Ended Call Summary */}
              {selectedRoom.status === 'ended' && (
                <div className="ended-call-section">
                  <h3>Call Summary</h3>
                  <div className="summary-info">
                    <p>
                      <strong>Duration:</strong>{' '}
                      {selectedRoom.recordingEndedAt
                        ? Math.round((new Date(selectedRoom.recordingEndedAt) - new Date(selectedRoom.recordingStartedAt)) / 1000)
                        : 0}{' '}
                      seconds
                    </p>
                    <p>
                      <strong>Final Sentiment:</strong>{' '}
                      <span style={{ color: getSentimentColor(selectedRoom.transcription?.overallSentiment?.label) }}>
                        {selectedRoom.transcription?.overallSentiment?.label}
                      </span>
                    </p>
                  </div>

                  {/* Audio Player */}
                  <div className="audio-player-section">
                    <div className="audio-player-header">
                      <span className="audio-player-title">🎙 Interview Recording</span>
                      {selectedRoom.recordingUrl && (
                        <button
                          className="btn-download btn-dl-wav"
                          onClick={() => downloadAudio(selectedRoom)}
                          title="Download audio file"
                        >
                          ⬇ Download
                        </button>
                      )}
                    </div>
                    {selectedRoom.recordingUrl ? (
                      <audio
                        className="audio-player"
                        controls
                        src={`${API_BASE}${selectedRoom.recordingUrl}`}
                        preload="metadata"
                      >
                        Your browser does not support the audio element.
                      </audio>
                    ) : (
                      <p className="audio-unavailable">
                        No recording available. Audio is saved when the candidate ends the call using the End Call button.
                      </p>
                    )}
                  </div>

                  <div className="speech-history-section">
                    <h4>Speech History</h4>
                    {selectedTranscriptSegments.length === 0 ? (
                      <p className="no-speech-history">No speech history saved for this room.</p>
                    ) : (
                      <div className="speech-history-list">
                        {selectedTranscriptSegments.map((segment, index) => (
                          <div key={`${segment.timestamp || 'segment'}-${index}`} className="speech-history-item">
                            <div className="speech-history-meta">
                              <span className="speech-history-time">
                                {formatTranscriptTime(segment.timestamp) || `Segment ${index + 1}`}
                              </span>
                              <span
                                className="segment-sentiment"
                                style={{ backgroundColor: getSentimentColor(segment.sentiment?.label) }}
                              >
                                {segment.sentiment?.label || 'NEUTRAL'}
                              </span>
                            </div>
                            <p className="speech-history-text">{segment.text}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {selectedRoom.transcription?.text && (
                    <div className="full-transcript-section">
                      <h4>Full Transcript</h4>
                      <p>{selectedRoom.transcription.text}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PublicLayout>
  );
};

export default CallRoomDashboard;
