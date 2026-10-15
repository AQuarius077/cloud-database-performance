# Study of Cloud Database Performance Optimization Methods
> **Бұлттық деректер базасының өнімділігін оңтайландыру әдістерін зерттеу**  
> Academic Research & Benchmarking Platform for Cloud Database Resource & Performance Efficiency

---

## Architecture Overview

```
Browser ──HTTP──► Express (TypeScript / Node.js 22)
                        │
                pg.Pool (Connection Pooling)
                        │
             PostgreSQL 16+ Database
             (db_benchmark_users, db_benchmark_orders, benchmark_results)
```

- **Frontend**: Clean single-page dashboard with real-time hardware metrics polling (CPU & RAM), live database connection status, research dataset seeder, and Chart.js analytics.
- **Backend**: Express REST API running on Node.js 22 with full TypeScript support (`server.ts`).
- **Database Layer**: Official PostgreSQL driver (`pg`) utilizing connection pooling (`pg.Pool`) configured via environment variables.

---

## Database Configuration

PostgreSQL is configured strictly through environment variables. Credentials are never exposed to the client.

### Environment Variables

Configure these in your `.env` file (see `.env.example`):

| Variable | Description | Default | Example |
|---|---|---|---|
| `PORT` | Web server listening port | `3000` | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `""` (offline mode) | `postgresql://user:password@localhost:5432/cloud_benchmark_db` |
| `PG_POOL_MAX` | Maximum concurrent pool clients | `20` | `20` |
| `ENVIRONMENT_NAME` | Name of current testing environment | `Local` | `Local` or `Cloud-GCP` |
| `SERVER_CONFIGURATION` | Host specifications label | `Standard Local Host` | `4 vCPU, 8GB RAM` |

---

## Database Schema

When `DATABASE_URL` is configured, schema migrations run automatically on startup to ensure the required research tables exist:

### 1. `db_benchmark_users`
- `id`: `SERIAL PRIMARY KEY`
- `name`: `VARCHAR(255) NOT NULL`
- `email`: `VARCHAR(255) NOT NULL`
- `status`: `VARCHAR(50) NOT NULL`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### 2. `db_benchmark_orders`
- `id`: `SERIAL PRIMARY KEY`
- `user_id`: `INTEGER NOT NULL REFERENCES db_benchmark_users(id) ON DELETE CASCADE`
- `amount`: `NUMERIC(12, 2) NOT NULL`
- `status`: `VARCHAR(50) NOT NULL`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### 3. `benchmark_results`
- `id`: `SERIAL PRIMARY KEY`
- `experiment_type`: `VARCHAR(100) NOT NULL`
- `dataset_size`: `INTEGER`
- `execution_time_ms`: `DOUBLE PRECISION NOT NULL`
- `average_latency_ms`: `DOUBLE PRECISION`
- `min_latency_ms`: `DOUBLE PRECISION`
- `max_latency_ms`: `DOUBLE PRECISION`
- `qps`: `DOUBLE PRECISION`
- `error_rate`: `DOUBLE PRECISION DEFAULT 0`
- `experiment_metadata`: `JSONB`
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`

---

## Dataset Generation

The dataset generation endpoint uses PostgreSQL's native `generate_series` function to populate realistic relational datasets without copying large arrays over Node.js memory:

```http
POST /api/benchmark/dataset-seed
Content-Type: application/json

{
  "dataset_size": 10000
}
```

- **Supported sizes**: `10000`, `100000`, `1000000`
- **Safety**: Runs within a transaction (`BEGIN` / `COMMIT`), resets previous test data with `TRUNCATE ... RESTART IDENTITY CASCADE`, parameterizes queries to prevent SQL injection, and runs `ANALYZE` for optimizer statistics.

---

## API Endpoints

- `GET /api/health` — Returns status of application and live PostgreSQL connection.
- `GET /api/database/status` — Returns database name, PostgreSQL version, size in MB, active connections, and table row counts.
- `POST /api/benchmark/dataset-seed` — Generates 10k, 100k, or 1M relational rows in PostgreSQL.
- `GET /api/system-info` — System information (OS, CPU cores, RAM).
- `GET /api/metrics` — Live CPU and RAM usage polled by the dashboard.
- `GET /api/benchmarks` — Benchmark test history.
- `GET /api/benchmarks/compare` — Cross-environment comparative performance data.

---

## Testing

Run unit and integration validation tests:

```bash
npm test
```
