import copy
import re
import uuid

# The 12 built-in Reactive Resume templates — confirmed against the running
# v4.4.6 instance's own frontend bundle (a Zod enum literal), not guessed:
# each is a distinct rendered layout, applied server-side at PDF export time.
RXRESUME_TEMPLATES = (
    "azurill", "bronzor", "chikorita", "ditto", "gengar", "glalie",
    "kakuna", "leafish", "nosepass", "onyx", "pikachu", "rhyhorn",
)

# The base skeleton ships a harsh default red (#dc2626). We instead pick a
# professional accent per template so the generated PDF's colour tracks the
# preview thumbnail the candidate sees in the picker (e.g. Gengar's preview is
# blue-teal, not red). Curated & readable on white; refined from each template
# sample's dominant accent. Unknown/no template → the NextHire app teal.
DEFAULT_ACCENT = "#0f5c5a"
TEMPLATE_ACCENTS = {
    "azurill": "#b45309",   # amber
    "bronzor": "#0d9488",   # teal
    "chikorita": "#047857", # green
    "ditto": "#0e7490",     # cyan
    "gengar": "#2f6f92",    # blue-teal (matches its preview)
    "glalie": "#3f4c6b",    # slate blue
    "kakuna": "#8a5a2b",    # warm brown
    "leafish": "#0f766e",   # teal-green
    "nosepass": "#a3502f",  # terracotta
    "onyx": "#be123c",      # rose
    "pikachu": "#b7791f",   # gold
    "rhyhorn": "#334155",   # slate (the neutral default template)
}

# Skills are grouped into a few labelled categories rendered as keyword pills,
# instead of one tall single-column list of one-line items. Ordered: the first
# matching category wins (Frontend before Langages so "javascript" lands in
# Frontend while "java" stays a language). Anything unmatched → "Autres".
_SKILL_GROUPS = (
    ("Frontend", ("react", "angular", "vue", "svelte", "next.js", "nextjs", "nuxt",
                  "redux", "tailwind", "bootstrap", "html", "css", "sass", "scss",
                  "jquery", "javascript", "typescript")),
    ("Backend", ("node.js", "node", "express.js", "express", "nestjs", "django",
                 "flask", "fastapi", "laravel", "symfony", "spring", "spring boot",
                 ".net", "asp.net", "rails", "php")),
    ("Langages", ("python", "java", "c++", "c#", "kotlin", "swift", "go", "golang",
                  "rust", "scala", "dart", "perl")),
    ("Bases de données", ("mongodb", "postgresql", "postgres", "mysql", "mariadb",
                          "sqlite", "redis", "oracle", "sql server", "mssql",
                          "cassandra", "dynamodb", "firebase", "sql", "nosql")),
    ("DevOps & Outils", ("docker", "kubernetes", "k8s", "git", "gitlab", "github",
                         "bitbucket", "jenkins", "ci/cd", "cicd", "sonarqube", "aws",
                         "azure", "gcp", "terraform", "ansible", "linux", "nginx",
                         "apache", "jira", "postman", "figma", "webpack", "vite",
                         "graphql", "rest", "microservices")),
)
_OTHER_SKILLS = "Autres compétences"


def _id() -> str:
    # Reactive Resume item ids must match ^[0-9a-z]+$ (Cuid2-like); a plain
    # hex uuid satisfies that.
    return uuid.uuid4().hex


def _html(text: str) -> str:
    text = (text or "").strip()
    return f"<p>{text}</p>" if text else ""


def _required(value: str, fallback: str) -> str:
    # A handful of Reactive Resume fields (company, institution, language
    # name) have minLength: 1 — never send an empty string for those.
    value = (value or "").strip()
    return value if value else fallback


# Confirmed against a live v4.4.6 instance (POST /api/resume + GET
# /api/resume/schema): item required fields are
#   experience: visible, company(minLength 1), position, location, date, summary, url
#   education:  visible, institution(minLength 1), studyType, area, score, date, summary, url
#   skills:     visible, name, description
#   languages:  visible, name(minLength 1), description

def _experience_item(exp: dict) -> dict:
    return {
        "id": _id(),
        "visible": True,
        "company": _required(exp.get("company", ""), "Entreprise"),
        "position": exp.get("title", ""),
        "location": "",
        "date": exp.get("duration", ""),
        "summary": _html(exp.get("description", "")),
        "url": {"label": "", "href": ""},
    }


def _education_item(line: str) -> dict:
    return {
        "id": _id(),
        "visible": True,
        "institution": _required(line, "Formation"),
        "studyType": "",
        "area": "",
        "score": "",
        "date": "",
        "summary": "",
        "url": {"label": "", "href": ""},
    }


def _match_group(skill: str) -> str | None:
    s = (skill or "").strip().lower()
    if not s:
        return None
    for cat, kws in _SKILL_GROUPS:
        for kw in kws:
            if s == kw:
                return cat
            # whole-token match: kw bounded by non-alphanumerics in the skill
            # so "java" never matches "javascript" and "node" matches "node.js".
            if re.search(r"(^|[^a-z0-9])" + re.escape(kw) + r"([^a-z0-9]|$)", s):
                return cat
    return None


def _grouped_skill_items(skills: list) -> list:
    order = [c for c, _ in _SKILL_GROUPS] + [_OTHER_SKILLS]
    buckets: dict[str, list] = {c: [] for c in order}
    for sk in skills or []:
        name = (sk or "").strip()
        if not name:
            continue
        buckets[_match_group(name) or _OTHER_SKILLS].append(name)
    items = []
    for cat in order:
        vals = buckets[cat]
        if not vals:
            continue
        items.append({
            "id": _id(), "visible": True, "name": cat,
            "description": "", "level": 0, "keywords": vals,
        })
    return items


def _language_item(name: str) -> dict:
    return {"id": _id(), "visible": True, "name": _required(name, "—"), "description": "", "level": 0}


def to_rxresume_data(cv_json: dict, tailored: dict, base_data: dict, template: str | None = None) -> dict:
    data = copy.deepcopy(base_data)
    profile = cv_json.get("profile", {}) or {}

    if template:
        if template not in RXRESUME_TEMPLATES:
            raise ValueError(f"Unknown Reactive Resume template '{template}'. Valid: {', '.join(RXRESUME_TEMPLATES)}")
        data.setdefault("metadata", {})["template"] = template

    # Replace the base skeleton's harsh default red with a professional accent
    # that matches the chosen template's preview (Gengar → blue-teal, etc.).
    accent = TEMPLATE_ACCENTS.get(template, DEFAULT_ACCENT)
    data.setdefault("metadata", {}).setdefault("theme", {})
    data["metadata"]["theme"]["primary"] = accent

    data["basics"]["name"] = cv_json.get("name", "")
    data["basics"]["email"] = cv_json.get("email", "")
    data["basics"]["phone"] = cv_json.get("phone", "")
    headline = cv_json.get("domain", "")
    if not headline and tailored.get("experiences"):
        headline = tailored["experiences"][0].get("title", "")
    data["basics"]["headline"] = headline

    # summary is its own top-level section (sections.summary.content), not a
    # top-level `data.summary` key.
    data["sections"]["summary"]["content"] = _html(tailored.get("summary", ""))

    data["sections"]["experience"]["items"] = [_experience_item(e) for e in tailored.get("experiences", [])]
    data["sections"]["education"]["items"] = [_education_item(x) for x in tailored.get("education", [])]
    data["sections"]["skills"]["items"] = _grouped_skill_items(tailored.get("skills", []))
    data["sections"]["languages"]["items"] = [_language_item(l) for l in profile.get("languages", [])]

    return data
