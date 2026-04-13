import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import Navbar from "../../components/Navbar/Navbar";
import Footer from "../../components/Footer/Footer";
import MessagePopup from "../../components/MessagePopup";
import { io } from "socket.io-client";
import { jwtDecode } from "jwt-decode";
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
import "./Home.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLanguage,
  faLayerGroup,
  faChevronRight,
  faLocationDot,
  faMagnifyingGlass,
  faCirclePlay,
  faLightbulb,
  faStar,
  faMessage,
  faRobot
} from "@fortawesome/free-solid-svg-icons";
import { motion } from "framer-motion";
import { TypeAnimation } from "react-type-animation";

const Home = () => {
  const token = localStorage.getItem("token");
  const socketRef = useRef(null);

  const isTokenExpired = (jwtToken) => {
    if (!jwtToken) return true;
    try {
      const decoded = jwtDecode(jwtToken);
      if (!decoded?.exp) return true;
      return decoded.exp * 1000 <= Date.now();
    } catch {
      return true;
    }
  };

  const [jobs, setJobs] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("all");
  const [selectedSkill, setSelectedSkill] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const [minMatch, setMinMatch] = useState(50);
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationsError, setRecommendationsError] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [contactName, setContactName] = useState("");
  const [contactSubject, setContactSubject] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [showMessagePopup, setShowMessagePopup] = useState(false);
  const [chatPartner, setChatPartner] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
  const [applicationStatusByJobId, setApplicationStatusByJobId] = useState({});

  const role = localStorage.getItem("role");

  useEffect(() => {
    const userId = localStorage.getItem("userId");
    const canConnectSocket = token && !isTokenExpired(token);
    let socket = socketRef.current;

    if (canConnectSocket) {
      if (!socket || socket.disconnected) {
        socket = io("http://localhost:3001", {
          auth: { token },
          transports: ["websocket", "polling"],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000,
        });
        socketRef.current = socket;
      }
    } else if (socket) {
      socket.disconnect();
      socketRef.current = null;
      socket = null;
    }
    if (userId) {
      setCurrentUserId(userId);
    }

    if (socket) {
      socket.on("connect", () => {
        console.log("✅ Connected to socket server");
      });

      socket.on("disconnect", () => {
        console.log("❌ Disconnected from socket server");
      });

      socket.on("connect_error", (error) => {
        if (error?.message === "TOKEN_EXPIRED") {
          console.warn("Socket disconnected: session expired. Please login again.");
          socket.disconnect();
        }
      });

      socket.on("receive-message", (data) => {
        console.log("📥 Message received from:", data.from);
        if (data.to === userId) {
          setHasUnreadMessages(true);
        }
      });
    }

    const fetchCandidateRecommendations = async () => {
      if (role !== "CANDIDATE" || !token) {
        return;
      }

      setRecommendationsLoading(true);
      setRecommendationsError(null);

      try {
        const recRes = await axios.get(
          "http://localhost:3001/api/recommendations/for-user",
          { headers: { Authorization: `Bearer ${token}` } }
        );

        let recommendationsData = [];
        if (Array.isArray(recRes.data)) {
          recommendationsData = recRes.data;
        } else if (recRes.data?.recommendations) {
          recommendationsData = recRes.data.recommendations;
        } else if (Array.isArray(recRes.data?.jobs)) {
          recommendationsData = recRes.data.jobs.map((job) => ({
            ...job,
            match_score: job.score || 0,
          }));
        }

        const transformedRecs = recommendationsData.map((rec) => {
          const jobData = rec.job || rec;
          return {
            ...jobData,
            match_score: rec.score || rec.match_score || 0,
          };
        });

        setRecommendations(transformedRecs);
      } catch (recError) {
        console.error("❌ Error fetching recommendations:", recError);
        setRecommendationsError("Failed to load recommendations.");
      } finally {
        setRecommendationsLoading(false);
      }
    };

    const fetchData = async () => {
      try {
        const jobsRes = await axios.get("http://localhost:3001/Frontend/jobs");
        setJobs(jobsRes.data);

        if (role === "CANDIDATE" && userId) {
          try {
            const applicationsRes = await axios.get(`http://localhost:3001/Frontend/applications-by-candidate/${userId}`);
            const applications = Array.isArray(applicationsRes?.data) ? applicationsRes.data : [];
            const statusMap = {};
            applications.forEach((application) => {
              const jobId =
                typeof application?.jobId === "object" && application?.jobId?._id
                  ? String(application.jobId._id)
                  : (application?.jobId ? String(application.jobId) : null);

              if (!jobId) return;

              const completed = Boolean(application?.quizCompleted);
              statusMap[jobId] = completed ? "completed" : "pending";
            });

            setApplicationStatusByJobId(statusMap);
          } catch (applicationError) {
            console.error("❌ Error fetching candidate applications:", applicationError);
          }
        }

        if (role === "ENTERPRISE") {
          const candidatesRes = await axios.get("http://localhost:3001/api/Frontend/all-candidates");
          setCandidates(candidatesRes.data);
        }

        if (token) {
          if (role === "CANDIDATE") {
            try {
              const messagesRes = await axios.get(
                `http://localhost:3001/api/messages/history/${userId}/system`,
                { headers: { Authorization: `Bearer ${token}` } }
              );

              const unreadMessages = messagesRes.data.messages?.filter(
                (msg) => !msg.read && msg.to === userId
              );

              if (unreadMessages?.length > 0) {
                setHasUnreadMessages(true);
              }
            } catch (msgError) {
              console.error("❌ Error fetching messages:", msgError);
            }
          }

          // Fetch recommendations (Only for Candidates)
          if (role === "CANDIDATE") {
            await fetchCandidateRecommendations();
          } else {
            setRecommendationsLoading(false);
          }
        }
      } catch (error) {
        console.error("❌ Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    const handleVisibleRefresh = () => {
      if (document.visibilityState === "visible") {
        fetchCandidateRecommendations();
      }
    };

    window.addEventListener("focus", handleVisibleRefresh);
    document.addEventListener("visibilitychange", handleVisibleRefresh);

    return () => {
      if (socket) {
        socket.off("connect");
        socket.off("disconnect");
        socket.off("connect_error");
        socket.off("receive-message");
        socket.disconnect();
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
      }
      window.removeEventListener("focus", handleVisibleRefresh);
      document.removeEventListener("visibilitychange", handleVisibleRefresh);
    };
  }, [role, token]);

  const parseSalary = (salary) => {
    if (typeof salary === "number") return salary;
    if (typeof salary === "string") {
      const normalized = salary.replace(/[^\d.]/g, "");
      const parsed = Number(normalized);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  const buildSearchableText = (job) => {
    const companyName =
      job.entrepriseId?.enterprise?.name ||
      job.entrepriseId?.name ||
      job.company?.name ||
      "";

    const skills = [...(job.skills || []), ...(job.tags || []), ...(job.languages || [])]
      .map((item) => (typeof item === "string" ? item : item?.name || ""))
      .join(" ");

    return `${job.title || ""} ${job.location || ""} ${companyName} ${skills}`.toLowerCase();
  };

  const applyJobFilters = (job) => {
    const query = searchTerm.trim().toLowerCase();
    const searchable = buildSearchableText(job);
    const matchesQuery = !query || searchable.includes(query);

    const locationValue = (job.location || "Remote").toLowerCase();
    const matchesLocation =
      selectedLocation === "all" || locationValue === selectedLocation.toLowerCase();

    const allSkills = [...(job.skills || []), ...(job.tags || []), ...(job.languages || [])].map((item) =>
      typeof item === "string" ? item.toLowerCase() : (item?.name || "").toLowerCase()
    );
    const matchesSkill = selectedSkill === "all" || allSkills.includes(selectedSkill.toLowerCase());

    return matchesQuery && matchesLocation && matchesSkill;
  };

  const sortJobs = (list) => {
    const sorted = [...list];
    if (sortBy === "title") {
      sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    } else if (sortBy === "salary-desc") {
      sorted.sort((a, b) => parseSalary(b.salary) - parseSalary(a.salary));
    } else if (sortBy === "salary-asc") {
      sorted.sort((a, b) => parseSalary(a.salary) - parseSalary(b.salary));
    } else {
      sorted.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }
    return sorted;
  };

  const allJobsForFilters = [...jobs, ...recommendations];
  const locationOptions = Array.from(
    new Set(allJobsForFilters.map((job) => (job.location || "Remote").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const skillOptions = Array.from(
    new Set(
      allJobsForFilters
        .flatMap((job) => [...(job.skills || []), ...(job.tags || []), ...(job.languages || [])])
        .map((item) => (typeof item === "string" ? item.trim() : item?.name?.trim()))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  const filteredJobs = sortJobs(jobs.filter(applyJobFilters));

  const filteredRecommendations = sortJobs(
    recommendations.filter((job) => {
      const matchValue = Number(job.match_score || job.score || 0) * 100;
      return applyJobFilters(job) && matchValue >= minMatch;
    })
  );

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedLocation("all");
    setSelectedSkill("all");
    setSortBy("recent");
    setMinMatch(50);
  };

  const openContactModal = (candidate) => {
    setSelectedCandidate(candidate);
    setShowModal(true);
  };

  const openMessagePopup = (user) => {
    setChatPartner(user);
    setShowMessagePopup(true);
    setHasUnreadMessages(false);
  };

  const openBotChat = () => {
    setChatPartner({
      _id: 'bot',
      name: 'NextBot Assistant',
      picture: '/images/bot-avatar.png'
    });
    setShowMessagePopup(true);
    setHasUnreadMessages(false);
  };

  const openCandidateMessages = async () => {
    try {
      const token = localStorage.getItem("token");
      const userId = localStorage.getItem("userId");
      if (!token || !userId) {
        console.error("No token or userId found");
        return;
      }

      const response = await axios.get(
        `http://localhost:3001/api/messages/user/${userId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data.messages && response.data.messages.length > 0) {
        const lastMsg = response.data.messages.at(-1);
        const senderId = lastMsg.from === userId ? lastMsg.to : lastMsg.from;

        const senderInfo = await axios.get(
          `http://localhost:3001/Frontend/getUser/${senderId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        setChatPartner({
          _id: senderInfo.data._id,
          name: senderInfo.data.name,
          picture: senderInfo.data.picture || "/images/avatar-placeholder.png"
        });

        setShowMessagePopup(true);
      } else {
        // If no messages, open bot chat
        openBotChat();
      }
    } catch (error) {
      console.error("Error fetching candidate messages:", error);
      alert("Could not open messages. Starting chat with NextBot instead.");
      openBotChat();
    }
  };

  const handleSend = async () => {
    if (!contactName || !contactSubject || !contactMessage) {
      alert("Please fill out all fields.");
      return;
    }

    try {
      const response = await axios.post(
        "http://localhost:3001/api/messages/send",
        {
          from: currentUserId,
          to: selectedCandidate._id,
          text: contactMessage
        },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token")}`
          }
        }
      );

      if (response.data.success || response.status === 200) {
        socketRef.current?.emit("send-message", {
          from: currentUserId,
          to: selectedCandidate._id,
          text: contactMessage,
          timestamp: new Date()
        });

        socketRef.current?.emit("notify-candidate", {
          to: selectedCandidate._id,
          message: `📬 New message from ${contactName}: "${contactSubject}"`,
          type: "message"
        });

        alert("Message sent!");
        setShowModal(false);
        setContactName("");
        setContactSubject("");
        setContactMessage("");
      } else {
        alert("Failed to send message.");
      }
    } catch (error) {
      console.error("Error sending message:", error);
      alert("An error occurred while sending the message.");
    }
  };

  const renderJobCard = (job, isRecommended = false) => {
    const currentJobId = String(job?._id || job?.id || "");
    const applicationStatus = role === "CANDIDATE" ? applicationStatusByJobId[currentJobId] : null;
    const isApplied = applicationStatus === "completed";
    const hasPendingApplication = applicationStatus === "pending";

    // Determine the company image source
    let companyImage = "/images/working.png";
    if (job.entrepriseId?.picture) {
      if (job.entrepriseId.picture.startsWith("http")) {
        companyImage = job.entrepriseId.picture;
      } else {
        companyImage = `http://localhost:3001${job.entrepriseId.picture.startsWith("/") ? "" : "/"}${job.entrepriseId.picture}`;
      }
    } else if (job.company?.logo) {
      companyImage = job.company.logo;
    }

    return (
      <div key={job._id || job.id} className="job-card-home">
        {isRecommended && (job.match_score || job.score) && (
          <div className="recommendation-badge">
            <FontAwesomeIcon icon={faStar} />
            <span>{Math.round((job.match_score || job.score) * 100)}% Match</span>
          </div>
        )}
        {isApplied && (
          <div className="applied-badge-home">
            Applied
          </div>
        )}
        <div className="job-card-body">
          <div className="job-card-header">
            <div className="company-info">
              <div className="company-logo">
                <img
                  src={companyImage}
                  alt="Company Logo"
                  onError={(e) => {
                    e.target.onerror = null;
                    e.target.src = "/images/working.png";
                  }}
                />
              </div>
              <div className="company-details">
                <span className="company-name">
                  {job.entrepriseId?.enterprise?.name ||
                    job.entrepriseId?.name ||
                    job.company?.name ||
                    "Unknown Company"}
                </span>
                <span className="company-location">
                  <FontAwesomeIcon icon={faLocationDot} style={{ marginRight: "5px" }} />
                  {job.location || "Remote"}
                </span>
              </div>
            </div>
            <div className="job-bookmark">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ cursor: "pointer", color: "#6c757d" }}
              >
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
          </div>
          <h3 className="job-title" title={job.title}>{job.title || "Untitled Position"}</h3>

          <div className="job-tags-container">
            {(job.skills?.length > 0 || job.languages?.length > 0 || job.tags?.length > 0) && (
              <div className="job-tags">
                {(job.skills || job.tags || []).slice(0, 3).map((skill, index) => (
                  <span key={`skill-${index}`} className="job-tag skill">
                    <FontAwesomeIcon icon={faLayerGroup} style={{ marginRight: "5px" }} />
                    {typeof skill === 'string' ? skill : skill.name}
                  </span>
                ))}
                {(job.languages || []).slice(0, 2).map((language, index) => (
                  <span key={`lang-${index}`} className="job-tag language">
                    <FontAwesomeIcon icon={faLanguage} style={{ marginRight: "5px" }} />
                    {typeof language === 'string' ? language : language.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="job-card-footer">
          <span className="job-salary">
             {job.salary ? `${job.salary}€` : "Competitive"}
             <span className="job-salary-period">/Month</span>
          </span>
          {isApplied ? (
            <span className="apply-btn-home disabled">
              Applied
            </span>
          ) : hasPendingApplication ? (
            <Link to={`/quiz/${job._id || job.id}`} className="apply-btn-home continue">
              Continue Quiz <FontAwesomeIcon icon={faChevronRight} />
            </Link>
          ) : (
            <Link to={`/job/${job._id || job.id}`} className="apply-btn-home">
              Apply Now <FontAwesomeIcon icon={faChevronRight} />
            </Link>
          )}
        </div>
      </div>
    );
  };

  const renderCandidateCard = (candidate, isCompact = false) => {
    return (
      <div key={candidate._id} className={`candidate-card ${isCompact ? 'compact' : ''}`}>
        <div className="candidate-header">
          <img
            src={
              candidate.picture
                ? (candidate.picture.startsWith("http")
                    ? candidate.picture
                    : `http://localhost:3001${candidate.picture.startsWith("/") ? "" : "/"}${candidate.picture}`)
                : "/images/avatar-placeholder.png"
            }
            alt={candidate.name}
            className="candidate-avatar"
            onError={(e) => { e.target.onerror = null; e.target.src = "/images/avatar-placeholder.png"; }}
          />
          <h3>{candidate.name}</h3>
          <p>{candidate.email}</p>
        </div>
        <div className="candidate-skills">
          {candidate.profile?.skills && candidate.profile.skills.length > 0 ? (
            candidate.profile.skills.slice(0, isCompact ? 2 : 4).map((skill, i) => (
              <span key={i} className="candidate-skill">
                {skill}
              </span>
            ))
          ) : (
            <span className="no-skills-text" style={{ fontSize: '0.8rem', color: '#a0aec0', fontStyle: 'italic' }}>No skills</span>
          )}
        </div>
        <div className="candidate-actions">
          <Link
            to={`/candidate/${candidate._id}`}
            className="view-profile-link"
          >
            View Profile
          </Link>
          <div className="contact-buttons">
            <button className="contact-btn" onClick={() => openContactModal(candidate)} title="Send Email">
              <FontAwesomeIcon icon={faMessage} /> Email
            </button>
            <button className="chat-btn" onClick={() => openMessagePopup(candidate)} title="Instant Chat">
              <FontAwesomeIcon icon={faMessage} /> Chat
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <>
      {/* Contact Form Modal */}
      {showModal && (
        <div className="side-panel-overlay" onClick={() => setShowModal(false)}>
          <div className="side-panel" onClick={(e) => e.stopPropagation()}>
            <div className="message-header">
              <img src={selectedCandidate?.picture || "/images/avatar-placeholder.png"} alt="Candidate" className="avatar-thumbnail" />
              <div>
                <h3>Message to {selectedCandidate?.name}</h3>
                <p className="muted-text">{selectedCandidate?.email}</p>
              </div>
            </div>
            <input
              type="text"
              placeholder="e.g. John Smith from HR Department"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
            <input
              type="text"
              placeholder="Subject: e.g. Let's Connect Regarding a Role"
              value={contactSubject}
              onChange={(e) => setContactSubject(e.target.value)}
            />
            <textarea
              placeholder="Write a clear, polite message. Mention why you're contacting them and what value you offer."
              value={contactMessage}
              onChange={(e) => setContactMessage(e.target.value)}
            ></textarea>
            <div className="side-panel-actions">
              <button onClick={handleSend}>Send</button>
              <button onClick={() => setShowModal(false)} className="cancel-btn">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Chat Message Popup */}
      {showMessagePopup && chatPartner && (
        <MessagePopup
          socket={socketRef.current}
          selectedUser={chatPartner}
          onClose={() => setShowMessagePopup(false)}
          currentUserId={currentUserId}
        />
      )}

      <div className="home-container">
        <Navbar />
        {/* Message notification and bot chat buttons for candidates */}
        {localStorage.getItem("token") && role === "CANDIDATE" && (
          <div className="message-notification-container">
            <button
              className={`message-notification-button ${hasUnreadMessages ? 'has-notifications' : ''}`}
              onClick={openCandidateMessages}
              title="View Messages"
            >
              <FontAwesomeIcon icon={faMessage} />
              {hasUnreadMessages && <span className="notification-badge"></span>}
            </button>
            <button
              className="bot-chat-button"
              onClick={openBotChat}
              title="Chat with NextBot"
            >
              <FontAwesomeIcon icon={faRobot} />
            </button>
          </div>
        )}
        <section className="hero_section_clean elite">
          <svg className="hero_blob" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg">
            <g transform="translate(300,300)">
              <path d="M120,-152C156,-115,182,-77,186,-38C190,1,171,41,147,84C123,127,94,172,55,182C16,193,-33,170,-76,143C-118,117,-154,86,-166,47C-178,7,-165,-41,-139,-89C-113,-137,-75,-186,-28,-192C19,-199,77,-164,120,-152Z" fill="#5b86e5" opacity="0.3" />
            </g>
          </svg>
          <div className="hero_shapes">
            <div className="circle circle1"></div>
            <div className="circle circle2"></div>
            <div className="blur_light"></div>
          </div>
          <div className="hero_wrapper">
            <motion.div
              className="hero_text_block"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1, ease: 'easeOut' }}
            >
              <h1 className="hero_heading">
                Welcome to NextHire <br />
                <TypeAnimation
                  sequence={[
                    'Connecting Talent with Opportunity', 2000,
                    'Hire Smarter. Get Hired Faster.', 2000,
                    'Your Next Hire is Just One Click Away', 2000,
                  ]}
                  wrapper="span"
                  speed={50}
                  repeat={Infinity}
                  className="highlighted"
                  style={{ display: 'inline-block' }}
                />
              </h1>
              <p className="hero_subtext">
                NextHire bridges the gap between top companies and ambitious professionals. Whether you're looking for
                your dream job or the perfect candidate — we've got you covered.
              </p>
              <motion.div
                className="hero_ctas"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
              >
                <motion.a
                  href="#contact"
                  className="hero_btn pulse primary"
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <FontAwesomeIcon icon={faCirclePlay} style={{ color: "#ffffff" }} />
                    Get Started
                </motion.a>
                <motion.a
                  href="#about"
                  className="hero_btn secondary"
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <FontAwesomeIcon icon={faLightbulb} style={{ color: "#36d1dc" }} />
                    Learn More
                </motion.a>
              </motion.div>
            </motion.div>
            <motion.div
              className="hero_image_block"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.6, duration: 1 }}
            >
              <motion.img
                src="/images/hero2_img.png"
                alt="Hero visual"
                className="hero_main_img"
                animate={{ y: [0, -12, 0] }}
                transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
              />
            </motion.div>
          </div>
        </section>
        {!localStorage.getItem("token") && (
          <section className="role-selector">
            <div className="container">
              <h2>Choose Your Path</h2>
              <div className="role-cards">
                <div className="role-card">
                  <img src="/images/candidate-icon.png" alt="Candidate" />
                  <h3>I'm a Candidate</h3>
                  <p>Looking for my next career opportunity. I want to showcase my skills and connect with employers.</p>
                  <Link to="/register?role=candidate" className="role-btn">
                    Register as Candidate
                  </Link>
                </div>
                <div className="role-card">
                  <img src="/images/enterprise-icon.png" alt="Enterprise" />
                  <h3>I'm an Enterprise</h3>
                  <p>Seeking talented professionals to join our team. I want to post jobs and find the right candidates.</p>
                  <Link to="/register?role=enterprise" className="role-btn">
                    Register as Enterprise
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}
        {role === "ENTERPRISE" && (
          <section className="candidates_section">
            <div className="container">
              <h2 className="section-title">Recently Registered Candidates</h2>
              <div className="candidate-card-list">
                {candidates.length > 0 ? (
                  candidates.map((candidate) => (
                    <div key={candidate._id} className="candidate-card">
                      <div className="candidate-header">
                        <img
                          src={
                            candidate.picture 
                              ? (candidate.picture.startsWith("http") 
                                  ? candidate.picture 
                                  : `http://localhost:3001${candidate.picture.startsWith("/") ? "" : "/"}${candidate.picture}`)
                              : "/images/avatar-placeholder.png"
                          }
                          alt={candidate.name}
                          className="candidate-avatar"
                          onError={(e) => { e.target.onerror = null; e.target.src = "/images/avatar-placeholder.png"; }}
                        />
                        <h3>{candidate.name}</h3>
                        <p>{candidate.email}</p>
                      </div>
                      <div className="candidate-skills">
                        {candidate.profile?.skills && candidate.profile.skills.length > 0 ? (
                          candidate.profile.skills.slice(0, 4).map((skill, i) => (
                            <span key={i} className="candidate-skill">
                              {skill}
                            </span>
                          ))
                        ) : (
                          <span className="no-skills-text" style={{ fontSize: '0.8rem', color: '#a0aec0', fontStyle: 'italic' }}>No skills listed</span>
                        )}
                      </div>
                      <div className="candidate-actions">
                        <Link
                          to={`/candidate/${candidate._id}`}
                          className="view-profile-link"
                        >
                          View Profile
                        </Link>
                        <div className="contact-buttons">
                          <button className="contact-btn" onClick={() => openContactModal(candidate)} title="Send Email">
                            <FontAwesomeIcon icon={faMessage} /> Email
                          </button>
                          <button className="chat-btn" onClick={() => openMessagePopup(candidate)} title="Instant Chat">
                            <FontAwesomeIcon icon={faMessage} /> Chat
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="no-candidates-message" style={{
                    width: '100%',
                    textAlign: 'center',
                    padding: '60px 40px',
                    background: 'rgba(11, 12, 42, 0.5)',
                    borderRadius: '16px',
                    border: '1px solid rgba(54, 209, 220, 0.2)',
                    backdropFilter: 'blur(10px)'
                  }}>
                    <p style={{
                      color: '#9fc4d7',
                      fontSize: '1.1rem',
                      margin: 0
                    }}>No recently registered candidates found.</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        <section className="jobs_section">
          <div className="container">
            <div className="job-section-header">
              <div className="job-search-bar modern">
                <div className="search-icon-wrapper">
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="search-icon" />
                </div>
                <input
                  type="text"
                  placeholder="Search by title, company, location, or skill..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <button type="button" onClick={resetFilters}>Reset</button>
              </div>

              <div className="job-filter-bar">
                <div className="filter-group">
                  <label htmlFor="job-location-filter">Location</label>
                  <select
                    id="job-location-filter"
                    value={selectedLocation}
                    onChange={(e) => setSelectedLocation(e.target.value)}
                  >
                    <option value="all">All locations</option>
                    {locationOptions.map((location) => (
                      <option key={location} value={location}>{location}</option>
                    ))}
                  </select>
                </div>

                <div className="filter-group">
                  <label htmlFor="job-skill-filter">Skill</label>
                  <select
                    id="job-skill-filter"
                    value={selectedSkill}
                    onChange={(e) => setSelectedSkill(e.target.value)}
                  >
                    <option value="all">All skills</option>
                    {skillOptions.map((skill) => (
                      <option key={skill} value={skill}>{skill}</option>
                    ))}
                  </select>
                </div>

                <div className="filter-group">
                  <label htmlFor="job-sort-filter">Sort by</label>
                  <select
                    id="job-sort-filter"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="recent">Most recent</option>
                    <option value="title">Title A-Z</option>
                    <option value="salary-desc">Salary high to low</option>
                    <option value="salary-asc">Salary low to high</option>
                  </select>
                </div>

                {role === "CANDIDATE" && (
                  <div className="filter-group">
                    <label htmlFor="job-match-filter">Min match: {minMatch}%</label>
                    <input
                      id="job-match-filter"
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={minMatch}
                      onChange={(e) => setMinMatch(Number(e.target.value))}
                    />
                  </div>
                )}
              </div>
            </div>
            {token && role === "CANDIDATE" && (
              <div className="recommendations-section">
                <h2 className="section-title clean">
                  Recommended For You
                  {recommendationsLoading && (
                    <span className="loading-text">Loading...</span>
                  )}
                </h2>
                {recommendationsError && (
                  <div className="recommendation-error-message">
                    {recommendationsError}
                  </div>
                )}
                <div className="job-list">
                  {recommendationsLoading ? (
                    <div className="loading-container">
                      <div className="loading-spinner"></div>
                    </div>
                  ) : filteredRecommendations.length === 0 && candidates.length === 0 ? (
                    <div className="no-jobs-message">
                      {recommendationsError || "No recommendations available. Complete your profile for better matches."}
                    </div>
                  ) : (
                    <>
                      {filteredRecommendations.map(job => renderJobCard(job, true))}
                      {candidates.slice(0, 3).map(candidate => renderCandidateCard(candidate, true))}
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="latest-jobs-section">
              <h2 className="section-title clean">Latest Job Offers</h2>
              <div className="job-list">
                {filteredJobs.length === 0 ? (
                  <div className="no-jobs-message">
                    No job offers match your search criteria.
                  </div>
                ) : (
                  filteredJobs.map(job => renderJobCard(job))
                )}
              </div>
            </div>
          </div>
        </section>
        <Footer />
      </div>
    </>
  );
};

export default Home;