"""
Historical Fire Intelligence (Earth Engine). REUSES the existing GEE singleton / error classification.

Archive sources (daily 1 km gridded thermal-anomaly products, science-quality, long archive):
    MODIS Terra  MODIS/061/MOD14A1      bands FireMask, MaxFRP (x0.1 MW), QA, sample
    MODIS Aqua   MODIS/061/MYD14A1      same bands
    Suomi NPP    NASA/VIIRS/002/VNP14A1 same band names (1 km gridded VIIRS)
NOAA-20 / NOAA-21 VIIRS are NOT integrated: no Earth Engine archive collection is wired for them (see /sources).
The live NRT collections used by the existing 3-31 day view are untouched.

Record semantics: one RECORD = one 1 km grid cell on one day whose FireMask is 7/8/9 (low / nominal / high confidence
fire). It is NOT a unique fire and NOT a raw hotspot. MaxFRP is the maximum FRP among detections inside the cell
(MW). FRP is radiative power; it is not burned area or damage. Sensors are never merged or converted.

Coverage dates are read from the collections at runtime (aggregate_min/max); nothing is assumed.
Completed past months are immutable -> cached on disk; the current month is cached for a short TTL only.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from backend import config
from backend.services import gee_service as gee
from backend.services.gee_service import GeeError, classify_exception

log = logging.getLogger("pyrascope.history")

SCALE_M = 1000
FIRE_MIN_CLASS = 7          # FireMask 7 low, 8 nominal, 9 high confidence
FRP_SCALE = 0.1             # MaxFRP is stored in units of 0.1 MW
SOURCES: dict[str, dict[str, Any]] = {
    "MODIS_TERRA": {"family": "MODIS", "collection_id": "MODIS/061/MOD14A1", "platform": "Terra", "instrument": "MODIS",
                    "resolution_m": 1000, "documented_start": "2000-02-18"},
    "MODIS_AQUA": {"family": "MODIS", "collection_id": "MODIS/061/MYD14A1", "platform": "Aqua", "instrument": "MODIS",
                   "resolution_m": 1000, "documented_start": "2002-07-04"},
    "VIIRS_SNPP": {"family": "VIIRS", "collection_id": "NASA/VIIRS/002/VNP14A1", "platform": "Suomi NPP", "instrument": "VIIRS",
                   "resolution_m": 1000, "documented_start": "2012-01-19"},
}
NOT_INTEGRATED = [
    {"key": "VIIRS_NOAA20", "platform": "NOAA-20", "reason": "No verified Earth Engine archive collection is configured; not queried."},
    {"key": "VIIRS_NOAA21", "platform": "NOAA-21", "reason": "No verified Earth Engine archive collection is configured; not queried."},
]
RANGES = {"3d": 3, "7d": 7, "30d": 30, "90d": 90, "1y": 365, "5y": 5 * 365, "10y": 10 * 365}
WORLDCOVER_ID = "ESA/WorldCover/v200"
# ESA WorldCover class -> PyraScope context group (classification of the surrounding land, NOT a fire cause)
LC_GROUPS = {10: "Forest", 20: "Grassland and shrubland", 30: "Grassland and shrubland", 40: "Agricultural land",
             50: "Built-up areas", 60: "Other land cover", 70: "Other land cover", 80: "Other land cover",
             90: "Other land cover", 95: "Forest", 100: "Other land cover"}

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}
_MEM_MAX = 256
CACHE_DIR = config.PROJECT_ROOT / "backend" / ".history_cache"


# ------------------------------------------------------------------ pure helpers (unit-tested offline)
def resolve_period(range_key: str, start: date | None, end: date | None, today: date | None = None) -> tuple[date | None, date]:
    """Return (start, end). start None = 'all available history' (clamped later to real coverage)."""
    today = today or datetime.now(timezone.utc).date()
    if range_key == "custom":
        if not start or not end:
            raise GeeError("INVALID_DATE_RANGE", "Custom range needs start_date and end_date.", 422)
        if start > end:
            raise GeeError("INVALID_DATE_RANGE", "start_date must be on or before end_date.", 422)
        return start, min(end, today)
    if range_key == "all":
        return None, today
    if range_key in RANGES:
        return today - timedelta(days=RANGES[range_key] - 1), today
    raise GeeError("INVALID_RANGE", f"Unknown range '{range_key}'.", 422)


def month_chunks(start: date, end: date) -> list[tuple[int, int, date, date]]:
    """Calendar-month chunks (year, month, first_day, last_day) clipped to [start, end]."""
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        first = date(y, m, 1)
        nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
        out.append((y, m, max(first, start), min(nxt - timedelta(days=1), end)))
        y, m = nxt.year, nxt.month
    return out


def validate_history_bbox(bbox: tuple[float, float, float, float]) -> None:
    w, s, e, n = bbox
    if not (-180 <= w < e <= 180) or not (-90 <= s < n <= 90):
        raise GeeError("INVALID_BBOX", "Bounding box must satisfy -180<=min_lon<max_lon<=180 and -90<=min_lat<max_lat<=90.", 422)
    cap = config.max_history_bbox_degrees()
    if (e - w) > cap or (n - s) > cap:
        raise GeeError("BBOX_TOO_LARGE", f"Historical queries are limited to {cap} degrees per side "
                       "(the global archive is never requested).", 422, "Select a country, state, city or drawn box.")


def aggregate(months: list[dict[str, Any]]) -> dict[str, Any]:
    """Pure aggregation of per-source-month rows into overview / annual / monthly / seasonal / per-source stats.
    Row: {source, year, month, records, frp_sum_mw, frp_n, frp_max_mw, images, expected_days}."""
    def blank():
        return {"records": 0, "frp_sum": 0.0, "frp_n": 0, "frp_max": None, "images": 0, "expected_days": 0}

    def add(b, r):
        b["records"] += r["records"]; b["frp_sum"] += r["frp_sum_mw"]; b["frp_n"] += r["frp_n"]
        b["images"] += r["images"]; b["expected_days"] += r["expected_days"]
        if r["frp_max_mw"] is not None:
            b["frp_max"] = r["frp_max_mw"] if b["frp_max"] is None else max(b["frp_max"], r["frp_max_mw"])

    def fin(b):
        return {"records": b["records"], "frp_mean_mw": round(b["frp_sum"] / b["frp_n"], 2) if b["frp_n"] else None,
                "frp_max_mw": b["frp_max"], "frp_records": b["frp_n"], "images": b["images"], "expected_days": b["expected_days"]}

    annual: dict[tuple, dict] = {}; monthly: dict[tuple, dict] = {}; tot: dict[str, dict] = {}
    ym: dict[tuple, dict] = {}
    for r in months:
        fam = SOURCES[r["source"]]["family"]
        for store, key in ((annual, (r["year"], fam)), (annual, (r["year"], "ALL")), (annual, (r["year"], r["source"])),
                           (monthly, (r["month"], fam)), (monthly, (r["month"], "ALL")), (monthly, (r["month"], r["source"])),
                           (tot, (fam,)), (tot, ("ALL",)), (tot, (r["source"],)),
                           (ym, (r["year"], r["month"], fam)), (ym, (r["year"], r["month"], "ALL"))):
            b = store.setdefault(key if len(key) > 1 else key[0], blank()); add(b, r)
    years = sorted({r["year"] for r in months})
    annual_rows = []
    for y in years:
        row = {"year": y}
        for k in ("MODIS", "VIIRS", "ALL", "MODIS_TERRA", "MODIS_AQUA", "VIIRS_SNPP"):
            row[k] = fin(annual[(y, k)]) if (y, k) in annual else None
        annual_rows.append(row)
    monthly_rows = []
    for m in range(1, 13):
        row = {"month": m}
        for k in ("MODIS", "VIIRS", "ALL", "MODIS_TERRA", "MODIS_AQUA", "VIIRS_SNPP"):
            row[k] = fin(monthly[(m, k)]) if (m, k) in monthly else None
        monthly_rows.append(row)
    ym_rows = [{"year": y, "month": m, "records": ym[(y, m, "ALL")]["records"],
                "modis_records": ym.get((y, m, "MODIS"), blank())["records"], "viirs_records": ym.get((y, m, "VIIRS"), blank())["records"]}
               for (y, m, f) in ym if f == "ALL"]
    ym_rows.sort(key=lambda r: (r["year"], r["month"]))
    all_rec = tot.get("ALL", blank())
    best_year = max(annual_rows, key=lambda r: r["ALL"]["records"], default=None)
    best_month = max(monthly_rows, key=lambda r: (r["ALL"] or {"records": -1})["records"], default=None)
    seasons = {"Dec-Feb": (12, 1, 2), "Mar-May": (3, 4, 5), "Jun-Aug": (6, 7, 8), "Sep-Nov": (9, 10, 11)}
    season_rows = [{"season": k, "records": sum((monthly_rows[m - 1]["ALL"] or {"records": 0})["records"] for m in ms),
                    "note": "Northern-hemisphere meteorological seasons; use months for southern-hemisphere regions."}
                   for k, ms in seasons.items()]
    total = all_rec["records"]
    overview = {
        "modis_records": tot.get("MODIS", blank())["records"], "viirs_records": tot.get("VIIRS", blank())["records"],
        "combined_records": total, "years_with_records": sum(1 for r in annual_rows if r["ALL"]["records"] > 0),
        "years_covered": len(years),
        "frp_mean_mw": fin(all_rec)["frp_mean_mw"], "frp_max_mw": all_rec["frp_max"],
        "peak_year": {"year": best_year["year"], "records": best_year["ALL"]["records"]} if best_year and total else None,
        "most_active_month": {"month": best_month["month"], "records": best_month["ALL"]["records"]} if best_month and total else None,
    }
    per_source = {k: fin(tot[k]) for k in SOURCES if k in tot}
    return {"overview": overview, "annual": annual_rows, "monthly": monthly_rows, "seasonal": season_rows,
            "year_month": ym_rows, "per_source": per_source}


def frp_distribution(bins_counts: dict[str, list[int]]) -> dict[str, Any]:
    return {"bin_edges_mw": FRP_BIN_EDGES, "bins": bins_counts}


FRP_BIN_EDGES = [0, 10, 25, 50, 100, 250, 500]  # last bin = >= 500


def grid_cell_deg(bbox: tuple[float, float, float, float], target_cells: int = 2400) -> float:
    w, s, e, n = bbox
    cell = ((e - w) * (n - s) / target_cells) ** 0.5
    for c in (0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1.0):
        if cell <= c:
            return c
    return 1.0


# --------------------------------------------------------------------------------------------- cache
def _key(*parts: Any) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def _cache_get(key: str, ttl: float | None) -> Any | None:
    now = time.time()
    with _lock:
        hit = _mem.get(key)
    if hit and (ttl is None or now - hit[0] < ttl):
        return hit[1]
    f = CACHE_DIR / f"{key}.json"
    if ttl is None and f.exists():
        try:
            val = json.loads(f.read_text())
            with _lock:
                _mem[key] = (now, val)
            return val
        except (OSError, ValueError):
            return None
    return None


def _cache_put(key: str, val: Any, persist: bool) -> None:
    with _lock:
        if len(_mem) >= _MEM_MAX:
            _mem.pop(min(_mem, key=lambda k: _mem[k][0]))
        _mem[key] = (time.time(), val)
    if persist:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (CACHE_DIR / f"{key}.json").write_text(json.dumps(val))
        except OSError as exc:  # cache is an optimisation only
            log.warning("history cache write failed: %s", exc)


def clear_cache() -> None:
    with _lock:
        _mem.clear()


# ------------------------------------------------------------------------------------ progress
# Real progress of a running summary, counted in month chunks (one chunk = one source-month). The frontend sends a
# random progress_id with /summary and polls /progress?id=... while it waits. Nothing is estimated from elapsed time.
_progress: dict[str, dict[str, Any]] = {}
_PROGRESS_TTL = 900


def progress_start(pid: str | None, total: int) -> None:
    if not pid:
        return
    now = time.time()
    with _lock:
        for k in [k for k, v in _progress.items() if now - v["t"] > _PROGRESS_TTL]:
            _progress.pop(k, None)
        _progress[pid] = {"done": 0, "total": int(total), "finished": False, "t": now}


def progress_advance(pid: str | None, n: int = 1) -> None:
    if not pid:
        return
    with _lock:
        p = _progress.get(pid)
        if p:
            p["done"] = min(p["total"], p["done"] + n)
            p["t"] = time.time()


def progress_finish(pid: str | None) -> None:
    if not pid:
        return
    with _lock:
        p = _progress.get(pid)
        if p:
            p["done"], p["finished"], p["t"] = p["total"], True, time.time()


def get_progress(pid: str) -> dict[str, Any]:
    with _lock:
        p = _progress.get(pid)
        if not p:
            return {"known": False, "done": 0, "total": 0, "finished": False}
        return {"known": True, "done": p["done"], "total": p["total"], "finished": p["finished"]}


# --------------------------------------------------------------------------------------- EE access
def _ms_date(ms: float | None) -> str | None:
    return None if ms is None else datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def source_coverage() -> dict[str, Any]:
    """Actual first / last image dates read from Earth Engine, per source (cached 6 h)."""
    ck = _key("coverage")
    hit = _cache_get(ck, 6 * 3600)
    if hit:
        return hit
    gee.gee_service.ensure_ready()
    ee = gee.ee
    out: dict[str, Any] = {}
    for k, cfg in SOURCES.items():
        item = {kk: cfg[kk] for kk in ("family", "platform", "instrument", "collection_id", "resolution_m", "documented_start")}
        try:
            col = ee.ImageCollection(cfg["collection_id"])
            lo, hi, n = col.aggregate_min("system:time_start").getInfo(), col.aggregate_max("system:time_start").getInfo(), col.size().getInfo()
            bands = ee.Image(col.first()).bandNames().getInfo()
            item.update(status="available", first_image=_ms_date(lo), last_image=_ms_date(hi), image_count=n, band_names=bands,
                        has_frp="MaxFRP" in bands and "FireMask" in bands)
        except Exception as exc:  # noqa: BLE001 - one source failing must not hide the others
            err = classify_exception(exc)
            item.update(status="unavailable", error=err.message, first_image=None, last_image=None, has_frp=False)
        out[k] = item
    res = {"sources": out, "not_integrated": NOT_INTEGRATED, "retrieved_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    _cache_put(ck, res, persist=False)
    return res


def _region(bbox):
    return gee.ee.Geometry.Rectangle(list(bbox), "EPSG:4326", False)


def _fire_images(col):
    ee = gee.ee
    def f(img):
        img = ee.Image(img)
        fire = img.select("FireMask").gte(FIRE_MIN_CLASS)
        frp = img.select("MaxFRP").multiply(FRP_SCALE).updateMask(fire)
        return fire.rename("fire").addBands(frp.rename("frp")).copyProperties(img, ["system:time_start"])
    return col.map(f)


def _month_rows_for_year(source: str, year: int, months: list[tuple[int, date, date]], bbox) -> list[dict[str, Any]]:
    """One getInfo for up to 12 months of one source-year: per-month count / FRP sum / FRP max / image count."""
    ee = gee.ee
    cfg = SOURCES[source]
    region = _region(bbox)
    feats = []
    for month, d0, d1 in months:
        col = ee.ImageCollection(cfg["collection_id"]).filterDate(d0.isoformat(), (d1 + timedelta(days=1)).isoformat()).filterBounds(region)
        fi = _fire_images(col)
        # sum of binary fire = number of fire cells-days; frp sum / count of cells-days with FRP; frp max over the month
        count_img = fi.select("fire").sum().unmask(0).rename("records")
        frp_sum = fi.select("frp").sum().unmask(0).rename("frp_sum")
        frp_n = fi.select("frp").count().rename("frp_n")
        frp_max = fi.select("frp").max().rename("frp_max")
        stats = ee.Image.cat([count_img, frp_sum, frp_n]).reduceRegion(
            reducer=ee.Reducer.sum(), geometry=region, scale=SCALE_M, maxPixels=int(1e10), tileScale=4)
        mx = frp_max.reduceRegion(reducer=ee.Reducer.max(), geometry=region, scale=SCALE_M, maxPixels=int(1e10), tileScale=4)
        feats.append(ee.Feature(None, {"month": month, "images": col.size()}).set(stats).set(mx))
    rows = ee.FeatureCollection(feats).getInfo().get("features", [])
    out = []
    by_month = {m: (d0, d1) for m, d0, d1 in months}
    for r in rows:
        p = r["properties"]
        d0, d1 = by_month[int(p["month"])]
        out.append({"source": source, "year": year, "month": int(p["month"]), "records": int(round(p.get("records") or 0)),
                    "frp_sum_mw": float(p.get("frp_sum") or 0.0), "frp_n": int(round(p.get("frp_n") or 0)),
                    "frp_max_mw": p.get("frp_max"), "images": int(p.get("images") or 0), "expected_days": (d1 - d0).days + 1})
    return out


def _source_year_rows(source: str, year: int, months, bbox, today: date) -> list[dict[str, Any]]:
    # persist only fully-elapsed, full-month chunks (immutable); partial / current months use a short TTL
    full = [(m, d0, d1) for m, d0, d1 in months if d0.day == 1 and d1 == (date(d0.year + (d0.month == 12), 1 if d0.month == 12 else d0.month + 1, 1) - timedelta(days=1))]
    rows: list[dict[str, Any]] = []
    todo = []
    for m, d0, d1 in months:
        ck = _key("month", source, bbox, year, m, d0, d1)
        persist = (m, d0, d1) in full and d1 < today.replace(day=1)
        hit = _cache_get(ck, None if persist else 300)
        if hit is not None:
            rows.append(hit)
        else:
            todo.append((m, d0, d1, ck, persist))
    if todo:
        fresh = _month_rows_for_year(source, year, [(m, a, b) for m, a, b, _, _ in todo], bbox)
        meta = {m: (ck, persist) for m, _, _, ck, persist in todo}
        for r in fresh:
            ck, persist = meta[r["month"]]
            _cache_put(ck, r, persist)
            rows.append(r)
    return rows


def history_summary(bbox: tuple[float, float, float, float], range_key: str, start: date | None, end: date | None, progress_id: str | None = None) -> dict[str, Any]:
    """Backend-aggregated monthly/annual statistics for one bbox and period. Summary only (no per-record listing)."""
    validate_history_bbox(bbox)
    s, e = resolve_period(range_key, start, end)
    cov = source_coverage()
    gee.gee_service.ensure_ready()
    today = datetime.now(timezone.utc).date()
    availability, jobs = {}, []
    for k, cfg in SOURCES.items():
        c = cov["sources"][k]
        if c["status"] != "available" or not c.get("first_image"):
            availability[k] = {"status": "unavailable", "reason": c.get("error", "collection not accessible"), **{x: c.get(x) for x in ("first_image", "last_image")}}
            continue
        first, last = date.fromisoformat(c["first_image"]), date.fromisoformat(c["last_image"])
        qs, qe = max(s or first, first), min(e, last)
        availability[k] = {"status": "available" if qs <= qe else "no_overlap", "first_image": c["first_image"], "last_image": c["last_image"],
                           "queried_from": qs.isoformat() if qs <= qe else None, "queried_to": qe.isoformat() if qs <= qe else None,
                           "platform": cfg["platform"], "collection_id": cfg["collection_id"], "has_frp": c["has_frp"]}
        if qs <= qe:
            for y, m, a, b in month_chunks(qs, qe):
                jobs.append((k, y, m, a, b))
    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    progress_start(progress_id, len(jobs))
    def run(group):
        (k, y), items = group
        try:
            return _source_year_rows(k, y, [(m, a, b) for _, _, m, a, b in items], bbox, today), None
        except Exception as exc:  # noqa: BLE001
            return [], f"{k} {y}: {classify_exception(exc).message}"
        finally:
            progress_advance(progress_id, len(items))
    groups: dict[tuple, list] = {}
    for j in jobs:
        groups.setdefault((j[0], j[1]), []).append(j)
    with ThreadPoolExecutor(max_workers=config.history_workers()) as ex:
        for r, err in ex.map(run, list(groups.items())):
            rows.extend(r)
            if err:
                errors.append(err)
    for k in availability:
        if availability[k]["status"] == "available":
            ks = [r for r in rows if r["source"] == k]
            availability[k]["months_retrieved"] = len(ks)
            availability[k]["months_with_missing_images"] = sum(1 for r in ks if r["images"] < r["expected_days"])
            availability[k]["missing_image_days"] = sum(max(0, r["expected_days"] - r["images"]) for r in ks)
    progress_finish(progress_id)
    agg = aggregate(rows)
    res = {"status": "ok" if rows and not errors else "partial" if rows else "no_data",
           "query": {"bbox": list(bbox), "range": range_key, "start_date": (s.isoformat() if s else None), "end_date": e.isoformat(),
                     "effective_start": min((r["year"] * 100 + r["month"] for r in rows), default=None)},
           "record_definition": "One record = a 1 km grid cell on one day with FireMask 7-9 (low/nominal/high confidence fire). "
                                "Records are NOT unique fires.",
           "availability": availability, "not_integrated": NOT_INTEGRATED, "errors": errors, "month_rows": rows, **agg,
           "retrieved_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    if not rows and not errors:
        res["message"] = "No imagery overlaps the requested period for any source. See availability for each source's real coverage."
    elif rows and agg["overview"]["combined_records"] == 0:
        res["message"] = "Imagery was available but contained no fire records inside this region and period."
    return res


# ----------------------------------------------------------------------------- distribution, FRP, land cover
def _period_collection(source: str, a: date, b: date, region):
    ee = gee.ee
    return ee.ImageCollection(SOURCES[source]["collection_id"]).filterDate(a.isoformat(), (b + timedelta(days=1)).isoformat()).filterBounds(region)


def history_grid(bbox, source_family: str, start: date, end: date) -> dict[str, Any]:
    """Coarse grid of record counts + max FRP (server-side reduceResolution) for globe display. One call per source family."""
    validate_history_bbox(bbox)
    if end < start:
        raise GeeError("INVALID_DATE_RANGE", "start_date must be on or before end_date.", 422)
    if (end - start).days > 366 * 27:
        raise GeeError("DATE_RANGE_TOO_LARGE", "Grid range too long.", 422)
    today = datetime.now(timezone.utc).date()
    persist = end < today.replace(day=1)
    ck = _key("grid", source_family, bbox, start, end)
    hit = _cache_get(ck, None if persist else 300)
    if hit:
        return hit
    cov = source_coverage()
    gee.gee_service.ensure_ready()
    ee = gee.ee
    region = _region(bbox)
    cell = grid_cell_deg(bbox)
    proj = ee.Projection("EPSG:4326", [cell, 0, bbox[0], 0, -cell, bbox[3]])
    cells: dict[tuple, dict] = {}
    keys = [k for k, c in SOURCES.items() if c["family"] == source_family and cov["sources"][k]["status"] == "available"]
    if not keys:
        raise GeeError("SOURCE_UNAVAILABLE", f"No accessible {source_family} archive collection.", 503)
    try:
        for k in keys:
            c = cov["sources"][k]
            a, b = max(start, date.fromisoformat(c["first_image"])), min(end, date.fromisoformat(c["last_image"]))
            if a > b:
                continue
            fi = _fire_images(_period_collection(k, a, b, region))
            # .sum() / .max() composites lose the default projection, which reduceResolution requires: restore the
            # sensor's native 1 km projection (taken from the unfiltered collection so it exists even if the period is empty).
            native = ee.Image(ee.ImageCollection(SOURCES[k]["collection_id"]).first()).select(0).projection()
            cnt = fi.select("fire").sum().setDefaultProjection(native).unmask(0).rename("records")
            mx = fi.select("frp").max().setDefaultProjection(native).unmask(-1).rename("frp_max")
            img = ee.Image.cat([cnt.reduceResolution(ee.Reducer.sum(), maxPixels=4096).reproject(proj),
                                mx.reduceResolution(ee.Reducer.max(), maxPixels=4096).reproject(proj)])
            img = img.updateMask(img.select("records").gt(0))
            fc = img.sample(region=region, projection=proj, geometries=True, dropNulls=True, numPixels=5000).getInfo()
            for f in fc.get("features", []):
                lon, lat = f["geometry"]["coordinates"]
                p = f["properties"]
                key = (round(lat, 5), round(lon, 5))
                d = cells.setdefault(key, {"latitude": key[0], "longitude": key[1], "records": 0, "frp_max_mw": None})
                d["records"] += int(round(p.get("records") or 0))
                fm = p.get("frp_max")
                if fm is not None and fm >= 0:
                    d["frp_max_mw"] = fm if d["frp_max_mw"] is None else max(d["frp_max_mw"], fm)
    except GeeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise classify_exception(exc) from exc
    lst = sorted(cells.values(), key=lambda d: -d["records"])
    res = {"status": "ok" if lst else "no_data", "source_family": source_family, "start_date": start.isoformat(), "end_date": end.isoformat(),
           "cell_size_deg": cell, "cell_count": len(lst), "cells": lst,
           "truncated": len(lst) >= 5000,
           "note": "Each cell sums 1 km fire records (cell-days) inside it. Counts depend on cell size and sensor; not unique fires."}
    _cache_put(ck, res, persist)
    return res


# ----------------------------------------------------------------------------- individual records (globe dots)
def record_chunks(start: date, end: date) -> list[tuple[date, date]]:
    """Periods of up to ~one calendar month (<= 12 months asked) or one calendar year (longer) that keep each Earth Engine call small."""
    months = month_chunks(start, end)
    if len(months) <= 12:
        return [(a, b) for _, _, a, b in months]
    out: list[tuple[date, date]] = []
    for y in range(start.year, end.year + 1):
        out.append((max(start, date(y, 1, 1)), min(end, date(y, 12, 31))))
    return out


def parse_record_features(features: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
    """Earth Engine sample features -> record dicts. Pure. One record = one 1 km cell-day with FireMask 7-9; the cell centre is its position.
    Features without valid coordinates are skipped; MaxFRP (0.1 MW units) is converted to MW (None when missing)."""
    cfg = SOURCES[source]
    out = []
    for f in features:
        coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
        lon, lat = coords[0], coords[1]
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)) or abs(lat) > 90 or abs(lon) > 180:
            continue
        p = f.get("properties") or {}
        frp = p.get("MaxFRP")
        fc = p.get("FireMask")
        out.append({"latitude": round(lat, 5), "longitude": round(lon, 5), "date": p.get("date"), "source": cfg["family"],
                    "platform": cfg["platform"], "frp_mw": round(frp * FRP_SCALE, 1) if isinstance(frp, (int, float)) else None,
                    "fire_class": int(fc) if isinstance(fc, (int, float)) else None})
    return out


def trim_records(records: list[dict[str, Any]], cap: int) -> tuple[list[dict[str, Any]], bool]:
    """Keep at most `cap` records. When over the cap the STRONGEST FRP are kept (ties: newest first) and truncated=True. Pure."""
    if len(records) <= cap:
        return sorted(records, key=lambda r: (r["date"] or "", r["latitude"], r["longitude"])), False
    ranked = sorted(records, key=lambda r: ((r["frp_mw"] if r["frp_mw"] is not None else -1.0), r["date"] or ""), reverse=True)
    return ranked[:cap], True


def _records_for_chunk(source: str, a: date, b: date, region, limit: int) -> list[dict[str, Any]]:
    """Fire cells of one source in one period, as individual records (strongest `limit` per chunk when there are more)."""
    ee = gee.ee

    def per_image(img):
        img = ee.Image(img)
        fire = img.select("FireMask").gte(FIRE_MIN_CLASS)
        proj = img.select("FireMask").projection()
        d = ee.Date(img.get("system:time_start")).format("YYYY-MM-dd")
        return (img.select(["FireMask", "MaxFRP"]).updateMask(fire)
                .sample(region=region, projection=proj, geometries=True, dropNulls=True)
                .map(lambda f: ee.Feature(f).set("date", d)))

    fc = ee.FeatureCollection(_period_collection(source, a, b, region).map(per_image)).flatten()
    fc = fc.sort("MaxFRP", False).limit(limit)
    return parse_record_features(fc.getInfo().get("features", []), source)


def history_records(bbox, source_family: str, start: date, end: date) -> dict[str, Any]:
    """Individual observation records (1 km cell-days with fire) of one sensor family, for drawing one dot per record on the globe.
    At most GEE_HISTORY_MAX_RECORDS are returned; beyond that the strongest-FRP records are kept and `truncated` is true (never silent)."""
    validate_history_bbox(bbox)
    if end < start:
        raise GeeError("INVALID_DATE_RANGE", "start_date must be on or before end_date.", 422)
    if (end - start).days > 366 * 27:
        raise GeeError("DATE_RANGE_TOO_LARGE", "Record range too long.", 422)
    cap = config.history_max_records()
    today = datetime.now(timezone.utc).date()
    persist = end < today.replace(day=1)
    ck = _key("records", source_family, bbox, start, end, cap)
    hit = _cache_get(ck, None if persist else 300)
    if hit:
        return hit
    cov = source_coverage()
    gee.gee_service.ensure_ready()
    keys = [k for k, c in SOURCES.items() if c["family"] == source_family and cov["sources"][k]["status"] == "available"]
    if not keys:
        raise GeeError("SOURCE_UNAVAILABLE", f"No accessible {source_family} archive collection.", 503)
    region = _region(bbox)
    jobs: list[tuple[str, date, date]] = []
    for k in keys:
        c = cov["sources"][k]
        a, b = max(start, date.fromisoformat(c["first_image"])), min(end, date.fromisoformat(c["last_image"]))
        if a <= b:
            jobs += [(k, x, y) for x, y in record_chunks(a, b)]
    per_chunk = max(200, -(-cap * 2 // max(1, len(jobs))))  # slack so the global trim by FRP stays meaningful
    records: list[dict[str, Any]] = []
    errors: list[str] = []

    def run(job):
        k, x, y = job
        try:
            return _records_for_chunk(k, x, y, region, per_chunk), None
        except Exception as exc:  # noqa: BLE001
            return [], f"{k} {x} to {y}: {classify_exception(exc).message}"

    chunk_limited = False  # True when some chunk returned exactly its limit, i.e. it may hold more records than were returned
    with ThreadPoolExecutor(max_workers=config.history_workers()) as ex:
        for r, err in ex.map(run, jobs):
            records.extend(r)
            chunk_limited = chunk_limited or len(r) >= per_chunk
            if err:
                errors.append(err)
    if errors and not records:
        raise GeeError("RECORDS_UNAVAILABLE", "Earth Engine could not return individual records: " + errors[0], 502,
                       "Choose a smaller area or a single year.")
    kept, truncated = trim_records(records, cap)
    res = {"status": "ok" if kept else "no_data", "source_family": source_family, "start_date": start.isoformat(), "end_date": end.isoformat(),
           "record_count": len(kept), "cap": cap, "truncated": truncated or chunk_limited,
           "errors": errors, "records": kept,
           "note": "One dot = one 1 km grid cell on one day with a fire detection (FireMask 7-9). Not a unique fire. "
                   "When truncated, the strongest FRP records are kept."}
    if not errors:
        _cache_put(ck, res, persist)
    return res


def history_frp(bbox, start: date, end: date) -> dict[str, Any]:
    """FRP histogram per sensor (MODIS vs VIIRS kept separate). Counts FRP-bearing records per FRP class (MW)."""
    validate_history_bbox(bbox)
    today = datetime.now(timezone.utc).date()
    persist = end < today.replace(day=1)
    ck = _key("frp", bbox, start, end)
    hit = _cache_get(ck, None if persist else 300)
    if hit:
        return hit
    cov = source_coverage()
    gee.gee_service.ensure_ready()
    ee = gee.ee
    region = _region(bbox)
    out: dict[str, list[int]] = {}
    edges = FRP_BIN_EDGES
    try:
        for fam in ("MODIS", "VIIRS"):
            counts = [0] * len(edges)
            for k, cfg in SOURCES.items():
                if cfg["family"] != fam or cov["sources"][k]["status"] != "available":
                    continue
                c = cov["sources"][k]
                a, b = max(start, date.fromisoformat(c["first_image"])), min(end, date.fromisoformat(c["last_image"]))
                if a > b:
                    continue
                # month-by-month to keep each computation small
                for _, _, d0, d1 in month_chunks(a, b):
                    fi = _fire_images(_period_collection(k, d0, d1, region)).select("frp")
                    bins = []
                    for i, lo in enumerate(edges):
                        hi = edges[i + 1] if i + 1 < len(edges) else None
                        m = fi.map(lambda im, lo=lo, hi=hi: im.gte(lo).And(im.lt(hi)) if hi is not None else im.gte(lo)).sum()
                        bins.append(m.unmask(0).reduceRegion(ee.Reducer.sum(), region, SCALE_M, maxPixels=int(1e10), tileScale=4).get("frp"))
                    vals = ee.List(bins).getInfo()
                    for i, v in enumerate(vals):
                        counts[i] += int(round(v or 0))
            out[fam] = counts
    except GeeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise classify_exception(exc) from exc
    res = {"status": "ok", "start_date": start.isoformat(), "end_date": end.isoformat(), **frp_distribution(out),
           "note": "FRP (MW) is the maximum fire radiative power within a 1 km cell-day. MODIS and VIIRS are shown separately and are "
                   "not interchangeable. FRP indicates radiative energy release, not burned area or damage."}
    _cache_put(ck, res, persist)
    return res


def history_landcover(bbox, start: date, end: date) -> dict[str, Any]:
    """ESA WorldCover (2021 snapshot) composition of the region vs. of the 1 km cells that recorded fire in the period."""
    validate_history_bbox(bbox)
    today = datetime.now(timezone.utc).date()
    persist = end < today.replace(day=1)
    ck = _key("lc", bbox, start, end)
    hit = _cache_get(ck, None if persist else 300)
    if hit:
        return hit
    cov = source_coverage()
    gee.gee_service.ensure_ready()
    ee = gee.ee
    region = _region(bbox)
    src = {"name": "ESA WorldCover 2021", "dataset_id": WORLDCOVER_ID, "resolution": "10 m (sampled at 1 km)", "year": 2021}
    try:
        lc = ee.ImageCollection(WORLDCOVER_ID).first().select("Map")
        ever = None
        for k in SOURCES:
            c = cov["sources"][k]
            if c["status"] != "available":
                continue
            a, b = max(start, date.fromisoformat(c["first_image"])), min(end, date.fromisoformat(c["last_image"]))
            if a > b:
                continue
            m = _fire_images(_period_collection(k, a, b, region)).select("fire").max().unmask(0)
            ever = m if ever is None else ever.max(m)
        if ever is None:
            return {"status": "no_data", "source": src, "message": "No fire imagery in the period."}
        hist_all = lc.reduceRegion(ee.Reducer.frequencyHistogram(), region, SCALE_M, maxPixels=int(1e10), tileScale=4).get("Map")
        hist_fire = lc.updateMask(ever.gt(0)).reduceRegion(ee.Reducer.frequencyHistogram(), region, SCALE_M, maxPixels=int(1e10), tileScale=4).get("Map")
        both = ee.Dictionary({"all": hist_all, "fire": hist_fire}).getInfo()
    except GeeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise classify_exception(exc) from exc
    return_val = group_landcover(both.get("all"), both.get("fire"))
    res = {"status": "ok" if return_val["fire_cells"] else "no_data", "source": src, **return_val,
           "note": "Land cover describes the surrounding surface, not the cause of any fire. A cell is not labelled an agricultural, "
                   "forest or industrial fire. The 2021 land-cover snapshot is applied to all years; land cover may have changed."}
    _cache_put(ck, res, persist)
    return res


def group_landcover(all_hist: dict | None, fire_hist: dict | None) -> dict[str, Any]:
    def grp(h):
        out: dict[str, float] = {}
        for k, v in (h or {}).items():
            out[LC_GROUPS.get(int(float(k)), "Other land cover")] = out.get(LC_GROUPS.get(int(float(k)), "Other land cover"), 0) + float(v)
        return out
    a, f = grp(all_hist), grp(fire_hist)
    ta, tf = sum(a.values()), sum(f.values())
    names = ["Forest", "Grassland and shrubland", "Agricultural land", "Built-up areas", "Other land cover"]
    rows = [{"group": n, "region_cells": round(a.get(n, 0)), "region_share": round(a.get(n, 0) / ta, 4) if ta else None,
             "fire_cells": round(f.get(n, 0)), "fire_share": round(f.get(n, 0) / tf, 4) if tf else None} for n in names]
    unknown = max(0, round(ta - sum(a.get(n, 0) for n in names)))
    return {"groups": rows, "region_cells": round(ta), "fire_cells": round(tf), "unknown_or_unavailable_cells": unknown,
            "cells_definition": "1 km cells; fire cells = cells with at least one fire record in the period"}
