"""
run.py
------
Entry point for running the Flask development server directly
(without Docker / Gunicorn).

Usage:
    python run.py
"""

import os
from dotenv import load_dotenv

# Load .env before importing the app so config picks up values
load_dotenv()

from app import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("FLASK_PORT", 5000))
    debug = os.environ.get("FLASK_ENV", "development") == "development"
    app.run(host="0.0.0.0", port=port, debug=debug)
