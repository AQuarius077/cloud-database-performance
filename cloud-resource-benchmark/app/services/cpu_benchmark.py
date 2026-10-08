"""
app/services/cpu_benchmark.py
------------------------------
CPU Benchmark service.

How it works
------------
1. Record baseline RAM.
2. Start one worker thread per logical CPU that performs a CPU-intensive
   prime-counting loop for the requested duration.
3. A sampler thread records cpu_percent() every 0.5 s throughout the run.
4. After all workers finish, collect final RAM and return the metrics dict.

The prime-counting loop is a deterministic calculation: the same duration
always exercises the CPU in the same way regardless of the result.
"""

import logging
import math
import os
import threading
import time
from typing import Any

import psutil

logger = logging.getLogger(__name__)

# How many primes to count per "chunk" inside the worker loop.
# Smaller = more granular yielding; larger = heavier CPU hit per iteration.
PRIME_CHUNK_LIMIT = 200_000


def _count_primes(limit: int) -> int:
    """Count prime numbers up to *limit* using trial division.
    Pure Python so it actually burns CPU regardless of optimisations."""
    count = 0
    for n in range(2, limit):
        is_prime = True
        for d in range(2, int(math.isqrt(n)) + 1):
            if n % d == 0:
                is_prime = False
                break
        if is_prime:
            count += 1
    return count


def _worker(stop_event: threading.Event) -> None:
    """Keep counting primes until the stop event is set."""
    while not stop_event.is_set():
        _count_primes(PRIME_CHUNK_LIMIT)


def run_cpu_benchmark(duration_seconds: int) -> dict[str, Any]:
    """
    Run a CPU-intensive workload for *duration_seconds* seconds.

    Parameters
    ----------
    duration_seconds : int
        How long to stress the CPU (5, 10, or 30).

    Returns
    -------
    dict with keys:
        duration_requested, execution_time, avg_cpu_percent,
        max_cpu_percent, ram_before_mb, ram_after_mb,
        worker_count
    """
    if duration_seconds not in (5, 10, 30):
        raise ValueError("duration_seconds must be 5, 10, or 30")

    cpu_count = os.cpu_count() or 1
    process = psutil.Process()

    # --- Baseline RAM ---
    ram_before_mb = process.memory_info().rss / 1_048_576  # bytes → MB

    # --- CPU samples collected by a background thread ---
    cpu_samples: list[float] = []
    stop_event = threading.Event()
    sample_interval = 0.5  # seconds between samples

    def sampler() -> None:
        # Warm up psutil's interval-based measurement
        psutil.cpu_percent(interval=None)
        while not stop_event.is_set():
            sample = psutil.cpu_percent(interval=sample_interval)
            cpu_samples.append(sample)

    # --- Launch workers + sampler ---
    threads: list[threading.Thread] = []
    sampler_thread = threading.Thread(target=sampler, daemon=True)
    sampler_thread.start()

    for _ in range(cpu_count):
        t = threading.Thread(target=_worker, args=(stop_event,), daemon=True)
        t.start()
        threads.append(t)

    start_time = time.perf_counter()

    # Run for the requested duration, then signal workers to stop
    time.sleep(duration_seconds)
    stop_event.set()

    for t in threads:
        t.join(timeout=5)

    elapsed = time.perf_counter() - start_time

    # --- Final RAM ---
    ram_after_mb = process.memory_info().rss / 1_048_576

    # --- Aggregate CPU samples ---
    if not cpu_samples:
        avg_cpu = 0.0
        max_cpu = 0.0
    else:
        avg_cpu = round(sum(cpu_samples) / len(cpu_samples), 2)
        max_cpu = round(max(cpu_samples), 2)

    logger.info(
        "CPU benchmark done: %.2f s, avg_cpu=%.1f%%, max_cpu=%.1f%%",
        elapsed,
        avg_cpu,
        max_cpu,
    )

    return {
        "duration_requested": duration_seconds,
        "execution_time": round(elapsed, 3),
        "avg_cpu_percent": avg_cpu,
        "max_cpu_percent": max_cpu,
        "ram_before_mb": round(ram_before_mb, 1),
        "ram_after_mb": round(ram_after_mb, 1),
        "worker_count": cpu_count,
        "sample_count": len(cpu_samples),
    }
