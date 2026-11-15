"""One-time local sign-in:  python -m backend.authenticate_gee"""
import ee

from backend import config

project = config.gee_project_id()
if not project:
    raise SystemExit("GEE_PROJECT_ID is not set. Copy .env.example to .env and fill it in.")

ee.Authenticate()            # opens browser; stores a refresh token in your user profile (not in this repo)
ee.Initialize(project=project)
print(f"Earth Engine initialized for project '{project}'. Credentials are stored outside this repo.")
