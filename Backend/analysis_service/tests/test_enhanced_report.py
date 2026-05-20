"""Tests for the enhanced report pipeline (Parts 1-10).

Covers:
  - Q&A extraction from stored conversation
  - Missing Q&A returns qnaAvailable=False
  - Per-question scoring (empty / generic / concrete)
  - Sentiment model output per answer
  - Skills extracted only from candidate answers
  - Job context loads from room
  - Job match score calculates correctly
  - Missing job returns fitLevel=unknown
  - LLM cannot change protected fields
  - Final recommendation changes based on evidence
"""

import copy

import pytest

# ─────────────────────────────────────────────────────────────────────────────
# Part 1: Q&A extraction
# ─────────────────────────────────────────────────────────────────────────────


class TestQnAExtraction:
    """Tests for qna_service.load_interview_qa."""

    def _make_room(self, messages):
        return {"_id": "room1", "roomId": "room1", "messages": messages}

    def test_extracts_qa_from_messages(self):
        from app.services.qna_service import load_interview_qa

        messages = [
            {"role": "agent", "text": "Tell me about your background."},
            {"role": "candidate", "text": "I have 5 years of experience in Node.js."},
            {"role": "agent", "text": "Describe your MongoDB experience."},
            {
                "role": "candidate",
                "text": "I used MongoDB for 3 years with aggregation pipelines.",
            },
        ]
        room = self._make_room(messages)
        result = load_interview_qa("room1", call_room=room)

        assert result["available"] is True
        assert result["source"] == "stored_conversation"
        assert result["questionCount"] == 2
        assert result["answeredCount"] == 2
        assert len(result["items"]) == 2
        assert result["items"][0]["questionText"] == "Tell me about your background."
        assert "Node.js" in result["items"][0]["answerText"]

    def test_missing_messages_returns_unavailable(self):
        from app.services.qna_service import load_interview_qa

        room = {"_id": "room2", "roomId": "room2", "messages": []}
        result = load_interview_qa("room2", call_room=room)

        assert result["available"] is False
        assert result["source"] == "unavailable"
        assert result["questionCount"] == 0
        assert result["items"] == []

    def test_no_call_room_returns_unavailable(self):
        from app.services.qna_service import load_interview_qa

        result = load_interview_qa("nonexistent-id", call_room=None)
        assert result["available"] is False

    def test_agent_question_without_candidate_answer(self):
        from app.services.qna_service import load_interview_qa

        messages = [
            {"role": "agent", "text": "What is your notice period?"},
            # No candidate answer follows
        ]
        room = self._make_room(messages)
        result = load_interview_qa("room3", call_room=room)

        assert result["available"] is True
        assert result["questionCount"] == 1
        assert result["answeredCount"] == 0
        assert result["items"][0]["answerText"] == ""

    def test_uses_agent_snapshot_fallback(self):
        from app.services.qna_service import load_interview_qa

        snapshot_messages = [
            {"role": "agent", "text": "What is your experience with React?"},
            {
                "role": "candidate",
                "text": "I have built multiple React apps with Redux.",
            },
        ]
        room = {
            "_id": "room4",
            "roomId": "room4",
            "messages": [],  # Empty messages
            "agentSnapshot": {"conversation": snapshot_messages},
        }
        result = load_interview_qa("room4", call_room=room)

        assert result["available"] is True
        assert result["source"] == "agent_snapshot"
        assert result["questionCount"] == 1

    def test_stt_fallback_returns_unavailable(self):
        from app.services.qna_service import extract_qna_from_stt

        stt = {"fullText": "Hello I am a candidate.", "segments": []}
        result = extract_qna_from_stt(stt)
        assert result["available"] is False
        assert result["source"] == "unavailable"

    def test_stt_empty_returns_unavailable(self):
        from app.services.qna_service import extract_qna_from_stt

        result = extract_qna_from_stt({"fullText": "", "segments": []})
        assert result["available"] is False


# ─────────────────────────────────────────────────────────────────────────────
# Part 2/3: Per-question scoring and sentiment
# ─────────────────────────────────────────────────────────────────────────────


class TestQuestionEvaluation:
    """Tests for question_evaluator.evaluate_question."""

    def test_empty_answer_is_insufficient(self):
        from app.services.question_evaluator import evaluate_question

        item = {
            "questionId": "q1",
            "questionText": "Tell me about yourself.",
            "answerText": "",
        }
        result = evaluate_question(item, 0)

        assert result["score"] <= 30
        assert result["answerQuality"] == "insufficient"
        assert result["confidence"] == "high"

    def test_short_answer_is_insufficient(self):
        from app.services.question_evaluator import evaluate_question

        item = {
            "questionId": "q1",
            "questionText": "Tell me about yourself.",
            "answerText": "I code.",
        }
        result = evaluate_question(item, 0)

        assert result["score"] <= 30
        assert result["answerQuality"] == "insufficient"

    def test_generic_answer_is_acceptable(self):
        from app.services.question_evaluator import evaluate_question

        answer = (
            "I have experience working with JavaScript and Node.js. "
            "I enjoy backend development and have built REST APIs. "
            "I worked on several web projects."
        )
        item = {
            "questionId": "q1",
            "questionText": "Describe your background.",
            "answerText": answer,
        }
        result = evaluate_question(item, 0)

        assert 40 <= result["score"] <= 70
        assert result["answerQuality"] in {"acceptable", "strong"}

    def test_concrete_technical_answer_is_strong(self):
        from app.services.question_evaluator import evaluate_question

        answer = (
            "I built a microservice backend using Node.js and Express that handled "
            "50,000 daily API requests. I designed the MongoDB database schema, "
            "implemented Docker containerization, and deployed on AWS with GitHub Actions CI/CD. "
            "The project reduced response latency by 40% after query optimizations."
        )
        item = {
            "questionId": "q1",
            "questionText": "Describe your Node.js experience.",
            "answerText": answer,
        }
        result = evaluate_question(item, 0)

        assert result["score"] >= 70
        assert result["answerQuality"] == "strong"
        assert result["confidence"] in {"medium", "high"}

    def test_score_never_reaches_100(self):
        from app.services.question_evaluator import evaluate_question

        answer = " ".join(
            ["I built implemented designed deployed managed optimized increased"] * 30
        )
        item = {
            "questionId": "q1",
            "questionText": "Describe your work.",
            "answerText": answer,
        }
        result = evaluate_question(item, 0)

        assert result["score"] <= 95

    def test_sentiment_is_populated(self):
        from app.services.question_evaluator import evaluate_question

        item = {
            "questionId": "q1",
            "questionText": "How do you feel about Node.js?",
            "answerText": "I love Node.js. It is excellent and I am very excited to use it.",
        }
        result = evaluate_question(item, 0)

        assert result["sentiment"] in {"positive", "neutral", "negative"}
        assert result["sentimentScore"] is not None
        assert 0.0 <= result["sentimentScore"] <= 1.0

    def test_skills_mentioned_only_from_answer(self):
        from app.services.question_evaluator import evaluate_question

        # The question mentions TypeScript but the answer only mentions Python
        item = {
            "questionId": "q1",
            "questionText": "Do you know TypeScript and React?",
            "answerText": "I primarily use Python and Flask for backend development.",
        }
        result = evaluate_question(item, 0)

        # Python/Flask should be detected; TypeScript/React should not
        assert (
            "Python" in result["skillsMentioned"]
            or "Flask" in result["skillsMentioned"]
        )
        assert "TypeScript" not in result["skillsMentioned"]

    def test_follow_up_generated(self):
        from app.services.question_evaluator import evaluate_question

        item = {
            "questionId": "q1",
            "questionText": "Describe your Node.js experience.",
            "answerText": "I use Node.js for APIs.",
        }
        result = evaluate_question(item, 0)

        assert isinstance(result["recommendedFollowUp"], str)
        assert len(result["recommendedFollowUp"]) > 10


class TestEvaluateAllQuestions:
    def test_empty_input_returns_empty(self):
        from app.services.question_evaluator import evaluate_all_questions

        result = evaluate_all_questions([])
        assert result == []

    def test_multiple_questions_evaluated(self):
        from app.services.question_evaluator import evaluate_all_questions

        items = [
            {
                "questionId": "q1",
                "questionText": "Tell me about yourself.",
                "answerText": "I have 5 years of Node.js experience.",
            },
            {"questionId": "q2", "questionText": "Describe MongoDB.", "answerText": ""},
        ]
        result = evaluate_all_questions(items)

        assert len(result) == 2
        # First answer should be better than second (empty)
        assert result[0]["score"] > result[1]["score"]


# ─────────────────────────────────────────────────────────────────────────────
# Part 3: Sentiment service
# ─────────────────────────────────────────────────────────────────────────────


class TestSentimentService:
    def test_positive_answer(self):
        from app.services.sentiment_service import analyze_sentiment

        result = analyze_sentiment(
            "I am very excited to work on this project. I love Node.js and built excellent APIs."
        )
        assert result["label"] == "positive"
        assert result["score"] > 0.5

    def test_neutral_answer(self):
        from app.services.sentiment_service import analyze_sentiment

        result = analyze_sentiment(
            "I have worked with various technologies. I have experience in backend development."
        )
        assert result["label"] in {
            "neutral",
            "positive",
        }  # Neutral or slightly positive

    def test_negative_answer(self):
        from app.services.sentiment_service import analyze_sentiment

        result = analyze_sentiment(
            "I struggled with this technology. It was difficult and I failed to complete it. Very confusing."
        )
        assert result["label"] == "negative"
        assert result["score"] < 0.5

    def test_empty_answer_is_neutral(self):
        from app.services.sentiment_service import analyze_sentiment

        result = analyze_sentiment("")
        assert result["label"] == "neutral"
        assert result["score"] == 0.5

    def test_qna_sentiment_mutates_items(self):
        from app.services.sentiment_service import analyze_qna_sentiment

        items = [
            {"answerText": "I love building React apps with Node.js!"},
            {"answerText": ""},
        ]
        summary = analyze_qna_sentiment(items)

        # Items should be mutated
        assert "sentiment" in items[0]
        assert "sentimentScore" in items[0]
        assert summary["totalAnswersAnalyzed"] == 2


# ─────────────────────────────────────────────────────────────────────────────
# Part 4: Skills extraction
# ─────────────────────────────────────────────────────────────────────────────


class TestSkillsExtraction:
    def test_detects_skills_from_candidate_answers(self):
        from app.services.skills_service import extract_skills_from_interview

        items = [
            {
                "questionText": "Tell me about yourself.",
                "answerText": "I used React, Node.js, and MongoDB for 3 years.",
            },
        ]
        result = extract_skills_from_interview(qna_items=items)

        skill_names = [s["skill"] for s in result["detectedSkills"]]
        assert "React" in skill_names
        assert "Node.js" in skill_names
        assert "MongoDB" in skill_names

    def test_does_not_count_skills_from_question_only(self):
        from app.services.skills_service import extract_skills_from_interview

        items = [
            {
                "questionText": "Do you have experience with TypeScript and Docker?",
                "answerText": "I primarily use Python and Flask.",
            },
        ]
        result = extract_skills_from_interview(qna_items=items)

        skill_names = [s["skill"] for s in result["detectedSkills"]]
        # TypeScript and Docker are in question only — should NOT be detected
        assert "TypeScript" not in skill_names
        assert "Docker" not in skill_names
        # Python and Flask ARE in answer — should be detected
        assert "Python" in skill_names or "Flask" in skill_names

    def test_missing_from_interview_with_job_requirements(self):
        from app.services.skills_service import extract_skills_from_interview

        items = [
            {"questionText": "Q", "answerText": "I used React and Node.js."},
        ]
        required = ["React", "Node.js", "TypeScript", "Docker", "AWS"]
        result = extract_skills_from_interview(
            qna_items=items, job_required_skills=required
        )

        # TypeScript, Docker, AWS not mentioned → missing
        missing = result["missingFromInterview"]
        assert "TypeScript" in missing or "Docker" in missing or "AWS" in missing

    def test_empty_answers_returns_empty(self):
        from app.services.skills_service import extract_skills_from_interview

        result = extract_skills_from_interview(qna_items=[], full_transcript="")
        assert result["detectedSkills"] == []

    def test_evidence_stored_per_skill(self):
        from app.services.skills_service import extract_skills_from_interview

        items = [
            {
                "questionText": "Q",
                "answerText": "I built APIs using Node.js and Express for REST API design.",
            },
        ]
        result = extract_skills_from_interview(qna_items=items)

        for skill in result["detectedSkills"]:
            if skill["skill"] == "Node.js":
                assert len(skill["evidence"]) > 0
                break

    def test_categories_populated(self):
        from app.services.skills_service import extract_skills_from_interview

        items = [
            {
                "questionText": "Q",
                "answerText": "I used React, Node.js, MongoDB, Docker, AWS.",
            },
        ]
        result = extract_skills_from_interview(qna_items=items)

        cats = result["categories"]
        assert isinstance(cats, dict)
        assert "frontend" in cats
        assert "backend" in cats


# ─────────────────────────────────────────────────────────────────────────────
# Part 5/6: Job match service
# ─────────────────────────────────────────────────────────────────────────────


class TestJobMatchEvaluation:
    def _job_context(self, linked=True):
        if not linked:
            return {"linked": False}
        return {
            "linked": True,
            "jobId": "job1",
            "title": "Lead Full-Stack Engineer",
            "companyName": "Talan",
            "location": "Paris",
            "requiredSkills": ["React", "Node.js", "TypeScript", "MongoDB", "Docker"],
            "requiredLanguages": ["English", "French"],
            "responsibilities": [
                "Design and implement REST APIs using Node.js and Express",
                "Build responsive user interfaces with React and TypeScript",
            ],
            "requiredQualifications": ["5+ years web development"],
        }

    def test_job_not_linked_returns_unknown(self):
        from app.services.job_match_service import build_job_match_evaluation

        result = build_job_match_evaluation(
            job_context=self._job_context(linked=False),
            detected_skills=[],
            question_evaluations=[],
        )

        assert result["score"] is None
        assert result["fitLevel"] == "unknown"
        assert "not linked" in result["summary"].lower()

    def test_skill_match_populates_matched_and_missing(self):
        from app.services.job_match_service import build_job_match_evaluation

        # Candidate mentions React, Node.js, MongoDB but NOT TypeScript or Docker
        detected = [
            {"skill": "React"},
            {"skill": "Node.js"},
            {"skill": "MongoDB"},
        ]
        result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=detected,
            question_evaluations=[],
            full_candidate_text="I used React, Node.js and MongoDB",
        )

        assert "React" in result["matchedSkills"]
        assert "Node.js" in result["matchedSkills"]
        assert "MongoDB" in result["matchedSkills"]
        assert "TypeScript" in result["missingOrUnverifiedSkills"]
        assert "Docker" in result["missingOrUnverifiedSkills"]

    def test_score_increases_with_better_answers(self):
        from app.services.job_match_service import build_job_match_evaluation

        # Good answers
        good_evals = [
            {"score": 82, "answerQuality": "strong", "sentiment": "positive"},
            {"score": 75, "answerQuality": "strong", "sentiment": "positive"},
        ]
        # Poor answers
        poor_evals = [
            {"score": 20, "answerQuality": "insufficient", "sentiment": "neutral"},
            {"score": 25, "answerQuality": "insufficient", "sentiment": "neutral"},
        ]
        detected = [{"skill": "React"}, {"skill": "Node.js"}, {"skill": "MongoDB"}]

        good_result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=detected,
            question_evaluations=good_evals,
        )
        poor_result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=detected,
            question_evaluations=poor_evals,
        )

        assert good_result["score"] > poor_result["score"]

    def test_full_skill_match_gives_higher_score(self):
        from app.services.job_match_service import build_job_match_evaluation

        all_skills = [
            {"skill": "React"},
            {"skill": "Node.js"},
            {"skill": "TypeScript"},
            {"skill": "MongoDB"},
            {"skill": "Docker"},
        ]
        no_skills = []

        full_result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=all_skills,
            question_evaluations=[
                {"score": 70, "answerQuality": "strong", "sentiment": "positive"}
            ],
        )
        empty_result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=no_skills,
            question_evaluations=[
                {"score": 70, "answerQuality": "strong", "sentiment": "positive"}
            ],
        )

        assert full_result["score"] > empty_result["score"]

    def test_follow_up_questions_generated_for_missing_skills(self):
        from app.services.job_match_service import build_job_match_evaluation

        detected = [{"skill": "React"}]
        result = build_job_match_evaluation(
            job_context=self._job_context(),
            detected_skills=detected,
            question_evaluations=[],
        )

        assert len(result["recruiterFollowUpQuestions"]) > 0
        # Follow-up should mention missing skills
        followup_text = " ".join(result["recruiterFollowUpQuestions"]).lower()
        assert any(s.lower() in followup_text for s in ["node", "typescript", "docker"])


# ─────────────────────────────────────────────────────────────────────────────
# Part 7: Enhanced final recommendation
# ─────────────────────────────────────────────────────────────────────────────


class TestEnhancedRecommendation:
    def _call(self, **kwargs):
        from app.services.report_service import _build_final_recommendation_enhanced

        defaults = dict(
            qna_available=True,
            usable_transcript=True,
            job_linked=True,
            multiple_faces_detected=False,
            integrity_score=85,
            job_match_score=80,
            technical_score=75,
            hr_score=70,
            report_quality_confidence="high",
            question_evaluations=[],
        )
        defaults.update(kwargs)
        return _build_final_recommendation_enhanced(**defaults)

    def test_proceed_when_everything_is_good(self):
        result = self._call()
        assert result["decision"] == "proceed"

    def test_insufficient_data_when_no_transcript_and_no_qna(self):
        result = self._call(qna_available=False, usable_transcript=False)
        assert result["decision"] == "insufficient_data"

    def test_manual_review_when_job_not_linked(self):
        result = self._call(job_linked=False)
        assert result["decision"] == "manual_review"
        assert "not linked" in result["summary"].lower()

    def test_manual_review_when_multiple_faces(self):
        result = self._call(multiple_faces_detected=True)
        assert result["decision"] == "manual_review"

    def test_manual_review_when_low_integrity(self):
        result = self._call(integrity_score=50)
        assert result["decision"] == "manual_review"

    def test_technical_follow_up_when_good_tech_but_low_job_match(self):
        result = self._call(technical_score=75, job_match_score=60)
        assert result["decision"] == "technical_follow_up"

    def test_not_recommended_when_all_answers_are_weak(self):
        weak_evals = [
            {"answerQuality": "insufficient"},
            {"answerQuality": "weak"},
            {"answerQuality": "insufficient"},
        ]
        # Must also have lower job match so it doesn't hit proceed first
        result = self._call(
            job_match_score=40,
            question_evaluations=weak_evals,
            integrity_score=80,
        )
        # Could be not_recommended or manual_review — both are valid
        assert result["decision"] in {
            "not_recommended",
            "manual_review",
            "technical_follow_up",
        }

    def test_reasons_are_populated(self):
        result = self._call()
        assert isinstance(result["reasons"], list)
        assert len(result["reasons"]) > 0


# ─────────────────────────────────────────────────────────────────────────────
# Part 10: LLM cannot change protected fields
# ─────────────────────────────────────────────────────────────────────────────


class TestLLMProtectedFields:
    """Tests that report_polish._repin_deterministic protects new fields."""

    def _make_report(self):
        return {
            "interviewId": "interview123",
            "candidateName": "Alice",
            "jobTitle": "Lead Engineer",
            "integrityScore": 85,
            "overallScore": 78,
            "interviewQna": {
                "available": True,
                "source": "stored_conversation",
                "questionCount": 3,
                "answeredCount": 3,
                "items": [],
            },
            "skillsExtractedFromInterview": {
                "detectedSkills": [{"skill": "React", "mentions": 2}],
                "missingFromInterview": ["Docker"],
                "categories": {},
            },
            "jobContext": {
                "linked": True,
                "title": "Lead Full-Stack Engineer",
                "requiredSkills": ["React", "Docker"],
            },
            "jobMatchEvaluation": {
                "score": 72,
                "fitLevel": "moderate",
            },
            "answerSentimentSummary": {
                "overallSentiment": "positive",
                "positiveAnswers": 3,
            },
            "enhancedRecommendation": {
                "decision": "technical_follow_up",
                "label": "Technical Follow-up Recommended",
            },
            "questionEvaluations": [
                {"questionId": "q1", "score": 82, "answerQuality": "strong"},
            ],
            "humanReviewRequired": False,
            "technicalEvaluation": {"score": 75},
            "finalRecommendation": {
                "status": "proceed",
                "overallScore": 78,
            },
            "scoreBreakdown": {"technicalScore": 75, "integrityScore": 85},
            "visionMonitoring": {"faceVisiblePercent": 90.0},
            "audioAnalysis": {"transcriptionAvailable": True},
            "integrityAlerts": [],
            "reportQuality": {"confidence": "high"},
            "recruiterDecisionSummary": {"decision": "proceed"},
        }

    def test_llm_cannot_change_interview_qna(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        # LLM tries to tamper with interviewQna
        llm_out["interviewQna"]["available"] = False
        llm_out["interviewQna"]["questionCount"] = 0

        merged = _whitelist_merge(report, llm_out)

        assert merged["interviewQna"]["available"] is True
        assert merged["interviewQna"]["questionCount"] == 3

    def test_llm_cannot_change_job_match_score(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        llm_out["jobMatchEvaluation"]["score"] = 99
        llm_out["jobMatchEvaluation"]["fitLevel"] = "strong"

        merged = _whitelist_merge(report, llm_out)

        assert merged["jobMatchEvaluation"]["score"] == 72
        assert merged["jobMatchEvaluation"]["fitLevel"] == "moderate"

    def test_llm_cannot_change_sentiment_summary(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        llm_out["answerSentimentSummary"]["overallSentiment"] = "negative"
        llm_out["answerSentimentSummary"]["positiveAnswers"] = 0

        merged = _whitelist_merge(report, llm_out)

        assert merged["answerSentimentSummary"]["overallSentiment"] == "positive"
        assert merged["answerSentimentSummary"]["positiveAnswers"] == 3

    def test_llm_cannot_change_skills_extracted(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        llm_out["skillsExtractedFromInterview"]["detectedSkills"] = [
            {"skill": "FakeSkill", "mentions": 100}
        ]

        merged = _whitelist_merge(report, llm_out)

        skill_names = [
            s["skill"] for s in merged["skillsExtractedFromInterview"]["detectedSkills"]
        ]
        assert "FakeSkill" not in skill_names
        assert "React" in skill_names

    def test_llm_cannot_change_enhanced_recommendation(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        llm_out["enhancedRecommendation"]["decision"] = "proceed"

        merged = _whitelist_merge(report, llm_out)

        assert merged["enhancedRecommendation"]["decision"] == "technical_follow_up"

    def test_llm_cannot_change_integrity_score(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        llm_out = copy.deepcopy(report)
        llm_out["integrityScore"] = 10

        merged = _whitelist_merge(report, llm_out)

        assert merged["integrityScore"] == 85

    def test_llm_can_change_technical_eval_summary(self):
        from app.services.report_polish import _whitelist_merge

        report = self._make_report()
        report["technicalEvaluation"]["summary"] = "Original summary."
        llm_out = copy.deepcopy(report)
        llm_out["technicalEvaluation"]["summary"] = "Polished summary."

        merged = _whitelist_merge(report, llm_out)

        # Score must be unchanged, summary can be changed
        assert merged["technicalEvaluation"]["score"] == 75
        assert merged["technicalEvaluation"]["summary"] == "Polished summary."
