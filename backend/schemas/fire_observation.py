"""
Common fire-observation schema for cross-sensor comparison.

Plain dataclasses (no pydantic dependency) so the logic is testable offline; FastAPI serializes the dicts.

Design rules
* One OBSERVATION = one distinct FIRMS source record (pixels sharing a line_number within one daily image are
  grouped: the FIRMS rasters expand one record into several pixels). Raw pixel centres are kept.
* Sensor-specific measurements are NOT forced into shared fields: they stay under `original_properties.bands`
  with their original names and units (MODIS: T21; VIIRS: Bright_ti4, Bright_ti5, DayNight, ...).
* `confidence` keeps the ORIGINAL value; `confidence_scale` says what it means. MODIS (0-100 %) and VIIRS
  (0/1/2 categories) are never converted into one another.
* Missing values stay None. Nothing is inferred.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class FireObservation:
    observation_id: str
    source: str                       # "MODIS" | "VIIRS"
    platform: str | None
    instrument: str
    latitude: float | None
    longitude: float | None
    acquisition_date: str | None      # YYYY-MM-DD (derived from acquisition time if present, else source image date)
    acquisition_time_utc: str | None  # ISO-8601 UTC; None when the dataset has no acquisition timestamp
    confidence: float | int | None    # ORIGINAL value
    confidence_scale: str | None
    frp_mw: float | None              # None when the dataset has no FRP band (MODIS FIRMS in Earth Engine)
    source_image_id: str | None
    source_image_date: str | None     # date of the Earth Engine daily image (used for date matching)
    coordinate_method: str            # how latitude/longitude were obtained
    pixel_count: int
    original_properties: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Thresholds:
    spatial_km: float
    temporal_minutes: float
    date_tolerance_days: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CandidatePair:
    modis_observation_id: str
    viirs_observation_id: str
    distance_km: float
    spatial_status: str               # "within_threshold"
    date_difference_days: int | None
    temporal_matching_possible: bool
    time_difference_minutes: float | None
    within_temporal_threshold: bool | None
    temporal_note: str
    classification: str

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["note"] = "Potential relationship only. Not a confirmed observation of the same fire."
        return d
