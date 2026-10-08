"""
tests/conftest.py
-----------------
Shared pytest fixtures for the Cloud Resource Benchmark test suite.

The tests mock the database so they can run without a live PostgreSQL
instance. Integration tests (that need a real DB) are marked with
@pytest.mark.integration.
"""

import os
import pytest
from unittest.mock import MagicMock, patch

# Set env vars BEFORE importing the app
os.environ.setdefault("FLASK_ENV", "testing")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret")
os.environ.setdefault("DB_HOST", "localhost")
os.environ.setdefault("DB_PORT", "5432")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("DB_USER", "test_user")
os.environ.setdefault("DB_PASSWORD", "test_password")
os.environ.setdefault("ENVIRONMENT_NAME", "Test")
os.environ.setdefault("SERVER_CONFIGURATION", "Test Machine")


@pytest.fixture(scope="session")
def app():
    """
    Create a Flask test application.
    DB pool init, schema creation, and cache init are mocked so no real DB or Redis is needed.
    """
    with patch("app.database.init_pool"), \
         patch("app.cache.init_cache"), \
         patch("app.models.benchmark.init_schema"), \
         patch("app.models.benchmark.seed_benchmark_data"):
        from app import create_app
        flask_app = create_app()
        flask_app.config["TESTING"] = True
        yield flask_app



@pytest.fixture()
def client(app):
    """Flask test client."""
    return app.test_client()


@pytest.fixture()
def mock_db():
    """Mock the database execute_query function."""
    with patch("app.database.execute_query") as m:
        yield m


@pytest.fixture()
def mock_is_connected_ok():
    with patch("app.database.is_connected", return_value=True):
        yield


@pytest.fixture()
def mock_is_connected_fail():
    with patch("app.database.is_connected", return_value=False):
        yield
