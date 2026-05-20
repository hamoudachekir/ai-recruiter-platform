import { useEffect, useRef, useState, useCallback } from "react";
import PropTypes from "prop-types";
import "./MessagePopup.css";
import axios from "axios";

const API = "http://localhost:3001";

const QUICK_QUESTIONS = [
  { icon: "💼", text: "How do I apply for jobs?" },
  { icon: "🎯", text: "Tips for interview preparation" },
  { icon: "📝", text: "How to improve my profile?" },
  { icon: "📊", text: "How does AI scoring work?" },
];

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

const MessagePopup = ({ socket, selectedUser, onClose, currentUserId }) => {
  const [messages, setMessages]     = useState([]);
  const [newMsg, setNewMsg]         = useState("");
  const [error, setError]           = useState(null);
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [isSending, setIsSending]   = useState(false);
  const chatEndRef  = useRef(null);
  const textareaRef = useRef(null);

  const isBot = selectedUser._id === "bot";

  // Load chat history
  useEffect(() => {
    if (!selectedUser?._id || !currentUserId) return;
    axios
      .get(`${API}/api/messages/history/${currentUserId}/${selectedUser._id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      })
      .then((res) => {
        const raw = res.data.messages || [];
        const seen = new Set();
        const deduped = raw.filter((msg) => {
          const ts = msg.timestamp ? Math.round(new Date(msg.timestamp).getTime() / 2000) : 0;
          const key = `${msg.from}|${msg.to}|${msg.text}|${ts}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setMessages(deduped);
      })
      .catch(() => setError("Failed to load messages."));
  }, [selectedUser._id, currentUserId]);

  // Incoming socket messages
  useEffect(() => {
    if (!socket) return;
    const handler = (msg) => {
      if (msg.from === selectedUser._id && msg.to === currentUserId) {
        setMessages((prev) => [...prev, msg]);
      }
    };
    socket.on("receive-message", handler);
    return () => socket.off("receive-message", handler);
  }, [socket, selectedUser._id, currentUserId]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBotTyping]);

  // Core send logic — accepts text directly to avoid stale-state race
  const doSend = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;

    const messageObj = {
      from: currentUserId,
      to: selectedUser._id,
      text: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, messageObj]);
    setNewMsg("");
    setError(null);
    setIsSending(true);

    try {
      await axios.post(`${API}/api/messages/send`, messageObj, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });

      if (isBot) {
        setIsBotTyping(true);
        const res = await axios.post(
          `${API}/api/messages/bot/interaction`,
          { userId: currentUserId, message: trimmed },
          { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } }
        );
        setIsBotTyping(false);
        const botResponse = {
          from: "bot",
          to: currentUserId,
          text: res.data.reply,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, botResponse]);
      } else {
        socket?.emit("send-message", messageObj);
      }
    } catch (err) {
      console.error("Send error:", err);
      setIsBotTyping(false);
      setError("Failed to send message. Please try again.");
    } finally {
      setIsSending(false);
    }
  }, [currentUserId, selectedUser._id, isBot, isSending, socket]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend(newMsg);
    }
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Render a single message row
  const renderMsg = (msg, i) => {
    const isSent = msg.from === currentUserId;
    const isFromBot = msg.from === "bot";
    const key = msg._id || `${msg.from}-${msg.to}-${msg.timestamp || i}`;

    return (
      <div key={key} className={`mp-msg-row mp-msg-row--${isSent ? "sent" : "received"}`}>
        {/* Avatar on the left for received messages */}
        {!isSent && (
          <div className={`mp-msg-avatar mp-msg-avatar--${isFromBot ? "bot" : "other"}`}>
            {isFromBot ? "🤖" : (selectedUser.name?.[0] || "?").toUpperCase()}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: "78%", alignItems: isSent ? "flex-end" : "flex-start" }}>
          <div className={`mp-bubble${isFromBot ? " mp-bubble--bot" : ""}`}>
            {isFromBot ? (
              <span
                className="mp-text"
                dangerouslySetInnerHTML={{
                  __html: (msg.text || "")
                    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                    .replace(/\n/g, "<br>"),
                }}
              />
            ) : (
              <span className="mp-text">{msg.text || ""}</span>
            )}
          </div>
          <div className="mp-time">
            {formatTime(msg.timestamp)}
            {isFromBot && <span className="bot-indicator">AI</span>}
          </div>
        </div>

        {/* Avatar on the right for sent messages */}
        {isSent && (
          <div className="mp-msg-avatar mp-msg-avatar--user">
            {currentUserId?.[0]?.toUpperCase() || "U"}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="message-popup">
      {/* ── Header ── */}
      <div className="popup-header">
        <div className="popup-user-info">
          <div className="popup-avatar-wrap">
            <div className="popup-avatar-fallback">
              {isBot ? "🤖" : (selectedUser.name?.[0] || "?").toUpperCase()}
            </div>
            {isBot && <span className="popup-online-dot" />}
          </div>
          <div className="popup-header-text">
            <span className="popup-header-name">
              {isBot ? "NextBot" : selectedUser.name || "User"}
              {isBot && <span className="bot-badge">AI</span>}
            </span>
            <span className="popup-header-sub">
              {isBot ? "● Online — powered by Groq" : "● Active"}
            </span>
          </div>
        </div>
        <button className="close-button" onClick={onClose} title="Close">✕</button>
      </div>

      {/* ── Messages body ── */}
      <div className="popup-body">
        {error && <div className="error-message">{error}</div>}

        {messages.length === 0 ? (
          <div className="mp-welcome">
            <div className="mp-welcome__icon">🤖</div>
            <div className="mp-welcome__title">Hi! I'm NextBot</div>
            <div className="mp-welcome__sub">
              Your AI career assistant for NextHire.<br />
              Ask me anything about jobs, interviews, or your profile.
            </div>
            <div className="bot-quick-questions">
              {QUICK_QUESTIONS.map((q) => (
                <button key={q.text} onClick={() => doSend(q.text)}>
                  {q.icon} {q.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map(renderMsg)
        )}

        {isBotTyping && (
          <div className="mp-msg-row mp-msg-row--received">
            <div className="mp-msg-avatar mp-msg-avatar--bot">🤖</div>
            <div className="mp-bubble mp-bubble--bot">
              <div className="typing-indicator">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* ── Footer ── */}
      <div className="popup-footer">
        <textarea
          ref={textareaRef}
          value={newMsg}
          onChange={(e) => setNewMsg(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isBot ? "Ask NextBot anything…" : "Type a message…"}
          rows={1}
          disabled={isSending}
        />
        <button
          className="send-button"
          onClick={() => doSend(newMsg)}
          disabled={isSending || !newMsg.trim()}
          title="Send"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
};

MessagePopup.propTypes = {
  socket: PropTypes.object,
  selectedUser: PropTypes.shape({
    _id: PropTypes.string.isRequired,
    name: PropTypes.string,
    picture: PropTypes.string,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  currentUserId: PropTypes.string.isRequired,
};

MessagePopup.defaultProps = { socket: null };

export default MessagePopup;
