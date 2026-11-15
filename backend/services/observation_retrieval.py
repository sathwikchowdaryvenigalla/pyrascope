"""
Earth Engine retrieval of ALL fire pixels for harmonization (MODIS FIRMS + Suomi NPP VIIRS), with a small TTL cache
so compare and summary calls do not repeat Earth Engine requests. Reuses gee_service for initialization / errors.
The existing modis/viirs test services are untouched (VIIRS only had a small bug fix).
"""
from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from backend import config
from backend.services import gee_service as gee
from backend.services import harmonization_service as hs
from backend.services import viirs_service
from backend.services.gee_service import GeeError, classify_exception, validate_query

SOURCES = {
    "MODIS": {"collection_id": gee.FIRMS_COLLECTION_ID, "scale": gee.FIRMS_SCALE_M},
    "VIIRS": {"collection_id": viirs_service.PLATFORMS["snpp"]["collection_id"], "scale": viirs_service.SCALE_M},
}

_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_CACHE_MAX = 32


def _ms_date(ms: float | None) -> str | None:
    return None if ms is None else datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def fetch_source_pixels(source: str, start: date, end: date, bbox: tuple[float, float, float, float],
                        max_pixels: int) -> dict[str, Any]:
    """Retrieve every unmasked pixel for the source in bbox/date range. Refuses (422) instead of truncating."""
    cfg = SOURCES[source]
    gee.gee_service.ensure_ready()
    ee = gee.ee
    min_lon, min_lat, max_lon, max_lat = bbox
    try:
        region = ee.Geometry.Rectangle([min_lon, min_lat, max_lon, max_lat], "EPSG:4326", False)
        col = (ee.ImageCollection(cfg["collection_id"])
               .filterDate(start.isoformat(), (end + timedelta(days=1)).isoformat()).filterBounds(region))
        n_images = int(col.size().getInfo())
        info = {"dataset_id": cfg["collection_id"], "matching_images": n_images, "images_with_fire_pixels": 0,
                "fire_pixels_expected": 0, "fire_pixels_retrieved": 0, "complete": True,
                "max_pixels_cap": max_pixels}
        if n_images == 0:
            full = ee.ImageCollection(cfg["collection_id"])
            info["dataset_coverage"] = {"first_image": _ms_date(full.aggregate_min("system:time_start").getInfo()),
                                        "last_image": _ms_date(full.aggregate_max("system:time_start").getInfo())}
            return {"pixels": [], "info": info}

        ordered = col.sort("system:time_start")
        bands = ee.Image(ordered.first()).bandNames().getInfo()
        if "confidence" not in bands:
            raise GeeError("MISSING_BANDS", f"{source}: 'confidence' band missing; found {bands}.", 502)
        info["band_names"] = bands

        def summarize(img):
            raw = ee.Image(img)                          # metadata is read from the ORIGINAL image
            fire = viirs_service.fire_pixel_image(raw)   # fire pixel = all bands valid (see viirs_service)
            n = fire.select("confidence").reduceRegion(
                reducer=ee.Reducer.count(), geometry=region, scale=cfg["scale"], maxPixels=int(1e9)).get("confidence")
            return ee.Feature(None, {"index": raw.get("system:index"), "id": raw.id(),
                                     "time_start": raw.get("system:time_start"), "n": n})

        rows = [r["properties"] for r in ee.FeatureCollection(ordered.map(summarize)).getInfo().get("features", [])]
        with_fire = [r for r in rows if (r.get("n") or 0) > 0]
        expected = sum(int(r["n"]) for r in with_fire)
        info.update(images_with_fire_pixels=len(with_fire), fire_pixels_expected=expected)
        if expected > max_pixels:
            raise GeeError("TOO_MANY_OBSERVATIONS",
                           f"{source}: {expected} fire pixels in this query exceed the cap of {max_pixels}. "
                           "Results are not truncated because that would make counts misleading.", 422,
                           "Use a smaller bounding box or a shorter date range.")
        pixels: list[dict[str, Any]] = []
        for r in with_fire:
            img = ee.Image(ordered.filter(ee.Filter.eq("system:index", r["index"])).first())
            fc = viirs_service.fire_pixel_image(img).sample(region=region, scale=cfg["scale"], geometries=True).getInfo()
            for f in fc.get("features", []):
                lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
                pixels.append({"image_id": r.get("id") or r["index"], "image_date": _ms_date(r.get("time_start")),
                               "longitude": lon, "latitude": lat, **f.get("properties", {})})
        info["fire_pixels_retrieved"] = len(pixels)
        info["complete"] = len(pixels) == expected
        if not info["complete"]:
            info["warnings"] = [f"{source}: retrieved {len(pixels)} pixels but the count query expected {expected}."]
        return {"pixels": pixels, "info": info}
    except GeeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise classify_exception(exc) from exc


def _cached_fetch(source: str, start: date, end: date, bbox: tuple, max_pixels: int) -> tuple[dict[str, Any], bool]:
    key = (source, start, end, bbox, max_pixels)
    ttl = config.harmonization_cache_ttl_s()
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1], True
    data = fetch_source_pixels(source, start, end, bbox, max_pixels)
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        _cache[key] = (now, data)
    return data, False


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def get_harmonized(start: date, end: date, bbox: tuple[float, float, float, float],
                   spatial_km: float, temporal_minutes: float, date_tolerance_days: int = 0) -> hs.Harmonization:
    validate_query(start, end, bbox)
    th = hs.validate_thresholds(spatial_km, temporal_minutes, date_tolerance_days)
    cap = config.max_viirs_bbox_degrees()
    if (bbox[2] - bbox[0]) > cap or (bbox[3] - bbox[1]) > cap:
        raise GeeError("BBOX_TOO_LARGE", f"Harmonization bounding box side exceeds {cap} degrees.", 422)

    max_px = config.max_harmonization_pixels()
    modis_raw, modis_cached = _cached_fetch("MODIS", start, end, bbox, max_px)
    viirs_raw, viirs_cached = _cached_fetch("VIIRS", start, end, bbox, max_px)
    modis = hs.normalize_pixels("MODIS", modis_raw["pixels"])
    viirs = hs.normalize_pixels("VIIRS", viirs_raw["pixels"])
    match = hs.match_observations(modis, viirs, th)
    availability = {"MODIS": modis_raw["info"], "VIIRS": viirs_raw["info"],
                    "warnings": modis_raw["info"].get("warnings", []) + viirs_raw["info"].get("warnings", [])}
    return hs.Harmonization(
        query={"start_date": start.isoformat(), "end_date": end.isoformat(), "end_date_inclusive": True,
               "bbox": {"min_lon": bbox[0], "min_lat": bbox[1], "max_lon": bbox[2], "max_lat": bbox[3]}},
        thresholds=th, modis=modis, viirs=viirs, match=match, availability=availability,
        retrieved_at_utc=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        from_cache={"MODIS": modis_cached, "VIIRS": viirs_cached})
