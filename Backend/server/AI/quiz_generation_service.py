from flask import Flask, request, jsonify
from flask_cors import CORS
from collections import Counter, defaultdict
import json
import os
import random
import re

import requests

try:
    from dotenv import load_dotenv
except Exception:
    def load_dotenv(*args, **kwargs):
        return False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)  # Backend/server

# Try loading .env from multiple locations
env_paths = [
    os.path.join(BASE_DIR, ".env"),           # Backend/server/AI/.env
    os.path.join(PARENT_DIR, ".env"),         # Backend/server/.env
]

for env_path in env_paths:
    if os.path.exists(env_path):
        print(f"[DEBUG] Loading .env from: {env_path}")
        load_dotenv(env_path)
        break
else:
    print(f"[DEBUG] No .env file found. Checked: {env_paths}")

app = Flask(__name__)
CORS(app)

MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "").strip()
MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "ministral-8b-latest").strip()
MISTRAL_API_URL = os.getenv("MISTRAL_API_URL", "https://api.mistral.ai/v1/chat/completions").strip()
MISTRAL_TIMEOUT = int(os.getenv("MISTRAL_TIMEOUT", "30"))
QUIZ_USE_MISTRAL = os.getenv("QUIZ_USE_MISTRAL", "true").strip().lower() in {"1", "true", "yes", "on"}
QUIZ_REQUIRE_MISTRAL = os.getenv("QUIZ_REQUIRE_MISTRAL", "false").strip().lower() in {"1", "true", "yes", "on"}
QUIZ_PAGE_SIZE = max(1, int(os.getenv("QUIZ_PAGE_SIZE", "5")))
QUIZ_VARIANTS_PER_QUESTION = max(2, min(3, int(os.getenv("QUIZ_VARIANTS_PER_QUESTION", "3"))))
QUIZ_TARGET_TOTAL_SECONDS_FOR_20 = max(120, int(os.getenv("QUIZ_TARGET_TOTAL_SECONDS_FOR_20", "300")))
QUIZ_QUALITY_THRESHOLD = float(os.getenv("QUIZ_QUALITY_THRESHOLD", "4.2"))
QUIZ_JOB_ONLY_MODE = os.getenv("QUIZ_JOB_ONLY_MODE", "true").strip().lower() in {"1", "true", "yes", "on"}
# Configuration for question types to include. Comma-separated: "QCM,vrai-faux,réponse courte,mini-exercice"
QUIZ_ALLOWED_TYPES = [t.strip() for t in os.getenv("QUIZ_ALLOWED_TYPES", "QCM").split(",") if t.strip()]

# Debug output
print(f"[CONFIG] MISTRAL_API_KEY loaded: {'OK' if MISTRAL_API_KEY else 'MISSING'}")
print(f"[CONFIG] MISTRAL_MODEL: {MISTRAL_MODEL}")
print(f"[CONFIG] QUIZ_JOB_ONLY_MODE: {QUIZ_JOB_ONLY_MODE}")
print(f"[CONFIG] QUIZ_USE_MISTRAL: {QUIZ_USE_MISTRAL}")

KNOWN_AI_TOOLS = [
    "chatgpt", "gpt", "openai", "copilot", "github copilot", "cursor", "claude",
    "gemini", "mistral", "langchain", "llamaindex", "hugging face", "transformers",
    "prompt engineering", "vector database", "rag", "pinecone", "weaviate", "chroma",
    "azure openai", "vertex ai", "bedrock",
]

QUESTION_BANK = [
    {
        "title": "Que retourne une LEFT JOIN en SQL ?",
        "type": "QCM",
        "domain": "data",
        "skills": ["sql"],
        "difficulty": "facile",
        "options": [
            "Toutes les lignes de la table gauche et les correspondances de la table droite",
            "Seulement les lignes communes",
            "Toutes les lignes des deux tables",
            "Aucune ligne sans clé primaire",
        ],
        "correctAnswer": 0,
        "expectedAnswer": "Toutes les lignes de la table gauche et les correspondances de la table droite",
        "explanation": "LEFT JOIN garde toutes les lignes de la table de gauche.",
        "score": 10,
        "timeLimit": 90,
    },
    {
        "title": "Quelle clause SQL sert à filtrer après un GROUP BY ?",
        "type": "QCM",
        "domain": "data",
        "skills": ["sql"],
        "difficulty": "moyen",
        "options": ["WHERE", "HAVING", "ORDER BY", "DISTINCT"],
        "correctAnswer": 1,
        "expectedAnswer": "HAVING",
        "explanation": "HAVING s'applique après agrégation.",
        "score": 10,
        "timeLimit": 75,
    },
    {
        "title": "En Python, quel type est mutable ?",
        "type": "QCM",
        "domain": "data",
        "skills": ["python"],
        "difficulty": "facile",
        "options": ["tuple", "str", "list", "int"],
        "correctAnswer": 2,
        "expectedAnswer": "list",
        "explanation": "Les listes sont mutables.",
        "score": 10,
        "timeLimit": 60,
    },
    {
        "title": "Que fait dropna() dans Pandas ?",
        "type": "QCM",
        "domain": "data",
        "skills": ["python"],
        "difficulty": "moyen",
        "options": [
            "Supprime les lignes/colonnes avec des valeurs manquantes",
            "Remplit les valeurs manquantes",
            "Trie les données",
            "Convertit en JSON",
        ],
        "correctAnswer": 0,
        "expectedAnswer": "Supprime les lignes/colonnes avec des valeurs manquantes",
        "explanation": "dropna retire les observations incomplètes selon les paramètres.",
        "score": 10,
        "timeLimit": 90,
    },
    {
        "title": "Quel hook React sert à gérer l'état local ?",
        "type": "QCM",
        "domain": "web",
        "skills": ["react"],
        "difficulty": "facile",
        "options": ["useEffect", "useMemo", "useState", "useRef"],
        "correctAnswer": 2,
        "expectedAnswer": "useState",
        "explanation": "useState sert à stocker un état local dans un composant.",
        "score": 10,
        "timeLimit": 60,
    },
    {
        "title": "Vrai ou Faux: useEffect sans tableau de dépendances s'exécute après chaque rendu.",
        "type": "vrai-faux",
        "domain": "web",
        "skills": ["react"],
        "difficulty": "moyen",
        "options": ["Vrai", "Faux", "", ""],
        "correctAnswer": 0,
        "expectedAnswer": "Vrai",
        "explanation": "Sans dépendances, l'effet s'exécute après chaque rendu.",
        "score": 10,
        "timeLimit": 50,
    },
    {
        "title": "Quel visuel est le plus adapté pour comparer des catégories ?",
        "type": "QCM",
        "domain": "data visualization",
        "skills": ["power bi", "data visualization"],
        "difficulty": "facile",
        "options": ["Bar chart", "Pie chart", "Scatter", "Heatmap"],
        "correctAnswer": 0,
        "expectedAnswer": "Bar chart",
        "explanation": "Le bar chart est souvent le plus lisible pour comparer des catégories.",
        "score": 10,
        "timeLimit": 60,
    },
    {
        "title": "Mini-exercice: Propose une KPI de suivi du pipeline commercial.",
        "type": "mini-exercice",
        "domain": "logique métier",
        "skills": ["business", "analytics"],
        "difficulty": "difficile",
        "options": ["", "", "", ""],
        "correctAnswer": 0,
        "expectedAnswer": "Ex: taux de conversion = deals gagnés / opportunités",
        "explanation": "La réponse est évaluée sur la pertinence métier de la KPI.",
        "score": 10,
        "timeLimit": 180,
    },
    {
        "title": "Quel service cloud est souvent utilisé pour déployer des conteneurs ?",
        "type": "QCM",
        "domain": "devops",
        "skills": ["docker", "kubernetes", "azure"],
        "difficulty": "moyen",
        "options": ["Git", "AKS", "Figma", "MongoDB Compass"],
        "correctAnswer": 1,
        "expectedAnswer": "AKS",
        "explanation": "AKS est un service Kubernetes managé sur Azure.",
        "score": 10,
        "timeLimit": 80,
    },
]


def normalize(items):
    if not isinstance(items, list):
        return []
    return [str(item).strip().lower() for item in items if str(item).strip()]


def extract_ai_tools_from_job(job):
    job_text = " ".join([
        str(job.get("title", "")),
        str(job.get("description", "")),
        " ".join([str(item) for item in job.get("skills", [])]) if isinstance(job.get("skills", []), list) else "",
    ]).lower()

    detected = []
    for tool in KNOWN_AI_TOOLS:
        if tool in job_text:
            detected.append(tool)

    normalized = []
    for value in detected:
        if value == "gpt":
            normalized.append("chatgpt")
        elif value == "github copilot":
            normalized.append("copilot")
        else:
            normalized.append(value)

    return sorted(dict.fromkeys(normalized))


def build_job_skill_stack(job):
    job_skills = normalize(job.get("skills", []))
    ai_tools = extract_ai_tools_from_job(job)

    ranked = []
    for skill in job_skills + ai_tools:
        if skill not in ranked:
            ranked.append(skill)

    return ranked, ai_tools


def extract_candidate_skills(candidate_profiles):
    skills = []
    for profile in candidate_profiles:
        profile_skills = profile.get("skills", []) if isinstance(profile, dict) else []
        skills.extend(normalize(profile_skills))
    return skills


def extract_candidate_domains(candidate_profiles):
    domains = []
    for profile in candidate_profiles:
        if not isinstance(profile, dict):
            continue
        profile_domain = profile.get("domain", "")
        domains.extend(normalize([profile_domain]))
    return domains


def _extract_years_from_experience_entry(entry):
    if isinstance(entry, (int, float)):
        return float(entry)

    if isinstance(entry, dict):
        for key in ("years", "durationYears", "experienceYears", "value"):
            raw = entry.get(key)
            if isinstance(raw, (int, float)):
                return float(raw)
        text = " ".join(str(value) for value in entry.values())
    else:
        text = str(entry)

    matches = re.findall(r"\d+(?:[\.,]\d+)?", text)
    if not matches:
        return None

    values = []
    for match in matches:
        try:
            values.append(float(match.replace(",", ".")))
        except Exception:
            continue
    if not values:
        return None
    return max(values)


def summarize_candidate_experience(candidate_profiles):
    years = []
    snippets = []

    for profile in candidate_profiles:
        if not isinstance(profile, dict):
            continue
        raw_experience = profile.get("experience", [])
        if isinstance(raw_experience, list):
            entries = raw_experience
        elif raw_experience:
            entries = [raw_experience]
        else:
            entries = []

        for entry in entries:
            parsed_years = _extract_years_from_experience_entry(entry)
            if parsed_years is not None:
                years.append(parsed_years)
            snippet = str(entry).strip()
            if snippet:
                snippets.append(snippet[:120])

    avg_years = round(sum(years) / len(years), 1) if years else None
    if avg_years is None:
        level = "intermediaire"
    elif avg_years < 2:
        level = "junior"
    elif avg_years < 5:
        level = "intermediaire"
    else:
        level = "senior"

    return {
        "avgYears": avg_years,
        "level": level,
        "samples": snippets[:6],
    }


def build_candidate_context(candidate_profiles):
    domains = extract_candidate_domains(candidate_profiles)
    domain_counter = Counter(domains)
    ranked_domains = [name for name, _ in domain_counter.most_common()]

    return {
        "domains": ranked_domains,
        "experience": summarize_candidate_experience(candidate_profiles),
    }


def get_difficulty_mix(total_questions):
    easy = max(1, int(total_questions * 0.4))
    medium = max(1, int(total_questions * 0.4))
    hard = max(0, total_questions - easy - medium)
    while easy + medium + hard > total_questions:
        if medium > 1:
            medium -= 1
        elif easy > 1:
            easy -= 1
        else:
            hard = max(0, hard - 1)
    while easy + medium + hard < total_questions:
        medium += 1
    return {"facile": easy, "moyen": medium, "difficile": hard}


def choose_by_skills(pool, target_skills):
    if not target_skills:
        return list(pool)
    boosted = []
    remaining = []
    skill_set = set(target_skills)
    for question in pool:
        q_skills = set(normalize(question.get("skills", [])))
        if q_skills.intersection(skill_set):
            boosted.append(question)
        else:
            remaining.append(question)
    random.shuffle(boosted)
    random.shuffle(remaining)
    return boosted + remaining


def normalize_question(question):
    raw_options = question.get("options", ["", "", "", ""])
    if not isinstance(raw_options, list):
        raw_options = [str(raw_options)]
    safe_options = [str(option) if option is not None else "" for option in raw_options][:4]
    while len(safe_options) < 4:
        safe_options.append("")

    raw_expected = question.get("expectedAnswer", "")
    if isinstance(raw_expected, list):
        expected_answer = "\n".join([str(item) for item in raw_expected if item is not None]).strip()
    elif isinstance(raw_expected, dict):
        expected_answer = json.dumps(raw_expected, ensure_ascii=False)
    elif raw_expected is None:
        expected_answer = ""
    else:
        expected_answer = str(raw_expected)

    raw_correct = question.get("correctAnswer", 0)
    try:
        normalized_correct = int(raw_correct)
    except Exception:
        normalized_correct = 0
    normalized_correct = max(0, min(3, normalized_correct))

    raw_score = question.get("score", 10)
    try:
        normalized_score = int(raw_score)
    except Exception:
        normalized_score = 10
    normalized_score = max(1, normalized_score)

    raw_time = question.get("timeLimit", 60)
    try:
        normalized_time = int(raw_time)
    except Exception:
        normalized_time = 60
    normalized_time = max(15, normalized_time)

    return {
        "title": str(question.get("title", "Question")),
        "question": str(question.get("title", question.get("question", "Question"))),
        "type": str(question.get("type", "QCM")),
        "domain": str(question.get("domain", "general")),
        "skills": [str(skill) for skill in question.get("skills", [])] if isinstance(question.get("skills", []), list) else [],
        "difficulty": str(question.get("difficulty", "moyen")),
        "options": safe_options,
        "correctAnswer": normalized_correct,
        "expectedAnswer": expected_answer,
        "explanation": str(question.get("explanation", "")),
        "score": normalized_score,
        "timeLimit": normalized_time,
    }


def _extract_json_text(raw_text):
    if not raw_text:
        return ""

    text = raw_text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, flags=re.DOTALL)
    if fence_match:
        return fence_match.group(1).strip()

    first_curly = text.find("{")
    first_square = text.find("[")
    candidates = [idx for idx in [first_curly, first_square] if idx != -1]
    if not candidates:
        return text
    start = min(candidates)
    return text[start:].strip()


def _build_generation_prompt(job, ranked_skills, total_questions, difficulty_mix):
    job_title = job.get("title", "")
    job_desc = job.get("description", "")
    job_skills = job.get("skills", [])

    return f"""
Tu es un générateur de quiz technique RH.

Contexte:
- Poste: {job_title}
- Description: {job_desc}
- Skills du poste: {job_skills}
- Skills candidats observés: {ranked_skills[:12]}

Contraintes strictes:
- Nombre total de questions: {total_questions}
- Répartition difficulté: {difficulty_mix}
- Chaque question doit contenir exactement ces champs:
  title, type, domain, skills, difficulty, options, correctAnswer, expectedAnswer, explanation, score, timeLimit
- type autorisés: QCM, vrai-faux, réponse courte, mini-exercice
- difficulty autorisés: facile, moyen, difficile
- Pour QCM: options = 4 propositions, correctAnswer entre 0 et 3
- Pour vrai-faux: options = ["Vrai", "Faux", "", ""], correctAnswer = 0 ou 1
- Pour réponse courte / mini-exercice: options = ["", "", "", ""], correctAnswer = 0

Format de sortie:
Retourne UNIQUEMENT du JSON valide, sans texte additionnel:
{{
  "questions": [ ... ]
}}
""".strip()


def _call_mistral_json(system_prompt, user_prompt, max_tokens=2200, temperature=0.3):
    headers = {
        "Authorization": f"Bearer {MISTRAL_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    last_error = None
    for attempt in range(2):
        attempt_user_prompt = user_prompt
        if attempt == 1:
            attempt_user_prompt = (
                f"{user_prompt}\n\n"
                "IMPORTANT: Return STRICT valid JSON only. "
                "No markdown, no code fences, no extra commentary."
            )

        payload = {
            "model": MISTRAL_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": attempt_user_prompt},
            ],
            "temperature": temperature if attempt == 0 else 0.2,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }

        try:
            response = requests.post(
                MISTRAL_API_URL,
                headers=headers,
                json=payload,
                timeout=MISTRAL_TIMEOUT,
            )
            response.raise_for_status()
            response_json = response.json()
            content = (
                response_json.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
            parsed_text = _extract_json_text(content)
            return json.loads(parsed_text)
        except Exception as exc:
            last_error = exc

    raise last_error


def _build_quiz_plan_prompt(job, ranked_skills, total_questions, difficulty_mix):
    job_title = job.get("title", "")
    job_desc = job.get("description", "")
    job_skills = job.get("skills", [])
    ai_tools = extract_ai_tools_from_job(job)

    return f"""
Tu dois créer un PLAN de quiz technique, pas les questions finales.

Contexte:
- Poste: {job_title}
- Description: {job_desc}
- Skills du poste: {job_skills}
- Skills à couvrir (job uniquement): {ranked_skills[:12]}
- Outils IA détectés dans le job: {ai_tools}
- totalQuestions: {total_questions}
- difficultyMix: {difficulty_mix}
- pageSize: {QUIZ_PAGE_SIZE}

Règles:
- Produis un plan découpé en pages.
- Chaque slot représente UNE question future.
- Respecte la répartition des difficultés.
- Varie les types: QCM, vrai-faux, réponse courte, mini-exercice.
- timeLimit recommandé entre 20 et 120 secondes.
- Génère uniquement selon le poste (aucune personnalisation candidat).
- Si des outils IA sont présents, inclure explicitement des slots sur ces outils.

Format JSON strict (sans texte hors JSON):
{{
  "pages": [
    {{
      "pageNumber": 1,
      "title": "Page 1",
      "slots": [
        {{
          "questionNumber": 1,
          "type": "QCM",
          "difficulty": "facile",
          "domain": "data",
          "skills": ["sql"],
          "timeLimit": 45,
          "objective": "valider les fondamentaux"
        }}
      ]
    }}
  ]
}}
""".strip()


def _default_quiz_plan(total_questions, ranked_skills, difficulty_mix):
    prioritized = ranked_skills[:10] if ranked_skills else ["problem solving", "communication", "analysis"]
    page_count = (total_questions + QUIZ_PAGE_SIZE - 1) // QUIZ_PAGE_SIZE

    difficulty_bag = (
        ["facile"] * difficulty_mix.get("facile", 0)
        + ["moyen"] * difficulty_mix.get("moyen", 0)
        + ["difficile"] * difficulty_mix.get("difficile", 0)
    )
    if len(difficulty_bag) < total_questions:
        difficulty_bag += ["moyen"] * (total_questions - len(difficulty_bag))
    difficulty_bag = difficulty_bag[:total_questions]

    # Use configured types or default to QCM-only
    type_cycle = QUIZ_ALLOWED_TYPES if QUIZ_ALLOWED_TYPES else ["QCM"]
    pages = []
    question_number = 1

    for page_index in range(page_count):
        slots = []
        for _ in range(QUIZ_PAGE_SIZE):
            if question_number > total_questions:
                break
            skill = prioritized[(question_number - 1) % len(prioritized)]
            slots.append({
                "questionNumber": question_number,
                "type": type_cycle[(question_number - 1) % len(type_cycle)],
                "difficulty": difficulty_bag[question_number - 1],
                "domain": "technique",
                "skills": [skill],
                "timeLimit": 45,
                "objective": f"Évaluer la maîtrise de {skill}",
            })
            question_number += 1

        pages.append(
            {
                "pageNumber": page_index + 1,
                "title": f"Page {page_index + 1}",
                "slots": slots,
            }
        )

    return {"pages": pages}


def _normalize_quiz_plan(plan_data, total_questions, ranked_skills, difficulty_mix):
    if not isinstance(plan_data, dict):
        return _default_quiz_plan(total_questions, ranked_skills, difficulty_mix)

    raw_pages = plan_data.get("pages", [])
    if not isinstance(raw_pages, list) or not raw_pages:
        return _default_quiz_plan(total_questions, ranked_skills, difficulty_mix)

    normalized_pages = []
    collected = []
    used_numbers = set()

    for page_index, page in enumerate(raw_pages, start=1):
        page_number = page.get("pageNumber", page_index) if isinstance(page, dict) else page_index
        page_title = page.get("title", f"Page {page_number}") if isinstance(page, dict) else f"Page {page_number}"
        raw_slots = page.get("slots", []) if isinstance(page, dict) else []
        if not isinstance(raw_slots, list):
            raw_slots = []

        slots = []
        for slot in raw_slots:
            if not isinstance(slot, dict):
                continue
            qn = slot.get("questionNumber")
            try:
                qn = int(qn)
            except Exception:
                qn = None
            if not qn or qn in used_numbers or qn < 1 or qn > total_questions:
                continue

            normalized_slot = {
                "questionNumber": qn,
                "type": str(slot.get("type", "QCM")),
                "difficulty": str(slot.get("difficulty", "moyen")),
                "domain": str(slot.get("domain", "general")),
                "skills": [str(s) for s in slot.get("skills", [])] if isinstance(slot.get("skills", []), list) else [],
                "timeLimit": int(slot.get("timeLimit", 45)) if str(slot.get("timeLimit", "45")).isdigit() else 45,
                "objective": str(slot.get("objective", "")),
            }
            slots.append(normalized_slot)
            collected.append(normalized_slot)
            used_numbers.add(qn)

        normalized_pages.append(
            {
                "pageNumber": int(page_number) if str(page_number).isdigit() else page_index,
                "title": str(page_title),
                "slots": slots,
            }
        )

    if len(collected) < total_questions:
        default_plan = _default_quiz_plan(total_questions, ranked_skills, difficulty_mix)
        for page in default_plan["pages"]:
            for slot in page["slots"]:
                qn = slot["questionNumber"]
                if qn not in used_numbers:
                    used_numbers.add(qn)
                    target_page = (qn - 1) // QUIZ_PAGE_SIZE + 1
                    while len(normalized_pages) < target_page:
                        normalized_pages.append({"pageNumber": len(normalized_pages) + 1, "title": f"Page {len(normalized_pages) + 1}", "slots": []})
                    normalized_pages[target_page - 1]["slots"].append(slot)

    for page in normalized_pages:
        page["slots"] = sorted(page.get("slots", []), key=lambda x: x.get("questionNumber", 999))

    normalized_pages = [page for page in normalized_pages if page.get("slots")]
    return {"pages": normalized_pages}


def _build_page_generation_prompt(job, page, variants_per_question):
    job_title = job.get("title", "")
    job_desc = job.get("description", "")
    slots = page.get("slots", [])
    ai_tools = extract_ai_tools_from_job(job)

    return f"""
Tu génères des questions de quiz à partir de slots prédéfinis.

Contexte job:
- title: {job_title}
- description: {job_desc}
- outils IA détectés dans le job: {ai_tools}

Slots à générer (page {page.get("pageNumber")}):
{json.dumps(slots, ensure_ascii=False)}

Règles:
- Pour chaque slot, génère exactement {variants_per_question} variantes.
- Respecte slot.type, slot.difficulty, slot.domain, slot.skills, slot.timeLimit.
- Champs obligatoires par variante:
  title, type, domain, skills, difficulty, options, correctAnswer, expectedAnswer, explanation, score, timeLimit
- QCM: 4 options non vides, correctAnswer entre 0 et 3.
- vrai-faux: options ["Vrai", "Faux", "", ""], correctAnswer 0 ou 1.
- réponse courte/mini-exercice: options ["", "", "", ""], correctAnswer 0.
- score = 1.
- Générer des questions strictement basées sur les exigences du poste.
- Si un slot mentionne un outil IA détecté, proposer une question appliquée à cet outil.

Format JSON strict:
{{
  "questions": [
    {{
      "questionNumber": 1,
      "variants": [{{...}}, {{...}}]
    }}
  ]
}}
""".strip()


def _chunk_items(items, chunk_size):
    if chunk_size <= 0:
        return [items]
    return [items[index:index + chunk_size] for index in range(0, len(items), chunk_size)]


def _tokenize_text(text):
    tokens = re.findall(r"[a-zA-Zàâäçéèêëîïôöùûüÿñæœ]{3,}", str(text or "").lower())
    stop_words = {
        "pour", "avec", "dans", "sans", "entre", "plus", "moins", "dans", "this", "that", "from",
        "what", "which", "where", "when", "comment", "quelle", "quels", "les", "des", "une", "the",
        "and", "or", "est", "sont", "sur", "par", "aux", "you", "your", "vos", "votre", "sera",
    }
    return [token for token in tokens if token not in stop_words]


def _semantic_signature(question):
    title = question.get("title", "")
    expected = question.get("expectedAnswer", "")
    domain = question.get("domain", "")
    skills = " ".join(question.get("skills", [])) if isinstance(question.get("skills", []), list) else ""
    tokens = _tokenize_text(f"{title} {expected} {domain} {skills}")
    return set(tokens)


def _semantic_similarity(sig_a, sig_b):
    if not sig_a or not sig_b:
        return 0.0
    intersection = len(sig_a.intersection(sig_b))
    union = len(sig_a.union(sig_b))
    if union == 0:
        return 0.0
    return intersection / union


def _target_total_seconds(total_questions):
    if total_questions == 20:
        return QUIZ_TARGET_TOTAL_SECONDS_FOR_20
    return max(60, int(total_questions * (QUIZ_TARGET_TOTAL_SECONDS_FOR_20 / 20)))


def _enforce_total_time_budget(questions, total_questions):
    if not questions:
        return {"target": 0, "actualBefore": 0, "actualAfter": 0}

    target = _target_total_seconds(total_questions)
    current = sum(max(10, int(q.get("timeLimit", 15))) for q in questions)

    base = max(10, target // len(questions))
    remainder = target - (base * len(questions))

    for idx, question in enumerate(questions):
        extra = 1 if idx < remainder else 0
        question["timeLimit"] = base + extra

    actual_after = sum(int(q.get("timeLimit", 0)) for q in questions)
    return {"target": target, "actualBefore": current, "actualAfter": actual_after}


def _post_validate_questions(questions, total_questions):
    safe_questions = [normalize_question(question) for question in questions if isinstance(question, dict)]

    deduped = []
    signatures = []
    duplicate_count = 0
    for question in safe_questions:
        signature = _semantic_signature(question)
        duplicate = any(_semantic_similarity(signature, existing) >= 0.82 for existing in signatures)
        if duplicate:
            duplicate_count += 1
            continue
        signatures.append(signature)
        deduped.append(question)

    allowed_difficulties = {"facile", "moyen", "difficile"}
    difficulty_fix_count = 0
    for question in deduped:
        difficulty = str(question.get("difficulty", "moyen")).lower()
        if difficulty not in allowed_difficulties:
            question["difficulty"] = "moyen"
            difficulty_fix_count += 1

    if len(deduped) < total_questions and deduped:
        synthesized = []
        synth_index = 0
        while len(deduped) + len(synthesized) < total_questions:
            base_question = deduped[synth_index % len(deduped)]
            variant_id = (synth_index // len(deduped)) + 1
            cloned = json.loads(json.dumps(base_question, ensure_ascii=False))
            base_title = str(cloned.get("title", "Question"))
            cloned["title"] = f"{base_title} (unique {variant_id})"
            cloned["question"] = cloned["title"]
            cloned["explanation"] = f"{cloned.get('explanation', '')} Variante post-validation."

            synthesized.append(cloned)

            synth_index += 1
            if synth_index > total_questions * 10:
                break

        deduped.extend(synthesized)

    time_report = _enforce_total_time_budget(deduped, total_questions)
    return deduped[:total_questions], {
        "semanticDuplicatesRemoved": duplicate_count,
        "difficultyFixCount": difficulty_fix_count,
        "timeBudget": time_report,
    }


def _collect_low_quality_slots(selected_questions_by_number, slots_by_number, candidate_context=None):
    weak = {}
    seen_signatures = []

    for qn in sorted(selected_questions_by_number.keys()):
        question = selected_questions_by_number.get(qn)
        slot = slots_by_number.get(qn, {})
        if not question:
            weak[qn] = ["missing-question"]
            continue

        reasons = []
        quality_score = _score_question_quality(question, slot, set(), candidate_context=candidate_context)
        if quality_score < QUIZ_QUALITY_THRESHOLD:
            reasons.append(f"low-quality-score:{round(quality_score, 2)}")

        if str(question.get("difficulty", "")).lower() != str(slot.get("difficulty", "")).lower():
            reasons.append("difficulty-mismatch")

        if str(question.get("type", "")).lower() != str(slot.get("type", "")).lower():
            reasons.append("type-mismatch")

        if not _is_type_compatible(question.get("type"), question.get("options", [])):
            reasons.append("type-options-incompatible")

        signature = _semantic_signature(question)
        duplicate_detected = False
        for existing in seen_signatures:
            if _semantic_similarity(signature, existing) >= 0.82:
                duplicate_detected = True
                break
        if duplicate_detected:
            reasons.append("semantic-duplicate")
        else:
            seen_signatures.append(signature)

        if reasons:
            weak[qn] = reasons

    return weak


def _regenerate_weak_slots(job, weak_slots, used_titles, candidate_context=None):
    replacements = {}
    if not weak_slots:
        return replacements

    slot_chunks = _chunk_items(weak_slots, 2)
    for chunk in slot_chunks:
        chunk_page = {
            "pageNumber": 0,
            "title": "Weak-slot-regeneration",
            "slots": chunk,
        }
        prompt = _build_page_generation_prompt(job, chunk_page, QUIZ_VARIANTS_PER_QUESTION)
        try:
            generated = _call_mistral_json(
                system_prompt="Tu régénères uniquement des questions faibles, JSON strict.",
                user_prompt=prompt,
                max_tokens=1800,
                temperature=0.35,
            )
        except Exception:
            continue

        generated_questions = generated.get("questions", []) if isinstance(generated, dict) else []
        for entry in generated_questions:
            if not isinstance(entry, dict):
                continue
            qn = entry.get("questionNumber")
            try:
                qn = int(qn)
            except Exception:
                continue

            slot = next((slot_item for slot_item in chunk if int(slot_item.get("questionNumber", -1)) == qn), None)
            if not slot:
                continue

            variants = entry.get("variants", []) if isinstance(entry.get("variants", []), list) else []
            normalized_variants = [normalize_question(variant) for variant in variants if isinstance(variant, dict)]
            if not normalized_variants:
                continue

            best_variant = None
            best_score = float("-inf")
            for variant in normalized_variants:
                score = _score_question_quality(variant, slot, used_titles, candidate_context=candidate_context)
                if score > best_score:
                    best_score = score
                    best_variant = variant

            if best_variant is None:
                continue

            best_variant["difficulty"] = str(slot.get("difficulty", best_variant.get("difficulty", "moyen")))
            best_variant["type"] = str(slot.get("type", best_variant.get("type", "QCM")))
            best_variant["domain"] = str(slot.get("domain", best_variant.get("domain", "general")))
            best_variant["skills"] = slot.get("skills", best_variant.get("skills", []))
            best_variant["timeLimit"] = int(slot.get("timeLimit", best_variant.get("timeLimit", 15)))

            title_key = str(best_variant.get("title", "")).strip().lower()
            if title_key and title_key not in used_titles:
                used_titles.add(title_key)
            replacements[qn] = best_variant

    return replacements


def _is_type_compatible(question_type, options):
    q_type = str(question_type or "QCM").lower()
    non_empty = [str(opt).strip() for opt in options if str(opt).strip()]
    if q_type == "qcm":
        return len(non_empty) >= 4
    if q_type == "vrai-faux":
        return len(non_empty) >= 2 and non_empty[0].lower() in {"vrai", "true"} and non_empty[1].lower() in {"faux", "false"}
    return len(non_empty) == 0


def _score_question_quality(question, slot, existing_titles, candidate_context=None):
    score = 0.0
    title = str(question.get("title", "")).strip()
    explanation = str(question.get("explanation", "")).strip()
    expected = str(question.get("expectedAnswer", "")).strip()
    q_type = str(question.get("type", "QCM"))
    difficulty = str(question.get("difficulty", "moyen"))
    options = question.get("options", []) if isinstance(question.get("options", []), list) else []

    if len(title) >= 15:
        score += 1.2
    if len(explanation) >= 20:
        score += 0.8
    if len(expected) >= 3:
        score += 0.6
    if difficulty == str(slot.get("difficulty", "moyen")):
        score += 1.0
    if q_type == str(slot.get("type", "QCM")):
        score += 1.0

    slot_skills = set(normalize(slot.get("skills", [])))
    q_skills = set(normalize(question.get("skills", [])))
    if slot_skills and q_skills.intersection(slot_skills):
        score += 1.0

    candidate_context = candidate_context or {}
    preferred_domains = set(normalize(candidate_context.get("domains", [])))
    q_domain = normalize([question.get("domain", "")])
    if preferred_domains and set(q_domain).intersection(preferred_domains):
        score += 0.6

    experience = candidate_context.get("experience", {}) if isinstance(candidate_context.get("experience", {}), dict) else {}
    experience_level = str(experience.get("level", "intermediaire")).lower()
    preferred_difficulties = {
        "junior": {"facile", "moyen"},
        "intermediaire": {"moyen", "difficile"},
        "senior": {"moyen", "difficile"},
    }.get(experience_level, {"moyen"})

    if difficulty.lower() in preferred_difficulties:
        score += 0.4

    if _is_type_compatible(q_type, options):
        score += 1.0

    title_key = title.lower()
    if title_key and title_key not in existing_titles:
        score += 1.0
    else:
        score -= 1.2

    return score


def _generate_with_two_step_pipeline(job, ranked_skills, total_questions, difficulty_mix, candidate_context=None):
    plan_prompt = _build_quiz_plan_prompt(job, ranked_skills, total_questions, difficulty_mix)
    plan_raw = _call_mistral_json(
        system_prompt="Tu crées des plans de quiz RH en JSON strict.",
        user_prompt=plan_prompt,
        max_tokens=1800,
        temperature=0.2,
    )
    plan = _normalize_quiz_plan(plan_raw, total_questions, ranked_skills, difficulty_mix)

    selected_questions_by_number = {}
    used_titles = set()
    page_summaries = []
    slots_by_number = {}

    for page in plan.get("pages", []):
        page_slots = page.get("slots", []) if isinstance(page.get("slots", []), list) else []
        slot_chunks = _chunk_items(page_slots, 2)
        generated_questions = []

        for slot_chunk in slot_chunks:
            chunk_page = {
                "pageNumber": page.get("pageNumber"),
                "title": page.get("title"),
                "slots": slot_chunk,
            }
            page_prompt = _build_page_generation_prompt(job, chunk_page, QUIZ_VARIANTS_PER_QUESTION)
            try:
                generated_page = _call_mistral_json(
                    system_prompt="Tu génères des questions de quiz en respectant des slots imposés, JSON strict.",
                    user_prompt=page_prompt,
                    max_tokens=1900,
                    temperature=0.4,
                )
                chunk_questions = generated_page.get("questions", []) if isinstance(generated_page, dict) else []
                if isinstance(chunk_questions, list):
                    generated_questions.extend(chunk_questions)
            except Exception:
                continue

        question_map = {}

        for entry in generated_questions:
            if not isinstance(entry, dict):
                continue
            qn = entry.get("questionNumber")
            try:
                qn = int(qn)
            except Exception:
                continue
            variants = entry.get("variants", []) if isinstance(entry.get("variants", []), list) else []
            question_map[qn] = variants

        generated_on_page = 0
        for slot in page.get("slots", []):
            qn = int(slot.get("questionNumber"))
            slots_by_number[qn] = slot
            raw_variants = question_map.get(qn, [])
            normalized_variants = [normalize_question(variant) for variant in raw_variants if isinstance(variant, dict)]

            if not normalized_variants:
                continue

            best_variant = None
            best_score = float("-inf")
            for variant in normalized_variants:
                variant_score = _score_question_quality(variant, slot, used_titles, candidate_context=candidate_context)
                if variant_score > best_score:
                    best_score = variant_score
                    best_variant = variant

            if best_variant is None:
                continue

            best_variant["difficulty"] = str(slot.get("difficulty", best_variant.get("difficulty", "moyen")))
            best_variant["type"] = str(slot.get("type", best_variant.get("type", "QCM")))
            best_variant["domain"] = str(slot.get("domain", best_variant.get("domain", "general")))
            best_variant["skills"] = slot.get("skills", best_variant.get("skills", []))
            best_variant["timeLimit"] = int(slot.get("timeLimit", best_variant.get("timeLimit", 45)))

            title_key = str(best_variant.get("title", "")).strip().lower()
            if title_key:
                used_titles.add(title_key)

            selected_questions_by_number[qn] = best_variant
            generated_on_page += 1

        page_summaries.append(
            {
                "pageNumber": page.get("pageNumber"),
                "title": page.get("title"),
                "plannedCount": len(page.get("slots", [])),
                "generatedCount": generated_on_page,
            }
        )

    weak_before = _collect_low_quality_slots(selected_questions_by_number, slots_by_number, candidate_context=candidate_context)
    weak_slots = [slots_by_number[qn] for qn in sorted(weak_before.keys()) if qn in slots_by_number]

    regenerated_replacements = _regenerate_weak_slots(job, weak_slots, used_titles, candidate_context=candidate_context)
    for qn, regenerated_question in regenerated_replacements.items():
        selected_questions_by_number[qn] = regenerated_question

    weak_after = _collect_low_quality_slots(selected_questions_by_number, slots_by_number, candidate_context=candidate_context)

    ordered_numbers = list(range(1, total_questions + 1))
    selected_questions = [selected_questions_by_number[number] for number in ordered_numbers if number in selected_questions_by_number]
    time_report = _enforce_total_time_budget(selected_questions, total_questions)

    validation_report = {
        "weakQuestionCountBefore": len(weak_before),
        "regeneratedWeakQuestionCount": len(regenerated_replacements),
        "weakQuestionCountAfter": len(weak_after),
        "weakReasonsAfter": weak_after,
        "timeBudget": time_report,
    }
    return selected_questions, plan, page_summaries, validation_report


def _call_mistral_for_questions(job, ranked_skills, total_questions, difficulty_mix, candidate_context=None):
    if not QUIZ_USE_MISTRAL:
        return None, "Mistral disabled by QUIZ_USE_MISTRAL=false"

    if not MISTRAL_API_KEY:
        return None, "Missing MISTRAL_API_KEY"

    try:
        selected_questions, plan_data, page_summaries, validation_report = _generate_with_two_step_pipeline(
            job=job,
            ranked_skills=ranked_skills,
            total_questions=total_questions,
            difficulty_mix=difficulty_mix,
            candidate_context=candidate_context,
        )
        if not selected_questions:
            return None, "Mistral returned empty questions"

        normalized = [normalize_question(question) for question in selected_questions]
        normalized = normalized[:total_questions]

        if not normalized:
            return None, "Mistral questions failed normalization"

        generation_trace = {
            "plan": plan_data,
            "pageSummaries": page_summaries,
            "variantsPerQuestion": QUIZ_VARIANTS_PER_QUESTION,
            "pageSize": QUIZ_PAGE_SIZE,
            "validation": validation_report,
        }
        return normalized, "ok", generation_trace
    except Exception as exc:
        return None, str(exc), None


def _generate_from_local_bank(total_questions, ranked_skills, difficulty_mix):
    selected = []
    used_titles = set()

    for difficulty, count in difficulty_mix.items():
        pool = [q for q in QUESTION_BANK if q.get("difficulty") == difficulty]
        pool = choose_by_skills(pool, ranked_skills)
        for question in pool:
            if len([s for s in selected if s.get("difficulty") == difficulty]) >= count:
                break
            if question["title"] in used_titles:
                continue
            selected.append(question)
            used_titles.add(question["title"])

    if len(selected) < total_questions:
        fallback_pool = choose_by_skills(QUESTION_BANK, ranked_skills)
        for question in fallback_pool:
            if len(selected) >= total_questions:
                break
            if question["title"] in used_titles:
                continue
            selected.append(question)
            used_titles.add(question["title"])

    if len(selected) < total_questions and selected:
        synthesized = []
        synth_index = 0
        base_items = list(selected)
        while len(selected) + len(synthesized) < total_questions:
            base_question = base_items[synth_index % len(base_items)]
            variant_id = (synth_index // len(base_items)) + 1
            cloned = json.loads(json.dumps(base_question, ensure_ascii=False))
            base_title = str(cloned.get("title", "Question"))
            cloned["title"] = f"{base_title} (variante {variant_id})"
            cloned["question"] = cloned["title"]
            cloned["explanation"] = f"{cloned.get('explanation', '')} Variante générée automatiquement pour compléter le quiz."

            title_key = cloned["title"]
            if title_key not in used_titles:
                used_titles.add(title_key)
                synthesized.append(cloned)
            synth_index += 1

        selected.extend(synthesized)

    selected = selected[:total_questions]
    return [normalize_question(q) for q in selected]


def _parse_question_key(value):
    try:
        parsed = int(value)
    except Exception:
        return None
    if parsed < 0:
        return None
    return parsed


def _text_token_overlap(left, right):
    left_tokens = set(_tokenize_text(left))
    right_tokens = set(_tokenize_text(right))
    if not right_tokens:
        return 0.0
    return len(left_tokens.intersection(right_tokens)) / len(right_tokens)


def _evaluate_adaptive_answer(question, submitted_answer):
    has_options = isinstance(question.get("options", []), list) and any(str(opt or "").strip() for opt in question.get("options", []))
    try:
        parsed_answer_index = int(submitted_answer)
    except Exception:
        parsed_answer_index = None

    submitted_answer_text = str(submitted_answer).strip() if isinstance(submitted_answer, str) else ""
    expected_answer_text = str(question.get("expectedAnswer", "")).strip()

    is_correct = False
    if has_options:
        is_correct = parsed_answer_index == question.get("correctAnswer")
    elif submitted_answer_text:
        if not expected_answer_text:
            is_correct = True
        else:
            is_correct = _text_token_overlap(submitted_answer_text, expected_answer_text) >= 0.45

    return {
        "isCorrect": bool(is_correct),
        "parsedAnswerIndex": parsed_answer_index,
        "submittedAnswerText": submitted_answer_text,
        "expectedAnswerText": expected_answer_text,
    }


def _summarize_adaptive_performance(questions, response_history):
    question_map = {index: question for index, question in enumerate(questions)}
    stats = {
        "totalAnswered": 0,
        "totalCorrect": 0,
        "easyAnswered": 0,
        "easyCorrect": 0,
        "easySpeedSamples": [],
        "wrongBySkill": defaultdict(int),
        "correctBySkill": defaultdict(int),
    }

    for entry in response_history:
        if not isinstance(entry, dict):
            continue
        key = _parse_question_key(entry.get("questionKey"))
        if key is None or key not in question_map:
            continue

        question = question_map[key]
        evaluation = _evaluate_adaptive_answer(question, entry.get("answer"))
        is_correct = evaluation["isCorrect"]
        difficulty = str(question.get("difficulty", "moyen")).lower()
        try:
            time_spent_seconds = max(0, float(entry.get("timeSpentSeconds", question.get("timeLimit", 60))))
        except Exception:
            time_spent_seconds = float(question.get("timeLimit", 60))
        expected_time = max(15.0, float(question.get("timeLimit", 60)))

        stats["totalAnswered"] += 1
        if is_correct:
            stats["totalCorrect"] += 1

        if difficulty == "facile":
            stats["easyAnswered"] += 1
            if is_correct:
                stats["easyCorrect"] += 1
            stats["easySpeedSamples"].append(time_spent_seconds / expected_time)

        for skill in normalize(question.get("skills", [])):
            if  is_correct:
                stats["correctBySkill"][skill] += 1
            else:
                stats["wrongBySkill"][skill] += 1

    total_accuracy = (stats["totalCorrect"] / stats["totalAnswered"]) if stats["totalAnswered"] else 0.0
    easy_accuracy = (stats["easyCorrect"] / stats["easyAnswered"]) if stats["easyAnswered"] else 0.0
    avg_easy_speed = (
        sum(stats["easySpeedSamples"]) / len(stats["easySpeedSamples"])
        if stats["easySpeedSamples"] else 1.0
    )

    target_difficulty = "moyen"
    if stats["easyAnswered"] >= 2 and easy_accuracy >= 0.75 and avg_easy_speed <= 0.85:
        target_difficulty = "difficile"
    elif stats["totalAnswered"] >= 3 and total_accuracy < 0.4:
        target_difficulty = "facile"

    penalized_skills = {
        skill
        for skill, wrong_count in stats["wrongBySkill"].items()
        if wrong_count >= 2 and wrong_count > stats["correctBySkill"].get(skill, 0)
    }

    boosted_skills = {
        skill
        for skill, correct_count in stats["correctBySkill"].items()
        if correct_count >= 2 and stats["wrongBySkill"].get(skill, 0) < correct_count
    }

    return {
        "targetDifficulty": target_difficulty,
        "penalizedSkills": penalized_skills,
        "boostedSkills": boosted_skills,
        "totalAnswered": stats["totalAnswered"],
        "totalAccuracy": total_accuracy,
        "easyAccuracy": easy_accuracy,
        "avgEasySpeed": avg_easy_speed,
    }


def _select_adaptive_questions(questions, response_history, asked_question_keys, page_size=5):
    safe_page_size = max(1, min(10, int(page_size or 5)))

    asked_set = set()
    for value in list(asked_question_keys or []) + [entry.get("questionKey") for entry in (response_history or []) if isinstance(entry, dict)]:
        parsed = _parse_question_key(value)
        if parsed is not None:
            asked_set.add(parsed)

    perf = _summarize_adaptive_performance(questions, response_history or [])
    target_rank = {"facile": 0, "moyen": 1, "difficile": 2}.get(perf["targetDifficulty"], 1)

    scored = []
    for index, question in enumerate(questions):
        if index in asked_set:
            continue
        
        # Filter by allowed question types
        question_type = str(question.get("type", "QCM")).strip()
        if QUIZ_ALLOWED_TYPES and question_type not in QUIZ_ALLOWED_TYPES:
            continue

        difficulty = str(question.get("difficulty", "moyen")).lower()
        difficulty_rank = {"facile": 0, "moyen": 1, "difficile": 2}.get(difficulty, 1)
        distance = abs(difficulty_rank - target_rank)
        skills = set(normalize(question.get("skills", [])))

        score = 0.0
        if distance == 0:
            score += 2.2
        elif distance == 1:
            score += 1.1
        else:
            score -= 0.3

        if skills.intersection(perf["boostedSkills"]):
            score += 0.6

        if skills.intersection(perf["penalizedSkills"]):
            if difficulty == "difficile":
                score -= 1.6
            else:
                score += 0.4

        score += random.random() * 0.15
        scored.append({"question": question, "questionKey": index, "adaptiveScore": score})

    scored.sort(key=lambda item: item["adaptiveScore"], reverse=True)
    selected = scored[:safe_page_size]
    selected_questions = [{**item["question"], "questionKey": item["questionKey"]} for item in selected]

    return {
        "selected": selected_questions,
        "remainingCount": max(0, len(scored) - len(selected_questions)),
        "adaptation": {
            "targetDifficulty": perf["targetDifficulty"],
            "penalizedSkills": sorted(perf["penalizedSkills"]),
            "boostedSkills": sorted(perf["boostedSkills"]),
            "totalAnswered": perf["totalAnswered"],
            "totalAccuracy": round(perf["totalAccuracy"], 2),
            "easyAccuracy": round(perf["easyAccuracy"], 2),
            "avgEasySpeed": round(perf["avgEasySpeed"], 2),
        },
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "ok": True,
            "service": "quiz-generation",
            "bank_size": len(QUESTION_BANK),
            "mistral_enabled": QUIZ_USE_MISTRAL,
            "mistral_required": QUIZ_REQUIRE_MISTRAL,
            "job_only_mode": QUIZ_JOB_ONLY_MODE,
            "mistral_configured": bool(MISTRAL_API_KEY),
            "mistral_model": MISTRAL_MODEL,
        }
    )


@app.route("/generate-quiz", methods=["POST"])
def generate_quiz():
    payload = request.get_json(silent=True) or {}

    job = payload.get("job", {})
    total_questions = int(payload.get("totalQuestions", 10))
    total_questions = max(1, min(20, total_questions))
    force_mistral = bool(payload.get("forceMistral", False)) or QUIZ_REQUIRE_MISTRAL or QUIZ_JOB_ONLY_MODE
    ranked_skills, ai_tools_detected = build_job_skill_stack(job)

    difficulty_mix = get_difficulty_mix(total_questions)

    mistral_questions, mistral_status, generation_trace = _call_mistral_for_questions(
        job=job,
        ranked_skills=ranked_skills,
        total_questions=total_questions,
        difficulty_mix=difficulty_mix,
        candidate_context=None,
    )

    if not mistral_questions:
        return jsonify(
            {
                "message": "Quiz generation failed: Mistral is required in job-only mode.",
                "meta": {
                    "source": "mistral-required-error",
                    "fallbackReason": mistral_status,
                    "model": MISTRAL_MODEL,
                    "jobOnlyMode": QUIZ_JOB_ONLY_MODE,
                    "forceMistral": force_mistral,
                },
            }
        ), 503

    normalized = mistral_questions
    source = "mistral-job-only"
    fallback_reason = None

    normalized, post_validation = _post_validate_questions(normalized, total_questions)

    return jsonify(
        {
            "questions": normalized,
            "meta": {
                "jobTitle": job.get("title", ""),
                "skillsUsed": ranked_skills[:10],
                "aiToolsDetected": ai_tools_detected,
                "difficultyMix": difficulty_mix,
                "source": source,
                "fallbackReason": fallback_reason,
                "model": MISTRAL_MODEL,
                "jobOnlyMode": QUIZ_JOB_ONLY_MODE,
                "pageSize": QUIZ_PAGE_SIZE,
                "variantsPerQuestion": QUIZ_VARIANTS_PER_QUESTION,
                "generationTrace": generation_trace if source == "mistral-job-only" else None,
                "postValidation": post_validation,
            },
        }
    )


@app.route("/adaptive-next-page", methods=["POST"])
def adaptive_next_page():
    payload = request.get_json(silent=True) or {}

    raw_questions = payload.get("questions", [])
    questions = [normalize_question(question) for question in raw_questions if isinstance(question, dict)]
    if not questions:
        return jsonify({"message": "questions are required"}), 400

    response_history = payload.get("responseHistory", [])
    if not isinstance(response_history, list):
        response_history = []

    asked_question_keys = payload.get("askedQuestionKeys", [])
    if not isinstance(asked_question_keys, list):
        asked_question_keys = []

    page = max(1, int(payload.get("page", 1) or 1))
    page_size = max(1, min(10, int(payload.get("pageSize", 5) or 5)))

    adaptive_selection = _select_adaptive_questions(
        questions=questions,
        response_history=response_history,
        asked_question_keys=asked_question_keys,
        page_size=page_size,
    )

    selected = adaptive_selection["selected"]
    remaining_count = adaptive_selection["remainingCount"]

    return jsonify(
        {
            "success": True,
            "page": page,
            "pageSize": page_size,
            "totalQuestions": len(questions),
            "questions": selected,
            "adaptation": adaptive_selection["adaptation"],
            "remainingCount": remaining_count,
            "completed": len(selected) == 0 or remaining_count == 0,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5003, debug=True)
