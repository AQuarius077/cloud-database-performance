"""
app/config.py
-------------
All configuration is read from environment variables.
Sensitive defaults are intentionally missing — the app
will raise an error rather than silently use bad values.
"""

import os


class Config:
    # Flask
    SECRET_KEY: str = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")
    FLASK_ENV: str = os.environ.get("FLASK_ENV", "development")

    # PostgreSQL
    DB_HOST: str = os.environ.get("DB_HOST", "localhost")
    DB_PORT: int = int(os.environ.get("DB_PORT", 5432))
    DB_NAME: str = os.environ.get("DB_NAME", "benchmark_db")
    DB_USER: str = os.environ.get("DB_USER", "benchmark_user")
    DB_PASSWORD: str = os.environ.get("DB_PASSWORD", "")
    DB_MIN_CONN: int = int(os.environ.get("DB_MIN_CONN", 2))
    DB_MAX_CONN: int = int(os.environ.get("DB_MAX_CONN", 30))

    # Redis Cache Layer
    REDIS_HOST: str = os.environ.get("REDIS_HOST", "localhost")
    REDIS_PORT: int = int(os.environ.get("REDIS_PORT", 6379))
    REDIS_PASSWORD: str | None = os.environ.get("REDIS_PASSWORD") or None
    REDIS_DB: int = int(os.environ.get("REDIS_DB", 0))

    # Experiment identity
    ENVIRONMENT_NAME: str = os.environ.get("ENVIRONMENT_NAME", "Local")
    SERVER_CONFIGURATION: str = os.environ.get("SERVER_CONFIGURATION", "Unknown")

    @property
    def db_dsn(self) -> str:
        """Return a psycopg2-compatible DSN string."""
        return (
            f"host={self.DB_HOST} "
            f"port={self.DB_PORT} "
            f"dbname={self.DB_NAME} "
            f"user={self.DB_USER} "
            f"password={self.DB_PASSWORD}"
        )

    @property
    def redis_url(self) -> str:
        """Return a redis connection URL."""
        if self.REDIS_PASSWORD:
            return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

