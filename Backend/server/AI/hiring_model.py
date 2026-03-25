from flask import Flask, request, jsonify
import joblib
import numpy as np
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

model = joblib.load('hiring_model.pkl')
scaler = joblib.load('scaler.pkl')


def _to_float(value, default):
    try:
        if isinstance(value, list):
            value = value[0] if value else default
        if value in (None, ""):
            return float(default)
        return float(value)
    except Exception:
        return float(default)


@app.route('/predict-from-skills', methods=['POST'])
def predict_from_skills():
    try:
        data = request.get_json(silent=True) or {}

        candidate_skills = data.get('candidate_skills', []) or []
        job_skills = data.get('job_skills', []) or []
        candidate_exp = _to_float(data.get('candidate_exp', 0), 0)
        required_exp = _to_float(data.get('required_exp', 1), 1)
        candidate_edu = str(data.get('candidate_education', '') or '')
        required_edu = str(data.get('required_education', '') or '')

        skill_match = calculate_skill_match(candidate_skills, job_skills)
        exp_match = calculate_experience_match(candidate_exp, required_exp)
        education_match = calculate_education_match(candidate_edu, required_edu)

        input_data = np.array([[skill_match, exp_match, education_match]])
        input_scaled = scaler.transform(input_data)

        prediction = model.predict(input_scaled)
        confidence = float(np.max(model.predict_proba(input_scaled)[0]))

        return jsonify({
            'hired': int(prediction[0]),
            'confidence': confidence,
            'matches': {
                'skill_match': skill_match,
                'exp_match': exp_match,
                'education_match': education_match
            },
            'status': 'success'
        })
    except Exception as e:
        return jsonify({
            'error': str(e),
            'status': 'failed'
        }), 500


def calculate_skill_match(candidate_skills, job_skills):
    if not candidate_skills or not job_skills:
        return 0
    candidate_skills = set(str(skill).lower().strip() for skill in candidate_skills)
    job_skills = set(str(skill).lower().strip() for skill in job_skills)
    matches = sum(1 for skill in job_skills if skill in candidate_skills)
    return matches / len(job_skills) if job_skills else 0


def calculate_experience_match(candidate_exp, required_exp):
    if required_exp == 0:
        return 1
    return min(1, candidate_exp / required_exp)


def calculate_education_match(candidate_edu, required_edu):
    education_levels = {
        'high school': 1,
        'bachelor': 2,
        'master': 3,
        'phd': 4
    }
    candidate_level = education_levels.get(str(candidate_edu).lower().strip(), 0)
    required_level = education_levels.get(str(required_edu).lower().strip(), 0)
    if candidate_level >= required_level:
        return 1
    if candidate_level >= required_level - 1:
        return 0.5
    return 0


if __name__ == '__main__':
    app.run(port=5000)