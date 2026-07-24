from app.fit import analyze_fit


def _strengths(cv_json: dict, job_text: str) -> list[str]:
    analysis = analyze_fit(cv_json, job_text)
    return analysis.matched_skills[:6]


def generate_cover_letter(
    cv_json: dict,
    job_text: str,
    job_title: str = "",
    company: str = "",
    language: str = "fr",
) -> str:
    name = cv_json.get("name") or "Candidat"
    profile = cv_json.get("profile", {}) or {}
    summary = profile.get("shortDescription") or profile.get("resume") or ""
    strengths = _strengths(cv_json, job_text)
    role = job_title.strip() or ("the advertised position" if language == "en" else "le poste proposé")
    employer = company.strip() or ("your organisation" if language == "en" else "votre entreprise")
    skills = ", ".join(strengths) if strengths else (
        "software engineering and collaborative delivery"
        if language == "en"
        else "l’ingénierie logicielle et la livraison collaborative"
    )

    if language == "en":
        paragraphs = [
            f"Dear Hiring Team at {employer},",
            (
                f"I am applying for {role}. My background aligns particularly well with your needs in "
                f"{skills}. {summary}".strip()
            ),
            (
                "I build dependable solutions from design through delivery, with close attention to APIs, "
                "testing, maintainability and teamwork. I would welcome the opportunity to discuss how my "
                "existing experience can contribute to your team; this letter intentionally includes only "
                "skills evidenced in my CV."
            ),
            "Yours faithfully,",
            name,
        ]
    else:
        paragraphs = [
            f"Madame, Monsieur, équipe recrutement de {employer},",
            (
                f"Je vous adresse ma candidature au poste de {role}. Mon parcours correspond notamment à "
                f"vos besoins en {skills}. {summary}".strip()
            ),
            (
                "Je conçois des solutions fiables de la conception à la livraison, avec une attention "
                "particulière portée aux API, aux tests, à la maintenabilité et au travail d’équipe. "
                "Je serais heureux d’échanger sur la contribution que mon expérience actuelle pourrait "
                "apporter à votre équipe ; cette lettre ne reprend que des compétences présentes dans mon CV."
            ),
            "Cordialement,",
            name,
        ]

    return "\n\n".join(paragraph for paragraph in paragraphs if paragraph)
