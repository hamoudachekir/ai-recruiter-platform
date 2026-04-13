import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell } from "@fortawesome/free-solid-svg-icons";
import AuthContext from "../../context/AuthContext";
import "./Navbar.css";

const NOTIFICATION_API_BASE = "http://localhost:3001/Frontend/notifications";

const formatNotificationDate = (value) => {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
};

const normalizeNotifications = (items) => {
  if (!Array.isArray(items)) return [];
  return [...items].sort((left, right) => new Date(right?.date || 0) - new Date(left?.date || 0));
};

const Navbar = () => {
  const userId = localStorage.getItem("userId");
  const userRole = (localStorage.getItem("role") || "").toUpperCase();

  const { isAuthenticated, logout } = useContext(AuthContext);
  const navigate = useNavigate();

  const [notifications, setNotifications] = useState([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isNotificationLoading, setIsNotificationLoading] = useState(false);
  const notificationMenuRef = useRef(null);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification?.seen).length,
    [notifications]
  );

  const fetchNotifications = useCallback(
    async (silent = false) => {
      if (!isAuthenticated || !userId) return;

      if (!silent) {
        setIsNotificationLoading(true);
      }

      try {
        const res = await axios.get(`${NOTIFICATION_API_BASE}/${userId}`);
        const list = Array.isArray(res?.data?.notifications) ? res.data.notifications : [];
        setNotifications(normalizeNotifications(list));
      } catch (error) {
        console.error("Failed to fetch navbar notifications:", error);
      } finally {
        if (!silent) {
          setIsNotificationLoading(false);
        }
      }
    },
    [isAuthenticated, userId]
  );

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      setNotifications([]);
      setIsNotificationOpen(false);
      return;
    }

    fetchNotifications(false);
    const intervalId = setInterval(() => fetchNotifications(true), 30000);

    return () => {
      clearInterval(intervalId);
    };
  }, [fetchNotifications, isAuthenticated, userId]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationMenuRef.current && !notificationMenuRef.current.contains(event.target)) {
        setIsNotificationOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setIsNotificationOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const syncNotificationsFromResponse = (incoming, fallbackUpdater) => {
    if (Array.isArray(incoming)) {
      setNotifications(normalizeNotifications(incoming));
      return;
    }

    if (typeof fallbackUpdater === "function") {
      setNotifications((previous) => normalizeNotifications(fallbackUpdater(previous)));
    }
  };

  const handleKeepNotification = async (notificationId) => {
    if (!notificationId || !userId) return;
    try {
      const res = await axios.patch(`${NOTIFICATION_API_BASE}/${userId}/${notificationId}/seen`, {
        seen: true,
      });
      syncNotificationsFromResponse(res?.data?.notifications, (previous) =>
        previous.map((notification) =>
          String(notification?._id || "") === String(notificationId)
            ? { ...notification, seen: true }
            : notification
        )
      );
    } catch (error) {
      console.error("Failed to keep notification:", error);
    }
  };

  const handleClearNotification = async (notificationId) => {
    if (!notificationId || !userId) return;
    try {
      const res = await axios.delete(`${NOTIFICATION_API_BASE}/${userId}/${notificationId}`);
      syncNotificationsFromResponse(res?.data?.notifications, (previous) =>
        previous.filter((notification) => String(notification?._id || "") !== String(notificationId))
      );
    } catch (error) {
      console.error("Failed to clear notification:", error);
    }
  };

  const handleKeepAllNotifications = async () => {
    if (!userId || notifications.length === 0) return;
    try {
      const res = await axios.patch(`${NOTIFICATION_API_BASE}/${userId}/mark-all-seen`);
      syncNotificationsFromResponse(res?.data?.notifications, (previous) =>
        previous.map((notification) => ({ ...notification, seen: true }))
      );
    } catch (error) {
      console.error("Failed to keep all notifications:", error);
    }
  };

  const handleClearAllNotifications = async () => {
    if (!userId || notifications.length === 0) return;
    try {
      await axios.delete(`${NOTIFICATION_API_BASE}/${userId}`);
      setNotifications([]);
    } catch (error) {
      console.error("Failed to clear all notifications:", error);
    }
  };

  const handleToggleNotifications = () => {
    const nextOpen = !isNotificationOpen;
    setIsNotificationOpen(nextOpen);
    if (nextOpen) {
      fetchNotifications(false);
    }
  };

  const handleLogout = () => {
    setNotifications([]);
    setIsNotificationOpen(false);
    logout();
    navigate("/login");
  };

  const profilePath = userRole === "ENTERPRISE" ? `/entreprise/${userId}` : `/profile/${userId}`;

  return (
    <nav className="futuristic-navbar navbar navbar-expand-lg">
      <div className="container-fluid">
        <Link className="navbar-brand futuristic-brand" to="/">
          <span>NEXTHIRE</span>
        </Link>
  
        <button
          className="navbar-toggler futuristic-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#navbarSupportedContent"
          aria-controls="navbarSupportedContent"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span className="navbar-toggler-icon"></span>
        </button>
  
        <div className="collapse navbar-collapse" id="navbarSupportedContent">
          <ul className="navbar-nav ms-auto align-items-center">
            <li className="nav-item">
              <Link className="nav-link futuristic-nav-link" to="/home">Home</Link>
            </li>
            <li className="nav-item">
              <Link className="nav-link futuristic-nav-link" to="/about">About</Link>
            </li>
            <li className="nav-item">
              <Link className="nav-link futuristic-nav-link" to="/service">Services</Link>
            </li>
            <li className="nav-item">
              <Link className="nav-link futuristic-nav-link" to="/why">Why Us</Link>
            </li>
            <li className="nav-item">
              <Link className="nav-link futuristic-nav-link" to="/team">Team</Link>
            </li>
  
            {/* 🔒 Authenticated User */}
            {isAuthenticated && userId ? (
  <>
    <li className="nav-item notification-nav-item" ref={notificationMenuRef}>
      <button
        type="button"
        className="notification-toggle"
        aria-label="Notifications"
        aria-expanded={isNotificationOpen}
        onClick={handleToggleNotifications}
      >
        <FontAwesomeIcon icon={faBell} />
        {unreadCount > 0 && <span className="notification-alert-dot"></span>}
        {unreadCount > 0 && (
          <span className="notification-count-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
      </button>

      {isNotificationOpen && (
        <div className="notification-dropdown" role="menu" aria-label="Notifications menu">
          <div className="notification-dropdown-header">
            <h6>Notifications</h6>
            <span>{unreadCount} new</span>
          </div>

          <div className="notification-dropdown-actions">
            <button
              type="button"
              className="notification-action-btn"
              onClick={handleKeepAllNotifications}
              disabled={notifications.length === 0}
            >
              Keep all
            </button>
            <button
              type="button"
              className="notification-action-btn danger"
              onClick={handleClearAllNotifications}
              disabled={notifications.length === 0}
            >
              Clear all
            </button>
          </div>

          <div className="notification-dropdown-list">
            {isNotificationLoading && notifications.length === 0 && (
              <p className="notification-empty-state">Loading notifications...</p>
            )}

            {!isNotificationLoading && notifications.length === 0 && (
              <p className="notification-empty-state">No notifications for now.</p>
            )}

            {notifications.map((notification, index) => {
              const notificationId = String(notification?._id || "");
              const key = notificationId || `${String(notification?.date || "")}-${String(notification?.message || "")}-${index}`;
              const unread = !notification?.seen;

              return (
                <div key={key} className={`notification-item ${unread ? "unread" : ""}`}>
                  <div className="notification-item-top">
                    <p className="notification-message">
                      {notification?.message || "You have a new notification."}
                    </p>
                    {unread && <span className="notification-item-dot"></span>}
                  </div>
                  <p className="notification-date">{formatNotificationDate(notification?.date)}</p>
                  <div className="notification-item-actions">
                    <button
                      type="button"
                      className="notification-item-btn"
                      onClick={() => handleKeepNotification(notificationId)}
                      disabled={!unread || !notificationId}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="notification-item-btn danger"
                      onClick={() => handleClearNotification(notificationId)}
                      disabled={!notificationId}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </li>

    <li className="nav-item">
      <Link
        className="nav-link futuristic-nav-link"
        to={profilePath}
      >
        {userRole === "ENTERPRISE" ? "My Enterprise" : "Mon Profil"}
      </Link>
    </li>

    {/* Interview Rooms Navigation */}
    {isAuthenticated && userId && (
      <li className="nav-item">
        <Link
          className="nav-link futuristic-nav-link"
          to={userRole === "CANDIDATE" ? "/call-room/available" : "/call-room/dashboard"}
          title={userRole === "CANDIDATE" ? "Browse available interview rooms" : "Your call room dashboard"}
        >
          {userRole === "CANDIDATE" ? "Interview Rooms" : "Call Rooms"}
        </Link>
      </li>
    )}

    <li className="nav-item">
      <button
        className="btn logout-btn"
        onClick={handleLogout}
        style={{
          background: "transparent",
          border: "2px solid #5b86e5",
          color: "#5b86e5",
          fontWeight: "600",
          borderRadius: "25px",
          transition: "all 0.3s ease",
        }}
      >
        Logout
      </button>
                </li>
              </>
            ) : (
              <>
                <li className="nav-item">
                  <Link className="btn signin-btn mx-2" to="/login">Sign In</Link>
                </li>
                <li className="nav-item">
                  <Link className="btn signup-btn" to="/register">Sign Up</Link>
                </li>
              </>
            )}
          </ul>
        </div>
      </div>
    </nav>
  );
  
};

export default Navbar;
