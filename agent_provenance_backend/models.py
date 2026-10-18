"""Shared serialization and versioned analysis contracts."""

import json
import os
import tempfile
from hashlib import sha256
from pathlib import Path
from typing import Any

FRAMEWORK_VERSION = "pattern-abstraction-v6-event-assessments"
ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "agent_provenance_react" / ".cache" / "pattern-framework"


class ModelResponseError(ValueError):
    """An upstream model violated the requested annotation contract."""


def digest(value: Any) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_cache(path: Path) -> Any:
    return json.loads(path.read_text()) if path.exists() else None


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Requests for overlapping selections may complete at the same time.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        temporary = handle.name
        try:
            json.dump(value, handle, ensure_ascii=False)
        except Exception:
            os.unlink(temporary)
            raise
    os.replace(temporary, path)
