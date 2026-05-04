import json
import requests

BASE = "http://localhost:8013"
IID = "typed-test-001"

start_payload = {
    "interview_id": IID,
    "phase": "intro",
    "job_title": "Data Engineer",
    "job_skills": ["Python", "SQL", "ETL", "Airflow"],
    "job_description": "Recruiter: Talan, data platform role",
    "candidate_name": "hamouda",
    "candidate_profile": {
        "skills": ["Python", "SQL", "ETL"],
        "summary": "Junior data engineer with ETL practice"
    }
}
turns = [
    "i don't",
    "Did you hear me?",
    "can you explain for me what is the motivation",
    "Can you tell me something about you?",
    "Okay, I applied because I like data engineering and I built ETL pipelines with Python and SQL."
]


def post(path, payload):
    r = requests.post(BASE + path, json=payload, timeout=30)
    print(f"POST {path} -> {r.status_code}")
    if r.status_code >= 400:
        print("ERROR_BODY=" + r.text)
    r.raise_for_status()
    return r.json()

start_resp = post('/session/start', start_payload)
print('START_AGENT=' + json.dumps(start_resp.get('agent_message', {}), ensure_ascii=False))

rows = []
for msg in turns:
    tr = post('/session/turn', {"interview_id": IID, "text": msg})
    agent = tr.get('agent_message', {}) if isinstance(tr, dict) else {}
    rows.append({
        "turn_input": msg,
        "question_text": agent.get('text') or tr.get('question') or tr.get('text'),
        "difficulty": agent.get('difficulty') or tr.get('difficulty'),
        "skill_focus": agent.get('skill_focus') or tr.get('skill_focus'),
        "reasoning": (tr.get('scoring') or {}).get('reasoning') if isinstance(tr, dict) else None
    })

print('TURNS_BEGIN')
for r in rows:
    print(f"turn input: {r['turn_input']}")
    print(f"question text: {r['question_text']}")
    print(f"difficulty: {r['difficulty']}")
    print(f"skill_focus: {r['skill_focus']}")
    print(f"reasoning: {r['reasoning']}")
    print('---')
print('TURNS_END')

texts = [r['question_text'] or '' for r in rows]
uniq = len(set(texts))
adaptive = 'adaptive' if uniq >= 3 else 'repetitive'
print(f"ADAPTIVENESS={adaptive} unique_questions={uniq}/{len(texts)}")

end_resp = post('/session/end', {"interview_id": IID})
print('END=' + json.dumps(end_resp, ensure_ascii=False))
