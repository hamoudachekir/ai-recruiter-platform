import json
import re
import unicodedata

from app.keywords import extract_keywords
from app.schema import FitAnalysis


SKILL_ALIASES = {
    "Angular": ("angular",),
    "AWS": ("aws", "amazon web services"),
    "Azure": ("azure",),
    "C#": ("c#", "c sharp"),
    "CI/CD": ("ci/cd", "continuous integration", "gitlab ci", "github actions", "jenkins"),
    "Django": ("django",),
    "Docker": ("docker", "containerisation", "containerization"),
    "FastAPI": ("fastapi",),
    "Flask": ("flask",),
    "GCP": ("gcp", "google cloud"),
    "Git": ("git",),
    "Java": ("java",),
    "JavaScript": ("javascript", "js"),
    "Kubernetes": ("kubernetes", "k8s"),
    "LangChain": ("langchain",),
    "LangGraph": ("langgraph",),
    "Laravel": ("laravel",),
    "LLM": ("llm", "large language model", "generative ai", "genai"),
    "MongoDB": ("mongodb", "mongo db"),
    "Node.js": ("node.js", "nodejs", "node js", "express.js", "expressjs"),
    "PostgreSQL": ("postgresql", "postgres"),
    "Python": ("python",),
    "RAG": ("rag", "retrieval augmented generation", "retrieval-augmented generation"),
    "React": ("react", "react.js", "reactjs"),
    "REST API": ("rest api", "restful api", "api rest"),
    "SQL": ("sql",),
    "Solidity": ("solidity",),
    "Spring Boot": ("spring boot",),
    "TypeScript": ("typescript",),
}


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", text.lower()).strip()


def _contains(text: str, term: str) -> bool:
    normalised_term = _normalise(term)
    if re.fullmatch(r"[a-z0-9]+", normalised_term):
        return re.search(rf"\b{re.escape(normalised_term)}\b", text) is not None
    return normalised_term in text


def cv_to_text(cv_json: dict) -> str:
    return _normalise(json.dumps(cv_json, ensure_ascii=False))


def detect_required_skills(job_text: str) -> list[str]:
    text = _normalise(job_text)
    return [
        skill
        for skill, aliases in SKILL_ALIASES.items()
        if any(_contains(text, alias) for alias in aliases)
    ]


def analyze_fit(cv_json: dict, job_text: str) -> FitAnalysis:
    candidate_text = cv_to_text(cv_json)
    required_skills = detect_required_skills(job_text)
    matched_skills = [
        skill
        for skill in required_skills
        if any(_contains(candidate_text, alias) for alias in SKILL_ALIASES[skill])
    ]
    missing_skills = [skill for skill in required_skills if skill not in matched_skills]

    keywords = extract_keywords({"description": job_text}, top_k=20)
    supporting_keywords = [
        keyword
        for keyword in keywords
        if not any(_contains(_normalise(keyword), alias) for aliases in SKILL_ALIASES.values() for alias in aliases)
    ][:10]
    matched_keywords = [keyword for keyword in supporting_keywords if _contains(candidate_text, keyword)]
    missing_keywords = [keyword for keyword in supporting_keywords if keyword not in matched_keywords]

    skill_score = len(matched_skills) / len(required_skills) if required_skills else 0.5
    keyword_score = len(matched_keywords) / len(supporting_keywords) if supporting_keywords else skill_score
    score = round(100 * ((0.8 * skill_score) + (0.2 * keyword_score)))

    if score >= 65:
        recommendation = "apply"
    elif score >= 40:
        recommendation = "consider"
    else:
        recommendation = "skip"

    evidence = []
    if matched_skills:
        evidence.append(f"Compétences techniques correspondantes : {', '.join(matched_skills[:8])}.")
    if missing_skills:
        evidence.append(f"Compétences demandées non trouvées dans le CV : {', '.join(missing_skills[:8])}.")
    if not required_skills:
        evidence.append("Peu de compétences techniques explicites détectées ; vérification manuelle recommandée.")

    return FitAnalysis(
        score=score,
        recommendation=recommendation,
        matched_skills=matched_skills,
        missing_skills=missing_skills,
        matched_keywords=matched_keywords,
        missing_keywords=missing_keywords,
        evidence=evidence,
    )
