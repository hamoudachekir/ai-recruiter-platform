from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from Backend.voice_engine.interview_agent.interview_engine import InterviewEngine
from Backend.voice_engine.interview_agent.llm_client import GroqClient, LLMClient, LLMError, build_client_from_env


class ScriptedInterviewLLM(LLMClient):
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.questions = [
            "What motivated you to apply for this role?",
            "Can you share one team situation where communication mattered?",
            "How did you validate the transcript cleanup worked?",
            "What would you improve in that project if you had more time?",
        ]

    def complete_json(
        self,
        system: str,
        messages: list[dict[str, str]],
        temperature: float = 0.6,
        max_tokens: int = 800,
    ) -> dict[str, Any]:
        prompt = messages[-1]["content"]
        self.calls.append(prompt)
        index = min(len(self.calls) - 1, len(self.questions) - 1)
        return {
            "score": 0.72,
            "confidence": 0.76,
            "reasoning": "Scripted test response with usable evidence.",
            "next_question": self.questions[index],
            "difficulty": 2,
            "skill_focus": "communication",
            "done": False,
        }


class FailingInterviewLLM(LLMClient):
    def complete_json(
        self,
        system: str,
        messages: list[dict[str, str]],
        temperature: float = 0.6,
        max_tokens: int = 800,
    ) -> dict[str, Any]:
        raise LLMError("simulated provider timeout")


def _agent_text(response: dict[str, Any]) -> str:
    return str(response.get("agent_message", {}).get("text") or "")


class InterviewAgentConversationTests(unittest.TestCase):
    def _engine(self) -> tuple[InterviewEngine, ScriptedInterviewLLM]:
        llm = ScriptedInterviewLLM()
        engine = InterviewEngine(llm)
        return engine, llm

    def _start(self, engine: InterviewEngine, interview_id: str = "unit-convo") -> dict[str, Any]:
        return engine.start(
            interview_id,
            job_title="AI Software Engineer",
            job_skills=["Python", "React", "Node.js"],
            job_description="Build AI recruiting tools.",
            candidate_name="Alex",
            candidate_profile={"skills": ["Python", "React", "Node.js"]},
            interview_style="friendly",
            phase="intro",
            preferred_language="en",
        )

    def test_response_shape_contains_agent_message_and_scoring(self) -> None:
        engine, _llm = self._engine()

        response = self._start(engine)

        self.assertIn("agent_message", response)
        self.assertIn("scoring", response)
        self.assertTrue(_agent_text(response).startswith("Hello, I'm Nour"))
        self.assertEqual(response["agent_message"]["skill_focus"], "background")

    def test_repeated_words_inside_real_answer_is_not_repeat_request(self) -> None:
        engine, llm = self._engine()
        self._start(engine)

        first = engine.candidate_turn(
            "unit-convo",
            text=(
                "I started as a backend developer and worked mostly on API design, "
                "data processing, and production monitoring."
            ),
            sentiment={"label": "POSITIVE", "score": 0.7},
        )
        second = engine.candidate_turn(
            "unit-convo",
            text=(
                "A recent issue was that speech-to-text captured repeated words in "
                "candidate answers, so I added transcript normalization before the LLM step."
            ),
            sentiment={"label": "POSITIVE", "score": 0.7},
        )

        self.assertGreaterEqual(len(llm.calls), 2)
        self.assertNotIn("Let me rephrase", _agent_text(second))
        self.assertNotEqual(_agent_text(first), _agent_text(second))
        self.assertEqual(second["scoring"]["reasoning"], "Scripted test response with usable evidence.")

    def test_short_repeat_request_rephrases_without_calling_llm(self) -> None:
        engine, llm = self._engine()
        self._start(engine)

        response = engine.candidate_turn(
            "unit-convo",
            text="Can you repeat?",
            sentiment={"label": "NEUTRAL", "score": 0.5},
        )

        text = _agent_text(response)
        self.assertRegex(text, re.compile(r"rephrase|restate", re.IGNORECASE))
        self.assertEqual(llm.calls, [])
        self.assertEqual(response["scoring"]["reasoning"], "Candidate requested a repeat, so the question was rephrased.")

    def test_provider_failure_uses_safe_fallback_question(self) -> None:
        engine = InterviewEngine(FailingInterviewLLM())
        self._start(engine)

        response = engine.candidate_turn(
            "unit-convo",
            text="I handled a production issue by tracing logs, fixing the API bug, and adding regression tests.",
            sentiment={"label": "POSITIVE", "score": 0.7},
        )

        self.assertTrue(_agent_text(response))
        self.assertIn("LLM fallback due to provider error", response["scoring"]["reasoning"])

    def test_groq_provider_is_available_from_env(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "LLM_PROVIDER": "groq",
                "GROQ_API_KEY": "test-key",
                "GROQ_MODEL": "openai/gpt-oss-120b",
                "AGENT_LLM_TIMEOUT_MS": "6000",
            },
            clear=False,
        ):
            client = build_client_from_env()

        self.assertIsInstance(client, GroqClient)
        self.assertEqual(client.model, "openai/gpt-oss-120b")
        self.assertEqual(client.request_timeout_sec, 6.0)
        self.assertTrue(client.use_compact_interview_prompt)


if __name__ == "__main__":
    unittest.main()
