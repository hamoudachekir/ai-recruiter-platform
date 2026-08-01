#!/bin/sh
set -eu

cd /app/Backend/server/AI

export CLUSTERING_PORT="${CLUSTERING_PORT:-5006}"
export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="${PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION:-python}"

python iA4.py &
python hiring_model.py &
python recommendation_service.py &
python interview_score_model.py &
python clustering.py &
python quiz_generation_service.py &

wait -n
exit $?
