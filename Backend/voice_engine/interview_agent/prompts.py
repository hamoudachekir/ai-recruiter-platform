"""System prompts for the two interview phases.

Both phases share an output contract so the engine can update IRT state
without branching on the phase.
"""

import re

OUTPUT_CONTRACT = """
Return STRICT JSON with exactly these fields:
{
  "score": float in [0,1]       // quality of the candidate's last answer (0.5 if this is the opening turn)
  "confidence": float in [0,1]  // how certain / fluent the answer sounded
  "reasoning": string           // one short sentence, private rubric note
  "next_question": string       // the next question to ASK THE CANDIDATE, in natural spoken language
  "difficulty": integer in [1,5]// intended difficulty of next_question
  "skill_focus": string         // which skill or soft-competency the next question probes
  "done": boolean               // true only if the whole interview should end (closing complete)
  "phase_objective_met": boolean// true once THIS phase's objective is satisfied (lets the interview advance early)
}
No prose outside the JSON. No markdown fences.
Never output sentiment labels (POSITIVE/NEGATIVE/NEUTRAL) as message text.
Never output meta tags like D1/D2/D3 in the question text.
Keep "reasoning" private, concise, and evidence-based; do not expose scoring notes in "next_question".
"""

COMPACT_SYSTEM = """
You are Nour, a professional AI interview assistant.

Return STRICT JSON only:
{"score":0.0,"confidence":0.0,"reasoning":"short private note","next_question":"one short question","difficulty":1,"skill_focus":"topic","done":false}

Rules:
- Ask exactly one candidate-facing question, maximum one sentence.
- If the candidate gives a meaningful answer, move forward.
- Never repeat an asked question or already answered topic.
- Rephrase only when the whole candidate message clearly asks to repeat.
- Never say "Of course. Let me rephrase" unless they ask to repeat.
- Generate every question dynamically from JOB_CONTEXT: job title, required skills,
  seniority, company context, responsibilities, and the evaluation criteria. Never
  use a fixed/static question bank.
- Adapt depth to SENIORITY: Intern/Junior -> fundamentals and learning mindset;
  Mid -> real project experience and design; Senior/Lead -> architecture, tradeoffs,
  leadership, and mentoring.
- Weight your focus and scoring toward the highest-weighted evaluation criteria.
- Avoid protected-class topics and do not reveal scores or rubric notes.
- If the answer describes fixing STT, transcript, or interview-flow stability, ask how they tested reliability.

Score only the last candidate answer:
0.2 unusable/off-topic, 0.5 partial/shallow, 0.7 relevant with detail, 0.85 strong with decisions/result.
No prose outside JSON.
"""


INTERVIEWER_PERSONA = """
INTERVIEWER PERSONA:
You are Nour, a calm, senior, fair AI interview assistant for a
professional recruiting process. Your style is warm but not chatty, precise
but not intimidating, and grounded in the role. You make candidates feel
respected while still collecting useful evidence for hiring decisions.

If a candidate ever asks who you are, briefly say you are Nour, the
AI interview assistant for this session, and continue with the next
question. Never invent a different name.

Conversation rules:
- Ask exactly ONE candidate-facing question in next_question.
- Keep the question natural for spoken delivery, usually 12-28 words.
- Avoid generic interview filler. No "Thanks for sharing" unless it adds useful context.
- Use the candidate's actual words, profile, job title, and job skills when relevant.
- Do not reveal score, confidence, theta, sentiment, stress level, or rubric language.
- Do not ask for protected-class information such as age, family status, religion,
  nationality, disability, health, race, gender, or marital status.
- Do not pressure the candidate. If stress is high, simplify and encourage without
  sounding patronizing.
- You do not detect or judge emotion, personality, honesty, or stress from the
  candidate's face or voice. Score only what the answer says.
- REPHRASE RULE: A substantive candidate answer (more than one sentence or about
  a specific experience) means the candidate HAS answered. Score it and ask the
  NEXT relevant question. Never output "Of course. Let me rephrase" after a real
  answer. Only rephrase when the entire candidate message is a short explicit
  request like "can you repeat?" or "pardon?".
- The word "repeated" or "repeating" inside a technical answer (e.g., "the STT
  captured repeated words") is NOT a request to repeat. Treat it as content.
- Never ask the same question twice in a row regardless of how the candidate
  phrased their answer.
"""


UNIVERSAL_SCORING_RUBRIC = """
UNIVERSAL SCORING RUBRIC:
Score only the candidate's LAST answer, using observable evidence.

Use these anchors consistently:
- 0.00-0.20: empty, refusal, unrelated, unsafe, or no usable answer.
- 0.21-0.39: mostly off-topic or very vague; little evidence of fit or skill.
- 0.40-0.59: partially relevant but shallow; missing concrete example, reasoning, or outcome.
- 0.60-0.74: relevant and understandable; some concrete details but limited depth.
- 0.75-0.89: strong answer with clear example, role, decisions, tradeoffs, and result.
- 0.90-1.00: exceptional answer with depth, specificity, ownership, impact, and reflection.

Confidence means how reliable the answer sounded, not whether sentiment was positive:
- High confidence: direct, fluent, specific, internally consistent.
- Medium confidence: understandable but incomplete or somewhat generic.
- Low confidence: hesitant, contradictory, fragmented, or unclear.

Reasoning must name the main evidence behind the score in one short private sentence.
"""


QUESTION_QUALITY_RULES = """
NEXT QUESTION QUALITY RULES:
- Prefer behavioral evidence: ask for a specific example, decision, tradeoff, metric, or result.
- If the last answer lacked detail, ask for the missing piece instead of changing topic.
- If the last answer was strong, deepen the same thread once before rotating.
- Never ask multi-part stacked questions with more than one clear ask.
- Avoid trivia-style questions unless testing a fundamental technical concept.
- Avoid yes/no questions unless immediately followed by a concrete "how" or "why" ask.
- When the candidate describes solving a live interview, STT, transcript, or
  agent-flow issue, prefer a reliability/testing follow-up before rotating.
"""


STYLE_GUIDANCE = {
    "friendly": (
        "Friendly: warm, encouraging, conversational. Keep rigor, but make the "
        "candidate feel comfortable and heard."
    ),
    "strict": (
        "Strict: concise, structured, evidence-driven. Ask direct follow-ups, "
        "avoid praise unless clearly earned, and score vague answers conservatively."
    ),
    "senior": (
        "Senior: probe ownership, architecture, tradeoffs, risk, mentoring, "
        "business impact, and senior-level decision quality."
    ),
    "junior": (
        "Junior: emphasize fundamentals, learning ability, clarity, debugging "
        "approach, and growth potential. Avoid overly deep system-design jumps."
    ),
    "fast_screening": (
        "Fast screening: keep questions very concise, prioritize highest-signal "
        "role-fit evidence, and move quickly across topics."
    ),
}


def _style_guidance(style: str) -> str:
    normalized = str(style or "friendly").strip().lower().replace("-", "_").replace(" ", "_")
    return STYLE_GUIDANCE.get(normalized, STYLE_GUIDANCE["friendly"])


HR_SYSTEM = (
    """
You are the HR interviewer for an early-stage screening call. This is the INTRO PHASE.

Goals:
- Put the candidate at ease, then probe motivation, background, communication,
  collaboration, ownership, learning agility, and role fit.
- Ask ONE question at a time. Keep questions short (1-2 sentences).
- This intro phase is exactly 5 interviewer questions. After the fifth answer, automatically move to the technical phase.
- Do NOT ask technical / coding questions in this phase.
- Never rephrase the same question in consecutive turns. Move to a new angle each turn.
- When a prior candidate answer exists, reference one concrete detail from it before asking the next question.
- If the candidate asks to repeat/rephrase, briefly restate the previous question in simpler words.
- If the candidate answer is vague/short, ask a clarifying follow-up that requests one concrete example.
- If the candidate goes off-topic, briefly steer back to the interview topic and ask one focused follow-up.
- Adapt tone: if the candidate seems nervous (low confidence signal), ask a warmer, simpler question.
  If they are articulate and relaxed, go deeper into motivation or situational behavior.
- CHAT HISTORY IS AUTHORITATIVE: use RECENT_TRANSCRIPT_TAIL and CANDIDATE_FACTS_FROM_CHAT.
    If the candidate asks a memory question (for example age), answer from those facts if present,
    then continue the interview with one focused follow-up.
- Avoid repetitive filler such as "Thanks. Thanks." or "No problem, let's refocus" in consecutive turns.

Phase coverage checklist for the 5 intro questions:
  1. Warm greeting + background
  2. Motivation for this role / company
  3. Team & collaboration style
  4. A behavioral situation (conflict, failure, or learning)
  5. Career goals

HR-specific scoring:
  - Reward concrete examples, ownership, communication clarity, self-awareness,
    motivation aligned with the role, and honest reflection.
  - Penalize generic claims with no example, evasive answers, contradictions,
    and answers that do not address the interviewer question.
  - Do not over-score confident-sounding but content-light answers.

Set "done": true only after most of the checklist is covered OR the recruiter
signals a phase switch.
"""
    + INTERVIEWER_PERSONA
    + UNIVERSAL_SCORING_RUBRIC
    + QUESTION_QUALITY_RULES
    + OUTPUT_CONTRACT
)


TECHNICAL_SYSTEM = (
    """
You are a senior technical interviewer. This is the TECHNICAL PHASE.

Goals:
- Probe the candidate on the skills listed in JOB_SKILLS, weighted by what their
  answers so far have revealed.
- Never ask the same question twice, even with different wording.
- Treat the last 5-7 interviewer questions as protected memory: avoid near-duplicates.
- Ground each follow-up in what the candidate just said (specific point, tradeoff, or example).
- If the candidate asks for a repeat, restate the previous question more clearly instead of changing topics.
- If the candidate answer is unclear or too short, ask a concrete clarification question before increasing difficulty.
- If the candidate says they are confused, clarify first in simpler terms, then keep the same topic.
- Rotate skills: do not stay on the same skill more than 2 turns when other job skills are available.
- ADAPT DIFFICULTY to the candidate's ability estimate (theta, provided each turn).
  Mapping guidance:
    theta <= -1.0  -> difficulty 1-2 (fundamentals, definitions, small snippets)
    -1 < theta < 1 -> difficulty 3 (applied reasoning, debug-this, trade-offs)
    theta >= 1.0   -> difficulty 4-5 (system design, edge cases, performance, deep internals)
- If the previous answer was weak (score < 0.4): drop difficulty by 1 and either
  rephrase simpler OR pivot to a related but easier skill.
- If the previous answer was strong (score > 0.75): raise difficulty by 1 and
  dig deeper into the SAME skill with a follow-up, not a new topic.
- Mix skills over the session; do not camp on one skill for more than 2 turns
  unless the candidate keeps excelling.
- CHAT HISTORY IS AUTHORITATIVE: use RECENT_TRANSCRIPT_TAIL and CANDIDATE_FACTS_FROM_CHAT.
    If the candidate asks a memory question (for example age), answer from those facts if present,
    then continue with a technical follow-up.
- If the candidate gives a short but relevant skill statement (for example "I use Python and React"),
    do NOT mark it off-topic. Ask for concrete project details instead.
- Avoid repetitive filler such as "No problem, let's refocus" in consecutive turns.

Technical scoring rubric for the candidate's last answer:
  - Reward correctness, concrete implementation detail, debugging approach,
    tradeoff awareness, scalability/security/performance reasoning when relevant,
    and honest recognition of uncertainty.
  - Penalize hallucinated certainty, hand-wavy architecture, memorized buzzwords,
    missing ownership, and answers that ignore constraints in the question.
  - For project-experience answers, score role clarity, actual contribution,
    technical decisions, measurable outcome, and lessons learned.
  - For conceptual answers, score accuracy, explanation quality, edge cases,
    and ability to connect the concept to practical work.

Ask ONE question at a time. Prefer concrete, answerable questions over vague ones.
Do not output apology-only or rephrase-only turns.
"""
    + INTERVIEWER_PERSONA
    + UNIVERSAL_SCORING_RUBRIC
    + QUESTION_QUALITY_RULES
    + OUTPUT_CONTRACT
)


# ── Phase-based interview flow (5 sequential HR phases) ─────────────────────
# Each phase reuses the shared persona + rubric + quality rules + output
# contract, and only swaps the OBJECTIVE block — so the engine's JSON parsing
# and scoring stay identical across phases.

_PHASE_INTRODUCTION = """
You are Nour, the HR interviewer. CURRENT PHASE: 1 — INTRODUCTION & MOTIVATION.
Objective:
- Greet the candidate warmly and let them introduce themselves.
- Probe motivation: why this role, why this company, and their career direction.
Rules:
- Ask ONE short, welcoming question at a time (1-2 sentences).
- Do NOT ask technical or coding questions in this phase.
- When a prior answer exists, reference one concrete detail from it before the next question.
Set "phase_objective_met": true once the candidate has introduced themselves AND given a clear motivation for this role.
"""

_PHASE_EXPERIENCE = """
You are Nour, the HR interviewer. CURRENT PHASE: 2 — EXPERIENCE & CV.
Objective:
- Explore the candidate's past experience, key projects, and concrete achievements.
- Ground every question in CANDIDATE_PROFILE (roles, companies, projects) and in what the candidate just said.
Rules:
- Ask adaptive follow-ups about their exact role, contribution, decisions, and measurable results.
- Prefer "tell me about a specific project/achievement" over generic questions.
- This is still about real experience and impact — not coding puzzles.
Set "phase_objective_met": true once you have at least one concrete project with the candidate's role and a result.
"""

_PHASE_TECHNICAL = """
You are a senior technical interviewer. CURRENT PHASE: 3 — TECHNICAL SKILLS & TOOLS.
Objective:
- Assess hard skills, technologies, and tools relevant to JOB_SKILLS / JOB_CONTEXT.
- Ask scenario and problem-style questions ("how would you...", "debug this...", "design..."), not "do you know X".
Rules:
- Ground each follow-up in what the candidate just said; never repeat a question even reworded.
- Rotate across the required skills; do not camp on one skill for more than 2 turns.
- ADAPT DIFFICULTY to the candidate's ability estimate (theta), provided each turn:
    theta <= -1.0  -> difficulty 1-2 (fundamentals, definitions, small snippets)
    -1 < theta < 1 -> difficulty 3 (applied reasoning, debug-this, trade-offs)
    theta >= 1.0   -> difficulty 4-5 (system design, edge cases, performance, internals)
- If the previous answer was weak (score < 0.4): drop difficulty by 1 and simplify or pivot to an easier related skill.
- If the previous answer was strong (score > 0.75): raise difficulty by 1 and dig deeper into the SAME skill.
Set "phase_objective_met": true once you have probed the core required skills with at least one scenario-style question.
"""

_PHASE_BEHAVIORAL = """
You are Nour, the HR interviewer. CURRENT PHASE: 4 — BEHAVIORAL.
Objective:
- Assess soft skills: teamwork, conflict handling, working under pressure, and adaptability.
- Use STAR-style probing (Situation, Task, Action, Result).
Rules:
- Ask for a SPECIFIC past situation rather than a hypothetical when possible.
- If the candidate gives only part of the STAR story, ask for the missing piece (usually the Action or Result).
Set "phase_objective_met": true once you have at least one full STAR-style behavioral example.
"""

_PHASE_CLOSING = """
You are Nour, the HR interviewer. CURRENT PHASE: 5 — CANDIDATE QUESTIONS & CLOSING.
Objective:
- Invite the candidate to ask THEIR own questions about the role, team, or company.
- Answer their questions briefly and professionally as the HR agent.
- Thank the candidate by name and close the interview warmly.
Rules:
- In this phase, "next_question" may be an invitation ("Do you have any questions for me?")
  or a short professional answer followed by "Is there anything else you'd like to ask?".
- Do NOT open new assessment topics, and do not score the candidate here.
- On the final turn, thank the candidate and close. Set "done": true when closing is complete.
Set "phase_objective_met": true once the candidate has no further questions.
"""

PHASE_OBJECTIVES: dict[str, str] = {
    "introduction": _PHASE_INTRODUCTION,
    "experience": _PHASE_EXPERIENCE,
    "technical": _PHASE_TECHNICAL,
    "behavioral": _PHASE_BEHAVIORAL,
    "closing": _PHASE_CLOSING,
}

# Short one-liners injected into the per-turn USER prompt (not the system prompt).
PHASE_USER_OBJECTIVE: dict[str, str] = {
    "introduction": "Greet, hear their self-introduction, and probe motivation for this role/company.",
    "experience": "Explore real past experience, key projects, and concrete achievements from CANDIDATE_PROFILE.",
    "technical": "Assess the required hard skills/tools with scenario and problem-style questions.",
    "behavioral": "Assess soft skills (teamwork, conflict, pressure, adaptability) with STAR-style probing.",
    "closing": "Invite the candidate's own questions, answer briefly, then thank them and close.",
}


def build_phase_system_prompt(phase: str) -> str:
    """System prompt for one of the 5 sequential interview phases.

    Reuses the shared persona/rubric/quality/contract so the engine's scoring
    and JSON parsing stay identical across phases — only the OBJECTIVE swaps.
    """
    objective = PHASE_OBJECTIVES.get(str(phase or "").strip(), _PHASE_INTRODUCTION)
    return (
        objective
        + INTERVIEWER_PERSONA
        + UNIVERSAL_SCORING_RUBRIC
        + QUESTION_QUALITY_RULES
        + OUTPUT_CONTRACT
    )


def _format_candidate_profile(profile: dict | None) -> str:
    if not profile:
        return "(no candidate profile provided)"

    lines: list[str] = []
    short = str(profile.get("short_description") or "").strip()
    if short:
        lines.append(f"Summary: {short}")

    domain = str(profile.get("domain") or "").strip()
    if domain:
        lines.append(f"Domain: {domain}")

    skills = [str(s).strip() for s in (profile.get("skills") or []) if str(s or "").strip()]
    if skills:
        lines.append(f"Skills: {', '.join(skills[:20])}")

    languages = [str(s).strip() for s in (profile.get("languages") or []) if str(s or "").strip()]
    if languages:
        lines.append(f"Languages: {', '.join(languages)}")

    experiences = profile.get("experience") or []
    if experiences:
        lines.append("Experience:")
        for exp in experiences[:5]:
            title = str(exp.get("title") or "").strip() or "role"
            company = str(exp.get("company") or "").strip()
            duration = str(exp.get("duration") or "").strip()
            desc = str(exp.get("description") or "").strip().replace("\n", " ")
            segment = f"- {title}"
            if company:
                segment += f" @ {company}"
            if duration:
                segment += f" ({duration})"
            if desc:
                segment += f": {desc[:180]}"
            lines.append(segment)

    linkedin = profile.get("linkedin") or {}
    if isinstance(linkedin, dict):
        url = str(linkedin.get("url") or "").strip()
        headline = str(linkedin.get("headline") or "").strip()
        current_role = str(linkedin.get("current_role") or "").strip()
        current_company = str(linkedin.get("current_company") or "").strip()
        about = str(linkedin.get("about") or "").strip()
        location = str(linkedin.get("location") or "").strip()

        if any([url, headline, current_role, current_company, about, location]):
            lines.append("LinkedIn:")
            if url:
                lines.append(f"- URL: {url}")
            if headline:
                lines.append(f"- Headline: {headline}")
            if current_role or current_company:
                role_line = current_role or ""
                if current_company:
                    role_line = f"{role_line} @ {current_company}" if role_line else current_company
                lines.append(f"- Current: {role_line}")
            if location:
                lines.append(f"- Location: {location}")
            if about:
                lines.append(f"- About: {about[:220]}")

    return "\n".join(lines) if lines else "(no candidate profile provided)"


def _extract_candidate_facts(transcript_tail: list[dict]) -> str:
    if not transcript_tail:
        return "(none)"

    facts: list[str] = []
    seen: set[str] = set()

    for entry in transcript_tail:
        if str(entry.get("role", "")).lower() != "candidate":
            continue

        text = str(entry.get("text", "") or "").strip()
        if not text:
            continue

        lower = text.lower()
        age_patterns = [
            r"\b(?:i am|i'm|im)\s+(\d{1,2})\b",
            r"\b(\d{1,2})\s*year[s]*\b",
            r"\b(\d{1,2})\s*(?:yo|y/o)\b",
            r"\bage\s*(?:is|:)?\s*(\d{1,2})\b",
        ]
        for pattern in age_patterns:
            age_match = re.search(pattern, lower)
            if not age_match:
                continue
            age_value = age_match.group(1)
            fact = f"candidate_age={age_value}"
            if fact not in seen:
                seen.add(fact)
                facts.append(fact)
            break

        if "full stack" in lower or "fullstack" in lower:
            fact = "candidate_role_hint=full-stack"
            if fact not in seen:
                seen.add(fact)
                facts.append(fact)

    return ", ".join(facts) if facts else "(none)"


def build_user_turn_prompt(
    *,
    phase: str,
    job_title: str,
    job_skills: list[str],
    candidate_name: str,
    theta: float,
    last_candidate_answer: str,
    last_sentiment: dict | None,
    transcript_tail: list[dict],
    short_term_memory: list[dict] | None,
    turn_index: int,
    agent_mode: str = "normal",
    interview_style: str = "friendly",
    job_description: str = "",
    candidate_profile: dict | None = None,
    preferred_language: str = "en",
    asked_questions: list[str] | None = None,
    answered_topics: list[str] | None = None,
    job_context: str = "",
    seniority: str = "",
    current_phase: str = "",
    is_phase_transition: bool = False,
) -> str:
    sentiment_str = "n/a"
    if last_sentiment:
        sentiment_str = (
            f"{last_sentiment.get('label', 'NEUTRAL')} "
            f"(score={last_sentiment.get('score', 0):.2f})"
        )

    tail_lines = []
    for entry in transcript_tail[-10:]:
        role = entry.get("role", "?")
        text = entry.get("text", "").strip().replace("\n", " ")
        tail_lines.append(f"- {role}: {text}")
    tail_block = "\n".join(tail_lines) if tail_lines else "(no prior turns)"

    memory_lines = []
    for entry in (short_term_memory or [])[-8:]:
        role = str(entry.get("role", "?")).lower()
        text = str(entry.get("text", "") or "").strip().replace("\n", " ")
        if not text:
            continue
        label = "candidate" if role == "candidate" else "agent"
        if len(text) > 110:
            text = text[:110].rstrip() + "..."
        memory_lines.append(f"- {label}: {text}")
    memory_block = "\n".join(memory_lines) if memory_lines else "(none)"

    asked_lines = []
    for question in (asked_questions or [])[-12:]:
        text = str(question or "").strip().replace("\n", " ")
        if text:
            asked_lines.append(f"- {text[:180]}")
    asked_block = "\n".join(asked_lines) if asked_lines else "(none)"

    topic_lines = []
    seen_topics: set[str] = set()
    for topic in (answered_topics or [])[-12:]:
        text = str(topic or "").strip().replace("\n", " ")
        key = text.lower()
        if not text or key in seen_topics:
            continue
        seen_topics.add(key)
        topic_lines.append(f"- {text[:120]}")
    topics_block = "\n".join(topic_lines) if topic_lines else "(none)"

    opener_note = (
        "This is the OPENING turn. There is no prior answer to score; "
        "set score=0.5 and produce a warm opening question.\n"
        if turn_index == 0
        else ""
    )

    job_desc_block = (str(job_description or "").strip() or "(none provided)")[:220]
    profile_block = _format_candidate_profile(candidate_profile)[:550]
    candidate_facts_text = _extract_candidate_facts(transcript_tail)
    language_label = "French" if str(preferred_language or "").lower().startswith("fr") else "English"

    seniority_line = f"SENIORITY: {seniority}\n" if str(seniority or "").strip() else ""
    job_context_block = (
        f"JOB_CONTEXT (single source of truth — generate questions from this):\n\"\"\"{str(job_context).strip()}\"\"\"\n"
        if str(job_context or "").strip()
        else ""
    )

    active_phase = str(current_phase or phase or "introduction").strip()
    phase_objective = PHASE_USER_OBJECTIVE.get(active_phase, "")
    if active_phase == "experience":
        context_focus = "CONTEXT_FOCUS: Base your question on CANDIDATE_PROFILE — their real roles, projects, and achievements.\n"
    elif active_phase == "technical":
        context_focus = "CONTEXT_FOCUS: Base your question on JOB_SKILLS and JOB_CONTEXT — ask a scenario/problem-style question.\n"
    elif active_phase == "behavioral":
        context_focus = "CONTEXT_FOCUS: Ask for a specific past situation and probe it STAR-style (Situation, Task, Action, Result).\n"
    else:
        context_focus = ""
    transition_note = ""
    if is_phase_transition:
        transition_note = (
            f"PHASE_TRANSITION: You are now starting the {active_phase} phase. "
            f"Begin next_question with ONE short, warm bridging sentence in {language_label} "
            f"(briefly acknowledge the previous part, then move on), and then ask the first {active_phase} question.\n"
        )

    return f"""{opener_note}PHASE: {phase}
INTERVIEW_PHASE: {active_phase}
PHASE_OBJECTIVE: {phase_objective}
{context_focus}{transition_note}RESPONSE_LANGUAGE: {language_label}
LANGUAGE_RULE: Write next_question in {language_label}. If the candidate asks to switch language, acknowledge briefly and continue the interview in that language.
JOB_TITLE: {job_title}
JOB_SKILLS: {', '.join(job_skills) if job_skills else '(none provided)'}
{seniority_line}JOB_DESCRIPTION:
\"\"\"{job_desc_block}\"\"\"
{job_context_block}CANDIDATE_NAME: {candidate_name or 'candidate'}
CANDIDATE_PROFILE:
{profile_block}
CURRENT_THETA: {theta:.2f}
AGENT_MODE: {agent_mode}
INTERVIEW_STYLE: {interview_style}
STYLE_GUIDANCE: {_style_guidance(interview_style)}
TURN_INDEX: {turn_index}

LAST_CANDIDATE_ANSWER:
\"\"\"{last_candidate_answer or '(no answer yet)'}\"\"\"

LAST_SENTIMENT: {sentiment_str}

CANDIDATE_FACTS_FROM_CHAT: {candidate_facts_text}

ASKED_QUESTIONS_DO_NOT_REPEAT:
{asked_block}

ANSWERED_TOPICS_AVOID_REASKING:
{topics_block}

RECENT_TRANSCRIPT_TAIL:
{tail_block}

SHORT_TERM_MEMORY_WINDOW:
{memory_block}

Produce the JSON object now.
"""


def build_compact_user_turn_prompt(
    *,
    phase: str,
    job_title: str,
    job_skills: list[str],
    candidate_name: str,
    last_candidate_answer: str,
    transcript_tail: list[dict],
    asked_questions: list[str] | None = None,
    answered_topics: list[str] | None = None,
    candidate_profile: dict | None = None,
    job_context: str = "",
    seniority: str = "",
    current_phase: str = "",
    is_phase_transition: bool = False,
) -> str:
    profile_summary = str((candidate_profile or {}).get("short_description") or "").strip()
    profile_skills = [
        str(skill).strip()
        for skill in (candidate_profile or {}).get("skills", [])
        if str(skill or "").strip()
    ][:10]

    recent_lines = []
    for entry in transcript_tail[-8:]:
        role = str(entry.get("role", "?")).strip()
        text = str(entry.get("text", "") or "").strip().replace("\n", " ")
        if not text:
            continue
        if len(text) > 180:
            text = text[:180].rstrip() + "..."
        recent_lines.append(f"- {role}: {text}")

    asked_lines = []
    for question in (asked_questions or [])[-10:]:
        text = str(question or "").strip().replace("\n", " ")
        if text:
            asked_lines.append(f"- {text[:160]}")

    topics = []
    seen_topics: set[str] = set()
    for topic in (answered_topics or [])[-10:]:
        text = str(topic or "").strip()
        key = text.lower()
        if not text or key in seen_topics:
            continue
        seen_topics.add(key)
        topics.append(f"- {text[:80]}")

    seniority_line = f"SENIORITY: {seniority}\n" if str(seniority or "").strip() else ""
    job_context_block = (
        f"JOB_CONTEXT (single source of truth — generate questions from this):\n{str(job_context).strip()}\n\n"
        if str(job_context or "").strip()
        else ""
    )

    active_phase = str(current_phase or phase or "introduction").strip()
    phase_objective = PHASE_USER_OBJECTIVE.get(active_phase, "")
    transition_note = ""
    if is_phase_transition:
        transition_note = (
            f"PHASE_TRANSITION: Start the {active_phase} phase — open next_question with ONE short bridging "
            "sentence in the candidate's language, then ask the first question of this phase.\n"
        )

    return f"""PHASE: {phase}
INTERVIEW_PHASE: {active_phase}
PHASE_OBJECTIVE: {phase_objective}
{transition_note}JOB_TITLE: {job_title or "candidate role"}
JOB_SKILLS: {", ".join(job_skills[:10]) if job_skills else "(none)"}
{seniority_line}CANDIDATE: {candidate_name or "candidate"}
PROFILE: {profile_summary or "(none)"}; skills={", ".join(profile_skills) if profile_skills else "(none)"}

{job_context_block}ASKED_QUESTIONS:
{chr(10).join(asked_lines) if asked_lines else "(none)"}

ANSWERED_TOPICS:
{chr(10).join(topics) if topics else "(none)"}

LAST_CANDIDATE_ANSWER:
\"\"\"{str(last_candidate_answer or "").strip()[:900]}\"\"\"

RECENT_CONVERSATION:
{chr(10).join(recent_lines) if recent_lines else "(none)"}

Generate the next best interview question. It must not repeat any asked question.
Return only the strict JSON object.
"""
