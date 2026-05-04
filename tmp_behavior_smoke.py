from Backend.voice_engine.interview_agent.interview_engine import InterviewEngine
from Backend.voice_engine.interview_agent.llm_client import EchoClient

engine = InterviewEngine(EchoClient())
interview_id = "smoke-test"

start = engine.start(
    interview_id,
    job_title="Full Stack Developer",
    job_skills=["python", "react"],
    candidate_name="hamouda chekir",
)

printed = []

start_text = str(start.get("question", "")).strip()
printed.append(("START", start_text))
print(f"START_AGENT: {start_text}")

turns = [
    "hey my name is hamouda chekir 25 yearss and full sstack developpeur",
    "can u tell me what is my age",
    "i use python and react",
    "i use python and react",
]

responses = []
for idx, user_text in enumerate(turns, start=1):
    out = engine.candidate_turn(interview_id, text=user_text)
    agent_text = str(out.get("question", "")).strip()
    responses.append(agent_text)
    printed.append((f"TURN{idx}", agent_text))
    print(f"TURN{idx}_AGENT: {agent_text}")

age_ok = "25" in responses[1]
no_d_tokens = all(("D1" not in text and "D2" not in text) for _, text in printed)
repeat_followup_ok = (
    responses[3] != responses[2]
    and "concrete" in responses[3].lower()
    and "let's refocus" not in responses[3].lower()
)

status = "PASS" if (age_ok and no_d_tokens and repeat_followup_ok) else "FAIL"
print(f"RESULT: {status}")
print(f"CHECK_age_contains_25: {age_ok}")
print(f"CHECK_no_D1_D2_tokens: {no_d_tokens}")
print(f"CHECK_repeat_low_info_followup: {repeat_followup_ok}")
