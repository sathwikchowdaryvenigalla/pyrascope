"""
Offline tests (no Earth Engine, no network).
* REAL_MODIS_PIXELS are 5 real pixels copied from a live /api/gee/modis-test response (2024-03-01).
* Everything else is a SYNTHETIC TEST FIXTURE used only to exercise the logic. None of it is satellite data.
"""
import random
import time
import unittest
from datetime import date
from unittest import mock

from backend.schemas.fire_observation import FireObservation
from backend.services import harmonization_service as hs
from backend.services import observation_retrieval as orr
from backend.services.gee_service import GeeError

REAL_MODIS_PIXELS = [
    {"image_id": "2024061", "image_date": "2024-03-01", "longitude": lon, "latitude": lat,
     "T21": 317.20001220703125, "confidence": 68, "line_number": 713}
    for lon, lat in [(78.74737070981644, 23.01410567742417), (78.75714159376639, 23.01410567742417),
                     (78.76691247771637, 23.01410567742417), (78.74212181467338, 23.005112471501572),
                     (78.75189204734643, 23.005112471501572)]]

EPOCH = 1709294400  # 2024-03-01T12:00:00Z


def viirs_px(lat, lon, line, epoch=EPOCH, day="2024-03-01", image="v1", **kw):
    p = {"image_id": image, "image_date": day, "longitude": lon, "latitude": lat, "Bright_ti4": 340.0,
         "Bright_ti5": 300.0, "confidence": 1, "frp": 3.2, "acq_epoch": epoch,
         "acq_time": (epoch % 86400) if epoch else None, "DayNight": 1, "line_number": line}
    p.update(kw)
    return p


def modis_px(lat, lon, line, day="2024-03-01", image="m1"):
    return {"image_id": image, "image_date": day, "longitude": lon, "latitude": lat,
            "T21": 320.0, "confidence": 80, "line_number": line}


TH = hs.Thresholds(1.0, 30.0, 0)


def obs(source, oid, lat, lon, time_utc=None, day="2024-03-01"):
    return FireObservation(oid, source, "p", source, lat, lon, day, time_utc, None, None, None, None, day,
                           "pixel_center", 1, {})


class NormalizeTests(unittest.TestCase):
    def test_real_modis_pixels_group_into_one_record(self):
        o = hs.normalize_pixels("MODIS", REAL_MODIS_PIXELS)
        self.assertEqual(len(o), 1)
        r = o[0]
        self.assertEqual(r.pixel_count, 5)
        self.assertEqual(r.confidence, 68)
        self.assertEqual(r.confidence_scale, "percent_0_100")
        self.assertIsNone(r.acquisition_time_utc)
        self.assertIsNone(r.frp_mw)
        self.assertEqual(r.original_properties["bands"]["T21"], 317.20001220703125)
        self.assertEqual(r.acquisition_date, "2024-03-01")
        self.assertTrue(r.coordinate_method.startswith("mean_of_5"))
        self.assertAlmostEqual(r.latitude, (3 * 23.01410567742417 + 2 * 23.005112471501572) / 5, 6)
        self.assertFalse(r.original_properties["bands_vary_within_record"])

    def test_viirs_fields_preserved(self):
        r = hs.normalize_pixels("VIIRS", [viirs_px(23.0, 78.0, 5, confidence=2)])[0]
        self.assertEqual(r.acquisition_time_utc, "2024-03-01T12:00:00Z")
        self.assertEqual((r.confidence, r.frp_mw), (2, 3.2))
        b = r.original_properties["bands"]
        self.assertEqual((b["Bright_ti4"], b["Bright_ti5"], b["DayNight"]), (340.0, 300.0, 1))
        self.assertEqual(r.confidence_scale, "categorical_0_low_1_nominal_2_high")

    def test_missing_or_invalid_values_not_invented(self):
        a = hs.normalize_pixels("VIIRS", [viirs_px(None, None, 1, epoch=None)])[0]
        self.assertIsNone(a.latitude)
        self.assertIsNone(a.acquisition_time_utc)
        self.assertEqual(a.acquisition_date, "2024-03-01")  # falls back to image date, flagged by missing time
        b = hs.normalize_pixels("VIIRS", [viirs_px(10, 10, 2, epoch=-5)])[0]
        self.assertIsNone(b.acquisition_time_utc)
        c = hs.normalize_pixels("VIIRS", [viirs_px(95, 10, 3)])[0]
        self.assertIsNone(c.latitude)  # invalid latitude

    def test_pixels_without_line_number_stay_separate(self):
        px = [modis_px(10, 10, None), modis_px(10.5, 10, None)]
        self.assertEqual(len(hs.normalize_pixels("MODIS", px)), 2)


class MatchTests(unittest.TestCase):
    def test_haversine(self):
        self.assertAlmostEqual(hs.haversine_km(0, 0, 1, 0), 111.195, 2)
        self.assertEqual(hs.haversine_km(5, 5, 5, 5), 0)

    def test_modis_only(self):
        m = hs.normalize_pixels("MODIS", [modis_px(10, 10, 1), modis_px(11, 11, 2)])
        r = hs.match_observations(m, [], TH)
        self.assertEqual((len(r.pairs), len(r.unmatched_modis_ids), len(r.unmatched_viirs_ids)), (0, 2, 0))

    def test_viirs_only(self):
        v = hs.normalize_pixels("VIIRS", [viirs_px(10, 10, 1)])
        r = hs.match_observations([], v, TH)
        self.assertEqual((len(r.pairs), len(r.unmatched_modis_ids), len(r.unmatched_viirs_ids)), (0, 0, 1))

    def test_spatial_match_with_modis_missing_time_is_insufficient(self):
        m = hs.normalize_pixels("MODIS", [modis_px(10.0, 10.0, 1)])
        v = hs.normalize_pixels("VIIRS", [viirs_px(10.002, 10.002, 7)])
        r = hs.match_observations(m, v, TH)
        self.assertEqual(len(r.pairs), 1)
        p = r.pairs[0]
        self.assertEqual(p.classification, hs.CLASS_INSUFFICIENT)
        self.assertFalse(p.temporal_matching_possible)
        self.assertIsNone(p.time_difference_minutes)
        self.assertLess(p.distance_km, 1.0)

    def test_temporal_within_and_outside(self):
        m = obs("MODIS", "M1", 10, 10, "2024-03-01T12:10:00Z")
        near = obs("VIIRS", "V1", 10.001, 10, "2024-03-01T12:20:00Z")
        far_t = obs("VIIRS", "V2", 10.001, 10, "2024-03-01T15:00:00Z")
        r = hs.match_observations([m], [near, far_t], TH)
        by = {p.viirs_observation_id: p for p in r.pairs}
        self.assertEqual(by["V1"].classification, hs.CLASS_MATCH)
        self.assertEqual(by["V1"].time_difference_minutes, 10.0)
        self.assertEqual(by["V2"].classification, hs.CLASS_SPATIAL_ONLY)
        self.assertFalse(by["V2"].within_temporal_threshold)

    def test_one_to_many_is_kept(self):
        m = obs("MODIS", "M1", 10, 10)
        vs = [obs("VIIRS", f"V{i}", 10 + i * 0.001, 10) for i in range(3)]
        r = hs.match_observations([m], vs, TH)
        self.assertEqual(len(r.pairs), 3)
        self.assertEqual((r.modis_with_candidates, r.viirs_with_candidates), (1, 3))
        m2 = [obs("MODIS", f"M{i}", 10 + i * 0.001, 10) for i in range(3)]
        r2 = hs.match_observations(m2, [obs("VIIRS", "V", 10, 10)], TH)
        self.assertEqual((len(r2.pairs), r2.modis_with_candidates, r2.viirs_with_candidates), (3, 3, 1))

    def test_spatial_threshold_boundary(self):
        m = obs("MODIS", "M", 10, 10)
        v04 = obs("VIIRS", "V04", 10 + 0.4 / hs.KM_PER_DEG_LAT, 10)
        v06 = obs("VIIRS", "V06", 10 + 0.6 / hs.KM_PER_DEG_LAT, 10)
        r = hs.match_observations([m], [v04, v06], hs.Thresholds(0.5, 30, 0))
        self.assertEqual([p.viirs_observation_id for p in r.pairs], ["V04"])
        self.assertEqual(r.unmatched_viirs_ids, ["V06"])

    def test_date_gate(self):
        m = obs("MODIS", "M", 10, 10, day="2024-03-01")
        v = obs("VIIRS", "V", 10, 10, day="2024-03-02")
        self.assertEqual(len(hs.match_observations([m], [v], hs.Thresholds(1, 30, 0)).pairs), 0)
        self.assertEqual(len(hs.match_observations([m], [v], hs.Thresholds(1, 30, 1)).pairs), 1)

    def test_missing_coordinates_excluded_not_dropped(self):
        m = [obs("MODIS", "M1", None, None), obs("MODIS", "M2", 10, 10)]
        r = hs.match_observations(m, [obs("VIIRS", "V", 10, 10)], TH)
        self.assertEqual(r.modis_without_coordinates, ["M1"])
        self.assertEqual(len(r.pairs), 1)

    def test_performance_3000x3000(self):
        rnd = random.Random(1)
        mk = lambda s, n: [obs(s, f"{s}{i}", 10 + rnd.random() * 2, 70 + rnd.random() * 2) for i in range(n)]
        t = time.time()
        r = hs.match_observations(mk("M", 3000), mk("V", 3000), hs.Thresholds(0.5, 30, 0))
        self.assertLess(time.time() - t, 10)
        self.assertGreaterEqual(len(r.pairs), 0)


class ValidationAndFormatTests(unittest.TestCase):
    def test_threshold_validation(self):
        for args in [(0, 30, 0), (-1, 30, 0), (30, 30, 0), (1, -1, 0), (1, 2000, 0), (1, 30, 9)]:
            with self.assertRaises(GeeError) as c:
                hs.validate_thresholds(*args)
            self.assertEqual(c.exception.code, "INVALID_THRESHOLD")
        hs.validate_thresholds(1, 30, 0)

    def _h(self, modis, viirs):
        return hs.Harmonization({"x": 1}, TH, modis, viirs, hs.match_observations(modis, viirs, TH),
                                {"warnings": []}, "now", {"MODIS": False, "VIIRS": False})

    def test_empty_results(self):
        out = hs.format_compare(self._h([], []))
        self.assertEqual(out["status"], "no_data")
        self.assertEqual(out["counts"]["observations"]["modis"], 0)
        self.assertIsNone(out["counts"]["unique_fire_events"])
        self.assertEqual(hs.format_summary(self._h([], []))["status"], "no_data")

    def test_compare_and_summary_both_sources(self):
        m = hs.normalize_pixels("MODIS", REAL_MODIS_PIXELS)
        v = hs.normalize_pixels("VIIRS", [viirs_px(23.0095, 78.753, 1), viirs_px(30, 30, 2)])
        h = self._h(m, v)
        c = hs.format_compare(h, include_observations=True, max_details=1)
        self.assertEqual(c["counts"]["candidate_pairs"]["total"], 1)
        self.assertEqual(c["counts"]["candidate_pairs"]["insufficient_timestamp_information"], 1)
        self.assertEqual(c["counts"]["unmatched"]["viirs_observations"], 1)
        self.assertFalse(c["temporal_matching_available"])
        self.assertIn("observations", c)
        self.assertTrue(any("Temporal matching was not possible" in w for w in c["warnings"]))
        s = hs.format_summary(h)
        self.assertEqual(s["observation_counts_by_source"], {"MODIS": 1, "VIIRS": 2})
        self.assertEqual(s["observation_counts_by_date"]["2024-03-01"], {"MODIS": 1, "VIIRS": 2})
        self.assertIsNone(s["unique_fire_events"])

    def test_pair_text_never_claims_same_fire(self):
        m = [obs("MODIS", "M", 10, 10)]
        v = [obs("VIIRS", "V", 10, 10)]
        d = hs.format_compare(self._h(m, v))["match_details"][0]
        self.assertIn("Not a confirmed", d["note"])


class RunnerTests(unittest.TestCase):
    def setUp(self):
        orr.clear_cache()

    def test_cache_avoids_repeat_fetch_and_thresholds_do_not_refetch(self):
        def fake(source, *a, **k):
            px = REAL_MODIS_PIXELS if source == "MODIS" else [viirs_px(23.0095, 78.753, 1)]
            return {"pixels": px, "info": {"matching_images": 1}}
        with mock.patch.object(orr, "fetch_source_pixels", side_effect=fake) as f:
            bbox = (77, 22, 79, 24)
            h1 = orr.get_harmonized(date(2024, 3, 1), date(2024, 3, 1), bbox, 1.0, 30)
            h2 = orr.get_harmonized(date(2024, 3, 1), date(2024, 3, 1), bbox, 5.0, 60)
            self.assertEqual(f.call_count, 2)  # one per source, second call fully cached
            self.assertEqual(h2.from_cache, {"MODIS": True, "VIIRS": True})
            self.assertEqual(len(h1.match.pairs), 1)

    def test_invalid_bounds_rejected_before_fetch(self):
        with mock.patch.object(orr, "fetch_source_pixels") as f:
            for bbox in [(79, 22, 77, 24), (77, 24, 79, 22), (-200, 0, 10, 5), (0, 0, 60, 5)]:
                with self.assertRaises(GeeError):
                    orr.get_harmonized(date(2024, 3, 1), date(2024, 3, 2), bbox, 1, 30)
            with self.assertRaises(GeeError):
                orr.get_harmonized(date(2024, 3, 5), date(2024, 3, 1), (77, 22, 79, 24), 1, 30)
            f.assert_not_called()


if __name__ == "__main__":
    unittest.main()
