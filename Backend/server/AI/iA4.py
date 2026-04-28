import os
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
# Paddle/PaddleOCR on Windows can fail with protobuf>=4 C++ descriptors.
# Force Python implementation for compatibility in this service process.
os.environ.setdefault('PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION', 'python')
import re
import numpy as np
import spacy
import pdfplumber   
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from flask import Flask, request, jsonify
from werkzeug.utils import secure_filename
from flask_cors import CORS

try:
    import fitz
except Exception:
    fitz = None

try:
    from paddleocr import PaddleOCR
except Exception as _paddle_err:
    print(f"❌ PaddleOCR import failed: {_paddle_err}")
    PaddleOCR = None

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Uploads folder
UPLOAD_FOLDER = 'uploads/'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTENSIONS = {'.pdf', '.png', '.jpg', '.jpeg'}

# Load spaCy model
nlp = spacy.load("en_core_web_sm")
ocr_engine = None
if PaddleOCR is not None:
    print("🔍 PaddleOCR available: ✅ Yes")
else:
    print("🔍 PaddleOCR available: ❌ Unavailable (import/runtime dependency issue)")

# Load skills from file
def load_skill_keywords():
    path = os.path.join(os.path.dirname(__file__), "skills_list.txt")
    if not os.path.exists(path):
        print("⚠️ Warning: skills_list.txt not found.")
        return []
    with open(path, 'r', encoding='utf-8') as f:
        return [line.strip().lower() for line in f if line.strip()]

skill_keywords = load_skill_keywords()

CV_KEYWORDS = [
    'resume', 'cv', 'curriculum vitae', 'profile', 'summary',
    'experience', 'professional experience', 'work history',
    'education', 'formation', 'skills', 'competencies', 'languages',
    'certification', 'projects', 'internship'
]

SKILL_FORMAT_MAP = {
    'aws': 'AWS',
    'gcp': 'GCP',
    'sql': 'SQL',
    'mysql': 'MySQL',
    'postgresql': 'PostgreSQL',
    'mongodb': 'MongoDB',
    'javascript': 'JavaScript',
    'typescript': 'TypeScript',
    'nodejs': 'Node.js',
    'node js': 'Node.js',
    '.net': '.NET',
    'asp.netcore': 'ASP.NET Core',
    'asp.net core': 'ASP.NET Core',
    'react': 'React',
    'react.js': 'React.js',
    'c++': 'C++',
    'c#': 'C#',
    'php': 'PHP',
    'html': 'HTML',
    'css': 'CSS',
    'api': 'API',
    'docker': 'Docker',
    'figma': 'Figma',
}

DOMAIN_KEYWORDS = {
    "Artificial Intelligence / Machine Learning": [
        "machine learning", "deep learning", "neural network", "tensorflow", "pytorch", "keras",
        "scikit-learn", "nlp", "natural language processing", "computer vision", "reinforcement learning",
        "huggingface", "transformers", "llm", "gpt", "bert", "yolo", "opencv", "data augmentation",
        "model training", "feature engineering", "embedding", "gradient", "classification", "regression",
        "clustering", "ai", "artificial intelligence",
    ],
    "Data Science / Analytics": [
        "data science", "data analysis", "data analyst", "pandas", "numpy", "matplotlib", "seaborn",
        "tableau", "power bi", "statistics", "jupyter", "bigquery", "spark", "hadoop", "etl",
        "data warehouse", "looker", "data engineer", "data pipeline", "a/b testing", "business intelligence",
    ],
    "Software Development": [
        "javascript", "typescript", "python", "java", "c#", "c++", "react", "angular", "vue",
        "node.js", "express", "django", "flask", "spring", "asp.net", "rest api", "microservices",
        "git", "software engineer", "developer", "backend", "frontend", "full stack",
        "android", "ios", "flutter", "react native", "mobile development", "api", "graphql",
    ],
    "DevOps / Cloud": [
        "docker", "kubernetes", "aws", "azure", "gcp", "ci/cd", "jenkins", "terraform", "ansible",
        "linux", "devops", "cloud", "infrastructure", "nginx", "prometheus", "grafana",
        "github actions", "gitlab ci", "serverless", "helm", "monitoring",
    ],
    "Cybersecurity": [
        "cybersecurity", "penetration testing", "ethical hacking", "firewall", "siem", "soc",
        "vulnerability", "cryptography", "network security", "kali linux", "wireshark",
        "metasploit", "owasp", "incident response", "security audit", "blue team", "red team",
    ],
    "Finance / Accounting": [
        "finance", "accounting", "audit", "financial analysis", "budget", "treasury", "banking",
        "investment", "tax", "balance sheet", "sap", "erp", "financial reporting", "cpa", "cfa",
        "comptabilité", "contrôle de gestion", "bilan", "trésorerie", "analyse financière",
    ],
    "Marketing / Communication": [
        "marketing", "digital marketing", "seo", "social media", "content", "advertising",
        "brand", "campaign", "google analytics", "email marketing", "copywriting",
        "communication", "public relations", "growth hacking", "crm", "hubspot", "e-commerce",
    ],
    "Human Resources": [
        "human resources", "hr", "recruitment", "talent acquisition", "payroll", "training",
        "performance management", "employee relations", "onboarding", "compensation", "hris",
        "ressources humaines", "recrutement", "gestion des talents", "formation",
    ],
    "Design / UX-UI": [
        "figma", "adobe", "photoshop", "illustrator", "ux", "ui", "wireframe", "prototype",
        "user experience", "user interface", "sketch", "invision", "graphic design",
        "motion design", "zeplin", "after effects",
    ],
    "Project Management": [
        "project management", "pmp", "agile", "scrum", "jira", "confluence", "waterfall",
        "risk management", "stakeholder", "gantt", "product manager", "product owner", "kanban",
        "gestion de projet", "chef de projet",
    ],
}


def detect_domain(text, skills):
    """Score each domain by keyword hits in the full CV text + skills list."""
    combined = compact_text(text + ' ' + ' '.join(skills)).lower()
    scores = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        score = sum(1 for kw in keywords if re.search(rf'\b{re.escape(kw)}\b', combined))
        if score > 0:
            scores[domain] = score

    if not scores:
        return "General / Other"

    sorted_domains = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    # Return primary domain; append secondary if score is close
    primary_domain, primary_score = sorted_domains[0]
    if len(sorted_domains) > 1:
        secondary_domain, secondary_score = sorted_domains[1]
        if secondary_score >= primary_score * 0.7:
            return f"{primary_domain} / {secondary_domain}"
    return primary_domain


CV_TRAIN_SAMPLES = [
    ("John Doe resume email john@example.com phone +21655123456 skills python react sql education bachelor experience software engineer", 1),
    ("curriculum vitae profile summary experience at company education master degree skills docker aws python", 1),
    ("cv mohamed ali contact mohamed@mail.com phone 22334455 languages french english arabic projects internship", 1),
    ("resume professional experience developer 2019 2024 education university certifications scrum skills java spring", 1),
    ("profil candidat formation experience competences langues email telephone", 1),
    ("work history education skills certifications profile software engineer full time", 1),
    ("invoice number 459 total amount due payment method client address tax vat", 0),
    ("restaurant menu starters main course dessert drinks prices", 0),
    ("medical prescription patient dosage treatment diagnosis hospital", 0),
    ("bank statement account transactions balance credit debit reference", 0),
    ("wedding invitation date venue RSVP ceremony dinner", 0),
    ("shipping label tracking code sender receiver parcel weight", 0),
]

# Helper cleaning
def clean_text(text):
    text = text.replace('\r', '\n').replace('\t', ' ')
    text = re.sub(r'\(cid:\d+\)', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s*[@§•●■♦]+\s*', ' ', text)
    text = re.sub(r'[^\S\n]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)

    lines = []
    for raw_line in text.split('\n'):
        line = raw_line.strip(' -•|')
        line = re.sub(r'\s{2,}', ' ', line).strip()
        if line:
            lines.append(line)
    return '\n'.join(lines).strip()

def compact_text(text):
    return re.sub(r'\s+', ' ', text).strip()

def split_lines(text):
    return [line.strip() for line in text.split('\n') if line.strip()]

def extract_section_lines(lines, start_patterns, stop_patterns):
    section = []
    in_section = False
    for line in lines:
        line_lower = line.lower()
        if any(re.search(pattern, line_lower) for pattern in start_patterns):
            in_section = True
            continue
        if in_section and any(re.search(pattern, line_lower) for pattern in stop_patterns):
            break
        if in_section:
            section.append(line)
    return section

def normalize_skill_label(skill):
    normalized = skill.strip().lower()
    if not normalized:
        return ''
    if normalized in SKILL_FORMAT_MAP:
        return SKILL_FORMAT_MAP[normalized]
    if len(normalized) <= 4 and normalized.isalpha():
        return normalized.upper()
    return normalized.capitalize()

def strip_contact_noise(line):
    line = re.sub(r'https?://\S+|www\.\S+|\b\S+\.com/\S*', '', line, flags=re.IGNORECASE)
    line = re.sub(r'\S+@\S+', '', line)
    line = re.sub(r'\+\d[\d\s\-]{6,}', '', line)
    line = re.sub(r'\s{2,}', ' ', line)
    return line.strip(' -•|#')

def build_cv_classifier():
    texts = [sample[0] for sample in CV_TRAIN_SAMPLES]
    labels = [sample[1] for sample in CV_TRAIN_SAMPLES]
    classifier = Pipeline([
        ('tfidf', TfidfVectorizer(ngram_range=(1, 2), lowercase=True)),
        ('clf', LogisticRegression(max_iter=500, class_weight='balanced', random_state=42)),
    ], memory=None)
    classifier.fit(texts, labels)
    return classifier

try:
    cv_classifier = build_cv_classifier()
except Exception as model_error:
    print(f"⚠️ CV classifier init failed: {model_error}")
    cv_classifier = None

def get_ocr_engine():
    global ocr_engine
    if PaddleOCR is None:
        raise RuntimeError("PaddleOCR is not installed")
    if ocr_engine is None:
        try:
            ocr_engine = PaddleOCR(use_textline_orientation=True, lang='en')
            print("✅ PaddleOCR initialized (use_textline_orientation)")
        except Exception:
            try:
                ocr_engine = PaddleOCR(use_angle_cls=True, lang='en')
                print("✅ PaddleOCR initialized (use_angle_cls fallback)")
            except Exception as e:
                raise RuntimeError(f"PaddleOCR initialization failed: {e}")
    return ocr_engine

def is_text_sufficient(text):
    if not text:
        return False
    words = re.findall(r'\w+', text)
    return len(text.strip()) >= 120 and len(words) >= 20

def ocr_from_image_array(image_array):
    engine = get_ocr_engine()
    lines = []

    try:
        result = engine.ocr(image_array, cls=True)
        if result:
            for block in result:
                if not block:
                    continue
                for item in block:
                    if len(item) >= 2 and item[1] and len(item[1]) >= 1:
                        lines.append(item[1][0])
    except Exception:
        try:
            result = engine.predict(image_array)
            for item in result or []:
                if isinstance(item, dict):
                    rec_texts = item.get('rec_texts')
                    if rec_texts:
                        lines.extend([text for text in rec_texts if text])
        except Exception:
            return ''

    return clean_text('\n'.join(lines))

# Extractors
def extract_name(text):
    lines = split_lines(text)
    for line in lines[:5]:
        cleaned = strip_contact_noise(line)
        cleaned = re.sub(r'\b\+?\d[\d\s\-]{6,}\b', '', cleaned).strip()
        if cleaned.istitle() and not any(word.lower() in ['cv', 'resume'] for word in cleaned.split()):
            return cleaned
    return None

def extract_email(text):
    match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', text)
    return match.group(0) if match else None

def extract_phone(text):
    match = re.search(r'(\+?\d{1,3})?[\s\-]?\(?\d{2,4}\)?[\s\-]?\d{3}[\s\-]?\d{3,4}', text)
    if match:
        phone = re.sub(r'\D', '', match.group(0))
        return '+' + phone if not phone.startswith('+') else phone
    return None

def extract_education(text):
    education = []
    lines = split_lines(text)
    education_lines = extract_section_lines(
        lines,
        start_patterns=[r'education', r'formation', r'academic background', r'études'],
        stop_patterns=[r'experience', r'expérience', r'work history', r'skills', r'certification', r'projects', r'languages', r'langues']
    )
    for line in education_lines:
        if line:
            education.append(line)
    return education

# Date patterns used in CV experience sections (English + French)
_DATE_RE = re.compile(
    "(?:"
    "(?:jan(?:uary|vier)?|feb(?:ruary|rier)?|mar(?:ch|s)?|apr(?:il)?|avr(?:il)?"
    "|may|mai|jun(?:e)?|juin|jul(?:y)?|juil(?:let)?|aug(?:ust)?|ao[u\u00fb]t"
    "|sep(?:tember|t(?:embre)?)?|oct(?:ober|obre)?|nov(?:ember|embre)?|dec(?:ember|embre)?)"
    r"[\s.,-]*\d{2,4}"
    "|(?:present|pr[e\u00e9]sent|aujourd.hui|current|ongoing|maintenant)"
    r"|\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}"
    r"|\d{4}\s*[-\u2013]\s*(?:\d{4}|pr[e\u00e9]sent|present|current|aujourd.hui|ongoing)"
    r"|\d{4}"
    ")",
    re.IGNORECASE,
)

_SECTION_EXPERIENCE_RE = re.compile(
    (
        r"^\s*(exp[e\u00e9]riences?\s*professionnelles?|exp[e\u00e9]riences?|"
        r"parcours\s*professionnel|professional\s+experience|"
        r"work\s+(?:experience|history)|emplois?|"
        r"exp[e\u00e9]riences?\s+(?:professionnelles?|de\s+travail)?|"
        r"stages?\s+(?:professionnels?)?|stages?|internships?|"
        r"postes?\s+occup[e\u00e9]s?|historique\s+professionnel|"
        r"activit[e\u00e9]s?\s+professionnelles?)\s*$"
    ),
    re.IGNORECASE,
)

# Matches the second line of split headers like "EXPÉRIENCES" / "PROFESSIONNELLES"
_SECTION_EXPERIENCE_CONT_RE = re.compile(
    r"^\s*professionnelles?\s*$", re.IGNORECASE
)

_SECTION_STOP_RE = re.compile(
    (
        r"^\s*(education|formation|[e\u00e9]tudes|parcours\s+acad[e\u00e9]mique|"
        r"skills?|comp[e\u00e9]tences?|certifications?|projets?\s+acad[e\u00e9]miques?|"
        r"projets?\s+personnels?|projects?|langues?|languages?|interests?|loisirs|"
        r"centres?\s+d.int[e\u00e9]r[e\u00ea]ts?|publications?|r[e\u00e9]f[e\u00e9]rences?|"
        r"distinctions?|r[e\u00e9]compenses?|prix|awards?|volunteering?|b[e\u00e9]n[e\u00e9]volat)\s*$"
    ),
    re.IGNORECASE,
)

_PROJECT_SECTION_RE = re.compile(
    r"^\s*(projets?\s*(?:acad[e\u00e9]miques?|personnels?)?|academic\s+projects?|projects?)\s*$",
    re.IGNORECASE,
)


def _extract_duration_from_line(line):
    """Return (duration_str, line_without_duration) from a line."""
    dates = _DATE_RE.findall(line)
    if not dates:
        return "", line

    # Build a duration string from the found date tokens
    duration = " - ".join(d.strip() for d in dates if d.strip())

    # Remove the date parts from the line to get the rest
    remainder = _DATE_RE.sub("", line)
    remainder = re.sub(r"[\s\-\u2013|]+$", "", remainder.strip()).strip(" -\u2013|:")
    return duration, remainder


def _is_title_line(line):
    """Heuristic: does this line look like a job title or role?"""
    title_keywords = (
        "ing[e\u00e9]nieur|engineer|d[e\u00e9]veloppeur|developer|analyste|analyst|"
        "consultant|manager|chef\\s+de\\s+projet|architecte|architect|"
        "stagiaire|intern|alternant|apprenti|stage|full.?stack|backend|frontend|"
        "devops|data\\s+(?:scientist|engineer|analyst)|responsable|designer|"
        "lead|senior|junior|mid.?level|technicien|technician|scrum\\s+master|"
        "product\\s+owner|cto|ceo|coo|directeur|director|coordinateur|coordinator"
    )
    return bool(re.search(title_keywords, line, re.IGNORECASE))


def _clean_exp_line(line):
    return re.sub(r"^[^\S\n]*[^\w\s]?[^\S\n]*", "", (line or "").lstrip(" \t\r\u2022\u2013\u2014*\u2023\u25b8\u25aa")).strip()


def extract_experience(text):
    lines = split_lines(text)
    experience = []

    # ── 1. Locate section boundaries ─────────────────────────────────────────
    # Handles headers split across two lines, e.g. "EXPÉRIENCES" / "PROFESSIONNELLES"
    exp_start = None
    exp_end = len(lines)
    project_start = None
    project_end = len(lines)
    prev_was_exp_trigger = False   # True after seeing "EXPÉRIENCES" alone

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Two-line header: previous line was "EXPÉRIENCES", this is "PROFESSIONNELLES"
        if prev_was_exp_trigger and _SECTION_EXPERIENCE_CONT_RE.match(stripped):
            prev_was_exp_trigger = False
            continue   # skip the continuation line; exp_start already set

        prev_was_exp_trigger = False

        if exp_start is None and _SECTION_EXPERIENCE_RE.match(stripped):
            exp_start = i + 1
            # If this matched "EXPÉRIENCES" alone, the next line might be "PROFESSIONNELLES"
            if re.match(r"^\s*exp[e\u00e9]riences?\s*$", stripped, re.IGNORECASE):
                prev_was_exp_trigger = True
            continue

        if exp_start is not None and exp_end == len(lines) and _SECTION_STOP_RE.match(stripped):
            exp_end = i

        if _PROJECT_SECTION_RE.match(stripped):
            project_start = i + 1
            project_end = len(lines)
            continue

        if project_start is not None and project_end == len(lines) and _SECTION_STOP_RE.match(stripped) and i > project_start:
            project_end = i

    exp_lines   = lines[exp_start:exp_end]     if exp_start   is not None else []
    proj_lines  = lines[project_start:project_end] if project_start is not None else []

    # ── 2. Parse experience entries ───────────────────────────────────────────
    def flush(entry, result):
        if entry.get("title") or entry.get("company"):
            desc = entry.get("description", [])
            entry["description"] = " ".join(desc) if isinstance(desc, list) else desc
            result.append(entry)

    def new_entry(title="", company="", duration=""):
        return {"title": title, "company": company, "duration": duration, "description": []}

    # Regex: remainder after stripping dates is just a city / short location
    _LOCATION_RE = re.compile(
        r"^[A-Z\u00C0-\u017E][a-z\u00C0-\u017E]+(?:[\s\-][A-Z\u00C0-\u017E][a-z\u00C0-\u017E]+)?$"
    )

    current = {}
    for line in exp_lines:
        stripped = line.strip()
        if not stripped:
            continue

        cleaned = stripped.lstrip("-\u2013\u2014\u2022*\u25b8\u25aa ").strip()
        if not cleaned:
            continue

        # Skip "Stack : ..." lines (tech stack summary) — move to description
        # We keep them as description, not a new entry trigger.

        # ── A. Pipe / en-dash separated WITH dates: new entry header ──────────
        # e.g. "Full-Stack Dev | Talan | Juil 2024 – Présent"
        parts_pipe = re.split(r"\s*[|\u2013]\s*", cleaned)
        if len(parts_pipe) >= 2:
            dates_in_line = _DATE_RE.findall(cleaned)
            if dates_in_line:
                flush(current, experience)
                duration = " - ".join(d.strip() for d in dates_in_line if d.strip())
                non_date = [p for p in parts_pipe if not _DATE_RE.fullmatch(p.strip())]
                title   = non_date[0].strip() if non_date else ""
                company = non_date[1].strip() if len(non_date) > 1 else ""
                current = new_entry(title, company, duration)
                continue
            else:
                # ── B. Em-dash separated WITHOUT dates: company — sub-dept ──
                # e.g. "SmartConseil — Dafe Management"
                if current.get("title") and not current.get("company"):
                    current["company"] = cleaned
                    continue

        # ── C. Pure date range line ───────────────────────────────────────────
        if _DATE_RE.fullmatch(cleaned) or re.match(
            r"^\d{4}\s*[-\u2013]\s*(\d{4}|present|pr[e\u00e9]sent|current|ongoing|aujourd.hui)$",
            cleaned, re.IGNORECASE
        ):
            if current and not current.get("duration"):
                current["duration"] = cleaned
            continue

        # ── D. Line containing a date ─────────────────────────────────────────
        date_matches = list(_DATE_RE.finditer(cleaned))
        if date_matches:
            duration, remainder = _extract_duration_from_line(cleaned)
            remainder = remainder.strip()

            # Date + city/location only → belongs to the CURRENT entry
            is_location = (
                not remainder
                or (len(remainder) <= 25 and not _is_title_line(remainder) and _LOCATION_RE.match(remainder))
            )
            if is_location:
                if current and not current.get("duration"):
                    current["duration"] = duration
                continue

            # Date + substantial text → new entry header
            if remainder and len(remainder) >= 3:
                flush(current, experience)
                at_split = re.split(r"\s+(?:at|chez|pour|within)\s+", remainder, maxsplit=1, flags=re.IGNORECASE)
                if len(at_split) == 2:
                    current = new_entry(at_split[0].strip(), at_split[1].strip(), duration)
                elif _is_title_line(remainder):
                    current = new_entry(remainder, "", duration)
                else:
                    current = new_entry("", remainder, duration)
                continue
            elif current and not current.get("duration"):
                current["duration"] = duration
                continue

        # ── E. Title line — starts a new entry ───────────────────────────────
        if _is_title_line(cleaned):
            if not current:
                current = new_entry(cleaned)
                continue
            if not current.get("title"):
                current["title"] = cleaned
                continue
            # Already have a complete entry header — flush and start fresh
            if current.get("title") and current.get("company"):
                flush(current, experience)
                current = new_entry(cleaned)
                continue

        # ── F. Company line ───────────────────────────────────────────────────
        if current.get("title") and not current.get("company"):
            # Accept any reasonably short non-title line as company name
            if len(cleaned.split()) <= 7 and not cleaned.startswith("Stack"):
                current["company"] = cleaned
                continue

        # ── G. Description / tech-stack line ─────────────────────────────────
        if current:
            current.setdefault("description", []).append(cleaned)

    flush(current, experience)

    # ── 3. Parse projects section ─────────────────────────────────────────────
    current_proj = None
    project_entries = []

    for line in proj_lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Project header: starts with bullet/dash OR short line with no date yet
        is_proj_header = re.match(r"^[-\u2013\u2014\u25b8\u25aa]", stripped) or (
            len(stripped) < 90
            and not re.search(r"^(stack|technologies|tech)\s*:", stripped, re.IGNORECASE)
            and current_proj is None
        )
        if is_proj_header:
            if current_proj:
                project_entries.append(current_proj)
            header = stripped.lstrip("-\u2013\u2014\u25b8\u25aa ").strip()
            duration, remainder = _extract_duration_from_line(header)
            title = re.sub(r"\bintitul[e\u00e9]\s*:\s*", "", remainder, flags=re.IGNORECASE).strip(" \"")
            current_proj = new_entry(title or "Project", "", duration)
            continue

        if not current_proj:
            continue
        if re.search(r"^(stack|technologies)\s*:", stripped, re.IGNORECASE):
            continue
        cleaned_p = stripped.lstrip("-\u2013\u2022* ").strip()
        if len(cleaned_p) >= 15:
            current_proj["description"].append(cleaned_p)

    if current_proj:
        project_entries.append(current_proj)

    for proj in project_entries[:6]:
        desc = proj.get("description", [])
        proj["description"] = " ".join(desc[:3]) if isinstance(desc, list) else desc
        experience.append(proj)

    # ── 4. Deduplicate ────────────────────────────────────────────────────────
    seen = set()
    unique = []
    for e in experience:
        key = (e.get("title", ""), e.get("company", ""), e.get("duration", ""))
        if key not in seen:
            seen.add(key)
            unique.append(e)

    return unique

NON_SKILL_WORDS = {
    # Generic French words that leak from CV text
    'activit', 'activite', 'activites', 'analyses', 'alertes', 'badges', 'bilan',
    'burndown', 'cardio', 'challenges', 'classements', 'conception', 'courant',
    'crbrales', 'crud', 'dashboards', 'dons', 'donnes', 'ducatives', 'vnements',
    'evenements', 'fc', 'forums', 'franais', 'francais', 'gestion', 'issues',
    'langues', 'lifestyle', 'membre', 'mthodo', 'methodo', 'multi', 'passerelles',
    'platform', 'profils', 'projet', 'projets', 'ressources', 'revues', 'rles',
    'roles', 'score', 'screening', 'scurit', 'securite', 'sommeil', 'sprints',
    'suivi', 'techniques', 'tunis', 'tunisie', 'uml', 'utilisateurs', 'virement',
    'vnements', 'admin', 'administration', 'introduction', 'stage', 'formation',
    # Generic English words
    'platform', 'user', 'users', 'data', 'management', 'system', 'service',
    'application', 'module', 'interface', 'online', 'basic', 'various', 'advanced',
    'level', 'design', 'implementation', 'integration', 'development', 'stories',
    'adventure', 'academic', 'lifestyle', 'other', 'general', 'core', 'custom',
    'auth', 'authentication',
}

# Known valid short/uppercase skills that must not be filtered
KNOWN_SHORT_SKILLS = {
    'aws', 'gcp', 'sql', 'css', 'html', 'php', 'git', 'api', 'ios', 'c#', 'c++',
    'r', 'go', 'ui', 'ux', 'jwt', 'ci', 'cd', 'vue', 'xml', 'json', 'rest', 'orm',
    'jira', 'java', 'seo', 'sem', 'etl', 'bi', 'nlp', 'erp', 'crm', 'sdk', 'ide',
    't5',
}


def _is_valid_skill_token(token):
    """Return True if the token looks like a genuine skill name."""
    # Strip trailing punctuation and whitespace
    cleaned = re.sub(r'[^\w\+#\.\-\s]', '', token).strip()
    cleaned = re.sub(r'\s{2,}', ' ', cleaned)

    if not cleaned:
        return False

    token_lower = cleaned.lower()

    # Reject tokens that start with a digit or year-like pattern
    if re.match(r'^\d', cleaned):
        return False

    # Reject tokens that contain a 4-digit year (e.g. "Z 2023 react")
    if re.search(r'\b(19|20)\d{2}\b', cleaned):
        return False

    # Reject tokens ending with a period that look like sentences
    if cleaned.endswith('.') and len(cleaned) > 10:
        return False

    word_count = len(cleaned.split())

    # Short-known skills are always fine
    if token_lower in KNOWN_SHORT_SKILLS:
        return True

    # Single characters that are not known skills → reject
    if len(cleaned) <= 1:
        return False

    # Two-char tokens: only accept known acronyms
    if len(cleaned) == 2 and token_lower not in KNOWN_SHORT_SKILLS:
        return False

    # Reject from blacklist
    if token_lower in NON_SKILL_WORDS:
        return False

    # Reject words that look like broken-encoding French
    # (consonant-heavy, no proper vowel structure, e.g. "Crbrales", "Mthodo")
    vowels = set('aeiouáàâäéèêëíìîïóòôöúùûüæœ')
    letters_only = re.sub(r'[^a-zA-ZÀ-ÿ]', '', cleaned)
    if len(letters_only) >= 5:
        vowel_ratio = sum(1 for ch in letters_only.lower() if ch in vowels) / len(letters_only)
        if vowel_ratio < 0.2:
            return False

    # Reject phrases longer than 3 words (unless they are known multi-word skills)
    if word_count > 3:
        return False

    # Reject generic section/sentence words
    if re.search(
        r'\b(langue\s+maternelle|membre|responsable|gestion|tunis|tunisie|fran[cç]ais|anglais|arabe'
        r'|avanc|courant|bilingue|natif|natale|profil|candidat|projet acadmique'
        r'|user\s+stories|revues?\s+de\s+sprint|suivi\s+des|analyses?\s+d)\b',
        token_lower,
        re.IGNORECASE,
    ):
        return False

    # Must be at least 2 chars after cleaning
    if len(cleaned) < 2:
        return False

    return True


def extract_skills(text):
    skills = set()
    text_lower = compact_text(text).lower()
    for skill in skill_keywords:
        if re.search(rf'\b{re.escape(skill)}\b', text_lower):
            skills.add(normalize_skill_label(skill))

    lines = split_lines(text)
    skill_lines = extract_section_lines(
        lines,
        start_patterns=[r'skills', r'technical skills', r'compétences', r'competences'],
        stop_patterns=[r'experience', r'education', r'formation', r'projects', r'languages']
    )

    candidates = []
    for line in skill_lines:
        normalized_line = re.sub(
            r'^(langage\s+de\s+programation|langages?|base\s+de\s+donn[ée]es\s+et\s+sgbd|frameworks?|outils\s+de\s+d[ée]veloppement|technologies\s+utilis[ée]es?|comp[ée]tences)\s*:\s*',
            '',
            line,
            flags=re.IGNORECASE
        )
        candidates.extend([token.strip() for token in re.split(r'[,/|;·•]', normalized_line) if token.strip()])

    for token in candidates:
        cleaned = re.sub(r'[^a-zA-Z0-9\+#\.\-\s]', '', token).strip()
        if not _is_valid_skill_token(cleaned):
            continue
        label = normalize_skill_label(cleaned)
        if label.lower() not in NON_SKILL_WORDS:
            skills.add(label)

    return sorted(skills)

def extract_languages(text):
    language_map = {
        "english": "English", "anglais": "English",
        "french": "French", "français": "French",
        "spanish": "Spanish", "español": "Spanish",
        "arabic": "Arabic", "arabe": "Arabic",
        "german": "German", "deutsch": "German",
        "italian": "Italian", "italiano": "Italian",
    }
    languages = set()
    text_lower = compact_text(text).lower()
    for lang_key, lang_value in language_map.items():
        if re.search(rf'\b{re.escape(lang_key)}\b', text_lower):
            languages.add(lang_value)
    return sorted(languages)

def extract_summary(text):
    lines = split_lines(text)
    summary_lines = extract_section_lines(
        lines,
        start_patterns=[r'summary', r'about\s+me', r'profile', r'profil', r'personal\s+profile'],
        stop_patterns=[r'experience', r'education', r'skills', r'languages', r'projects']
    )
    summary = ' '.join(summary_lines).strip()
    return compact_text(summary) if summary else None

def extract_short_description(text):
    summary = extract_summary(text)
    if summary:
        return summary[:240]

    lines = split_lines(text)
    top_lines = [strip_contact_noise(line) for line in lines[:10]]
    top_lines = [line for line in top_lines if line]

    title_keywords = r'(developpeur|développeur|engineer|ing[ée]nieur|data|full\s*stack|backend|frontend|mobile|software|web)'
    top_title = next((line for line in top_lines if re.search(title_keywords, line, re.IGNORECASE) and len(line) <= 90), None)

    first_exp_line = None
    in_experience = False
    for line in lines:
        if re.search(r'experience|expérience|work history|professional experience|emploi', line, re.IGNORECASE):
            in_experience = True
            continue
        if in_experience:
            cleaned_line = strip_contact_noise(re.sub(r'^[\-–\*∗\s]+', '', line))
            if cleaned_line and not re.search(r'^technologies\s+utilis[ée]es?\s*:', cleaned_line, re.IGNORECASE):
                first_exp_line = re.sub(r'\s{2,}', ' ', cleaned_line)
                break

    if top_title and first_exp_line:
        return compact_text(f"{top_title}. {first_exp_line}")[:240]
    if top_title:
        return compact_text(top_title)[:240]

    filtered_lines = []
    for line in lines[:25]:
        cleaned_line = strip_contact_noise(line)
        if not cleaned_line:
            continue
        if re.search(r'@(?!\s)|\+\d|tunis|tunisia|linkedin|github|cid:\d+', cleaned_line, re.IGNORECASE):
            continue
        if len(cleaned_line) < 20:
            continue
        if re.search(r'^(education|formation|skills|languages|langues|projects|experience|contact)\b', cleaned_line, re.IGNORECASE):
            continue
        filtered_lines.append(cleaned_line)

    if filtered_lines:
        return compact_text(' '.join(filtered_lines[:2]))[:240]

    sentences = [s.strip() for s in re.split(r'[\.\n]+', text) if s.strip()]
    cleaned = [
        s for s in sentences
        if len(s) > 25 and not re.search(r'^(experience|education|skills|languages|projects|contact)\b', s, re.IGNORECASE)
    ]
    if not cleaned:
        return ""

    short = compact_text(' '.join(cleaned[:2]))
    return short[:240]

def looks_like_cv(text, parsed):
    model_probability = None
    if cv_classifier is not None:
        try:
            model_probability = float(cv_classifier.predict_proba([text])[0][1])
        except Exception:
            model_probability = None

    text_lower = compact_text(text).lower()
    keyword_hits = sum(1 for keyword in CV_KEYWORDS if keyword in text_lower)
    has_contact = bool(parsed.get('email') or parsed.get('phone'))
    profile = parsed.get('profile', {}) or {}
    has_structured_content = bool(
        profile.get('skills')
        or profile.get('languages')
        or profile.get('experience')
        or parsed.get('education')
    )

    heuristic_pass = (keyword_hits >= 2 and has_contact) or (has_contact and has_structured_content) or keyword_hits >= 4
    if model_probability is None:
        return heuristic_pass

    print(f"🔍 CV check → keyword_hits={keyword_hits}, has_contact={has_contact}, has_structured={has_structured_content}, prob={model_probability:.3f}")

    if has_contact and has_structured_content:
        return model_probability >= 0.40
    if has_contact or has_structured_content:
        return model_probability >= 0.55 and keyword_hits >= 1
    if keyword_hits >= 4:
        return model_probability >= 0.45
    return False

def _words_to_lines(words, y_tolerance=4):
    """Reconstruct lines from a list of pdfplumber word dicts sorted by position."""
    if not words:
        return []
    words = sorted(words, key=lambda w: (round(w["top"] / y_tolerance) * y_tolerance, w["x0"]))
    lines = []
    cur_line = []
    cur_top = None
    for w in words:
        t = round(w["top"] / y_tolerance) * y_tolerance
        if cur_top is None or abs(t - cur_top) <= y_tolerance:
            cur_line.append(w["text"])
            cur_top = t
        else:
            if cur_line:
                lines.append(" ".join(cur_line))
            cur_line = [w["text"]]
            cur_top = t
    if cur_line:
        lines.append(" ".join(cur_line))
    return lines


def _extract_page_text_column_aware(page):
    """
    Extract page text with column awareness.
    For two-column CVs, pdfplumber's default reading order mixes columns.
    This function detects the column split and reconstructs left-then-right order.
    """
    try:
        words = page.extract_words(x_tolerance=3, y_tolerance=3, keep_blank_chars=False)
    except Exception:
        return page.extract_text() or ""

    if not words:
        return page.extract_text() or ""

    page_width = float(page.width)

    # Build a histogram of x0 positions to find the inter-column gap
    x0_vals = sorted(w["x0"] for w in words)
    # Find the largest gap between consecutive unique x-buckets (10pt buckets)
    buckets = sorted(set(round(x / 10) * 10 for x in x0_vals))
    col_split = page_width / 2  # default: split at centre
    if len(buckets) > 3:
        gaps = [(buckets[i + 1] - buckets[i], (buckets[i] + buckets[i + 1]) / 2)
                for i in range(len(buckets) - 1)]
        # Only consider gaps in the middle 40-60% range of the page width
        mid_gaps = [(g, mid) for g, mid in gaps if 0.35 * page_width < mid < 0.65 * page_width]
        if mid_gaps:
            col_split = max(mid_gaps, key=lambda x: x[0])[1]

    left_words  = [w for w in words if w["x0"] <  col_split]
    right_words = [w for w in words if w["x0"] >= col_split]

    # Only treat as two-column if right side has substantial content
    if len(right_words) < max(5, len(left_words) * 0.15):
        # Single-column page
        return "\n".join(_words_to_lines(words))

    left_text  = "\n".join(_words_to_lines(left_words))
    right_text = "\n".join(_words_to_lines(right_words))
    # Return left column first, then right column — each section is self-contained
    return left_text + "\n" + right_text


def extract_text_from_pdf(file_path):
    text_native = ""
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                page_text = _extract_page_text_column_aware(page)
                if page_text:
                    text_native += page_text + "\n"
    except Exception as e:
        print(f"❌ Error reading PDF: {e}")

    text_native = clean_text(text_native)
    if is_text_sufficient(text_native):
        return text_native

    if fitz is None or PaddleOCR is None:
        return text_native

    try:
        doc = fitz.open(file_path)
        ocr_text_parts = []
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n > 3:
                image = image[:, :, :3]
            page_text = ocr_from_image_array(image)
            if page_text:
                ocr_text_parts.append(page_text)
        doc.close()
        ocr_text = clean_text('\n'.join(ocr_text_parts))
        return ocr_text if len(ocr_text) > len(text_native) else text_native
    except Exception as e:
        print(f"❌ Error during OCR fallback: {e}")
        return text_native

def extract_text_from_image(file_path):
    try:
        from PIL import Image
        image = Image.open(file_path).convert('RGB')
        image_array = np.array(image)
        print(f"🖼️ Image loaded: shape={image_array.shape}")
        text = ocr_from_image_array(image_array)
        print(f"📝 OCR extracted {len(text)} chars from image")
        if text:
            print(f"📝 Preview: {text[:200]}")
        return text
    except Exception as e:
        print(f"❌ Error reading image with OCR: {e}")
        return ''

def process_resume(file_path):
    extension = os.path.splitext(file_path)[1].lower()
    if extension == '.pdf':
        text = extract_text_from_pdf(file_path)
    elif extension in {'.png', '.jpg', '.jpeg'}:
        text = extract_text_from_image(file_path)
    else:
        return {'error': 'Unsupported file format'}

    if not text or len(text) < 50:
        return {'error': 'Extracted text is too short or empty'}

    skills = extract_skills(text)
    domain = detect_domain(text, skills)

    parsed = {
        "name": extract_name(text),
        "email": extract_email(text),
        "phone": extract_phone(text),
        "role": "CANDIDATE",
        "isActive": True,
        "domain": domain,
        "verificationStatus": {
            "status": "PENDING",
            "emailVerified": False
        },
        "profile": {
            "resume": extract_summary(text) or "",
            "shortDescription": extract_short_description(text),
            "skills": skills,
            "phone": extract_phone(text),
            "languages": extract_languages(text),
            "availability": "Full-time",
            "domain": domain,
            "experience": [{
                "title": exp.get('title', ''),
                "company": exp.get('company', ''),
                "duration": exp.get('duration', ''),
                "description": exp.get('description', '') if isinstance(exp.get('description'), str) else ' '.join(exp.get('description', []))
            } for exp in extract_experience(text)]
        },
        "education": extract_education(text)
    }

    if not looks_like_cv(text, parsed):
        return {'error': 'Uploaded file does not appear to be a valid CV'}

    return parsed

# Home route (for checking server)
@app.route('/', methods=['GET'])
def home():
    return "✅ Flask server running", 200

# Debug route — returns raw extracted text + experience parse for diagnosis
@app.route('/debug-cv', methods=['POST'])
def debug_cv():
    if 'resume' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files['resume']
    extension = os.path.splitext(file.filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        return jsonify({'error': 'Unsupported file type'}), 400
    filename = secure_filename(file.filename)
    file_path = os.path.join(UPLOAD_FOLDER, 'debug_' + filename)
    file.save(file_path)
    try:
        text = extract_text_from_pdf(file_path) if extension == '.pdf' else extract_text_from_image(file_path)
        lines = split_lines(text)
        experience = extract_experience(text)
        return jsonify({
            'raw_lines': lines[:80],
            'experience': experience,
            'char_count': len(text),
        })
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)

# Upload route
@app.route('/upload', methods=['POST'])
def upload_resume():
    if 'resume' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['resume']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    extension = os.path.splitext(file.filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        return jsonify({'error': 'Only PDF, PNG, JPG, and JPEG files are accepted'}), 400

    filename = secure_filename(file.filename)
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    file.save(file_path)

    try:
        extracted = process_resume(file_path)
        if isinstance(extracted, dict) and extracted.get('error'):
            return jsonify(extracted), 400
        return jsonify(extracted)
    except Exception as e:
        print(f"❌ Resume processing error: {e}")
        return jsonify({'error': f'Processing error: {str(e)}'}), 500
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)

# Start server
if __name__ == '__main__':
    app.run(debug=True, port=5002)
