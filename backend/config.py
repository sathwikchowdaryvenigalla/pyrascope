"""Environment-driven configuration. Secrets live in .env (git-ignored), never in code."""
import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _clean(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def gee_project_id() -> str | None:
    return _clean("GEE_PROJECT_ID")


def gee_service_account() -> str | None:
    """Optional: service-account email (for servers; local dev uses `ee.Authenticate()`)."""
    return _clean("GEE_SERVICE_ACCOUNT")


def gee_private_key_file() -> str | None:
    """Optional: PATH to a service-account JSON key stored OUTSIDE the repo."""
    return _clean("GEE_PRIVATE_KEY_FILE")


def cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    return [o.strip() for o in raw.split(",") if o.strip()]


def max_query_days() -> int:
    return int(os.getenv("GEE_MAX_QUERY_DAYS", "31"))


def max_bbox_degrees() -> float:
    return float(os.getenv("GEE_MAX_BBOX_DEGREES", "30"))


def max_viirs_bbox_degrees() -> float:
    """VIIRS is 375 m (much denser than MODIS 1 km), so its bbox cap is tighter."""
    return float(os.getenv("GEE_VIIRS_MAX_BBOX_DEGREES", "10"))


def max_harmonization_pixels() -> int:
    """Max fire pixels retrieved PER SOURCE for harmonization (queries above this are refused, never truncated)."""
    return int(os.getenv("GEE_HARMONIZATION_MAX_PIXELS", "5000"))


def harmonization_cache_ttl_s() -> int:
    return int(os.getenv("GEE_HARMONIZATION_CACHE_TTL_S", "600"))


def max_candidate_pairs() -> int:
    return int(os.getenv("HARMONIZATION_MAX_CANDIDATE_PAIRS", "200000"))


def max_history_bbox_degrees() -> float:
    """Historical (monthly-aggregated, 1 km) queries allow larger areas than the live record listing."""
    return float(os.getenv("GEE_HISTORY_MAX_BBOX_DEGREES", "30"))


def history_workers() -> int:
    return int(os.getenv("GEE_HISTORY_WORKERS", "4"))


def history_max_records() -> int:
    """Max individual observation records returned PER SENSOR FAMILY for the historical globe (strongest FRP kept if exceeded)."""
    return int(os.getenv("GEE_HISTORY_MAX_RECORDS", "5000"))
