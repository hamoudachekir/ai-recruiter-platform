"""agent_state_utils.py

Stateless helpers that the interview agent uses each turn:

  - stress_label_from_level    : numeric stress in [0,1] → "none|mild|moderate|high"
  - stress_instruction_for     : per-label instruction to inject into the prompt
  - depth_instruction_for_theta: theta band → question-depth guidance
  - update_domain_coverage     : regex-based skill/domain extractor, no LLM call
  - is_repeat_request          : detects "can you repeat / rephrase" intents
  - classify_question_type     : tags an agent question by probing strategy
  - format_domain_coverage     : pretty-print the coverage map for prompt injection

All functions are pure — no I/O, no global state — so the caller (interview_service)
owns persistence. Designed to be backward-compatible: missing session fields
default cleanly to empty maps / lists.
"""
from __future__ import annotations

import re
from typing import Iterable


# ── 1. Stress-level routing ──────────────────────────────────────────────────

def stress_label_from_level(stress: float) -> str:
    """Map numeric stress in [0,1] to the user-facing label.

    Thresholds chosen so that compute_stress_level's typical range produces a
    spread across all four buckets:
      < 0.25  none
      < 0.45  mild
      < 0.70  moderate
      else    high
    """
    try:
        s = float(stress)
    except (TypeError, ValueError):
        return "none"
    if s < 0.25:
        return "none"
    if s < 0.45:
        return "mild"
    if s < 0.70:
        return "moderate"
    return "high"


_STRESS_INSTRUCTIONS = {
    "none": "",
    "mild": (
        "The candidate seems slightly tense. Be warm and encouraging before "
        "your next question. Open with a brief acknowledgement like "
        "'You're doing well' before continuing."
    ),
    "moderate": (
        "The candidate is showing stress. Acknowledge their effort genuinely, "
        "then ask an easier or different-domain question. Do NOT repeat the "
        "same topic. Use a softer tone."
    ),
    "high": (
        "The candidate is highly stressed. Offer a brief pause option "
        "(\"Take your time, there's no rush\"), pivot to a simpler topic, and "
        "use a calm, supportive tone. Avoid hard technical depth this turn."
    ),
}


def stress_instruction_for(label: str) -> str:
    return _STRESS_INSTRUCTIONS.get(label, "")


# ── 2. Theta → question-depth guidance ───────────────────────────────────────

def depth_instruction_for_theta(theta: float) -> str:
    """Return a one-line directive that pins next_question to a depth band.

    Bands (mirror the spec):
      theta <  -1.0          foundational / definition-level
      -1.0 <= theta < 0.5    implementation-level
      0.5  <= theta < 1.5    architectural / trade-off
      theta >= 1.5           advanced / design / scale
    """
    try:
        t = float(theta)
    except (TypeError, ValueError):
        t = 0.0
    if t < -1.0:
        return (
            "QUESTION DEPTH: foundational. Ask definition-level or "
            "single-concept questions (e.g. 'What is X?', 'What does X do?'). "
            "No multi-part questions. No system design."
        )
    if t < 0.5:
        return (
            "QUESTION DEPTH: implementation-level. Ask how the candidate built "
            "or used something concrete (e.g. 'How did you implement X?', "
            "'Walk me through what your code does when X happens'). Stay "
            "hands-on, not architectural."
        )
    if t < 1.5:
        return (
            "QUESTION DEPTH: architectural / trade-off. Ask why one approach "
            "over another and what the limits are (e.g. 'Why X over Y?', "
            "'What are the trade-offs of that choice?', 'When does this "
            "approach break down?')."
        )
    return (
        "QUESTION DEPTH: advanced / scale / failure modes. Push on scale, "
        "concurrency, and edge cases (e.g. 'How would you scale this to "
        "10x?', 'What breaks under load?', 'How would you design X from "
        "scratch?'). Treat the candidate as a peer."
    )


# ── 3. Domain coverage extractor ─────────────────────────────────────────────

# Each entry maps a domain bucket to a list of (canonical_name, regex) pairs.
# Regex is matched case-insensitively against the candidate answer.
_DOMAIN_LEXICON: dict[str, list[tuple[str, re.Pattern]]] = {
    "frontend": [
        ("React",       re.compile(r"\breact(?:\.?js)?\b", re.I)),
        ("Vue",         re.compile(r"\bvue(?:\.?js)?\b", re.I)),
        ("Angular",     re.compile(r"\bangular(?:\.?js)?\b", re.I)),
        ("Next.js",     re.compile(r"\bnext\.?js\b", re.I)),
        ("Svelte",      re.compile(r"\bsvelte\b", re.I)),
        ("Redux",       re.compile(r"\bredux\b", re.I)),
        ("Tailwind",    re.compile(r"\btailwind\b", re.I)),
        ("HTML",        re.compile(r"\bhtml5?\b", re.I)),
        ("CSS",         re.compile(r"\bcss3?\b|\bsass\b|\bscss\b", re.I)),
        ("TypeScript",  re.compile(r"\btypescript\b", re.I)),
    ],
    "backend": [
        ("Node.js",     re.compile(r"\bnode(?:\.?js)?\b", re.I)),
        ("Express",     re.compile(r"\bexpress(?:\.?js)?\b", re.I)),
        ("NestJS",      re.compile(r"\bnest(?:\.?js)?\b", re.I)),
        ("Django",      re.compile(r"\bdjango\b", re.I)),
        ("Flask",       re.compile(r"\bflask\b", re.I)),
        ("FastAPI",     re.compile(r"\bfast\s?api\b", re.I)),
        ("Spring",      re.compile(r"\bspring(?: boot)?\b", re.I)),
        ("Rails",       re.compile(r"\brails\b", re.I)),
        ("Laravel",     re.compile(r"\blaravel\b", re.I)),
        (".NET",        re.compile(r"\.net\b|\bdotnet\b", re.I)),
        ("Go",          re.compile(r"\bgolang\b", re.I)),
        ("Java",        re.compile(r"\bjava\b(?!script)", re.I)),
        ("Python",      re.compile(r"\bpython\b", re.I)),
        ("PHP",         re.compile(r"\bphp\b", re.I)),
    ],
    "database": [
        ("MongoDB",     re.compile(r"\bmongo\s?db\b|\bmongo\b", re.I)),
        ("PostgreSQL",  re.compile(r"\bpostgres(?:ql)?\b", re.I)),
        ("MySQL",       re.compile(r"\bmysql\b", re.I)),
        ("Redis",       re.compile(r"\bredis\b", re.I)),
        ("Elasticsearch", re.compile(r"\belastic\s?search\b", re.I)),
        ("SQLite",      re.compile(r"\bsqlite\b", re.I)),
        ("SQL",         re.compile(r"\bsql\b", re.I)),
    ],
    "ai_ml": [
        ("multi-agent", re.compile(r"\bmulti[- ]?agent\b", re.I)),
        ("LLM",         re.compile(r"\bllm\b|large language model", re.I)),
        ("RAG",         re.compile(r"\brag\b|retrieval[- ]augmented", re.I)),
        ("ML",          re.compile(r"\bmachine learning\b|\bml\b", re.I)),
        ("NLP",         re.compile(r"\bnlp\b|natural language", re.I)),
        ("TensorFlow",  re.compile(r"\btensor\s?flow\b", re.I)),
        ("PyTorch",     re.compile(r"\bpy\s?torch\b", re.I)),
        ("Embeddings",  re.compile(r"\bembeddings?\b", re.I)),
    ],
    "devops": [
        ("Docker",      re.compile(r"\bdocker\b", re.I)),
        ("Kubernetes",  re.compile(r"\bkubernetes\b|\bk8s\b", re.I)),
        ("AWS",         re.compile(r"\baws\b|amazon web services", re.I)),
        ("Azure",       re.compile(r"\bazure\b", re.I)),
        ("GCP",         re.compile(r"\bgcp\b|google cloud", re.I)),
        ("CI/CD",       re.compile(r"\bci\s*\/?\s*cd\b", re.I)),
        ("Terraform",   re.compile(r"\bterraform\b", re.I)),
        ("Nginx",       re.compile(r"\bnginx\b", re.I)),
        ("Linux",       re.compile(r"\blinux\b|\bubuntu\b", re.I)),
    ],
    "architecture": [
        ("microservices", re.compile(r"\bmicro\s?services?\b", re.I)),
        ("REST",        re.compile(r"\brest(?:ful)?\b", re.I)),
        ("GraphQL",     re.compile(r"\bgraphql\b", re.I)),
        ("WebSockets",  re.compile(r"\bweb\s?sockets?\b", re.I)),
        ("event-driven", re.compile(r"\bevent[- ]driven\b", re.I)),
    ],
}


# Signals that the candidate showed depth (versus just name-dropping).
_DEPTH_SIGNALS = re.compile(
    r"\b(?:because|so that|in order to|the reason|trade[- ]?off|"
    r"latency|throughput|scalab\w+|race condition|deadlock|index(?:ed|ing)?|"
    r"transaction|atomic|idempotent|partition|sharding|replica|consistency|"
    r"benchmark|profil(?:e|ing)|memory leak|race|mutex|lock)\b",
    re.I,
)


def _empty_coverage() -> dict:
    return {bucket: {"mentioned": [], "depth_score": 0} for bucket in _DOMAIN_LEXICON}


def update_domain_coverage(
    coverage: dict | None,
    candidate_answer: str,
) -> dict:
    """Update a domain_coverage dict from one candidate answer.

    Pure: takes the current map (or None) and returns a NEW map with any new
    skill names appended to `mentioned` and `depth_score` incremented if the
    answer contains explanation/trade-off vocabulary.

    The shape matches the spec exactly:
      {
        "frontend": {"mentioned": ["React"], "depth_score": 1},
        ...
      }
    """
    text = candidate_answer or ""
    out = _empty_coverage()
    # Carry over existing mentions (defensive against schema drift).
    if isinstance(coverage, dict):
        for bucket, default in out.items():
            prev = coverage.get(bucket) or {}
            mentioned = prev.get("mentioned") if isinstance(prev, dict) else None
            depth = prev.get("depth_score") if isinstance(prev, dict) else None
            out[bucket]["mentioned"] = list(mentioned) if isinstance(mentioned, list) else []
            try:
                out[bucket]["depth_score"] = int(depth) if depth is not None else 0
            except (TypeError, ValueError):
                out[bucket]["depth_score"] = 0

    if not text.strip():
        return out

    has_depth_signal = bool(_DEPTH_SIGNALS.search(text))

    for bucket, entries in _DOMAIN_LEXICON.items():
        bucket_hit = False
        for canonical, rx in entries:
            if rx.search(text) and canonical not in out[bucket]["mentioned"]:
                out[bucket]["mentioned"].append(canonical)
                bucket_hit = True
        # Depth score grows when an answer both mentions the bucket AND shows
        # explanation-level vocabulary. Capped at 5 so the prompt stays small.
        if bucket_hit and has_depth_signal:
            out[bucket]["depth_score"] = min(5, out[bucket]["depth_score"] + 1)
    return out


def format_domain_coverage(coverage: dict | None) -> str:
    """Pretty-print the coverage map for the system prompt. Empty buckets are
    omitted so the prompt only shows what has actually been discussed."""
    if not isinstance(coverage, dict) or not coverage:
        return ""
    lines = []
    for bucket, data in coverage.items():
        mentioned = (data or {}).get("mentioned") or []
        if not mentioned:
            continue
        depth = (data or {}).get("depth_score") or 0
        lines.append(f"  - {bucket}: {', '.join(mentioned)} (depth={depth})")
    return "\n".join(lines)


# ── 4. Repeat / clarification request detection ──────────────────────────────

_REPEAT_PATTERNS = [
    re.compile(r"\b(?:can|could|would) you (?:please )?(?:repeat|say(?: that)? again|rephrase|reword)\b", re.I),
    re.compile(r"\brepeat (?:the )?question\b", re.I),
    re.compile(r"\bplease (?:repeat|rephrase|say (?:it|that) again)\b", re.I),
    re.compile(r"\bsay (?:it|that) again\b", re.I),
    re.compile(r"\bi (?:did(?:n['’]t)?|do(?:n['’]t)?) (?:understand|catch|get)\b", re.I),
    re.compile(r"\bwhat do you mean\b", re.I),
    re.compile(r"\bwhat was the question\b", re.I),
    re.compile(r"\bcan you (?:please )?clarify\b", re.I),
    # French equivalents — common because the agent supports FR.
    re.compile(r"\b(?:pouvez|peux)[- ]vous? (?:r[ée]p[ée]ter|reformuler)\b", re.I),
    re.compile(r"\brepetez la question\b", re.I),
    re.compile(r"\bje n[' ]?ai pas compris\b", re.I),
]


def is_repeat_request(candidate_message: str) -> bool:
    """True when the candidate is asking for the previous question to be
    repeated or rephrased. Used to gate the agent away from copy-pasting."""
    text = (candidate_message or "").strip()
    if not text:
        return False
    # Very short messages that contain the trigger words count.
    if len(text) > 240:
        # A long answer that happens to contain the word "repeat" is unlikely
        # to be a true repeat request.
        return False
    for rx in _REPEAT_PATTERNS:
        if rx.search(text):
            return True
    return False


REPEAT_INSTRUCTION = (
    "The candidate did NOT understand your previous question and asked you "
    "to repeat or rephrase it. Rewrite the SAME question in one clear, simple "
    "sentence. Do not add 'You mentioned X' preamble. Do not add new "
    "sub-questions. Use plain language and keep it under 20 words."
)


# ── 5. Question-type rotation ────────────────────────────────────────────────

QUESTION_TYPES: tuple[str, ...] = (
    "behavioral",
    "technical_deep_dive",
    "problem_solving",
    "reflection",
    "clarification",
)


_QTYPE_PATTERNS = {
    "behavioral":          re.compile(r"\btell me about a time\b|\bwalk me through\b|\bhave you ever\b|\bdescribe a (?:situation|time|project)\b", re.I),
    "reflection":          re.compile(r"\bwhat would you do differently\b|\blook(?:ing)? back\b|\bif you had to redo\b|\bwhat did you learn\b", re.I),
    "problem_solving":     re.compile(r"\bhow would you (?:approach|handle|tackle|design)\b|\bhow do you (?:approach|handle|tackle)\b|\bsuppose\b|\bimagine\b", re.I),
    "clarification":       re.compile(r"\bcould you (?:clarify|expand|elaborate)\b|\bwhat exactly\b|\bwhen you say\b|\bcan you be more specific\b", re.I),
    "technical_deep_dive": re.compile(r"\bwhat (?:specifically )?happens when\b|\bunder the hood\b|\bhow does (?:that|it) work\b|\bwhat is the (?:time complexity|big[- ]?o)\b|\bwhy did you choose\b", re.I),
}


def classify_question_type(question_text: str) -> str:
    """Best-effort tag for an agent question. Returns one of QUESTION_TYPES or
    'open' when nothing matches. Used to enforce no-repeat rotation."""
    t = (question_text or "").strip()
    if not t:
        return "open"
    # Order matters slightly — clarification/reflection markers are
    # quite specific, so check them before the looser behavioral pattern.
    for name in ("clarification", "reflection", "problem_solving", "technical_deep_dive", "behavioral"):
        if _QTYPE_PATTERNS[name].search(t):
            return name
    return "open"


def variety_instruction(recent_types: Iterable[str]) -> str:
    """Build a directive that tells the agent which question shapes to use
    next, given what it already used in the last few turns."""
    recent = [t for t in (recent_types or []) if t]
    last = recent[-1] if recent else None
    last_two = recent[-2:] if recent else []

    rotation_pool = [
        ("behavioral",          "Behavioral — \"Tell me about a time when you …\""),
        ("technical_deep_dive", "Technical deep-dive — \"What specifically happens when …\" or \"How does X work under the hood?\""),
        ("problem_solving",    "Problem-solving — \"How would you approach …\" or \"How would you design …\""),
        ("reflection",         "Reflection — \"What would you do differently?\" / \"What did you learn?\""),
    ]

    avoid = ", ".join(last_two) if last_two else "none yet"
    suggestions = "\n".join(f"  • {label}" for _, label in rotation_pool if _ != last)
    clarification_note = (
        "Clarification questions are allowed only if the previous answer was "
        "genuinely unclear AND you have not used clarification in the last "
        "two turns."
    )
    return (
        f"QUESTION VARIETY RULES:\n"
        f"  Recent question types used (most recent last): {avoid}\n"
        f"  Do NOT use the same question structure as the previous turn.\n"
        f"  Pick the next question from a DIFFERENT shape than the last one:\n"
        f"{suggestions}\n"
        f"  {clarification_note}"
    )
