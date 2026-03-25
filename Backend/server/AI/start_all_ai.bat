@echo off
echo Starting all AI Microservices...

cd /d "%~dp0"

set "VENV_PY=..\..\..\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
	set "VENV_PY=python"
)

start "Parseur CV (Port 5002)" cmd /k "\"%VENV_PY%\" iA4.py"
start "Hiring Model (Port 5000)" cmd /k "\"%VENV_PY%\" hiring_model.py"
start "Recommendation (Port 5001)" cmd /k "\"%VENV_PY%\" recommendation_service.py"
start "Interview Score (Port 7000)" cmd /k "\"%VENV_PY%\" interview_score_model.py"
start "Clustering" cmd /k "\"%VENV_PY%\" clustering.py"
start "Quiz Generation (Port 5003)" cmd /k "\"%VENV_PY%\" quiz_generation_service.py"

echo All AI servers are launching in separate windows!
    