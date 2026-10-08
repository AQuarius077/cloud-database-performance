"""
tests/test_api.py
-----------------
Unit tests for the general API endpoints.
Database calls are mocked — no live PostgreSQL required.
"""

import json
from unittest.mock import patch
import pytest


# ============================================================
# Health endpoint
# ============================================================

class TestHealth:
    def test_health_ok(self, client, mock_is_connected_ok):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert data["database"] == "connected"

    def test_health_db_unavailable(self, client, mock_is_connected_fail):
        resp = client.get("/api/health")
        assert resp.status_code == 503
        data = resp.get_json()
        assert data["database"] == "unavailable"


# ============================================================
# System info endpoint
# ============================================================

class TestSystemInfo:
    def test_returns_expected_fields(self, client):
        resp = client.get("/api/system-info")
        assert resp.status_code == 200
        data = resp.get_json()

        required_keys = [
            "hostname", "os", "python_version", "cpu_cores",
            "total_ram_mb", "available_ram_mb",
            "cpu_percent", "ram_percent", "uptime_seconds",
            "environment_name", "server_configuration",
        ]
        for key in required_keys:
            assert key in data, f"Missing key: {key}"

    def test_no_sensitive_info(self, client):
        """Ensure passwords / env vars are not leaked."""
        resp = client.get("/api/system-info")
        text = resp.get_data(as_text=True).lower()
        assert "password" not in text
        assert "secret" not in text
        assert "db_password" not in text

    def test_cpu_cores_positive(self, client):
        data = client.get("/api/system-info").get_json()
        assert data["cpu_cores"] >= 1

    def test_environment_name_matches_config(self, client):
        data = client.get("/api/system-info").get_json()
        assert data["environment_name"] == "Test"


# ============================================================
# Metrics endpoint
# ============================================================

class TestMetrics:
    def test_returns_metrics(self, client):
        resp = client.get("/api/metrics")
        assert resp.status_code == 200
        data = resp.get_json()
        assert "cpu_percent" in data
        assert "ram_percent" in data
        assert "ram_used_mb" in data
        assert "ram_available_mb" in data

    def test_cpu_percent_in_range(self, client):
        data = client.get("/api/metrics").get_json()
        assert 0 <= data["cpu_percent"] <= 100

    def test_ram_percent_in_range(self, client):
        data = client.get("/api/metrics").get_json()
        assert 0 <= data["ram_percent"] <= 100


# ============================================================
# Benchmark history endpoint
# ============================================================

class TestBenchmarkHistory:
    def test_returns_list_with_mock(self, client, mock_db):
        from datetime import datetime, timezone
        mock_db.return_value = [
            {
                "id": 1,
                "environment_name": "Test",
                "server_configuration": "Test Machine",
                "test_type": "cpu",
                "test_parameter": "5s",
                "execution_time": 5.01,
                "cpu_usage": 88.5,
                "memory_usage": 42.1,
                "extra_metrics": None,
                "timestamp": datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc),
            }
        ]
        resp = client.get("/api/benchmarks")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, list)
        assert data[0]["test_type"] == "cpu"

    def test_limit_clamping(self, client, mock_db):
        mock_db.return_value = []
        resp = client.get("/api/benchmarks?limit=99999")
        assert resp.status_code == 200  # clamped, not rejected

    def test_invalid_limit(self, client):
        resp = client.get("/api/benchmarks?limit=notanumber")
        assert resp.status_code == 400


# ============================================================
# Dashboard route
# ============================================================

class TestDashboard:
    def test_serves_html(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert b"Cloud Resource Benchmark" in resp.data
        assert b"<html" in resp.data.lower()


# ============================================================
# Database Status endpoint (Stage 2)
# ============================================================

class TestDatabaseStatus:
    def test_database_status_connected(self, client):
        with patch("app.database.is_connected", return_value=True), \
             patch("app.database.get_pg_version", return_value="PostgreSQL 16.3 on x86_64"), \
             patch("app.database.get_database_size", return_value={"size_bytes": 10485760, "size_pretty": "10 MB"}), \
             patch("app.database.get_active_connections", return_value=3), \
             patch("app.models.benchmark.get_dataset_counts", return_value={"users_count": 10000, "orders_count": 10000}), \
             patch("app.models.benchmark.is_users_email_indexed", return_value=True), \
             patch("app.cache.get_cache_status", return_value={"connected": True, "ping_ms": 0.45, "version": "7.2.4"}):
            resp = client.get("/api/database/status")
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["status"] == "ok"
            assert data["database"]["connected"] is True
            assert "PostgreSQL 16" in data["database"]["version"]
            assert data["database"]["size"]["size_pretty"] == "10 MB"
            assert data["database"]["active_connections"] == 3
            assert data["database"]["counts"]["users_count"] == 10000
            assert data["database"]["idx_users_email_exists"] is True
            assert data["redis"]["connected"] is True
            assert data["redis"]["version"] == "7.2.4"

    def test_database_status_degraded(self, client):
        with patch("app.database.is_connected", return_value=False), \
             patch("app.cache.get_cache_status", return_value={"connected": False, "ping_ms": None, "version": None}):
            resp = client.get("/api/database/status")
            assert resp.status_code == 503
            data = resp.get_json()
            assert data["status"] == "degraded"
            assert data["database"]["connected"] is False


# ============================================================
# Database Index Management endpoint (Stage 2)
# ============================================================

class TestManageIndex:
    def test_manage_index_create(self, client):
        with patch("app.database.is_connected", return_value=True), \
             patch("app.models.benchmark.set_users_email_index", return_value=True):
            resp = client.post("/api/database/index", json={"action": "create", "index_name": "idx_users_email"})
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["status"] == "ok"
            assert data["action"] == "created"
            assert data["exists"] is True

    def test_manage_index_drop(self, client):
        with patch("app.database.is_connected", return_value=True), \
             patch("app.models.benchmark.set_users_email_index", return_value=False):
            resp = client.post("/api/database/index", json={"action": "drop", "index_name": "idx_users_email"})
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["status"] == "ok"
            assert data["action"] == "dropped"
            assert data["exists"] is False

