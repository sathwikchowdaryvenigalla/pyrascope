from datetime import date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend.services import history_service as hs
from backend.services.gee_service import GeeError

router = APIRouter(prefix="/api/history", tags=["history"])
RANGE_PATTERN = "^(3d|7d|30d|90d|1y|5y|10y|all|custom)$"


def _guard(fn):
    try:
        return fn()
    except GeeError as e:
        return JSONResponse(status_code=e.status_code, content=e.to_dict())


@router.get("/sources")
def sources():
    """Actual first/last image dates and bands of each archive collection, read live from Earth Engine."""
    return _guard(hs.source_coverage)


@router.get("/summary")
def summary(
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    range: str = Query("1y", pattern=RANGE_PATTERN),
    start_date: date | None = None, end_date: date | None = None,
    progress_id: str | None = Query(None, max_length=64, pattern="^[A-Za-z0-9_-]+$"),
):
    """Backend-aggregated monthly / annual / seasonal statistics (summary first; no per-record listing)."""
    return _guard(lambda: hs.history_summary((min_lon, min_lat, max_lon, max_lat), range, start_date, end_date, progress_id))


@router.get("/progress")
def progress(id: str = Query(..., max_length=64, pattern="^[A-Za-z0-9_-]+$")):
    """Real chunk progress of a running /summary request (done / total month chunks)."""
    return hs.get_progress(id)


def _period(start_date, end_date):
    if start_date > end_date:
        raise GeeError("INVALID_DATE_RANGE", "start_date must be on or before end_date.", 422)


@router.get("/grid")
def grid(
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    start_date: date = Query(...), end_date: date = Query(...),
    source: str = Query("MODIS", pattern="^(MODIS|VIIRS)$"),
):
    """Lazy-loaded spatial grid (record counts + max FRP per cell) for one source family and period."""
    def run():
        _period(start_date, end_date)
        return hs.history_grid((min_lon, min_lat, max_lon, max_lat), source, start_date, end_date)
    return _guard(run)


@router.get("/records")
def records(
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    start_date: date = Query(...), end_date: date = Query(...),
    source: str = Query("MODIS", pattern="^(MODIS|VIIRS)$"),
):
    """Individual observation records (one per 1 km cell-day with fire) of one sensor family, for one dot each on the globe."""
    def run():
        _period(start_date, end_date)
        return hs.history_records((min_lon, min_lat, max_lon, max_lat), source, start_date, end_date)
    return _guard(run)


@router.get("/frp")
def frp(
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    start_date: date = Query(...), end_date: date = Query(...),
):
    def run():
        _period(start_date, end_date)
        return hs.history_frp((min_lon, min_lat, max_lon, max_lat), start_date, end_date)
    return _guard(run)


@router.get("/landcover")
def landcover(
    min_lon: float = Query(..., ge=-180, le=180), min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180), max_lat: float = Query(..., ge=-90, le=90),
    start_date: date = Query(...), end_date: date = Query(...),
):
    def run():
        _period(start_date, end_date)
        return hs.history_landcover((min_lon, min_lat, max_lon, max_lat), start_date, end_date)
    return _guard(run)
