# ============================================================
# Dockerfile — Cloud Resource Benchmark Flask App
# ============================================================
# Multi-stage is not needed here; single-stage keeps it simple
# and readable for a beginner/intermediate developer.
# ============================================================

FROM python:3.12-slim

# ---------- System dependencies ----------
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# ---------- Working directory ----------
WORKDIR /app

# ---------- Python dependencies ----------
# Copy requirements first to benefit from Docker layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------- Application code ----------
COPY . .

# ---------- Runtime configuration ----------
# These are defaults; override them via docker-compose / .env
ENV FLASK_ENV=production
ENV FLASK_PORT=5000
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# ---------- Expose port ----------
EXPOSE 5000

# ---------- Health check ----------
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/api/health')"

# ---------- Start command ----------
# Use Gunicorn in production; falls back gracefully if not installed.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "2", \
     "--threads", "4", \
     "--timeout", "120", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "run:app"]
