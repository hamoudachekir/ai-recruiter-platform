import os
import re
import time
from typing import Any, Dict, List, Optional, Union

import numpy as np
from bson import ObjectId
from faiss import IndexFlatIP
from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import MongoClient
from sklearn.feature_extraction.text import HashingVectorizer


class EmbeddingBackend:
    """Use sentence-transformers when available, otherwise fall back to sklearn."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2", fallback_features: int = 384):
        self.model_name = model_name
        self.fallback_features = fallback_features
        self._model = None
        self._using_fallback = False
        self._vectorizer = HashingVectorizer(
            n_features=fallback_features,
            alternate_sign=False,
            norm=None,
        )

    def _load_model(self) -> None:
        if self._model is not None or self._using_fallback:
            return

        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self.model_name)
            print(f"[INFO] Loaded embedding model: {self.model_name}")
        except Exception as exc:
            self._using_fallback = True
            print(f"[WARNING] Falling back to sklearn embeddings: {exc}")

    def encode(self, texts: Union[str, List[str]]) -> np.ndarray:
        self._load_model()

        is_single_text = isinstance(texts, str)
        text_list = [texts] if is_single_text else texts

        if self._model is not None:
            embeddings = self._model.encode(text_list, convert_to_tensor=False)
            return np.asarray(embeddings, dtype=np.float32)

        sparse_matrix = self._vectorizer.transform(text_list)
        embeddings = sparse_matrix.toarray().astype(np.float32)
        return embeddings[0] if is_single_text else embeddings


NODE_JS_SKILL = "node.js"

CORE_SKILL_WEIGHTS = {
    # Frontend
    "react": 4.0,
    "javascript": 3.5,
    "typescript": 3.5,
    "angular": 2.0,
    "vue": 2.0,
    "next.js": 2.5,
    "html": 1.4,
    "css": 1.4,
    "tailwind css": 1.2,
    "bootstrap": 1.0,
    # Backend
    NODE_JS_SKILL: 2.2,
    "express": 2.0,
    "python": 2.0,
    "java": 2.0,
    "php": 1.5,
    "laravel": 1.8,
    "django": 1.8,
    "flask": 1.5,
    "spring": 1.8,
    "spring boot": 2.0,
    "symfony": 1.5,
    # Databases
    "mongodb": 1.5,
    "sql": 1.0,
    "postgresql": 1.2,
    "mysql": 1.2,
    "sqlite": 0.8,
    # APIs
    "rest api": 1.5,
    "graphql": 1.5,
    # Cloud / DevOps
    "docker": 1.5,
    "kubernetes": 1.5,
    "aws": 2.0,
    "azure": 1.8,
    "gcp": 1.8,
    "ci/cd": 1.2,
    "devops": 1.5,
    "gitlab ci/cd": 1.2,
    "github actions": 1.2,
    "jenkins": 1.0,
    # General
    "git": 0.8,
    "scrum": 0.8,
    "agile": 0.8,
    "microservices": 1.5,
    "jwt": 0.8,
    "figma": 1.0,
    "frontend": 1.5,
    "web development": 1.1,
    "full stack": 1.0,
}

SKILL_SYNONYMS = {
    # JavaScript / TypeScript
    "js": "javascript",
    "javascript": "javascript",
    "ts": "typescript",
    "typescript": "typescript",
    # React
    "reactjs": "react",
    "react.js": "react",
    "react": "react",
    # Vue
    "vuejs": "vue",
    "vue.js": "vue",
    "vue": "vue",
    # Angular
    "angularjs": "angular",
    "angular": "angular",
    # Node
    "node": NODE_JS_SKILL,
    "nodejs": NODE_JS_SKILL,
    "node js": NODE_JS_SKILL,
    "node.js": NODE_JS_SKILL,
    # Express
    "expressjs": "express",
    "express.js": "express",
    "express": "express",
    # Databases
    "mongo": "mongodb",
    "mongodb": "mongodb",
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "mysql": "mysql",
    "sqlite": "sqlite",
    # Git / DevOps
    "git": "git",
    "github": "git",
    "gitlab": "git",
    "gitlab ci": "gitlab ci/cd",
    "gitlab ci/cd": "gitlab ci/cd",
    "github actions": "github actions",
    "docker": "docker",
    "kubernetes": "kubernetes",
    "k8s": "kubernetes",
    # Web
    "html5": "html",
    "html": "html",
    "css3": "css",
    "css": "css",
    "tailwindcss": "tailwind css",
    "tailwind css": "tailwind css",
    "tailwind": "tailwind css",
    "bootstrap": "bootstrap",
    # APIs
    "rest api": "rest api",
    "restapi": "rest api",
    "rest": "rest api",
    "restful": "rest api",
    "restful api": "rest api",
    "graphql": "graphql",
    "api": "rest api",
    # Cloud
    "aws": "aws",
    "azure": "azure",
    "gcp": "gcp",
    "google cloud": "gcp",
    # Other common
    "python": "python",
    "java": "java",
    "php": "php",
    "laravel": "laravel",
    "symfony": "symfony",
    "django": "django",
    "flask": "flask",
    "spring": "spring",
    "springboot": "spring boot",
    "spring boot": "spring boot",
    "next.js": "next.js",
    "nextjs": "next.js",
    "nuxt.js": "nuxt.js",
    "nuxtjs": "nuxt.js",
    "jwt": "jwt",
    "scrum": "scrum",
    "agile": "agile",
    "jira": "jira",
    "figma": "figma",
    "ci/cd": "ci/cd",
    "cicd": "ci/cd",
    "devops": "devops",
    "microservices": "microservices",
}


# Initialize MongoDB connection
client = MongoClient(os.getenv("MONGO_URI"))
db = client[os.getenv("MONGO_DB_NAME", "users")]

# Load the embedding backend
model = EmbeddingBackend()


class JobRecommender:
    def __init__(self):
        self.job_index: Optional[IndexFlatIP] = None
        self.job_ids: List[ObjectId] = []
        self.last_update: float = 0

    def _prepare_job_text(self, job: Dict[str, Any]) -> str:
        """Build job text used for semantic embeddings."""
        components = [
            job.get("title", ""),
            job.get("description", ""),
            f"Skills: {', '.join(job.get('skills', []))}" if job.get("skills") else "",
            f"Languages: {', '.join(job.get('languages', []))}" if job.get("languages") else "",
        ]
        return ". ".join(filter(None, components))

    def _prepare_candidate_text(self, candidate: Dict[str, Any]) -> str:
        """Build candidate text used for semantic embeddings."""
        profile = candidate.get("profile", {})

        experiences = []
        for exp in profile.get("experience", []):
            exp_text = [
                exp.get("title", "Position"),
                f"at {exp.get('company', 'Company')}" if exp.get("company") else "",
                f"({exp.get('duration', '')})" if exp.get("duration") else "",
                f": {exp.get('description', '')}" if exp.get("description") else "",
            ]
            experiences.append(" ".join(filter(None, exp_text)))

        exp_section = "Experience:\n" + "\n".join(experiences) if experiences else ""

        components = [
            f"Resume Summary: {profile.get('resume', '')}" if profile.get("resume") else "",
            f"Skills: {', '.join(profile.get('skills', []))}" if profile.get("skills") else "",
            f"Languages: {', '.join(profile.get('languages', []))}" if profile.get("languages") else "",
            f"Availability: {profile.get('availability', '')}" if profile.get("availability") else "",
            exp_section,
        ]

        return "\n".join(filter(None, components))

    @staticmethod
    def _canonicalize_skill(skill: Any) -> str:
        raw_value = str(skill or "").lower().strip()
        if not raw_value:
            return ""

        normalized = re.sub(r"[^a-z0-9+#.\s]", " ", raw_value)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        compact = normalized.replace(" ", "")

        if compact in SKILL_SYNONYMS:
            return SKILL_SYNONYMS[compact]
        if normalized in SKILL_SYNONYMS:
            return SKILL_SYNONYMS[normalized]
        return normalized

    def _normalize_skill_list(self, skills: Any) -> List[str]:
        if not skills:
            return []

        normalized = []
        seen = set()
        for skill in skills:
            canonical = self._canonicalize_skill(skill)
            if canonical and canonical not in seen:
                normalized.append(canonical)
                seen.add(canonical)
        return normalized

    def _extract_job_skills(self, job: Dict[str, Any]) -> List[str]:
        return self._normalize_skill_list(job.get("skills", []))

    def _extract_candidate_skills(self, candidate: Dict[str, Any]) -> List[str]:
        profile = candidate.get("profile", {}) if isinstance(candidate, dict) else {}
        return self._normalize_skill_list(profile.get("skills", []))

    def _skill_weight(self, skill: str) -> float:
        return CORE_SKILL_WEIGHTS.get(skill, 1.0)

    def _score_explicit_skill_overlap(self, candidate_skills: List[str], job_skills: List[str]) -> float:
        if not candidate_skills or not job_skills:
            return 0.0

        candidate_set = set(candidate_skills)
        job_set = set(job_skills)
        matched = candidate_set.intersection(job_set)
        if not matched:
            return 0.0

        weighted_matched = sum(self._skill_weight(skill) for skill in matched)
        weighted_total = sum(self._skill_weight(skill) for skill in job_set)
        if weighted_total <= 0:
            return 0.0

        coverage = weighted_matched / weighted_total

        react_stack = {"react", "javascript", "typescript"}
        frontend_support = {"html", "css", "angular", "vue", NODE_JS_SKILL, "express", "mongodb", "git"}

        react_bonus = min(1.0, len(matched.intersection(react_stack)) / len(react_stack)) * 0.15
        support_bonus = min(1.0, len(matched.intersection(frontend_support)) / max(1, len(frontend_support))) * 0.10

        explicit_score = (coverage * 0.75) + react_bonus + support_bonus
        if coverage >= 0.98 and len(matched.intersection(react_stack)) >= 2:
            explicit_score = 1.0

        return min(1.0, explicit_score)

    def _build_hybrid_score(self, semantic_score: float, candidate_skills: List[str], job: Dict[str, Any]) -> Dict[str, Any]:
        job_skills = self._extract_job_skills(job)
        explicit_skill_score = self._score_explicit_skill_overlap(candidate_skills, job_skills)

        semantic_component = max(0.0, min(1.0, float(semantic_score)))
        hybrid_score = (semantic_component * 0.25) + (explicit_skill_score * 0.75)

        title_text = str(job.get("title", "") or "").lower()
        description_text = str(job.get("description", "") or "").lower()
        if "react" in title_text or "react" in description_text:
            if {"react", "javascript", "typescript"}.issubset(set(candidate_skills)):
                hybrid_score = min(1.0, hybrid_score + 0.04)

        if explicit_skill_score >= 0.95 and semantic_component >= 0.35:
            hybrid_score = 1.0

        return {
            "score": float(max(0.0, min(1.0, hybrid_score))),
            "skill_score": float(explicit_skill_score),
            "semantic_score": float(semantic_component),
            "job_skills": job_skills,
        }

    def _load_candidate(self, candidate_obj_id: ObjectId) -> Optional[Dict[str, Any]]:
        try:
            return db.users.find_one(
                {"_id": candidate_obj_id, "role": "CANDIDATE"},
                {"profile": 1, "applications": 1, "name": 1},
            )
        except Exception as exc:
            raise RuntimeError(f"Database error: {str(exc)}") from exc

    @staticmethod
    def _get_applied_job_ids(candidate: Dict[str, Any]) -> List[ObjectId]:
        applied_job_ids: List[ObjectId] = []
        for app in candidate.get("applications", []):
            try:
                applied_job_ids.append(ObjectId(app.get("jobId")))
            except Exception:
                continue
        return applied_job_ids

    def _get_candidate_embedding(self, candidate: Dict[str, Any]) -> np.ndarray:
        candidate_text = self._prepare_candidate_text(candidate)
        print("\n[DEBUG] Candidate Profile Text:")
        print(candidate_text)
        candidate_skills = self._extract_candidate_skills(candidate)
        print(f"[DEBUG] Candidate Skills: {candidate_skills}")

        candidate_embedding = model.encode(candidate_text)
        norm = np.linalg.norm(candidate_embedding)
        if norm <= 0:
            raise ValueError("Candidate embedding norm is zero")

        candidate_embedding = candidate_embedding / norm
        print(f"\n[DEBUG] Embedding shape: {candidate_embedding.shape}")
        print(f"Sample embedding values: {candidate_embedding[:5]}...")
        return candidate_embedding

    def _build_recommendation_record(
        self,
        job_id: ObjectId,
        semantic_score: float,
        candidate_skills: List[str],
        threshold: float,
    ) -> Optional[Dict[str, Any]]:
        try:
            job = db.jobs.find_one(
                {"_id": job_id},
                {
                    "title": 1,
                    "description": 1,
                    "skills": 1,
                    "languages": 1,
                    "location": 1,
                    "salary": 1,
                    "entrepriseId": 1,
                    "createdAt": 1,
                },
            )
        except Exception as exc:
            print(f"[ERROR] Processing job {job_id}: {str(exc)}")
            return None

        if not job:
            return None

        hybrid = self._build_hybrid_score(float(semantic_score), candidate_skills, job)
        if hybrid["score"] < threshold:
            print(f"[DEBUG] Final hybrid score {hybrid['score']:.3f} below threshold {threshold} for job {job_id}")
            return None

        job["_id"] = str(job["_id"])
        if "entrepriseId" in job:
            job["entrepriseId"] = str(job["entrepriseId"])
        job["match_score"] = hybrid["score"]
        job["match_breakdown"] = {
            "semantic": round(hybrid["semantic_score"] * 100, 2),
            "skills": round(hybrid["skill_score"] * 100, 2),
        }

        print(
            f"[MATCH] Job {job['title']} (ID: {job['_id']}) - "
            f"Semantic: {hybrid['semantic_score']:.3f}, Skills: {hybrid['skill_score']:.3f}, Final: {hybrid['score']:.3f}"
        )
        return job

    def _collect_recommendations(
        self,
        scores: np.ndarray,
        indices: np.ndarray,
        candidate_skills: List[str],
        applied_job_ids: List[ObjectId],
        threshold: float,
        top_k: int,
    ) -> List[Dict[str, Any]]:
        recommendations: List[Dict[str, Any]] = []

        for idx, score in zip(indices[0], scores[0]):
            if idx >= len(self.job_ids):
                print(f"[WARNING] Invalid index {idx} >= {len(self.job_ids)}")
                continue

            job_id = self.job_ids[idx]
            if job_id in applied_job_ids:
                print(f"[DEBUG] Skipping already applied job {job_id}")
                continue

            job = self._build_recommendation_record(job_id, float(score), candidate_skills, threshold)
            if not job:
                continue

            recommendations.append(job)
            if len(recommendations) >= top_k:
                break

        return recommendations

    def update_job_index(self, force: bool = False) -> None:
        """Update the in-memory index with all jobs from database."""
        if not force and time.time() - self.last_update < 3600:
            return

        try:
            jobs = list(db.jobs.find({"status": {"$ne": "CLOSED"}}))
            print(f"\n[DEBUG] Found {len(jobs)} jobs in database")

            if not jobs:
                print("[WARNING] No jobs found in database")
                return

            job_texts = []
            self.job_ids = []

            for i, job in enumerate(jobs, 1):
                job_text = self._prepare_job_text(job)
                print(f"\n[DEBUG] Job {i}/{len(jobs)}:")
                print(f"ID: {job['_id']}")
                print(f"Title: {job.get('title', 'N/A')}")
                print(f"Text: {job_text[:200]}...")

                if job_text.strip():
                    job_texts.append(job_text)
                    self.job_ids.append(job["_id"])
                else:
                    print("[WARNING] Skipped empty job text")

            if not job_texts:
                print("[ERROR] No valid jobs found to index")
                return

            print("\n[DEBUG] Generating embeddings...")
            embeddings = model.encode(job_texts)
            norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
            embeddings = embeddings / np.clip(norms, 1e-8, None)

            dimension = embeddings.shape[1]
            self.job_index = IndexFlatIP(dimension)
            self.job_index.add(embeddings.astype("float32"))

            self.last_update = time.time()
            print(f"[SUCCESS] Indexed {len(self.job_ids)} jobs")
        except Exception as e:
            print(f"[ERROR] Updating job index: {str(e)}")
            self.job_index = None
            self.job_ids = []

    def recommend_jobs(
        self,
        candidate_id: str,
        top_k: int = 5,
        threshold: float = 0.3,
    ) -> Dict[str, Union[str, List[Dict[str, Any]]]]:
        """Get top matched jobs for a candidate profile."""
        print("\n==== STARTING RECOMMENDATION ====")
        self.update_job_index()

        try:
            candidate_obj_id = ObjectId(candidate_id)
        except Exception:
            print("[ERROR] Invalid candidate ID format")
            return {"error": "Invalid candidate ID format"}

        try:
            candidate = self._load_candidate(candidate_obj_id)
        except RuntimeError as exc:
            print(f"[ERROR] Database lookup failed: {str(exc)}")
            return {"error": str(exc)}

        if not candidate:
            print("[ERROR] Candidate not found or not a candidate role")
            return {"error": "Candidate not found or not a candidate role"}

        print(f"\n[DEBUG] Candidate: {candidate.get('name', 'Unknown')} ({candidate_id})")
        candidate_skills = self._extract_candidate_skills(candidate)
        applied_job_ids = self._get_applied_job_ids(candidate)
        print(f"[DEBUG] Applied to {len(applied_job_ids)} jobs")

        try:
            candidate_embedding = self._get_candidate_embedding(candidate)
        except Exception as e:
            print(f"[ERROR] Processing candidate profile: {str(e)}")
            return {"error": f"Error processing candidate profile: {str(e)}"}

        if not self.job_index or len(self.job_ids) == 0:
            print("[ERROR] No jobs available in the index")
            return {"error": "No jobs available in the index"}

        try:
            search_k = min(top_k * 3, len(self.job_ids))
            print(f"\n[DEBUG] Searching top {search_k} jobs from {len(self.job_ids)} available")

            scores, indices = self.job_index.search(
                candidate_embedding.reshape(1, -1).astype("float32"),
                search_k,
            )

            print(f"[DEBUG] Raw scores: {scores}")
            print(f"[DEBUG] Raw indices: {indices}")

            recommendations = self._collect_recommendations(
                scores=scores,
                indices=indices,
                candidate_skills=candidate_skills,
                applied_job_ids=applied_job_ids,
                threshold=threshold,
                top_k=top_k,
            )

            recommendations.sort(key=lambda x: x["match_score"], reverse=True)
            if recommendations:
                print(f"\n[SUCCESS] Returning {len(recommendations)} recommendations")
                return {"recommendations": recommendations}

            print("\n[WARNING] No matching jobs found")
            return {
                "message": "No matching jobs found",
                "debug_info": {
                    "threshold_used": threshold,
                    "top_scores": [float(s) for s in scores[0][:5]],
                    "candidate_skills": candidate.get("profile", {}).get("skills", []),
                    "total_jobs_considered": len(self.job_ids),
                },
            }
        except Exception as e:
            print(f"[ERROR] During recommendation search: {str(e)}")
            return {"error": f"Error during recommendation search: {str(e)}"}


app = Flask(__name__)
CORS(app)
recommender = JobRecommender()


@app.route('/recommend', methods=['POST'])
def recommend():
    data = request.json or {}
    candidate_id = data.get('candidate_id')
    top_k = data.get('top_k', 5)
    threshold = data.get('threshold', 0.3)

    if not candidate_id:
        return jsonify({"error": "candidate_id is required"}), 400

    results = recommender.recommend_jobs(candidate_id, top_k, threshold)
    return jsonify(results)


@app.route('/refresh-index', methods=['POST'])
def refresh_index():
    """Force refresh the job index immediately."""
    try:
        recommender.update_job_index(force=True)
        return jsonify({
            "success": True,
            "message": f"Job index refreshed with {len(recommender.job_ids)} jobs"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "running",
        "jobs_indexed": len(recommender.job_ids),
        "last_update": recommender.last_update
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)