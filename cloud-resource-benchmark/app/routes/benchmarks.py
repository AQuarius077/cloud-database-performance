"""
app/routes/benchmarks.py
-------------------------
Benchmark execution endpoints:
    POST /api/benchmark/cpu
    POST /api/benchmark/database
    POST /api/benchmark/data-processing

Each endpoint:
  1. Validates the request body.
  2. Runs the real benchmark.
  3. Persists the result to PostgreSQL.
  4. Returns the result as JSON.
"""

import logging

from flask import Blueprint, current_app, jsonify, request

from app.models.benchmark import save_result
from app.services.cpu_benchmark import run_cpu_benchmark
from app.services.data_benchmark import run_data_benchmark
from app.services.db_benchmark import run_db_benchmark

logger = logging.getLogger(__name__)
benchmarks_bp = Blueprint("benchmarks", __name__, url_prefix="/api/benchmark")


def _experiment_meta(app) -> tuple[str, str]:
    """Return (environment_name, server_configuration) from app config."""
    return app.config["ENVIRONMENT_NAME"], app.config["SERVER_CONFIGURATION"]


# --------------------------------------------------------------------------- #
# Research Dataset Generation                                                 #
# --------------------------------------------------------------------------- #

@benchmarks_bp.post("/dataset-seed")
def seed_dataset():
    """
    Body (JSON):
        { "dataset_size": 10000 }  # 10000 | 100000 | 1000000
    """
    body = request.get_json(silent=True) or {}
    try:
        dataset_size = int(body.get("dataset_size", 10_000))
    except (TypeError, ValueError):
        return jsonify({"error": "dataset_size must be an integer (10000, 100000, or 1000000)"}), 400

    if dataset_size not in (10_000, 100_000, 1_000_000):
        return jsonify({"error": "dataset_size must be 10000, 100000, or 1000000"}), 400

    logger.info("Starting dataset seeding for research: %d rows", dataset_size)
    try:
        from app.models.benchmark import seed_research_dataset
        result = seed_research_dataset(dataset_size)
        return jsonify(result), 200
    except Exception as exc:
        logger.exception("Dataset seeding failed")
        return jsonify({"error": str(exc)}), 500


# --------------------------------------------------------------------------- #
# CPU Benchmark                                                                 #
# --------------------------------------------------------------------------- #

@benchmarks_bp.post("/cpu")
def cpu_benchmark():
    """
    Body (JSON):
        { "duration": 5 }    # 5 | 10 | 30
    """
    body = request.get_json(silent=True) or {}
    try:
        duration = int(body.get("duration", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "duration must be an integer (5, 10, or 30)"}), 400

    if duration not in (5, 10, 30):
        return jsonify({"error": "duration must be 5, 10, or 30"}), 400

    logger.info("Starting CPU benchmark: %d s", duration)
    try:
        result = run_cpu_benchmark(duration)
    except Exception as exc:
        logger.exception("CPU benchmark failed")
        return jsonify({"error": str(exc)}), 500

    env_name, srv_cfg = _experiment_meta(current_app)
    saved = save_result(
        environment_name=env_name,
        server_configuration=srv_cfg,
        test_type="cpu",
        test_parameter=f"{duration}s",
        execution_time=result["execution_time"],
        cpu_usage=result["avg_cpu_percent"],
        memory_usage=(result["ram_after_mb"] / _total_ram_mb()) * 100,
        extra_metrics={
            "max_cpu_percent": result["max_cpu_percent"],
            "ram_before_mb": result["ram_before_mb"],
            "ram_after_mb": result["ram_after_mb"],
            "worker_count": result["worker_count"],
        },
    )

    return jsonify({**result, **saved, "environment_name": env_name,
                    "server_configuration": srv_cfg})


# --------------------------------------------------------------------------- #
# Database Benchmark                                                            #
# --------------------------------------------------------------------------- #

@benchmarks_bp.post("/database")
def database_benchmark():
    """
    Body (JSON):
        { "query_count": 1000 }    # 100 | 1000 | 10000
    """
    body = request.get_json(silent=True) or {}
    try:
        query_count = int(body.get("query_count", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "query_count must be an integer"}), 400

    if query_count not in (100, 1_000, 10_000):
        return jsonify({"error": "query_count must be 100, 1000, or 10000"}), 400

    logger.info("Starting DB benchmark: %d queries", query_count)
    try:
        result = run_db_benchmark(query_count)
    except Exception as exc:
        logger.exception("DB benchmark failed")
        return jsonify({"error": str(exc)}), 500

    env_name, srv_cfg = _experiment_meta(current_app)
    saved = save_result(
        environment_name=env_name,
        server_configuration=srv_cfg,
        test_type="database",
        test_parameter=f"{query_count}q",
        execution_time=result["execution_time"],
        cpu_usage=result["cpu_percent"],
        memory_usage=(result["ram_after_mb"] / _total_ram_mb()) * 100,
        extra_metrics={
            "avg_query_time_ms": result["avg_query_time_ms"],
            "queries_per_second": result["queries_per_second"],
            "ram_before_mb": result["ram_before_mb"],
            "ram_after_mb": result["ram_after_mb"],
        },
    )

    return jsonify({**result, **saved, "environment_name": env_name,
                    "server_configuration": srv_cfg})


# --------------------------------------------------------------------------- #
# Data Processing Benchmark                                                     #
# --------------------------------------------------------------------------- #

@benchmarks_bp.post("/data-processing")
def data_processing_benchmark():
    """
    Body (JSON):
        { "size": "medium" }    # small | medium | large
    """
    body = request.get_json(silent=True) or {}
    size = str(body.get("size", "")).strip().lower()

    if size not in ("small", "medium", "large"):
        return jsonify({"error": "size must be 'small', 'medium', or 'large'"}), 400

    logger.info("Starting data-processing benchmark: size=%s", size)
    try:
        result = run_data_benchmark(size)
    except Exception as exc:
        logger.exception("Data benchmark failed")
        return jsonify({"error": str(exc)}), 500

    env_name, srv_cfg = _experiment_meta(current_app)
    saved = save_result(
        environment_name=env_name,
        server_configuration=srv_cfg,
        test_type="data-processing",
        test_parameter=size,
        execution_time=result["execution_time"],
        cpu_usage=result["cpu_percent"],
        memory_usage=(result["ram_after_mb"] / _total_ram_mb()) * 100,
        extra_metrics={
            "matrix_dimension": result["matrix_dimension"],
            "approx_flops": result["approx_flops"],
            "ram_before_mb": result["ram_before_mb"],
            "ram_after_mb": result["ram_after_mb"],
        },
    )

    return jsonify({**result, **saved, "environment_name": env_name,
                    "server_configuration": srv_cfg})


# --------------------------------------------------------------------------- #
# Helper                                                                        #
# --------------------------------------------------------------------------- #

def _total_ram_mb() -> float:
    """Return total physical RAM in MB (used to compute % from absolute MB)."""
    import psutil
    return psutil.virtual_memory().total / 1_048_576
