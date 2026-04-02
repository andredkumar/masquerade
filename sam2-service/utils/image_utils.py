import base64
import numpy as np
from PIL import Image
import io


def b64_to_numpy(b64_string: str) -> np.ndarray:
    """Decode base64 image string to RGB numpy array."""
    if "," in b64_string:
        b64_string = b64_string.split(",", 1)[1]
    img_bytes = base64.b64decode(b64_string)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    return np.array(img)


def numpy_to_b64(arr: np.ndarray, fmt: str = "PNG") -> str:
    """Encode numpy array (H,W) or (H,W,C) to base64 PNG string."""
    if arr.dtype != np.uint8:
        arr = (arr * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def mask_to_rgba_overlay(image_rgb: np.ndarray, mask: np.ndarray,
                          color=(0, 255, 100), alpha=0.4) -> np.ndarray:
    """Blend a binary mask onto the source image as a colored overlay."""
    overlay = image_rgb.copy().astype(np.float32)
    for c, val in enumerate(color):
        overlay[mask > 0, c] = overlay[mask > 0, c] * (1 - alpha) + val * alpha
    return overlay.clip(0, 255).astype(np.uint8)


def auto_bbox_from_image(h: int, w: int, margin: float = 0.2) -> np.ndarray:
    """
    Generate a center-region bounding box as a fallback prompt.
    margin=0.2 means the box covers the middle 60% of the image.
    For POCUS, the region of interest is almost always center-frame.
    """
    x1 = int(w * margin)
    y1 = int(h * margin)
    x2 = int(w * (1 - margin))
    y2 = int(h * (1 - margin))
    return np.array([x1, y1, x2, y2], dtype=np.float32)
