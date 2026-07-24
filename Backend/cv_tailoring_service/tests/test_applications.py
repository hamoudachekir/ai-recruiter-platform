from app.applications import list_applications, save_analysis, update_application
from app.schema import ApplicationUpdate, FitAnalysis


def test_save_list_and_update_application(monkeypatch, tmp_path):
    monkeypatch.setenv("CV_COPILOT_DB", str(tmp_path / "copilot.sqlite3"))
    analysis = FitAnalysis(score=72, recommendation="apply", matched_skills=["Python"])

    created = save_analysis(
        candidate_id="candidate-1",
        job_text="Python engineer needed for a FastAPI platform.",
        analysis=analysis,
        job_title="Python Engineer",
        company="Example",
    )

    assert created.id > 0
    assert created.status == "discovered"
    assert list_applications("other") == []
    assert list_applications("candidate-1")[0].company == "Example"

    updated = update_application(
        created.id,
        "candidate-1",
        ApplicationUpdate(status="applied", notes="Applied on company website"),
    )
    assert updated is not None
    assert updated.status == "applied"
    assert updated.notes == "Applied on company website"


def test_update_is_scoped_to_candidate(monkeypatch, tmp_path):
    monkeypatch.setenv("CV_COPILOT_DB", str(tmp_path / "copilot.sqlite3"))
    analysis = FitAnalysis(score=50, recommendation="consider")
    created = save_analysis("owner", "A sufficiently long job description.", analysis)

    assert update_application(
        created.id,
        "not-owner",
        ApplicationUpdate(status="applied"),
    ) is None
