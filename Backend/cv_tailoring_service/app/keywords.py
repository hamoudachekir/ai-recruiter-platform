from sklearn.feature_extraction.text import TfidfVectorizer
from app.db import job_to_text


def _dedupe_preserve(seq):
    seen, out = set(), []
    for s in seq:
        key = s.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(s.strip())
    return out


def extract_keywords(job: dict, top_k: int = 20) -> list[str]:
    explicit = list(job.get("skills", []) or [])
    text = job_to_text(job)
    tfidf_terms = []
    if text.strip():
        try:
            vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=200)
            matrix = vec.fit_transform([text])
            scores = matrix.toarray()[0]
            names = vec.get_feature_names_out()
            ranked = sorted(zip(names, scores), key=lambda x: x[1], reverse=True)
            tfidf_terms = [name for name, score in ranked if score > 0]
        except ValueError:
            tfidf_terms = []
    return _dedupe_preserve(explicit + tfidf_terms)[:top_k]
