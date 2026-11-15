"""Offline unit tests for the pure parts of history_service. These use hand-made rows to test ARITHMETIC only;
they are not satellite data and are never imported by the app."""
import unittest
from datetime import date

from backend.services import history_service as hs
from backend.services.gee_service import GeeError


def row(source, year, month, records, frp_sum=0.0, frp_n=0, frp_max=None, images=30, expected=30):
    return dict(source=source, year=year, month=month, records=records, frp_sum_mw=frp_sum, frp_n=frp_n,
                frp_max_mw=frp_max, images=images, expected_days=expected)


class ProgressUnit(unittest.TestCase):
    def test_progress_counts_chunks_and_finishes(self):
        pid = "t-progress-1"
        self.assertFalse(hs.get_progress(pid)["known"])
        hs.progress_start(pid, 10)
        hs.progress_advance(pid, 3)
        self.assertEqual((hs.get_progress(pid)["done"], hs.get_progress(pid)["total"]), (3, 10))
        hs.progress_advance(pid, 99)  # never exceeds total
        self.assertEqual(hs.get_progress(pid)["done"], 10)
        hs.progress_finish(pid)
        self.assertTrue(hs.get_progress(pid)["finished"])
        hs.progress_advance(None, 1)  # no id: no-op


class HistoryUnit(unittest.TestCase):
    def test_resolve_period(self):
        s, e = hs.resolve_period("7d", None, None, today=date(2024, 3, 10))
        self.assertEqual((s, e), (date(2024, 3, 4), date(2024, 3, 10)))
        self.assertEqual(hs.resolve_period("all", None, None, today=date(2024, 3, 10)), (None, date(2024, 3, 10)))
        with self.assertRaises(GeeError):
            hs.resolve_period("custom", date(2024, 2, 1), date(2024, 1, 1))
        with self.assertRaises(GeeError):
            hs.resolve_period("bogus", None, None)

    def test_month_chunks(self):
        c = hs.month_chunks(date(2023, 11, 15), date(2024, 2, 10))
        self.assertEqual([(y, m) for y, m, _, _ in c], [(2023, 11), (2023, 12), (2024, 1), (2024, 2)])
        self.assertEqual(c[0][2:], (date(2023, 11, 15), date(2023, 11, 30)))
        self.assertEqual(c[-1][2:], (date(2024, 2, 1), date(2024, 2, 10)))

    def test_bbox_limit(self):
        hs.validate_history_bbox((70, 8, 90, 28))
        with self.assertRaises(GeeError):
            hs.validate_history_bbox((-180, -90, 180, 90))

    def test_aggregate_keeps_sources_separate(self):
        rows = [row("MODIS_TERRA", 2020, 3, 10, 100, 10, 40.0), row("MODIS_AQUA", 2020, 3, 5, 50, 5, 30.0),
                row("VIIRS_SNPP", 2020, 3, 20, 400, 20, 90.0), row("MODIS_TERRA", 2021, 4, 7, 70, 7, 20.0)]
        a = hs.aggregate(rows)
        o = a["overview"]
        self.assertEqual((o["modis_records"], o["viirs_records"], o["combined_records"]), (22, 20, 42))
        self.assertEqual(o["frp_max_mw"], 90.0)
        self.assertAlmostEqual(o["frp_mean_mw"], (100 + 50 + 400 + 70) / 42, places=2)
        self.assertEqual(o["peak_year"], {"year": 2020, "records": 35})
        self.assertEqual(o["most_active_month"]["month"], 3)
        y20 = [r for r in a["annual"] if r["year"] == 2020][0]
        self.assertEqual((y20["MODIS"]["records"], y20["VIIRS"]["records"], y20["ALL"]["records"]), (15, 20, 35))
        y21 = [r for r in a["annual"] if r["year"] == 2021][0]
        self.assertIsNone(y21["VIIRS"])          # VIIRS not available/queried that year -> None, never zero-filled
        self.assertEqual(a["per_source"]["MODIS_AQUA"]["records"], 5)

    def test_aggregate_empty(self):
        a = hs.aggregate([])
        self.assertEqual(a["overview"]["combined_records"], 0)
        self.assertIsNone(a["overview"]["peak_year"])

    def test_missing_images_tracked(self):
        a = hs.aggregate([row("MODIS_TERRA", 2020, 1, 0, images=20, expected=31)])
        self.assertEqual(a["per_source"]["MODIS_TERRA"]["images"], 20)
        self.assertEqual(a["per_source"]["MODIS_TERRA"]["expected_days"], 31)

    def test_grid_cell_size_bounds_cells(self):
        for bb in [(70, 8, 90, 28), (0, 0, 1, 1), (-10, -10, 20, 20)]:
            c = hs.grid_cell_deg(bb)
            self.assertLessEqual(((bb[2] - bb[0]) / c) * ((bb[3] - bb[1]) / c), 12000)

    def test_landcover_grouping(self):
        g = hs.group_landcover({"10": 50, "40": 30, "50": 20}, {"10": 5, "40": 15})
        d = {r["group"]: r for r in g["groups"]}
        self.assertEqual(g["fire_cells"], 20)
        self.assertAlmostEqual(d["Agricultural land"]["fire_share"], 0.75)
        self.assertAlmostEqual(d["Forest"]["region_share"], 0.5)



class RecordsUnit(unittest.TestCase):
    def test_record_chunks_month_then_year(self):
        self.assertEqual(hs.record_chunks(date(2024, 1, 10), date(2024, 3, 5)),
                         [(date(2024, 1, 10), date(2024, 1, 31)), (date(2024, 2, 1), date(2024, 2, 29)), (date(2024, 3, 1), date(2024, 3, 5))])
        y = hs.record_chunks(date(2020, 6, 1), date(2023, 2, 1))
        self.assertEqual(y, [(date(2020, 6, 1), date(2020, 12, 31)), (date(2021, 1, 1), date(2021, 12, 31)),
                             (date(2022, 1, 1), date(2022, 12, 31)), (date(2023, 1, 1), date(2023, 2, 1))])

    def test_parse_record_features(self):
        feats = [{"geometry": {"coordinates": [80.123456, 17.5]}, "properties": {"FireMask": 8, "MaxFRP": 125, "date": "2020-03-01"}},
                 {"geometry": {"coordinates": [None, 17.5]}, "properties": {}},
                 {"geometry": {"coordinates": [200, 10]}, "properties": {}},
                 {"geometry": {"coordinates": [81, 18]}, "properties": {"FireMask": 7, "date": "2020-03-02"}}]
        r = hs.parse_record_features(feats, "MODIS_AQUA")
        self.assertEqual(len(r), 2)
        self.assertEqual((r[0]["longitude"], r[0]["frp_mw"], r[0]["fire_class"], r[0]["source"], r[0]["platform"]), (80.12346, 12.5, 8, "MODIS", "Aqua"))
        self.assertIsNone(r[1]["frp_mw"])

    def test_trim_records(self):
        mk = lambda d, f: {"latitude": 1.0, "longitude": 2.0, "date": d, "frp_mw": f}
        recs = [mk("2020-01-03", 5.0), mk("2020-01-01", 50.0), mk("2020-01-02", None), mk("2020-01-04", 20.0)]
        kept, trunc = hs.trim_records(recs, 10)
        self.assertFalse(trunc)
        self.assertEqual([r["date"] for r in kept], ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"])
        kept, trunc = hs.trim_records(recs, 2)
        self.assertTrue(trunc)
        self.assertEqual([r["frp_mw"] for r in kept], [50.0, 20.0])

if __name__ == "__main__":
    unittest.main()
