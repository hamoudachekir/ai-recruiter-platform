import { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import "./MessagePopup.css";
import "./ConversationsPopup.css";

const API = "http://localhost:3001";

// A real conversation partner is a Mongo ObjectId — not "bot" / "system".
const isRealUserId = (id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id);

const authHeader = () => ({
  headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
});

const ConversationsPopup = ({ socket, currentUserId, onSelectPartner, onSelectBot, onClose }) => {
  const [conversations, setConversations] = useState([]);
  const [names, setNames] = useState({}); // partnerId -> display name
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Build the conversation list from a flat message array.
  const buildConversations = useCallback(
    (messages) => {
      const map = new Map();

      messages.forEach((msg) => {
        const partnerId = msg.from === currentUserId ? msg.to : msg.from;
        if (!isRealUserId(partnerId) || partnerId === currentUserId) return;

        const existing = map.get(partnerId);
        const incomingUnread = msg.to === currentUserId && !msg.read;
        const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;

        if (!existing || ts >= existing.ts) {
          map.set(partnerId, {
            partnerId,
            lastText: msg.text || "",
            lastFromSelf: msg.from === currentUserId,
            ts,
            unread: (existing?.unread || 0) + (incomingUnread ? 1 : 0),
          });
        } else if (incomingUnread) {
          existing.unread += 1;
        }
      });

      return [...map.values()].sort((a, b) => b.ts - a.ts);
    },
    [currentUserId]
  );

  // Resolve display names for any partners we don't know yet.
  const resolveNames = useCallback(
    async (partnerIds) => {
      const unknown = partnerIds.filter((id) => !names[id]);
      if (unknown.length === 0) return;

      const entries = await Promise.all(
        unknown.map(async (id) => {
          try {
            const { data: u } = await axios.get(`${API}/api/users/${id}`, authHeader());
            const display =
              u.name ||
              `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
              "User";
            return [id, display];
          } catch {
            return [id, "Recruiter"];
          }
        })
      );

      setNames((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    },
    [names]
  );

  // Initial load
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;

    axios
      .get(`${API}/api/messages/user/${currentUserId}`, authHeader())
      .then((res) => {
        if (cancelled) return;
        const list = buildConversations(res.data.messages || []);
        setConversations(list);
        resolveNames(list.map((c) => c.partnerId));
      })
      .catch(() => !cancelled && setError("Failed to load conversations."))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [currentUserId, buildConversations, resolveNames]);

  // Real-time: incoming messages bump the matching conversation to the top.
  useEffect(() => {
    if (!socket) return;
    const handler = (msg) => {
      const partnerId = msg.from === currentUserId ? msg.to : msg.from;
      if (!isRealUserId(partnerId)) return;

      resolveNames([partnerId]);
      setConversations((prev) => {
        const others = prev.filter((c) => c.partnerId !== partnerId);
        const existing = prev.find((c) => c.partnerId === partnerId);
        const isIncoming = msg.to === currentUserId;
        return [
          {
            partnerId,
            lastText: msg.text || "",
            lastFromSelf: msg.from === currentUserId,
            ts: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
            unread: (existing?.unread || 0) + (isIncoming ? 1 : 0),
          },
          ...others,
        ];
      });
    };

    socket.on("receive-message", handler);
    return () => socket.off("receive-message", handler);
  }, [socket, currentUserId, resolveNames]);

  const handleSelect = (conv) => {
    onSelectPartner({ _id: conv.partnerId, name: names[conv.partnerId] || "User" });
  };

  const formatTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  return (
    <div className="message-popup">
      {/* Header */}
      <div className="popup-header">
        <div className="popup-user-info">
          <div className="popup-avatar-wrap">
            <div className="popup-avatar-fallback">💬</div>
          </div>
          <div className="popup-header-text">
            <span className="popup-header-name">Messages</span>
            <span className="popup-header-sub" style={{ color: "#a8b8cc" }}>
              Your conversations
            </span>
          </div>
        </div>
        <button className="close-button" onClick={onClose} title="Close">✕</button>
      </div>

      {/* List */}
      <div className="popup-body conv-body">
        {error && <div className="error-message">{error}</div>}

        {loading ? (
          <div className="conv-loading">Loading conversations…</div>
        ) : (
          <>
            {conversations.length === 0 && !error && (
              <div className="conv-empty">
                <div className="conv-empty__icon">📭</div>
                <div className="conv-empty__title">No messages yet</div>
                <div className="conv-empty__sub">
                  When someone messages you, the conversation appears here.
                </div>
              </div>
            )}

            {conversations.map((conv) => {
              const name = names[conv.partnerId] || "Recruiter";
              const preview =
                (conv.lastFromSelf ? "You: " : "") + (conv.lastText || "");
              return (
                <button
                  key={conv.partnerId}
                  className="conv-row"
                  onClick={() => handleSelect(conv)}
                >
                  <div className="conv-avatar">{(name[0] || "?").toUpperCase()}</div>
                  <div className="conv-row__main">
                    <div className="conv-row__top">
                      <span className="conv-name">{name}</span>
                      <span className="conv-time">{formatTime(conv.ts)}</span>
                    </div>
                    <div className="conv-row__bottom">
                      <span className={`conv-preview${conv.unread ? " unread" : ""}`}>
                        {preview}
                      </span>
                      {conv.unread > 0 && (
                        <span className="conv-unread-badge">{conv.unread}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* NextBot — pinned entry, kept distinct from recruiter chats */}
      <div className="conv-bot-strip">
        <button className="conv-row conv-row--bot" onClick={onSelectBot}>
          <div className="conv-avatar conv-avatar--bot">🤖</div>
          <div className="conv-row__main">
            <div className="conv-row__top">
              <span className="conv-name">
                NextBot Assistant
                <span className="bot-badge">AI</span>
              </span>
            </div>
            <div className="conv-row__bottom">
              <span className="conv-preview">Ask about jobs, interviews & your profile</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
};

ConversationsPopup.propTypes = {
  socket: PropTypes.object,
  currentUserId: PropTypes.string.isRequired,
  onSelectPartner: PropTypes.func.isRequired,
  onSelectBot: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

ConversationsPopup.defaultProps = { socket: null };

export default ConversationsPopup;
