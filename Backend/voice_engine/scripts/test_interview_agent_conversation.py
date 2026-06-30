"""Live conversation test for the interview agent API.

Run from the repo root while the agent service is running on port 8013:

    python Backend/voice_engine/scripts/test_interview_agent_conversation.py

The script starts a session, sends realistic candidate answers, prints the
candidate/agent transcript, and checks the two important repeat behaviors:

- "repeated words" inside a real answer is treated as content.
- "can you repeat?" triggers a local rephrase of the current question.
"""
from __future__ import annotations

import argparse
import json
import textwrap
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://localhost:8013"
DEFAULT_MAX_TURN_MS = 15000


class ApiError(RuntimeError):
    """Raised when the interview agent returns an HTTP or malformed response."""


def _json_request(method: str, base_url: str, path: str, payload: dict[str, Any] | None = None, timeout: float = 60.0) -> tuple[dict[str, Any], int]:
    url = f"{base_url.rstrip('/')}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )

    start = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw_error = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"{method} {path} failed with HTTP {exc.code}: {raw_error}") from exc
    except URLError as exc:
        raise ApiError(f"{method} {path} failed: {exc}") from exc

    elapsed_ms = int((time.perf_counter() - start) * 1000)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"{method} {path} returned non-JSON body: {raw[:300]}") from exc

    if not isinstance(parsed, dict):
        raise ApiError(f"{method} {path} returned unexpected JSON: {type(parsed).__name__}")
    return parsed, elapsed_ms


def _get_json(base_url: str, path: str, timeout: float = 20.0) -> tuple[dict[str, Any], int]:
    return _json_request("GET", base_url, path, None, timeout)


def _post_json(base_url: str, path: str, payload: dict[str, Any], timeout: float = 60.0) -> tuple[dict[str, Any], int]:
    return _json_request("POST", base_url, path, payload, timeout)


def _agent_text(response: dict[str, Any]) -> str:
    message = response.get("agent_message") or {}
    if isinstance(message, dict):
        text = str(message.get("text") or "").strip()
        if text:
            return text
    return str(response.get("next_question") or response.get("message") or "").strip()


def _agent_meta(response: dict[str, Any]) -> dict[str, Any]:
    message = response.get("agent_message") or {}
    return message if isinstance(message, dict) else {}


def _scoring(response: dict[str, Any]) -> dict[str, Any]:
    scoring = response.get("scoring") or {}
    return scoring if isinstance(scoring, dict) else {}


def _question_key(text: str) -> str:
    return " ".join(
        token
        for token in "".join(ch.lower() if ch.isalnum() else " " for ch in text).split()
        if token not in {"can", "you", "tell", "me", "about", "the", "a", "an", "and", "or"}
    )


def _wrap(prefix: str, text: str) -> str:
    return textwrap.fill(
        text,
        width=94,
        initial_indent=prefix,
        subsequent_indent=" " * len(prefix),
    )


def _print_turn(role: str, text: str, elapsed_ms: int | None = None) -> None:
    timing = f" ({elapsed_ms} ms)" if elapsed_ms is not None else ""
    print(f"{role}{timing}")
    print(_wrap("  ", text))
    print()


def _candidate_turns() -> list[dict[str, Any]]:
    return [
        {
            "label": "Background intro",
            "phase": "intro",
            "text": (
                "Hi, I am Alex, a full-stack developer with three years of experience. "
                "I have mostly worked with React, Node.js, Python, and PostgreSQL, and my "
                "recent work was an AI recruiter platform with live interview automation."
            ),
        },
        {
            "label": "Motivation",
            "phase": "intro",
            "text": (
                "I applied because the role is focused on owning features end to end. "
                "In my last project I handled backend APIs, frontend integration, and the "
                "AI report pipeline, so this position matches how I like to work."
            ),
        },
        {
            "label": "Repeated-words bug trigger",
            "phase": "intro",
            "assert_not_rephrase": True,
            "text": (
                "A challenge I handled was in the speech-to-text pipeline. The engine sometimes "
                "captured wrong or repeated words, which made the interview agent misunderstand "
                "answers. I added normalization and deduplication before sending transcripts to the LLM."
            ),
        },
        {
            "label": "Explicit repeat request",
            "phase": "intro",
            "assert_rephrase": True,
            "allow_repeat": True,
            "text": "Sorry, can you repeat the question?",
        },
        {
            "label": "Teamwork answer",
            "phase": "intro",
            "text": (
                "I worked in a small team of four. I usually owned backend and AI tasks, "
                "but I shared early API contracts with the frontend developer and used short "
                "sync calls whenever integration got blocked."
            ),
        },
        {
            "label": "React performance",
            "phase": "technical",
            "text": (
                "In React, I avoid unnecessary re-renders by keeping state close to where it is used, "
                "splitting large components, and memoizing expensive computations with useMemo. "
                "I only use React.memo or useCallback when profiling shows the component actually needs it."
            ),
        },
        {
            "label": "PostgreSQL optimization",
            "phase": "technical",
            "text": (
                "For slow PostgreSQL queries I start with EXPLAIN ANALYZE. In one case, a missing "
                "composite index on a join and filter path caused an 800 ms query. Adding the index "
                "brought it down to around 12 ms."
            ),
        },
        {
            "label": "JWT security",
            "phase": "technical",
            "text": (
                "For JWT authentication in Node.js, I use short-lived access tokens and store refresh "
                "tokens in httpOnly cookies. Protected routes validate signature and expiry, and logout "
                "revokes refresh tokens server-side."
            ),
        },
    ]


def run_conversation(base_url: str, max_turn_ms: int, request_timeout: float, write_json: bool) -> int:
    failures: list[str] = []
    warnings: list[str] = []
    asked_questions: list[str] = []
    transcript: list[dict[str, Any]] = []

    health, health_ms = _get_json(base_url, "/health", timeout=10.0)
    provider = health.get("provider", "unknown")
    if not health.get("ready"):
        raise ApiError(f"Agent is not ready: {health}")

    session_id = f"test-convo-{uuid.uuid4().hex[:10]}"
    print("=" * 72)
    print("INTERVIEW AGENT LIVE CONVERSATION TEST")
    print(f"Session:  {session_id}")
    print(f"Base URL: {base_url}")
    print(f"Provider: {provider}")
    print(f"Health:   ok ({health_ms} ms)")
    print("=" * 72)
    print()

    start_payload = {
        "interview_id": session_id,
        "job_title": "Full Stack Developer",
        "job_skills": ["React", "Node.js", "Python", "PostgreSQL", "REST APIs", "Docker"],
        "job_description": "Build and maintain scalable web applications and AI-powered recruiting workflows.",
        "candidate_name": "Alex",
        "candidate_profile": {
            "short_description": "Full-stack developer with React, Node.js, Python, and AI integration experience.",
            "skills": ["React", "Node.js", "Python", "FastAPI", "PostgreSQL"],
            "domain": "AI / Web",
        },
        "interview_style": "friendly",
        "phase": "intro",
        "preferred_language": "en",
    }

    response, elapsed_ms = _post_json(base_url, "/session/start", start_payload, timeout=request_timeout)
    question = _agent_text(response)
    if not question:
        failures.append("Opening question was empty.")
    else:
        asked_questions.append(question)
    transcript.append({"role": "agent", "text": question, "elapsed_ms": elapsed_ms, "response": response})
    _print_turn("[AI Nour]", question or "<empty>", elapsed_ms)

    switched_to_technical = False

    for index, turn in enumerate(_candidate_turns(), start=1):
        if turn["phase"] == "technical" and not switched_to_technical:
            switch_response, switch_ms = _post_json(
                base_url,
                "/session/switch",
                {"interview_id": session_id, "phase": "technical"},
                timeout=request_timeout,
            )
            switched_to_technical = True
            switch_question = _agent_text(switch_response)
            if not switch_question:
                failures.append("Technical phase switch returned an empty question.")
            else:
                asked_questions.append(switch_question)
            transcript.append(
                {
                    "role": "agent",
                    "text": switch_question,
                    "elapsed_ms": switch_ms,
                    "response": switch_response,
                    "event": "switch_to_technical",
                }
            )
            print("-" * 72)
            print("SWITCH TO TECHNICAL")
            _print_turn("[AI Nour]", switch_question or "<empty>", switch_ms)

        print("-" * 72)
        print(f"TURN {index}: {turn['label']}")
        _print_turn("[Candidate]", turn["text"])
        transcript.append({"role": "candidate", "text": turn["text"], "label": turn["label"]})

        response, elapsed_ms = _post_json(
            base_url,
            "/session/turn",
            {
                "interview_id": session_id,
                "text": turn["text"],
                "sentiment": {"label": "POSITIVE", "score": 0.72},
                "preferred_language": "en",
            },
            timeout=request_timeout,
        )
        question = _agent_text(response)
        meta = _agent_meta(response)
        scoring = _scoring(response)
        transcript.append({"role": "agent", "text": question, "elapsed_ms": elapsed_ms, "response": response})
        _print_turn("[AI Nour]", question or "<empty>", elapsed_ms)

        if not question:
            failures.append(f"Turn {index} returned an empty agent question.")

        if elapsed_ms > max_turn_ms:
            failures.append(f"Turn {index} was slow: {elapsed_ms} ms > {max_turn_ms} ms.")

        normalized = _question_key(question)
        previous_normalized = {_question_key(item) for item in asked_questions}
        if question and not turn.get("allow_repeat") and normalized in previous_normalized:
            failures.append(f"Turn {index} repeated a previous question exactly: {question}")
        if question:
            asked_questions.append(question)

        lowered = question.lower()
        if turn.get("assert_not_rephrase") and ("let me rephrase" in lowered or "let me restate" in lowered):
            failures.append('The "repeated words" answer was incorrectly treated as a repeat request.')
        if turn.get("assert_rephrase") and not ("rephrase" in lowered or "restate" in lowered or "again" in lowered):
            failures.append("The explicit repeat request did not produce a rephrase/restatement.")

        if scoring.get("reasoning", "").startswith("LLM fallback"):
            warnings.append(f"Turn {index} used LLM fallback: {scoring.get('reasoning')}")

        score = scoring.get("score", "?")
        confidence = scoring.get("confidence", "?")
        difficulty = meta.get("difficulty", "?")
        skill = meta.get("skill_focus", "?")
        print(f"Score={score}  Confidence={confidence}  Difficulty={difficulty}  Skill={skill}")
        print()

    end_response, end_ms = _post_json(base_url, "/session/end", {"interview_id": session_id}, timeout=request_timeout)
    report = end_response.get("report") or {}
    category_scores = report.get("category_scores") or {}
    overall = (category_scores.get("overall") or {}).get("score", 0)
    recommendation = (report.get("recommendation") or {}).get("label", "unknown")

    print("=" * 72)
    print("SESSION SUMMARY")
    print(f"End call:           {end_ms} ms")
    print(f"Transcript entries: {report.get('transcript_len', len(report.get('transcript', [])))}")
    print(f"Evaluated answers:  {report.get('evaluated_answers', '?')}")
    print(f"Overall score:      {overall}")
    print(f"Recommendation:     {recommendation}")
    print("=" * 72)
    print()

    if warnings:
        print("Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
        print()

    if failures:
        print("FAILED:")
        for failure in failures:
            print(f"  - {failure}")
    else:
        print("PASSED: conversation flow, response shape, repeat guard, and timing checks are OK.")

    if write_json:
        output_dir = Path("Backend/voice_engine/_runtime_logs")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{session_id}.json"
        output_path.write_text(
            json.dumps(
                {
                    "session_id": session_id,
                    "health": health,
                    "transcript": transcript,
                    "end_response": end_response,
                    "warnings": warnings,
                    "failures": failures,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Saved JSON transcript: {output_path}")

    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a live candidate/agent conversation test.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Interview agent base URL. Default: {DEFAULT_BASE_URL}")
    parser.add_argument("--max-turn-ms", type=int, default=DEFAULT_MAX_TURN_MS, help="Fail if a turn takes longer than this.")
    parser.add_argument("--timeout", type=float, default=60.0, help="Per-request timeout in seconds.")
    parser.add_argument("--no-json", action="store_true", help="Do not save the JSON transcript under _runtime_logs.")
    args = parser.parse_args()

    try:
        return run_conversation(
            base_url=args.base_url,
            max_turn_ms=args.max_turn_ms,
            request_timeout=args.timeout,
            write_json=not args.no_json,
        )
    except ApiError as exc:
        print(f"FAILED: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
