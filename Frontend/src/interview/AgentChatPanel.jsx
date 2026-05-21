import { useEffect, useRef, useState } from 'react';
import { containsProfanity } from './utils/profanityFilter';
import './AgentChatPanel.css';

// Belt-and-suspenders: strip any leading sentiment label that may bleed
// through from the agent (the system prompt forbids it, but LLMs sometimes
// echo POSITIVE/NEGATIVE/NEUTRAL anyway). Keeps the candidate-facing chat
// free of analyst-only tokens regardless of upstream behavior.
const SENTIMENT_PREFIX_RX = /^(?:POSITIVE|NEGATIVE|NEUTRAL)[.!,:;\s-]+/i;
const stripSentimentPrefix = (s) =>
  String(s || '').replace(SENTIMENT_PREFIX_RX, '').trim();

/**
 * Adaptive interview agent chat panel.
 *
 * Props:
 *   socket    — socket.io client instance (already connected + joined to roomId)
 *   roomId    — CallRoom.roomId (string, broadcast channel)
 *   roomDbId  — CallRoom._id (Mongo id, used as interview_id by the Python agent)
 *   isRH      — true to show Start/Switch/End controls + scoring readout
 */
const PHASE_LABEL = { intro: 'HR Intro', technical: 'Technical' };
const STYLE_OPTIONS = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'strict', label: 'Strict' },
  { value: 'senior', label: 'Senior' },
  { value: 'junior', label: 'Junior' },
  { value: 'fast_screening', label: 'Fast' },
];

export default function AgentChatPanel({
  socket,
  roomId,
  roomDbId,
  isRH = false,
  interviewStarting = false,
  candidateDraftText = null,
  turnState = 'candidate_listening',
  turnStatusLabel = '',
  submitDisabled = false,
  inputDisabled = false,
  onTypingChange,
  onCandidateAnswerSubmit,
  onSubmitVoiceDraft,
  canSubmitVoiceDraft = false,
  recoverableAgentError = '',
  onRetryAgentResponse,
  agentRetrying = false,
  initialAgentMessage = '',
  initialAgentPhase = '',
  initialAgentDifficulty = null,
  initialAgentSkill = '',
  initialAgentTurnIndex = null,
}) {
  const [messages, setMessages] = useState([]); // { role: 'agent'|'candidate', text, meta?, ts }
  const [sessionActive, setSessionActive] = useState(false);
  const [phase, setPhase] = useState('intro');
  const [scoring, setScoring] = useState(null); // { score, confidence, theta, stress_level, agent_mode, reasoning }
  const [lastSkill, setLastSkill] = useState('');
  const [lastDifficulty, setLastDifficulty] = useState(null);
  const [agentMode, setAgentMode] = useState('normal');
  const [stressLevel, setStressLevel] = useState(0);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftBubble, setDraftBubble] = useState(''); // live STT ghost bubble
  const [interviewStyle, setInterviewStyle] = useState('friendly');
  const [finalReport, setFinalReport] = useState(null);
  const feedRef = useRef(null);
  const autoStartTriggeredRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const pendingTypedAnswerRef = useRef('');
  const submitAnswerRef = useRef(null);
  // Keys of agent messages already added — checked synchronously to survive
  // React's batching where two near-simultaneous events both see stale `prev`.
  const seenAgentMsgKeysRef = useRef(new Set());

  useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);

  useEffect(() => {
    submitAnswerRef.current = onCandidateAnswerSubmit || null;
  }, [onCandidateAnswerSubmit]);

  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;

      const incomingText = String(payload.text || '').trim();
      // Build a stable key: turnIndex (if present) + first 120 chars of text.
      // Check synchronously via ref — immune to React batching race where two
      // near-simultaneous events both see the same stale `prev` snapshot.
      const msgKey = `${payload.turnIndex ?? 'na'}::${incomingText.slice(0, 120)}`;
      if (seenAgentMsgKeysRef.current.has(msgKey)) {
        console.log('💬 [AgentChatPanel] Deduped duplicate message key=', msgKey);
        return;
      }
      seenAgentMsgKeysRef.current.add(msgKey);

      console.log('💬 [AgentChatPanel] Received agent message:', payload);
      const wasSessionInactive = !sessionActiveRef.current;
      setSessionActive(true);
      setBusy(false);
      setPhase(payload.phase || 'intro');
      if (payload.interviewStyle) setInterviewStyle(payload.interviewStyle);
      if (payload.difficulty != null) setLastDifficulty(payload.difficulty);
      if (payload.skillFocus) setLastSkill(payload.skillFocus);

      const now = Date.now();
      const cleanText = stripSentimentPrefix(payload.text || '');
      console.log('💬 [AgentChatPanel] Adding new agent message to feed:', incomingText);
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          text: cleanText,
          meta: { difficulty: payload.difficulty, skillFocus: payload.skillFocus, turnIndex: payload.turnIndex },
          ts: now,
        },
      ]);

      // Candidate typed before the session was ready:
      // start intro first, then forward the queued answer automatically.
      if (!isRH && wasSessionInactive && pendingTypedAnswerRef.current && socket && roomDbId) {
        const queued = pendingTypedAnswerRef.current;
        pendingTypedAnswerRef.current = '';
        if (submitAnswerRef.current) {
          void submitAnswerRef.current(queued);
        } else {
          setBusy(true);
          socket.emit('agent:candidate-turn', {
            roomId,
            roomDbId,
            text: queued,
            answerText: queued,
            answerSource: 'typed',
            sentiment: null,
            source: 'typed',
          });
        }
      }
    };

    const onScore = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
      if (payload.scoring) {
        setScoring(payload.scoring);
        if (payload.scoring.stress_level != null) setStressLevel(payload.scoring.stress_level);
        if (payload.scoring.agent_mode) setAgentMode(payload.scoring.agent_mode);
      }
      if (payload.interviewStyle) setInterviewStyle(payload.interviewStyle);
    };

    const onEnded = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
      setSessionActive(false);
      setBusy(false);
      setFinalReport(payload.report || payload.snapshot?.report || null);
      setMessages((prev) => [...prev, { role: 'system', text: 'Session ended.', ts: Date.now() }]);
    };

    const onThinking = (payload) => {
      if (payload?.roomId && roomId && payload.roomId !== roomId) return;
      setBusy(true);
      setError('');
    };

    const onError = (payload) => {
      setBusy(false);
      const code = payload?.code || '';
      const rawMessage = String(payload?.message || '');
      const safeMessage = code === 'AGENT_ABORTED' || /abort/i.test(rawMessage)
        ? 'The interviewer response was interrupted. Retrying...'
        : (payload?.retryable
            ? 'The interviewer response was interrupted. You can retry the AI response.'
            : 'The interviewer had trouble responding. Please try again.');
      setError(safeMessage);
      if (!sessionActive) {
        autoStartTriggeredRef.current = false;
      }
      setTimeout(() => setError(''), 6000);
    };

    const onCandidateMessage = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
      // Drop any synthetic "sentiment_label" packets the server may emit —
      // POSITIVE/NEGATIVE/NEUTRAL strings must never appear in the
      // candidate-facing transcript. Sentiment lives in the recruiter
      // report and per-message `meta.sentiment` only.
      if (payload.type === 'sentiment_label') return;
      setDraftBubble(''); // final answer arrived — drop the ghost
      setMessages((prev) => {
        // Deduplicate: if we just pushed an optimistic local bubble, skip the echo.
        const lastCandidate = [...prev].reverse().find((m) => m.role === 'candidate');
        if (
          lastCandidate &&
          lastCandidate.text.trim() === String(payload.text || '').trim() &&
          Math.abs((lastCandidate.ts || 0) - Date.now()) < 5000
        ) {
          return prev;
        }
        return [
          ...prev,
          {
            role: 'candidate',
            text: payload.text || '',
            meta: { source: payload.source || 'voice', sentiment: payload.sentiment },
            ts: payload.ts || Date.now(),
          },
        ];
      });
    };

    const onCandidateDraft = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
      setDraftBubble(String(payload.text || ''));
    };

    const onLocalCandidateMessage = (ev) => {
      const text = String(ev?.detail?.text || '').trim();
      if (!text) {
        console.log('💬 [AgentChatPanel] Skipping empty candidate message');
        return;
      }
      console.log('💬 [AgentChatPanel] Local candidate message received:', text, ev?.detail?.sentiment);
      setDraftBubble('');
      setMessages((prev) => {
        const lastCandidate = [...prev].reverse().find((m) => m.role === 'candidate');
        if (
          lastCandidate &&
          lastCandidate.text.trim() === text &&
          Math.abs((lastCandidate.ts || 0) - Date.now()) < 5000
        ) {
          console.log('💬 [AgentChatPanel] Deduped local candidate message');
          return prev;
        }   
        console.log('💬 [AgentChatPanel] Adding local candidate message:', text);
        return [
          ...prev,
          {
            role: 'candidate',
            text,
            meta: { source: ev?.detail?.source || 'voice', sentiment: ev?.detail?.sentiment },
            ts: ev?.detail?.ts || Date.now(),
          },
        ];
      });
    };

    socket.on('agent:message', onMessage);
    socket.on('agent:score', onScore);
    socket.on('agent:ended', onEnded);
    socket.on('agent:thinking', onThinking);
    socket.on('agent:error', onError);
    socket.on('candidate:message', onCandidateMessage);
    socket.on('candidate:draft', onCandidateDraft);
    globalThis.addEventListener('candidate-local-message', onLocalCandidateMessage);

    return () => {
      socket.off('agent:message', onMessage);
      socket.off('agent:score', onScore);
      socket.off('agent:ended', onEnded);
      socket.off('agent:thinking', onThinking);
      socket.off('agent:error', onError);
      socket.off('candidate:message', onCandidateMessage);
      socket.off('candidate:draft', onCandidateDraft);
      globalThis.removeEventListener('candidate-local-message', onLocalCandidateMessage);
    };
  }, [socket, roomId]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages, draftBubble]);

  useEffect(() => {
    if (candidateDraftText == null) return;
    setDraftBubble(String(candidateDraftText || ''));
  }, [candidateDraftText]);

  useEffect(() => {
    const text = String(initialAgentMessage || '').trim();
    if (!text) return;

    setSessionActive(true);
    if (initialAgentPhase) setPhase(initialAgentPhase);
    if (initialAgentDifficulty != null) setLastDifficulty(initialAgentDifficulty);
    if (initialAgentSkill) setLastSkill(initialAgentSkill);

    setMessages((prev) => {
      const alreadyShown = prev.some(
        (message) => message.role === 'agent' && String(message.text || '').trim() === text,
      );
      if (alreadyShown) return prev;
      return [
        ...prev,
        {
          role: 'agent',
          text,
          meta: {
            difficulty: initialAgentDifficulty,
            skillFocus: initialAgentSkill,
            turnIndex: initialAgentTurnIndex,
          },
          ts: Date.now(),
        },
      ];
    });
  }, [initialAgentMessage, initialAgentPhase, initialAgentDifficulty, initialAgentSkill, initialAgentTurnIndex]);

  useEffect(() => {
    autoStartTriggeredRef.current = false;
  }, [roomId, roomDbId]);

  useEffect(() => {
    if (!isRH || !socket || !roomId || !roomDbId) return;
    if (sessionActive || busy || autoStartTriggeredRef.current) return;

    autoStartTriggeredRef.current = true;
    setError('');
    setBusy(true);
    setMessages([]);
    setScoring(null);
    setFinalReport(null);
    setPhase('intro');
    socket.emit('agent:start-session', { roomId, roomDbId, phase: 'intro', interviewStyle });
  }, [isRH, socket, roomId, roomDbId, sessionActive, busy, interviewStyle]);

  const startSession = (nextPhase = 'intro', { restart = false } = {}) => {
    if (!socket) {
      setError('Socket not connected yet. Please wait 1-2 seconds and try again.');
      return;
    }
    setError('');
    setBusy(true);
    setMessages([]);
    setScoring(null);
    setFinalReport(null);
    setPhase(nextPhase);
    socket.emit('agent:start-session', { roomId, roomDbId, phase: nextPhase, restart, interviewStyle });
  };

  const switchPhase = (nextPhase) => {
    if (!socket) {
      setError('Socket not connected yet.');
      return;
    }
    setBusy(true);
    setPhase(nextPhase);
    socket.emit('agent:switch-phase', { roomId, roomDbId, phase: nextPhase });
  };

  const endSession = () => {
    if (!socket) return;
    socket.emit('agent:end-session', { roomId, roomDbId });
  };

  const sendAnswer = async () => {
    const text = input.trim();
    if (!text || !socket || !roomDbId) return;
    if (submitDisabled) return;

    if (containsProfanity(text)) {
      setError('Please avoid inappropriate language in your answer.');
      setTimeout(() => setError(''), 3500);
      return;
    }

    if (!sessionActive) {
      pendingTypedAnswerRef.current = text;
      setInput('');
      onTypingChange?.(false);
      setBusy(true);
      socket.emit('agent:start-session', { roomId, roomDbId, phase: 'intro', interviewStyle });
      return;
    }

    if (onCandidateAnswerSubmit) {
      const accepted = await onCandidateAnswerSubmit(text);
      if (!accepted) {
        setError('Please type a complete answer before sending.');
        setTimeout(() => setError(''), 3500);
        return;
      }
      setInput('');
      onTypingChange?.(false);
      setBusy(true);
      return;
    }

    setInput('');
    onTypingChange?.(false);
    setBusy(true);
    socket.emit('agent:candidate-turn', {
      roomId,
      roomDbId,
      text,
      answerText: text,
      answerSource: 'typed',
      source: 'typed',
      timestamp: Date.now(),
    });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAnswer();
    }
  };

  const categoryScores = scoring?.category_scores || finalReport?.category_scores || null;

  return (
    <div className={`agent-panel ${isRH ? 'agent-panel--rh' : 'agent-panel--candidate'}`}>
      <div className="agent-panel__header">
        <div className="agent-panel__title">
          <span className="agent-panel__bot">🤖</span>
          <span>AI Interviewer</span>
          <span className={`agent-panel__phase agent-panel__phase--${phase}`}>
            {PHASE_LABEL[phase] || phase}
          </span>
        </div>
        {isRH && (
          <div className="agent-panel__controls">
            <div className="agent-style" role="group" aria-label="Interview style">
              {STYLE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`agent-style__option ${interviewStyle === option.value ? 'agent-style__option--active' : ''}`}
                  onClick={() => setInterviewStyle(option.value)}
                  disabled={busy}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {!sessionActive ? (
              <button className="agent-btn" onClick={() => startSession('intro', { restart: true })} disabled={busy}>
                ↻ Restart Intro
              </button>
            ) : (
              <>
                {phase === 'intro' ? (
                  <button className="agent-btn" onClick={() => switchPhase('technical')} disabled={busy}>
                    ⇨ Switch to Technical
                  </button>
                ) : (
                  <button className="agent-btn" onClick={() => switchPhase('intro')} disabled={busy}>
                    ⇦ Back to Intro
                  </button>
                )}
                <button className="agent-btn agent-btn--danger" onClick={endSession}>
                  ■ End
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {isRH && scoring && (
        <div className="agent-panel__scoring">
          <div className="scoring-item">
            <span className="scoring-label">θ</span>
            <span className="scoring-value">{(scoring.theta ?? 0).toFixed(2)}</span>
          </div>
          <div className="scoring-item">
            <span className="scoring-label">Score</span>
            <span className="scoring-value">{(scoring.score ?? 0).toFixed(2)}</span>
          </div>
          <div className="scoring-item">
            <span className="scoring-label">Confidence</span>
            <span className="scoring-value">{(scoring.confidence ?? 0).toFixed(2)}</span>
          </div>
          {categoryScores?.hr && (
            <div className="scoring-item">
              <span className="scoring-label">HR</span>
              <span className="scoring-value">{(categoryScores.hr.score ?? 0).toFixed(2)}</span>
            </div>
          )}
          {categoryScores?.technical && (
            <div className="scoring-item">
              <span className="scoring-label">Tech</span>
              <span className="scoring-value">{(categoryScores.technical.score ?? 0).toFixed(2)}</span>
            </div>
          )}
          {lastDifficulty != null && (
            <div className="scoring-item">
              <span className="scoring-label">Difficulty</span>
              <span className="scoring-value">{lastDifficulty}/5</span>
            </div>
          )}
          {lastSkill && (
            <div className="scoring-item scoring-item--wide">
              <span className="scoring-label">Skill</span>
              <span className="scoring-value">{lastSkill}</span>
            </div>
          )}
          {scoring.reasoning && (
            <div className="scoring-reasoning" title={scoring.reasoning}>
              {scoring.reasoning}
            </div>
          )}
          {/* Stress + Agent Mode */}
          <div className="scoring-item scoring-item--wide">
            <span className="scoring-label">Stress</span>
            <div className="stress-meter">
              <div
                className={`stress-bar stress-bar--${agentMode}`}
                style={{ width: `${(stressLevel || 0) * 100}%` }}
              />
            </div>
            <span className="stress-label">{agentMode.toUpperCase()} ({(stressLevel ?? 0).toFixed(2)})</span>
          </div>
        </div>
      )}

      {error && <div className="agent-panel__error">{error}</div>}
      {!isRH && recoverableAgentError && (
        <div className="agent-panel__notice">
          <span>{recoverableAgentError}</span>
          {onRetryAgentResponse && !agentRetrying && !/inappropriate language/i.test(recoverableAgentError) && (
            <button type="button" className="agent-btn" onClick={onRetryAgentResponse}>
              Retry AI response
            </button>
          )}
        </div>
      )}

      {isRH && finalReport && (
        <div className="agent-panel__report">
          <div className="report-head">
            <span className="report-title">Final Report</span>
            <span className={`report-pill report-pill--${finalReport.recommendation?.label || 'mixed_signal'}`}>
              {String(finalReport.recommendation?.label || 'mixed_signal').replaceAll('_', ' ')}
            </span>
          </div>
          <div className="report-grid">
            <div>
              <span className="report-label">Overall</span>
              <strong>{(finalReport.category_scores?.overall?.score ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <span className="report-label">HR</span>
              <strong>{(finalReport.category_scores?.hr?.score ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <span className="report-label">Tech</span>
              <strong>{(finalReport.category_scores?.technical?.score ?? 0).toFixed(2)}</strong>
            </div>
            <div>
              <span className="report-label">Answers</span>
              <strong>{finalReport.evaluated_answers ?? 0}</strong>
            </div>
          </div>
          {finalReport.recommendation?.summary && (
            <p className="report-summary">{finalReport.recommendation.summary}</p>
          )}
          {!!finalReport.strengths?.length && (
            <div className="report-list">
              <span className="report-label">Strengths</span>
              {finalReport.strengths.slice(0, 3).map((item, idx) => (
                <p key={`strength-${idx}`}>{item}</p>
              ))}
            </div>
          )}
          {!!finalReport.concerns?.length && (
            <div className="report-list">
              <span className="report-label">Concerns</span>
              {finalReport.concerns.slice(0, 3).map((item, idx) => (
                <p key={`concern-${idx}`}>{item}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="agent-panel__feed" ref={feedRef}>
        {messages.length === 0 ? (
          <div className="agent-panel__empty">
            {isRH
              ? 'Interview intro starts automatically when the room is ready.'
              : 'Waiting for the interviewer to start the session. You can type below once your mic and camera are ready.'}
          </div>
        ) : (
          messages.map((m, idx) => (
            // Sentiment/emotion labels are intentionally not rendered for
            // candidate turns: emotion is not used in the recruitment decision.
            <div key={idx} className={`agent-msg agent-msg--${m.role}`}>
              {m.role === 'agent' && m.meta?.difficulty != null && (
                <span className="agent-msg__badge" title={m.meta.skillFocus || ''}>
                  D{m.meta.difficulty}
                </span>
              )}
              <span className="agent-msg__text">{m.text}</span>
            </div>
          ))
        )}
        {busy && messages.length > 0 && (
          <div className="agent-msg agent-msg--agent agent-msg--thinking">
            <span className="agent-msg__text">
              <span className="thinking-dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </span>
          </div>
        )}
        {(draftBubble || turnState === 'candidate_answering') && (
          <div className="agent-msg agent-msg--candidate agent-msg--draft">
            <span className="agent-msg__text" style={{ opacity: 0.7, fontStyle: 'italic' }}>
              {draftBubble || 'Listening'}
              <span style={{ marginLeft: 4 }}>…</span>
            </span>
          </div>
        )}
      </div>

      {!isRH && (
        <div className="agent-panel__composer">
          {turnStatusLabel && (
            <div className={`agent-composer__status agent-composer__status--${turnState}`}>
              {turnStatusLabel}
            </div>
          )}
          <textarea
            className="agent-composer__input"
            placeholder="Type your answer… (Enter to send, Shift+Enter for newline)"
            rows={2}
            value={input}
            onChange={(e) => {
              const nextValue = e.target.value;
              setInput(nextValue);
              if (containsProfanity(nextValue)) {
                setError('Please avoid inappropriate language in your answer.');
              } else if (error) {
                setError('');
              }
              onTypingChange?.(!!nextValue.trim());
            }}
            onKeyDown={onKeyDown}
            disabled={inputDisabled}
          />
          {canSubmitVoiceDraft && (
            <button
              className="agent-btn"
              onClick={onSubmitVoiceDraft}
              disabled={busy || submitDisabled}
            >
              Submit voice answer
            </button>
          )}
          <button
            className="agent-btn agent-btn--primary"
            onClick={sendAnswer}
            disabled={busy || submitDisabled || !input.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
