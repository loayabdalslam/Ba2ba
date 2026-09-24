from __future__ import annotations

import hashlib
import json
import os
import platform
import secrets
import socket
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional


def bee2bee_home() -> Path:
    base = os.environ.get("BEE2BEE_HOME")
    p = Path(base) if base else Path.home() / ".bee2bee"
    p.mkdir(parents=True, exist_ok=True)
    return p


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def write_secret_file(path: Path, content: str) -> None:
    """Write a file readable only by the current user."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def new_secret(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def now_ms() -> int:
    return int(time.time() * 1000)


def os_name() -> str:
    return platform.system()


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hash_password(password: str, salt: str) -> str:
    """Memory-hard password hash (scrypt). Salt must be unique per password."""
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=2**14, r=8, p=1, dklen=32)
    return digest.hex()


def gen_salt() -> str:
    return secrets.token_hex(16)


def get_lan_ip() -> str:
    """Detect the local LAN IP address (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def is_colab() -> bool:
    import sys

    return "google.colab" in sys.modules


def get_gpu_usage() -> Optional[float]:
    """GPU utilisation percent via nvidia-smi, or None when unavailable."""
    import shutil
    import subprocess

    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            stderr=subprocess.STDOUT,
            timeout=2,
        )
        return float(out.decode("utf-8").strip().splitlines()[0])
    except Exception:
        return None


def get_system_metrics() -> Dict[str, Any]:
    """Real host metrics. Nothing here is simulated."""
    metrics: Dict[str, Any] = {}
    try:
        import psutil

        metrics["cpu_percent"] = psutil.cpu_percent(interval=None)
        metrics["memory_percent"] = psutil.virtual_memory().percent
    except Exception:
        pass
    gpu = get_gpu_usage()
    if gpu is not None:
        metrics["gpu_percent"] = gpu
    return metrics
