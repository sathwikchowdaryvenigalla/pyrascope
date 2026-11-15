from datetime import date

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend.services.gee_service import GeeError, gee_service
from backend.services.viirs_service import query_viirs

router = APIRouter(prefix="/api/gee", tags=["gee"])


@router.get("/status")
def gee_status():
    """Earth Engine initialization status (no secrets)."""
    return gee_service.status()


@router.get("/modis-test")
def modis_test(
    start_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    end_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    min_lon: float = Query(..., ge=-180, le=180),
    min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180),
    max_lat: float = Query(..., ge=-90, le=90),
    max_images: int = Query(3, ge=1, le=10, description="How many daily images to inspect"),
    sample_pixels: int = Query(5, ge=1, le=50, description="Max fire pixels returned per image"),
):
    """Test query against the MODIS FIRMS collection in Earth Engine."""
    try:
        return gee_service.query_firms(start_date, end_date, (min_lon, min_lat, max_lon, max_lat),
                                       max_images=max_images, sample_pixels=sample_pixels)
    except GeeError as e:
        return JSONResponse(status_code=e.status_code, content=e.to_dict())


@router.get("/viirs-test")
def viirs_test(
    start_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    end_date: date = Query(..., description="YYYY-MM-DD (inclusive)"),
    min_lon: float = Query(..., ge=-180, le=180),
    min_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180),
    max_lat: float = Query(..., ge=-90, le=90),
    max_images: int = Query(3, ge=1, le=10, description="Max daily images (with fire pixels) to sample"),
    sample_pixels: int = Query(10, ge=1, le=100, description="Max sampled fire pixels per image"),
):
    """Test query against Suomi NPP VIIRS 375 m active fires (NASA/LANCE/SNPP_VIIRS/C2)."""
    try:
        return query_viirs(start_date, end_date, (min_lon, min_lat, max_lon, max_lat),
                           platform_key="snpp", max_images=max_images, sample_pixels=sample_pixels)
    except GeeError as e:
        return JSONResponse(status_code=e.status_code, content=e.to_dict())
