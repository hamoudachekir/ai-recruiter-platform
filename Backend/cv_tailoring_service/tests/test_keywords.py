from app.keywords import extract_keywords

def test_includes_explicit_skills_first():
    job = {"title": "Data Engineer", "description": "airflow spark kafka pipelines", "skills": ["Airflow", "Spark"]}
    kws = extract_keywords(job, top_k=10)
    assert "Airflow" in kws and "Spark" in kws
    # explicit skills come before tfidf-only terms
    assert kws.index("Airflow") < len(job["skills"]) + 0.5 * len(kws)

def test_extracts_terms_from_description_when_no_skills():
    job = {"title": "", "description": "kubernetes kubernetes docker terraform", "skills": []}
    kws = [k.lower() for k in extract_keywords(job, top_k=5)]
    assert "kubernetes" in kws

def test_no_crash_on_empty_job():
    assert extract_keywords({}, top_k=5) == []
