import { useEffect, useState } from 'react';
import axios from 'axios';
import Navbar from '../components/Navbar/Navbar';
import Footer from '../components/Footer/Footer';
import { io } from 'socket.io-client';

const CandidateMessages = () => {
  const [messages, setMessages] = useState([]);

  const candidateId = localStorage.getItem("userId");
  const token = localStorage.getItem("token");

  useEffect(() => {
    const fetchMessages = async () => {
      try {
        const res = await axios.get(`http://localhost:3001/api/messages/user/${candidateId}`);
        if (Array.isArray(res.data.messages)) {
          setMessages(res.data.messages);
        } else {
          setMessages(res.data); // fallback if structure is flat
        }
      } catch (err) {
        console.error("❌ Error fetching messages:", err);
      }
    };

    fetchMessages();

    if (!candidateId || !token) return;

    const socket = io("http://localhost:3001", {
      path: "/socket.io/",
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on("connect_error", (error) => {
      if (error?.message === "TOKEN_EXPIRED") {
        console.warn("Socket session expired. Please login again.");
        socket.disconnect();
      }
    });

    socket.on(`notification-${candidateId}`, (data) => {
      alert(data.message);
      fetchMessages(); // Refresh messages
    });

    return () => {
      socket.off(`notification-${candidateId}`);
      socket.off("connect_error");
      socket.disconnect();
    };
  }, [candidateId, token]);

  return (
    <>
      <Navbar />
      <div className="messages-container">
        <h2>Your Messages</h2>
        {messages.length === 0 ? (
          <p>No messages received yet.</p>
        ) : (
          <ul className="messages-list">
            {messages.map((msg, index) => (
              <li key={msg._id || `${msg.timestamp || "msg"}-${index}`} className="message-card">
                <h4>📩 {msg.subject || 'No Subject'}</h4>
                <p><strong>From:</strong> {msg.senderName || msg.from}</p>
                <p>{msg.message || msg.text}</p>
                <span className="timestamp">
                  {msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Footer />
    </>
  );
};

export default CandidateMessages;
