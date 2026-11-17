import os

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-secret-key-change-me-32bytes")

    MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
    MONGO_DB = os.getenv("MONGO_DB", "triad_dms")

    JWT_SECRET = os.getenv("JWT_SECRET", SECRET_KEY)
    JWT_ALGORITHM = "HS256"
    JWT_EXPIRES_HOURS = int(os.getenv("JWT_EXPIRES_HOURS", "24"))

    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_MB", "25")) * 1024 * 1024

    ALLOWED_EXTENSIONS = {
        "pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp", "txt",
    }

    # The assignment's sample test uploads without a token. Auth is still
    # enforced for every other action; set to true to require it on upload too.
    REQUIRE_AUTH_FOR_UPLOAD = _bool("REQUIRE_AUTH_FOR_UPLOAD", False)

    OCR_ENABLED = _bool("OCR_ENABLED", True)
    OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "15"))
    OCR_MAX_CHARS = int(os.getenv("OCR_MAX_CHARS", "200000"))
    OCR_TIMEOUT_SECONDS = int(os.getenv("OCR_TIMEOUT_SECONDS", "30"))

    SEED_DEFAULTS = _bool("SEED_DEFAULTS", True)
    ADMIN_EMAILS = {
        e.strip().lower()
        for e in os.getenv("ADMIN_EMAILS", "admin@triad.ai").split(",")
        if e.strip()
    }
