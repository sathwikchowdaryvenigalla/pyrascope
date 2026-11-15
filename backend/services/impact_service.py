"""
Environmental context for ONE selected fire observation.

Evidence tiers (never mixed):
  observed   - the satellite detection itself (echoed from the selected observation; nothing added)
  estimated  - geographic context around the detection (land cover, protected areas, population, smoke indicators).
               This describes what is EXPOSED near the point, not damage that happened.
  confirmed  - burned area, ONLY when the independent MODIS MCD64A1 product maps a burned pixel at the location.

Rules: no hectares / tree loss / wildlife / economic figures are ever computed (and never from FRP); no overall
score; a dataset that cannot be queried is returned as status "unavailable" with the reason - never invented.

Datasets (Earth Engine catalog):
  ESA/WorldCover/v200 (2021, 10 m)            land cover
  MODIS/061/MCD64A1 (monthly, 500 m)           burned area (independent of the active-fire product)
  WCMC/WDPA/current/polygons                   protected areas
  COPERNICUS/S5P/OFFL/L3_AER_AI, L3_CO         smoke / CO indicators (Sentinel-5P TROPOMI)
  CIESIN/GPWv411/GPW_Population_Count          population (latest epoch, ~1 km)
Soil: no soil dataset is integrated, so it is reported as unavailable.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from backend.services.gee_service import GeeError, classify_exception, ee, gee_service

log = logging.getLogger("pyrascope.impact")

UNAVAILABLE_TEXT = "Data unavailable — additional environmental data required."
CACHE_TTL_S = 600
_cache: dict[tuple, tuple[float, dict]] = {}

WORLDCOVER_ID = "ESA/WorldCover/v200"
BURNED_ID = "MODIS/061/MCD64A1"
WDPA_ID = "WCMC/WDPA/current/polygons"
AER_AI_ID, AER_AI_BAND = "COPERNICUS/S5P/OFFL/L3_AER_AI", "absorbing_aerosol_index"
CO_ID, CO_BAND = "COPERNICUS/S5P/OFFL/L3_CO", "CO_column_number_density"
POP_ID = "CIESIN/GPWv411/GPW_Population_Count"

LANDCOVER = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up", 60: "Bare / sparse vegetation",
             70: "Snow and ice", 80: "Permanent water", 90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen"}
VEGETATED = {10, 20, 30, 40, 90, 95, 100}
HABITAT_CLASSES = {10, 90, 95}
LC_RADIUS_M, WDPA_RADIUS_M, AQ_RADIUS_M, BURN_RADIUS_M = 1000, 5000, 25000, 1000
POP_RADII_M = (5000, 10000)


# ----------------------------------------------------------------------------- section helpers
def src(name: str, dataset_id: str, resolution: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"name": name, "dataset_id": dataset_id, "resolution": resolution, **extra}


def section(sid: str, title: str, status: str, evidence: str, headline: str, facts: list[dict] | None = None,
            sources: list[dict] | None = None, limitations: list[str] | None = None, reason: str | None = None) -> dict[str, Any]:
    """status: ok | unavailable | insufficient.  evidence: estimated | confirmed | none."""
    return {"id": sid, "title": title, "status": status, "evidence": evidence, "headline": headline,
            "facts": facts or [], "sources": sources or [], "limitations": limitations or [], "reason": reason}


def unavailable(sid: str, title: str, reason: str, sources: list[dict] | None = None) -> dict[str, Any]:
    return section(sid, title, "unavailable", "none", UNAVAILABLE_TEXT, sources=sources, reason=reason)


def _fact(label: str, value: Any) -> dict[str, Any]:
    return {"label": label, "value": value}


# ----------------------------------------------------------------------------- pure interpretation (unit-tested)
def summarize_landcover(point_class: Any, hist: dict[str, float] | None) -> dict[str, Any] | None:
    """WorldCover class at the point and class shares inside the radius. None if nothing was returned."""
    if not hist:
        return None
    counts = {int(float(k)): float(v) for k, v in hist.items()}
    total = sum(counts.values())
    if total <= 0:
        return None
    shares = {c: n / total * 100 for c, n in counts.items()}
    dominant = max(shares, key=shares.get)
    pc = int(point_class) if point_class is not None else None
    return {"point_class": pc, "point_label": LANDCOVER.get(pc) if pc is not None else None,
            "dominant_class": dominant, "dominant_label": LANDCOVER.get(dominant, f"class {dominant}"),
            "shares": {LANDCOVER.get(c, f"class {c}"): round(s, 1) for c, s in sorted(shares.items(), key=lambda kv: -kv[1])},
            "vegetated_pct": round(sum(s for c, s in shares.items() if c in VEGETATED), 1),
            "habitat_pct": round(sum(s for c, s in shares.items() if c in HABITAT_CLASSES), 1),
            "tree_pct": round(shares.get(10, 0.0), 1), "builtup_pct": round(shares.get(50, 0.0), 1)}


def burn_date_from_doy(year: int, doy: int) -> str | None:
    if not 1 <= doy <= 366:
        return None
    d = date(year, 1, 1) + timedelta(days=doy - 1)
    return d.isoformat() if d.year == year else None


def interpret_air(day: float | None, base: float | None) -> str:
    """Descriptive comparison only. It cannot attribute a smoke plume to this particular fire."""
    if day is None:
        return "no_overpass_value"
    if base is None:
        return "no_baseline"
    return "above_local_mean" if day > base else "at_or_below_local_mean"


def assessment_category(confirmed: dict, context: list[dict]) -> dict[str, Any]:
    """Rule-based CATEGORY (not a score)."""
    n_ok = sum(1 for s in context if s["status"] == "ok")
    queried = [s for s in context if s["id"] != "soil"]
    ok_q = sum(1 for s in queried if s["status"] == "ok")
    if confirmed["evidence"] == "confirmed":
        cat = "Burned area confirmed by independent data"
        detail = "An independent burned-area product maps burned pixels at this location. Extent and severity are not quantified here."
    elif n_ok:
        cat = "Fire detection with estimated environmental context"
        detail = "A satellite fire detection with geographic context. Environmental damage is NOT confirmed."
    else:
        cat = "Insufficient evidence"
        detail = "A satellite fire detection only. No supporting environmental dataset returned data."
    return {"category": cat, "detail": detail,
            "evidence_availability": {"datasets_returning_data": ok_q, "datasets_queried": len(queried),
                                      "burned_area_confirmed": confirmed["evidence"] == "confirmed"}}


# ----------------------------------------------------------------------------- Earth Engine queries (one per dataset)
def _q_landcover(lon: float, lat: float) -> dict:
    pt = ee.Geometry.Point([lon, lat])
    img = ee.ImageCollection(WORLDCOVER_ID).first().select("Map")
    return ee.Dictionary({
        "point": img.reduceRegion(ee.Reducer.first(), pt, 10).get("Map"),
        "hist": img.reduceRegion(ee.Reducer.frequencyHistogram(), pt.buffer(LC_RADIUS_M), 30, maxPixels=int(1e8)).get("Map"),
    }).getInfo()


def _q_burned(lon: float, lat: float, d: date) -> dict:
    pt = ee.Geometry.Point([lon, lat])
    m0 = d.replace(day=1)
    m1 = (m0 + timedelta(days=32)).replace(day=1)
    full = ee.ImageCollection(BURNED_ID)
    col = full.filterDate(m0.isoformat(), m1.isoformat()).filterBounds(pt)
    n = col.size()
    area = pt.buffer(BURN_RADIUS_M)
    burn = col.select("BurnDate").mosaic()
    burned = burn.gt(0).selfMask()
    stats = ee.Algorithms.If(n.gt(0), ee.Dictionary({
        "burned_px": burned.reduceRegion(ee.Reducer.count(), area, 500, maxPixels=int(1e7)).get("BurnDate"),
        "first_doy": burn.updateMask(burn.gt(0)).reduceRegion(ee.Reducer.min(), area, 500, maxPixels=int(1e7)).get("BurnDate"),
    }), None)
    return ee.Dictionary({"n_images": n, "stats": stats, "latest_ms": full.aggregate_max("system:time_start")}).getInfo()


def _q_wdpa(lon: float, lat: float) -> dict:
    pt = ee.Geometry.Point([lon, lat])
    fc = ee.FeatureCollection(WDPA_ID).filterBounds(pt.buffer(WDPA_RADIUS_M)).limit(10)
    slim = fc.map(lambda f: ee.Feature(None, {
        "NAME": f.get("NAME"), "DESIG": f.get("DESIG_ENG"), "IUCN": f.get("IUCN_CAT"), "STATUS": f.get("STATUS"),
        "MARINE": f.get("MARINE"), "DIST_M": f.geometry().distance(pt, 100)}))
    return {"features": [x["properties"] for x in slim.getInfo().get("features", [])]}


def _q_air(lon: float, lat: float, d: date, col_id: str, band: str) -> dict:
    area = ee.Geometry.Point([lon, lat]).buffer(AQ_RADIUS_M)
    col = ee.ImageCollection(col_id).select(band).filterBounds(area)
    d0, d1, b0 = d.isoformat(), (d + timedelta(days=1)).isoformat(), (d - timedelta(days=30)).isoformat()
    day_c, base_c = col.filterDate(d0, d1), col.filterDate(b0, d0)

    def mean_of(c):
        return ee.Algorithms.If(c.size().gt(0), c.mean().reduceRegion(ee.Reducer.mean(), area, 5000, maxPixels=int(1e8)).get(band), None)

    return ee.Dictionary({"day": mean_of(day_c), "base": mean_of(base_c), "n_day": day_c.size(), "n_base": base_c.size()}).getInfo()


def _q_population(lon: float, lat: float) -> dict:
    pt = ee.Geometry.Point([lon, lat])
    img = ee.ImageCollection(POP_ID).sort("system:time_start", False).first()
    band = img.select("population_count")
    scale = band.projection().nominalScale()
    out = {"year": ee.Date(img.get("system:time_start")).get("year")}
    for r in POP_RADII_M:
        out[f"r{r}"] = band.reduceRegion(ee.Reducer.sum(), pt.buffer(r), scale, maxPixels=int(1e9)).get("population_count")
    return ee.Dictionary(out).getInfo()


# ----------------------------------------------------------------------------- section builders
def _guard(sid: str, title: str, sources: list[dict], fn: Callable[[], dict]) -> dict[str, Any]:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - each dataset fails independently
        err = classify_exception(exc)
        log.warning("impact %s failed: %s [%s]", sid, err.message, err.code)
        return unavailable(sid, title, f"{err.message} ({err.code})", sources)


def build_vegetation_and_habitat(lon: float, lat: float) -> tuple[dict, dict]:
    wc_src = [src("ESA WorldCover 2021 land cover", WORLDCOVER_ID, "10 m", year=2021)]
    wd_src = [src("World Database on Protected Areas (UNEP-WCMC / IUCN)", WDPA_ID, "polygons")]

    lc: dict | None = None
    lc_err: str | None = None
    try:
        raw = _q_landcover(lon, lat)
        lc = summarize_landcover(raw.get("point"), raw.get("hist"))
        if lc is None:
            lc_err = "WorldCover returned no land-cover pixels here (for example open water or no coverage)."
    except Exception as exc:  # noqa: BLE001
        e = classify_exception(exc)
        lc_err = f"{e.message} ({e.code})"

    pa: list[dict] | None = None
    pa_err: str | None = None
    try:
        pa = _q_wdpa(lon, lat)["features"]
    except Exception as exc:  # noqa: BLE001
        e = classify_exception(exc)
        pa_err = f"{e.message} ({e.code})"

    lim_lc = ["Land cover is a 2021 map; the surface may have changed since.",
              "A satellite fire detection pixel (375 m – 1 km) is not the same as a burned area."]
    if lc is None:
        veg = unavailable("vegetation", "Vegetation", lc_err or "no data", wc_src)
    else:
        top = ", ".join(f"{k} {v:g}%" for k, v in list(lc["shares"].items())[:3])
        veg = section("vegetation", "Vegetation", "ok", "estimated",
                      f"Surface at the detection point: {lc['point_label'] or 'not classified'}. Dominant within {LC_RADIUS_M // 1000} km: {lc['dominant_label']}.",
                      [_fact("Vegetated land within 1 km", f"{lc['vegetated_pct']} %"), _fact("Largest classes (1 km radius)", top)],
                      wc_src, lim_lc + ["Whether the vegetation burned is not shown by land cover. See the burned-area evidence."])

    facts, parts, sources, lims, hab_ok = [], [], [], [], False
    if lc is not None:
        hab_ok = True
        facts += [_fact("Tree cover within 1 km", f"{lc['tree_pct']} %"), _fact("Forest + wetland + mangrove within 1 km", f"{lc['habitat_pct']} %")]
        parts.append(f"{lc['habitat_pct']} % of the surrounding 1 km is forest, wetland or mangrove")
        sources += wc_src
        lims += lim_lc
    if pa is not None:
        hab_ok = True
        sources += wd_src
        land_pa = [p for p in pa if str(p.get("MARINE")) in ("0", "None", "") or p.get("MARINE") in (0, None)]
        inside = [p for p in land_pa if (p.get("DIST_M") or 0) <= 0]
        near = [p for p in land_pa if (p.get("DIST_M") or 0) > 0]
        if inside:
            n = inside[0]
            facts.append(_fact("Protected area containing the point", f"{n.get('NAME') or 'unnamed'} ({n.get('DESIG') or 'designation n/a'}, IUCN {n.get('IUCN') or 'n/a'})"))
            parts.append("the point lies inside a designated protected area")
        elif near:
            n = min(near, key=lambda p: p["DIST_M"])
            facts.append(_fact("Nearest protected area (within 5 km)", f"{n.get('NAME') or 'unnamed'} ({n.get('DESIG') or 'designation n/a'}), about {n['DIST_M'] / 1000:.1f} km away"))
            parts.append("a protected area lies within 5 km")
        else:
            facts.append(_fact("Protected areas within 5 km", "None in WDPA"))
            parts.append("no WDPA protected area within 5 km")
        lims.append("WDPA lists designated areas only. Absence does not mean the area is ecologically unimportant.")
    if not hab_ok:
        hab = unavailable("habitat", "Forest and habitat exposure", f"Land cover: {lc_err}; protected areas: {pa_err}", wc_src + wd_src)
    else:
        missing = []
        if lc is None:
            missing.append("land cover unavailable")
        if pa is None:
            missing.append("protected-area data unavailable")
        hab = section("habitat", "Forest and habitat exposure", "ok", "estimated",
                      "Exposure context: " + "; ".join(parts) + ".", facts, sources, lims + ([f"Partial: {', '.join(missing)}."] if missing else []))
    return veg, hab


def build_burned_area(lon: float, lat: float, d: date) -> dict:
    s = [src("MODIS Burned Area MCD64A1 (monthly)", BURNED_ID, "500 m")]
    title = "Burned area (independent evidence)"

    def run() -> dict:
        r = _q_burned(lon, lat, d)
        latest = datetime.fromtimestamp(r["latest_ms"] / 1000, tz=timezone.utc).date().isoformat() if r.get("latest_ms") else None
        if not r.get("n_images"):
            return section("burned_area", title, "insufficient", "none",
                           "Insufficient evidence: no MCD64A1 burned-area product exists yet for this month.",
                           sources=s, limitations=["MCD64A1 is produced weeks after the observation month; newer fires cannot be checked yet."]
                           + ([f"Latest MCD64A1 image in Earth Engine: {latest}."] if latest else []))
        st = r.get("stats") or {}
        px = int(st.get("burned_px") or 0)
        lims = ["500 m product: small, short or low-severity burns can be missed, so no burned pixel does not rule out burning.",
                "Burned-area extent (hectares) and burn severity are not calculated here."]
        if px > 0:
            doy = st.get("first_doy")
            bd = burn_date_from_doy(d.year, int(doy)) if doy else None
            facts = [_fact("Burned 500 m pixels within 1 km of the detection", str(px))]
            if bd:
                facts.append(_fact("Earliest mapped burn date in that footprint", bd))
            return section("burned_area", title, "ok", "confirmed",
                           "Confirmed by supporting data: the independent MCD64A1 product maps burned area at this location in the observation month.",
                           facts, s, lims)
        return section("burned_area", title, "ok", "none",
                       "No burned pixel is mapped by MCD64A1 within 1 km for this month. Burning is neither confirmed nor ruled out.",
                       [_fact("Burned 500 m pixels within 1 km of the detection", "0")], s, lims)

    return _guard("burned_area", title, s, run)


def build_air_quality(lon: float, lat: float, d: date) -> dict:
    s = [src("Sentinel-5P TROPOMI UV aerosol index (offline)", AER_AI_ID, "~3.5 x 7 km"),
         src("Sentinel-5P TROPOMI carbon monoxide (offline)", CO_ID, "~5.5 x 7 km")]
    title = "Air quality"
    rows, got_any, errs = [], False, []
    for label, cid, band, unit in (("UV aerosol index", AER_AI_ID, AER_AI_BAND, ""), ("CO column", CO_ID, CO_BAND, " mol/m²")):
        try:
            r = _q_air(lon, lat, d, cid, band)
        except Exception as exc:  # noqa: BLE001
            e = classify_exception(exc)
            errs.append(f"{label}: {e.message} ({e.code})")
            continue
        verdict = interpret_air(r.get("day"), r.get("base"))
        if r.get("day") is None:
            rows.append(_fact(label, "No satellite value on the observation date"))
            continue
        got_any = True
        fmt = (lambda v: f"{v:.3g}{unit}") if unit else (lambda v: f"{v:.2f}")
        txt = f"{fmt(r['day'])} (25 km mean on the observation date)"
        if r.get("base") is not None:
            txt += f" vs {fmt(r['base'])} (30-day prior mean) — {'above' if verdict == 'above_local_mean' else 'at or below'} the local prior mean"
        else:
            txt += " — no prior baseline available"
        rows.append(_fact(label, txt))
    if not got_any:
        reason = "; ".join(errs) or "Sentinel-5P returned no value for this day and place (cloud, gap in coverage or processing delay)."
        return section("air_quality", title, "unavailable" if errs else "insufficient", "none",
                       UNAVAILABLE_TEXT if errs else "Insufficient evidence: no Sentinel-5P value on the observation date.",
                       rows, s, ["Satellite smoke indicators are often missing under cloud or outside the overpass."], reason)
    return section("air_quality", title, "ok", "estimated",
                   "Satellite smoke / CO indicators near the detection (supporting only). Not a ground air-quality measurement.",
                   rows, s, ["Regional aerosol and CO also come from other fires, dust and pollution; this does not attribute any plume to this detection.",
                             "No ground-level PM2.5 / AQI data is integrated."] + [f"Partly unavailable: {e}" for e in errs])


def build_settlements(lon: float, lat: float) -> dict:
    s = [src("GPWv4.11 population count (CIESIN, Columbia University)", POP_ID, "~1 km")]
    title = "Nearby settlements"

    def run() -> dict:
        r = _q_population(lon, lat)
        a, b = r.get(f"r{POP_RADII_M[0]}"), r.get(f"r{POP_RADII_M[1]}")
        if a is None and b is None:
            return section("settlements", title, "insufficient", "none", "Insufficient evidence: no population raster value here.", sources=s)
        yr = r.get("year")
        facts = [_fact("People within 5 km (modelled)", f"~{round(a):,}" if a is not None else "n/a"),
                 _fact("People within 10 km (modelled)", f"~{round(b):,}" if b is not None else "n/a")]
        lead = f"~{round(a):,} people modelled within 5 km" if a is not None else "Population modelled within 10 km"
        return section("settlements", title, "ok", "estimated", f"{lead} (GPWv4, {yr} epoch).", facts, s,
                       ["Modelled gridded population from a past epoch, not a count of people at risk.",
                        "Distance to the nearest named settlement is not computed (no settlement-point dataset integrated)."])

    return _guard("settlements", title, s, run)


def soil_section() -> dict:
    return unavailable("soil", "Soil", "No soil dataset is integrated, so soil degradation cannot be assessed.")


# ----------------------------------------------------------------------------- orchestration
def _cache_get(key: tuple) -> dict | None:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    return None


def build_impact(observation_id: str, observed: dict[str, Any]) -> dict[str, Any]:
    """`observed` is the metadata of the selected observation (as supplied by the client; echoed, never altered)."""
    lat, lon = observed["latitude"], observed["longitude"]
    d = date.fromisoformat(observed["acquisition_date"])
    key = (observation_id, round(lat, 5), round(lon, 5), d)
    cached = _cache_get(key)
    if cached:
        return {**cached, "served_from_cache": True}

    ee_status: dict[str, Any] = {"available": True, "message": None}
    try:
        gee_service.ensure_ready()
    except GeeError as e:
        ee_status = {"available": False, "message": f"{e.message} ({e.code})"}

    if ee_status["available"]:
        with ThreadPoolExecutor(max_workers=5) as pool:
            f_vh = pool.submit(build_vegetation_and_habitat, lon, lat)
            f_burn = pool.submit(build_burned_area, lon, lat, d)
            f_air = pool.submit(build_air_quality, lon, lat, d)
            f_pop = pool.submit(build_settlements, lon, lat)
            veg, hab = f_vh.result()
            confirmed, air, pop = f_burn.result(), f_air.result(), f_pop.result()
    else:
        why = ee_status["message"]
        veg = unavailable("vegetation", "Vegetation", why, [src("ESA WorldCover 2021", WORLDCOVER_ID)])
        hab = unavailable("habitat", "Forest and habitat exposure", why, [src("WDPA", WDPA_ID)])
        air = unavailable("air_quality", "Air quality", why, [src("Sentinel-5P", AER_AI_ID)])
        pop = unavailable("settlements", "Nearby settlements", why, [src("GPWv4.11", POP_ID)])
        confirmed = unavailable("burned_area", "Burned area (independent evidence)", why, [src("MCD64A1", BURNED_ID)])

    estimated = [veg, hab, air, soil_section(), pop]
    out = {
        "status": "ok" if ee_status["available"] else "partial",
        "observation_id": observation_id,
        "observed": {**observed, "evidence": "observed",
                     "note": "Satellite detection metadata of the selected observation. A detection is not proof of a large wildfire."},
        "estimated": estimated,
        "confirmed": confirmed,
        "assessment": assessment_category(confirmed, estimated),
        "earth_engine": ee_status,
        "limitations": ["Estimated items describe what lies near the detection, not damage that occurred.",
                        "Hectares burned, tree loss, wildlife deaths and economic damage are never derived from fire radiative power or a detection.",
                        "No overall environmental-damage score is produced."],
        "served_from_cache": False,
    }
    if ee_status["available"]:
        _cache[key] = (time.monotonic(), out)
    return out
