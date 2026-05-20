# Report Graph Testing Guide

> **Next Hire — AI Recruiter Platform**  
> LangGraph post-interview report pipeline — validation & testing

## Phase 1 Improvements (New)

This document includes testing instructions for the hardened Phase 1 pipeline.

### New Safety Features

| Feature | Description |
|---------|-------------|
| **Pydantic Schema Validation** | All reports validated before MongoDB persistence |
| **FFmpeg Timeouts & Retries** | Configurable timeouts with automatic cleanup on failure |
| **Deterministic Field Protection** | LLM polish cannot modify scores, counts, or durations |
| **Structured Error Logging** | Node errors include code, step, duration, and recoverability |
| **Non-Destructive Polish** | `polish.nonDestructive=true` confirms scores unchanged |

### Environment Variables

```powershell
# FFmpeg configuration
$env:FFMPEG_TIMEOUT_SEC = "60"        # Audio/frame extraction timeout (seconds)
$env:FFMPEG_MAX_ATTEMPTS = "2"        # Retry attempts for transient failures
$env:FFPROBE_TIMEOUT_SEC = "20"       # Duration extraction timeout (seconds)

# Report polish configuration
$env:REPORT_POLISH_ENABLED = "true"    # Enable LLM polish (default: false)
$env:REPORT_POLISH_PROVIDER = "gemini"  # Provider: gemini, nvidia, anthropic, openai
$env:REPORT_POLISH_MODEL = "gemini-2.5-flash-lite"
$env:REPORT_POLISH_TIMEOUT_SEC = "25"  # LLM API timeout (seconds)
```

---

## Prerequisites

```powershell
# From repo root — activate your virtual environment first
cd ai-recruiter-platform

# Install analysis service dependencies if not already done
pip install -r Backend\analysis_service\requirements.txt
```

Set `PYTHONPATH` before every command:

```powershell
$env:PYTHONPATH = "Backend\analysis_service"
```

---

## Task 1 — Verify upload path is correct

The fixed `config.py` resolves uploads to:

```
Backend/uploads/interviews/<interviewId>/raw/<recording>
```

Quick Python sanity-check (no interview needed):

```powershell
python -c "
from app.core.config import log_resolved_paths
log_resolved_paths()
"
```

Expected output:
```
  BACKEND_DIR  : ...\Backend
  ANALYSIS_DIR : ...\Backend\analysis_service
  UPLOADS_DIR  : ...\Backend\uploads\interviews  (exists=True)
```

---

## Task 2 — Live report graph validation

Checks MongoDB connection, interview document, existing report, recording file,
then runs the full LangGraph pipeline and prints a structured summary.

```powershell
$env:PYTHONPATH = "Backend\analysis_service"
python Backend\analysis_service\scripts\test_live_report_graph.py <interviewId>
```

Expected output (recording present):
```
  MongoDB connection status : ✓ connected
  Interview found           : yes
  Existing report found     : yes/no
  Recording found           : yes
  Graph status              : COMPLETED
  polishStatus              : skipped
  llmUsed                   : False
  Final recommendation      : Candidate can be considered for next step.
  Technical score           : 75

✓  PASS  — graph completed successfully
```

> **Warning:** If no recording is found the graph will print a clear warning
> and stop at the `init` node. The script does NOT crash.

---

## Task 3 — Deterministic mode direct run

Run the graph as a module (minimal output):

```powershell
$env:PYTHONPATH = "Backend\analysis_service"
$env:REPORT_POLISH_ENABLED = "false"
python -m app.services.report_graph <interviewId>
```

Expected output:
```
interview_id=<id>  error=None  polish_status=skipped
```

---

## Task 4 — Deterministic parity check

Compares the existing MongoDB report with a freshly generated deterministic
report. Ignores metadata fields; diffs only business fields.

```powershell
$env:PYTHONPATH = "Backend\analysis_service"
$env:REPORT_POLISH_ENABLED = "false"
python Backend\analysis_service\scripts\check_report_parity.py <interviewId>
```

Expected output:
```
  ✓  PASS  parity check — all business fields are identical
```

If differences exist only in metadata (`generatedAt`, `polishStatus`, etc.) the
check still **PASS**es — those fields are excluded from the diff.

---

## Task 5 — Live NVIDIA polish

> ⚠  Requires a valid NVIDIA NIM API key.  
> Never hardcode the key. Never commit it to git.

```powershell
$env:PYTHONPATH       = "Backend\analysis_service"
$env:REPORT_POLISH_ENABLED = "true"
$env:LLM_PROVIDER     = "nvidia"
$env:NVIDIA_API_KEY   = "nvapi-REPLACE_WITH_YOUR_KEY"
$env:NVIDIA_MODEL     = "meta/llama-3.1-8b-instruct"
python Backend\analysis_service\scripts\test_nvidia_polish_live.py <interviewId>
```

Expected output:
```
  provider          : nvidia
  model             : meta/llama-3.1-8b-instruct
  API key loaded    : yes
  polishStatus      : completed
  llmUsed           : True
  Prose fields polished (2):
    ✓ transcriptSummary
    ✓ technicalEvaluation.strengths
  ...
  ✓  PASS  live NVIDIA polish test
     polishStatus=completed  llmUsed=true
     deterministic scores unchanged
     forbidden fields unchanged
```

### What the script verifies

| Check | Expected |
|---|---|
| `polishStatus` | `completed` |
| `llmUsed` | `True` |
| `technicalEvaluation.score` | Unchanged |
| `visionMonitoring` | Unchanged |
| `integrityAlerts` | Unchanged |
| `finalRecommendation.status` | Unchanged |
| `audioAnalysis` | Unchanged |
| Prose fields (`transcriptSummary`, strengths, etc.) | May change |

---

## Task 6 — Invalid NVIDIA API key failure test

Verifies the graph completes without crashing when the API key is invalid and
returns the unchanged deterministic report.

```powershell
$env:PYTHONPATH       = "Backend\analysis_service"
$env:REPORT_POLISH_ENABLED = "true"
$env:LLM_PROVIDER     = "nvidia"
$env:NVIDIA_API_KEY   = "invalid_key_for_test"
python Backend\analysis_service\scripts\test_nvidia_failure.py <interviewId>
```

Expected output:
```
  polishStatus      : failed
  llmUsed           : False
  score (baseline)  : 75
  score (failure)   : 75

  ✓  PASS  failure handling test
     Graph completed without crash
     polishStatus=failed
     llmUsed=false
     Deterministic report returned unchanged
     Forbidden fields unchanged
```

You can also pass a custom bad key as the second CLI argument:

```powershell
python Backend\analysis_service\scripts\test_nvidia_failure.py <interviewId> "bad-key-xyz"
```

---

## Task 7 — Final verification checklist

Run all checks and fill in the table:

| # | Check | Result |
|---|---|---|
| 1 | Upload path resolves to `Backend/uploads/interviews` | `PASS / FAIL` |
| 2 | Live graph test | `PASS / FAIL` |
| 3 | MongoDB interview found | `yes / no` |
| 4 | Recording file found | `yes / no` |
| 5 | Deterministic parity | `PASS / FAIL` |
| 6 | NVIDIA polish live | `PASS / FAIL` |
| 7 | Invalid NVIDIA key failure | `PASS / FAIL` |

### Invariant guarantees

| Guarantee | How enforced |
|---|---|
| Existing report logic unchanged | `report_service.py` not modified |
| Scores are deterministic | `_repin_deterministic()` re-pins after every merge |
| LLM only edits whitelisted prose | `_whitelist_merge()` explicit allow-list |
| App does not crash when LLM fails | `ThreadPoolExecutor` timeout + `except` in `polish()` |
| Recruiter is final decision-maker | `humanReviewRequired=True` always; `recruiterDecision` is forbidden |
| No identity/emotion inference | Report schema contains no such fields; `ethicsNote` is re-pinned |

---

## Whitelisted LLM-editable prose fields

```
transcriptSummary
finalRecommendation                     (string schema)
finalRecommendation.summary             (object schema)
finalRecommendation.nextStep            (object schema)
technicalEvaluation.strengths
technicalEvaluation.weaknesses
communicationAnalysis.summary           (if field exists in report)
visionIntegrityReport.summary           (if field exists in report)
aiInterviewerNotes.summary              (if field exists in report)
aiInterviewerNotes.strengths            (if field exists in report)
aiInterviewerNotes.weaknesses           (if field exists in report)
aiInterviewerNotes.recommendedFollowUpQuestions  (if field exists)
questionEvaluations[].feedback          (if array exists in report)
```

## Forbidden fields (always re-pinned from deterministic report)

```
finalRecommendation.status / overallScore
technicalEvaluation.score
scoreBreakdown
visionMonitoring  (entire subtree)
visionIntegrityReport.riskLevel + event counts
integrityAlerts
audioAnalysis
humanReviewRequired
ethicsNote
recruiterDecision
identity
candidateInfo
generatedAt / updatedAt / createdAt
```

---

## Architecture notes

```
report_graph.py
  │
  ├── init_node              – locates recording in UPLOADS_DIR
  ├── audio_extract_node     – ffmpeg → audio.wav
  ├── frames_extract_node    – ffmpeg → frames/
  ├── vision_analyze_node    – MediaPipe/YOLO frame analysis
  ├── transcribe_node        – Whisper STT
  ├── silence_detect_node    – silence detection
  ├── merge_live_node        – merges live call-room monitoring
  ├── build_report_node      – deterministic report_service.build_final_report()
  │
  ├── [if REPORT_POLISH_ENABLED=true]
  │     polish_report_node   – report_polish.polish() with whitelist merge
  │
  └── persist_report_node    – saves to MongoDB interview_final_reports
```

Every node except `polish_report_node` is wrapped with the `@node` decorator
which short-circuits the pipeline into `mark_failed` on any exception.
The polish node swallows its own errors and always returns the deterministic
report unchanged if the LLM fails.

---

## Phase 1 Unit Tests

Run the new unit tests to verify schema validation, polish protection, and FFmpeg error handling:

```powershell
# Install pytest if not already installed
pip install pytest

# From repo root
$env:PYTHONPATH = "Backend/analysis_service"
pytest Backend/analysis_service/tests -v
```

### Test Coverage

| Test File | Coverage |
|-----------|----------|
| `test_report_schema.py` | Pydantic schema validation, field constraints, backward compatibility |
| `test_report_polish_merge.py` | Deterministic field protection, whitelist merge, score preservation |
| `test_ffmpeg_service.py` | Timeout handling, retry logic, error structuring, cleanup |

### Expected Test Output

```
Backend/analysis_service/tests/test_report_schema.py::TestReportSchemaValidation::test_minimal_valid_report PASSED
Backend/analysis_service/tests/test_report_schema.py::TestReportSchemaValidation::test_full_valid_report PASSED
Backend/analysis_service/tests/test_report_schema.py::TestReportSchemaValidation::test_score_range_validation PASSED
...
Backend/analysis_service/tests/test_report_polish_merge.py::TestIsAllowedPolishPath::test_allowed_top_level_paths PASSED
Backend/analysis_service/tests/test_report_polish_merge.py::TestWhitelistMerge::test_score_unchanged_by_llm PASSED
Backend/analysis_service/tests/test_report_polish_merge.py::TestWhitelistMerge::test_vision_metrics_protected PASSED
...
Backend/analysis_service/tests/test_ffmpeg_service.py::TestRunSubprocessCommand::test_success_on_first_attempt PASSED
Backend/analysis_service/tests/test_ffmpeg_service.py::TestRunSubprocessCommand::test_retry_on_failure_then_success PASSED
Backend/analysis_service/tests/test_ffmpeg_service.py::TestExtractAudio::test_cleanup_on_failure PASSED
...

================ 50+ tests passed =================
```

---

## Running the Report Graph Locally

### Quick test (no polish)

```powershell
$env:PYTHONPATH = "Backend/analysis_service"
$env:REPORT_POLISH_ENABLED = "false"
python -m Backend.analysis_service.scripts.test_live_report_graph <interviewId>
```

### With schema validation and polish

```powershell
$env:PYTHONPATH = "Backend/analysis_service"
$env:REPORT_POLISH_ENABLED = "true"
$env:REPORT_POLISH_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "your-key-here"
python -m app.services.report_graph <interviewId>
```

### Inside Backend/analysis_service directory

```powershell
cd Backend/analysis_service
$env:PYTHONPATH = "."
python -m app.services.report_graph <interviewId>
```
