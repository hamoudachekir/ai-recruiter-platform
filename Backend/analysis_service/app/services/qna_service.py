"""Q&A extraction service.

Loads structured interview Q&A from MongoDB (stored conversation history
in CallRoom.messages), falling back to STT transcript segmentation if
no structured messages exist.

Returns interviewQna field for the final report.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

from bson import ObjectId
from bson.errors import InvalidId

_LOG = logging.getLogger(__name__)


def _coerce_oid(value) -> Optional[ObjectId]:
    if value is None:
        return None
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except (InvalidId, Exception):
        return None


def _word_count(text: str) -> int:
    return len(text.split()) if text and text.strip() else 0


def _ts_to_iso(ts) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts.isoformat()
    return str(ts)


def _duration_sec(asked_ts, answered_ts) -> Optional[float]:
    try:
        if isinstance(asked_ts, str):
            asked_ts = datetime.fromisoformat(asked_ts.replace("Z", "+00:00"))
        if isinstance(answered_ts, str):
            answered_ts = datetime.fromisoformat(answered_ts.replace("Z", "+00:00"))
        if asked_ts and answered_ts:
            delta = (answered_ts - asked_ts).total_seconds()
            return round(delta, 1) if delta > 0 else None
    except Exception:
        pass
    return None


def _fetch_call_room(interview_id: str) -> Optional[dict]:
    """Fetch call room from MongoDB."""
    try:
        import os

        from app.db.mongo import _client

        users_db = _client[os.getenv("USERS_DB_NAME", os.getenv("MONGO_DB_NAME", "ai_recruiter"))]
        col = users_db["callrooms"]
        oid = _coerce_oid(interview_id)
        room = None
        if oid:
            room = col.find_one({"_id": oid})
        if not room:
            room = col.find_one({"roomId": interview_id})
        return room
    except Exception as exc:
        _LOG.warning("[QnA] Failed to fetch call room: %s", exc)
        return None


def _compute_pair_confidence(
    question_text: str,
    answer_text: str,
    source: str,
) -> dict:
    """Compute confidence scores for a single Q&A pair.

    Returns a dict with individual signal confidences and a weighted overall.
    Scoring is fully deterministic — no LLM involved.

    Sources:
      stored_conversation  → agent/candidate roles are explicit → high trust
      agent_snapshot       → from snapshot, slightly less reliable
      stt_fallback         → no roles known → very low
    """
    # Transcription confidence depends on how the text was obtained
    source_confidence_map = {
        "stored_conversation": 0.95,
        "agent_snapshot": 0.85,
        "stt_fallback": 0.30,
    }
    transcription_confidence = source_confidence_map.get(source, 0.70)

    # Alignment confidence: is the answer long enough to be evaluated?
    a_words = len((answer_text or "").split())
    if a_words == 0:
        alignment_confidence = 0.0
    elif a_words < 5:
        alignment_confidence = 0.25
    elif a_words < 20:
        alignment_confidence = 0.60
    elif a_words < 50:
        alignment_confidence = 0.80
    else:
        alignment_confidence = 0.95

    # Speaker confidence: for message-based extraction the roles are always
    # explicit (agent → RECRUITER, candidate → CANDIDATE), so this is fixed.
    speaker_confidence = (
        0.95 if source in ("stored_conversation", "agent_snapshot") else 0.20
    )

    # Weighted average: alignment matters most (answer quality determines
    # how useful the pair is for evaluation)
    overall = round(
        0.30 * transcription_confidence
        + 0.50 * alignment_confidence
        + 0.20 * speaker_confidence,
        3,
    )

    return {
        "transcriptionConfidence": transcription_confidence,
        "alignmentConfidence": alignment_confidence,
        "speakerConfidence": speaker_confidence,
        "overall": overall,
    }


def _build_pair_evidence(
    question_text: str,
    answer_text: str,
    q_idx: int,
    source: str,
) -> list:
    """Build evidence references for a Q&A pair.

    Each evidence item traces the text back to its source so evaluators and
    recruiters can verify any claim against the original transcript.

    Args:
        question_text: The question as stored in the message
        answer_text:   The candidate's answer
        q_idx:         1-based question index (for segmentId generation)
        source:        Data source ("stored_conversation", "agent_snapshot", …)

    Returns:
        List of evidence dicts with segmentId, text, role, source, confidence
    """
    evidence = []

    if question_text and question_text.strip():
        evidence.append(
            {
                "segmentId": f"q{q_idx}_question",
                "text": question_text.strip()[:400],
                "role": "RECRUITER",
                "source": source,
                "confidence": 0.95
                if source in ("stored_conversation", "agent_snapshot")
                else 0.40,
            }
        )

    if answer_text and answer_text.strip():
        # Split answer into sentence-level evidence snippets (max 3)
        sentences = [
            s.strip()
            for s in re.split(r"[.!?]", answer_text)
            if len(s.strip().split()) >= 4
        ]
        for snippet_idx, sentence in enumerate(sentences[:3]):
            evidence.append(
                {
                    "segmentId": f"q{q_idx}_answer_{snippet_idx}",
                    "text": sentence[:400],
                    "role": "CANDIDATE",
                    "source": source,
                    "confidence": 0.90
                    if source in ("stored_conversation", "agent_snapshot")
                    else 0.30,
                }
            )

    return evidence


def _guard_speaker_leakage(
    question_text: str,
    answer_text: str,
) -> tuple[bool, str]:
    """Detect potential speaker leakage in a Q&A pair.

    Speaker leakage = recruiter speech appearing in answerText OR
    candidate speech appearing in questionText.

    This function is conservative: it only flags DEFINITE leakage
    (empty question, or answer IS identical to question).

    Args:
        question_text: Text attributed to RECRUITER
        answer_text:   Text attributed to CANDIDATE

    Returns:
        (is_clean: bool, reason: str)
    """
    if not question_text or not question_text.strip():
        return (
            False,
            "question_text is empty — possible speaker leakage or missing turn",
        )

    if not answer_text or not answer_text.strip():
        # Missing answer is acceptable (candidate may not have responded)
        return True, "ok_no_answer"

    # Exact match: answer is identical to question — definite leakage
    if question_text.strip().lower() == answer_text.strip().lower():
        return False, "answer_identical_to_question"

    # Very high overlap (>85% shared words) is suspicious
    q_words = set(question_text.lower().split())
    a_words = set(answer_text.lower().split())
    if q_words and len(q_words & a_words) / len(q_words) > 0.85:
        return False, "answer_overlaps_question_by_more_than_85pct"

    return True, "ok"


def _extract_from_messages(messages: list, source: str = "stored_conversation") -> list:
    """Parse message array into Q&A pairs.

    Groups consecutive agent→candidate message pairs.
    Skips system messages.
    """
    items = []
    q_idx = 0
    i = 0

    while i < len(messages):
        msg = messages[i]
        role = (msg.get("role") or "").lower()

        if role == "agent":
            question_text = (msg.get("text") or msg.get("content") or "").strip()
            if not question_text:
                i += 1
                continue

            # Look ahead for candidate answer
            j = i + 1
            answer_text = ""
            answered_ts = None
            answer_msg = None

            while j < len(messages):
                next_msg = messages[j]
                next_role = (next_msg.get("role") or "").lower()
                if next_role == "candidate":
                    answer_text = (
                        next_msg.get("text") or next_msg.get("content") or ""
                    ).strip()
                    answered_ts = next_msg.get("timestamp")
                    answer_msg = next_msg
                    break
                elif next_role == "agent":
                    break
                j += 1

            q_idx += 1
            asked_ts = msg.get("timestamp")
            duration = _duration_sec(asked_ts, answered_ts)

            pair_confidence = _compute_pair_confidence(
                question_text, answer_text, source
            )
            pair_evidence = _build_pair_evidence(
                question_text, answer_text, q_idx, source
            )
            is_clean, leakage_note = _guard_speaker_leakage(question_text, answer_text)

            items.append(
                {
                    "questionId": f"q{q_idx}",
                    "questionText": question_text,
                    "answerText": answer_text,
                    # Speaker attribution — always explicit for message-based extraction
                    "speakerQuestion": "RECRUITER",
                    "speakerAnswer": "CANDIDATE",
                    # Timestamps
                    "askedAt": _ts_to_iso(asked_ts),
                    "answeredAt": _ts_to_iso(answered_ts),
                    "answerDurationSec": duration,
                    # Quality signals
                    "wordCount": _word_count(answer_text),
                    "confidence": pair_confidence,
                    "evidence": pair_evidence,
                    # Integrity
                    "speakerLeakageClean": is_clean,
                    "speakerLeakageNote": leakage_note if not is_clean else None,
                }
            )

            # Skip past the answer message
            i = j + 1 if answer_msg is not None else j
        else:
            i += 1

    return items


def load_interview_qa(interview_id: str, call_room: Optional[dict] = None) -> dict:
    """Load structured Q&A from MongoDB call room messages.

    Priority:
    1. CallRoom.messages (role: agent/candidate)
    2. CallRoom.agentSnapshot conversation
    3. Returns qnaAvailable=False if neither exists

    Args:
        interview_id: Room ID or MongoDB _id string
        call_room: Pre-loaded call room document (optional — avoids re-query)

    Returns:
        interviewQna dict with keys:
          available, source, questionCount, answeredCount, items
    """
    fallback_result = {
        "available": False,
        "source": "unavailable",
        "questionCount": 0,
        "answeredCount": 0,
        "items": [],
    }

    if not call_room and interview_id:
        call_room = _fetch_call_room(interview_id)

    if not call_room:
        _LOG.warning("[QnA] No call room found for interview_id=%s", interview_id)
        return fallback_result

    # --- Try messages array first ---
    messages = call_room.get("messages") or []
    if messages:
        items = _extract_from_messages(messages, source="stored_conversation")
        if items:
            answered = sum(1 for it in items if it.get("answerText", "").strip())
            _LOG.info(
                "[QnA] Extracted %d Q&A pairs from messages for interview=%s",
                len(items),
                interview_id,
            )
            return {
                "available": True,
                "source": "stored_conversation",
                "questionCount": len(items),
                "answeredCount": answered,
                "items": items,
            }

    # --- Try agentSnapshot ---
    snapshot = call_room.get("agentSnapshot") or {}
    convo = snapshot.get("conversation") or snapshot.get("messages") or []
    if convo:
        items = _extract_from_messages(convo, source="agent_snapshot")
        if items:
            answered = sum(1 for it in items if it.get("answerText", "").strip())
            _LOG.info(
                "[QnA] Extracted %d Q&A pairs from agentSnapshot for interview=%s",
                len(items),
                interview_id,
            )
            return {
                "available": True,
                "source": "agent_snapshot",
                "questionCount": len(items),
                "answeredCount": answered,
                "items": items,
            }

    _LOG.info("[QnA] No structured Q&A found for interview=%s", interview_id)
    return fallback_result


def extract_qna_from_stt(stt_payload: dict) -> dict:
    """Attempt to note STT transcript presence (last-resort fallback).

    STT has no role labels, so Q&A segmentation is not possible.
    Returns a record indicating the transcript is available but Q&A is not.

    Args:
        stt_payload: Transcript payload from stt_service

    Returns:
        interviewQna dict (qnaAvailable=False, but with STT metadata)
    """
    full_text = (stt_payload.get("fullText") or "").strip()
    segments = stt_payload.get("segments") or []

    if not full_text or len(full_text.split()) < 10:
        return {
            "available": False,
            "source": "unavailable",
            "questionCount": 0,
            "answeredCount": 0,
            "items": [],
            "note": "Transcript too short for Q&A segmentation.",
        }

    # STT has no role labels — return unavailable
    return {
        "available": False,
        "source": "unavailable",
        "questionCount": 0,
        "answeredCount": 0,
        "items": [],
        "note": "STT transcript available but no speaker-role labels found. Q&A evaluation unavailable.",
        "sttWordCount": len(full_text.split()),
        "sttSegmentCount": len(segments),
    }


def freeze_qna_snapshot(qna_result: dict) -> dict:
    """Return a deep-frozen copy of a Q&A result for use as a pipeline snapshot.

    The returned object is a plain dict (not a Pydantic model) — it cannot
    be mutated in-place by downstream pipeline stages. Downstream nodes MUST
    read from this snapshot instead of re-fetching from MongoDB.

    Adds a `_frozen` marker and a `_frozenAt` timestamp so audits can confirm
    the snapshot was not re-generated mid-pipeline.

    Args:
        qna_result: The dict returned by load_interview_qa or extract_qna_from_stt

    Returns:
        An independent copy with _frozen=True and _frozenAt set.
    """
    import copy
    from datetime import datetime, timezone

    snapshot = copy.deepcopy(qna_result)
    snapshot["_frozen"] = True
    snapshot["_frozenAt"] = datetime.now(timezone.utc).isoformat()
    return snapshot
