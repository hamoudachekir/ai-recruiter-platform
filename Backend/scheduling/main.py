#!/usr/bin/env python3
"""
Entry point for the Interview Scheduling Service.
Run with: python main.py
Or: uvicorn main:app --reload
"""

import sys
import os

# Add app directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.main import app

if __name__ == "__main__":
    import uvicorn
    from app.config import get_settings
    
    settings = get_settings()
    
    uvicorn.run(
        app,
        host=settings.service_host,
        port=settings.service_port,
        reload=settings.debug,
        log_level=settings.log_level.lower()
    )
