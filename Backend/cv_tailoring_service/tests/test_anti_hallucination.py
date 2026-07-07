from app.anti_hallucination import verify, factual_entities

ORIGINAL = {
    "name": "Ada", "profile": {"experience": [{"company": "ACME", "duration": "2020-2022", "description": "Built 3 services"}], "skills": ["Python"]},
    "education": ["BSc Computer Science 2019"],
}

def test_clean_reformulation_passes():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Engineered 3 services"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is True
    assert v.invented_entities == []

def test_invented_company_is_flagged():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "Google", "duration": "2020-2022", "description": "x"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is False
    assert any("google" in e.lower() for e in v.invented_entities)

def test_invented_year_is_flagged():
    tailored = {"summary": "s", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2025-2030", "description": "x"}], "skills": ["Python"], "education": ["BSc Computer Science 2019"], "changes_applied": []}
    v = verify(ORIGINAL, tailored)
    assert v.passed is False


def test_word_present_in_original_not_flagged_when_tagged_only_in_prose():
    # Regression: en_core_web_sm tags "DevOps" as an entity in prose but not in
    # the flattened skill list. Token-coverage must treat it as present.
    cv = {"name": "Ada", "profile": {"skills": ["DevOps", "Docker"], "experience": []}, "education": []}
    tailored = {"summary": "Expert DevOps specialist working with Docker daily.",
                "experiences": [], "skills": ["DevOps", "Docker"], "education": [], "changes_applied": []}
    v = verify(cv, tailored)
    assert v.passed is True
    assert v.invented_entities == []


def test_lowercase_french_noise_not_flagged():
    # Regression: French words ("un", "ainsi qu'en") were mis-tagged and rejected.
    cv = {"name": "Jean", "profile": {"skills": ["Python"],
          "experience": [{"company": "Talan", "duration": "2023", "description": "Developpeur"}]}, "education": []}
    tailored = {"summary": "Developpeur ainsi que responsable, un vrai atout pour l equipe.",
                "experiences": [{"title": "Dev", "company": "Talan", "duration": "2023", "description": "y"}],
                "skills": ["Python"], "education": [], "changes_applied": []}
    v = verify(cv, tailored)
    assert v.passed is True


def test_invented_capitalized_company_in_prose_is_flagged():
    # Real inventions (a new capitalized org in prose) must still be caught.
    cv = {"name": "Ada", "profile": {"skills": ["Python"],
          "experience": [{"company": "ACME", "duration": "2020", "description": "work"}]}, "education": []}
    tailored = {"summary": "Led a team at Google to ship the platform.",
                "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020", "description": "x"}],
                "skills": ["Python"], "education": [], "changes_applied": []}
    v = verify(cv, tailored)
    assert v.passed is False
    assert any("google" in e.lower() for e in v.invented_entities)
