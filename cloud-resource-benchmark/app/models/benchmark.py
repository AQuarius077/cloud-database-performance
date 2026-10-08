"""
app/models/benchmark.py
-----------------------
Database schema management, synthetic dataset generation, and result persistence.

Tables
------
benchmark_results    — one row per completed benchmark run (with rich DB metrics)
benchmark_data       — synthetic legacy dataset used by existing DB benchmark
db_benchmark_users   — 10k / 100k / 1M users for database optimization research
db_benchmark_orders  — corresponding relational orders table
"""

import json
import logging
import time
from datetime import datetime
from typing import Any, Optional
from app import database as db

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Schemas                                                                     #
# --------------------------------------------------------------------------- #

CREATE_RESULTS_TABLE = """
CREATE TABLE IF NOT EXISTS benchmark_results (
    id                      SERIAL PRIMARY KEY,
    environment_name        VARCHAR(64)   NOT NULL,
    server_configuration    VARCHAR(128)  NOT NULL,
    test_type               VARCHAR(64)   NOT NULL,
    test_parameter          VARCHAR(64)   NOT NULL,
    execution_time          FLOAT         NOT NULL,   -- seconds
    cpu_usage               FLOAT         NOT NULL,   -- average %
    memory_usage            FLOAT         NOT NULL,   -- average %
    extra_metrics           JSONB,                    -- test-specific extras
    timestamp               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    
    -- Cloud Database Performance Research extensions
    experiment_type         VARCHAR(64),
    dataset_size            INTEGER,
    execution_time_ms       FLOAT,
    average_latency_ms      FLOAT,
    min_latency_ms          FLOAT,
    max_latency_ms          FLOAT,
    qps                     FLOAT,
    error_rate              FLOAT,
    cache_hit               BOOLEAN,
    index_state             VARCHAR(64),
    database_configuration  VARCHAR(128),
    explain_plan            JSONB,
    created_at              TIMESTAMPTZ   DEFAULT NOW()
);
"""

ALTER_RESULTS_TABLE_COLUMNS = [
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS experiment_type VARCHAR(64);",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS dataset_size INTEGER;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS execution_time_ms FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS average_latency_ms FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS min_latency_ms FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS max_latency_ms FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS qps FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS error_rate FLOAT;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS index_state VARCHAR(64);",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS database_configuration VARCHAR(128);",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS explain_plan JSONB;",
    "ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();",
]

CREATE_BENCHMARK_DATA_TABLE = """
CREATE TABLE IF NOT EXISTS benchmark_data (
    id          SERIAL PRIMARY KEY,
    category    VARCHAR(32)   NOT NULL,
    value_int   INTEGER       NOT NULL,
    value_float DOUBLE PRECISION NOT NULL,
    label       VARCHAR(64)   NOT NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
"""

CREATE_RESEARCH_USERS_TABLE = """
CREATE TABLE IF NOT EXISTS db_benchmark_users (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(128)  NOT NULL,
    email       VARCHAR(255)  NOT NULL,
    status      VARCHAR(32)   NOT NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
"""

CREATE_RESEARCH_ORDERS_TABLE = """
CREATE TABLE IF NOT EXISTS db_benchmark_orders (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES db_benchmark_users(id) ON DELETE CASCADE,
    amount      NUMERIC(10, 2) NOT NULL,
    status      VARCHAR(32)   NOT NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
"""

# Base indexes
CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_br_env        ON benchmark_results(environment_name);",
    "CREATE INDEX IF NOT EXISTS idx_br_type       ON benchmark_results(test_type);",
    "CREATE INDEX IF NOT EXISTS idx_br_timestamp  ON benchmark_results(timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_bd_category   ON benchmark_data(category);",
]

# Name of research index on users email
INDEX_USERS_EMAIL = "idx_users_email"


def init_schema() -> None:
    """Create tables, apply migrations, and build base indexes."""
    logger.info("Initialising database schema …")
    conn = db.get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(CREATE_RESULTS_TABLE)
            # Run column additions in case benchmark_results already existed without them
            for alter_sql in ALTER_RESULTS_TABLE_COLUMNS:
                cur.execute(alter_sql)

            cur.execute(CREATE_BENCHMARK_DATA_TABLE)
            cur.execute(CREATE_RESEARCH_USERS_TABLE)
            cur.execute(CREATE_RESEARCH_ORDERS_TABLE)

            for idx_sql in CREATE_INDEXES:
                cur.execute(idx_sql)
        conn.commit()
        logger.info("Database schema and research tables ready.")
    except Exception as exc:
        conn.rollback()
        logger.error("Schema init failed: %s", exc)
        raise
    finally:
        db.release_connection(conn)


# --------------------------------------------------------------------------- #
# Research Dataset Management (10k, 100k, 1M rows)                           #
# --------------------------------------------------------------------------- #

VALID_DATASET_SIZES = (10_000, 100_000, 1_000_000)


def seed_research_dataset(dataset_size: int) -> dict[str, Any]:
    """
    Generate a realistic, deterministic dataset of *dataset_size* rows
    in db_benchmark_users and db_benchmark_orders.

    Uses PostgreSQL generate_series for maximum speed and safety.
    """
    if dataset_size not in VALID_DATASET_SIZES:
        raise ValueError(f"dataset_size must be one of {VALID_DATASET_SIZES}")

    start_time = time.perf_counter()
    conn = db.get_connection()
    try:
        with conn.cursor() as cur:
            logger.info("Clearing previous research dataset …")
            cur.execute("TRUNCATE TABLE db_benchmark_orders, db_benchmark_users RESTART IDENTITY CASCADE;")

            logger.info("Generating %d users …", dataset_size)
            users_sql = """
                INSERT INTO db_benchmark_users (name, email, status, created_at)
                SELECT 
                    'User_' || i,
                    'user_' || i || '@benchmark.cloud',
                    (ARRAY['active', 'pending', 'suspended', 'inactive'])[1 + (i % 4)],
                    NOW() - (i || ' seconds')::INTERVAL
                FROM generate_series(1, %s) AS s(i);
            """
            cur.execute(users_sql, (dataset_size,))

            logger.info("Generating %d orders …", dataset_size)
            orders_sql = """
                INSERT INTO db_benchmark_orders (user_id, amount, status, created_at)
                SELECT 
                    1 + (i % %s),
                    ROUND((10.0 + (i % 990) + (i % 100) * 0.35)::numeric, 2),
                    (ARRAY['completed', 'processing', 'cancelled', 'refunded'])[1 + (i % 4)],
                    NOW() - (i || ' seconds')::INTERVAL
                FROM generate_series(1, %s) AS s(i);
            """
            cur.execute(orders_sql, (dataset_size, dataset_size))

            cur.execute("ANALYZE db_benchmark_users;")
            cur.execute("ANALYZE db_benchmark_orders;")

        conn.commit()
        elapsed = time.perf_counter() - start_time
        logger.info(
            "Dataset seeding complete: %d users & orders in %.3f s",
            dataset_size,
            elapsed,
        )
        return {
            "status": "ok",
            "dataset_size": dataset_size,
            "users_count": dataset_size,
            "orders_count": dataset_size,
            "execution_time_seconds": round(elapsed, 4),
            "message": f"Successfully generated {dataset_size:,} users and {dataset_size:,} orders in {elapsed:.3f}s",
        }
    except Exception as exc:
        conn.rollback()
        logger.exception("Failed to seed research dataset: %s", exc)
        raise
    finally:
        db.release_connection(conn)


def get_dataset_counts() -> dict[str, int]:
    """Return actual row counts of users and orders tables."""
    try:
        users = db.execute_query("SELECT count(*)::int AS count FROM db_benchmark_users;")
        orders = db.execute_query("SELECT count(*)::int AS count FROM db_benchmark_orders;")
        return {
            "users_count": users[0]["count"] if users else 0,
            "orders_count": orders[0]["count"] if orders else 0,
        }
    except Exception:
        return {"users_count": 0, "orders_count": 0}


# --------------------------------------------------------------------------- #
# Research Index Management                                                   #
# --------------------------------------------------------------------------- #

def is_users_email_indexed() -> bool:
    """Return True if idx_users_email exists."""
    return db.index_exists(INDEX_USERS_EMAIL)


def set_users_email_index(create: bool = True) -> bool:
    """Create or drop idx_users_email."""
    if create:
        db.create_index(INDEX_USERS_EMAIL, "db_benchmark_users", "email")
    else:
        db.drop_index(INDEX_USERS_EMAIL)
    return is_users_email_indexed()


# --------------------------------------------------------------------------- #
# Legacy Seed data for backward compatibility                                  #
# --------------------------------------------------------------------------- #

SEED_ROW_COUNT = 50_000


def seed_benchmark_data() -> None:
    """Populate legacy benchmark_data with synthetic rows if empty."""
    conn = db.get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM benchmark_data;")
            count = cur.fetchone()[0]
            if count >= SEED_ROW_COUNT:
                logger.info("benchmark_data already has %d rows — skipping legacy seed.", count)
                return

            logger.info("Seeding %d rows into benchmark_data …", SEED_ROW_COUNT)
            categories = ["alpha", "beta", "gamma", "delta", "epsilon"]
            rows = [
                (
                    categories[i % len(categories)],
                    i,
                    round(i * 1.618033988749895, 4),
                    f"label_{i:06d}",
                )
                for i in range(SEED_ROW_COUNT)
            ]
            from psycopg2.extras import execute_values
            execute_values(
                cur,
                "INSERT INTO benchmark_data (category, value_int, value_float, label) VALUES %s",
                rows,
                page_size=1000,
            )
        conn.commit()
        logger.info("Legacy seed complete.")
    except Exception as exc:
        conn.rollback()
        logger.error("Legacy seed failed: %s", exc)
        raise
    finally:
        db.release_connection(conn)


# --------------------------------------------------------------------------- #
# Result persistence                                                          #
# --------------------------------------------------------------------------- #

INSERT_RESULT = """
INSERT INTO benchmark_results
    (environment_name, server_configuration, test_type, test_parameter,
     execution_time, cpu_usage, memory_usage, extra_metrics,
     experiment_type, dataset_size, execution_time_ms, average_latency_ms,
     min_latency_ms, max_latency_ms, qps, error_rate, cache_hit,
     index_state, database_configuration, explain_plan)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
RETURNING id, timestamp;
"""


def save_result(
    environment_name: str,
    server_configuration: str,
    test_type: str,
    test_parameter: str,
    execution_time: float,
    cpu_usage: float,
    memory_usage: float,
    extra_metrics: Optional[dict] = None,
    # Research specific fields
    experiment_type: Optional[str] = None,
    dataset_size: Optional[int] = None,
    execution_time_ms: Optional[float] = None,
    average_latency_ms: Optional[float] = None,
    min_latency_ms: Optional[float] = None,
    max_latency_ms: Optional[float] = None,
    qps: Optional[float] = None,
    error_rate: Optional[float] = None,
    cache_hit: Optional[bool] = None,
    index_state: Optional[str] = None,
    database_configuration: Optional[str] = None,
    explain_plan: Optional[Any] = None,
) -> dict:
    """Persist one benchmark result and return its id + timestamp."""
    extra_json = json.dumps(extra_metrics) if extra_metrics else None
    plan_json = json.dumps(explain_plan) if explain_plan else None

    # Derive execution_time_ms if not supplied
    if execution_time_ms is None and execution_time is not None:
        execution_time_ms = round(execution_time * 1000, 3)

    rows = db.execute_query(
        INSERT_RESULT,
        (
            environment_name,
            server_configuration,
            test_type,
            test_parameter,
            round(execution_time, 4),
            round(cpu_usage, 2),
            round(memory_usage, 2),
            extra_json,
            experiment_type or test_type,
            dataset_size,
            execution_time_ms,
            average_latency_ms,
            min_latency_ms,
            max_latency_ms,
            qps,
            error_rate,
            cache_hit,
            index_state,
            database_configuration or server_configuration,
            plan_json,
        ),
        fetch=True,
    )
    row = rows[0]
    return {"id": row["id"], "timestamp": row["timestamp"].isoformat()}


# --------------------------------------------------------------------------- #
# Query helpers                                                               #
# --------------------------------------------------------------------------- #

def get_results(
    test_type: Optional[str] = None,
    environment_name: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 200,
) -> list:
    """Fetch benchmark history with optional filters."""
    clauses = []
    params = []

    if test_type:
        clauses.append("(test_type = %s OR experiment_type = %s)")
        params.extend([test_type, test_type])
    if environment_name:
        clauses.append("environment_name = %s")
        params.append(environment_name)
    if date_from:
        clauses.append("timestamp >= %s")
        params.append(date_from)
    if date_to:
        clauses.append("timestamp <= %s")
        params.append(date_to)

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    params.append(limit)

    sql = f"""
        SELECT id, environment_name, server_configuration,
               test_type, test_parameter,
               execution_time, cpu_usage, memory_usage,
               extra_metrics, timestamp,
               experiment_type, dataset_size, execution_time_ms,
               average_latency_ms, min_latency_ms, max_latency_ms,
               qps, error_rate, cache_hit, index_state,
               database_configuration, explain_plan, created_at
        FROM   benchmark_results
        {where}
        ORDER  BY timestamp DESC
        LIMIT  %s
    """

    rows = db.execute_query(sql, params)
    return [dict(r) for r in rows]


def get_comparison_data() -> list:
    """Return aggregated results grouped by test_type, test_parameter, environment_name."""
    sql = """
        SELECT
            test_type,
            test_parameter,
            environment_name,
            server_configuration,
            ROUND(AVG(execution_time)::numeric, 4)  AS avg_execution_time,
            ROUND(AVG(cpu_usage)::numeric, 2)       AS avg_cpu_usage,
            ROUND(AVG(memory_usage)::numeric, 2)    AS avg_memory_usage,
            COUNT(*)                                 AS run_count
        FROM  benchmark_results
        GROUP BY test_type, test_parameter, environment_name, server_configuration
        ORDER BY test_type, test_parameter, environment_name
    """
    rows = db.execute_query(sql)
    return [dict(r) for r in rows]
