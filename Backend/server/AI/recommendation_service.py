from flask import Flask, request, jsonify
from job_recommender import JobRecommender
from flask_cors import CORS
import os

app = Flask(__name__)
CORS(app)
recommender = JobRecommender()

@app.route('/recommend', methods=['POST'])
def recommend():
    data = request.json
    candidate_id = data.get('candidate_id')
    top_k = data.get('top_k', 5)
    threshold = data.get('threshold', 0.3)

    if not candidate_id:
        return jsonify({"error": "candidate_id is required"}), 400

    results = recommender.recommend_jobs(candidate_id, top_k, threshold)
    return jsonify(results)

@app.route('/refresh-index', methods=['POST'])
def refresh_index():
    """Force refresh the job index immediately"""
    try:
        recommender.update_job_index(force=True)
        return jsonify({
            "success": True,
            "message": f"Job index refreshed with {len(recommender.job_ids)} jobs"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "running",
        "jobs_indexed": len(recommender.job_ids),
        "last_update": recommender.last_update
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)