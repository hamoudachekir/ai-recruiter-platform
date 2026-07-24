"""Regression checks for current Claude API constraints in AnthropicClient."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from Backend.voice_engine.interview_agent.llm_client import _anthropic_supports_temperature


class AnthropicSamplingParamTests(unittest.TestCase):
    def test_sonnet_4_6_and_haiku_still_accept_temperature(self) -> None:
        self.assertTrue(_anthropic_supports_temperature("claude-sonnet-4-6"))
        self.assertTrue(_anthropic_supports_temperature("claude-haiku-4-5"))
        self.assertTrue(_anthropic_supports_temperature("claude-opus-4-6"))

    def test_opus_4_8_family_rejects_temperature(self) -> None:
        for model in (
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-mythos-5",
        ):
            with self.subTest(model=model):
                self.assertFalse(_anthropic_supports_temperature(model))


if __name__ == "__main__":
    unittest.main()
