"""
app/services/db_benchmark.py
-----------------------------
Database Benchmark service.

How it works
------------
1. Execute N parameterised SELECT queries against benchmark_data.
2. Measure wall-clock time for the whole batch.
3. Sample CPU and RAM before/during/after.

Every query uses a %s placeholder — no string formatting of user input.
"""

import logging
import time
from typing import Any

import psutil

from app import database as db

logger = logging.getLogger(__name__)

ALLOWED_QUERY_COUNTS = {100, 1_000, 10_000}

# The test query — parameterised, no injection risk.
BENCHMARK_QUERY = """
    SELECT id, category, value_int, value_float, label
    FROM   benchmark_data
    WHERE  category = %s
    LIMIT  10
"""

CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon"]


def run_db_benchmark(query_count: int) -> dict[str, Any]:
    """
    Execute *query_count* parameterised SELECT queries and measure timing.

    Parameters
    ----------
    query_count : int
        Number of queries to run (100, 1 000, or 10 000).

    Returns
    -------
    dict with keys:
        query_count, execution_time, avg_query_time_ms,
        queries_per_second, cpu_percent, memory_mb
    """
    if query_count not in ALLOWED_QUERY_COUNTS:
        raise ValueError(f"query_count must be one of {ALLOWED_QUERY_COUNTS}")

    process = psutil.Process()

    # Warm up psutil interval measurement
    psutil.cpu_percent(interval=None)

    ram_before_mb = process.memory_info().rss / 1_048_576

    conn = db.get_connection()
    try:
        start = time.perf_counter()

        with conn.cursor() as cur:
            for i in range(query_count):
                # Rotate through categories deterministically
                category = CATEGORIES[i % len(CATEGORIES)]
                cur.execute(BENCHMARK_QUERY, (category,))
                cur.fetchall()

        elapsed = time.perf_counter() - start
    finally:
        db.release_connection(conn)

    cpu_pct = psutil.cpu_percent(interval=None)
    ram_after_mb = process.memory_info().rss / 1_048_576

    avg_query_ms = (elapsed / query_count) * 1000
    qps = query_count / elapsed if elapsed > 0 else 0.0

    logger.info(
        "DB benchmark done: %d queries in %.3f s (%.1f q/s)",
        query_count,
        elapsed,
        qps,
    )

    return {
        "query_count": query_count,
        "execution_time": round(elapsed, 4),
        "avg_query_time_ms": round(avg_query_ms, 4),
        "queries_per_second": round(qps, 2),
        "cpu_percent": round(cpu_pct, 2),
        "ram_before_mb": round(ram_before_mb, 1),
        "ram_after_mb": round(ram_after_mb, 1),
    }
