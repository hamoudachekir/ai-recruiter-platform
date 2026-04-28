import { Component, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate, useLocation } from 'react-router-dom';
import { AvatarWidget } from '@streamoji/avatar-widget';
import '@streamoji/avatar-widget/styles.css';

const STREAMOJI_DEFAULT_AVATAR_URL =
  'https://pub-be53cae7bd99457a8c1f11b4d38f1672.r2.dev/default-models/avatar-blue-suit.glb';

class AvatarErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('Streamoji widget render failed:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid #fecaca',
            background: '#7f1d1d',
            color: '#fee2e2',
            fontSize: 14,
          }}
        >
          Avatar temporarily unavailable. Interview audio/chat remains active.
        </div>
      );
    }

    return this.props.children;
  }
}

AvatarErrorBoundary.propTypes = {
  children: PropTypes.node,
};

/**
 * Streamoji Avatar Wrapper for Call Room
 * 
 * Integrates the Streamoji AvatarWidget into the call room and:
 * - Routes navigation requests through React Router instead of opening new tabs
 * - Listens to agent-speech events to coordinate speaking state
 * - Hides on routes that shouldn't show the widget (optional)
 * - Passes logged-in user details if available for personalization
 */
export default function StreamojiAvatarWrapper() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(null);
  const [widgetVisible, setWidgetVisible] = useState(true);

  // Get agent ID from env (backend should provide this)
  const agentId = import.meta.env.VITE_STREAMOJI_AGENT_ID || 'client_w8omf96Fz4UhrTg2UAKGzhcHzlE3';
  const fallbackAvatarUrl = import.meta.env.VITE_STREAMOJI_AVATAR_URL
    || STREAMOJI_DEFAULT_AVATAR_URL;

  // Fetch user info from localStorage if available
  useEffect(() => {
    try {
      const userId = localStorage.getItem('userId');
      const userEmail = localStorage.getItem('userEmail');
      const userName = localStorage.getItem('userName');

      if (userId) {
        setUser({
          id: userId,
          email: userEmail || undefined,
          name: userName || undefined,
        });
      }
    } catch (err) {
      console.warn('Failed to load user details:', err);
    }
  }, []);

  // Hide widget on certain routes (e.g., when showing the full avatar creator)
  useEffect(() => {
    const shouldHide = location.pathname.includes('/createAvatar') 
      || location.pathname.includes('/avatar-creator');
    setWidgetVisible(!shouldHide);
  }, [location.pathname]);

  const handleNavigationRequested = (url) => {
    if (!url) return;

    try {
      const parsedUrl = new URL(url, globalThis.window.location.origin);
      const targetPath = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
      navigate(targetPath);
    } catch {
      navigate(url);
    }
  };

  // Publish Streamoji's imperative actions (avatarSpeak, replay, etc.) on
  // the global window + dispatch a 'streamoji:ready' event so CallRoomActive
  // can route NIM-generated agent text through avatarSpeak() — which makes
  // the Streamoji avatar speak + lip-sync the words. We also dispatch
  // 'streamoji:teardown' on unmount so the parent can fall back cleanly.
  const handleAvatarReady = (actions) => {
    if (!actions) return;
    globalThis.__streamojiActions = actions;
    globalThis.dispatchEvent(new CustomEvent('streamoji:ready', { detail: actions }));
    console.log('🟣 Streamoji avatar ready — TTS will route through it');
  };

  useEffect(() => {
    return () => {
      if (globalThis.__streamojiActions) {
        delete globalThis.__streamojiActions;
      }
      globalThis.dispatchEvent(new CustomEvent('streamoji:teardown'));
    };
  }, []);

  const presetUserDetails = user
    ? {
        name: user.name,
        email: user.email,
      }
    : undefined;

  if (!widgetVisible || !agentId) return null;

  return (
    <AvatarErrorBoundary>
      <div style={{ width: '100%', minHeight: 420 }}>
        <AvatarWidget
          agentId={agentId}
          avatarUrl={fallbackAvatarUrl}
          presetUserDetails={presetUserDetails}
          onNavigationRequested={handleNavigationRequested}
          onAvatarReady={handleAvatarReady}
        />
      </div>
    </AvatarErrorBoundary>
  );
}
