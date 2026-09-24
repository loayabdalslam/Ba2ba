"""Logging and error-reporting setup (call once at process start)."""

from __future__ import annotations

import sys
from pathlib import Path

from loguru import logger

from .settings import Settings

_configured = False


def setup(settings: Settings) -> None:
    global _configured
    if _configured:
        return
    _configured = True
    logger.remove()
    level = settings.log_level.upper()
    if settings.log_json:
        logger.add(sys.stderr, level=level, serialize=True)
    else:
        logger.add(sys.stderr, level=level, format="<green>{time:HH:mm:ss}</green> <level>{level: <8}</level> {message}")
    if settings.log_file:
        Path(settings.log_file).parent.mkdir(parents=True, exist_ok=True)
        logger.add(settings.log_file, level=level, rotation="10 MB", retention=5, serialize=settings.log_json)
    if settings.sentry_dsn:
        try:
            import sentry_sdk

            sentry_sdk.init(dsn=settings.sentry_dsn, traces_sample_rate=0.0)
            logger.info("Sentry error reporting enabled")
        except ImportError:
            logger.warning("BEE2BEE_SENTRY_DSN is set but sentry-sdk is not installed (pip install 'bee2bee[sentry]')")
