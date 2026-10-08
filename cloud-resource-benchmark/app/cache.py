"""
app/cache.py
------------
Redis connection management and cache utilities for database benchmarking.
"""

import logging
import time
from typing import Any, Optional
import redis

logger = logging.getLogger(__name__)

_redis_client: Optional[redis.Redis] = None


def init_cache(
    host: str = "localhost",
    port: int = 6379,
    password: Optional[str] = None,
    db: int = 0,
    socket_timeout: float = 0.5,
    socket_connect_timeout: float = 0.5,
) -> Optional[redis.Redis]:
    """Initialize Redis client."""
    global _redis_client
    if host == "localhost":
        host = "127.0.0.1"
    try:
        _redis_client = redis.Redis(
            host=host,
            port=port,
            password=password,
            db=db,
            socket_timeout=socket_timeout,
            socket_connect_timeout=socket_connect_timeout,
            decode_responses=True,
        )
        # Test connection with a ping
        _redis_client.ping()
        logger.info("Connected to Redis cache at %s:%d (db=%d)", host, port, db)
        return _redis_client
    except Exception as exc:
        logger.warning("Redis cache is not reachable at %s:%d: %s", host, port, exc)
        return None


def get_redis_client() -> Optional[redis.Redis]:
    """Return the global Redis client instance."""
    return _redis_client


def is_cache_connected() -> bool:
    """Return True if Redis is responding to PING."""
    if _redis_client is None:
        return False
    try:
        return bool(_redis_client.ping())
    except Exception:
        return False


def get_cache_status() -> dict[str, Any]:
    """Return detailed Redis status, latency, and server info."""
    if _redis_client is None:
        return {
            "connected": False,
            "error": "Redis client not initialized",
            "ping_ms": None,
            "version": None,
        }
    try:
        start = time.perf_counter()
        _redis_client.ping()
        ping_ms = round((time.perf_counter() - start) * 1000, 2)
        info = _redis_client.info()
        return {
            "connected": True,
            "ping_ms": ping_ms,
            "version": info.get("redis_version"),
            "used_memory_human": info.get("used_memory_human"),
            "connected_clients": info.get("connected_clients"),
        }
    except Exception as exc:
        return {
            "connected": False,
            "error": str(exc),
            "ping_ms": None,
            "version": None,
        }
