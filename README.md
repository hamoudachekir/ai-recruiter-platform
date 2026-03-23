# AI Recruiter Platform (Next Hire)

Plateforme de recrutement intelligente qui combine une application web full-stack et des services IA pour améliorer le tri de CV, le matching candidat/poste, l'évaluation d'entretien et la communication RH.

## Project Overview
`AI Recruiter Platform` est une solution ATS (Applicant Tracking System) orientée IA. Elle aide les recruteurs et les candidats à travers:
- la gestion d'offres et de candidatures,
- le scoring/recommandation basé sur des modèles Python,
- la messagerie et des interactions temps réel,
- des interfaces dédiées (candidat, entreprise, admin).

## Fonctionnalités principales
- Matching candidat ↔ poste basé sur compétences.
- Analyse CV / recommandation via services IA Python.
- Gestion d'entretiens et quiz d'évaluation.
- Authentification utilisateur et gestion des profils.
- Messagerie et notifications en temps réel.
- Dashboard RH pour suivi des candidatures.

## Architecture du projet
- `Frontend/`: application React + Vite.
- `Backend/server/`: API Node.js/Express + WebSocket.
- `Backend/server/AI/`: micro-services et scripts IA (Python).
- `docs/`: vision produit et schémas.

## Stack technique
- Frontend: React, Vite, Bootstrap, MUI.
- Backend: Node.js, Express, Socket.IO.
- IA/Data: Python (recommandation, scoring, NLP).
- Base de données: MongoDB.
- CI/CD: Jenkins (et workflows possibles GitHub Actions).

## Lancement local rapide
### 1) Frontend
Dans `Frontend/`:

```bash
npm install
npm run dev
```

### 2) Backend Node.js
Dans `Backend/server/`:

```bash
npm install
node index.js
```

### 3) Services IA Python
Dans `Backend/server/AI/`:

```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
python start_all_ai.py
```

## Repository
GitHub: https://github.com/hamoudachekir/ai-recruiter-platform.git
