import re

from app.schema import Verification

try:
    import spacy
except ImportError:
    spacy = None

try:
    _nlp = spacy.load("en_core_web_sm", disable=["lemmatizer"]) if spacy else None
except OSError:
    _nlp = None

_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
_NUM_RE = re.compile(r"\b\d+(?:[.,]\d+)?%?\b")
_DEGREE_RE = re.compile(
    r"\b(bsc|msc|ph\.?d|b\.?a|m\.?a|bac|licence|master|ingenieur|engineer|doctorat|mba|dut|bts)\b",
    re.IGNORECASE,
)
_STOP_ENT = {"", "cv", "resume"}
_PROPER_CONTEXT_RE = re.compile(
    r"\b(?:at|chez|for|pour|with|avec)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})"
)


def _norm(tok: str) -> str:
    return re.sub(r"[^\w%]+", " ", tok, flags=re.UNICODE).strip().lower()


def _is_proper_noun(text: str) -> bool:
    # A real company/place name is a short run of Title/UPPER-case words
    # ("Google", "SmartConseil", "Amazon Web Services"). The English model
    # mis-tags lowercase French phrases ("utilisation de MongoDB", "suivi de la
    # qualité avec") as ORG; requiring EVERY alphabetic word to start uppercase
    # (and at most 4 words) rejects that noise while keeping real names.
    words = [w for w in text.split() if w[:1].isalpha()]
    return bool(words) and len(words) <= 4 and all(w[0].isupper() for w in words)


def factual_entities(text: str) -> set[str]:
    if not text:
        return set()
    ents: set[str] = set()
    if _nlp is not None:
        doc = _nlp(text)
        for ent in doc.ents:
            # Only genuine proper-noun organisations/places. Spelled-out numbers and
            # dates are handled language-agnostically by the regexes below.
            if ent.label_ in {"ORG", "GPE", "FAC", "PRODUCT"} and _is_proper_noun(ent.text):
                n = _norm(ent.text)
                if len(n) >= 3 and n not in _STOP_ENT:
                    ents.add(n)
    else:
        # Keep the guard useful in lightweight installations where spaCy or its
        # English model is unavailable. Context words avoid treating every
        # sentence-initial capitalised word as a company.
        for match in _PROPER_CONTEXT_RE.finditer(text):
            n = _norm(match.group(1))
            if len(n) >= 3 and n not in _STOP_ENT:
                ents.add(n)
    for m in _YEAR_RE.finditer(text):
        ents.add(m.group(0))
    for m in _NUM_RE.finditer(text):
        ents.add(_norm(m.group(0)))
    for m in _DEGREE_RE.finditer(text):
        ents.add(_norm(m.group(0)))
    return {e for e in ents if e and e not in _STOP_ENT}


def _cv_text(cv: dict) -> str:
    profile = cv.get("profile", {}) or {}
    parts = [cv.get("name", ""), cv.get("domain", ""), profile.get("resume", ""), profile.get("shortDescription", "")]
    parts += list(profile.get("skills", []) or [])
    parts += list(profile.get("languages", []) or [])
    parts += list(cv.get("education", []) or [])
    for exp in profile.get("experience", []) or []:
        parts += [exp.get("title", ""), exp.get("company", ""), exp.get("duration", ""), exp.get("description", "")]
    return "\n".join(str(p) for p in parts if p)


def _tailored_text(tailored: dict) -> str:
    parts = [tailored.get("summary", "")]
    parts += list(tailored.get("skills", []) or [])
    parts += list(tailored.get("education", []) or [])
    for exp in tailored.get("experiences", []) or []:
        parts += [exp.get("title", ""), exp.get("company", ""), exp.get("duration", ""), exp.get("description", "")]
    return "\n".join(str(p) for p in parts if p)


def _structured_orgs(experiences) -> set[str]:
    # Company names live in structured `company` fields and must stay intact.
    # Compare them directly — spaCy's en_core_web_sm does NOT reliably tag an
    # ORG in bare newline-joined field fragments (no sentence context).
    orgs = set()
    for exp in experiences or []:
        n = _norm((exp or {}).get("company", ""))
        if n and n not in _STOP_ENT:
            orgs.add(n)
    return orgs


def original_entities(cv: dict) -> set[str]:
    profile = cv.get("profile", {}) or {}
    return factual_entities(_cv_text(cv)) | _structured_orgs(profile.get("experience", []))


def tailored_entities(tailored: dict) -> set[str]:
    return factual_entities(_tailored_text(tailored)) | _structured_orgs(tailored.get("experiences", []))


# Alphanumeric runs kept together so mixed tokens like "ResNet50" match as one.
_TOKEN_RE = re.compile(r"[0-9A-Za-zÀ-ſ]+", re.UNICODE)


def _token_set(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN_RE.findall(text or "")}


def original_tokens(cv: dict) -> set[str]:
    # Every word/number token present ANYWHERE in the original CV. Comparing
    # tailored entities against this (rather than against the recognised-entity
    # set) avoids false positives from spaCy tagging a word as an entity in the
    # reformulated prose but not in the flattened original (e.g. "DevOps"), and
    # from language mismatches (e.g. French "un" tagged CARDINAL).
    toks = _token_set(_cv_text(cv))
    for org in _structured_orgs((cv.get("profile", {}) or {}).get("experience", [])):
        toks.update(org.split())
    return toks


def _entity_covered(entity: str, tokens: set[str]) -> bool:
    parts = entity.split()
    return all(p in tokens for p in parts) if parts else True


def verify(cv: dict, tailored: dict, retried: bool = False) -> Verification:
    tokens = original_tokens(cv)
    invented = sorted(e for e in tailored_entities(tailored) if not _entity_covered(e, tokens))
    return Verification(passed=len(invented) == 0, invented_entities=invented, retried=retried)
