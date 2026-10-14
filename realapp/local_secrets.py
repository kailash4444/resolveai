import base64
import ctypes
import os
import json
import tempfile
from pathlib import Path


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _secret_path() -> Path:
    override = os.getenv("RESOLVEAI_LOCAL_KEY_FILE")
    if override:
        return Path(override)
    base = Path(os.getenv("LOCALAPPDATA") or Path.home())
    return base / "ResolveAI" / "openai_api_key.dpapi"


def _protect(data: bytes) -> bytes:
    if os.name != "nt":
        return data
    source = ctypes.create_string_buffer(data)
    source_blob = _DataBlob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    output_blob = _DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source_blob), "ResolveAI", None, None, None, 0, ctypes.byref(output_blob)):
        raise OSError("Windows could not protect the local OpenAI key.")
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def _unprotect(data: bytes) -> bytes:
    if os.name != "nt":
        return data
    source = ctypes.create_string_buffer(data)
    source_blob = _DataBlob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    output_blob = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source_blob), None, None, None, None, 0, ctypes.byref(output_blob)):
        raise OSError("Windows could not read the protected local OpenAI key.")
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def save_local_openai_key(value: str) -> None:
    path = _secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64encode(_protect(value.strip().encode("utf-8"))))


def load_local_openai_key() -> str | None:
    path = _secret_path()
    if not path.exists():
        return None
    try:
        return _unprotect(base64.b64decode(path.read_bytes())).decode('utf-8').strip() or None
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _gemini_path() -> Path:
    override = os.getenv('RESOLVEAI_LOCAL_GEMINI_FILE')
    return Path(override) if override else Path(os.getenv('LOCALAPPDATA') or Path.home()) / 'ResolveAI' / 'gemini_api_key.dpapi'


def save_local_gemini_key(value: str) -> None:
    path = _gemini_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    protected = base64.b64encode(_protect(value.strip().encode('utf-8')))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(protected)
        os.replace(temporary, path)
        if os.name != 'nt':
            try:
                path.chmod(0o600)
            except OSError:
                pass
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def load_local_gemini_key() -> str | None:
    path = _gemini_path()
    if not path.exists():
        return None
    try:
        return _unprotect(base64.b64decode(path.read_bytes())).decode('utf-8').strip() or None
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def _livekit_path() -> Path:
    override = os.getenv("RESOLVEAI_LOCAL_LIVEKIT_FILE")
    return Path(override) if override else Path(os.getenv("LOCALAPPDATA") or Path.home()) / "ResolveAI" / "livekit.dpapi"


def save_local_livekit_config(values: dict) -> None:
    path = _livekit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    protected = base64.b64encode(_protect(json.dumps(values).encode("utf-8")))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(protected)
        os.replace(temporary, path)
        if os.name != 'nt':
            try:
                path.chmod(0o600)
            except OSError:
                pass
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def load_local_livekit_config() -> dict:
    path = _livekit_path()
    if not path.exists():
        return {}
    try:
        result = json.loads(_unprotect(base64.b64decode(path.read_bytes())))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError, UnicodeDecodeError):
        return {}
