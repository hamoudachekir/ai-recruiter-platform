from app.core.config import MONGO_DB_NAME, MONGO_URL
from pymongo import MongoClient

_client = MongoClient(MONGO_URL)
db = _client[MONGO_DB_NAME]

jobs_col = db["video_analysis_jobs"]
vision_events_col = db["post_interview_vision_events"]
transcripts_col = db["interview_transcripts"]
reports_col = db["interview_final_reports"]
call_rooms_col = db["callrooms"]
pipeline_snapshots_col = db["interview_pipeline_snapshots"]
behavioral_events_col = db["interview_behavioral_events"]
behavioral_audit_logs_col = db["interview_behavioral_audit_logs"]
audit_logs_col = db["interview_audit_logs"]
ml_dataset_col = db["interview_ml_dataset"]
ml_ab_metrics_col = db["ml_ab_test_metrics"]

# Phase 4.5 — Operational Governance collections
ml_shadow_results_col = db["ml_shadow_results"]
ml_feature_drift_metrics_col = db["ml_feature_drift_metrics"]
manual_review_queue_col = db["manual_review_queue"]
ml_model_monitoring_col = db["ml_model_monitoring"]
replay_evaluation_results_col = db["replay_evaluation_results"]

# Phase 5 — Enterprise SaaS collections
tenants_col = db["tenants"]
tenant_configs_col = db["tenant_configs"]
billing_events_col = db["billing_events"]
rbac_roles_col = db["rbac_roles"]
ats_sync_logs_col = db["ats_sync_logs"]
ranking_results_col = db["ranking_results"]
copilot_sessions_col = db["copilot_sessions"]
realtime_sessions_col = db["realtime_sessions"]

# Recruiter-only behavioral timeline overlay (DeepFace).
# Isolated from existing behavioral_events_col / behavioral_audit_logs_col so the
# new advisory pipeline shares no state with the legacy fer/mediapipe pipeline.
behavioral_timeline_events_col = db["interview_behavioral_timeline_events"]
behavioral_timeline_heatmap_col = db["interview_behavioral_timeline_heatmap"]
behavioral_timeline_audit_col = db["interview_behavioral_timeline_audit"]
