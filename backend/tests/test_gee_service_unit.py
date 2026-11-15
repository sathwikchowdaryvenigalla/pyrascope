"""Offline unit tests (no network, no Earth Engine). They do NOT prove live GEE access."""
import os
import unittest
from datetime import date

from backend.services import gee_service as g


class ClassifyTests(unittest.TestCase):
    def test_auth(self):
        e = g.classify_exception(Exception("Please authorize access to your Earth Engine account by running earthengine authenticate"))
        self.assertEqual(e.code, "GEE_AUTH_REQUIRED")

    def test_api_disabled(self):
        e = g.classify_exception(Exception("Earth Engine API has not been used in project 123 before or it is disabled"))
        self.assertEqual(e.code, "GEE_API_NOT_ENABLED")

    def test_permission(self):
        e = g.classify_exception(Exception("Caller does not have required permission to use project x"))
        self.assertEqual(e.code, "GEE_PERMISSION_DENIED")
        self.assertEqual(e.status_code, 403)

    def test_quota_and_unknown(self):
        self.assertEqual(g.classify_exception(Exception("Too many requests")).code, "GEE_QUOTA_EXCEEDED")
        self.assertEqual(g.classify_exception(Exception("boom")).code, "GEE_ERROR")


class ValidationTests(unittest.TestCase):
    BOX = (77.0, 23.0, 78.0, 24.0)

    def test_ok(self):
        g.validate_query(date(2024, 3, 1), date(2024, 3, 5), self.BOX)

    def test_reversed_dates(self):
        with self.assertRaises(g.GeeError) as c:
            g.validate_query(date(2024, 3, 5), date(2024, 3, 1), self.BOX)
        self.assertEqual(c.exception.code, "INVALID_DATE_RANGE")

    def test_range_too_large(self):
        with self.assertRaises(g.GeeError) as c:
            g.validate_query(date(2024, 1, 1), date(2024, 12, 31), self.BOX)
        self.assertEqual(c.exception.code, "DATE_RANGE_TOO_LARGE")

    def test_bad_bbox(self):
        with self.assertRaises(g.GeeError) as c:
            g.validate_query(date(2024, 3, 1), date(2024, 3, 2), (78.0, 23.0, 77.0, 24.0))
        self.assertEqual(c.exception.code, "INVALID_BBOX")

    def test_bbox_too_large(self):
        with self.assertRaises(g.GeeError) as c:
            g.validate_query(date(2024, 3, 1), date(2024, 3, 2), (-90, -50, 90, 50))
        self.assertEqual(c.exception.code, "BBOX_TOO_LARGE")


class InitFailureTests(unittest.TestCase):
    def test_missing_project_id_reported_not_raised(self):
        os.environ.pop("GEE_PROJECT_ID", None)
        svc = g.GeeService()
        self.assertFalse(svc.initialize())  # must not raise
        code = svc.status()["error"]["code"]
        self.assertIn(code, {"GEE_PROJECT_ID_MISSING", "GEE_PACKAGE_MISSING"})
        with self.assertRaises(g.GeeError):
            svc.query_firms(date(2024, 3, 1), date(2024, 3, 2), (77, 23, 78, 24))


if __name__ == "__main__":
    unittest.main()
