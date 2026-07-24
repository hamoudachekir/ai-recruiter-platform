# Master CV — how to tailor in 5 minutes

| Langue | Fichier |
|---|---|
| English (UK) | `hamouda_chekir_cv_master_en.tex` |
| Français | `hamouda_chekir_cv_master_fr.tex` |

## Google XYZ formula used everywhere

> Accomplished **[X]** as measured by **[Y]** by doing **[Z]**.

Example from the template:
> Delivered an AI-first ATS spanning **16 microservices** by designing a shared MongoDB architecture and Dockerised service boundaries.

## Red flags removed (10-second manager scan)

| Removed | Why it hurt |
|---|---|
| 10 academic projects | Looks like padding |
| Undated projects (`—`) | Looks unfinished / unverifiable |
| NextHire duplicated in Experience + Projects | Waste of space, smells like inflation |
| “Immersion intern” as a full block | Weak signal; optional one-liner only |
| Soft fluff profile | Replaced by outcome-led summary |
| Spring Boot / Jenkins / tools with no proof | Keyword stuffing |
| SDG / soft cert for tech roles | Irrelevant noise |
| Raw “Stack: …” dumps | Replaced by XYZ bullets |

## Tailor checklist

1. Change `\TargetTitle{...}` to the exact job title from the JD.
2. Change `\TargetKeywords{...}` to 8–12 keywords copied from the JD.
3. Keep **3–4** experience bullets that match the JD; comment the rest.
4. Keep **2** projects max that match the role; swap from the commented bank.
5. Recompile:

```powershell
cd c:\Users\wh\ai-recruiter-platform\cv
pdflatex hamouda_chekir_cv_master_en.tex
```

## Ready-made title/keyword swaps

**Full-Stack**
```tex
\newcommand{\TargetTitle}{Junior Full-Stack Software Engineer}
\newcommand{\TargetKeywords}{React · Node.js · Python · FastAPI · Microservices · Docker · MongoDB · REST APIs · Agile}
```

**AI / LLM**
```tex
\newcommand{\TargetTitle}{Junior AI / LLM Engineer}
\newcommand{\TargetKeywords}{LLM · LangGraph · RAG · Python · FastAPI · Computer Vision · YOLO · Agents · LangChain}
```

**Laravel**
```tex
\newcommand{\TargetTitle}{PHP / Laravel Developer}
\newcommand{\TargetKeywords}{PHP · Laravel · Blade · MySQL · PostgreSQL · MVC · GitLab CI/CD · Docker · Agile}
```
