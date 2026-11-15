from datetime import date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend.services.gee_service import GeeError
from backend.services.harmonization_service import format_compare, format_summary
from backend.services.observation_retrieval import get_harmonized

router = APIRouter(prefix="/api/harmonization", tags=["harmonization"])


def _common(start_date, end_date, min_lon, min_lat, max_lon, max_lat, spatial, temporal, tol):
    return get_harmonized(start_date, end_date, (min_lon, min_lat, max_lon, max_lat), spatial, temporal, tol)


@router.get("/compare")
def compare(
    start_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    end_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    spatial_threshold_km: float = Query(1.0, gt=0, le=25),
    temporal_threshold_minutes: float = Query(30, ge=0, le=1440),
    date_tolerance_days: int = Query(0, ge=0, le=3, description="Allowed difference in image date"),
    include_observations: bool = Query(False),
    max_details: int = Query(200, ge=0, le=2000, description="Max pairs / ids / observations listed"),
):
    """Compare MODIS and VIIRS observations. Pairs are POTENTIAL relationships only."""
    try:
        h = _common(start_date, end_date, min_lon, min_lat, max_lon, max_lat,
                    spatial_threshold_km, temporal_threshold_minutes, date_tolerance_days)
        return format_compare(h, include_observations, max_details)
    except GeeError as e:
        return JSONResponse(status_code=e.status_code, content=e.to_dict())


@router.get("/summary")
def summary(
    start_date: date = Query(...), end_date: date = Query(...),
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    spatial_threshold_km: float = Query(1.0, gt=0, le=25),
    temporal_threshold_minutes: float = Query(30, ge=0, le=1440),
    date_tolerance_days: int = Query(0, ge=0, le=3),
):
    """Counts by source/date/platform plus candidate and unmatched counts (no fire events are identified)."""
    try:
        h = _common(start_date, end_date, min_lon, min_lat, max_lon, max_lat,
                    spatial_threshold_km, temporal_threshold_minutes, date_tolerance_days)
        return format_summary(h)
    except GeeError as e:
        return JSONResponse(status_code=e.status_code, content=e.to_dict())
