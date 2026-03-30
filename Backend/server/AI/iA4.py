import os
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
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
print(f"🔍 PaddleOCR available: {'✅ Yes' if PaddleOCR is not None else '❌ Not installed'}")

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

def extract_experience(text):
    experience = []
    lines = split_lines(text)
    current_exp = {}
    capture = False

    section_stop_re = re.compile(
        r'^(education|formation|skills|comp[ée]tences|certification|projects|projets|languages|langues|interests|centres\s+d[\'’]int[ée]r[êe]t)\b',
        re.IGNORECASE,
    )

    def _is_experience_heading(line_text):
        return bool(re.search(r'^\s*(experience|work history|professional experience|emploi|exp[ée]rience)\b', line_text, re.IGNORECASE))

    def _clean_experience_line(line_text):
        cleaned = re.sub(r'^[•\-–*∗\s]+', '', line_text or '').strip()
        cleaned = re.sub(r'\s{2,}', ' ', cleaned)
        return cleaned

    for line in lines:
        if _is_experience_heading(line):
            capture = True
            continue

        if capture:
            if section_stop_re.search(line.strip()):
                break

            exp_match = re.search(r'^(.*?)\s*[-–|]\s*(.*?)\s*[-–|]\s*(.*)$', line)
            if exp_match:
                if current_exp:
                    experience.append(current_exp)
                current_exp = {
                    'company': exp_match.group(1).strip(),
                    'title': exp_match.group(2).strip(),
                    'duration': exp_match.group(3).strip(),
                    'description': []
                }

                continue

            cleaned_line = _clean_experience_line(line)
            if not cleaned_line:
                continue

            # Keep free-form experience content exactly, even when the CV does not
            # follow company-title-duration formatting.
            if not current_exp:
                current_exp = {
                    'company': '',
                    'title': 'Experience',
                    'duration': '',
                    'description': []
                }

            if current_exp.get('description') and re.match(r'^\s+', line):
                current_exp['description'][-1] += ' ' + cleaned_line
            else:
                current_exp.setdefault('description', []).append(cleaned_line)

    if current_exp:
        experience.append(current_exp)

    project_lines = extract_section_lines(
        lines,
        start_patterns=[r'projects', r'projets', r'projets académiques', r'academic projects'],
        stop_patterns=[r'education', r'formation', r'skills', r'languages', r'certification', r'interests']
    )
    project_entries = []
    current_project = None
    for raw_line in project_lines:
        line = raw_line.strip()
        if re.match(r'^[\-–]', line):
            if current_project:
                project_entries.append(current_project)

            header = re.sub(r'^[\-–\s]+', '', line)
            duration_match = re.search(r'((?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|present|présent|\d{4})[^\n]{0,25}(?:\d{4}|present|présent))$', header, re.IGNORECASE)
            duration = duration_match.group(1).strip() if duration_match else ''
            title = header.replace(duration, '').strip(' -|:')
            title = re.sub(r'\bintitul[ée]\s*:\s*', '', title, flags=re.IGNORECASE).strip('"')
            current_project = {
                'company': '',
                'title': title if title else 'Academic Project',
                'duration': duration,
                'description': []
            }
            continue

        if not current_project:
            continue
        if re.search(r'^technologies\s+utilis[ée]es?\s*:', line, re.IGNORECASE):
            continue
        if len(line) >= 20:
            current_project['description'].append(re.sub(r'^[\*∗\-–\s]+', '', line).strip())

    if current_project:
        project_entries.append(current_project)

    for project in project_entries[:6]:
        if project['description']:
            project['description'] = project['description'][:3]
        experience.append(project)

    return experience

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
        candidates.extend([token.strip() for token in re.split(r'[,/|;]', normalized_line) if token.strip()])

    for token in candidates:
        cleaned = re.sub(r'[^a-zA-Z0-9\+#\.\- ]', '', token).strip()
        word_count = len(cleaned.split())
        if re.search(r'(avanc|langue\s+maternelle|membre|responsable|gestion|tunis|tunisie|fran[cç]ais|anglais|arabe)', cleaned, re.IGNORECASE):
            continue
        if 2 <= len(cleaned) <= 30 and word_count <= 3 and not re.match(r'^(skills?|compétences?)$', cleaned, re.IGNORECASE):
            skills.add(normalize_skill_label(cleaned))

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

def extract_text_from_pdf(file_path):
    text_native = ''
    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_native += page_text + '\n'
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
                "description": ' '.join(exp.get('description', []))
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
