"""Offline tests of the impact interpretation logic (no network, no Earth Engine)."""
import unittest

from backend.services import impact_service as m


class ImpactTests(unittest.TestCase):
    def test_landcover(self):
        r = m.summarize_landcover(10, {"10": 60, "40": 30, "50": 10})
        self.assertEqual(r["point_label"], "Tree cover")
        self.assertEqual(r["tree_pct"], 60.0)
        self.assertEqual(r["vegetated_pct"], 90.0)
        self.assertEqual(r["builtup_pct"], 10.0)
        self.assertIsNone(m.summarize_landcover(10, None))
        self.assertIsNone(m.summarize_landcover(10, {}))

    def test_burn_date(self):
        self.assertEqual(m.burn_date_from_doy(2024, 60), "2024-02-29")
        self.assertIsNone(m.burn_date_from_doy(2023, 366))
        self.assertIsNone(m.burn_date_from_doy(2023, 0))

    def test_air(self):
        self.assertEqual(m.interpret_air(None, 1), "no_overpass_value")
        self.assertEqual(m.interpret_air(2, None), "no_baseline")
        self.assertEqual(m.interpret_air(2, 1), "above_local_mean")
        self.assertEqual(m.interpret_air(1, 2), "at_or_below_local_mean")

    def test_assessment_never_confirms_without_burned_area(self):
        conf = m.section("burned_area", "b", "ok", "none", "x")
        ctx = [m.section("vegetation", "v", "ok", "estimated", "x"), m.soil_section()]
        a = m.assessment_category(conf, ctx)
        self.assertNotIn("confirmed by", a["category"].lower())
        self.assertFalse(a["evidence_availability"]["burned_area_confirmed"])
        none = m.assessment_category(conf, [m.soil_section()])
        self.assertEqual(none["category"], "Insufficient evidence")
        yes = m.assessment_category(m.section("burned_area", "b", "ok", "confirmed", "x"), ctx)
        self.assertTrue(yes["evidence_availability"]["burned_area_confirmed"])

    def test_soil_unavailable_and_ee_down(self):
        s = m.soil_section()
        self.assertEqual(s["status"], "unavailable")
        self.assertEqual(s["headline"], m.UNAVAILABLE_TEXT)
        from backend.services.gee_service import GeeError
        orig = m.gee_service.ensure_ready
        m.gee_service.ensure_ready = lambda: (_ for _ in ()).throw(GeeError("GEE_AUTH_REQUIRED", "no creds"))
        try:
            out = m.build_impact("MODIS:x:1", {"latitude": 1.0, "longitude": 2.0, "acquisition_date": "2024-01-02"})
        finally:
            m.gee_service.ensure_ready = orig
        self.assertEqual(out["status"], "partial")
        self.assertTrue(all(x["status"] == "unavailable" for x in out["estimated"]))
        self.assertEqual(out["confirmed"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
