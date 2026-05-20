"""Realtime advisory interview analysis — Phase 5.

This module analyzes live interview streams while they are happening. Outputs are
strictly advisory and are never persisted into or allowed to overwrite the final
Phase 3 deterministic report.

Supported websocket events:
  - transcript.partial: {text, speaker, startMs, endMs}
  - audio.chunk:        {durationMs, speaker?} or raw bytes in route wrapper
  - silence.event:      {durationMs}
  - face.event:         {faces, centered, brightness, timestampMs}
  - ping:               {}

Server emits advisory snapshots:
  - realtime.snapshot
  - realtime.warning
  - pong
"""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

_LOG = logging.getLogger(__name__)


@dataclass
class RealtimeState:
    sessionId: str
    interviewId: str
    tenantId: str
    organizationId: str
    startedAt: datetime
    lastUpdatedAt: datetime
    transcriptChars: int = 0
    candidateSpeakingMs: int = 0
    recruiterSpeakingMs: int = 0
    silenceMs: int = 0
    interruptions: int = 0
    faceEvents: int = 0
    lowLightEvents: int = 0
    noFaceEvents: int = 0
    multiFaceEvents: int = 0
    centeredEvents: int = 0
    totalEvents: int = 0
    advisoryEvents: list[dict[str, Any]] = field(default_factory=list)


class RealtimeAnalysisSession:
    """In-memory state machine for one live interview websocket session."""

    def __init__(
        self,
        interview_id: str,
        tenant_id: str = "",
        organization_id: str = "",
        session_id: str | None = None,
    ) -> None:
        now = datetime.now(timezone.utc)
        self.state = RealtimeState(
            sessionId=session_id or f"rt_{uuid4().hex[:16]}",
            interviewId=interview_id,
            tenantId=tenant_id,
            organizationId=organization_id,
            startedAt=now,
            lastUpdatedAt=now,
        )

    def handle_event(self, event: dict[str, Any]) -> dict[str, Any]:
        """Process one client event and return an advisory snapshot."""
        event_type = str(event.get("type", "")).strip()
        payload = event.get("payload") or {}
        self.state.totalEvents += 1
        self.state.lastUpdatedAt = datetime.now(timezone.utc)

        if event_type == "transcript.partial":
            self._handle_transcript(payload)
        elif event_type == "audio.chunk":
            self._handle_audio(payload)
        elif event_type == "silence.event":
            self._handle_silence(payload)
        elif event_type == "face.event":
            self._handle_face(payload)
        elif event_type == "ping":
            return {"type": "pong", "sessionId": self.state.sessionId}
        else:
            return {
                "type": "realtime.warning",
                "sessionId": self.state.sessionId,
                "message": f"Unsupported realtime event type: {event_type}",
            }

        snapshot = self.snapshot()
        self.state.advisoryEvents.append(snapshot)
        if len(self.state.advisoryEvents) > 100:
            self.state.advisoryEvents = self.state.advisoryEvents[-100:]
        return snapshot

    def handle_binary_audio(self, chunk: bytes) -> dict[str, Any]:
        """Handle raw websocket audio bytes.

        The service only estimates activity volume here; real transcription is
        delegated to the deterministic final pipeline / transcription workers.
        """
        duration_ms = max(20, min(2000, int(len(chunk) / 32)))
        return self.handle_event(
            {"type": "audio.chunk", "payload": {"durationMs": duration_ms}}
        )

    def snapshot(self) -> dict[str, Any]:
        elapsed_ms = max(
            1,
            int(
                (self.state.lastUpdatedAt - self.state.startedAt).total_seconds() * 1000
            ),
        )
        total_speaking = self.state.candidateSpeakingMs + self.state.recruiterSpeakingMs
        candidate_ratio = (
            self.state.candidateSpeakingMs / total_speaking if total_speaking else 0.0
        )
        engagement = self._engagement_score(elapsed_ms, candidate_ratio)
        stress = self._stress_indicator(elapsed_ms)
        confidence = self._confidence_estimate(elapsed_ms)

        return {
            "type": "realtime.snapshot",
            "sessionId": self.state.sessionId,
            "interviewId": self.state.interviewId,
            "tenantId": self.state.tenantId,
            "advisoryOnly": True,
            "authoritativeFinalReport": False,
            "metrics": {
                "engagementTrend": round(engagement, 3),
                "candidateSpeakingRatio": round(candidate_ratio, 3),
                "recruiterSpeakingRatio": round(1.0 - candidate_ratio, 3)
                if total_speaking
                else 0.0,
                "silenceRatio": round(min(1.0, self.state.silenceMs / elapsed_ms), 3),
                "interruptionCount": self.state.interruptions,
                "stressIndicator": round(stress, 3),
                "confidenceEstimate": round(confidence, 3),
                "faceStability": round(self._face_stability(), 3),
            },
            "generatedAt": self.state.lastUpdatedAt.isoformat(),
        }

    def persist_final_session(self) -> None:
        """Persist the realtime session audit trail outside the final report."""
        try:
            from app.db.mongo import realtime_sessions_col

            realtime_sessions_col.update_one(
                {"sessionId": self.state.sessionId, "tenantId": self.state.tenantId},
                {
                    "$set": {
                        **asdict(self.state),
                        "startedAt": self.state.startedAt,
                        "lastUpdatedAt": self.state.lastUpdatedAt,
                        "advisoryOnly": True,
                        "doesNotOverwriteFinalReport": True,
                    }
                },
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            _LOG.warning("[Realtime] Session persistence failed: %s", exc)

    def _handle_transcript(self, payload: dict[str, Any]) -> None:
        text = str(payload.get("text", ""))
        speaker = str(payload.get("speaker", "candidate")).lower()
        duration = int(payload.get("durationMs") or 0)
        if not duration:
            start = int(payload.get("startMs") or 0)
            end = int(payload.get("endMs") or start)
            duration = max(0, end - start)
        self.state.transcriptChars += len(text)
        if speaker in {"recruiter", "interviewer", "host"}:
            self.state.recruiterSpeakingMs += duration
        else:
            self.state.candidateSpeakingMs += duration
        if "interrupt" in text.lower() or payload.get("interruption") is True:
            self.state.interruptions += 1

    def _handle_audio(self, payload: dict[str, Any]) -> None:
        duration = int(payload.get("durationMs") or 0)
        speaker = str(payload.get("speaker", "candidate")).lower()
        if speaker in {"recruiter", "interviewer", "host"}:
            self.state.recruiterSpeakingMs += duration
        else:
            self.state.candidateSpeakingMs += duration

    def _handle_silence(self, payload: dict[str, Any]) -> None:
        self.state.silenceMs += int(payload.get("durationMs") or 0)

    def _handle_face(self, payload: dict[str, Any]) -> None:
        self.state.faceEvents += 1
        faces = int(payload.get("faces") or 0)
        brightness = float(payload.get("brightness") or 100.0)
        if faces <= 0:
            self.state.noFaceEvents += 1
        if faces > 1:
            self.state.multiFaceEvents += 1
        if bool(payload.get("centered", True)):
            self.state.centeredEvents += 1
        if brightness < 45:
            self.state.lowLightEvents += 1

    def _engagement_score(self, elapsed_ms: int, candidate_ratio: float) -> float:
        speaking_balance = 1.0 - min(1.0, abs(candidate_ratio - 0.65) / 0.65)
        silence_penalty = min(0.6, self.state.silenceMs / max(1, elapsed_ms))
        face_bonus = self._face_stability() * 0.2
        return max(
            0.0, min(1.0, 0.65 * speaking_balance + face_bonus - silence_penalty)
        )

    def _stress_indicator(self, elapsed_ms: int) -> float:
        interruption_rate = min(1.0, self.state.interruptions / 5.0)
        silence_rate = min(1.0, self.state.silenceMs / max(1, elapsed_ms))
        visual_instability = 1.0 - self._face_stability()
        return max(
            0.0,
            min(
                1.0,
                0.45 * interruption_rate
                + 0.35 * silence_rate
                + 0.20 * visual_instability,
            ),
        )

    def _confidence_estimate(self, elapsed_ms: int) -> float:
        event_factor = min(1.0, math.log1p(self.state.totalEvents) / math.log1p(50))
        duration_factor = min(1.0, elapsed_ms / 120_000)
        return max(0.1, min(0.95, 0.55 * event_factor + 0.40 * duration_factor))

    def _face_stability(self) -> float:
        if self.state.faceEvents <= 0:
            return 0.5
        bad = (
            self.state.noFaceEvents
            + self.state.multiFaceEvents
            + self.state.lowLightEvents
        )
        return max(0.0, min(1.0, 1.0 - bad / max(1, self.state.faceEvents * 2)))
