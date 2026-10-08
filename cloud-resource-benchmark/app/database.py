"""
app/database.py
---------------
Manages a connection pool for PostgreSQL using psycopg2, plus utilities
for database performance measurements, EXPLAIN plan inspection, and index management.
"""

import json
import logging
from typing import Any, Optional
import psycopg2
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)

# The pool is initialised once in create_app()
_pool: pg_pool.ThreadedConnectionPool | None = None


def init_pool(dsn: str, minconn: int = 2, maxconn: int = 30) -> None:
    """Create the connection pool. Called once at startup."""
    global _pool
    _pool = pg_pool.ThreadedConnectionPool(minconn, maxconn, dsn)
    logger.info("PostgreSQL connection pool created (min=%d, max=%d)", minconn, maxconn)


def get_connection() -> psycopg2.extensions.connection:
    """Borrow a connection from the pool. Must be returned with release()."""
    if _pool is None:
        raise RuntimeError("Database pool is not initialised — call init_pool() first.")
    return _pool.getconn()


def release_connection(conn: psycopg2.extensions.connection) -> None:
    """Return a connection to the pool."""
    if _pool is not None and conn is not None:
        _pool.putconn(conn)


def execute_query(sql: str, params=None, fetch: bool = True) -> Any:
    """
    Run a single SQL statement using a pooled connection.

    Parameters
    ----------
    sql    : Parameterised SQL string (use %s placeholders).
    params : Tuple/list of values to bind.
    fetch  : If True return all rows as list-of-dicts; if False return None.

    Returns
    -------
    List of dicts (when fetch=True) or None.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            if fetch:
                return cur.fetchall()
            conn.commit()
            return None
    except Exception:
        conn.rollback()
        raise
    finally:
        release_connection(conn)


def is_connected() -> bool:
    """Return True if the database is reachable."""
    try:
        rows = execute_query("SELECT 1 AS ok")
        return rows is not None and len(rows) > 0
    except Exception as exc:
        logger.warning("DB health check failed: %s", exc)
        return False


# --------------------------------------------------------------------------- #
# Database Measurement Utilities                                               #
# --------------------------------------------------------------------------- #

def get_pg_version() -> str:
    """Return the PostgreSQL server version string."""
    rows = execute_query("SELECT version() AS version;")
    if rows and len(rows) > 0:
        return rows[0]["version"]
    return "Unknown"


def get_database_size() -> dict[str, Any]:
    """Return database size in bytes and human-readable format."""
    sql = """
        SELECT 
            pg_database_size(current_database()) AS size_bytes,
            pg_size_pretty(pg_database_size(current_database())) AS size_pretty;
    """
    rows = execute_query(sql)
    if rows and len(rows) > 0:
        return {
            "size_bytes": rows[0]["size_bytes"],
            "size_pretty": rows[0]["size_pretty"],
        }
    return {"size_bytes": 0, "size_pretty": "0 bytes"}


def get_active_connections() -> int:
    """Return the number of active connections to the current database."""
    sql = """
        SELECT count(*)::int AS active_conns 
        FROM pg_stat_activity 
        WHERE datname = current_database();
    """
    rows = execute_query(sql)
    if rows and len(rows) > 0:
        return rows[0]["active_conns"]
    return 0


def explain_query(
    sql: str,
    params=None,
    analyze: bool = True,
    buffers: bool = True,
    as_json: bool = True,
) -> Any:
    """
    Run EXPLAIN on the given SQL statement and return the plan.
    Uses EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) when as_json is True.
    """
    options = []
    if analyze:
        options.append("ANALYZE")
    if buffers:
        options.append("BUFFERS")
    if as_json:
        options.append("FORMAT JSON")

    opts_str = f"({', '.join(options)})" if options else ""
    explain_sql = f"EXPLAIN {opts_str} {sql}"

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(explain_sql, params)
            rows = cur.fetchall()
            if as_json and rows:
                plan_json = rows[0][0]
                if isinstance(plan_json, str):
                    return json.loads(plan_json)
                return plan_json
            return [r[0] for r in rows]
    except Exception:
        conn.rollback()
        raise
    finally:
        release_connection(conn)


# --------------------------------------------------------------------------- #
# Index Management Utilities                                                   #
# --------------------------------------------------------------------------- #

def index_exists(index_name: str) -> bool:
    """Check whether a specific index exists in the current database."""
    sql = "SELECT 1 FROM pg_indexes WHERE indexname = %s;"
    rows = execute_query(sql, (index_name,))
    return bool(rows and len(rows) > 0)


def create_index(index_name: str, table_name: str, column_name: str) -> None:
    """Create an index if it does not already exist."""
    sql = f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}({column_name});"
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        logger.info("Index created: %s on %s(%s)", index_name, table_name, column_name)
    except Exception:
        conn.rollback()
        raise
    finally:
        release_connection(conn)


def drop_index(index_name: str) -> None:
    """Drop an index if it exists."""
    sql = f"DROP INDEX IF EXISTS {index_name};"
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        logger.info("Index dropped: %s", index_name)
    except Exception:
        conn.rollback()
        raise
    finally:
        release_connection(conn)
