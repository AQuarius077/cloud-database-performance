"""
app/services/data_benchmark.py
-------------------------------
Data Processing Benchmark service.

How it works
------------
Uses NumPy to perform matrix multiplication on a square matrix.
The matrix is generated with a fixed random seed so the workload is
reproducible across runs.

Size mapping
    small  → 512 × 512
    medium → 1024 × 1024
    large  → 2048 × 2048

Matmul at these sizes is CPU-bound and scales clearly with hardware.
"""

import logging
import time
from typing import Any

import numpy as np
import psutil

logger = logging.getLogger(__name__)

# Deterministic sizes — same computation every run
SIZES: dict[str, int] = {
    "small": 512,
    "medium": 1024,
    "large": 2048,
}

RANDOM_SEED = 42  # fixed seed → identical matrices every run


def run_data_benchmark(size: str) -> dict[str, Any]:
    """
    Multiply two N×N float64 matrices and measure the elapsed time.

    Parameters
    ----------
    size : str
        'small', 'medium', or 'large'.

    Returns
    -------
    dict with keys:
        size, matrix_dimension, execution_time,
        cpu_percent, ram_before_mb, ram_after_mb,
        operations (approx FLOP count)
    """
    size = size.lower()
    if size not in SIZES:
        raise ValueError(f"size must be one of {list(SIZES.keys())}")

    dim = SIZES[size]
    process = psutil.Process()

    # Warm up psutil
    psutil.cpu_percent(interval=None)
    ram_before_mb = process.memory_info().rss / 1_048_576

    # Build matrices with fixed seed (deterministic)
    rng = np.random.default_rng(RANDOM_SEED)
    a = rng.random((dim, dim), dtype=np.float64)
    b = rng.random((dim, dim), dtype=np.float64)

    # --- Timed computation ---
    start = time.perf_counter()
    _result = np.matmul(a, b)
    elapsed = time.perf_counter() - start

    # Force result to be kept in memory until here
    _ = _result.sum()

    cpu_pct = psutil.cpu_percent(interval=None)
    ram_after_mb = process.memory_info().rss / 1_048_576

    # Approximate FLOP count for N×N matmul ≈ 2*N^3
    approx_flops = 2 * (dim ** 3)

    logger.info(
        "Data benchmark done: size=%s dim=%d elapsed=%.4f s",
        size,
        dim,
        elapsed,
    )

    return {
        "size": size,
        "matrix_dimension": dim,
        "execution_time": round(elapsed, 4),
        "cpu_percent": round(cpu_pct, 2),
        "ram_before_mb": round(ram_before_mb, 1),
        "ram_after_mb": round(ram_after_mb, 1),
        "approx_flops": approx_flops,
    }
