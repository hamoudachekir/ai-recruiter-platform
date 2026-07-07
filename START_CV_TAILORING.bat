@echo off
REM Double-click to start the CV Tailoring microservice (port 8014).
powershell -ExecutionPolicy Bypass -File "%~dp0Backend\cv_tailoring_service\run_cv_tailoring.ps1"
pause
