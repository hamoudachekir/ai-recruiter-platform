"""Ad-hoc latency harness for the PFE report (real measurements).

Measures the two dominant, externally-served stages of the interview turn:
  1. Groq LLM turn (evaluation + next-question in a single JSON call)
  2. Edge TTS synthesis (text -> first audio bytes)

Run from repo root:  python scratch/measure_latency.py
"""
from __future__ import annotations

import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_env() -> None:
    for name in (".env", "Backend/voice_engine/.env", "Backend/server/.env"):
        p = ROOT / name
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def measure_groq(n: int = 8) -> list[float]:
    from Backend.voice_engine.interview_agent.llm_client import GroqClient

    key = os.environ.get("GROQ_API_KEY", "")
    model = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
    if not key:
        print("  [skip] no GROQ_API_KEY")
        return []
    client = GroqClient(api_key=key, model=model)
    system = (
        "You are an interview agent. Score the candidate answer and ask the next "
        "question. Return JSON with keys score, confidence, next_question, "
        "difficulty, skill_focus, done."
    )
    messages = [
        {"role": "assistant", "content": "What motivated you to apply for this backend role?"},
        {"role": "user", "content": "I have three years building Node.js and Python microservices and I enjoy real-time systems."},
    ]
    times: list[float] = []
    for i in range(n):
        t0 = time.perf_counter()
        try:
            client.complete_json(system, messages, temperature=0.18, max_tokens=200)
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] call {i} failed: {exc}")
            continue
        times.append((time.perf_counter() - t0) * 1000.0)
        print(f"  groq turn {i+1}: {times[-1]:.0f} ms")
    return times


def measure_edge_tts(n: int = 8) -> list[float]:
    import asyncio
    import edge_tts

    voice = os.environ.get("EDGE_TTS_VOICE", "en-US-EmmaNeural")
    text = "Thank you for that answer. Can you describe a situation where you had to debug a difficult concurrency issue?"

    async def one() -> float:
        t0 = time.perf_counter()
        comm = edge_tts.Communicate(text, voice)
        first = None
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                first = (time.perf_counter() - t0) * 1000.0
                break
        return first if first is not None else (time.perf_counter() - t0) * 1000.0

    times: list[float] = []
    for i in range(n):
        try:
            ms = asyncio.run(one())
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] tts {i} failed: {exc}")
            continue
        times.append(ms)
        print(f"  edge-tts {i+1}: {ms:.0f} ms")
    return times


def summarize(label: str, times: list[float]) -> None:
    if not times:
        print(f"{label}: no data")
        return
    print(
        f"{label}: median={statistics.median(times):.0f} ms  "
        f"mean={statistics.mean(times):.0f} ms  "
        f"min={min(times):.0f}  max={max(times):.0f}  n={len(times)}"
    )


if __name__ == "__main__":
    load_env()
    print("== Groq LLM turn (gpt-oss-120b) ==")
    g = measure_groq()
    print("== Edge TTS first audio ==")
    t = measure_edge_tts()
    print("\n=== SUMMARY ===")
    summarize("Groq LLM turn", g)
    summarize("Edge TTS first byte", t)
