from flask import Flask, request, jsonify
import joblib
import numpy as np
from flask_cors import CORS
import re
from datetime import datetime

app = Flask(__name__)
CORS(app)

model = joblib.load('hiring_model.pkl')
scaler = joblib.load('scaler.pkl')

# Weights used for the recruiter-facing "Profile vs Job" percentage.
MATCH_WEIGHT_SKILL = 0.55
MATCH_WEIGHT_EXPERIENCE = 0.3
MATCH_WEIGHT_EDUCATION = 0.15

NODE_JS_CANONICAL = 'node.js'

# Normalized synonym map to improve overlap quality for common tech aliases.
SKILL_SYNONYMS = {
    'js': 'javascript',
    'javascript': 'javascript',
    'ecmascript': 'javascript',
    'ts': 'typescript',
    'typescript': 'typescript',
    'node': NODE_JS_CANONICAL,
    'nodejs': NODE_JS_CANONICAL,
    'nodej': NODE_JS_CANONICAL,
    'reactjs': 'react',
    'react': 'react',
    'vuejs': 'vue',
    'vue': 'vue',
    'expressjs': 'express',
    'express': 'express',
    'mongo': 'mongodb',
    'mongodb': 'mongodb',
    'postgres': 'postgresql',
    'postgresql': 'postgresql',
    'python3': 'python',
    'py': 'python',
    'csharp': 'c#',
    'dotnet': '.net',
}


def _to_float(value, default):
    try:
        if isinstance(value, list):
            value = value[0] if value else default
        if value in (None, ""):
            return float(default)
        return float(value)
    except Exception:
        return float(default)


def _skill_lookup_key(raw_value):
    text = str(raw_value or '').lower().strip()
    return re.sub(r'[^a-z0-9+#]', '', text)


def _canonicalize_skill(raw_value):
    text = str(raw_value or '').lower().strip()
    if not text:
        return ''

    key = _skill_lookup_key(text)
    if key in SKILL_SYNONYMS:
        return SKILL_SYNONYMS[key]

    collapsed = re.sub(r'\s+', ' ', text)
    return collapsed


def _parse_date_value(raw_value):
    if raw_value in (None, ''):
        return None

    value = str(raw_value).strip()
    candidate_formats = (
        '%Y-%m-%d',
        '%Y/%m/%d',
        '%Y-%m',
        '%Y/%m',
        '%m/%Y',
        '%Y',
    )

    for fmt in candidate_formats:
        try:
            return datetime.strptime(value, fmt)
        except Exception:
            continue

    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def _duration_from_dates(start_value, end_value):
    start_date = _parse_date_value(start_value)
    if start_date is None:
        return None

    now_value = datetime.now()

    if str(end_value or '').strip().lower() in {'present', 'current', 'now', 'aujourd\'hui'}:
        end_date = now_value
    else:
        end_date = _parse_date_value(end_value) or now_value

    if end_date <= start_date:
        return 0.0

    return (end_date - start_date).days / 365.0


def _parse_experience_text(value):
    text = str(value or '').strip().lower()
    if not text:
        return None

    year_match = re.search(r'(\d+(?:[\.,]\d+)?)\s*(?:years?|yrs?|ans?|annees?|ann\u00e9es?)', text)
    month_match = re.search(r'(\d+(?:[\.,]\d+)?)\s*(?:months?|mos?|mois)', text)
    week_match = re.search(r'(\d+(?:[\.,]\d+)?)\s*(?:weeks?|wks?)', text)
    day_match = re.search(r'(\d+(?:[\.,]\d+)?)\s*days?', text)

    if year_match or month_match or week_match or day_match:
        years_part = float(str(year_match.group(1)).replace(',', '.')) if year_match else 0.0
        months_part = float(str(month_match.group(1)).replace(',', '.')) / 12.0 if month_match else 0.0
        weeks_part = float(str(week_match.group(1)).replace(',', '.')) / 52.0 if week_match else 0.0
        days_part = float(str(day_match.group(1)).replace(',', '.')) / 365.0 if day_match else 0.0
        return years_part + months_part + weeks_part + days_part

    numeric_chunks = re.findall(r'\d+(?:[\.,]\d+)?', text)
    if not numeric_chunks:
        return None

    parsed_values = [float(chunk.replace(',', '.')) for chunk in numeric_chunks]
    return max(parsed_values)


def _aggregate_experience_values(values):
    valid = [item for item in values if item is not None]
    if not valid:
        return None
    return min(sum(valid), 50.0)


def _extract_experience_from_dict(value):
    preferred_keys = (
        'totalYears',
        'total_years',
        'years',
        'year',
        'experience',
        'duration',
        'period',
        'value',
    )
    for key in preferred_keys:
        if key in value:
            parsed = _extract_experience_years(value.get(key))
            if parsed is not None:
                return parsed

    nested_list_keys = ('experiences', 'items', 'history')
    for key in nested_list_keys:
        nested = value.get(key)
        if isinstance(nested, list):
            parsed = _aggregate_experience_values([
                _extract_experience_years(item)
                for item in nested
            ])
            if parsed is not None:
                return parsed

    return _duration_from_dates(
        value.get('startDate') or value.get('start_date') or value.get('from'),
        value.get('endDate') or value.get('end_date') or value.get('to'),
    )


def _extract_experience_from_sequence(value):
    return _aggregate_experience_values([
        _extract_experience_years(item)
        for item in value
    ])


def _extract_experience_years(value):
    if value in (None, ''):
        return None

    if isinstance(value, (int, float)):
        return max(0.0, float(value))

    if isinstance(value, str):
        return _parse_experience_text(value)

    if isinstance(value, dict):
        return _extract_experience_from_dict(value)

    if isinstance(value, (list, tuple, set)):
        return _extract_experience_from_sequence(value)

    return None


def _to_experience_years(value, default):
    parsed = _extract_experience_years(value)
    if parsed is None:
        return float(default)
    return max(0.0, float(parsed))


@app.route('/predict-from-skills', methods=['POST'])
def predict_from_skills():
    try:
        data = request.get_json(silent=True) or {}

        candidate_skills = data.get('candidate_skills', []) or []
        job_skills = data.get('job_skills', []) or []
        candidate_exp = _to_experience_years(data.get('candidate_exp', 0), 0)
        required_exp = _to_experience_years(data.get('required_exp', 1), 1)
        candidate_edu = str(data.get('candidate_education', '') or '')
        required_edu = str(data.get('required_education', '') or '')

        skill_match = calculate_skill_match(candidate_skills, job_skills)
        exp_match = calculate_experience_match(candidate_exp, required_exp)
        education_match = calculate_education_match(candidate_edu, required_edu)
        match_percent = calculate_match_percent(skill_match, exp_match, education_match)

        input_data = np.array([[skill_match, exp_match, education_match]])
        input_scaled = scaler.transform(input_data)

        prediction = model.predict(input_scaled)
        confidence = float(np.max(model.predict_proba(input_scaled)[0]))

        return jsonify({
            'hired': int(prediction[0]),
            'confidence': confidence,
            'match_percent': match_percent,
            'match_breakdown': {
                'skill': round(skill_match * 100, 2),
                'exp': round(exp_match * 100, 2),
                'education': round(education_match * 100, 2)
            },
            'matches': {
                'skill_match': skill_match,
                'exp_match': exp_match,
                'education_match': education_match
            },
            'normalized_inputs': {
                'candidate_exp_years': round(candidate_exp, 2),
                'required_exp_years': round(required_exp, 2),
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
    candidate_skills = {
        _canonicalize_skill(skill)
        for skill in candidate_skills
        if _canonicalize_skill(skill)
    }
    job_skills = {
        _canonicalize_skill(skill)
        for skill in job_skills
        if _canonicalize_skill(skill)
    }
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


def calculate_match_percent(skill_match, exp_match, education_match):
    # Weighted score prioritizes concrete skill overlap while keeping exp/education signals.
    weighted_score = (
        (MATCH_WEIGHT_SKILL * float(skill_match))
        + (MATCH_WEIGHT_EXPERIENCE * float(exp_match))
        + (MATCH_WEIGHT_EDUCATION * float(education_match))
    )
    clamped = max(0.0, min(1.0, weighted_score))
    return round(clamped * 100, 2)


if __name__ == '__main__':
    app.run(port=5000)