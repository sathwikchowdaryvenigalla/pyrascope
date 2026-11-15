"""Offline unit tests (no network, no Earth Engine). They do NOT prove live VIIRS retrieval."""
import unittest
from datetime import date

from backend.services import viirs_service as v
from backend.services.gee_service import GeeError

CFG = v.PLATFORMS["snpp"]
EPOCH = 1709294400  # 2024-03-01T12:00:00Z


class PixelTests(unittest.TestCase):
    def props(self, **kw):
        p = {"Bright_ti4": 340.1, "Bright_ti5": 301.2, "confidence": 2, "frp": 5.5,
             "acq_epoch": EPOCH, "acq_time": EPOCH % 86400, "DayNight": 1, "line_number": 42}
        p.update(kw)
        return p

    def test_values_preserved_and_labels_derived(self):
        r = v.format_pixel(self.props(), [78.5, 23.1], CFG)
        self.assertEqual((r["Bright_ti4"], r["frp"], r["confidence"]), (340.1, 5.5, 2))
        self.assertEqual(r["confidence_label"], "high")
        self.assertEqual(r["DayNight_label"], "day")
        self.assertEqual(r["acquisition_timestamp_utc"], "2024-03-01T12:00:00Z")
        self.assertEqual((r["latitude"], r["longitude"]), (23.1, 78.5))
        self.assertEqual((r["platform"], r["instrument"]), ("Suomi NPP", "VIIRS"))

    def test_missing_values_not_invented(self):
        r = v.format_pixel({"confidence": 1}, [1, 2], CFG)
        self.assertIsNone(r["frp"])
        self.assertIsNone(r["acquisition_timestamp_utc"])
        self.assertEqual(r["confidence_label"], "nominal")

    def test_warnings(self):
        ok = v.format_pixel(self.props(), [1, 2], CFG)
        self.assertEqual(v.pixel_warnings([ok]), [])
        bad = v.format_pixel(self.props(confidence=77, acq_time=1325), [1, 2], CFG)
        self.assertEqual(len(v.pixel_warnings([bad])), 2)


class MiscTests(unittest.TestCase):
    def test_band_check(self):
        self.assertEqual(v.check_bands(list(v.EXPECTED_BANDS)), [])
        self.assertEqual(v.check_bands(["confidence"]).count("frp"), 1)

    def test_noaa20_not_enabled(self):
        with self.assertRaises(GeeError) as c:
            v.query_viirs(date(2024, 3, 1), date(2024, 3, 2), (77, 23, 78, 24), platform_key="noaa20")
        self.assertEqual(c.exception.code, "PLATFORM_NOT_AVAILABLE")

    def test_viirs_bbox_cap(self):
        with self.assertRaises(GeeError) as c:
            v.query_viirs(date(2024, 3, 1), date(2024, 3, 2), (60, 10, 80, 30))
        self.assertEqual(c.exception.code, "BBOX_TOO_LARGE")

    def test_invalid_dates(self):
        with self.assertRaises(GeeError) as c:
            v.query_viirs(date(2024, 3, 5), date(2024, 3, 1), (77, 23, 78, 24))
        self.assertEqual(c.exception.code, "INVALID_DATE_RANGE")


if __name__ == "__main__":
    unittest.main()
