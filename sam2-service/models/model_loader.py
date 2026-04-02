import os
import torch
import logging

logger = logging.getLogger(__name__)

_predictor = None
_model_loaded = False


def get_predictor():
    """Return the singleton MedSAM2 predictor, loading it on first call."""
    global _predictor, _model_loaded
    if _predictor is None:
        _predictor = _load_model()
        _model_loaded = _predictor is not None
    return _predictor


def is_model_loaded() -> bool:
    return _model_loaded


def _load_model():
    checkpoint = os.getenv(
        "MEDSAM2_CHECKPOINT",
        "/home/ubuntu/MedSAM2/checkpoints/MedSAM2_pretrain.pth"
    )
    config = os.getenv("MEDSAM2_CONFIG", "sam2.1_hiera_b+.yaml")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    if not os.path.exists(checkpoint):
        logger.error(
            f"MedSAM2 checkpoint not found at: {checkpoint}\n"
            "Service will return MOCK results until checkpoint is present.\n"
            "Fix: cd ~/MedSAM2 && bash download.sh"
        )
        return None

    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        logger.info(f"Loading MedSAM2 from {checkpoint} on {device}...")
        model = build_sam2(config, checkpoint, device=device)
        predictor = SAM2ImagePredictor(model)
        logger.info("MedSAM2 loaded successfully.")
        return predictor
    except Exception as e:
        logger.error(f"Failed to load MedSAM2: {e}")
        return None
