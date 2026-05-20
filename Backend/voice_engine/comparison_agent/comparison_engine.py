"""Comparison engine — turns a list of interview reports into a ranked leaderboard.

The engine is intentionally thin: it builds a structured prompt, calls the
configured LLM through the shared client, and validates / normalizes the JSON
output. All scoring weights and "be objective" wording live in the prompt so
recruiters can tune behavior without touching code.
"""
from __future__ import annotations

import json
import os
from typing import Any

from ..interview_agent.llm_client import LLMClient, LLMError


SYSTEM_PROMPT = """You are an expert HR analyst.

You will receive a JSON payload describing a job posting and a list of \
candidates who completed structured AI-driven interviews for that role. Each \
candidate has:
  - technical scoring (IRT theta + raw technical score)
  - HR / soft skills score from the intro session
  - integrity score and stress profile
  - resilience index, sentiment trend, answer completeness
  - free-text strengths and weaknesses extracted from the transcript

Your task is to rank every candidate from most to least suitable for the role.
For each candidate produce:
  - rank (1 = best)
  - suitabilityScore (0-100 integer)
  - strongestPoint (one short sentence)
  - mainWeakness (one short sentence)
  - hiringRecommendation (one short sentence: "Strong hire", "Hire", "Maybe", \
"No hire", or similar)
  - justification (exactly 3 sentences comparing the candidate to the job \
requirements: strengths, weaknesses, recommendation)

After the per-candidate rows, produce an executiveSummary (3-5 sentences) \
comparing the top 3 candidates in plain English. Be specific and reference \
the actual metrics you saw — do not invent numbers.

Respond with ONLY a single JSON object using this exact shape:
{
  "rankings": [
    {
      "sessionId": "<the sessionId from the input>",
      "candidateName": "...",
      "rank": 1,
      "suitabilityScore": 87,
      "strongestPoint": "...",
      "mainWeakness": "...",
      "hiringRecommendation": "...",
      "justification": "..."
    }
  ],
  "executiveSummary": "..."
}

Rules:
- Every candidate in the input MUST appear in the rankings exactly once.
- Use the sessionId verbatim from the input so the system can match results.
- Be objective: a candidate with weak technical score but strong soft skills \
should be ranked lower for a senior engineering role and higher for a \
people-facing role. Read the job description carefully.
- Never recommend a hire based solely on integrity signals. Treat integrity \
as a review flag, not a ranking criterion."""


def _compact(value: Any) -> Any:
    """Trim transcript-style payloads so we don't blow the LLM context window."""
    if isinstance(value, str):
        return value if len(value) <= 600 else value[:600] + "…"
    if isinstance(value, list):
        return [_compact(item) for item in value[:8]]
    if isinstance(value, dict):
        return {k: _compact(v) for k, v in value.items()}
    return value


class ComparisonEngine:
    def __init__(self, client: LLMClient) -> None:
        self.client = client
        self.provider = os.getenv("LLM_PROVIDER", "echo").strip().lower()

    def rank(self, job: dict, candidates: list[dict]) -> dict:
        if not candidates:
            raise ValueError("No candidates provided")
        if len(candidates) < 2:
            raise ValueError("At least 2 candidates required for a comparison")

        user_payload = {
            "job": {
                "title": str(job.get("title", "")),
                "description": str(job.get("description", "")),
                "skills": list(job.get("skills") or []),
                "languages": list(job.get("languages") or []),
            },
            "candidates": [_compact(c) for c in candidates],
        }

        messages = [
            {
                "role": "user",
                "content": (
                    "Rank these candidates for the job below. "
                    "Return JSON only, matching the schema in the system prompt.\n\n"
                    + json.dumps(user_payload, ensure_ascii=False)
                ),
            }
        ]

        try:
            raw = self.client.complete_json(
                SYSTEM_PROMPT,
                messages,
                temperature=0.25,
                max_tokens=2400,
            )
        except LLMError:
            # Bubble up — the FastAPI layer turns this into a 502 the recruiter
            # can retry.
            raise

        rankings = raw.get("rankings") or []
        if not isinstance(rankings, list) or not rankings:
            raise LLMError("Model returned no rankings")

        # Defensive normalization. The agent_server validates basic shape; we
        # also re-sort by rank and clamp scores so the UI never gets garbage.
        normalized: list[dict] = []
        seen_sessions: set[str] = set()
        for row in rankings:
            if not isinstance(row, dict):
                continue
            session_id = str(row.get("sessionId") or "").strip()
            if not session_id or session_id in seen_sessions:
                continue
            seen_sessions.add(session_id)

            try:
                rank_value = int(row.get("rank") or 0)
            except (TypeError, ValueError):
                rank_value = 0

            try:
                score = float(row.get("suitabilityScore") or 0)
            except (TypeError, ValueError):
                score = 0.0
            score = max(0.0, min(100.0, score))

            normalized.append(
                {
                    "sessionId": session_id,
                    "candidateName": str(row.get("candidateName") or ""),
                    "rank": rank_value,
                    "suitabilityScore": round(score, 1),
                    "strongestPoint": str(row.get("strongestPoint") or ""),
                    "mainWeakness": str(row.get("mainWeakness") or ""),
                    "hiringRecommendation": str(
                        row.get("hiringRecommendation") or ""
                    ),
                    "justification": str(row.get("justification") or ""),
                }
            )

        # Renumber ranks 1..N in case the model produced gaps or duplicates.
        normalized.sort(key=lambda r: (r["rank"] or 999, -r["suitabilityScore"]))
        for idx, row in enumerate(normalized, start=1):
            row["rank"] = idx

        return {
            "rankings": normalized,
            "executiveSummary": str(raw.get("executiveSummary") or "").strip(),
            "provider": self.provider,
        }
