"""
app/routes/api.py
-----------------
General API endpoints:
    GET  /api/health          — liveness + DB check
    GET  /api/system-info     — hostname, OS, Python, CPU/RAM
    GET  /api/metrics         — live CPU% and RAM% (polled every 2 s by JS)
    GET  /api/benchmarks      — benchmark history (filterable)
    GET  /api/benchmarks/compare — Local vs Cloud comparison data
"""

import logging
import os
import platform
import time
from datetime import datetime, timezone

import psutil
from flask import Blueprint, current_app, jsonify, request

from app import cache
from app import database as db
from app.models import benchmark as bm_models

logger = logging.getLogger(__name__)
api_bp = Blueprint("api", __name__, url_prefix="/api")

# Track when the process started so we can report uptime
_PROCESS_START = time.time()


# --------------------------------------------------------------------------- #
# Health & Database Status                                                      #
# --------------------------------------------------------------------------- #

@api_bp.get("/health")
def health():
    db_ok = db.is_connected()
    return jsonify(
        {
            "status": "ok",
            "database": "connected" if db_ok else "unavailable",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    ), (200 if db_ok else 503)


@api_bp.get("/database/status")
def database_status():
    """
    Return comprehensive, real-time database and cache status:
    - PostgreSQL connection status and version
    - Database name and storage size on disk
    - Active connections in pg_stat_activity
    - Current row counts for users and orders
    - State of index idx_users_email
    - Redis connection status, ping latency, memory, and version
    """
    db_ok = db.is_connected()
    db_name = current_app.config.get("DB_NAME", "benchmark_db")
    db_host = current_app.config.get("DB_HOST", "localhost")
    db_port = current_app.config.get("DB_PORT", 5432)

    db_info = {
        "connected": db_ok,
        "name": db_name,
        "host": db_host,
        "port": db_port,
        "version": db.get_pg_version() if db_ok else "Unavailable",
        "size": db.get_database_size() if db_ok else {"size_bytes": 0, "size_pretty": "0 bytes"},
        "active_connections": db.get_active_connections() if db_ok else 0,
        "counts": bm_models.get_dataset_counts() if db_ok else {"users_count": 0, "orders_count": 0},
        "idx_users_email_exists": bm_models.is_users_email_indexed() if db_ok else False,
    }

    cache_status = cache.get_cache_status()
    cache_status["host"] = current_app.config.get("REDIS_HOST", "localhost")
    cache_status["port"] = current_app.config.get("REDIS_PORT", 6379)

    return jsonify({
        "status": "ok" if db_ok else "degraded",
        "database": db_info,
        "redis": cache_status,
        "environment_name": current_app.config.get("ENVIRONMENT_NAME", "Local"),
        "server_configuration": current_app.config.get("SERVER_CONFIGURATION", "Unknown"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }), (200 if db_ok else 503)


@api_bp.post("/database/index")
def manage_index():
    """
    Toggle or check research indexes.
    Body: {"action": "create"|"drop"|"status", "index_name": "idx_users_email"}
    """
    body = request.get_json(silent=True) or {}
    action = body.get("action", "status")
    index_name = body.get("index_name", "idx_users_email")

    if not db.is_connected():
        return jsonify({"error": "Database is not connected"}), 503

    try:
        if action == "create":
            if index_name == "idx_users_email":
                exists = bm_models.set_users_email_index(create=True)
            else:
                db.create_index(index_name, "db_benchmark_users", "email")
                exists = True
            return jsonify({"status": "ok", "index_name": index_name, "exists": exists, "action": "created"})
        elif action == "drop":
            if index_name == "idx_users_email":
                exists = bm_models.set_users_email_index(create=False)
            else:
                db.drop_index(index_name)
                exists = False
            return jsonify({"status": "ok", "index_name": index_name, "exists": exists, "action": "dropped"})
        else:
            exists = db.index_exists(index_name)
            return jsonify({"status": "ok", "index_name": index_name, "exists": exists, "action": "checked"})
    except Exception as exc:
        logger.exception("Index management action '%s' failed", action)
        return jsonify({"error": str(exc)}), 500




# --------------------------------------------------------------------------- #
# System information                                                            #
# --------------------------------------------------------------------------- #

@api_bp.get("/system-info")
def system_info():
    """
    Return non-sensitive system information useful for the dashboard header.
    Deliberately excludes: IP addresses, env vars, passwords, private paths.
    """
    vm = psutil.virtual_memory()
    uptime_seconds = int(time.time() - _PROCESS_START)

    return jsonify(
        {
            "hostname": platform.node(),
            "os": f"{platform.system()} {platform.release()}",
            "python_version": platform.python_version(),
            "cpu_cores": os.cpu_count(),
            "total_ram_mb": round(vm.total / 1_048_576, 1),
            "available_ram_mb": round(vm.available / 1_048_576, 1),
            "cpu_percent": psutil.cpu_percent(interval=0.5),
            "ram_percent": vm.percent,
            "uptime_seconds": uptime_seconds,
            # Experiment metadata (safe to expose — set by operator)
            "environment_name": current_app.config["ENVIRONMENT_NAME"],
            "server_configuration": current_app.config["SERVER_CONFIGURATION"],
        }
    )


# --------------------------------------------------------------------------- #
# Live metrics (polled by JS every 2 s)                                        #
# --------------------------------------------------------------------------- #

@api_bp.get("/metrics")
def metrics():
    """Lightweight endpoint — returns current CPU% and RAM stats."""
    vm = psutil.virtual_memory()
    return jsonify(
        {
            "cpu_percent": psutil.cpu_percent(interval=0.2),
            "ram_percent": vm.percent,
            "ram_used_mb": round((vm.total - vm.available) / 1_048_576, 1),
            "ram_available_mb": round(vm.available / 1_048_576, 1),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


# --------------------------------------------------------------------------- #
# Benchmark history                                                             #
# --------------------------------------------------------------------------- #

@api_bp.get("/benchmarks")
def benchmarks():
    """
    Return stored benchmark results.

    Query parameters (all optional):
        test_type        — filter by type (cpu / database / data-processing)
        environment_name — filter by environment
        date_from        — ISO date string  (e.g. 2025-01-01)
        date_to          — ISO date string
        limit            — max rows (default 200)
    """
    test_type = request.args.get("test_type")
    environment_name = request.args.get("environment_name")
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")

    try:
        limit = int(request.args.get("limit", 200))
        limit = max(1, min(limit, 1000))   # clamp between 1 and 1000
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400

    try:
        rows = bm_models.get_results(
            test_type=test_type,
            environment_name=environment_name,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
        )
    except Exception as exc:
        logger.exception("Failed to fetch benchmark history")
        return jsonify({"error": str(exc)}), 500

    # Serialise timestamps (psycopg2 returns datetime objects)
    for row in rows:
        if "timestamp" in row and hasattr(row["timestamp"], "isoformat"):
            row["timestamp"] = row["timestamp"].isoformat()

    return jsonify(rows)


# --------------------------------------------------------------------------- #
# Comparison                                                                    #
# --------------------------------------------------------------------------- #

@api_bp.get("/benchmarks/compare")
def benchmarks_compare():
    """
    Return comparison data grouped by test type, parameter, and environment.
    Only real stored data — nothing invented.
    """
    try:
        data = bm_models.get_comparison_data()
    except Exception as exc:
        logger.exception("Failed to fetch comparison data")
        return jsonify({"error": str(exc)}), 500

    # Serialise any datetime objects that may appear
    for row in data:
        for k, v in row.items():
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()

    return jsonify(data)
