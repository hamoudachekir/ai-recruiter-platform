import subprocess
import sys
import time

def start_services():
    print("Starting all AI Microservices...")
    
    # List of python scripts to run
    services = [
        {"name": "Parseur CV (Port 5002)", "script": "iA4.py"},
        {"name": "Hiring Model (Port 5000)", "script": "hiring_model.py"},
        {"name": "Recommendation (Port 5001)", "script": "recommendation_service.py"},
        {"name": "Interview Score (Port 7000)", "script": "interview_score_model.py"},
        {"name": "Clustering", "script": "clustering.py"},
        {"name": "Quiz Generation (Port 5003)", "script": "quiz_generation_service.py"}
    ]
    
    processes = []
    
    for service in services:
        print(f"Starting {service['name']}...")
        # Start each script in the background
        process = subprocess.Popen([sys.executable, service['script']])
        processes.append(process)
        time.sleep(1) # Small delay to prevent output overlapping during startup
        
    print("\n✅ All 5 AI microservices are running in the background!")
    print("Press Ctrl+C to stop all services.\n")
    
    try:
        # Keep the main script running
        for process in processes:
            process.wait()
    except KeyboardInterrupt:
        print("\nStopping all services...")
        for process in processes:
            process.terminate()
        print("All services stopped.")

if __name__ == "__main__":
    start_services()