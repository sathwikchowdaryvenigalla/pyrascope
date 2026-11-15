"""
Generates CONTRACT FIXTURES for the frontend tests by running the REAL backend formatting code
(normalize_pixels -> match_observations -> format_compare / format_summary) on pixel inputs.

!! These fixtures are NOT live NASA data. The 5 MODIS pixels are copied from the backend test-suite (they came from a
!! live response on 2024-03-01); every VIIRS pixel and everything else is SYNTHETIC and only exercises the schema.
Run from the project root:  python tests/frontend/make_fixtures.py
"""
import json
from pathlib import Path

from backend.services import harmonization_service as hs

OUT = Path(__file__).parent / "fixtures"
EPOCH = 1709294400  # 2024-03-01T12:00:00Z

MODIS = [{"image_id": "2024061", "image_date": "2024-03-01", "longitude": lon, "latitude": lat,
          "T21": 317.2, "confidence": 68, "line_number": 713}
         for lon, lat in [(78.74737, 23.01410), (78.75714, 23.01410), (78.76691, 23.01410), (78.74212, 23.00511), (78.75189, 23.00511)]]
MODIS += [{"image_id": "2024062", "image_date": "2024-03-02", "longitude": 77.5, "latitude": 22.5,
           "T21": 330.0, "confidence": 90, "line_number": 9}]


def viirs(lat, lon, line, day="2024-03-01", epoch=EPOCH, image="v1"):
    return {"image_id": image, "image_date": day, "longitude": lon, "latitude": lat, "Bright_ti4": 340.0, "Bright_ti5": 300.0,
            "confidence": 1, "frp": 3.2, "acq_epoch": epoch, "acq_time": epoch % 86400, "DayNight": 1, "line_number": line}


VIIRS = [viirs(23.0141, 78.7480, 1),                       # ~near MODIS record 713 (candidate)
         viirs(21.0, 76.5, 2),                              # far from everything (unmatched)
         viirs(22.5, 77.5, 3, day="2024-03-02", epoch=EPOCH + 86400, image="v2")]  # near MODIS line 9


def build(modis_px, viirs_px, max_details):
    m, v = hs.normalize_pixels("MODIS", modis_px), hs.normalize_pixels("VIIRS", viirs_px)
    th = hs.validate_thresholds(1.0, 30, 0)
    match = hs.match_observations(m, v, th)
    h = hs.Harmonization(
        query={"start_date": "2024-03-01", "end_date": "2024-03-02", "end_date_inclusive": True,
               "bbox": {"min_lon": 76, "min_lat": 21, "max_lon": 80, "max_lat": 25}},
        thresholds=th, modis=m, viirs=v, match=match,
        availability={"MODIS": {"dataset_id": "FIRMS", "matching_images": 2, "images_with_fire_pixels": 2,
                                "fire_pixels_expected": len(modis_px), "fire_pixels_retrieved": len(modis_px), "complete": True},
                      "VIIRS": {"dataset_id": "NASA/LANCE/SNPP_VIIRS/C2", "matching_images": 2, "images_with_fire_pixels": 2,
                                "fire_pixels_expected": len(viirs_px), "fire_pixels_retrieved": len(viirs_px), "complete": True},
                      "warnings": []},
        retrieved_at_utc="2024-03-05T10:00:00Z", from_cache={"MODIS": False, "VIIRS": False})
    return hs.format_compare(h, True, max_details), hs.format_summary(h)


for name, md in (("full", 2000), ("truncated", 1)):
    compare, summary = build(MODIS, VIIRS, md)
    (OUT / f"compare_{name}.json").write_text(json.dumps(compare, indent=1))
    (OUT / f"summary_{name}.json").write_text(json.dumps(summary, indent=1))
empty, esum = build([], [], 2000)
(OUT / "compare_empty.json").write_text(json.dumps(empty, indent=1))
print("fixtures written:", sorted(p.name for p in OUT.iterdir()))
