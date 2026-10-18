"""Small correlation helpers for one support journey across HTTP and background work."""
import json
import re
from contextvars import ContextVar
from uuid import uuid4


_trace_id = ContextVar("resolveai_trace_id", default="")
_SAFE_TRACE_ID = re.compile(r"^[A-Za-z0-9._-]{8,80}$")


def new_trace_id() -> str:
    return uuid4().hex


def valid_trace_id(value: str | None) -> str:
    value = (value or "").strip()
    return value if _SAFE_TRACE_ID.fullmatch(value) else ""


def set_trace_id(value: str):
    return _trace_id.set(valid_trace_id(value))


def reset_trace_id(token) -> None:
    _trace_id.reset(token)


def current_trace_id() -> str:
    return _trace_id.get()


def trace_log(event: str, trace_id: str = "", **fields) -> None:
    """Emit one Cloud Logging-friendly JSON record; never pass transcript text or credentials."""
    payload = {"severity": "INFO", "event": event, "trace_id": valid_trace_id(trace_id) or current_trace_id()}
    payload.update(fields)
    print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)
