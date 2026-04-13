import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import PublicLayout from '../layouts/PublicLayout';
import './CallRoomAvailable.css';

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

const CallRoomAvailable = () => {
  const [availableRooms, setAvailableRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingRoomId, setPendingRoomId] = useState('');
  const socketRef = useRef(null);
  const navigate = useNavigate();

  const token = localStorage.getItem('token');
  const currentUserId = localStorage.getItem('userId');

  // Fetch available rooms
  useEffect(() => {
    const fetchAvailableRooms = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/available`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success) {
          setAvailableRooms(data.rooms);
        }
      } catch (error) {
        console.error('Failed to fetch available rooms:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAvailableRooms();
  }, [token]);

  // Fallback auto-redirect in case socket confirm event is missed.
  useEffect(() => {
    if (!pendingRoomId || !token) return undefined;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(pendingRoomId)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success && data.room?.status === 'active') {
          clearInterval(timer);
          navigate(`/call-room/${encodeURIComponent(data.room.roomId)}`);
        }
      } catch (error) {
        // Ignore polling errors and keep retrying.
      }
    }, 2500);

    return () => clearInterval(timer);
  }, [navigate, pendingRoomId, token]);

  // Socket.IO subscription
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
        console.warn('Socket session expired on available rooms. Please login again.');
        socketRef.current?.disconnect();
      }
    });

    // Subscribe to available rooms
    socketRef.current.emit('subscribe-to-available-rooms');

    // Listen for new rooms
    socketRef.current.on('new-call-room', ({ room }) => {
      setAvailableRooms(prev => [room, ...prev]);
    });

    // Listen for join confirmation
    socketRef.current.on('join-confirmed', ({ roomId, roomDbId }) => {
      setAvailableRooms(prev => prev.filter(r => !(r._id === roomDbId || r.roomId === roomId)));
      alert('Confirmed! Redirecting to call room...');
      if (roomId) {
        navigate(`/call-room/${encodeURIComponent(roomId)}`);
      }
    });

    // Listen for join rejection
    socketRef.current.on('join-rejected', ({ roomId, roomDbId }) => {
      alert('Your join request was rejected');
      setAvailableRooms(prev => 
        prev.map(r => (r._id === roomDbId || r.roomId === roomId) ? { ...r, candidate: null } : r)
      );
    });

    // Listen for status updates
    socketRef.current.on('call-room-status-update', ({ roomId, roomDbId, status }) => {
      setAvailableRooms(prev => 
        prev.filter(r => !((r._id === roomDbId || r.roomId === roomId) && (status === 'active' || status === 'deleted')))
      );
    });

    return () => {
      socketRef.current?.off('connect_error');
      socketRef.current?.emit('unsubscribe-from-available-rooms');
      socketRef.current?.disconnect();
    };
  }, [navigate, token]);

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
        socketRef.current?.emit('call-room-join-request', {
          roomId: room.roomId,
          candidateId: localStorage.getItem('userId'),
          initiatorId: room.initiator?._id
        });
        alert('Join request sent! Waiting for confirmation...');
      } else {
        alert(data.message || 'Failed to request join');
      }
    } catch (error) {
      console.error('Failed to request join:', error);
      alert('Error requesting to join');
    }
  };

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
            {availableRooms.map(room => (
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
                      <strong>Interviewer:</strong> {room.initiator.firstName} {room.initiator.lastName}
                    </p>
                    <p><strong>Email:</strong> {room.initiator.email}</p>
                  </div>

                  <p className="created-time">
                    Created: {new Date(room.createdAt).toLocaleTimeString()}
                  </p>
                </div>

                <div className="room-card-footer">
                  {room.candidate ? (
                    <div className="waiting-confirmation">
                      <span className="badge-waiting">Waiting for Confirmation</span>
                      {String(room.candidate?._id || room.candidate) === String(currentUserId) && (
                        <button
                          className="btn-request-join"
                          onClick={() => navigate(`/call-room/${encodeURIComponent(room.roomId)}`)}
                          style={{ marginTop: '10px' }}
                        >
                          Enter Room
                        </button>
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
            ))}
          </div>
        )}
      </div>
    </PublicLayout>
  );
};

export default CallRoomAvailable;
