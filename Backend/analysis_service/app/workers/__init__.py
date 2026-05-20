"""Phase 5 async worker package.

Redis-backed job queues using RQ (Redis Queue).

Queues (by priority):
  high      transcription, report_generation
  default   ml_training, replay_jobs
  low       ats_exports, ml_monitoring

Workers are started independently:
  rq worker high default low --url redis://localhost:6379
"""
