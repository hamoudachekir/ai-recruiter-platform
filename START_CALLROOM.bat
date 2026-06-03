@echo off
REM ============================================================================
REM  START_CALLROOM.bat  — one double-click to launch the FULL call-room stack
REM ============================================================================
REM  Starts Node backend + Frontend + speech stack + interview agent + face
REM  verification + YOLO + analysis service, each in its own window, and
REM  health-checks them. Run this in YOUR OWN session (double-click or from a
REM  normal terminal) so the services stay up for the whole interview.
REM
REM  Leave the service windows open while you test. Re-run this file to restart.
REM ============================================================================
cd /d "%~dp0"
echo Launching the full AI call-room stack...
echo (Node, Frontend, Speech 8012, Agent 8013, Face 8011, YOLO 8001, Analysis 8090)
echo.
powershell -ExecutionPolicy Bypass -File "Backend\scripts\run_call_room_full_stack.ps1"
echo.
echo ============================================================================
echo  Stack launch finished. The services run in their own minimized windows.
echo  Keep them open. To restart everything, just run this file again.
echo ============================================================================
pause
