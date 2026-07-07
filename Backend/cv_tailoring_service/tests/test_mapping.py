import json, os
from app.mapping import to_rxresume_data

BASE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "rxresume_base.json"), encoding="utf-8"))

CV = {"name": "Ada Lovelace", "email": "ada@x.io", "phone": "+216 20", "domain": "Software",
      "profile": {"languages": ["English", "French"], "skills": ["Python"]}}
TAILORED = {"summary": "Great engineer", "skills": ["Python", "SQL"],
            "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Built APIs"}],
            "education": ["BSc CS, Univ Tunis, 2019"], "changes_applied": []}

def test_basics_populated():
    data = to_rxresume_data(CV, TAILORED, BASE)
    assert data["basics"]["name"] == "Ada Lovelace"
    assert data["basics"]["email"] == "ada@x.io"
    # summary is its own top-level section (sections.summary.content), not a
    # top-level `data.summary` key — confirmed against the live v4.4.6 schema.
    assert data["sections"]["summary"]["content"]  # non-empty
    assert "Great engineer" in data["sections"]["summary"]["content"]

def test_sections_items_counts():
    data = to_rxresume_data(CV, TAILORED, BASE)
    assert len(data["sections"]["experience"]["items"]) == 1
    assert len(data["sections"]["education"]["items"]) == 1
    # skills are grouped into labelled categories: Python → Langages, SQL →
    # Bases de données → 2 category items (not 2 one-line skills).
    assert len(data["sections"]["skills"]["items"]) == 2
    assert len(data["sections"]["languages"]["items"]) == 2


def test_skills_grouped_into_categories_with_keywords():
    cv = {"name": "X", "profile": {"languages": [], "skills": []}}
    tailored = {"summary": "s", "changes_applied": [], "experiences": [], "education": [],
                "skills": ["React", "Angular", "JavaScript", "Node.js", "Express.js",
                           "Django", "Python", "Java", "C++", "MongoDB", "PostgreSQL",
                           "Docker", "GitLab", "SonarQube"]}
    items = to_rxresume_data(cv, tailored, BASE)["sections"]["skills"]["items"]
    groups = {it["name"]: it["keywords"] for it in items}
    assert groups["Frontend"] == ["React", "Angular", "JavaScript"]
    assert "Node.js" in groups["Backend"] and "Django" in groups["Backend"]
    # "javascript" must land in Frontend, while "java" stays a language.
    assert "Java" in groups["Langages"] and "C++" in groups["Langages"]
    assert "JavaScript" not in groups["Langages"]
    assert "MongoDB" in groups["Bases de données"]
    assert "Docker" in groups["DevOps & Outils"]
    # every skill is preserved (nothing dropped)
    assert sum(len(v) for v in groups.values()) == 14


def test_unknown_skill_goes_to_autres():
    cv = {"name": "X", "profile": {"languages": [], "skills": []}}
    tailored = {"summary": "s", "changes_applied": [], "experiences": [], "education": [],
                "skills": ["Leadership", "Python"]}
    items = to_rxresume_data(cv, tailored, BASE)["sections"]["skills"]["items"]
    groups = {it["name"]: it["keywords"] for it in items}
    assert groups["Autres compétences"] == ["Leadership"]
    assert groups["Langages"] == ["Python"]


def test_template_accent_overrides_default_red():
    # base ships #dc2626; Gengar's preview is blue-teal — the output must not
    # keep the red default.
    data = to_rxresume_data(CV, TAILORED, BASE, template="gengar")
    assert data["metadata"]["theme"]["primary"] == "#2f6f92"
    # no template → the NextHire app teal, still never the harsh red
    data2 = to_rxresume_data(CV, TAILORED, BASE)
    assert data2["metadata"]["theme"]["primary"] == "#0f5c5a"
    assert BASE["metadata"]["theme"]["primary"] == "#dc2626"  # base untouched

def test_does_not_mutate_base():
    to_rxresume_data(CV, TAILORED, BASE)
    assert BASE["sections"]["experience"]["items"] == []

def test_experience_item_has_company_and_date():
    data = to_rxresume_data(CV, TAILORED, BASE)
    item = data["sections"]["experience"]["items"][0]
    assert item["company"] == "ACME"
    assert item["date"] == "2020-2022"

def test_never_emits_empty_required_strings():
    # Reactive Resume requires minLength 1 on company/institution/language
    # name — an empty value here would be rejected by the live instance.
    cv = {"name": "Ada", "profile": {"languages": [""], "skills": []},
          "education": []}
    tailored = {"summary": "s", "skills": [],
                "experiences": [{"title": "Dev", "company": "", "duration": "", "description": ""}],
                "education": [""], "changes_applied": []}
    data = to_rxresume_data(cv, tailored, BASE)
    assert data["sections"]["experience"]["items"][0]["company"]
    assert data["sections"]["education"]["items"][0]["institution"]
    assert data["sections"]["languages"]["items"][0]["name"]

def test_template_override_applied():
    from app.mapping import RXRESUME_TEMPLATES
    for tmpl in ("onyx", "pikachu"):
        data = to_rxresume_data(CV, TAILORED, BASE, template=tmpl)
        assert data["metadata"]["template"] == tmpl
    assert "onyx" in RXRESUME_TEMPLATES

def test_no_template_leaves_base_default():
    data = to_rxresume_data(CV, TAILORED, BASE)
    assert data["metadata"]["template"] == BASE["metadata"]["template"]

def test_invalid_template_raises():
    import pytest
    with pytest.raises(ValueError):
        to_rxresume_data(CV, TAILORED, BASE, template="not-a-real-template")
