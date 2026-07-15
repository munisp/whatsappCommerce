"""Image preprocessing utilities."""
import io
import base64
from PIL import Image, ImageOps
import structlog

from .config import settings

log = structlog.get_logger(__name__)


def resize_for_vlm(image_bytes: bytes) -> bytes:
    """
    Resize image to max dimension while preserving aspect ratio.
    Converts to JPEG for consistent encoding.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img = ImageOps.exif_transpose(img)  # fix EXIF rotation (mobile photos)

        max_dim = settings.max_image_dimension
        w, h = img.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            new_w, new_h = int(w * scale), int(h * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            log.debug("image_resized", original=(w, h), resized=(new_w, new_h))

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90, optimize=True)
        return buf.getvalue()
    except Exception as exc:
        log.error("image_resize_failed", error=str(exc))
        return image_bytes


def image_to_base64(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


def get_image_dimensions(image_bytes: bytes) -> tuple[int, int]:
    try:
        img = Image.open(io.BytesIO(image_bytes))
        return img.size  # (width, height)
    except Exception:
        return (0, 0)
