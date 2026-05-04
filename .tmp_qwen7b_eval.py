import json
import requests

BASE = "http://localhost:8013"
TIMEOUT = 120
IID = "qwen7b-eval-001"

start_payload = {
    "interview_id": IID,
    "phase": "intro",
    "job_title": "Full Stack Developer",
    "job_skills": ["Python", "React", "Node.js", "SQL"],
    "job_description": "Recruiter RH interview for a full-stack role",
    "candidate_name": "hamouda",
    "candidate_profile": {"skills": ["Python", "React"]}
}

turns = [
    "Thank you. POSITIVE hey my name is hamouda chekir 25 yearss and full sstack developpeur",
    "can u tell me what is my age",
    "i use python and react",
    "i use python and react",
    "i use python and react"
]

def post(path, payload):
    r = requests.post(BASE + path, json=payload, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()

try:
    start = post('/session/start', start_payload)
    print('START=' + json.dumps(start.get('agent_message', {}), ensure_ascii=False))

    rows = []
    for msg in turns:
        resp = post('/session/turn', {"interview_id": IID, "text": msg})
        agent = resp.get('agent_message', {})
        score = (resp.get('scoring') or {})
        rows.append({
            'input': msg,
            'question': agent.get('text'),
            'difficulty': agent.get('difficulty'),
            'skill_focus': agent.get('skill_focus'),
            'reasoning': score.get('reasoning'),
        })

    for i, row in enumerate(rows, start=1):
        print(f"TURN_{i}_INPUT={row['input']}")
        print(f"TURN_{i}_QUESTION={row['question']}")
        print(f"TURN_{i}_D={row['difficulty']} SKILL={row['skill_focus']}")
        print(f"TURN_{i}_REASON={row['reasoning']}")

    uniq = len(set((r['question'] or '').strip() for r in rows))
    print(f"UNIQUE_QUESTIONS={uniq}/{len(rows)}")

finally:
    try:
        end = post('/session/end', {"interview_id": IID})
        print('END=' + json.dumps({k: end.get(k) for k in ['interview_id','phase','turn_index','ended']}, ensure_ascii=False))
    except Exception as exc:
        print('END_ERROR=' + str(exc))
