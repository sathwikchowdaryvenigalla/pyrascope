"""
NASA VIIRS 375 m active-fire service (Earth Engine).

Verified against the Earth Engine Data Catalog:
    ee.ImageCollection("NASA/LANCE/SNPP_VIIRS/C2")   (VNP14IMGTDL_NRT daily raster, Suomi NPP)
    https://developers.google.com/earth-engine/datasets/catalog/NASA_LANCE_SNPP_VIIRS_C2
    Bands: Bright_ti4 (K), Bright_ti5 (K), confidence (0 low / 1 nominal / 2 high),
           line_number, frp (MW), acq_epoch (s), acq_time (s since midnight), DayNight (1 day / 0 night)
    Cadence: daily, 375 m. Near-real-time, NOT science quality.

Raster semantics: each image = one day of rasterized fire data. Only UNMASKED pixels are fire
pixels (the catalog describes confidence as defined "for all fire pixels within the fire mask";
it does not spell out the mask rule, so this module validates confidence in {0,1,2} at runtime).
Image count != fire-pixel count != hotspot count; all are reported separately.

Earth Engine initialization, error classification and bbox/date validation are REUSED from
gee_service. Platform identity is always preserved (nothing is merged across platforms).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from backend import config
from backend.services import gee_service as gee
from backend.services.gee_service import GeeError, classify_exception, validate_query

log = logging.getLogger("pyrascope.viirs")

SCALE_M = 375
EXPECTED_BANDS = ("Bright_ti4", "Bright_ti5", "confidence", "line_number", "frp",
                  "acq_epoch", "acq_time", "DayNight")
CONFIDENCE_LABELS = {0: "low", 1: "nominal", 2: "high"}
DAYNIGHT_LABELS = {1: "day", 0: "night"}
BAND_UNITS = {
    "Bright_ti4": "K (VIIRS I-4 brightness temperature)",
    "Bright_ti5": "K (VIIRS I-5 brightness temperature)",
    "confidence": "categorical: 0=low, 1=nominal, 2=high (VIIRS scale; NOT comparable to MODIS 0-100 %)",
    "line_number": "row in source FIRMS CSV",
    "frp": "MW (pixel-integrated fire radiative power)",
    "acq_epoch": "seconds (acquisition timestamp, epoch)",
    "acq_time": "seconds since midnight (as documented in the catalog)",
    "DayNight": "1 = daytime fire, 0 = nighttime fire",
}

# Platform registry. Add platforms here; identity is kept per entry.
PLATFORMS: dict[str, dict[str, Any]] = {
    "snpp": {
        "enabled": True,
        "collection_id": "NASA/LANCE/SNPP_VIIRS/C2",
        "platform": "Suomi NPP",
        "instrument": "VIIRS",
        "product": "VNP14IMGTDL_NRT (375 m active fire, daily raster)",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/NASA_LANCE_SNPP_VIIRS_C2",
    },
    # Prepared, NOT enabled: collection ID has not been verified against the catalog yet.
    "noaa20": {
        "enabled": False,
        "collection_id": "NASA/LANCE/NOAA20_VIIRS/C2",
        "platform": "NOAA-20",
        "instrument": "VIIRS",
        "product": "(unverified)",
        "catalog_url": None,
    },
}


def fire_pixel_image(img):
    """
    Keep only FIRE pixels: those where EVERY band is valid. Live evidence (2024-03-01..03, bbox 77,22,79,24):
    the `confidence` band alone is unmasked across the whole footprint (~324k pixels in a 2x2 degree box,
    identical every day), while the other bands are masked outside actual detections. So "confidence is
    unmasked" is NOT a fire test; "all bands valid" is (it is also what Image.sample(dropNulls=True) keeps).
    """
    ee = gee.ee
    img = ee.Image(img)
    return img.updateMask(img.mask().reduce(ee.Reducer.min()))


# --------------------------------------------------------------- pure helpers
def _iso_from_seconds(sec: float | None) -> str | None:
    if sec is None:
        return None
    return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_ms(ms: float | None) -> str | None:
    return None if ms is None else _iso_from_seconds(ms / 1000)


def check_bands(band_names: list[str]) -> list[str]:
    """Return expected bands that are absent from the actual band list."""
    return [b for b in EXPECTED_BANDS if b not in band_names]


def format_pixel(props: dict[str, Any], coords: list[float] | tuple | None, cfg: dict[str, Any]) -> dict[str, Any]:
    """
    Build one pixel record. Original band values are preserved as-is (source field names kept);
    missing values stay None (never invented). *_label / acquisition_* fields are DERIVED and
    named so. Platform/instrument come from the collection, not from the pixel.
    """
    lon, lat = (coords or [None, None])[:2]
    epoch = props.get("acq_epoch")
    conf = props.get("confidence")
    dn = props.get("DayNight")
    return {
        "latitude": lat,
        "longitude": lon,
        "platform": cfg["platform"],
        "instrument": cfg["instrument"],
        "acquisition_timestamp_utc": _iso_from_seconds(epoch),   # derived from acq_epoch
        "acquisition_date": (_iso_from_seconds(epoch) or "")[:10] or None,
        "acq_epoch": epoch,
        "acq_time": props.get("acq_time"),
        "Bright_ti4": props.get("Bright_ti4"),
        "Bright_ti5": props.get("Bright_ti5"),
        "confidence": conf,
        "confidence_label": CONFIDENCE_LABELS.get(int(conf)) if conf is not None else None,  # derived
        "frp": props.get("frp"),
        "DayNight": dn,
        "DayNight_label": DAYNIGHT_LABELS.get(int(dn)) if dn is not None else None,           # derived
        "line_number": props.get("line_number"),
    }


def pixel_warnings(pixels: list[dict[str, Any]]) -> list[str]:
    """Runtime sanity checks on retrieved pixels (evidence about mask / unit assumptions)."""
    w: list[str] = []
    bad_conf = [p["confidence"] for p in pixels if p["confidence"] not in (0, 1, 2, None)]
    if bad_conf:
        w.append(f"Unexpected confidence values {sorted(set(bad_conf))}; expected only 0, 1, 2. "
                 "Mask/confidence assumptions may be wrong.")
    mismatch = [p for p in pixels if p["acq_epoch"] is not None and p["acq_time"] is not None
                and int(p["acq_epoch"]) % 86400 != int(p["acq_time"])]
    if mismatch:
        w.append("acq_time does not equal acq_epoch's seconds-since-midnight (UTC) for some pixels; "
                 "the catalog's unit for acq_time may not hold. Use acq_epoch / acquisition_timestamp_utc.")
    if any(p["latitude"] is None or p["longitude"] is None for p in pixels):
        w.append("Some pixels lack coordinates.")
    return w


# ----------------------------------------------------------------- the query
def query_viirs(start: date, end: date, bbox: tuple[float, float, float, float],
                platform_key: str = "snpp", max_images: int = 3, sample_pixels: int = 10) -> dict[str, Any]:
    """
    Query a VIIRS active-fire collection. `end` is INCLUSIVE. Real data only.
    Counts: matching_images (rasters) / total_fire_pixels_in_bbox (all matching images) /
    sampled_pixels_returned (a random SAMPLE, not the full set).
    """
    cfg = PLATFORMS.get(platform_key)
    if cfg is None or not cfg["enabled"]:
        raise GeeError("PLATFORM_NOT_AVAILABLE", f"Platform '{platform_key}' is not enabled.", 422)

    validate_query(start, end, bbox)
    min_lon, min_lat, max_lon, max_lat = bbox
    cap = config.max_viirs_bbox_degrees()
    if (max_lon - min_lon) > cap or (max_lat - min_lat) > cap:
        raise GeeError("BBOX_TOO_LARGE", f"VIIRS (375 m) bounding box side exceeds {cap} degrees.", 422,
                       "Use a smaller box; 375 m data is ~7x denser than MODIS.")
    gee.gee_service.ensure_ready()
    ee = gee.ee

    try:
        region = ee.Geometry.Rectangle([min_lon, min_lat, max_lon, max_lat], "EPSG:4326", False)
        col = (ee.ImageCollection(cfg["collection_id"])
               .filterDate(start.isoformat(), (end + timedelta(days=1)).isoformat())
               .filterBounds(region))
        n_images = int(col.size().getInfo())

        dataset = {"id": cfg["collection_id"], "platform": cfg["platform"], "instrument": cfg["instrument"],
                   "product": cfg["product"], "pixel_size_m": SCALE_M, "cadence": "daily",
                   "catalog_url": cfg["catalog_url"],
                   "quality": "near-real-time, not science quality"}
        base = {"connected": True, "dataset": dataset,
                "query": {"start_date": start.isoformat(), "end_date": end.isoformat(), "end_date_inclusive": True,
                          "bbox": {"min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat}}}

        if n_images == 0:
            full = ee.ImageCollection(cfg["collection_id"])
            lo = full.aggregate_min("system:time_start").getInfo()
            hi = full.aggregate_max("system:time_start").getInfo()
            return {**base, "status": "no_data",
                    "message": "No images match this date range and bounding box. See dataset_coverage for the "
                               "collection's actual first/last image dates (the catalog's stated range is not reliable).",
                    "dataset_coverage": {"first_image": _iso_from_ms(lo), "last_image": _iso_from_ms(hi)},
                    "counts": {"matching_images": 0, "images_with_fire_pixels": 0, "total_fire_pixels_in_bbox": 0,
                               "images_sampled": 0, "sampled_pixels_returned": 0},
                    "band_names": [], "missing_bands": [], "daily_summary": [], "images": [], "warnings": []}

        ordered = col.sort("system:time_start")
        band_names = ee.Image(ordered.first()).bandNames().getInfo()
        missing = check_bands(band_names)
        if "confidence" in missing:
            raise GeeError("MISSING_BANDS", f"Collection images lack the 'confidence' band; found {band_names}.", 502)

        def summarize(img):
            img = ee.Image(img)
            n = fire_pixel_image(img).select("confidence").reduceRegion(
                reducer=ee.Reducer.count(), geometry=region, scale=SCALE_M, maxPixels=int(1e9)).get("confidence")
            n_conf = img.select("confidence").reduceRegion(   # diagnostic only: NOT a fire count
                reducer=ee.Reducer.count(), geometry=region, scale=SCALE_M, maxPixels=int(1e9)).get("confidence")
            return ee.Feature(None, {"id": img.id(), "index": img.get("system:index"),
                                    "time_start": img.get("system:time_start"), "fire_pixels": n,
                                    "conf_unmasked": n_conf})

        rows = ee.FeatureCollection(ordered.map(summarize)).getInfo().get("features", [])
        daily = [{"image_id": r["properties"].get("id"), "image_index": r["properties"].get("index"),
                  "confidence_band_unmasked_pixels": r["properties"].get("conf_unmasked"),
                  "observation_date": _iso_from_ms(r["properties"].get("time_start")),
                  # count of unmasked pixels; a fully masked image yields 0 (or no value) -> reported as 0
                  "fire_pixels_in_bbox": r["properties"].get("fire_pixels") or 0} for r in rows]
        total_pixels = sum(d["fire_pixels_in_bbox"] for d in daily)
        with_fire = [d for d in daily if d["fire_pixels_in_bbox"] > 0]

        images, all_pixels = [], []
        for d in with_fire[:max_images]:
            if d["image_index"] is None:
                continue
            # img.id() is not a reliable asset path for collection images; select by system:index instead.
            img = ee.Image(ordered.filter(ee.Filter.eq("system:index", d["image_index"])).first())
            img = fire_pixel_image(img)
            fc = (img.sample(region=region, scale=SCALE_M, geometries=True)
                  .randomColumn("_r", 42).sort("_r").limit(sample_pixels).getInfo())
            distinct = img.select("line_number").reduceRegion(
                reducer=ee.Reducer.countDistinct(), geometry=region, scale=SCALE_M,
                maxPixels=int(1e9)).get("line_number").getInfo() if "line_number" in band_names else None
            pix = []
            for f in fc.get("features", []):
                props = {k: v for k, v in f.get("properties", {}).items() if k != "_r"}
                pix.append(format_pixel(props, (f.get("geometry") or {}).get("coordinates"), cfg))
            all_pixels.extend(pix)
            images.append({"image_id": d["image_id"], "observation_date": d["observation_date"],
                           "fire_pixels_in_bbox": d["fire_pixels_in_bbox"],
                           "distinct_source_records_in_bbox": distinct,
                           "sample_pixels": pix})

        warnings = pixel_warnings(all_pixels)
        conf_total = sum((d.get("confidence_band_unmasked_pixels") or 0) for d in daily)
        if conf_total > total_pixels:
            warnings.append(
                f"The confidence band alone is unmasked for {conf_total} pixels (the whole footprint) versus "
                f"{total_pixels} pixels where all bands are valid. Fire pixels are counted as all-bands-valid.")
        # Per-band unmasked pixel counts for one image: shows exactly which bands are masked outside detections.
        diag_idx = (with_fire[0] if with_fire else daily[0]).get("image_index") if daily else None
        diagnostics = None
        if diag_idx is not None:
            raw = ee.Image(ordered.filter(ee.Filter.eq("system:index", diag_idx)).first())
            diagnostics = {"image_id": (with_fire[0] if with_fire else daily[0])["image_id"],
                           "band_unmasked_pixel_counts": raw.reduceRegion(
                               reducer=ee.Reducer.count(), geometry=region, scale=SCALE_M,
                               maxPixels=int(1e9)).getInfo()}
        if missing:
            warnings.append(f"Expected bands absent from the data: {missing}")

        return {**base, "status": "ok",
                "message": (f"{n_images} daily image(s) matched; {total_pixels} fire pixel(s) in the bbox across them. "
                            f"Sampled {len(all_pixels)} pixel(s) from {len(images)} image(s) with fire pixels."
                            if total_pixels else
                            f"{n_images} image(s) matched but contain 0 fire pixels inside the bbox."),
                "counts": {"matching_images": n_images, "images_with_fire_pixels": len(with_fire),
                           "total_fire_pixels_in_bbox": total_pixels,
                           "images_sampled": len(images), "sampled_pixels_returned": len(all_pixels),
                           "note": "Image = one day of raster. A fire pixel = a pixel where ALL bands are valid (the confidence "
                                   "band alone is valid over the whole footprint). Several pixels can share one "
                                   "line_number (one source record). sample_pixels is a RANDOM SAMPLE (seed 42); "
                                   "total_fire_pixels_in_bbox is the complete fire-pixel count for the bbox."},
                "diagnostics": diagnostics,
                "band_names": band_names, "missing_bands": missing, "band_units": BAND_UNITS,
                "confidence_meaning": {str(k): v for k, v in CONFIDENCE_LABELS.items()},
                "daily_summary": [{k: v for k, v in d.items() if k != "image_index"} for d in daily], "images": images, "warnings": warnings}
    except GeeError:
        raise
    except Exception as exc:  # noqa: BLE001
        err = classify_exception(exc)
        log.warning("VIIRS query failed: %s [%s] raw=%s", err.message, err.code, exc)
        raise err from exc
