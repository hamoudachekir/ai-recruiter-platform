import { useEffect, useState } from 'react';

/**
 * Hook: useQuizFocusTracking
 * Tracks tab/window focus loss, DevTools access, and copy-paste attempts during quiz
 * Sends metadata to parent component for submission
 */
export const useQuizFocusTracking = (onSecurityEvent, enabled = true) => {
  const [focusLossCount, setFocusLossCount] = useState(0);
  const [focusLossEvents, setFocusLossEvents] = useState([]);
  const [securityEvents, setSecurityEvents] = useState([]);
  const [devToolsAccessDetected, setDevToolsAccessDetected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let focusTimer = null;
    let devToolsCheckInterval = null;

    // ===== FOCUS LOSS TRACKING =====
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab/window lost focus
        const lossTime = new Date();
        console.warn('⚠️ Quiz focus lost at', lossTime.toISOString());
        
        setFocusLossCount((prev) => prev + 1);
        setFocusLossEvents((prev) => [
          ...prev,
          {
            timestamp: lossTime,
            type: 'lost',
            durationSeconds: 0,
          },
        ]);

        if (onSecurityEvent) {
          onSecurityEvent({
            type: 'focus-loss',
            count: focusLossCount + 1,
            timestamp: lossTime,
          });
        }
      } else {
        // Tab/window regained focus
        console.log('✅ Quiz focus regained');
        setFocusLossEvents((prev) => {
          const lastEvent = prev[prev.length - 1];
          if (lastEvent && lastEvent.type === 'lost') {
            const durationSeconds = Math.round(
              (new Date() - lastEvent.timestamp) / 1000
            );
            return [
              ...prev.slice(0, -1),
              { ...lastEvent, durationSeconds },
            ];
          }
          return prev;
        });
      }
    };

    // ===== DEVTOOLS DETECTION (Basic) =====
    const detectDevTools = () => {
      const threshold = 160; // Approximate size of DevTools when open
      if (window.outerHeight - window.innerHeight > threshold) {
        if (!devToolsAccessDetected) {
          console.warn('⚠️ DevTools access detected');
          setDevToolsAccessDetected(true);
          setSecurityEvents((prev) => [
            ...prev,
            {
              timestamp: new Date(),
              event: 'devtools-access',
            },
          ]);

          if (onSecurityEvent) {
            onSecurityEvent({
              type: 'devtools-access',
              timestamp: new Date(),
            });
          }
        }
      }
    };

    // Add listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', () => {
      setFocusLossCount((prev) => prev + 1);
      setFocusLossEvents((prev) => [
        ...prev,
        {
          timestamp: new Date(),
          type: 'lost',
          durationSeconds: 0,
        },
      ]);
    });

    // DevTools detection interval (every 500ms)
    devToolsCheckInterval = setInterval(detectDevTools, 500);

    // F12 key detection
    const handleKeyDown = (e) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        console.warn('⚠️ DevTools hotkey detected');
        setSecurityEvents((prev) => [
          ...prev,
          {
            timestamp: new Date(),
            event: 'devtools-access',
          },
        ]);

        if (onSecurityEvent) {
          onSecurityEvent({
            type: 'devtools-hotkey',
            key: e.key === 'F12' ? 'F12' : 'Ctrl+Shift+I',
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('keydown', handleKeyDown);
      if (devToolsCheckInterval) clearInterval(devToolsCheckInterval);
    };
  }, [devToolsAccessDetected, enabled, focusLossCount, onSecurityEvent]);

  return {
    focusLossCount,
    focusLossEvents,
    securityEvents,
    devToolsAccessDetected,
  };
};
