"""
MODIS-VIIRS harmonization (pure logic; no Earth Engine calls here).

METHOD
1. Normalize raw pixels into FireObservation records (pixels sharing a FIRMS line_number inside one daily image
   are one source record). Original band values are preserved under original_properties.
2. Spatial comparison: great-circle (Haversine) distance between observation coordinates; candidates are found
   with a latitude-sorted index (bisect) so large inputs do not need an all-pairs scan.
3. Temporal comparison: only when BOTH observations have a valid UTC acquisition timestamp.
   In Earth Engine, MODIS FIRMS has NO acquisition time (only a daily image date); VIIRS has acq_epoch.
   Therefore MODIS-VIIRS temporal matching is normally UNAVAILABLE and such pairs are labelled
   "insufficient_timestamp_information". Nothing is inferred or estimated.
4. A date gate (default: same Earth Engine image date, configurable tolerance) prevents pairing observations
   from different days.
5. Classification is per PAIR and one-to-many is allowed: an observation may appear in many pairs.

ASSUMPTIONS / LIMITS (also returned by the API)
* Pair = "potentially related observations", never "the same fire". No fire events are identified.
* MODIS coordinates are rasterized 1 km pixel centres (mean of the record's pixel centres), VIIRS 375 m pixel
  centres. Positional uncertainty is of the order of the pixel size, so the default 1 km threshold is a
  starting point, not a validated value.
* Earth Engine image date is assumed to be a UTC daily bin; not verified.
"""
from __future__ import annotations

import bisect
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

from backend import config
from backend.schemas.fire_observation import CandidatePair, FireObservation, Thresholds
from backend.services.gee_service import GeeError

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEG_LAT = 2 * math.pi * EARTH_RADIUS_KM / 360.0

CLASS_MATCH = "potential_spatial_and_temporal_match"
CLASS_SPATIAL_ONLY = "spatial_only_candidate"
CLASS_INSUFFICIENT = "insufficient_timestamp_information"
CLASS_UNMATCHED_MODIS = "unmatched_modis_observation"
CLASS_UNMATCHED_VIIRS = "unmatched_viirs_observation"

SOURCE_INFO = {
    "MODIS": {"platform": "MODIS (Terra and/or Aqua; not distinguishable in Earth Engine FIRMS)",
              "instrument": "MODIS", "confidence_scale": "percent_0_100"},
    "VIIRS": {"platform": "Suomi NPP", "instrument": "VIIRS",
              "confidence_scale": "categorical_0_low_1_nominal_2_high"},
}
_META_KEYS = {"image_id", "image_date", "longitude", "latitude"}

INTERPRETATION = {
    "observation": "One distinct FIRMS source record (pixels with the same line_number in one daily image are grouped).",
    "candidate_pair": "A MODIS-VIIRS pair that is close in space (and date); a POTENTIAL relationship only.",
    "unique_fire_events": None,
    "unique_fire_events_note": "Not determined. This system does not identify confirmed or unique fire events, "
                               "and has not been scientifically validated for that purpose.",
}


# ------------------------------------------------------------------ helpers
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _valid_coord(lat: Any, lon: Any) -> bool:
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and not isinstance(lat, bool)
            and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180)


def _iso_from_epoch(sec: Any) -> str | None:
    """Valid epoch seconds (years 2000-2100) -> ISO UTC string; anything else -> None (never guessed)."""
    if isinstance(sec, bool) or not isinstance(sec, (int, float)) or not math.isfinite(sec):
        return None
    if not (946684800 <= sec <= 4102444800):
        return None
    return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _date_diff_days(a: str | None, b: str | None) -> int | None:
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days) if a and b else None
    except ValueError:
        return None


def validate_thresholds(spatial_km: float, temporal_minutes: float, date_tolerance_days: int) -> Thresholds:
    if not (0 < spatial_km <= 25):
        raise GeeError("INVALID_THRESHOLD", "spatial_threshold_km must be > 0 and <= 25.", 422)
    if not (0 <= temporal_minutes <= 1440):
        raise GeeError("INVALID_THRESHOLD", "temporal_threshold_minutes must be between 0 and 1440.", 422)
    if not (0 <= date_tolerance_days <= 3):
        raise GeeError("INVALID_THRESHOLD", "date_tolerance_days must be between 0 and 3.", 422)
    return Thresholds(float(spatial_km), float(temporal_minutes), int(date_tolerance_days))


# ------------------------------------------------------------ normalization
def normalize_pixels(source: str, pixels: list[dict[str, Any]]) -> list[FireObservation]:
    """
    Raw pixel dicts -> FireObservation list. Each raw pixel needs: image_id, image_date, longitude, latitude,
    plus the source's original band values. Pixels without a line_number are kept as separate observations.
    """
    info = SOURCE_INFO[source]
    groups: dict[tuple, list[dict[str, Any]]] = {}
    for i, p in enumerate(pixels):
        ln = p.get("line_number")
        key = (p.get("image_id"), ln if ln is not None else f"px{i}")
        groups.setdefault(key, []).append(p)

    out: list[FireObservation] = []
    for (image_id, ln), members in groups.items():
        first = members[0]
        bands = {k: v for k, v in first.items() if k not in _META_KEYS}
        varies = any({k: v for k, v in m.items() if k not in _META_KEYS} != bands for m in members[1:])
        coords = [(m["latitude"], m["longitude"]) for m in members if _valid_coord(m.get("latitude"), m.get("longitude"))]
        if coords:
            lat = sum(c[0] for c in coords) / len(coords)
            lon = sum(c[1] for c in coords) / len(coords)
            method = "pixel_center" if len(coords) == 1 else f"mean_of_{len(coords)}_pixel_centers"
        else:
            lat = lon = None
            method = "unavailable (missing or invalid coordinates)"

        time_utc = _iso_from_epoch(bands.get("acq_epoch")) if source == "VIIRS" else None
        image_date = first.get("image_date")
        out.append(FireObservation(
            observation_id=f"{source}:{image_id or 'unknown'}:{ln}",
            source=source, platform=info["platform"], instrument=info["instrument"],
            latitude=lat, longitude=lon,
            acquisition_date=time_utc[:10] if time_utc else image_date,
            acquisition_time_utc=time_utc,
            confidence=bands.get("confidence"), confidence_scale=info["confidence_scale"],
            frp_mw=bands.get("frp") if source == "VIIRS" else None,
            source_image_id=image_id, source_image_date=image_date,
            coordinate_method=method, pixel_count=len(members),
            original_properties={
                "bands": bands,
                "line_number": bands.get("line_number"),
                "pixel_count": len(members),
                "bands_vary_within_record": varies,
                "pixel_centers_lonlat": [[m.get("longitude"), m.get("latitude")] for m in members[:9]],
            }))
    return out


# ------------------------------------------------------------------ matching
@dataclass
class MatchResult:
    pairs: list[CandidatePair] = field(default_factory=list)
    unmatched_modis_ids: list[str] = field(default_factory=list)
    unmatched_viirs_ids: list[str] = field(default_factory=list)
    modis_without_coordinates: list[str] = field(default_factory=list)
    viirs_without_coordinates: list[str] = field(default_factory=list)
    modis_with_candidates: int = 0
    viirs_with_candidates: int = 0

    def class_counts(self) -> dict[str, int]:
        c = Counter(p.classification for p in self.pairs)
        return {CLASS_MATCH: c[CLASS_MATCH], CLASS_SPATIAL_ONLY: c[CLASS_SPATIAL_ONLY],
                CLASS_INSUFFICIENT: c[CLASS_INSUFFICIENT]}


def _temporal(m: FireObservation, v: FireObservation, th: Thresholds) -> tuple[bool, float | None, bool | None, str]:
    if m.acquisition_time_utc and v.acquisition_time_utc:
        diff = abs((_parse_iso(m.acquisition_time_utc) - _parse_iso(v.acquisition_time_utc)).total_seconds()) / 60
        return True, round(diff, 3), diff <= th.temporal_minutes, "Compared UTC acquisition timestamps."
    missing = [n for n, o in (("MODIS", m), ("VIIRS", v)) if not o.acquisition_time_utc]
    return False, None, None, ("No valid acquisition timestamp for " + " and ".join(missing) +
                               "; temporal matching not possible (no time was inferred).")


def match_observations(modis: list[FireObservation], viirs: list[FireObservation], th: Thresholds) -> MatchResult:
    res = MatchResult()
    m_loc = [o for o in modis if o.latitude is not None]
    v_loc = sorted((o for o in viirs if o.latitude is not None), key=lambda o: o.latitude)
    res.modis_without_coordinates = [o.observation_id for o in modis if o.latitude is None]
    res.viirs_without_coordinates = [o.observation_id for o in viirs if o.latitude is None]
    v_lats = [o.latitude for o in v_loc]
    dlat = th.spatial_km / KM_PER_DEG_LAT * 1.001 + 1e-9
    cap = config.max_candidate_pairs()

    m_hit: set[str] = set()
    v_hit: set[str] = set()
    for m in m_loc:
        lo = bisect.bisect_left(v_lats, m.latitude - dlat)
        hi = bisect.bisect_right(v_lats, m.latitude + dlat)
        for v in v_loc[lo:hi]:
            dist = haversine_km(m.latitude, m.longitude, v.latitude, v.longitude)
            if dist > th.spatial_km:
                continue
            dd = _date_diff_days(m.source_image_date, v.source_image_date)
            if dd is not None and dd > th.date_tolerance_days:
                continue
            possible, diff, within, note = _temporal(m, v, th)
            cls = CLASS_INSUFFICIENT if not possible else (CLASS_MATCH if within else CLASS_SPATIAL_ONLY)
            res.pairs.append(CandidatePair(m.observation_id, v.observation_id, round(dist, 4), "within_threshold",
                                           dd, possible, diff, within, note, cls))
            m_hit.add(m.observation_id)
            v_hit.add(v.observation_id)
            if len(res.pairs) > cap:
                raise GeeError("TOO_MANY_CANDIDATE_PAIRS",
                               f"More than {cap} candidate pairs; results would be incomplete.", 422,
                               "Reduce spatial_threshold_km, the bounding box or the date range.")
    res.pairs.sort(key=lambda p: (p.modis_observation_id, p.distance_km))
    res.modis_with_candidates, res.viirs_with_candidates = len(m_hit), len(v_hit)
    res.unmatched_modis_ids = [o.observation_id for o in m_loc if o.observation_id not in m_hit]
    res.unmatched_viirs_ids = [o.observation_id for o in v_loc if o.observation_id not in v_hit]
    return res


# ------------------------------------------------------------ API shaping
@dataclass
class Harmonization:
    query: dict[str, Any]
    thresholds: Thresholds
    modis: list[FireObservation]
    viirs: list[FireObservation]
    match: MatchResult
    availability: dict[str, Any]
    retrieved_at_utc: str
    from_cache: dict[str, bool]


def _provenance(h: Harmonization) -> dict[str, Any]:
    return {
        "retrieved_at_utc": h.retrieved_at_utc,
        "served_from_cache": h.from_cache,
        "sources": {
            "MODIS": {"dataset": "FIRMS (Earth Engine)", "product": "MOD14/MYD14 via NASA LANCE/FIRMS, rasterized 1 km, NRT",
                      "available_bands": ["T21", "confidence", "line_number"],
                      "has_acquisition_time": False, "has_frp": False},
            "VIIRS": {"dataset": "NASA/LANCE/SNPP_VIIRS/C2", "product": "VNP14IMGTDL_NRT 375 m, daily raster, NRT",
                      "has_acquisition_time": True, "has_frp": True},
        },
        "retrieval": "ALL unmasked fire pixels in the bbox were retrieved (not a sample); queries over the "
                     "per-source pixel cap are refused rather than truncated.",
        "assumptions": [
            "Observation = FIRMS source record (pixels with equal line_number in one image are grouped).",
            "Coordinates are pixel centres (MODIS 1 km, VIIRS 375 m); positional uncertainty ~ pixel size.",
            "Date matching uses the Earth Engine daily image date, assumed to be a UTC bin (not verified).",
            "MODIS has no acquisition time in this dataset, so MODIS-VIIRS temporal matching is unavailable.",
            "MODIS confidence (0-100 %) and VIIRS confidence (0/1/2) are different scales and are never converted.",
            "Candidate pairs are potential relationships only; no fire events are identified or validated.",
        ],
    }


def _warnings(h: Harmonization) -> list[str]:
    w = list(h.availability.get("warnings", []))
    if h.match.pairs and not any(p.temporal_matching_possible for p in h.match.pairs):
        w.append("Temporal matching was not possible for any pair (missing acquisition timestamps); "
                 "all pairs are spatial/date candidates only.")
    n_nc = len(h.match.modis_without_coordinates) + len(h.match.viirs_without_coordinates)
    if n_nc:
        w.append(f"{n_nc} observation(s) lack valid coordinates and were excluded from spatial matching.")
    return w


def _counts(h: Harmonization) -> dict[str, Any]:
    cc = h.match.class_counts()
    return {
        "observations": {"modis": len(h.modis), "viirs": len(h.viirs),
                         "modis_pixels_retrieved": sum(o.pixel_count for o in h.modis),
                         "viirs_pixels_retrieved": sum(o.pixel_count for o in h.viirs)},
        "candidate_pairs": {"total": len(h.match.pairs),
                            "potential_spatial_and_temporal_matches": cc[CLASS_MATCH],
                            "spatial_only_candidates": cc[CLASS_SPATIAL_ONLY],
                            "insufficient_timestamp_information": cc[CLASS_INSUFFICIENT],
                            "modis_observations_with_a_candidate": h.match.modis_with_candidates,
                            "viirs_observations_with_a_candidate": h.match.viirs_with_candidates},
        "unmatched": {"modis_observations": len(h.match.unmatched_modis_ids),
                      "viirs_observations": len(h.match.unmatched_viirs_ids),
                      "modis_without_coordinates": len(h.match.modis_without_coordinates),
                      "viirs_without_coordinates": len(h.match.viirs_without_coordinates)},
        "unique_fire_events": None,
    }


def _status(h: Harmonization) -> tuple[str, str]:
    if not h.modis and not h.viirs:
        return "no_data", "No MODIS or VIIRS fire observations were found in this query."
    parts = []
    if not h.modis:
        parts.append("No MODIS observations (VIIRS only).")
    if not h.viirs:
        parts.append("No VIIRS observations (MODIS only).")
    parts.append("Pairs are potential relationships only, not confirmed same-fire matches.")
    return "ok", " ".join(parts)


def format_compare(h: Harmonization, include_observations: bool = False, max_details: int = 200) -> dict[str, Any]:
    status, message = _status(h)
    pairs = [p.to_dict() for p in h.match.pairs[:max_details]]
    out: dict[str, Any] = {
        "status": status, "connected": True, "message": message,
        "query": h.query, "applied_thresholds": h.thresholds.to_dict(),
        "counts": _counts(h),
        "temporal_matching_available": any(p.temporal_matching_possible for p in h.match.pairs),
        "match_details": pairs,
        "match_details_truncated": len(h.match.pairs) > max_details,
        "unmatched": {
            "modis_observation_ids": h.match.unmatched_modis_ids[:max_details],
            "viirs_observation_ids": h.match.unmatched_viirs_ids[:max_details],
            "truncated": max(len(h.match.unmatched_modis_ids), len(h.match.unmatched_viirs_ids)) > max_details},
        "interpretation": INTERPRETATION,
        "data_provenance": _provenance(h),
        "availability": h.availability,
        "warnings": _warnings(h),
    }
    if include_observations:
        out["observations"] = {"modis": [o.to_dict() for o in h.modis[:max_details]],
                               "viirs": [o.to_dict() for o in h.viirs[:max_details]],
                               "truncated": max(len(h.modis), len(h.viirs)) > max_details}
    return out


def format_summary(h: Harmonization) -> dict[str, Any]:
    status, message = _status(h)
    by_date: dict[str, dict[str, int]] = defaultdict(lambda: {"MODIS": 0, "VIIRS": 0})
    by_platform: Counter = Counter()
    for o in h.modis + h.viirs:
        by_date[o.source_image_date or "unknown"][o.source] += 1
        by_platform[o.platform or "unknown"] += 1
    c = _counts(h)
    return {
        "status": status, "connected": True, "message": message,
        "query_bounds": h.query, "applied_thresholds": h.thresholds.to_dict(),
        "observation_counts_by_source": {"MODIS": c["observations"]["modis"], "VIIRS": c["observations"]["viirs"]},
        "observation_counts_by_date": dict(sorted(by_date.items())),
        "observation_counts_by_platform": dict(by_platform),
        "candidate_pairs": c["candidate_pairs"],
        "unmatched": c["unmatched"],
        "unique_fire_events": None,
        "interpretation": INTERPRETATION,
        "data_availability": h.availability,
        "data_provenance": _provenance(h),
        "warnings": _warnings(h),
    }
