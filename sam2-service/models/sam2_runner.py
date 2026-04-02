import numpy as np
import logging
from models.model_loader import get_predictor, is_model_loaded
from utils.image_utils import mask_to_rgba_overlay, numpy_to_b64, auto_bbox_from_image

logger = logging.getLogger(__name__)


def run_segmentation(image_rgb: np.ndarray, bbox=None, points=None,
                     use_auto_prompt: bool = True) -> dict:
    """
    Run MedSAM2 segmentation on a single RGB frame.

    Prompt priority:
      1. bbox  — best results, MedSAM2 was trained heavily on bounding boxes
      2. points — acceptable but lower quality for medical images
      3. auto center-region bbox — reasonable fallback for POCUS (use_auto_prompt=True)

    Returns mock result if model is not loaded (checkpoint missing).
    """
    predictor = get_predictor()
    if predictor is None or not is_model_loaded():
        return _mock_result(image_rgb)

    try:
        predictor.set_image(image_rgb)
        h, w = image_rgb.shape[:2]

        if bbox is not None:
            box_np = np.array([bbox.x1, bbox.y1, bbox.x2, bbox.y2], dtype=np.float32)
            masks, scores, _ = predictor.predict(
                box=box_np,
                multimask_output=False,
            )
        elif points and len(points) > 0:
            pt_coords = np.array([[p.x, p.y] for p in points])
            pt_labels = np.array([p.label for p in points])
            masks, scores, _ = predictor.predict(
                point_coords=pt_coords,
                point_labels=pt_labels,
                multimask_output=True,
            )
        elif use_auto_prompt:
            box_np = auto_bbox_from_image(h, w, margin=0.2)
            masks, scores, _ = predictor.predict(
                box=box_np,
                multimask_output=False,
            )
        else:
            return {
                "success": False,
                "error": "No prompt provided and use_auto_prompt is False",
                "mock": False,
            }

        best_idx = int(np.argmax(scores))
        best_mask = masks[best_idx].astype(np.uint8)
        confidence = float(scores[best_idx])

        overlay = mask_to_rgba_overlay(image_rgb, best_mask)

        return {
            "success": True,
            "mask_b64": numpy_to_b64(best_mask * 255),
            "overlay_b64": numpy_to_b64(overlay),
            "confidence": confidence,
            "mock": False,
        }
    except Exception as e:
        logger.error(f"MedSAM2 inference error: {e}")
        return {"success": False, "error": str(e), "mock": False}


def _mock_result(image_rgb: np.ndarray) -> dict:
    """
    Return an obviously fake ellipse mask when the model is not loaded.
    The orange color and confidence=0.0 make it visually clear this is a mock.
    """
    h, w = image_rgb.shape[:2]
    mock_mask = np.zeros((h, w), dtype=np.uint8)
    cy, cx = h // 2, w // 2
    ry, rx = h // 5, w // 5
    Y, X = np.ogrid[:h, :w]
    ellipse = ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1
    mock_mask[ellipse] = 255
    overlay = mask_to_rgba_overlay(image_rgb, mock_mask, color=(255, 100, 0), alpha=0.5)
    return {
        "success": True,
        "mask_b64": numpy_to_b64(mock_mask),
        "overlay_b64": numpy_to_b64(overlay),
        "confidence": 0.0,
        "mock": True,
    }
