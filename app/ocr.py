"""Text extraction / OCR pipeline.

Strategy:
* Digital PDFs -> embedded text layer (pypdf), no OCR needed.
* Scanned PDFs -> render pages with PyMuPDF, then OCR with Tesseract.
* Images -> Tesseract OCR.

If the Tesseract binary is unavailable (e.g. bare local Windows install),
the upload still succeeds and the OCR status is reported as ``unavailable``.
The Docker image ships Tesseract so full OCR works in the reference setup.
"""
import io
import logging
import os
import shutil
from functools import lru_cache

from flask import current_app

log = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"}


@lru_cache(maxsize=1)
def _configure_tesseract() -> bool:
    try:
        import pytesseract
    except ImportError:
        return False
    cmd = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    if not cmd and os.name == "nt":
        candidates = (
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        )
        cmd = next((path for path in candidates if os.path.isfile(path)), None)
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    return True


@lru_cache(maxsize=1)
def tesseract_available() -> bool:
    try:
        import pytesseract

        _configure_tesseract()
        pytesseract.get_tesseract_version()
        return True
    except Exception:  # binary missing or not executable
        return False


def _normalize(text: str, max_chars: int) -> str:
    text = (text or "").replace("\x00", " ")
    return " ".join(text.split())[:max_chars]


def _extract_pdf_text(data: bytes, max_chars: int) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        chunks = []
        for page in reader.pages[: current_app.config["OCR_MAX_PAGES"]]:
            chunks.append(page.extract_text() or "")
        return _normalize("\n".join(chunks), max_chars)
    except Exception as exc:
        log.info("PDF text layer extraction failed: %s", exc)
        return ""


def _ocr_pdf(data: bytes, max_chars: int) -> str:
    try:
        import pymupdf as fitz
    except ImportError:  # older PyMuPDF releases
        import fitz
    import pytesseract
    from PIL import Image

    doc = fitz.open(stream=data, filetype="pdf")
    chunks = []
    try:
        for page in doc[: current_app.config["OCR_MAX_PAGES"]]:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            image = Image.open(io.BytesIO(pix.tobytes("png")))
            chunks.append(
                pytesseract.image_to_string(
                    image, timeout=current_app.config["OCR_TIMEOUT_SECONDS"]
                )
            )
            if sum(len(c) for c in chunks) >= max_chars:
                break
    finally:
        doc.close()
    return _normalize("\n".join(chunks), max_chars)


def _ocr_image(data: bytes, max_chars: int) -> str:
    import pytesseract
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    text = pytesseract.image_to_string(
        image, timeout=current_app.config["OCR_TIMEOUT_SECONDS"]
    )
    return _normalize(text, max_chars)


def process_file(data: bytes, filename: str) -> dict:
    """Return ``{text, status, engine}`` for the uploaded file."""
    cfg = current_app.config
    if not cfg.get("OCR_ENABLED", True):
        return {"text": "", "status": "skipped", "engine": ""}

    max_chars = cfg["OCR_MAX_CHARS"]
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext == "txt":
        try:
            return {
                "text": _normalize(data.decode("utf-8", errors="replace"), max_chars),
                "status": "extracted",
                "engine": "plaintext",
            }
        except Exception as exc:
            log.warning("text extraction failed: %s", exc)
            return {"text": "", "status": "failed", "engine": "plaintext"}

    if ext == "pdf":
        text = _extract_pdf_text(data, max_chars)
        if len(text) >= 20:
            return {"text": text, "status": "extracted", "engine": "pdf-text"}
        if not tesseract_available():
            return {
                "text": text,
                "status": "unavailable" if not text else "extracted",
                "engine": "pdf-text",
            }
        try:
            text = _ocr_pdf(data, max_chars)
            return {"text": text, "status": "ocr" if text else "empty", "engine": "tesseract"}
        except Exception as exc:
            log.warning("PDF OCR failed: %s", exc)
            return {"text": "", "status": "failed", "engine": "tesseract"}

    if ext in IMAGE_EXTENSIONS:
        if not tesseract_available():
            return {"text": "", "status": "unavailable", "engine": "tesseract"}
        try:
            text = _ocr_image(data, max_chars)
            return {"text": text, "status": "ocr" if text else "empty", "engine": "tesseract"}
        except Exception as exc:
            log.warning("image OCR failed: %s", exc)
            return {"text": "", "status": "failed", "engine": "tesseract"}

    return {"text": "", "status": "skipped", "engine": ""}


def make_thumbnail(data: bytes, filename: str, max_size: int = 320) -> bytes | None:
    """Render a small JPEG preview: first PDF page or the image itself."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    try:
        from PIL import Image, ImageOps

        if ext == "pdf":
            try:
                import pymupdf as fitz
            except ImportError:  # older PyMuPDF releases
                import fitz

            document = fitz.open(stream=data, filetype="pdf")
            try:
                if document.page_count == 0:
                    return None
                pix = document.load_page(0).get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
                image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            finally:
                document.close()
        elif ext in IMAGE_EXTENSIONS:
            image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        else:
            return None

        image.thumbnail((max_size, max_size))
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=72, optimize=True)
        return out.getvalue()
    except Exception as exc:
        log.info("thumbnail generation skipped for %s: %s", filename, exc)
        return None
