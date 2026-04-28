import { useEffect, useRef, useState } from 'react';
import './AgentChatPanel.css';

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

export default function AgentChatPanel({ socket, roomId, roomDbId, isRH = false }) {
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

  useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);

  useEffect(() => {
    if (!socket) return undefined;

    const onMessage = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
      const wasSessionInactive = !sessionActiveRef.current;
      setSessionActive(true);
      setBusy(false);
      setPhase(payload.phase || 'intro');
      if (payload.interviewStyle) setInterviewStyle(payload.interviewStyle);
      if (payload.difficulty != null) setLastDifficulty(payload.difficulty);
      if (payload.skillFocus) setLastSkill(payload.skillFocus);
      setMessages((prev) => {
        // The server fans this event out to room + direct user sockets, so
        // the same turn can arrive twice. Dedupe on turnIndex + text.
        const incomingText = String(payload.text || '').trim();
        const last = prev.at(-1);
        if (
          last &&
          last.role === 'agent' &&
          String(last.text || '').trim() === incomingText &&
          last.meta?.turnIndex === payload.turnIndex
        ) {
          return prev;
        }
        return [
          ...prev,
          {
            role: 'agent',
            text: payload.text || '',
            meta: { difficulty: payload.difficulty, skillFocus: payload.skillFocus, turnIndex: payload.turnIndex },
            ts: Date.now(),
          },
        ];
      });

      // Candidate typed before the session was ready:
      // start intro first, then forward the queued answer automatically.
      if (!isRH && wasSessionInactive && pendingTypedAnswerRef.current && socket && roomDbId) {
        const queued = pendingTypedAnswerRef.current;
        pendingTypedAnswerRef.current = '';
        setBusy(true);
        socket.emit('agent:candidate-turn', {
          roomId,
          roomDbId,
          text: queued,
          sentiment: null,
          source: 'text',
        });
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

    const onError = (payload) => {
      setBusy(false);
      setError(payload?.message || 'Agent error');
      if (!sessionActive) {
        autoStartTriggeredRef.current = false;
      }
      setTimeout(() => setError(''), 6000);
    };

    const onCandidateMessage = (payload) => {
      if (payload.roomId && roomId && payload.roomId !== roomId) return;
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
      if (!text) return;
      setDraftBubble('');
      setMessages((prev) => {
        const lastCandidate = [...prev].reverse().find((m) => m.role === 'candidate');
        if (
          lastCandidate &&
          lastCandidate.text.trim() === text &&
          Math.abs((lastCandidate.ts || 0) - Date.now()) < 5000
        ) {
          return prev;
        }   
        return [
          ...prev,
          {
            role: 'candidate',
            text,
            meta: { source: 'voice', sentiment: ev?.detail?.sentiment },
            ts: ev?.detail?.ts || Date.now(),
          },
        ];
      });
    };

    socket.on('agent:message', onMessage);
    socket.on('agent:score', onScore);
    socket.on('agent:ended', onEnded);
    socket.on('agent:error', onError);
    socket.on('candidate:message', onCandidateMessage);
    socket.on('candidate:draft', onCandidateDraft);
    globalThis.addEventListener('candidate-local-message', onLocalCandidateMessage);

    return () => {
      socket.off('agent:message', onMessage);
      socket.off('agent:score', onScore);
      socket.off('agent:ended', onEnded);
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

  const sendAnswer = () => {
    const text = input.trim();
    if (!text || !socket || !roomDbId) return;

    // Show candidate message instantly in the chat feed.
    setMessages((prev) => [
      ...prev,
      {
        role: 'candidate',
        text,
        meta: { source: 'text', sentiment: null },
        ts: Date.now(),
      },
    ]);
    setInput('');

    if (!sessionActive) {
      pendingTypedAnswerRef.current = text;
      setBusy(true);
      socket.emit('agent:start-session', { roomId, roomDbId, phase: 'intro', interviewStyle });
      return;
    }

    setBusy(true);
    socket.emit('agent:candidate-turn', { roomId, roomDbId, text, sentiment: null, source: 'text' });
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
              : 'Waiting for the interviewer to start the session…'}
          </div>
        ) : (
          messages.map((m, idx) => {
            const sentimentLabel = m.role === 'candidate' ? (m.meta?.sentiment?.label || '').toUpperCase() : '';
            const sentimentClass = sentimentLabel.includes('POSITIVE')
              ? 'positive'
              : sentimentLabel.includes('NEGATIVE')
              ? 'negative'
              : sentimentLabel
              ? 'neutral'
              : '';
            return (
              <div key={idx} className={`agent-msg agent-msg--${m.role}`}>
                {m.role === 'agent' && m.meta?.difficulty != null && (
                  <span className="agent-msg__badge" title={m.meta.skillFocus || ''}>
                    D{m.meta.difficulty}
                  </span>
                )}
                <span className="agent-msg__text">{m.text}</span>
                {sentimentClass && (
                  <span className={`agent-msg__sentiment agent-msg__sentiment--${sentimentClass}`}>
                    {sentimentLabel}
                  </span>
                )}
              </div>
            );
          })
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
        {draftBubble && (
          <div className="agent-msg agent-msg--candidate agent-msg--draft">
            <span className="agent-msg__text" style={{ opacity: 0.7, fontStyle: 'italic' }}>
              {draftBubble}
              <span style={{ marginLeft: 4 }}>…</span>
            </span>
          </div>
        )}
      </div>

      {!isRH && sessionActive && (
        <div className="agent-panel__composer">
          <textarea
            className="agent-composer__input"
            placeholder="Type your answer… (Enter to send, Shift+Enter for newline)"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          <button
            className="agent-btn agent-btn--primary"
            onClick={sendAnswer}
            disabled={busy || !input.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
