import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Read PostgreSQL configuration strictly from server-side environment variables
const databaseUrl = process.env.DATABASE_URL?.trim() || '';

// Read PG_POOL_MAX from environment, defaulting to 10 if missing or invalid
const rawPoolMax = parseInt(process.env.PG_POOL_MAX || '10', 10);
export const pgPoolMax = Number.isInteger(rawPoolMax) && rawPoolMax > 0 ? rawPoolMax : 10;

// Dedicated benchmark index name
export const BENCHMARK_INDEX_NAME = 'idx_db_benchmark_users_email';

/**
 * Mutex lock to ensure competing benchmark experiments do not run against
 * the database tables simultaneously, ensuring clean and reproducible measurements.
 */
let isBenchmarkRunning = false;

export function acquireBenchmarkLock(): boolean {
  if (isBenchmarkRunning) return false;
  isBenchmarkRunning = true;
  return true;
}

export function releaseBenchmarkLock(): void {
  isBenchmarkRunning = false;
}

/**
 * Sanitizes database errors to prevent leaking passwords or credentials in responses or logs.
 */
export function sanitizeDbError(err: any): string {
  if (!err) return 'Unknown database error';
  let message = typeof err === 'string' ? err : err.message || String(err);
  // Redact credentials in connection URI: postgresql://user:pass@host -> postgresql://user:***@host
  message = message.replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:***@');
  return message;
}

export interface DatabaseStatus {
  connected: boolean;
  error?: string | null;
  database_name?: string | null;
  version?: string | null;
  size_mb?: number | null;
  active_connections?: number | null;
  pool_max: number;
  counts?: {
    users_count: number;
    orders_count: number;
    results_count: number;
  } | null;
  benchmark_index_exists?: boolean;
}

let pool: pg.Pool | null = null;

if (databaseUrl) {
  try {
    const isNeonOrSslRequired =
      databaseUrl.includes('neon.tech') ||
      databaseUrl.includes('sslmode=require') ||
      databaseUrl.includes('ssl=true');

    const poolConfig: pg.PoolConfig = {
      connectionString: databaseUrl,
      max: pgPoolMax,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    };

    // Neon requires SSL. We strictly maintain certificate verification (rejectUnauthorized: true).
    if (isNeonOrSslRequired) {
      poolConfig.ssl = {
        rejectUnauthorized: true,
      };
    }

    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]:', sanitizeDbError(err));
    });
  } catch (err: any) {
    console.error('[PostgreSQL Pool Initialization Failed]:', sanitizeDbError(err));
    pool = null;
  }
}

export function getPool(): pg.Pool | null {
  return pool;
}

/**
 * Executes `SELECT 1` on the PostgreSQL connection pool to verify connectivity.
 * Never hardcodes or fabricates success.
 */
export async function checkDatabaseConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!pool || !databaseUrl) {
    return {
      connected: false,
      error: 'DATABASE_URL environment variable is not configured',
    };
  }

  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1;');
    return { connected: true };
  } catch (err: any) {
    return {
      connected: false,
      error: sanitizeDbError(err),
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Checks whether the dedicated benchmark index exists on db_benchmark_users.
 */
export async function checkBenchmarkIndexExists(): Promise<boolean> {
  if (!pool) return false;
  try {
    const res = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'db_benchmark_users' AND indexname = $1;",
      [BENCHMARK_INDEX_NAME]
    );
    return res.rowCount !== null && res.rowCount > 0;
  } catch {
    return false;
  }
}

/**
 * Creates the dedicated benchmark index on db_benchmark_users(email).
 */
export async function createBenchmarkIndex(): Promise<{ success: boolean; duration_ms: number }> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  const start = performance.now();
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${BENCHMARK_INDEX_NAME} ON db_benchmark_users(email);`
  );
  const duration = Math.round((performance.now() - start) * 100) / 100;
  return { success: true, duration_ms: duration };
}

/**
 * Drops the dedicated benchmark index safely.
 * Only drops the explicitly documented benchmark index; never touches primary keys or constraints.
 */
export async function dropBenchmarkIndex(): Promise<{ success: boolean; duration_ms: number }> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  const start = performance.now();
  await pool.query(`DROP INDEX IF EXISTS ${BENCHMARK_INDEX_NAME};`);
  const duration = Math.round((performance.now() - start) * 100) / 100;
  return { success: true, duration_ms: duration };
}

/**
 * Initializes database schema and migration for research benchmark tables.
 * Creates persistent tables structured for filtering, sorting, and indexing experiments.
 */
export async function initDatabaseSchema(): Promise<{ success: boolean; message: string }> {
  if (!pool || !databaseUrl) {
    return {
      success: false,
      message: 'Database not configured; skipping schema migration.',
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN;');

    // 1. db_benchmark_users table: structured for equality filtering (email), status filtering, and sorting
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_benchmark_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. db_benchmark_orders table: structured for foreign key joins, numeric range filtering, and aggregation
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_benchmark_orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES db_benchmark_users(id) ON DELETE CASCADE,
        amount NUMERIC(12, 2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. benchmark_results table: stores actual empirical performance results permanently
    await client.query(`
      CREATE TABLE IF NOT EXISTS benchmark_results (
        id SERIAL PRIMARY KEY,
        experiment_type VARCHAR(100) NOT NULL,
        dataset_size INTEGER,
        execution_time_ms DOUBLE PRECISION NOT NULL,
        average_latency_ms DOUBLE PRECISION,
        min_latency_ms DOUBLE PRECISION,
        max_latency_ms DOUBLE PRECISION,
        qps DOUBLE PRECISION,
        error_rate DOUBLE PRECISION DEFAULT 0,
        experiment_metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Base indexes supporting query and foreign key performance on results and orders
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_br_experiment_type ON benchmark_results(experiment_type);
      CREATE INDEX IF NOT EXISTS idx_br_created_at ON benchmark_results(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bo_user_id ON db_benchmark_orders(user_id);
    `);

    await client.query('COMMIT;');
    return { success: true, message: 'Database schema and tables initialized successfully.' };
  } catch (err: any) {
    await client.query('ROLLBACK;');
    throw new Error(`Schema migration failed: ${sanitizeDbError(err)}`);
  } finally {
    client.release();
  }
}

/**
 * Queries real PostgreSQL metadata and performance status.
 * Never fabricates values if the database is offline.
 */
export async function getDatabaseStatus(): Promise<DatabaseStatus> {
  const check = await checkDatabaseConnection();
  if (!check.connected || !pool) {
    return {
      connected: false,
      error: check.error || 'Database unavailable',
      database_name: null,
      version: null,
      size_mb: null,
      active_connections: null,
      pool_max: pgPoolMax,
      counts: null,
      benchmark_index_exists: false,
    };
  }

  const client = await pool.connect();
  try {
    // Current database name
    const dbNameRes = await client.query('SELECT current_database() AS db_name;');
    const database_name = dbNameRes.rows[0]?.db_name || 'unknown';

    // PostgreSQL Version
    const versionRes = await client.query('SELECT version();');
    const version = versionRes.rows[0]?.version || 'PostgreSQL';

    // Database size in MB
    const sizeRes = await client.query(`
      SELECT ROUND((pg_database_size(current_database()) / (1024.0 * 1024.0))::numeric, 2) AS size_mb;
    `);
    const size_mb = parseFloat(sizeRes.rows[0]?.size_mb) || 0;

    // Active connection count
    const connRes = await client.query(`
      SELECT count(*)::int AS active_connections 
      FROM pg_stat_activity 
      WHERE datname = current_database();
    `);
    const active_connections = connRes.rows[0]?.active_connections || 0;

    // Row counts for benchmark tables
    let users_count = 0;
    let orders_count = 0;
    let results_count = 0;

    try {
      const uRes = await client.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
      users_count = uRes.rows[0]?.count || 0;
    } catch {}

    try {
      const oRes = await client.query('SELECT count(*)::int AS count FROM db_benchmark_orders;');
      orders_count = oRes.rows[0]?.count || 0;
    } catch {}

    try {
      const rRes = await client.query('SELECT count(*)::int AS count FROM benchmark_results;');
      results_count = rRes.rows[0]?.count || 0;
    } catch {}

    const indexExists = await checkBenchmarkIndexExists();

    return {
      connected: true,
      error: null,
      database_name,
      version,
      size_mb,
      active_connections,
      pool_max: pgPoolMax,
      counts: {
        users_count,
        orders_count,
        results_count,
      },
      benchmark_index_exists: indexExists,
    };
  } catch (err: any) {
    return {
      connected: false,
      error: sanitizeDbError(err),
      database_name: null,
      version: null,
      size_mb: null,
      active_connections: null,
      pool_max: pgPoolMax,
      counts: null,
      benchmark_index_exists: false,
    };
  } finally {
    client.release();
  }
}

/**
 * Seed dataset into PostgreSQL using generate_series.
 * Validates dataset_size (10000, 100000, 1000000).
 * Prevents duplicates by cleanly resetting previous test runs in a single transaction.
 */
export async function seedResearchDataset(datasetSize: number): Promise<{
  status: string;
  dataset_size: number;
  users_inserted: number;
  orders_inserted: number;
  insertion_time_ms: number;
  message: string;
}> {
  if (![10000, 100000, 1000000].includes(datasetSize)) {
    throw new Error('dataset_size must be strictly 10000, 100000, or 1000000');
  }

  const check = await checkDatabaseConnection();
  if (!check.connected || !pool) {
    throw new Error(`Cannot seed dataset: PostgreSQL is not connected (${check.error || 'DATABASE_URL not configured'})`);
  }

  const client = await pool.connect();
  const startTime = performance.now();

  try {
    await client.query('BEGIN;');

    // Avoid duplicating full dataset on every run: clean previous benchmark dataset safely
    await client.query('TRUNCATE TABLE db_benchmark_orders, db_benchmark_users RESTART IDENTITY CASCADE;');

    // 1. Insert users using PostgreSQL generate_series with parameter binding ($1)
    const insertUsersQuery = `
      INSERT INTO db_benchmark_users (name, email, status, created_at)
      SELECT 
        'User_' || i,
        'user_' || i || '@benchmark.cloud',
        (ARRAY['active', 'pending', 'suspended', 'inactive'])[1 + (i % 4)],
        NOW() - (i || ' seconds')::INTERVAL
      FROM generate_series(1, $1) AS s(i);
    `;
    await client.query(insertUsersQuery, [datasetSize]);

    // 2. Insert orders referencing users using generate_series with parameter binding ($1)
    const insertOrdersQuery = `
      INSERT INTO db_benchmark_orders (user_id, amount, status, created_at)
      SELECT 
        1 + (i % $1),
        ROUND((10.0 + (i % 990) + (i % 100) * 0.35)::numeric, 2),
        (ARRAY['completed', 'processing', 'cancelled', 'refunded'])[1 + (i % 4)],
        NOW() - (i || ' seconds')::INTERVAL
      FROM generate_series(1, $1) AS s(i);
    `;
    await client.query(insertOrdersQuery, [datasetSize]);

    // Update PostgreSQL table statistics for the optimizer
    await client.query('ANALYZE db_benchmark_users;');
    await client.query('ANALYZE db_benchmark_orders;');

    await client.query('COMMIT;');

    const elapsedMs = Math.round((performance.now() - startTime) * 100) / 100;

    // Verify actual inserted counts from the database
    const uCountRes = await client.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
    const oCountRes = await client.query('SELECT count(*)::int AS count FROM db_benchmark_orders;');
    const usersCount = uCountRes.rows[0]?.count || 0;
    const ordersCount = oCountRes.rows[0]?.count || 0;

    return {
      status: 'ok',
      dataset_size: datasetSize,
      users_inserted: usersCount,
      orders_inserted: ordersCount,
      insertion_time_ms: elapsedMs,
      message: `Successfully seeded ${usersCount.toLocaleString()} users and ${ordersCount.toLocaleString()} orders in ${elapsedMs} ms into PostgreSQL.`,
    };
  } catch (err: any) {
    await client.query('ROLLBACK;');
    throw new Error(`Dataset seeding failed: ${sanitizeDbError(err)}`);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Real SQL Benchmark Services & Controlled Index Experiments
// ---------------------------------------------------------------------------

export type BenchmarkScenarioType =
  | 'filter_email'
  | 'by_id'
  | 'filter_sort_created'
  | 'count_status'
  | 'index_comparison';

export interface LatencyStats {
  count: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  median_ms: number;
  p95_ms: number;
  qps: number;
  success_count: number;
  failure_count: number;
  total_duration_ms: number;
}

export function calculateLatencyStats(
  latencies: number[],
  failures = 0,
  totalDurationMs: number
): LatencyStats {
  if (latencies.length === 0) {
    return {
      count: 0,
      min_ms: 0,
      max_ms: 0,
      mean_ms: 0,
      median_ms: 0,
      p95_ms: 0,
      qps: 0,
      success_count: 0,
      failure_count: failures,
      total_duration_ms: totalDurationMs,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const count = sorted.length;
  const mean = sum / count;

  // Median (P50)
  const mid = Math.floor(count / 2);
  const median = count % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // P95 percentile
  const p95Index = Math.min(count - 1, Math.floor(count * 0.95));
  const p95 = sorted[p95Index];

  const qps = totalDurationMs > 0 ? count / (totalDurationMs / 1000) : 0;

  return {
    count,
    min_ms: Math.round(sorted[0] * 100) / 100,
    max_ms: Math.round(sorted[count - 1] * 100) / 100,
    mean_ms: Math.round(mean * 100) / 100,
    median_ms: Math.round(median * 100) / 100,
    p95_ms: Math.round(p95 * 100) / 100,
    qps: Math.round(qps * 10) / 10,
    success_count: count,
    failure_count: failures,
    total_duration_ms: Math.round(totalDurationMs * 100) / 100,
  };
}

export interface ExplainPlanDiagnostic {
  plan_json: any;
  node_type: string;
  actual_total_time_ms: number;
  planning_time_ms: number;
  execution_time_ms: number;
  shared_hit_blocks: number;
  shared_read_blocks: number;
}

/**
 * Runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the target query.
 */
export async function getDiagnosticExplainPlan(
  sql: string,
  params: any[]
): Promise<ExplainPlanDiagnostic> {
  if (!pool) throw new Error('Database pool not available');
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  const res = await pool.query(explainSql, params);
  const raw = res.rows[0]['QUERY PLAN'][0];
  const rootPlan = raw.Plan;

  let nodeType = rootPlan['Node Type'] || 'Unknown';
  if (['Limit', 'Sort', 'Materialize'].includes(nodeType) && rootPlan.Plans && rootPlan.Plans.length > 0) {
    nodeType = rootPlan.Plans[0]['Node Type'] || nodeType;
  }

  return {
    plan_json: raw,
    node_type: nodeType,
    actual_total_time_ms: rootPlan['Actual Total Time'] || 0,
    planning_time_ms: raw['Planning Time'] || 0,
    execution_time_ms: raw['Execution Time'] || 0,
    shared_hit_blocks: rootPlan['Shared Hit Blocks'] || 0,
    shared_read_blocks: rootPlan['Shared Read Blocks'] || 0,
  };
}

/**
 * Persists an experiment run into the PostgreSQL benchmark_results table.
 */
export async function persistBenchmarkResult(entry: {
  experiment_type: string;
  dataset_size: number;
  execution_time_ms: number;
  average_latency_ms: number;
  min_latency_ms: number;
  max_latency_ms: number;
  qps: number;
  error_rate: number;
  experiment_metadata: Record<string, any>;
}): Promise<{ id: number; created_at: string }> {
  if (!pool) throw new Error('Database pool not available');
  const sql = `
    INSERT INTO benchmark_results (
      experiment_type,
      dataset_size,
      execution_time_ms,
      average_latency_ms,
      min_latency_ms,
      max_latency_ms,
      qps,
      error_rate,
      experiment_metadata,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING id, created_at;
  `;
  const res = await pool.query(sql, [
    entry.experiment_type,
    entry.dataset_size,
    entry.execution_time_ms,
    entry.average_latency_ms,
    entry.min_latency_ms,
    entry.max_latency_ms,
    entry.qps,
    entry.error_rate,
    JSON.stringify(entry.experiment_metadata),
  ]);
  return {
    id: res.rows[0].id,
    created_at: res.rows[0].created_at.toISOString(),
  };
}

/**
 * Fetches real persisted benchmark history from benchmark_results table.
 */
export async function getPersistedBenchmarkResults(limit = 100): Promise<any[]> {
  if (!pool) return [];
  const sql = `
    SELECT
      id,
      experiment_type AS test_type,
      COALESCE(experiment_metadata->>'scenario', experiment_type) AS test_parameter,
      (execution_time_ms / 1000.0) AS execution_time,
      average_latency_ms,
      min_latency_ms,
      max_latency_ms,
      qps,
      COALESCE((experiment_metadata->>'cpu_percent')::float, 0) AS cpu_usage,
      COALESCE((experiment_metadata->>'ram_percent')::float, 0) AS memory_usage,
      COALESCE(experiment_metadata->>'environment', 'Local') AS environment_name,
      experiment_metadata AS extra_metrics,
      created_at AS timestamp
    FROM benchmark_results
    ORDER BY created_at DESC
    LIMIT $1;
  `;
  const res = await pool.query(sql, [limit]);
  return res.rows.map((r) => ({
    ...r,
    execution_time: Number(r.execution_time),
    average_latency_ms: Number(r.average_latency_ms),
    cpu_usage: Number(r.cpu_usage),
    memory_usage: Number(r.memory_usage),
    timestamp: r.timestamp.toISOString(),
  }));
}

/**
 * Runs a single SQL scenario benchmark with warm-up queries and measured repetitions.
 */
export async function runRealSqlBenchmark(
  scenario: BenchmarkScenarioType,
  repetitions = 30
): Promise<{
  scenario: string;
  query_sql: string;
  sample_params: any[];
  dataset_size: number;
  stats: LatencyStats;
  warmup_runs: number;
  explain_diagnostic: ExplainPlanDiagnostic;
  persisted_id: number;
  timestamp: string;
  methodology_notes: string;
}> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  if (repetitions < 1 || repetitions > 1000) {
    throw new Error('Repetitions must be between 1 and 1000');
  }

  if (!acquireBenchmarkLock()) {
    throw new Error('Another database benchmark is currently in progress. Please wait for it to complete.');
  }

  try {
    // 1. Get current dataset size
    const countRes = await pool.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
    const datasetSize = countRes.rows[0]?.count || 0;
    if (datasetSize === 0) {
      throw new Error('db_benchmark_users table is empty. Please seed the dataset first.');
    }

    // 2. Select scenario SQL and parameter generator
    let querySql = '';
    let getParams: (iter: number) => any[];

    switch (scenario) {
      case 'by_id':
        querySql = 'SELECT id, name, email, status, created_at FROM db_benchmark_users WHERE id = $1;';
        getParams = (i) => [1 + ((i * 37) % datasetSize)];
        break;

      case 'filter_sort_created':
        querySql = `
          SELECT id, name, email, status, created_at 
          FROM db_benchmark_users 
          WHERE status = $1 
          ORDER BY created_at DESC 
          LIMIT 50;
        `;
        getParams = (i) => [['active', 'pending', 'suspended', 'inactive'][i % 4]];
        break;

      case 'count_status':
        querySql = 'SELECT count(*)::int AS count FROM db_benchmark_users WHERE status = $1;';
        getParams = (i) => [['active', 'pending', 'suspended', 'inactive'][i % 4]];
        break;

      case 'filter_email':
      default:
        querySql = `
          SELECT id, name, email, status, created_at 
          FROM db_benchmark_users 
          WHERE email = $1 
          LIMIT 50;
        `;
        getParams = (i) => [`user_${1 + ((i * 37) % datasetSize)}@benchmark.cloud`];
        break;
    }

    // 3. Warm-up queries (unmeasured, populates PostgreSQL buffer cache and prepares execution path)
    const warmupCount = 3;
    for (let w = 0; w < warmupCount; w++) {
      await pool.query(querySql, getParams(w));
    }

    // 4. Measured repetitions
    const latencies: number[] = [];
    let failures = 0;
    const benchmarkStart = performance.now();

    for (let i = 0; i < repetitions; i++) {
      const params = getParams(i);
      const callStart = performance.now();
      try {
        await pool.query(querySql, params);
        const callDuration = performance.now() - callStart;
        latencies.push(callDuration);
      } catch (err) {
        failures++;
      }
    }

    const totalDuration = performance.now() - benchmarkStart;
    const stats = calculateLatencyStats(latencies, failures, totalDuration);

    // 5. Diagnostic EXPLAIN (ANALYZE, BUFFERS)
    const sampleParams = getParams(0);
    const explainDiagnostic = await getDiagnosticExplainPlan(querySql, sampleParams);

    const methodologyNotes =
      'Client round-trip latencies measured in Node.js using performance.now() over TLS/SSL pooled connections with 3 unmeasured warm-up queries. Database server execution time and buffer stats captured via EXPLAIN (ANALYZE, BUFFERS). Buffer cache was kept warm across runs.';

    // 6. Persist result
    const persisted = await persistBenchmarkResult({
      experiment_type: 'sql_scenario',
      dataset_size: datasetSize,
      execution_time_ms: stats.total_duration_ms,
      average_latency_ms: stats.mean_ms,
      min_latency_ms: stats.min_ms,
      max_latency_ms: stats.max_ms,
      qps: stats.qps,
      error_rate: failures / repetitions,
      experiment_metadata: {
        scenario,
        query_sql: querySql,
        sample_params: sampleParams,
        repetitions,
        warmup_runs: warmupCount,
        median_latency_ms: stats.median_ms,
        p95_latency_ms: stats.p95_ms,
        success_count: stats.success_count,
        failure_count: stats.failure_count,
        explain_node_type: explainDiagnostic.node_type,
        server_execution_time_ms: explainDiagnostic.execution_time_ms,
        server_planning_time_ms: explainDiagnostic.planning_time_ms,
        shared_hit_blocks: explainDiagnostic.shared_hit_blocks,
        shared_read_blocks: explainDiagnostic.shared_read_blocks,
        methodology_notes: methodologyNotes,
      },
    });

    return {
      scenario,
      query_sql: querySql,
      sample_params: sampleParams,
      dataset_size: datasetSize,
      stats,
      warmup_runs: warmupCount,
      explain_diagnostic: explainDiagnostic,
      persisted_id: persisted.id,
      timestamp: persisted.created_at,
      methodology_notes: methodologyNotes,
    };
  } finally {
    releaseBenchmarkLock();
  }
}

export interface ControlledIndexComparisonResult {
  experiment_name: string;
  dataset_size: number;
  query_sql: string;
  sample_params: any[];
  repetitions: number;
  warmup_runs: number;
  configuration_a_unindexed: {
    index_name: string | null;
    stats: LatencyStats;
    explain: ExplainPlanDiagnostic;
    persisted_id: number;
  };
  configuration_b_indexed: {
    index_name: string;
    index_creation_duration_ms: number;
    stats: LatencyStats;
    explain: ExplainPlanDiagnostic;
    persisted_id: number;
  };
  comparison: {
    speedup_multiplier: number;
    latency_reduction_pct: number;
    server_time_speedup: number;
    summary: string;
  };
  timestamp: string;
  methodology_notes: string;
}

/**
 * Runs the controlled experiment:
 * Configuration A: Without idx_db_benchmark_users_email (Sequential Scan)
 * Configuration B: With idx_db_benchmark_users_email (Index Scan / Bitmap Index Scan)
 *
 * Uses the exact same dataset, query parameters, repetitions, and warm-up methodology.
 */
export async function runControlledIndexExperiment(
  repetitions = 30
): Promise<ControlledIndexComparisonResult> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  if (repetitions < 5 || repetitions > 500) {
    throw new Error('Repetitions must be between 5 and 500');
  }

  if (!acquireBenchmarkLock()) {
    throw new Error('Another database benchmark is currently in progress. Please wait for it to complete.');
  }

  try {
    const countRes = await pool.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
    const datasetSize = countRes.rows[0]?.count || 0;
    if (datasetSize === 0) {
      throw new Error('db_benchmark_users table is empty. Please seed the dataset first.');
    }

    const querySql = `
      SELECT id, name, email, status, created_at 
      FROM db_benchmark_users 
      WHERE email = $1 
      LIMIT 50;
    `;
    const getParams = (i: number) => [`user_${1 + ((i * 37) % datasetSize)}@benchmark.cloud`];
    const warmupCount = 3;

    // ----------------------------------------------------
    // Configuration A: Without Benchmark Index
    // ----------------------------------------------------
    await dropBenchmarkIndex();
    await pool.query('ANALYZE db_benchmark_users;');

    // Warm-up unindexed
    for (let w = 0; w < warmupCount; w++) {
      await pool.query(querySql, getParams(w));
    }

    const unindexedLatencies: number[] = [];
    let unindexedFailures = 0;
    const startA = performance.now();

    for (let i = 0; i < repetitions; i++) {
      const callStart = performance.now();
      try {
        await pool.query(querySql, getParams(i));
        unindexedLatencies.push(performance.now() - callStart);
      } catch {
        unindexedFailures++;
      }
    }
    const durationA = performance.now() - startA;
    const statsA = calculateLatencyStats(unindexedLatencies, unindexedFailures, durationA);
    const explainA = await getDiagnosticExplainPlan(querySql, getParams(0));

    // Persist Configuration A
    const persistedA = await persistBenchmarkResult({
      experiment_type: 'index_comparison_unindexed',
      dataset_size: datasetSize,
      execution_time_ms: statsA.total_duration_ms,
      average_latency_ms: statsA.mean_ms,
      min_latency_ms: statsA.min_ms,
      max_latency_ms: statsA.max_ms,
      qps: statsA.qps,
      error_rate: unindexedFailures / repetitions,
      experiment_metadata: {
        scenario: 'index_comparison',
        configuration: 'A_unindexed',
        index_name: null,
        query_sql: querySql,
        repetitions,
        warmup_runs: warmupCount,
        median_latency_ms: statsA.median_ms,
        p95_latency_ms: statsA.p95_ms,
        explain_node_type: explainA.node_type,
        server_execution_time_ms: explainA.execution_time_ms,
        server_planning_time_ms: explainA.planning_time_ms,
      },
    });

    // ----------------------------------------------------
    // Configuration B: With Benchmark Index
    // ----------------------------------------------------
    const createIndexRes = await createBenchmarkIndex();
    await pool.query('ANALYZE db_benchmark_users;');

    // Warm-up indexed
    for (let w = 0; w < warmupCount; w++) {
      await pool.query(querySql, getParams(w));
    }

    const indexedLatencies: number[] = [];
    let indexedFailures = 0;
    const startB = performance.now();

    for (let i = 0; i < repetitions; i++) {
      const callStart = performance.now();
      try {
        await pool.query(querySql, getParams(i));
        indexedLatencies.push(performance.now() - callStart);
      } catch {
        indexedFailures++;
      }
    }
    const durationB = performance.now() - startB;
    const statsB = calculateLatencyStats(indexedLatencies, indexedFailures, durationB);
    const explainB = await getDiagnosticExplainPlan(querySql, getParams(0));

    // Persist Configuration B
    const persistedB = await persistBenchmarkResult({
      experiment_type: 'index_comparison_indexed',
      dataset_size: datasetSize,
      execution_time_ms: statsB.total_duration_ms,
      average_latency_ms: statsB.mean_ms,
      min_latency_ms: statsB.min_ms,
      max_latency_ms: statsB.max_ms,
      qps: statsB.qps,
      error_rate: indexedFailures / repetitions,
      experiment_metadata: {
        scenario: 'index_comparison',
        configuration: 'B_indexed',
        index_name: BENCHMARK_INDEX_NAME,
        index_creation_duration_ms: createIndexRes.duration_ms,
        query_sql: querySql,
        repetitions,
        warmup_runs: warmupCount,
        median_latency_ms: statsB.median_ms,
        p95_latency_ms: statsB.p95_ms,
        explain_node_type: explainB.node_type,
        server_execution_time_ms: explainB.execution_time_ms,
        server_planning_time_ms: explainB.planning_time_ms,
      },
    });

    // Calculate delta and speedup
    const speedupMultiplier =
      statsB.mean_ms > 0 ? Math.round((statsA.mean_ms / statsB.mean_ms) * 100) / 100 : 1;
    const latencyReductionPct =
      statsA.mean_ms > 0
        ? Math.round(((statsA.mean_ms - statsB.mean_ms) / statsA.mean_ms) * 1000) / 10
        : 0;
    const serverTimeSpeedup =
      explainB.execution_time_ms > 0
        ? Math.round((explainA.execution_time_ms / explainB.execution_time_ms) * 100) / 100
        : 1;

    const methodologyNotes =
      'Controlled experiment comparing identical queries with and without idx_db_benchmark_users_email. Node.js measured client round-trip latencies with 3 warm-up runs. PostgreSQL server execution time and buffer blocks retrieved from EXPLAIN (ANALYZE, BUFFERS). Buffer cache state was kept warm.';

    return {
      experiment_name: 'Index Optimization Controlled Experiment (email filtering)',
      dataset_size: datasetSize,
      query_sql: querySql,
      sample_params: getParams(0),
      repetitions,
      warmup_runs: warmupCount,
      configuration_a_unindexed: {
        index_name: null,
        stats: statsA,
        explain: explainA,
        persisted_id: persistedA.id,
      },
      configuration_b_indexed: {
        index_name: BENCHMARK_INDEX_NAME,
        index_creation_duration_ms: createIndexRes.duration_ms,
        stats: statsB,
        explain: explainB,
        persisted_id: persistedB.id,
      },
      comparison: {
        speedup_multiplier: speedupMultiplier,
        latency_reduction_pct: latencyReductionPct,
        server_time_speedup: serverTimeSpeedup,
        summary: `Index ${BENCHMARK_INDEX_NAME} changed query plan from [${explainA.node_type}] to [${explainB.node_type}], resulting in a ${speedupMultiplier}x speedup in client latency and ${serverTimeSpeedup}x in PostgreSQL server execution time.`,
      },
      timestamp: new Date().toISOString(),
      methodology_notes: methodologyNotes,
    };
  } finally {
    releaseBenchmarkLock();
  }
}
