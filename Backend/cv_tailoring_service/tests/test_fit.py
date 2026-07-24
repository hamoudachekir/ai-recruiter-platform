from app.fit import analyze_fit, detect_required_skills


CV = {
    "name": "Ada",
    "profile": {
        "skills": ["Python", "FastAPI", "Docker", "PostgreSQL"],
        "experience": [{"description": "Built REST APIs with Python and Docker"}],
    },
}


def test_detects_canonical_skills_and_aliases():
    skills = detect_required_skills("Need Python, NodeJS, K8s and RESTful API experience")
    assert skills == ["Kubernetes", "Node.js", "Python", "REST API"]


def test_fit_returns_matched_and_missing_skills():
    result = analyze_fit(
        CV,
        "We need a Python FastAPI engineer with Docker, Kubernetes and PostgreSQL.",
    )
    assert result.score >= 60
    assert set(result.matched_skills) >= {"Python", "FastAPI", "Docker", "PostgreSQL"}
    assert result.missing_skills == ["Kubernetes"]
    assert result.recommendation in {"apply", "consider"}


def test_fit_does_not_claim_absent_skill():
    result = analyze_fit(CV, "Senior Angular and C# developer required for Azure")
    assert result.matched_skills == []
    assert set(result.missing_skills) == {"Angular", "Azure", "C#"}
    assert result.recommendation == "skip"
