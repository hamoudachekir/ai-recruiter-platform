"""Skills extraction service.

Performs deterministic keyword matching against a known skill dictionary.
Only marks a skill as detected if it appears in candidate answers.
Never invents skills — only matches against confirmed evidence.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

_LOG = logging.getLogger(__name__)

# ── Master skill dictionary with normalized names and aliases ──────────────
SKILL_DICTIONARY: dict[str, list[str]] = {
    # Frontend
    "React": ["react", "reactjs", "react.js"],
    "Angular": ["angular", "angularjs", "angular.js"],
    "Vue": ["vue", "vuejs", "vue.js"],
    "JavaScript": ["javascript", "js ", " js,", "ecmascript", "es6", "es2015"],
    "TypeScript": ["typescript", " ts ", " ts,"],
    "HTML": ["html", "html5"],
    "CSS": ["css", "css3", "sass", "scss"],
    # Backend
    "Node.js": ["node.js", "nodejs", " node "],
    "Express": ["express", "expressjs", "express.js"],
    "Python": ["python"],
    "Flask": ["flask"],
    "Django": ["django"],
    "FastAPI": ["fastapi", "fast api"],
    "Java": ["java", "spring boot", "springboot"],
    "C#": ["c#", ".net", "asp.net", "dotnet"],
    "PHP": ["php", "laravel", "symfony"],
    "Go": ["golang", "go lang"],
    "Rust": ["rust"],
    # Database
    "MongoDB": ["mongodb", "mongo", "mongoose"],
    "SQL": ["sql", "mysql", "postgresql", "postgres", "sqlite", "mariadb"],
    "Redis": ["redis"],
    "Elasticsearch": ["elasticsearch", "elastic search"],
    # DevOps / Cloud
    "Docker": ["docker", "dockerfile", "docker-compose", "containeriz"],
    "Kubernetes": ["kubernetes", "k8s", "kubectl"],
    "GitHub Actions": ["github actions", "github ci"],
    "CI/CD": ["ci/cd", "cicd", "continuous integration", "continuous deployment"],
    "AWS": ["aws", "amazon web services", " s3 ", " ec2 ", "lambda", "cloudfront"],
    "Azure": ["azure", "microsoft azure", "azure devops"],
    "GCP": ["gcp", "google cloud", "bigquery"],
    "Nginx": ["nginx"],
    "Linux": ["linux", "ubuntu", "debian", "centos"],
    # Process / API
    "Agile": ["agile", "scrum", "kanban", "sprint"],
    "Scrum": ["scrum master", "scrum"],
    "Git": ["git", "github", "gitlab", "bitbucket"],
    "REST API": ["rest api", "restful", "api design", "rest apis"],
    "GraphQL": ["graphql", "graph ql"],
    "Testing": [
        "unit test",
        "integration test",
        "jest",
        "pytest",
        "mocha",
        "cypress",
        "tdd",
        "bdd",
    ],
    # AI / ML
    "Machine Learning": ["machine learning", "deep learning", "neural network"],
    "LangChain": ["langchain", "langgraph"],
    "STT": ["speech to text", "stt", "whisper"],
    "TTS": ["text to speech", "tts"],
}

# ── Skill categories ────────────────────────────────────────────────────────
SKILL_CATEGORIES: dict[str, list[str]] = {
    "frontend": ["React", "Angular", "Vue", "JavaScript", "TypeScript", "HTML", "CSS"],
    "backend": [
        "Node.js",
        "Express",
        "Python",
        "Flask",
        "Django",
        "FastAPI",
        "Java",
        "C#",
        "PHP",
        "Go",
        "Rust",
    ],
    "database": ["MongoDB", "SQL", "Redis", "Elasticsearch"],
    "devops": [
        "Docker",
        "Kubernetes",
        "GitHub Actions",
        "CI/CD",
        "Nginx",
        "Linux",
        "Git",
    ],
    "cloud": ["AWS", "Azure", "GCP"],
    "process": ["Agile", "Scrum", "REST API", "GraphQL", "Testing"],
    "ai_ml": ["Machine Learning", "LangChain", "STT", "TTS"],
    "softSkills": [],
}


def _normalize_text(text: str) -> str:
    """Pad text with spaces so boundary matching works at start/end."""
    return " " + text.lower() + " "


def _has_skill(normalized_text: str, aliases: list[str]) -> bool:
    """Return True if any alias for a skill is found in the candidate text."""
    for alias in aliases:
        # Use the alias itself as a pattern — it already contains spaces where needed
        if alias in normalized_text:
            return True
        # Also try a regex word-boundary check for short tokens
        if len(alias.strip()) >= 3:
            pattern = (
                r"(?<![a-z0-9])" + re.escape(alias.strip().lower()) + r"(?![a-z0-9])"
            )
            if re.search(pattern, normalized_text):
                return True
    return False


def _count_mentions(normalized_text: str, aliases: list[str]) -> int:
    count = 0
    for alias in aliases:
        count += normalized_text.count(alias)
    return count


def _find_evidence(text: str, aliases: list[str], max_snippets: int = 3) -> list[str]:
    """Extract short evidence sentences from candidate text."""
    sentences = re.split(r"[.!?;\n]", text)
    evidence = []
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence or len(sentence.split()) < 3:
            continue
        sentence_normalized = _normalize_text(sentence)
        for alias in aliases:
            if alias in sentence_normalized:
                snippet = sentence[:200]
                if snippet not in evidence:
                    evidence.append(snippet)
                break
        if len(evidence) >= max_snippets:
            break
    return evidence


def extract_skills_from_interview(
    qna_items: list[dict],
    full_transcript: str = "",
    job_required_skills: Optional[list[str]] = None,
) -> dict:
    """Extract skills from candidate answers only.

    Rules:
    - Only marks skill as detected if it appears in candidate answer text.
    - Does not count skills mentioned only in AI questions.
    - Stores short evidence snippets per skill.
    - Normalizes skill name variants.

    Args:
        qna_items: Q&A items (each has questionText, answerText)
        full_transcript: Full STT text as fallback when no Q&A items
        job_required_skills: Required skills from job (for gap analysis)

    Returns:
        skillsExtractedFromInterview dict
    """
    empty_categories = {cat: [] for cat in SKILL_CATEGORIES}

    if not qna_items and not full_transcript:
        return {
            "detectedSkills": [],
            "missingFromInterview": list(job_required_skills or []),
            "categories": empty_categories,
            "note": "No candidate answers available for skill extraction.",
        }

    # Build candidate-only text — answers only, NOT questions
    candidate_text_parts = []
    for item in qna_items:
        answer = (item.get("answerText") or "").strip()
        if answer:
            candidate_text_parts.append(answer)

    # Fallback to full transcript if no structured answers
    candidate_text = " ".join(candidate_text_parts)
    if not candidate_text and full_transcript:
        candidate_text = full_transcript
        _LOG.info("[Skills] Using full transcript as fallback for skill extraction")

    if not candidate_text:
        return {
            "detectedSkills": [],
            "missingFromInterview": list(job_required_skills or []),
            "categories": empty_categories,
            "note": "No candidate answer text for skill extraction.",
        }

    normalized = _normalize_text(candidate_text)
    detected_skills = []
    detected_skill_names: set[str] = set()

    for skill_name, aliases in SKILL_DICTIONARY.items():
        if _has_skill(normalized, aliases):
            mention_count = _count_mentions(normalized, aliases)
            evidence = _find_evidence(candidate_text, aliases)
            confidence = (
                "high"
                if mention_count >= 3
                else ("medium" if mention_count >= 2 else "low")
            )

            detected_skills.append(
                {
                    "skill": skill_name,
                    "mentions": mention_count,
                    "evidence": evidence,
                    "confidence": confidence,
                }
            )
            detected_skill_names.add(skill_name)

    # Categorise detected skills
    categories: dict[str, list[str]] = {cat: [] for cat in SKILL_CATEGORIES}
    for item in detected_skills:
        skill = item["skill"]
        for cat, cat_skills in SKILL_CATEGORIES.items():
            if skill in cat_skills:
                categories[cat].append(skill)
                break

    # Gap analysis — which required skills were NOT mentioned?
    missing_from_interview: list[str] = []
    if job_required_skills:
        for req_skill in job_required_skills:
            matched = False
            req_lower = req_skill.lower().strip()
            for skill_name in detected_skill_names:
                if req_lower in skill_name.lower() or skill_name.lower() in req_lower:
                    matched = True
                    break
            if not matched:
                missing_from_interview.append(req_skill)

    _LOG.info(
        "[Skills] Detected %d skills, %d missing from interview",
        len(detected_skills),
        len(missing_from_interview),
    )

    return {
        "detectedSkills": detected_skills,
        "missingFromInterview": missing_from_interview,
        "categories": categories,
    }
