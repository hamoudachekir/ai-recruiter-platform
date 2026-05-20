"""AI-powered candidate comparison and ranking agent.

Aggregates structured interview reports for the same job and asks an LLM to
produce a ranked leaderboard with justifications. Reuses the voice_engine
provider-agnostic LLM client so the same `LLM_PROVIDER` env wiring works.
"""

from .comparison_engine import ComparisonEngine

__all__ = ["ComparisonEngine"]
