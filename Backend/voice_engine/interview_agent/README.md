# Interview Agent Service

Adaptive interview agent that runs a two-phase (HR intro + technical) interview
with dynamic difficulty based on a lightweight IRT ability estimate (`theta`).
Provider-agnostic: swap between **Ollama** (local), **Anthropic Claude**,
OpenAI-compatible APIs, or an **echo** stub via a single env var.

## Run

```bash
cd Backend/voice_engine/interview_agent
pip install -r requirements.txt
cp .env.example .env     # then edit LLM_PROVIDER
python -m uvicorn Backend.voice_engine.interview_agent.agent_server:app --port 8013
# or, from inside the package dir:
python agent_server.py
```

### Providers

| `LLM_PROVIDER` | What it uses | Needs |
|---|---|---|
| `echo`      | Offline stub, deterministic output | nothing — use for wiring up the frontend |
| `ollama`    | Local model via Ollama REST | Recommended: `ollama pull qwen2.5:14b-instruct` (fallback: `qwen2.5:7b-instruct`) |
| `anthropic` | Claude via official SDK | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI-compatible chat completions | `OPENAI_API_KEY` |

## Endpoints

- `POST /session/start` — `{ interview_id, job_title, job_skills[], candidate_name, phase, interview_style? }` → first agent question
- `POST /session/turn` — `{ interview_id, text, sentiment? }` → scores last answer, updates HR/technical category scores, returns next question
- `POST /session/switch` — `{ interview_id, phase: "technical" }` → manual phase switch (RH dashboard)
- `POST /session/end` — `{ interview_id }` → snapshot plus final report
- `GET  /session/{interview_id}` — state snapshot
- `GET  /health`

Supported `interview_style` values:

- `friendly`
- `strict`
- `senior`
- `junior`
- `fast_screening`

The final report includes overall, HR, and technical scores, skill breakdowns,
recommendation, strengths, concerns, evaluations, and transcript.

## IRT-lite update rule

```
delta = 0.4 * (score - 0.5) + 0.1 * (confidence - 0.5)
theta = clamp(theta + delta, -3, 3)
difficulty = clamp(round(3 + theta), 1, 5)
```

`score` comes from the LLM's rubric, `confidence` blends LLM self-report with
STT sentiment (POSITIVE boosts, NEGATIVE dampens).

## What this service does NOT do

- Socket.IO: Node relays events between rooms (step 2 of the plan).
- Persistence: state is in-memory by `interview_id`. Restarts wipe sessions.
- Auth: intended to sit behind the Node server, not exposed to the browser.
