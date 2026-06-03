from flask import Flask, request, jsonify
import pickle
import pandas as pd
from flask_cors import CORS

# Compatibility shims for loading a model pickled with scikit-learn 1.6.1 on a
# newer runtime (1.8.x) — the only scikit-learn that ships Python 3.14 wheels.
import numpy as np
import sklearn.compose._column_transformer as _ct
from sklearn.impute import SimpleImputer

# (1) ColumnTransformer in 1.6.1 stored remainder columns as the private
#     _RemainderColsList type, which was removed in 1.7+. Re-register a
#     stand-in so the pickle can be reconstructed.
if not hasattr(_ct, "_RemainderColsList"):
    class _RemainderColsList(list):
        pass
    _ct._RemainderColsList = _RemainderColsList


def _repair_estimator(obj, _seen=None):
    """Backfill attributes added after 1.6.1 so transform/predict work.

    SimpleImputer gained a private ``_fill_dtype`` attribute (set during fit)
    that 1.8.x's transform path requires. Pickles from 1.6.1 lack it, so we
    reconstruct it from the learned ``statistics_`` dtype. Walks nested
    Pipelines / ColumnTransformers to reach every imputer.
    """
    if _seen is None:
        _seen = set()
    if id(obj) in _seen:
        return
    _seen.add(id(obj))
    if isinstance(obj, SimpleImputer) and not hasattr(obj, "_fill_dtype"):
        stats = getattr(obj, "statistics_", np.array([], dtype=np.float64))
        obj._fill_dtype = stats.dtype
    for attr in ("steps", "transformers_", "transformers", "named_steps", "estimators_"):
        value = getattr(obj, attr, None)
        if value is None:
            continue
        items = value.values() if isinstance(value, dict) else value
        for item in items:
            if isinstance(item, (tuple, list)):
                for sub in item:
                    if isinstance(sub, SimpleImputer) or hasattr(sub, "__dict__"):
                        _repair_estimator(sub, _seen)
            elif hasattr(item, "__dict__"):
                _repair_estimator(item, _seen)

app = Flask(__name__)
CORS(app)

# Load the trained model
with open('interview_score_model.pkl', 'rb') as f:
    model = pickle.load(f)
_repair_estimator(model)

@app.route('/predict', methods=['POST'])
def predict():
    data = request.json

    # Ensure the input data includes all required features
    df = pd.DataFrame([{
        'domain_x': data.get('domain_match', 0),
        'experience_years': data.get('experience_years', 0),
        'education': data.get('education_match', 0),  # Adjust if needed
        'location_x': data.get('location', 0),
        'exp_match': data.get('experience_match', 0),
        'skill_match': data.get('skill_match', 0),  # Added this field
        'education_match': data.get('education_match', 0)  # Added this field
    }])

    # Print the dataframe to verify it's correctly structured
    print(f"Input DataFrame: {df}")

    # Handle missing values more explicitly
    df.fillna(0, inplace=True)  # Replace NaN values with 0 (or another suitable value)

    # Ensure that all columns are of the correct type
    df['domain_x'] = df['domain_x'].astype(int)
    df['experience_years'] = df['experience_years'].astype(int)
    df['education'] = df['education'].astype(int)
    df['location_x'] = df['location_x'].astype(int)
    df['exp_match'] = df['exp_match'].astype(int)
    df['skill_match'] = df['skill_match'].astype(int)
    df['education_match'] = df['education_match'].astype(int)

    # Print the cleaned dataframe for debugging
    print(f"Cleaned DataFrame: {df}")

    # Check if there are any NaN values after processing
    if df.isna().sum().sum() > 0:
        return jsonify({'error': 'Data contains NaN values after processing'}), 400

    try:
        # Make prediction
        prediction = model.predict(df)

        # Ensure score is between 0 and 1
        score = max(0, min(1, float(prediction[0])))

        return jsonify({'interview_score': score})
    except Exception as e:
        # Return an error response if prediction fails
        print(f"Error during prediction: {str(e)}")
        return jsonify({'error': 'Prediction failed', 'message': str(e)}), 500

if __name__ == '__main__':
    app.run(port=7000)
