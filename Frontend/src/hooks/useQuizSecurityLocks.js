import { useEffect, useState } from 'react';

/**
 * Hook: useQuizSecurityLocks
 * Prevents copy-paste, right-click context menu, and DevTools during quiz
 * Shows friendly warnings instead of being aggressive
 */
export const useQuizSecurityLocks = (quizContainerId, onSecurityEvent, enabled = true) => {
  const [copyPasteAttempts, setCopyPasteAttempts] = useState(0);
  const [contextMenuAttempts, setContextMenuAttempts] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const quizContainer = quizContainerId
      ? document.getElementById(quizContainerId)
      : document.body;

    if (!quizContainer) {
      console.warn('⚠️ Quiz container not found');
      return;
    }

    // ===== COPY-PASTE PREVENTION =====
    const handleCopy = (e) => {
      e.preventDefault();
      setCopyPasteAttempts((prev) => prev + 1);

      if (onSecurityEvent) {
        onSecurityEvent({
          type: 'copy-attempt',
          timestamp: new Date(),
        });
      }

      // Show friendly warning
      const warning = document.createElement('div');
      warning.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #fff3cd;
        border: 2px solid #ffc107;
        border-radius: 8px;
        padding: 12px 16px;
        z-index: 10000;
        font-size: 14px;
        color: #333;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        animation: slideDown 0.3s ease-out;
      `;
      warning.textContent = '⚠️ Copy-paste is disabled during the quiz to ensure fair assessment.';
      document.body.appendChild(warning);

      // Add animation
      const style = document.createElement('style');
      style.textContent = `
        @keyframes slideDown {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);

      setTimeout(() => warning.remove(), 3000);
    };

    const handlePaste = (e) => {
      e.preventDefault();
      setCopyPasteAttempts((prev) => prev + 1);

      if (onSecurityEvent) {
        onSecurityEvent({
          type: 'paste-attempt',
          timestamp: new Date(),
        });
      }

      const warning = document.createElement('div');
      warning.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #fff3cd;
        border: 2px solid #ffc107;
        border-radius: 8px;
        padding: 12px 16px;
        z-index: 10000;
        font-size: 14px;
        color: #333;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      `;
      warning.textContent = '⚠️ Pasting external content is not allowed during the quiz.';
      document.body.appendChild(warning);

      setTimeout(() => warning.remove(), 3000);
    };

    const handleCut = (e) => {
      e.preventDefault();
      setCopyPasteAttempts((prev) => prev + 1);

      if (onSecurityEvent) {
        onSecurityEvent({
          type: 'cut-attempt',
          timestamp: new Date(),
        });
      }
    };

    // ===== RIGHT-CLICK CONTEXT MENU PREVENTION =====
    const handleContextMenu = (e) => {
      const isQuizArea = quizContainer.contains(e.target);
      if (isQuizArea) {
        e.preventDefault();
        setContextMenuAttempts((prev) => prev + 1);

        if (onSecurityEvent) {
          onSecurityEvent({
            type: 'context-menu-attempt',
            timestamp: new Date(),
          });
        }

        // Show tooltip
        const tooltip = document.createElement('div');
        tooltip.style.cssText = `
          position: fixed;
          top: ${e.clientY}px;
          left: ${e.clientX}px;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 12px;
          z-index: 10001;
          white-space: nowrap;
        `;
        tooltip.textContent = 'Right-click is disabled during quiz';
        document.body.appendChild(tooltip);

        setTimeout(() => tooltip.remove(), 2000);
      }
    };

    // ===== KEYBOARD SHORTCUTS PREVENTION =====
    const handleKeyDown = (e) => {
      const isQuizArea = quizContainer.contains(document.activeElement);

      if (!isQuizArea) return;

      // Ctrl+C, Ctrl+X
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'x')) {
        e.preventDefault();
        setCopyPasteAttempts((prev) => prev + 1);

        if (onSecurityEvent) {
          onSecurityEvent({
            type: `${e.key === 'c' ? 'copy' : 'cut'}-hotkey`,
            timestamp: new Date(),
          });
        }
      }

      // Ctrl+V
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        setCopyPasteAttempts((prev) => prev + 1);

        if (onSecurityEvent) {
          onSecurityEvent({
            type: 'paste-hotkey',
            timestamp: new Date(),
          });
        }
      }

      // F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+K
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && ['I', 'J', 'K'].includes(e.key.toUpperCase()))
      ) {
        e.preventDefault();

        if (onSecurityEvent) {
          onSecurityEvent({
            type: 'devtools-hotkey',
            key: e.key,
            timestamp: new Date(),
          });
        }
      }
    };

    // Add event listeners
    quizContainer.addEventListener('copy', handleCopy);
    quizContainer.addEventListener('paste', handlePaste);
    quizContainer.addEventListener('cut', handleCut);
    quizContainer.addEventListener('contextmenu', handleContextMenu);
    quizContainer.addEventListener('keydown', handleKeyDown);

    return () => {
      quizContainer.removeEventListener('copy', handleCopy);
      quizContainer.removeEventListener('paste', handlePaste);
      quizContainer.removeEventListener('cut', handleCut);
      quizContainer.removeEventListener('contextmenu', handleContextMenu);
      quizContainer.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, quizContainerId, onSecurityEvent]);

  return {
    copyPasteAttempts,
    contextMenuAttempts,
  };
};
