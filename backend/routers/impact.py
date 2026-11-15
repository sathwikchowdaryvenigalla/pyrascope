from datetime import date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend.services.impact_service import build_impact

router = APIRouter(prefix="/api/impact", tags=["impact"])


@router.get("/observation/{observation_id}")
def observation_impact(
    observation_id: str,
    latitude: float = Query(..., ge=-90, le=90, description="Latitude of the selected observation"),
    longitude: float = Query(..., ge=-180, le=180, description="Longitude of the selected observation"),
    acquisition_date: date = Query(..., description="YYYY-MM-DD of the selected observation"),
    source: str = Query(..., pattern="^(MODIS|VIIRS)$"),
    platform: str | None = None, instrument: str | None = None,
    acquisition_time_utc: str | None = None,
    frp_mw: float | None = None,
    confidence: str | None = None, confidence_scale: str | None = None,
    day_night: str | None = None, match_status: str | None = None,
):
    """
    Environmental context for one selected observation. Observation metadata is echoed from the query (the selected
    record the UI already holds); every environmental item is queried live from Earth Engine datasets, and an
    inaccessible dataset is returned as status "unavailable" - nothing is estimated or invented.
    """
    if not observation_id.startswith(f"{source}:"):
        return JSONResponse(status_code=422, content={"status": "error", "error": {
            "code": "OBSERVATION_ID_MISMATCH", "message": "observation_id does not belong to the stated source.", "hint": None}})
    observed = {"observation_id": observation_id, "source": source, "platform": platform, "instrument": instrument,
                "latitude": latitude, "longitude": longitude, "acquisition_date": acquisition_date.isoformat(),
                "acquisition_time_utc": acquisition_time_utc, "frp_mw": frp_mw, "confidence": confidence,
                "confidence_scale": confidence_scale, "day_night": day_night, "match_status": match_status}
    return build_impact(observation_id, observed)
