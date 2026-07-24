from app.cover_letter import generate_cover_letter


CV = {
    "name": "Ada Lovelace",
    "profile": {
        "shortDescription": "Software engineer building reliable APIs.",
        "skills": ["Python", "FastAPI"],
    },
}


def test_french_letter_uses_only_matching_strengths():
    letter = generate_cover_letter(
        CV,
        "Nous recherchons Python, FastAPI et Kubernetes.",
        job_title="Ingénieur backend",
        company="ACME",
        language="fr",
    )
    assert "ACME" in letter
    assert "Python" in letter
    assert "Kubernetes" not in letter
    assert letter.endswith("Ada Lovelace")


def test_english_letter():
    letter = generate_cover_letter(
        CV,
        "We need a Python API engineer.",
        job_title="Backend Engineer",
        company="ACME",
        language="en",
    )
    assert "Dear Hiring Team" in letter
    assert "Backend Engineer" in letter
