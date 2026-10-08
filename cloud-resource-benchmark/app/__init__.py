"""
app/__init__.py
---------------
Flask application factory.

Calling create_app() wires together:
  - Configuration from environment variables
  - PostgreSQL connection pool
  - Database schema initialisation
  - All API Blueprints
  - The main dashboard route
"""

import logging
import os

from flask import Flask, render_template

from app.config import Config


def create_app(config: Config | None = None) -> Flask:
    """Create and configure the Flask application."""

    # ------------------------------------------------------------------ #
    # Logging                                                               #
    # ------------------------------------------------------------------ #
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger = logging.getLogger(__name__)

    # ------------------------------------------------------------------ #
    # Flask instance                                                        #
    # ------------------------------------------------------------------ #
    app = Flask(
        __name__,
        template_folder="templates",
        static_folder="static",
    )

    cfg = config or Config()
    app.config["SECRET_KEY"] = cfg.SECRET_KEY
    app.config["ENVIRONMENT_NAME"] = cfg.ENVIRONMENT_NAME
    app.config["SERVER_CONFIGURATION"] = cfg.SERVER_CONFIGURATION

    # ------------------------------------------------------------------ #
    # Database & Cache                                                      #
    # ------------------------------------------------------------------ #
    from app import database as db
    from app import cache

    try:
        db.init_pool(dsn=cfg.db_dsn, minconn=cfg.DB_MIN_CONN, maxconn=cfg.DB_MAX_CONN)
        logger.info("Database pool initialised (min=%d, max=%d).", cfg.DB_MIN_CONN, cfg.DB_MAX_CONN)

        from app.models.benchmark import init_schema, seed_benchmark_data
        init_schema()
        seed_benchmark_data()
    except Exception as exc:
        # Allow the app to start even if DB is temporarily unavailable
        # (health endpoint will report the outage).
        logger.error("Database startup failed: %s", exc)

    try:
        cache.init_cache(
            host=cfg.REDIS_HOST,
            port=cfg.REDIS_PORT,
            password=cfg.REDIS_PASSWORD,
            db=cfg.REDIS_DB,
        )
    except Exception as exc:
        logger.warning("Redis cache startup failed: %s", exc)

    # ------------------------------------------------------------------ #
    # Blueprints                                                            #
    # ------------------------------------------------------------------ #
    from app.routes.api import api_bp
    from app.routes.benchmarks import benchmarks_bp

    app.register_blueprint(api_bp)
    app.register_blueprint(benchmarks_bp)

    # ------------------------------------------------------------------ #
    # Dashboard route                                                       #
    # ------------------------------------------------------------------ #
    @app.get("/")
    def dashboard():
        return render_template("index.html")

    logger.info(
        "App ready — env=%s cfg=%s",
        cfg.ENVIRONMENT_NAME,
        cfg.SERVER_CONFIGURATION,
    )
    return app
