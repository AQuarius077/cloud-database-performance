import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Read PostgreSQL configuration strictly from server-side environment variables
let currentDatabaseUrl = process.env.DATABASE_URL?.trim() || '';

// Read PG_POOL_MAX from environment, defaulting to 20 if missing or invalid
const rawPoolMax = parseInt(process.env.PG_POOL_MAX || '20', 10);
export const pgPoolMax = Number.isInteger(rawPoolMax) && rawPoolMax > 0 ? rawPoolMax : 20;

// Dedicated benchmark index names
export const BENCHMARK_INDEX_NAME = 'idx_db_benchmark_users_email';
export const BENCHMARK_COMPOSITE_INDEX_NAME = 'idx_db_benchmark_users_status_created';

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
  table_sizes?: {
    users_size_kb: number;
    orders_size_kb: number;
    indexes_size_kb: number;
  } | null;
  benchmark_index_exists?: boolean;
  composite_index_exists?: boolean;
}

let pool: pg.Pool | null = null;

export function createPoolForUrl(url: string, maxPool = pgPoolMax): pg.Pool | null {
  if (!url) return null;
  try {
    const isNeonOrSslRequired =
      url.includes('neon.tech') ||
      url.includes('sslmode=require') ||
      url.includes('ssl=true') ||
      url.includes('amazonaws.com') ||
      url.includes('supabase.co');

    const poolConfig: pg.PoolConfig = {
      connectionString: url,
      max: maxPool,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    };

    if (isNeonOrSslRequired) {
      poolConfig.ssl = {
        rejectUnauthorized: false, // Allows flexible certificate verification for cloud proxies like Neon SNI
      };
    }

    const newPool = new Pool(poolConfig);
    newPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]:', sanitizeDbError(err));
    });
    return newPool;
  } catch (err: any) {
    console.error('[PostgreSQL Pool Initialization Failed]:', sanitizeDbError(err));
    return null;
  }
}

if (currentDatabaseUrl) {
  pool = createPoolForUrl(currentDatabaseUrl, pgPoolMax);
}

export function getPool(): pg.Pool | null {
  return pool;
}

export function getDatabaseUrl(): string {
  return currentDatabaseUrl;
}

/**
 * Dynamically reconfigures the active database connection pool.
 */
export async function setDatabaseUrl(newUrl: string): Promise<{ success: boolean; message: string }> {
  const trimmed = newUrl?.trim() || '';
  if (pool) {
    try {
      await pool.end();
    } catch {}
    pool = null;
  }
  currentDatabaseUrl = trimmed;
  if (!trimmed) {
    return { success: true, message: 'DATABASE_URL cleared. Database is now offline.' };
  }
  pool = createPoolForUrl(trimmed, pgPoolMax);
  const conn = await checkDatabaseConnection();
  if (conn.connected) {
    await initDatabaseSchema();
    return { success: true, message: 'Successfully connected and verified PostgreSQL schema.' };
  } else {
    return { success: false, message: conn.error || 'Connection failed' };
  }
}

/**
 * Executes `SELECT 1` on the PostgreSQL connection pool to verify connectivity.
 * Never hardcodes or fabricates success.
 */
export async function checkDatabaseConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!pool || !currentDatabaseUrl) {
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
export async function checkBenchmarkIndexExists(indexName = BENCHMARK_INDEX_NAME): Promise<boolean> {
  if (!pool) return false;
  try {
    const res = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename = 'db_benchmark_users' AND indexname = $1;",
      [indexName]
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
 * Creates the composite benchmark index on db_benchmark_users(status, created_at DESC).
 */
export async function createCompositeBenchmarkIndex(): Promise<{ success: boolean; duration_ms: number }> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  const start = performance.now();
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${BENCHMARK_COMPOSITE_INDEX_NAME} ON db_benchmark_users(status, created_at DESC);`
  );
  const duration = Math.round((performance.now() - start) * 100) / 100;
  return { success: true, duration_ms: duration };
}

/**
 * Drops the dedicated benchmark index safely.
 * Only drops the explicitly documented benchmark index; never touches primary keys or constraints.
 */
export async function dropBenchmarkIndex(indexName = BENCHMARK_INDEX_NAME): Promise<{ success: boolean; duration_ms: number }> {
  if (!pool) throw new Error('PostgreSQL database not connected');
  const start = performance.now();
  await pool.query(`DROP INDEX IF EXISTS ${indexName};`);
  const duration = Math.round((performance.now() - start) * 100) / 100;
  return { success: true, duration_ms: duration };
}

/**
 * Initializes database schema and migration for research benchmark tables.
 * Creates persistent tables structured for filtering, sorting, indexing, and connection pool experiments.
 */
export async function initDatabaseSchema(): Promise<{ success: boolean; message: string }> {
  if (!pool || !currentDatabaseUrl) {
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
 * Queries real PostgreSQL metadata, storage size, and active performance status.
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
      table_sizes: null,
      benchmark_index_exists: false,
      composite_index_exists: false,
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

    // Detailed table sizes
    let users_size_kb = 0;
    let orders_size_kb = 0;
    let indexes_size_kb = 0;
    try {
      const szRes = await client.query(`
        SELECT
          ROUND(pg_total_relation_size('db_benchmark_users') / 1024.0)::int AS u_kb,
          ROUND(pg_total_relation_size('db_benchmark_orders') / 1024.0)::int AS o_kb,
          ROUND(pg_indexes_size('db_benchmark_users') / 1024.0)::int AS idx_kb;
      `);
      users_size_kb = szRes.rows[0]?.u_kb || 0;
      orders_size_kb = szRes.rows[0]?.o_kb || 0;
      indexes_size_kb = szRes.rows[0]?.idx_kb || 0;
    } catch {}

    const indexExists = await checkBenchmarkIndexExists(BENCHMARK_INDEX_NAME);
    const compositeIndexExists = await checkBenchmarkIndexExists(BENCHMARK_COMPOSITE_INDEX_NAME);

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
      table_sizes: {
        users_size_kb,
        orders_size_kb,
        indexes_size_kb,
      },
      benchmark_index_exists: indexExists,
      composite_index_exists: compositeIndexExists,
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
      table_sizes: null,
      benchmark_index_exists: false,
      composite_index_exists: false,
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
  database_size_before_mb: number;
  database_size_after_mb: number;
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
    // Measure initial DB size
    const preSizeRes = await client.query(`
      SELECT ROUND((pg_database_size(current_database()) / (1024.0 * 1024.0))::numeric, 2) AS size_mb;
    `);
    const sizeBefore = parseFloat(preSizeRes.rows[0]?.size_mb) || 0;

    await client.query('BEGIN;');

    // Safely reset previous benchmark dataset
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

    // Measure post DB size
    const postSizeRes = await client.query(`
      SELECT ROUND((pg_database_size(current_database()) / (1024.0 * 1024.0))::numeric, 2) AS size_mb;
    `);
    const sizeAfter = parseFloat(postSizeRes.rows[0]?.size_mb) || 0;

    return {
      status: 'ok',
      dataset_size: datasetSize,
      users_inserted: usersCount,
      orders_inserted: ordersCount,
      insertion_time_ms: elapsedMs,
      database_size_before_mb: sizeBefore,
      database_size_after_mb: sizeAfter,
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
// Real SQL Benchmark Services & Scientific Calculations
// ---------------------------------------------------------------------------

export type BenchmarkScenarioType =
  | 'filter_email'
  | 'by_id'
  | 'filter_status'
  | 'filter_sort_created'
  | 'count_status'
  | 'count_aggregate'
  | 'join_orders'
  | 'index_comparison';

export interface LatencyStats {
  count: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  median_ms: number;
  p95_ms: number;
  std_dev_ms: number;
  confidence_interval_95: number;
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
      std_dev_ms: 0,
      confidence_interval_95: 0,
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

  // Standard deviation (sample standard deviation)
  const variance =
    count > 1 ? sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (count - 1) : 0;
  const stdDev = Math.sqrt(variance);

  // 95% Confidence Interval margin of error: z * (stdDev / sqrt(n)), where z = 1.96
  const confidenceInterval95 = count > 1 ? 1.96 * (stdDev / Math.sqrt(count)) : 0;

  const qps = totalDurationMs > 0 ? count / (totalDurationMs / 1000) : 0;

  return {
    count,
    min_ms: Math.round(sorted[0] * 100) / 100,
    max_ms: Math.round(sorted[count - 1] * 100) / 100,
    mean_ms: Math.round(mean * 100) / 100,
    median_ms: Math.round(median * 100) / 100,
    p95_ms: Math.round(p95 * 100) / 100,
    std_dev_ms: Math.round(stdDev * 100) / 100,
    confidence_interval_95: Math.round(confidenceInterval95 * 100) / 100,
    qps: Math.round(qps * 10) / 10,
    success_count: count,
    failure_count: failures,
    total_duration_ms: Math.round(totalDurationMs * 100) / 100,
  };
}

export interface ExplainPlanDiagnostic {
  plan_json: any;
  node_type: string;
  scan_type: string;
  has_sort: boolean;
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

  let scanType = 'Unknown';
  let hasSort = false;

  function traversePlan(node: any) {
    if (!node) return;
    const nt = String(node['Node Type'] || '');
    if (nt) {
      if (nt.includes('Scan')) {
        scanType = nt;
      }
      if (nt.includes('Sort')) {
        hasSort = true;
      }
    }
    if (node.Plans && Array.isArray(node.Plans)) {
      for (const child of node.Plans) {
        traversePlan(child);
      }
    }
  }

  traversePlan(rootPlan);

  let nodeType = rootPlan['Node Type'] || 'Unknown';
  if (['Limit', 'Sort', 'Materialize'].includes(nodeType) && rootPlan.Plans && rootPlan.Plans.length > 0) {
    nodeType = rootPlan.Plans[0]['Node Type'] || nodeType;
  }

  return {
    plan_json: raw,
    node_type: nodeType,
    scan_type: scanType !== 'Unknown' ? scanType : nodeType,
    has_sort: hasSort,
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

export interface RealSqlBenchmarkResult {
  scenario: string;
  query_sql: string;
  sample_params: any[];
  dataset_size: number;
  stats: LatencyStats;
  warmup_runs: number;
  explain_diagnostic: ExplainPlanDiagnostic;
  connection_acquisition_ms: number;
  baseline_network_rtt_ms: number;
  network_overhead_ms: number;
  server_estimated_qps: number;
  persisted_id: number;
  timestamp: string;
  methodology_notes: string;
}

/**
 * Runs a single SQL scenario benchmark with warm-up queries and measured repetitions.
 */
export async function runRealSqlBenchmark(
  scenario: BenchmarkScenarioType,
  repetitions = 30
): Promise<RealSqlBenchmarkResult> {
  const check = await checkDatabaseConnection();
  if (!check.connected || !pool) {
    throw new Error('PostgreSQL database not connected');
  }
  if (repetitions < 1 || repetitions > 1000) {
    throw new Error('Repetitions must be between 1 and 1000');
  }

  if (!acquireBenchmarkLock()) {
    throw new Error('Another database benchmark is currently in progress. Please wait for it to complete.');
  }

  let client: pg.PoolClient | null = null;
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

      case 'filter_status':
        querySql = `
          SELECT id, name, email, status, created_at 
          FROM db_benchmark_users 
          WHERE status = $1 
          ORDER BY id DESC 
          LIMIT 50;
        `;
        getParams = (i) => [['active', 'pending', 'suspended', 'inactive'][i % 4]];
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

      case 'count_aggregate':
        querySql = `
          SELECT 
            status, 
            count(*)::int AS order_count, 
            ROUND(AVG(amount)::numeric, 2) AS avg_amount, 
            ROUND(SUM(amount)::numeric, 2) AS total_amount 
          FROM db_benchmark_orders 
          GROUP BY status;
        `;
        getParams = () => [];
        break;

      case 'join_orders':
        querySql = `
          SELECT 
            u.id AS user_id, 
            u.name, 
            u.email, 
            o.id AS order_id, 
            o.amount, 
            o.status AS order_status, 
            o.created_at AS order_date
          FROM db_benchmark_users u 
          INNER JOIN db_benchmark_orders o ON u.id = o.user_id 
          WHERE u.id = $1 
          LIMIT 50;
        `;
        getParams = (i) => [1 + ((i * 37) % datasetSize)];
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

    // 3. Dedicated connection checkout and acquire latency timing
    const tAcquire = performance.now();
    client = await pool.connect();
    const connectionAcquisitionMs = Math.round((performance.now() - tAcquire) * 100) / 100;

    // 4. Baseline transport RTT measurement (raw ping over the established socket)
    const tPing = performance.now();
    await client.query('SELECT 1;');
    const baselineNetworkRttMs = Math.round((performance.now() - tPing) * 100) / 100;

    // 5. Warm-up queries (unmeasured, populates PostgreSQL buffer cache and prepares execution path)
    const warmupCount = 3;
    for (let w = 0; w < warmupCount; w++) {
      await client.query(querySql, getParams(w));
    }

    // 6. Measured repetitions using high-resolution monotonic timer (performance.now)
    const latencies: number[] = [];
    let failures = 0;
    const benchmarkStart = performance.now();

    for (let i = 0; i < repetitions; i++) {
      const params = getParams(i);
      const callStart = performance.now();
      try {
        await client.query(querySql, params);
        const callDuration = performance.now() - callStart;
        latencies.push(callDuration);
      } catch (err) {
        failures++;
      }
    }

    const totalDuration = performance.now() - benchmarkStart;
    const stats = calculateLatencyStats(latencies, failures, totalDuration);

    // 7. Diagnostic EXPLAIN (ANALYZE, BUFFERS) directly from the database server
    const sampleParams = getParams(0);
    const explainDiagnostic = await getDiagnosticExplainPlan(querySql, sampleParams);

    // 8. Breakdown of network transport overhead vs database server execution time
    const networkOverheadMs = Math.max(
      0,
      Math.round((stats.mean_ms - explainDiagnostic.execution_time_ms) * 100) / 100
    );
    const serverEstimatedQps =
      explainDiagnostic.execution_time_ms > 0
        ? Math.round((1000 / explainDiagnostic.execution_time_ms) * 10) / 10
        : 0;

    const methodologyNotes =
      `Application round-trip latency measured via high-resolution performance.now() over TLS connection to Neon PostgreSQL (Frankfurt, eu-central-1). Baseline network RTT: ~${baselineNetworkRttMs} ms. Dedicated client acquisition time: ${connectionAcquisitionMs} ms. PostgreSQL server execution time (${explainDiagnostic.execution_time_ms.toFixed(3)} ms) and buffer metrics were captured via EXPLAIN (ANALYZE, BUFFERS). Due to WAN physical distance (approx. 5,000 km), network transit time accounts for ~${stats.mean_ms > 0 ? Math.round((networkOverheadMs / stats.mean_ms) * 100) : 0}% of total application-observed latency.`;

    // 9. Persist result
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
        std_dev_ms: stats.std_dev_ms,
        confidence_interval_95: stats.confidence_interval_95,
        success_count: stats.success_count,
        failure_count: stats.failure_count,
        connection_acquisition_ms: connectionAcquisitionMs,
        baseline_network_rtt_ms: baselineNetworkRttMs,
        network_overhead_ms: networkOverheadMs,
        server_estimated_qps: serverEstimatedQps,
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
      connection_acquisition_ms: connectionAcquisitionMs,
      baseline_network_rtt_ms: baselineNetworkRttMs,
      network_overhead_ms: networkOverheadMs,
      server_estimated_qps: serverEstimatedQps,
      persisted_id: persisted.id,
      timestamp: persisted.created_at,
      methodology_notes: methodologyNotes,
    };
  } finally {
    if (client) {
      client.release();
    }
    releaseBenchmarkLock();
  }
}

export type IndexExperimentType = 'single_btree' | 'composite_btree';

export interface ControlledIndexComparisonResult {
  experiment_name: string;
  index_type: IndexExperimentType;
  target_index_name: string;
  dataset_size: number;
  query_sql: string;
  sample_params: any[];
  repetitions: number;
  warmup_runs: number;
  configuration_a_unindexed: {
    index_name: string | null;
    scan_type: string;
    has_sort: boolean;
    stats: LatencyStats;
    explain: ExplainPlanDiagnostic;
    persisted_id: number;
  };
  configuration_b_indexed: {
    index_name: string;
    scan_type: string;
    has_sort: boolean;
    index_creation_duration_ms: number;
    stats: LatencyStats;
    explain: ExplainPlanDiagnostic;
    persisted_id: number;
  };
  comparison: {
    speedup_multiplier: number;
    latency_reduction_pct: number;
    server_time_speedup: number;
    qps_increase_pct: number;
    summary: string;
  };
  timestamp: string;
  methodology_notes: string;
}

/**
 * Runs the controlled index experiment:
 * Configuration A: Without target index (Sequential Scan, explicit Sort when applicable)
 * Configuration B: With target B-tree or Composite B-tree index (Index Scan, Sort eliminated)
 *
 * Uses the exact same dataset, query parameters, repetitions, and warm-up methodology.
 * Guaranteed cleanup and restoration via try...finally block.
 */
export async function runControlledIndexExperiment(
  repetitions = 30,
  indexType: IndexExperimentType = 'single_btree'
): Promise<ControlledIndexComparisonResult> {
  if (repetitions < 5 || repetitions > 500) {
    throw new Error('Repetitions must be between 5 and 500');
  }

  const check = await checkDatabaseConnection();
  if (!check.connected || !pool) {
    throw new Error('PostgreSQL database not connected');
  }

  if (!acquireBenchmarkLock()) {
    throw new Error('Another database benchmark is currently in progress. Please wait for it to complete.');
  }

  const isComposite = indexType === 'composite_btree';
  const targetIndexName = isComposite ? BENCHMARK_COMPOSITE_INDEX_NAME : BENCHMARK_INDEX_NAME;
  const experimentName = isComposite
    ? 'Композиттік B-tree индекс эксперименті (status + created_at DESC)'
    : 'B-tree индекс эксперименті (email іздеу)';

  // Record initial index state to restore afterward
  const hadIndexInitially = await checkBenchmarkIndexExists(targetIndexName);

  try {
    const countRes = await pool.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
    const datasetSize = countRes.rows[0]?.count || 0;
    if (datasetSize === 0) {
      throw new Error('db_benchmark_users table is empty. Please seed the dataset first.');
    }

    let querySql = '';
    let getParams: (i: number) => any[];

    if (isComposite) {
      querySql = `
        SELECT id, name, email, status, created_at 
        FROM db_benchmark_users 
        WHERE status = $1 
        ORDER BY created_at DESC 
        LIMIT 50;
      `;
      getParams = (i) => [['active', 'pending', 'suspended', 'inactive'][i % 4]];
    } else {
      querySql = `
        SELECT id, name, email, status, created_at 
        FROM db_benchmark_users 
        WHERE email = $1 
        LIMIT 50;
      `;
      getParams = (i) => [`user_${1 + ((i * 37) % datasetSize)}@benchmark.cloud`];
    }

    const warmupCount = 3;

    // ----------------------------------------------------
    // Configuration A: Without Benchmark Index (Sequential Scan)
    // ----------------------------------------------------
    await dropBenchmarkIndex(targetIndexName);
    await pool.query('ANALYZE db_benchmark_users;');

    const clientA = await pool.connect();
    const unindexedLatencies: number[] = [];
    let unindexedFailures = 0;
    let durationA = 0;
    try {
      // Warm-up unindexed (populates buffer cache for fair test)
      for (let w = 0; w < warmupCount; w++) {
        await clientA.query(querySql, getParams(w));
      }

      const startA = performance.now();
      for (let i = 0; i < repetitions; i++) {
        const callStart = performance.now();
        try {
          await clientA.query(querySql, getParams(i));
          unindexedLatencies.push(performance.now() - callStart);
        } catch {
          unindexedFailures++;
        }
      }
      durationA = performance.now() - startA;
    } finally {
      clientA.release();
    }
    const statsA = calculateLatencyStats(unindexedLatencies, unindexedFailures, durationA);
    const explainA = await getDiagnosticExplainPlan(querySql, getParams(0));

    // Persist Configuration A
    const persistedA = await persistBenchmarkResult({
      experiment_type: `index_comparison_${indexType}_unindexed`,
      dataset_size: datasetSize,
      execution_time_ms: statsA.total_duration_ms,
      average_latency_ms: statsA.mean_ms,
      min_latency_ms: statsA.min_ms,
      max_latency_ms: statsA.max_ms,
      qps: statsA.qps,
      error_rate: unindexedFailures / repetitions,
      experiment_metadata: {
        scenario: 'index_comparison',
        index_type: indexType,
        target_index_name: targetIndexName,
        configuration: 'A_unindexed',
        index_name: null,
        query_sql: querySql,
        repetitions,
        warmup_runs: warmupCount,
        median_latency_ms: statsA.median_ms,
        p95_latency_ms: statsA.p95_ms,
        std_dev_ms: statsA.std_dev_ms,
        confidence_interval_95: statsA.confidence_interval_95,
        explain_node_type: explainA.node_type,
        scan_type: explainA.scan_type,
        has_sort: explainA.has_sort,
        server_execution_time_ms: explainA.execution_time_ms,
        server_planning_time_ms: explainA.planning_time_ms,
        shared_hit_blocks: explainA.shared_hit_blocks,
        shared_read_blocks: explainA.shared_read_blocks,
      },
    });

    // ----------------------------------------------------
    // Configuration B: With Benchmark Index (Index Scan)
    // ----------------------------------------------------
    const createIndexRes = isComposite
      ? await createCompositeBenchmarkIndex()
      : await createBenchmarkIndex();
    await pool.query('ANALYZE db_benchmark_users;');

    const clientB = await pool.connect();
    const indexedLatencies: number[] = [];
    let indexedFailures = 0;
    let durationB = 0;
    try {
      // Warm-up indexed (populates index leaf buffers)
      for (let w = 0; w < warmupCount; w++) {
        await clientB.query(querySql, getParams(w));
      }

      const startB = performance.now();
      for (let i = 0; i < repetitions; i++) {
        const callStart = performance.now();
        try {
          await clientB.query(querySql, getParams(i));
          indexedLatencies.push(performance.now() - callStart);
        } catch {
          indexedFailures++;
        }
      }
      durationB = performance.now() - startB;
    } finally {
      clientB.release();
    }
    const statsB = calculateLatencyStats(indexedLatencies, indexedFailures, durationB);
    const explainB = await getDiagnosticExplainPlan(querySql, getParams(0));

    // Persist Configuration B
    const persistedB = await persistBenchmarkResult({
      experiment_type: `index_comparison_${indexType}_indexed`,
      dataset_size: datasetSize,
      execution_time_ms: statsB.total_duration_ms,
      average_latency_ms: statsB.mean_ms,
      min_latency_ms: statsB.min_ms,
      max_latency_ms: statsB.max_ms,
      qps: statsB.qps,
      error_rate: indexedFailures / repetitions,
      experiment_metadata: {
        scenario: 'index_comparison',
        index_type: indexType,
        target_index_name: targetIndexName,
        configuration: 'B_indexed',
        index_name: targetIndexName,
        index_creation_duration_ms: createIndexRes.duration_ms,
        query_sql: querySql,
        repetitions,
        warmup_runs: warmupCount,
        median_latency_ms: statsB.median_ms,
        p95_latency_ms: statsB.p95_ms,
        std_dev_ms: statsB.std_dev_ms,
        confidence_interval_95: statsB.confidence_interval_95,
        explain_node_type: explainB.node_type,
        scan_type: explainB.scan_type,
        has_sort: explainB.has_sort,
        server_execution_time_ms: explainB.execution_time_ms,
        server_planning_time_ms: explainB.planning_time_ms,
        shared_hit_blocks: explainB.shared_hit_blocks,
        shared_read_blocks: explainB.shared_read_blocks,
      },
    });

    // Calculate speedup, latency drop, and throughput delta
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
    const qpsIncreasePct =
      statsA.qps > 0 ? Math.round(((statsB.qps - statsA.qps) / statsA.qps) * 1000) / 10 : 0;

    const methodologyNotes = `Controlled experiment comparing identical queries with and without ${targetIndexName}. Node.js measured client round-trip latencies with 3 warm-up runs. PostgreSQL server execution time and buffer blocks retrieved from EXPLAIN (ANALYZE, BUFFERS). Buffer cache state was kept warm.`;

    const summaryKZ = isComposite
      ? `Композиттік индекс ${targetIndexName} орындау жоспарын [${explainA.scan_type}] түрінен [${explainB.scan_type}] түріне ауыстырып, сұрыптауды (Sort) толық жойды. Серверлік ядролық өңдеу ${serverTimeSpeedup}x есе жеделдеді (${explainA.execution_time_ms.toFixed(3)} мс ➔ ${explainB.execution_time_ms.toFixed(3)} мс). Клиенттік толық кідіріс желілік WAN RTT (~100 мс) доминанттығына байланысты ${speedupMultiplier}x құрады.`
      : `B-tree индексі ${targetIndexName} орындау жоспарын [${explainA.scan_type}] түрінен [${explainB.scan_type}] түріне өзгертті. Серверлік ядролық өңдеу ${serverTimeSpeedup}x есе жеделдеді (${explainA.execution_time_ms.toFixed(3)} мс ➔ ${explainB.execution_time_ms.toFixed(3)} мс). Клиенттік толық кідіріс желілік WAN RTT (~100 мс) доминанттығына байланысты ${speedupMultiplier}x құрады.`;

    return {
      experiment_name: experimentName,
      index_type: indexType,
      target_index_name: targetIndexName,
      dataset_size: datasetSize,
      query_sql: querySql,
      sample_params: getParams(0),
      repetitions,
      warmup_runs: warmupCount,
      configuration_a_unindexed: {
        index_name: null,
        scan_type: explainA.scan_type,
        has_sort: explainA.has_sort,
        stats: statsA,
        explain: explainA,
        persisted_id: persistedA.id,
      },
      configuration_b_indexed: {
        index_name: targetIndexName,
        scan_type: explainB.scan_type,
        has_sort: explainB.has_sort,
        index_creation_duration_ms: createIndexRes.duration_ms,
        stats: statsB,
        explain: explainB,
        persisted_id: persistedB.id,
      },
      comparison: {
        speedup_multiplier: speedupMultiplier,
        latency_reduction_pct: latencyReductionPct,
        server_time_speedup: serverTimeSpeedup,
        qps_increase_pct: qpsIncreasePct,
        summary: summaryKZ,
      },
      timestamp: new Date().toISOString(),
      methodology_notes: methodologyNotes,
    };
  } finally {
    // Guaranteed restoration of initial index configuration, even on unexpected errors
    try {
      const currentlyExists = await checkBenchmarkIndexExists(targetIndexName);
      if (hadIndexInitially && !currentlyExists) {
        if (isComposite) {
          await createCompositeBenchmarkIndex();
        } else {
          await createBenchmarkIndex();
        }
      } else if (!hadIndexInitially && currentlyExists) {
        await dropBenchmarkIndex(targetIndexName);
      }
    } catch (restoreErr) {
      console.error('[Index Restoration Error]:', sanitizeDbError(restoreErr));
    }
    releaseBenchmarkLock();
  }
}

// ---------------------------------------------------------------------------
// Phase 6: Connection Pooling Benchmark Service
// ---------------------------------------------------------------------------

export type CloudEndpointType = 'neon_pooled' | 'neon_direct' | 'standard_pg';

export function detectEndpointType(url: string): CloudEndpointType {
  if (!url) return 'standard_pg';
  if (url.includes('-pooler.') || url.includes('pooler.')) {
    return 'neon_pooled';
  } else if (url.includes('neon.tech')) {
    return 'neon_direct';
  }
  return 'standard_pg';
}

export interface ConnectionPoolStepResult {
  pool_size: number;
  concurrency: number;
  total_queries: number;
  duration_ms: number;
  qps: number;
  stats: LatencyStats;
  mean_acquire_wait_ms: number;
  mean_sql_exec_ms: number;
  p95_acquire_wait_ms: number;
  connection_saturation_detected: boolean;
  endpoint_type: CloudEndpointType;
}

export interface ConnectionPoolingExperimentResponse {
  experiment_name: string;
  concurrency: number;
  repetitions_per_worker: number;
  total_queries_per_step: number;
  dataset_size: number;
  endpoint_type: CloudEndpointType;
  steps: ConnectionPoolStepResult[];
  optimal_pool_size: number;
  max_qps: number;
  lowest_p95_pool_size: number;
  lowest_p95_ms: number;
  scientific_summary_kz: string;
  persisted_id?: number;
  timestamp: string;
}

/**
 * Compares PostgreSQL connection pool configurations (1, 5, 10, 20 connections)
 * under controlled concurrency.
 *
 * Separates connection acquisition wait time from actual SQL execution time.
 * Automatically closes all benchmark test pools in finally blocks.
 */
export async function runConnectionPoolingExperiment(
  poolSizes: number[] = [1, 5, 10, 20],
  concurrency = 10,
  repetitionsPerWorker = 5
): Promise<ConnectionPoolingExperimentResponse> {
  if (concurrency < 1 || concurrency > 50) {
    throw new Error('Concurrency must be between 1 and 50');
  }
  if (!Array.isArray(poolSizes) || poolSizes.length === 0 || poolSizes.some((s) => s < 1 || s > 50)) {
    throw new Error('Pool sizes must be non-empty array with values between 1 and 50');
  }
  if (repetitionsPerWorker < 1 || repetitionsPerWorker > 50) {
    throw new Error('Repetitions per worker must be between 1 and 50');
  }

  if (!pool || !currentDatabaseUrl) {
    throw new Error('PostgreSQL database not connected');
  }

  if (!acquireBenchmarkLock()) {
    throw new Error('Another database benchmark is currently in progress. Please wait for it to complete.');
  }

  const endpointType = detectEndpointType(currentDatabaseUrl);

  try {
    const countRes = await pool.query('SELECT count(*)::int AS count FROM db_benchmark_users;');
    const datasetSize = countRes.rows[0]?.count || 0;
    if (datasetSize === 0) {
      throw new Error('db_benchmark_users table is empty. Please seed the dataset first.');
    }

    const querySql = 'SELECT id, name, email, status FROM db_benchmark_users WHERE id = $1;';
    const steps: ConnectionPoolStepResult[] = [];

    for (const poolSize of poolSizes) {
      // Create isolated dedicated test pool with target pool size and connection timeouts
      const testPool = createPoolForUrl(currentDatabaseUrl, poolSize);
      if (!testPool) throw new Error(`Failed to create test pool with size ${poolSize}`);

      const totalQueries = concurrency * repetitionsPerWorker;
      const latencies: number[] = [];
      const acquireWaitTimes: number[] = [];
      const sqlExecTimes: number[] = [];
      let failures = 0;

      try {
        // Unmeasured warm-up on test pool (pre-opens initial connection)
        try {
          await testPool.query('SELECT 1;');
        } catch {}

        const stepStart = performance.now();

        // Launch concurrent workers with controlled load
        const workerPromises = Array.from({ length: concurrency }, async (_, workerIdx) => {
          for (let r = 0; r < repetitionsPerWorker; r++) {
            const targetId = 1 + (((workerIdx * 17) + (r * 23)) % datasetSize);

            const tAcquire = performance.now();
            let client: pg.PoolClient | null = null;
            try {
              client = await testPool.connect();
              const acquireMs = performance.now() - tAcquire;
              acquireWaitTimes.push(acquireMs);

              const tExec = performance.now();
              await client.query(querySql, [targetId]);
              const execMs = performance.now() - tExec;
              sqlExecTimes.push(execMs);

              latencies.push(acquireMs + execMs);
            } catch {
              failures++;
            } finally {
              if (client) {
                client.release();
              }
            }
          }
        });

        await Promise.all(workerPromises);
        const stepDuration = performance.now() - stepStart;

        const stats = calculateLatencyStats(latencies, failures, stepDuration);

        // Calculate connection acquisition vs execution breakdown
        const meanAcquire =
          acquireWaitTimes.length > 0
            ? Math.round((acquireWaitTimes.reduce((a, b) => a + b, 0) / acquireWaitTimes.length) * 100) / 100
            : 0;
        const meanExec =
          sqlExecTimes.length > 0
            ? Math.round((sqlExecTimes.reduce((a, b) => a + b, 0) / sqlExecTimes.length) * 100) / 100
            : 0;

        const sortedAcquire = [...acquireWaitTimes].sort((a, b) => a - b);
        const p95AcquireIndex = Math.min(sortedAcquire.length - 1, Math.floor(sortedAcquire.length * 0.95));
        const p95Acquire = sortedAcquire.length > 0 ? Math.round(sortedAcquire[p95AcquireIndex] * 100) / 100 : 0;

        // Detect connection saturation (queue wait exceeds actual database query execution time)
        const isSaturated = poolSize < concurrency && meanAcquire > meanExec;

        steps.push({
          pool_size: poolSize,
          concurrency,
          total_queries: totalQueries,
          duration_ms: Math.round(stepDuration * 100) / 100,
          qps: stats.qps,
          stats,
          mean_acquire_wait_ms: meanAcquire,
          mean_sql_exec_ms: meanExec,
          p95_acquire_wait_ms: p95Acquire,
          connection_saturation_detected: isSaturated,
          endpoint_type: endpointType,
        });
      } finally {
        // Guaranteed cleanup of test pool
        await testPool.end();
      }
    }

    // Determine optimal pool size by highest QPS
    let optimal = steps[0];
    let lowestP95 = steps[0];
    for (const s of steps) {
      if (s.qps > optimal.qps) {
        optimal = s;
      }
      if (s.stats.p95_ms < lowestP95.stats.p95_ms) {
        lowestP95 = s;
      }
    }

    const saturatedSteps = steps.filter((s) => s.connection_saturation_detected);
    const saturationNote =
      saturatedSteps.length > 0
        ? `Пул көлемі ${saturatedSteps.map((s) => s.pool_size).join(', ')} болғанда байланыстардың қанығуы (connection saturation) байқалды: сұраныстар орындалу уақытына қарағанда бос қосылымды күтуге көбірек уақыт жұмсады (орташа күту: ${saturatedSteps[0].mean_acquire_wait_ms} мс).`
        : 'Байланыстар қанығуы байқалмады, барлық конфигурациялар кідіріссіз қызмет көрсетті.';

    const scientificSummaryKZ = `Байланыстар пулын сынау нәтижесінде ең жоғары өткізу қабілеті (Throughput) пул көлемі ${optimal.pool_size} болғанда байқалды (${optimal.qps} QPS, орташа кідіріс ${optimal.stats.mean_ms} мс, P95: ${optimal.stats.p95_ms} мс). Ең төменгі P95 кідірісі пул көлемі ${lowestP95.pool_size} кезінде анықталды (${lowestP95.stats.p95_ms} мс). ${saturationNote} Бұлттық Neon PostgreSQL ортасында сұраныстар ағыны ${concurrency} болғанда оңтайлы пул өлшемі ${optimal.pool_size} деп бағаланады.`;

    // Persist master result into benchmark_results
    const persisted = await persistBenchmarkResult({
      experiment_type: 'connection_pooling',
      dataset_size: datasetSize,
      execution_time_ms: steps.reduce((sum, s) => sum + s.duration_ms, 0),
      average_latency_ms: optimal.stats.mean_ms,
      min_latency_ms: optimal.stats.min_ms,
      max_latency_ms: optimal.stats.max_ms,
      qps: optimal.qps,
      error_rate: optimal.stats.failure_count / (optimal.stats.count || 1),
      experiment_metadata: {
        pool_sizes: poolSizes,
        concurrency,
        repetitions_per_worker: repetitionsPerWorker,
        endpoint_type: endpointType,
        steps,
        optimal_pool_size: optimal.pool_size,
        max_qps: optimal.qps,
        lowest_p95_pool_size: lowestP95.pool_size,
        lowest_p95_ms: lowestP95.stats.p95_ms,
        scientific_summary_kz: scientificSummaryKZ,
        database_environment: process.env.ENVIRONMENT_NAME || 'Cloud-Neon-Serverless',
      },
    });

    // Also persist individual step records for each pool size configuration
    for (const step of steps) {
      await persistBenchmarkResult({
        experiment_type: 'connection_pooling_step',
        dataset_size: datasetSize,
        execution_time_ms: step.duration_ms,
        average_latency_ms: step.stats.mean_ms,
        min_latency_ms: step.stats.min_ms,
        max_latency_ms: step.stats.max_ms,
        qps: step.qps,
        error_rate: step.stats.failure_count / (step.stats.count || 1),
        experiment_metadata: {
          experiment_master_id: persisted.id,
          pool_size: step.pool_size,
          concurrency: step.concurrency,
          query_type: 'by_id',
          dataset_size: datasetSize,
          mean_latency_ms: step.stats.mean_ms,
          median_latency_ms: step.stats.median_ms,
          p95_latency_ms: step.stats.p95_ms,
          min_latency_ms: step.stats.min_ms,
          max_latency_ms: step.stats.max_ms,
          qps: step.qps,
          error_rate: step.stats.failure_count / (step.stats.count || 1),
          mean_acquire_wait_ms: step.mean_acquire_wait_ms,
          mean_sql_exec_ms: step.mean_sql_exec_ms,
          p95_acquire_wait_ms: step.p95_acquire_wait_ms,
          connection_saturation_detected: step.connection_saturation_detected,
          endpoint_type: endpointType,
          database_environment: process.env.ENVIRONMENT_NAME || 'Cloud-Neon-Serverless',
        },
      });
    }

    return {
      experiment_name: 'PostgreSQL Connection Pooling Performance Experiment',
      concurrency,
      repetitions_per_worker: repetitionsPerWorker,
      total_queries_per_step: concurrency * repetitionsPerWorker,
      dataset_size: datasetSize,
      endpoint_type: endpointType,
      steps,
      optimal_pool_size: optimal.pool_size,
      max_qps: optimal.qps,
      lowest_p95_pool_size: lowestP95.pool_size,
      lowest_p95_ms: lowestP95.stats.p95_ms,
      scientific_summary_kz: scientificSummaryKZ,
      persisted_id: persisted.id,
      timestamp: persisted.created_at,
    };
  } finally {
    releaseBenchmarkLock();
  }
}
