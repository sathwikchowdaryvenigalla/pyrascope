"""
Google Earth Engine service for PyraScope.

* Initializes Earth Engine ONCE (singleton) - not per request.
* Classifies auth / permission / quota errors into clear, actionable messages.
* Provides the MODIS active-fire (FIRMS) query.

Dataset (verified against the Earth Engine Data Catalog):
    ee.ImageCollection("FIRMS")  - LANCE/FIRMS MODIS MOD14/MYD14 active fires, RASTERIZED.
    Bands: T21 (K), confidence (%), line_number.   Daily cadence, 1 km pixels.
    https://developers.google.com/earth-engine/datasets/catalog/FIRMS

IMPORTANT data model note: each *image* is one DAY of rasterized fire data. An "image"
is NOT a fire detection. Each FIRMS detection is expanded into one or more 1 km pixels, so
pixel counts OVERCOUNT detections; distinct `line_number` values (one per source FIRMS
record) are the closer count of detections. Images, pixels and source records are reported
separately. Images cover the whole globe, so a bbox with no fires still matches images
and shows up as fire_pixels_in_bbox == 0.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from backend import config

try:  # keep the API importable (and able to explain itself) if the package is missing
    import ee
except ImportError:  # pragma: no cover
    ee = None

log = logging.getLogger("pyrascope.gee")

FIRMS_COLLECTION_ID = "FIRMS"
FIRMS_DOCUMENTED_BANDS = ("T21", "confidence", "line_number")
FIRMS_SCALE_M = 1000
FIRMS_DESCRIPTION = (
    "FIRMS: Fire Information for Resource Management System "
    "(MODIS MOD14/MYD14 active fires via NASA LANCE, rasterized, near-real-time, "
    "not science quality)"
)
RETRY_COOLDOWN_S = 30


class GeeError(Exception):
    """Error with a stable code, an HTTP status and a human-readable hint."""

    def __init__(self, code: str, message: str, status_code: int = 502, hint: str | None = None):
        super().__init__(message)
        self.code, self.message, self.status_code, self.hint = code, message, status_code, hint

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": "error",
            "connected": False,
            "error": {"code": self.code, "message": self.message, "hint": self.hint},
        }


_AUTH_HINT = (
    "Run `python -m backend.authenticate_gee` once (opens a browser sign-in), then retry. "
    "On a server, configure GEE_SERVICE_ACCOUNT + GEE_PRIVATE_KEY_FILE instead."
)


def classify_exception(exc: Exception) -> GeeError:
    """Map an Earth Engine / Google client exception to a GeeError (heuristic on message text)."""
    if isinstance(exc, GeeError):
        return exc
    msg = str(exc).strip() or exc.__class__.__name__
    low = msg.lower()
    short = msg if len(msg) <= 400 else msg[:400] + "..."

    if any(s in low for s in ("please authorize access", "earthengine authenticate",
                              "default credentials", "invalid_grant", "reauth",
                              "credentials not found", "no credentials")):
        return GeeError("GEE_AUTH_REQUIRED", "Earth Engine credentials are missing or expired.", 503, _AUTH_HINT)
    if any(s in low for s in ("has not been used in project", "api has not been used",
                              "earthengine.googleapis.com is disabled", "service is disabled")):
        return GeeError("GEE_API_NOT_ENABLED",
                        "The Earth Engine API is not enabled for this Google Cloud project.", 403,
                        "Enable 'Google Earth Engine API' for the project in Google Cloud Console, wait a few minutes, retry.")
    if any(s in low for s in ("not registered", "not signed up", "register your project")):
        return GeeError("GEE_PROJECT_NOT_REGISTERED",
                        "This Google Cloud project is not registered for Earth Engine.", 403,
                        "Register the project at https://code.earthengine.google.com/register .")
    if any(s in low for s in ("permission", "forbidden", "403", "caller does not have")):
        return GeeError("GEE_PERMISSION_DENIED",
                        "Permission denied by Earth Engine for this account/project.", 403,
                        "Make sure the signed-in account (or service account) has the 'Earth Engine Resource Viewer' / "
                        "'Service Usage Consumer' roles on the project in GEE_PROJECT_ID. Detail: " + short)
    if any(s in low for s in ("quota", "too many requests", "429", "rate limit")):
        return GeeError("GEE_QUOTA_EXCEEDED", "Earth Engine quota or rate limit hit.", 429,
                        "Wait and retry, or narrow the date range / bounding box.")
    if any(s in low for s in ("timed out", "deadline exceeded", "timeout")):
        return GeeError("GEE_TIMEOUT", "Earth Engine computation timed out.", 504,
                        "Narrow the date range or bounding box.")
    if any(s in low for s in ("too many pixels", "memory limit", "out of memory", "exceeded")):
        return GeeError("GEE_QUERY_TOO_LARGE", "Query exceeds Earth Engine limits.", 422,
                        "Narrow the date range or bounding box. Detail: " + short)
    if "not found" in low and "project" in low:
        return GeeError("GEE_PROJECT_NOT_FOUND", "The Google Cloud project could not be found.", 403,
                        "Check GEE_PROJECT_ID is the project ID (not the display name or number).")
    return GeeError("GEE_ERROR", "Earth Engine request failed: " + short, 502)


def _ms_to_iso(ms: float | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def validate_query(start: date, end: date, bbox: tuple[float, float, float, float]) -> None:
    """Raise GeeError(422) for invalid / excessive queries. Pure function (no EE calls)."""
    min_lon, min_lat, max_lon, max_lat = bbox
    if start > end:
        raise GeeError("INVALID_DATE_RANGE", "start_date must be on or before end_date.", 422)
    span = (end - start).days + 1
    if span > config.max_query_days():
        raise GeeError("DATE_RANGE_TOO_LARGE",
                       f"Date range of {span} days exceeds the test-endpoint limit of {config.max_query_days()} days.", 422)
    if not (-180 <= min_lon < max_lon <= 180) or not (-90 <= min_lat < max_lat <= 90):
        raise GeeError("INVALID_BBOX",
                       "Bounding box must satisfy -180<=min_lon<max_lon<=180 and -90<=min_lat<max_lat<=90 "
                       "(boxes crossing the antimeridian are not supported).", 422)
    if (max_lon - min_lon) > config.max_bbox_degrees() or (max_lat - min_lat) > config.max_bbox_degrees():
        raise GeeError("BBOX_TOO_LARGE",
                       f"Bounding box side exceeds {config.max_bbox_degrees()} degrees.", 422)


class GeeService:
    """Process-wide Earth Engine client wrapper."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._initialized = False
        self._project: str | None = None
        self._auth_mode: str | None = None
        self._last_error: GeeError | None = None
        self._last_attempt = 0.0

    # ------------------------------------------------------------------ init
    def initialize(self, force: bool = False) -> bool:
        """Initialize Earth Engine once. Safe to call repeatedly; never raises."""
        with self._lock:
            if self._initialized and not force:
                return True
            self._last_attempt = time.monotonic()
            try:
                self._do_initialize()
                self._initialized, self._last_error = True, None
                log.info("Earth Engine initialized (project=%s, auth=%s)", self._project, self._auth_mode)
            except Exception as exc:  # noqa: BLE001 - classified below
                self._initialized = False
                self._last_error = classify_exception(exc)
                log.warning("Earth Engine init failed: %s [%s]", self._last_error.message, self._last_error.code)
            return self._initialized

    def _do_initialize(self) -> None:
        if ee is None:
            raise GeeError("GEE_PACKAGE_MISSING", "The 'earthengine-api' package is not installed.", 503,
                           "pip install -r backend/requirements.txt")
        project = config.gee_project_id()
        if not project:
            raise GeeError("GEE_PROJECT_ID_MISSING", "GEE_PROJECT_ID is not set.", 503,
                           "Copy .env.example to .env and set GEE_PROJECT_ID to your Google Cloud project ID.")
        self._project = project

        sa, key_file = config.gee_service_account(), config.gee_private_key_file()
        if sa and key_file:
            creds = ee.ServiceAccountCredentials(sa, key_file)
            ee.Initialize(credentials=creds, project=project)
            self._auth_mode = "service_account"
        else:
            # Uses credentials saved by `ee.Authenticate()` / `earthengine authenticate`.
            ee.Initialize(project=project)
            self._auth_mode = "user_credentials"

        # ee.Initialize alone does not prove project permissions or dataset access. Make one tiny real call.
        ee.ImageCollection(FIRMS_COLLECTION_ID).limit(1).size().getInfo()

    def ensure_ready(self) -> None:
        """Raise GeeError if EE is unavailable. Lazily retries (cooldown) so a fresh `authenticate` works without restart."""
        if self._initialized:
            return
        if self._last_error is None or (time.monotonic() - self._last_attempt) > RETRY_COOLDOWN_S:
            self.initialize()
        if not self._initialized:
            raise self._last_error or GeeError("GEE_NOT_INITIALIZED", "Earth Engine is not initialized.", 503)

    def status(self) -> dict[str, Any]:
        return {
            "earth_engine_initialized": self._initialized,
            "project_id": self._project or config.gee_project_id(),
            "auth_mode": self._auth_mode,
            "error": None if self._last_error is None or self._initialized else self._last_error.to_dict()["error"],
        }

    # ---------------------------------------------------------------- queries
    def query_firms(self, start: date, end: date, bbox: tuple[float, float, float, float],
                    max_images: int = 3, sample_pixels: int = 5) -> dict[str, Any]:
        """
        Query the MODIS FIRMS collection. `end` is INCLUSIVE (EE's filterDate end is exclusive,
        so one day is added internally). Returns real data only - nothing synthesized.
        """
        validate_query(start, end, bbox)
        self.ensure_ready()
        min_lon, min_lat, max_lon, max_lat = bbox
        try:
            region = ee.Geometry.Rectangle([min_lon, min_lat, max_lon, max_lat], "EPSG:4326", False)
            col = (ee.ImageCollection(FIRMS_COLLECTION_ID)
                   .filterDate(start.isoformat(), (end + timedelta(days=1)).isoformat())
                   .filterBounds(region))
            n_images = int(col.size().getInfo())

            base = {
                "connected": True,
                "dataset": {"id": FIRMS_COLLECTION_ID, "description": FIRMS_DESCRIPTION,
                            "pixel_size_m": FIRMS_SCALE_M, "cadence": "daily"},
                "query": {"start_date": start.isoformat(), "end_date": end.isoformat(),
                          "end_date_inclusive": True,
                          "bbox": {"min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat}},
            }

            if n_images == 0:
                cov = ee.ImageCollection(FIRMS_COLLECTION_ID)
                lo = cov.aggregate_min("system:time_start").getInfo()
                hi = cov.aggregate_max("system:time_start").getInfo()
                return {**base, "status": "no_data",
                        "message": "No FIRMS images intersect this date range and bounding box. "
                                   "The dataset's actual coverage is given in dataset_coverage; the Earth Engine "
                                   "copy can lag real time, so recent dates may be absent.",
                        "dataset_coverage": {"first_image": _ms_to_iso(lo), "last_image": _ms_to_iso(hi)},
                        "counts": {"matching_images": 0, "images_inspected": 0, "sample_pixels_returned": 0},
                        "band_names": [], "images": []}

            ordered = col.sort("system:time_start")
            band_names = ee.Image(ordered.first()).bandNames().getInfo()
            k = min(n_images, max_images)
            img_list = ordered.toList(k)

            images, total_sample = [], 0
            for i in range(k):
                img = ee.Image(img_list.get(i))
                meta = ee.Dictionary({
                    "id": img.id(),
                    "time_start": img.get("system:time_start"),
                    # number of unmasked (= fire) pixels of the image inside the bbox
                    "fire_pixels": img.select("confidence").reduceRegion(
                        reducer=ee.Reducer.count(), geometry=region, scale=FIRMS_SCALE_M, maxPixels=int(1e9)
                    ).get("confidence"),
                    # distinct FIRMS source records (line_number) among those pixels
                    "distinct_source_records": img.select("line_number").reduceRegion(
                        reducer=ee.Reducer.countDistinct(), geometry=region, scale=FIRMS_SCALE_M, maxPixels=int(1e9)
                    ).get("line_number"),
                }).getInfo()
                fc = img.sample(region=region, scale=FIRMS_SCALE_M, geometries=True).limit(sample_pixels).getInfo()
                pixels = []
                for f in fc.get("features", []):
                    props = f.get("properties", {})
                    lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
                    # source-specific band names preserved as-is
                    pixels.append({"longitude": lon, "latitude": lat, **props})
                total_sample += len(pixels)
                images.append({"image_id": meta.get("id"), "observation_date": _ms_to_iso(meta.get("time_start")),
                               "fire_pixels_in_bbox": meta.get("fire_pixels"),
                               "distinct_source_records_in_bbox": meta.get("distinct_source_records"),
                               "sample_pixels": pixels})

            return {**base, "status": "ok",
                    "message": f"{n_images} daily FIRMS image(s) matched; inspected the first {k} (chronological).",
                    "counts": {"matching_images": n_images, "images_inspected": k,
                               "sample_pixels_returned": total_sample,
                               "note": "An image is one day of rasterized fire data. Each FIRMS detection is expanded into "
                                       "one or more 1 km pixels, so fire_pixels_in_bbox overcounts detections. "
                                       "distinct_source_records_in_bbox (distinct line_number values) is the closer "
                                       "count of detections."},
                    "band_names": band_names,
                    "band_units": {"T21": "K (brightness temperature, MODIS ch. 21/22)", "confidence": "%",
                                   "line_number": "row in source FIRMS CSV"},
                    "images": images}
        except GeeError:
            raise
        except Exception as exc:  # noqa: BLE001
            err = classify_exception(exc)
            log.warning("FIRMS query failed: %s [%s] raw=%s", err.message, err.code, exc)
            raise err from exc


gee_service = GeeService()
