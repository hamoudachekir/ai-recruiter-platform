import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import PublicLayout from '../layouts/PublicLayout';
import './CallRoomAvailable.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

const decodeToken = (jwtToken) => {
  if (!jwtToken) return null;
  try {
    return JSON.parse(atob(jwtToken.split('.')[1] || ''));
  } catch {
    return null;
  }
};

const isTokenExpired = (jwtToken) => {
  const payload = decodeToken(jwtToken);
  if (!payload?.exp) return true;
  return payload.exp * 1000 <= Date.now();
};

const CallRoomAvailable = () => {
  const [availableRooms, setAvailableRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingRoomId, setPendingRoomId] = useState('');
  // Per-room status messages so the UI reflects state without alert()
  const [roomMessages, setRoomMessages] = useState({}); // { [room._id]: { type, text } }
  const socketRef = useRef(null);
  const navigate = useNavigate();

  const token = localStorage.getItem('token');
  // Derive identity from the token itself, not from the separate localStorage
  // 'role'/'userId' keys — those can go stale when a different login flow
  // overwrites the token without updating them, which made this page show an
  // empty list (recruiter token → 403) instead of the real reason.
  const tokenPayload = decodeToken(token);
  const currentUserId = String(
    tokenPayload?.id || tokenPayload?._id || localStorage.getItem('userId') || '',
  );
  const currentRole = String(tokenPayload?.role || '').toUpperCase();
  const isCandidate = currentRole === 'CANDIDATE';

  const setRoomMsg = (roomDbId, text, type = 'info') => {
    setRoomMessages(prev => ({ ...prev, [roomDbId]: { text, type } }));
  };

  const clearRoomMsg = (roomDbId) => {
    setRoomMessages(prev => {
      const next = { ...prev };
      delete next[roomDbId];
      return next;
    });
  };

  // ── Fetch available rooms ─────────────────────────────────────────────────
  useEffect(() => {
    // This page is candidate-only. If the browser is authenticated as a
    // recruiter/enterprise (e.g. the account that created the room), the
    // backend returns 403 — surface that clearly instead of showing an empty
    // "no rooms available" state.
    if (!isCandidate) {
      setLoading(false);
      return;
    }

    const fetchAvailableRooms = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/available`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success) {
          setAvailableRooms(data.rooms);
          // Restore "waiting for confirmation" state across reloads: if one of
          // the returned rooms is one this candidate already requested, resume
          // the fallback poll so we still auto-redirect when the recruiter
          // confirms.
          const mine = data.rooms.find(
            (r) => String(r.candidate?._id || r.candidate) === String(currentUserId),
          );
          if (mine?.roomId) {
            setPendingRoomId(mine.roomId);
          }
        } else {
          console.error('Available rooms request failed:', response.status, data.message);
        }
      } catch (error) {
        console.error('Failed to fetch available rooms:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAvailableRooms();
  }, [token, isCandidate]);

  // ── Fallback poll: redirect when room becomes active ──────────────────────
  useEffect(() => {
    if (!pendingRoomId || !token) return undefined;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(pendingRoomId)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const data = await response.json();
        if (data.success && data.room?.status === 'active') {
          clearInterval(timer);
          navigate(`/call-room/${encodeURIComponent(data.room.roomId)}`);
        }
      } catch (_) {
        // Keep retrying silently
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [navigate, pendingRoomId, token]);

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || isTokenExpired(token)) return undefined;

    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1200,
    });

    socketRef.current.on('connect_error', (error) => {
      if (error?.message === 'TOKEN_EXPIRED') {
        socketRef.current?.disconnect();
      }
    });

    socketRef.current.emit('subscribe-to-available-rooms');

    // New room appeared
    socketRef.current.on('new-call-room', ({ room }) => {
      setAvailableRooms(prev => [room, ...prev]);
    });

    // Recruiter confirmed this candidate → redirect immediately, no alert
    socketRef.current.on('join-confirmed', ({ roomId }) => {
      setAvailableRooms(prev => prev.filter(r => r.roomId !== roomId));
      if (roomId) {
        navigate(`/call-room/${encodeURIComponent(roomId)}`);
      }
    });

    // Recruiter rejected
    socketRef.current.on('join-rejected', ({ roomId, roomDbId }) => {
      setAvailableRooms(prev =>
        prev.map(r =>
          r._id === roomDbId || r.roomId === roomId
            ? { ...r, candidate: null, candidateJoinRequestedAt: null }
            : r
        )
      );
      setPendingRoomId('');
      // Show inline message on the affected room
      const targetRoom = availableRooms.find(r => r._id === roomDbId || r.roomId === roomId);
      if (targetRoom) {
        setRoomMsg(targetRoom._id, 'Your join request was rejected. You can try again.', 'error');
        setTimeout(() => clearRoomMsg(targetRoom._id), 5000);
      }
    });

    // Room closed / deleted / became active — remove from list
    socketRef.current.on('call-room-status-update', ({ roomId, roomDbId, status }) => {
      if (status === 'active' || status === 'deleted' || status === 'ended') {
        setAvailableRooms(prev =>
          prev.filter(r => !(r._id === roomDbId || r.roomId === roomId))
        );
      }
    });

    return () => {
      socketRef.current?.emit('unsubscribe-from-available-rooms');
      socketRef.current?.off('connect_error');
      socketRef.current?.off('new-call-room');
      socketRef.current?.off('join-confirmed');
      socketRef.current?.off('join-rejected');
      socketRef.current?.off('call-room-status-update');
      socketRef.current?.disconnect();
    };
  }, [navigate, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Request to join ───────────────────────────────────────────────────────
  const requestJoin = async (room) => {
    try {
      const response = await fetch(`${API_BASE}/api/call-rooms/${room._id}/request-join`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        setAvailableRooms(prev =>
          prev.map(r => r._id === room._id ? data.room : r)
        );
        setPendingRoomId(room.roomId || '');

        // Join the socket channel for this room so we receive direct events
        socketRef.current?.emit('join-room', { roomId: room.roomId });

        // Notify the recruiter via socket
        socketRef.current?.emit('call-room-join-request', {
          roomId: room.roomId,
          candidateId: currentUserId,
          initiatorId: room.initiator?._id
        });

        setRoomMsg(room._id, 'Request sent — waiting for the recruiter to confirm…', 'info');
      } else {
        setRoomMsg(room._id, data.message || 'Failed to request join', 'error');
        setTimeout(() => clearRoomMsg(room._id), 4000);
      }
    } catch (error) {
      console.error('Failed to request join:', error);
      setRoomMsg(room._id, 'Network error — please try again', 'error');
      setTimeout(() => clearRoomMsg(room._id), 4000);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (!isCandidate) {
    return (
      <PublicLayout>
        <div className="empty-state">
          <p>This page is only available to candidate accounts.</p>
          <p>
            You appear to be signed in
            {currentRole ? ` as ${currentRole}` : ''} — please log out and sign
            in with your candidate account to join an interview room.
          </p>
        </div>
      </PublicLayout>
    );
  }

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading">Loading available rooms...</div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="call-room-available">
        <div className="header">
          <h1>Available Interview Rooms</h1>
          <p>Browse rooms and request to join for your interview</p>
        </div>

        {availableRooms.length === 0 ? (
          <div className="empty-state">
            <p>No rooms available at the moment.</p>
            <p>Check back later when RH creates interview rooms.</p>
          </div>
        ) : (
          <div className="rooms-grid">
            {availableRooms.map(room => {
              const msg = roomMessages[room._id];
              const isMine = String(room.candidate?._id || room.candidate) === String(currentUserId);
              const isPending = room.roomId === pendingRoomId;

              return (
                <div key={room._id} className="room-card">
                  <div className="room-card-header">
                    <h3>Interview Room</h3>
                    <span className="room-id-badge">{room.roomId}</span>
                  </div>

                  <div className="room-card-body">
                    {room.job && (
                      <div className="job-info">
                        <p><strong>Position:</strong> {room.job.title}</p>
                        <p><strong>Company:</strong> {room.job.company}</p>
                      </div>
                    )}

                    <div className="rh-info">
                      <p>
                        <strong>Interviewer:</strong>{' '}
                        {room.initiator.firstName} {room.initiator.lastName}
                      </p>
                      <p><strong>Email:</strong> {room.initiator.email}</p>
                    </div>

                    <p className="created-time">
                      Created: {new Date(room.createdAt).toLocaleTimeString()}
                    </p>
                  </div>

                  {/* Inline status message */}
                  {msg && (
                    <div className={`room-card-message room-card-message--${msg.type}`}>
                      {msg.text}
                    </div>
                  )}

                  <div className="room-card-footer">
                    {room.candidate ? (
                      <div className="waiting-confirmation">
                        {isMine ? (
                          <>
                            <span className="badge-waiting">
                              {isPending ? '⏳ Waiting for confirmation…' : 'Waiting for Confirmation'}
                            </span>
                          </>
                        ) : (
                          <span className="badge-taken">Room taken</span>
                        )}
                      </div>
                    ) : (
                      <button
                        className="btn-request-join"
                        onClick={() => requestJoin(room)}
                      >
                        Request to Join
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PublicLayout>
  );
};

export default CallRoomAvailable;
