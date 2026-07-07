import json
import time
import httpx
from app.config import get_settings
from app.schema import TailoredCv

SYSTEM_PROMPT = (
    "Tu es un assistant de reformulation de CV bilingue (francais / anglais). On te donne un CV "
    "au format JSON et la liste des exigences cles d'une offre d'emploi (qui peut etre dans une "
    "langue differente du CV). Ta tache : reformuler le CV pour mieux correspondre a l'offre.\n\n"
    "REGLES STRICTES :\n"
    "1. N'ajoute AUCUNE competence, experience, diplome ou certification absente du CV original.\n"
    "2. Garde INTACTS : noms d'entreprises, dates, intitules de diplomes, chiffres et resultats.\n"
    "3. Tu peux : reformuler les descriptions, reordonner competences/experiences par pertinence, "
    "adapter le vocabulaire a celui de l'offre, mettre en avant ce qui correspond.\n"
    "4. LANGUE DE SORTIE : redige TOUT le CV reformule (resume, descriptions...) dans la langue "
    "cible indiquee explicitement dans le message. C'est la langue du CV original. N'utilise "
    "JAMAIS la langue de l'offre pour rediger si elle differe de la langue cible. Les termes "
    "techniques (React, Docker, CI/CD...) restent tels quels.\n"
    "5. Reponds UNIQUEMENT en JSON conforme au schema fourni, sans texte autour."
)

# French-specific signals used to pick the output language deterministically,
# so a differently-languaged job description can't drag an English CV into
# French (or vice-versa). Diacritics are the strongest signal.
_FR_ACCENTS = "àâäéèêëïîôöùûüçœ"
_FR_WORDS = (" et ", " des ", " une ", " avec ", " pour ", " les ", " du ", " aux ",
             " dans ", " en ", " est ", " sur ", " au ", " par ", " qui ", " ses ")
_EN_WORDS = (" the ", " and ", " with ", " for ", " of ", " to ", " in ", " built ",
             " set ", " on ", " as ", " using ", " developed ", " a ", " an ", " was ")


def detect_language(cv_json: dict) -> str:
    """Return 'fr' or 'en' for the CV's own language (defaults to 'fr')."""
    p = cv_json.get("profile", {}) or {}
    parts = [str(p.get("shortDescription", "")), str(p.get("resume", "")),
             str(cv_json.get("domain", ""))]
    for e in (p.get("experience") or []):
        parts.append(str(e.get("description", "")))
        parts.append(str(e.get("title", "")))
    text = (" " + " ".join(parts) + " ").lower()
    if not text.strip():
        return "fr"
    fr = 2 * sum(text.count(c) for c in _FR_ACCENTS) + sum(text.count(w) for w in _FR_WORDS)
    en = sum(text.count(w) for w in _EN_WORDS)
    return "en" if en > fr else "fr"

TAILORED_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "experiences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "company": {"type": "string"},
                    "duration": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["title", "company", "duration", "description"],
                "additionalProperties": False,
            },
        },
        "skills": {"type": "array", "items": {"type": "string"}},
        "education": {"type": "array", "items": {"type": "string"}},
        "changes_applied": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "experiences", "skills", "education", "changes_applied"],
    "additionalProperties": False,
}


class LlmError(RuntimeError):
    pass


class LlmRateLimited(LlmError):
    pass


def _compact_cv(cv_json: dict) -> dict:
    # Trim the prompt payload so a large CV stays within Groq's per-minute token
    # budget and the strict-schema generation stays reliable. Drops tail skills
    # (usually parse noise) and caps long experience descriptions.
    cv = dict(cv_json)
    p = dict(cv.get("profile", {}) or {})
    p["skills"] = (p.get("skills") or [])[:45]
    exps = []
    for e in (p.get("experience") or [])[:8]:
        e = dict(e)
        desc = e.get("description", "") or ""
        if len(desc) > 500:
            e["description"] = desc[:500]
        exps.append(e)
    p["experience"] = exps
    cv["profile"] = p
    return cv


def _user_message(cv_json: dict, keywords: list[str], extra_instruction: str) -> str:
    lang = detect_language(cv_json)
    lang_label = "FRANCAIS" if lang == "fr" else "ANGLAIS (ENGLISH)"
    return (
        f"LANGUE CIBLE DE SORTIE : {lang_label}. Redige TOUT le CV reformule dans cette langue, "
        "meme si l'offre est dans une autre langue.\n\n"
        "EXIGENCES CLES DE L'OFFRE (mots-cles):\n" + ", ".join(keywords) + "\n\n"
        "CV ORIGINAL (JSON):\n" + json.dumps(_compact_cv(cv_json), ensure_ascii=False)
        + (("\n\nCONTRAINTE SUPPLEMENTAIRE:\n" + extra_instruction) if extra_instruction else "")
        + f"\n\nRAPPEL : la sortie doit etre integralement en {lang_label}."
    )


def tailor_cv(cv_json: dict, keywords: list[str], extra_instruction: str = "") -> TailoredCv:
    s = get_settings()
    payload = {
        "model": s.groq_model,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_message(cv_json, keywords, extra_instruction)},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "tailored_cv", "strict": True, "schema": TAILORED_JSON_SCHEMA},
        },
    }
    headers = {"Authorization": f"Bearer {s.groq_api_key}", "Content-Type": "application/json"}
    last_err = None
    rate_limited = False
    # gpt-oss strict-schema generation is occasionally truncated (400), and the
    # free tier rate-limits (429); both are transient, so retry with backoff.
    for attempt in range(3):
        try:
            resp = httpx.post(f"{s.groq_base_url}/chat/completions", json=payload, headers=headers, timeout=90)
            if resp.status_code == 429:
                rate_limited = True
                last_err = f"rate limited (429): {resp.text[:200]}"
                time.sleep(3 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                last_err = f"status {resp.status_code}: {resp.text[:200]}"
                time.sleep(1)
                continue
            content = resp.json()["choices"][0]["message"]["content"]
            return TailoredCv.model_validate_json(content)
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
            last_err = str(e)
            time.sleep(1)
    if rate_limited:
        raise LlmRateLimited(
            "Limite de requêtes du modèle atteinte (quota gratuit). Patientez une minute puis réessayez."
        )
    raise LlmError(f"Groq request failed after retries: {last_err}")
