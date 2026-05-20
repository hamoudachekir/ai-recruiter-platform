import sys
sys.path.insert(0, 'Backend/analysis_service')

from app.services.report_service import build_final_report

# Test with transcript
report = build_final_report(
    interview_id='test-456',
    candidate_name='Jane Smith',
    job_title='Senior Python Developer',
    duration_seconds=600,
    transcript_payload={
        'transcriptionAvailable': True,
        'fullText': 'I have 5 years of Python experience. I worked with Django and FastAPI. I enjoy building scalable systems.',
        'segments': [
            {'start': 0, 'end': 5, 'text': 'I have 5 years of Python experience.'},
            {'start': 6, 'end': 10, 'text': 'I worked with Django and FastAPI.'},
            {'start': 11, 'end': 15, 'text': 'I enjoy building scalable systems.'}
        ],
    },
    live_vision_summary={
        'totalChecks': 200,
        'faceDetectedChecks': 190,
    },
    post_vision_summary={
        'totalChecks': 100,
        'faceDetectedChecks': 95,
    },
    live_events=[],
    post_events=[],
    silence_events=[{'start': 30, 'end': 33, 'duration': 3.5}],
    quiz_score=85.0,
    cv_job_match_score=None,
    job_metadata_status='linked'
)

print('Evidence Summary:')
evidence = report['evidenceSummary']
print(f'  usableTranscript: {evidence["usableTranscript"]}')
print(f'  evidenceLevel: {evidence["evidenceLevel"]}')
print(f'  transcriptWords: {evidence["transcriptWords"]}')
print(f'  speechSegments: {evidence["speechSegments"]}')
print()
print('Recruiter Decision:')
decision = report['recruiterDecisionSummary']
print(f'  decision: {decision["decision"]}')
print(f'  oneSentenceSummary: {decision["oneSentenceSummary"]}')
print(f'  whyThisDecision count: {len(decision.get("whyThisDecision", []))}')
print()
print('Job Fit:')
job_fit = report['jobFitAnalysis']
print(f'  fitLevel: {job_fit["fitLevel"]}')
print(f'  summary: {job_fit["summary"]}')
print()
print('Job Metadata Status:', report['jobMetadataStatus'])
