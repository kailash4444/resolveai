import re
from pathlib import Path
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException

from realapp.config import Settings
from realapp.models import Attachment, CaseRecord


IMAGE_EXTENSIONS: dict[str, str] = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
}
VIDEO_EXTENSIONS: dict[str, str] = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
}
ALLOWED_EXTENSIONS: dict[str, str] = {**IMAGE_EXTENSIONS, **VIDEO_EXTENSIONS}
MAX_FILE_SIZE = 20 * 1024 * 1024
MAX_TOTAL_SIZE = 20 * 1024 * 1024
MAX_FILES_PER_REQUEST = 3


def is_image(filename: str) -> bool:
    return Path(filename).suffix.lower() in IMAGE_EXTENSIONS

_MEM_LOCK = RLock()
_MEMORY_STORAGE: dict[str, tuple[Attachment, bytes]] = {}


def sanitize_filename(filename: str) -> str:
    name = Path(filename).name
    clean = re.sub(r"[^a-zA-Z0-9._-]", "_", name).strip("._")
    return clean or "attachment"


def _matches_file_type(ext: str, content: bytes) -> bool:
    if ext == ".png": return content.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in {".jpg", ".jpeg"}: return content.startswith(b"\xff\xd8\xff")
    if ext == ".gif": return content.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp": return content.startswith(b"RIFF") and content[8:12] == b"WEBP"
    if ext == ".avi": return content.startswith(b"RIFF") and content[8:12] == b"AVI "
    if ext in {".mp4", ".mov", ".heic"}:
        if len(content) < 12 or content[4:8] != b"ftyp": return False
        brand = content[8:12]
        return ext != ".heic" or brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}
    if ext in {".webm", ".mkv"}: return content.startswith(b"\x1a\x45\xdf\xa3")
    return False


def validate_attachment(filename: str, content: bytes, content_type: str | None = None) -> tuple[str, str]:
    if not filename:
        raise HTTPException(400, "Attachment filename must not be empty.")
    if not content:
        raise HTTPException(400, f"Attachment '{filename}' is empty.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(413, f"Attachment '{filename}' exceeds the 20 MB per-file limit.")

    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS.keys()))
        raise HTTPException(415, f"File type '{ext}' is not supported. Allowed formats: {allowed}.")
    if not _matches_file_type(ext, content):
        raise HTTPException(415, f"Attachment '{filename}' does not appear to be a valid {ALLOWED_EXTENSIONS[ext]} file.")

    expected_mime = ALLOWED_EXTENSIONS[ext]
    supplied_mime = (content_type or "").split(";", 1)[0].strip().lower()
    if supplied_mime and supplied_mime not in {expected_mime, "application/octet-stream", "binary/octet-stream"}:
        raise HTTPException(415, f"Attachment type does not match its .{ext.lstrip('.')} extension.")
    return sanitize_filename(filename), expected_mime


def _local_storage_dir(settings: Settings) -> Path:
    base = Path(settings.local_data_path).expanduser().resolve().parent / "attachments"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _gcs_bucket(settings: Settings):
    if not settings.attachment_bucket:
        raise HTTPException(503, "Cloud attachment storage is not configured. Set ATTACHMENT_BUCKET to a private Google Cloud Storage bucket.")
    from google.cloud import storage
    return storage.Client(project=settings.google_cloud_project).bucket(settings.attachment_bucket)


def save_attachment(filename: str, content: bytes, content_type: str | None, settings: Settings) -> Attachment:
    clean_name, mime = validate_attachment(filename, content, content_type)
    att_id = f"ATT-{uuid4().hex[:8].upper()}"
    attachment = Attachment(id=att_id, filename=clean_name, content_type=mime, size_bytes=len(content), url=f"/api/attachments/{att_id}")

    if settings.data_backend == "memory":
        with _MEM_LOCK:
            _MEMORY_STORAGE[att_id] = (attachment, content)
    elif settings.data_backend == "firestore":
        try:
            blob = _gcs_bucket(settings).blob(f"attachments/{att_id}/{clean_name}")
            blob.upload_from_string(content, content_type=mime)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, "Could not store the attachment in Google Cloud Storage.") from exc
    else:
        try:
            (_local_storage_dir(settings) / f"{att_id}_{clean_name}").write_bytes(content)
        except OSError as exc:
            raise HTTPException(503, "Could not store the attachment on local disk.") from exc
    return attachment


def get_attachment_data(attachment_id: str, attachment: Attachment, settings: Settings) -> tuple[Attachment, bytes] | None:
    if settings.data_backend == "memory":
        with _MEM_LOCK:
            return _MEMORY_STORAGE.get(attachment_id)
    try:
        if settings.data_backend == "firestore":
            blob = _gcs_bucket(settings).blob(f"attachments/{attachment.id}/{attachment.filename}")
            if not blob.exists():
                return None
            content = blob.download_as_bytes()
        else:
            path = _local_storage_dir(settings) / f"{attachment.id}_{attachment.filename}"
            if not path.is_file():
                return None
            content = path.read_bytes()
        return attachment, content
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Could not retrieve the attachment from storage.") from exc


def find_case_for_attachment(attachment_id: str, store) -> CaseRecord | None:
    for case in store.list_cases():
        if any(att.id == attachment_id for att in case.ticket.attachments):
            return case
    return None
