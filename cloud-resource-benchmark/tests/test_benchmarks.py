"""
tests/test_benchmarks.py
------------------------
Tests for benchmark services and routes.

Services are tested directly (no HTTP) to verify calculation logic.
Routes are tested via the Flask test client with mocked DB + services.
"""

import json
import pytest
from unittest.mock import patch, MagicMock


# ============================================================
# CPU Benchmark Service
# ============================================================

class TestCpuBenchmarkService:
    def test_valid_duration_returns_dict(self):
        from app.services.cpu_benchmark import run_cpu_benchmark
        result = run_cpu_benchmark(5)
        assert isinstance(result, dict)

    def test_result_has_required_keys(self):
        from app.services.cpu_benchmark import run_cpu_benchmark
        result = run_cpu_benchmark(5)
        required = [
            "execution_time", "avg_cpu_percent", "max_cpu_percent",
            "ram_before_mb", "ram_after_mb", "worker_count",
        ]
        for key in required:
            assert key in result, f"Missing: {key}"

    def test_execution_time_approximately_correct(self):
        """Execution time should be close to requested duration."""
        from app.services.cpu_benchmark import run_cpu_benchmark
        result = run_cpu_benchmark(5)
        assert 4 <= result["execution_time"] <= 8

    def test_invalid_duration_raises(self):
        from app.services.cpu_benchmark import run_cpu_benchmark
        with pytest.raises(ValueError):
            run_cpu_benchmark(7)

    def test_worker_count_positive(self):
        from app.services.cpu_benchmark import run_cpu_benchmark
        result = run_cpu_benchmark(5)
        assert result["worker_count"] >= 1

    def test_cpu_percent_in_range(self):
        from app.services.cpu_benchmark import run_cpu_benchmark
        result = run_cpu_benchmark(5)
        assert 0 <= result["avg_cpu_percent"] <= 100
        assert 0 <= result["max_cpu_percent"] <= 100


# ============================================================
# Data Processing Benchmark Service
# ============================================================

class TestDataBenchmarkService:
    def test_small_returns_dict(self):
        from app.services.data_benchmark import run_data_benchmark
        result = run_data_benchmark("small")
        assert isinstance(result, dict)

    def test_result_keys(self):
        from app.services.data_benchmark import run_data_benchmark
        result = run_data_benchmark("small")
        for key in ["execution_time", "cpu_percent", "ram_before_mb", "ram_after_mb",
                    "matrix_dimension", "approx_flops"]:
            assert key in result

    def test_matrix_dimension_small(self):
        from app.services.data_benchmark import run_data_benchmark
        result = run_data_benchmark("small")
        assert result["matrix_dimension"] == 512

    def test_matrix_dimension_medium(self):
        from app.services.data_benchmark import run_data_benchmark
        result = run_data_benchmark("medium")
        assert result["matrix_dimension"] == 1024

    def test_invalid_size_raises(self):
        from app.services.data_benchmark import run_data_benchmark
        with pytest.raises(ValueError):
            run_data_benchmark("huge")

    def test_deterministic(self):
        """Same size should give same flop count (deterministic workload)."""
        from app.services.data_benchmark import run_data_benchmark
        r1 = run_data_benchmark("small")
        r2 = run_data_benchmark("small")
        assert r1["approx_flops"] == r2["approx_flops"]


# ============================================================
# CPU Benchmark Route
# ============================================================

class TestCpuBenchmarkRoute:
    def _mock_run(self, result):
        return patch("app.routes.benchmarks.run_cpu_benchmark", return_value=result)

    def _mock_save(self, saved):
        return patch("app.routes.benchmarks.save_result", return_value=saved)

    def _mock_total_ram(self, mb=8192):
        return patch("app.routes.benchmarks._total_ram_mb", return_value=mb)

    def test_valid_request(self, client):
        fake_result = {
            "duration_requested": 5, "execution_time": 5.01,
            "avg_cpu_percent": 90.0, "max_cpu_percent": 99.0,
            "ram_before_mb": 500.0, "ram_after_mb": 502.0,
            "worker_count": 4, "sample_count": 10,
        }
        fake_saved = {"id": 42, "timestamp": "2025-01-01T00:00:00+00:00"}

        with self._mock_run(fake_result), self._mock_save(fake_saved), self._mock_total_ram():
            resp = client.post(
                "/api/benchmark/cpu",
                data=json.dumps({"duration": 5}),
                content_type="application/json",
            )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["id"] == 42
        assert data["execution_time"] == 5.01

    def test_invalid_duration_rejected(self, client):
        resp = client.post(
            "/api/benchmark/cpu",
            data=json.dumps({"duration": 7}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_missing_body_rejected(self, client):
        resp = client.post("/api/benchmark/cpu", content_type="application/json")
        assert resp.status_code == 400


# ============================================================
# Database Benchmark Route
# ============================================================

class TestDbBenchmarkRoute:
    def test_invalid_query_count(self, client):
        resp = client.post(
            "/api/benchmark/database",
            data=json.dumps({"query_count": 500}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_non_integer_rejected(self, client):
        resp = client.post(
            "/api/benchmark/database",
            data=json.dumps({"query_count": "many"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


# ============================================================
# Data Processing Benchmark Route
# ============================================================

class TestDataBenchmarkRoute:
    def test_invalid_size_rejected(self, client):
        resp = client.post(
            "/api/benchmark/data-processing",
            data=json.dumps({"size": "huge"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_valid_size_runs(self, client):
        fake_result = {
            "size": "small", "matrix_dimension": 512,
            "execution_time": 0.25, "cpu_percent": 55.0,
            "ram_before_mb": 400.0, "ram_after_mb": 404.0,
            "approx_flops": 268_435_456,
        }
        fake_saved = {"id": 10, "timestamp": "2025-01-01T00:00:00+00:00"}

        with patch("app.routes.benchmarks.run_data_benchmark", return_value=fake_result), \
             patch("app.routes.benchmarks.save_result", return_value=fake_saved), \
             patch("app.routes.benchmarks._total_ram_mb", return_value=8192):
            resp = client.post(
                "/api/benchmark/data-processing",
                data=json.dumps({"size": "small"}),
                content_type="application/json",
            )
        assert resp.status_code == 200
        assert resp.get_json()["id"] == 10


# ============================================================
# Research Dataset Seeding route (Stage 2)
# ============================================================

class TestDatasetSeedRoute:
    def test_invalid_size_rejected(self, client):
        resp = client.post(
            "/api/benchmark/dataset-seed",
            json={"dataset_size": 500},
        )
        assert resp.status_code == 400
        assert "dataset_size must be" in resp.get_json()["error"]

    def test_valid_size_success(self, client):
        mock_seed_result = {
            "status": "ok",
            "dataset_size": 10000,
            "users_count": 10000,
            "orders_count": 10000,
            "execution_time_seconds": 0.085,
            "message": "Successfully generated 10,000 users and 10,000 orders in 0.085s",
        }
        with patch("app.models.benchmark.seed_research_dataset", return_value=mock_seed_result):
            resp = client.post(
                "/api/benchmark/dataset-seed",
                json={"dataset_size": 10000},
            )
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["status"] == "ok"
            assert data["users_count"] == 10000
            assert data["orders_count"] == 10000


# ============================================================
# Database Utilities Tests (Stage 2)
# ============================================================

class TestDatabaseUtilities:
    def test_get_database_size(self):
        with patch("app.database.execute_query", return_value=[{"size_bytes": 1048576, "size_pretty": "1024 kB"}]):
            from app.database import get_database_size
            res = get_database_size()
            assert res["size_bytes"] == 1048576
            assert res["size_pretty"] == "1024 kB"

    def test_get_active_connections(self):
        with patch("app.database.execute_query", return_value=[{"active_conns": 5}]):
            from app.database import get_active_connections
            assert get_active_connections() == 5

    def test_explain_query_json(self):
        fake_plan = [{"Plan": {"Node Type": "Seq Scan", "Total Cost": 12.5}}]
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = [[json.dumps(fake_plan)]]
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

        with patch("app.database.get_connection", return_value=mock_conn):
            from app.database import explain_query
            plan = explain_query("SELECT * FROM db_benchmark_users WHERE email = %s", ("test@mail.com",))
            assert plan == fake_plan

