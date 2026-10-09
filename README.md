# Cloud Resource Benchmark

> **Academic Research Tool** — Deploying a Web Application in a Cloud Environment and Studying Resource Utilisation Efficiency

A full-stack benchmarking dashboard built with Python/Flask + PostgreSQL that lets you run controlled workloads, measure real server performance metrics, and compare results across different environments (Local, Cloud-1, Cloud-2, etc.).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Database Schema](#database-schema)
4. [Prerequisites](#prerequisites)
5. [Quick Start — Docker Compose](#quick-start--docker-compose)
6. [Quick Start — Local (without Docker)](#quick-start--local-without-docker)
7. [Environment Variables Reference](#environment-variables-reference)
8. [Running Tests](#running-tests)
9. [Using the Benchmarks](#using-the-benchmarks)
10. [Local vs Cloud Comparison](#local-vs-cloud-comparison)
11. [Deploying to a Cloud VPS](#deploying-to-a-cloud-vps)
12. [API Reference](#api-reference)

---

## Architecture Overview

```
Browser ──HTTP──► Flask (REST API + HTML dashboard)
                        │
                   psutil / NumPy / math
                   (real measurements)
                        │
                   PostgreSQL (results + seed data)
```

- **Flask** serves the HTML dashboard and all `/api/*` endpoints.
- **psutil** collects real-time CPU and RAM metrics.
- **NumPy** powers the matrix-multiplication data-processing benchmark.
- **PostgreSQL** stores all benchmark results and the 50 000-row seed table used by the database benchmark.
- **Docker Compose** starts both containers with one command and wires them through a private network.

---

## Project Structure

```
cloud-resource-benchmark/
│
├── app/
│   ├── __init__.py          # Flask application factory
│   ├── config.py            # Configuration from environment variables
│   ├── database.py          # PostgreSQL connection pool (psycopg2)
│   ├── routes/
│   │   ├── api.py           # GET /api/health, /system-info, /metrics, /benchmarks
│   │   └── benchmarks.py    # POST /api/benchmark/cpu|database|data-processing
│   ├── services/
│   │   ├── cpu_benchmark.py     # Multi-threaded prime counting
│   │   ├── db_benchmark.py      # Parameterised SELECT queries
│   │   └── data_benchmark.py    # NumPy matrix multiplication
│   ├── models/
│   │   └── benchmark.py     # Schema init, seed, save/query results
│   ├── templates/
│   │   └── index.html       # Single-page dashboard (5 tabs)
│   └── static/
│       ├── css/style.css    # Dark technical dashboard theme
│       └── js/app.js        # Tab nav, polling, Chart.js charts
│
├── tests/
│   ├── conftest.py          # Shared fixtures (mocked DB)
│   ├── test_api.py          # API endpoint unit tests
│   └── test_benchmarks.py  # Service + route tests
│
├── Dockerfile               # Single-stage python:3.12-slim image
├── docker-compose.yml       # Flask + PostgreSQL services
├── requirements.txt         # Pinned Python dependencies
├── .env.example             # Environment variable template
├── .gitignore
├── run.py                   # Dev-server entry point
└── README.md
```

---

## Database Schema

### `benchmark_results`

| Column               | Type          | Description                          |
|----------------------|---------------|--------------------------------------|
| id                   | SERIAL PK     | Auto-increment                       |
| environment_name     | VARCHAR(64)   | `Local` / `Cloud-1` / `Cloud-2` …   |
| server_configuration | VARCHAR(128)  | e.g. `2 vCPU / 2 GB RAM`            |
| test_type            | VARCHAR(64)   | `cpu` / `database` / `data-processing` |
| test_parameter       | VARCHAR(64)   | `5s` / `1000q` / `medium`           |
| execution_time       | FLOAT         | Seconds                              |
| cpu_usage            | FLOAT         | Average CPU % during the test        |
| memory_usage         | FLOAT         | Average RAM % during the test        |
| extra_metrics        | JSONB         | Test-specific extras (max_cpu, QPS …)|
| timestamp            | TIMESTAMPTZ   | UTC timestamp, auto-set              |

### `benchmark_data`

50 000 seed rows used by the database benchmark. Generated deterministically on startup.

| Column      | Type    | Description              |
|-------------|---------|--------------------------|
| id          | SERIAL  |                          |
| category    | VARCHAR | alpha/beta/gamma/delta/epsilon |
| value_int   | INTEGER | Row index                |
| value_float | FLOAT   | i × golden ratio         |
| label       | VARCHAR | `label_000001` etc.      |

---

## Prerequisites

- **Docker + Docker Compose** ← recommended for easiest setup
- **OR**: Python 3.11+, pip, a running PostgreSQL 14+ instance

---

## Quick Start — Docker Compose

### 1. Clone / copy the project

```bash
cd cloud-resource-benchmark
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and set **at minimum** a strong `DB_PASSWORD`:

```env
DB_PASSWORD=mysecurepassword123
ENVIRONMENT_NAME=Local
SERVER_CONFIGURATION=Local Machine
```

### 3. Build and start

```bash
docker compose up --build
```

On first start:
- PostgreSQL initialises the database
- Flask creates all tables automatically
- Flask seeds 50 000 rows into `benchmark_data` (takes ~10 seconds)

### 4. Open the dashboard

```
http://localhost:5000
```

### 5. Stop

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # stop + wipe DB volume
```

---

## Quick Start — Local (without Docker)

### 1. Install Python dependencies

```bash
cd cloud-resource-benchmark

# Create and activate a virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

# Install
pip install -r requirements.txt
```

### 2. Create a PostgreSQL database

Connect to your PostgreSQL instance and run:

```sql
CREATE DATABASE benchmark_db;
CREATE USER benchmark_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE benchmark_db TO benchmark_user;
```

### 3. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env`:

```env
FLASK_ENV=development
FLASK_PORT=5000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=benchmark_db
DB_USER=benchmark_user
DB_PASSWORD=your_password
ENVIRONMENT_NAME=Local
SERVER_CONFIGURATION=Local Machine
```

### 4. Run

```bash
python run.py
```

Flask will:
- Create all tables automatically
- Seed benchmark data
- Start the dev server on `http://localhost:5000`

---

## Environment Variables Reference

| Variable              | Default          | Description                                      |
|-----------------------|------------------|--------------------------------------------------|
| `FLASK_ENV`           | `development`    | `development` or `production`                   |
| `FLASK_SECRET_KEY`    | (required)       | Flask session secret — change in production     |
| `FLASK_PORT`          | `5000`           | Port to listen on                               |
| `DB_HOST`             | `localhost`      | PostgreSQL hostname (`db` when using Compose)   |
| `DB_PORT`             | `5432`           | PostgreSQL port                                 |
| `DB_NAME`             | `benchmark_db`   | Database name                                   |
| `DB_USER`             | `benchmark_user` | Database user                                   |
| `DB_PASSWORD`         | (required)       | Database password — **never commit this**       |
| `ENVIRONMENT_NAME`    | `Local`          | Labels results: `Local` / `Cloud-1` / `Cloud-2` |
| `SERVER_CONFIGURATION`| `Local Machine`  | e.g. `2 vCPU / 2 GB RAM`                       |

---

## Running Tests

Tests do **not** require a live database — the DB is mocked.

```bash
# Make sure dependencies are installed
pip install -r requirements.txt

# Run all tests
pytest tests/ -v

# Run only service/logic tests (no HTTP)
pytest tests/test_benchmarks.py -v

# Run only API tests
pytest tests/test_api.py -v

# With coverage report
pip install pytest-cov
pytest tests/ --cov=app --cov-report=term-missing
```

> **Note**: `test_cpu_benchmark_service` actually runs a 5-second CPU workload — this is intentional to verify real measurements.

---

## Using the Benchmarks

### First CPU Benchmark

1. Open `http://localhost:5000`
2. Click **Benchmarks** tab
3. Under **CPU Benchmark**, select **5 seconds**
4. Click **Run CPU Benchmark**
5. Wait 5 seconds — the result box will show:
   - Execution time
   - Average + max CPU %
   - RAM before/after
   - Saved result ID

### First Database Benchmark

1. Click **Benchmarks** tab
2. Under **Database Benchmark**, select **100 queries**
3. Click **Run Database Benchmark**
4. Results appear instantly showing:
   - Total time, avg query time (ms), queries/second
   - CPU and RAM during the run

### First Data Processing Benchmark

1. Click **Benchmarks** tab
2. Under **Data Processing Benchmark**, select **Small (512²)**
3. Click **Run Data Processing Benchmark**
4. Results show execution time, GFLOP/s estimate, CPU/RAM

---

## Local vs Cloud Comparison

### How it works

Every benchmark result stores `environment_name` and `server_configuration` from your `.env`.

The **Local vs Cloud** tab queries `/api/benchmarks/compare` which groups all stored results by `(test_type, test_parameter)` and pivots by environment — only showing real stored values.

### Example workflow

**Step 1 — Run on Local machine**

```env
ENVIRONMENT_NAME=Local
SERVER_CONFIGURATION=Local Machine
```

Run CPU, Database, and Data Processing benchmarks.

**Step 2 — Deploy to Cloud VPS, change `.env`**

```env
ENVIRONMENT_NAME=Cloud-1
SERVER_CONFIGURATION=2 vCPU / 2 GB RAM
```

Run the same benchmarks.

**Step 3 — View comparison**

Both environments share the same PostgreSQL database, so the comparison table will automatically show both columns side-by-side with the best (fastest) result highlighted in green.

> **Alternative**: If Cloud uses a separate DB, export results as SQL `INSERT` statements and import them into the other environment's database.

### Changing `ENVIRONMENT_NAME`

**Without Docker:**

Edit `.env`:
```env
ENVIRONMENT_NAME=Cloud-1
```
Restart the app:
```bash
python run.py
```

**With Docker Compose:**

Edit `.env`, then restart:
```bash
docker compose down
docker compose up --build
```

---

## Deploying to a Cloud VPS

### Requirements on the VPS

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y docker.io docker-compose-plugin git

# Add your user to the docker group
sudo usermod -aG docker $USER
newgrp docker
```

### Deploy steps

```bash
# 1. Copy project to VPS (example using scp)
scp -r cloud-resource-benchmark/ user@your-vps-ip:/home/user/

# 2. SSH into VPS
ssh user@your-vps-ip

# 3. Navigate to project
cd cloud-resource-benchmark

# 4. Create .env with cloud-specific values
cp .env.example .env
nano .env
```

Set in `.env`:
```env
ENVIRONMENT_NAME=Cloud-1
SERVER_CONFIGURATION=2 vCPU / 2 GB RAM
DB_PASSWORD=strong_random_password_here
FLASK_SECRET_KEY=another_random_secret_here
```

```bash
# 5. Start
docker compose up --build -d

# 6. Check logs
docker compose logs -f web

# 7. Open firewall port (if needed)
sudo ufw allow 5000
```

Access at: `http://your-vps-ip:5000`

### Running with a different vCPU/RAM configuration

Change `SERVER_CONFIGURATION` in `.env` to match the actual VPS spec, then restart:

```bash
docker compose down
docker compose up -d
```

New benchmarks will be tagged with the new configuration value.

---

## API Reference

| Method | Endpoint                       | Description                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/health`                 | Liveness check + DB connectivity     |
| GET    | `/api/system-info`            | Hostname, OS, CPU, RAM, uptime       |
| GET    | `/api/metrics`                | Live CPU% and RAM% (poll every 2 s)  |
| POST   | `/api/benchmark/cpu`          | Run CPU benchmark `{"duration": 5}`  |
| POST   | `/api/benchmark/database`     | Run DB benchmark `{"query_count": 1000}` |
| POST   | `/api/benchmark/data-processing` | Run data benchmark `{"size": "medium"}` |
| GET    | `/api/benchmarks`             | Benchmark history (filterable)       |
| GET    | `/api/benchmarks/compare`     | Local vs Cloud aggregated comparison |

### Example API calls

```bash
# Health check
curl http://localhost:5000/api/health

# Run 10-second CPU benchmark
curl -X POST http://localhost:5000/api/benchmark/cpu \
     -H "Content-Type: application/json" \
     -d '{"duration": 10}'

# Run 1000-query DB benchmark
curl -X POST http://localhost:5000/api/benchmark/database \
     -H "Content-Type: application/json" \
     -d '{"query_count": 1000}'

# Run medium data processing benchmark
curl -X POST http://localhost:5000/api/benchmark/data-processing \
     -H "Content-Type: application/json" \
     -d '{"size": "medium"}'

# Fetch last 50 results for CPU tests
curl "http://localhost:5000/api/benchmarks?test_type=cpu&limit=50"

# Get comparison data
curl http://localhost:5000/api/benchmarks/compare
```

---

## Academic Data Export

All results are stored in the `benchmark_results` table. To export for analysis:

```bash
# Export as CSV (inside Docker)
docker exec benchmark_db psql -U benchmark_user -d benchmark_db \
  -c "\COPY benchmark_results TO '/tmp/results.csv' CSV HEADER"

docker cp benchmark_db:/tmp/results.csv ./benchmark_results.csv
```

The CSV will contain all fields needed for your academic analysis:
`environment_name, server_configuration, test_type, test_parameter, execution_time, cpu_usage, memory_usage, timestamp`

---

*Built for academic research — all benchmark results are real measurements, never generated or invented.*
