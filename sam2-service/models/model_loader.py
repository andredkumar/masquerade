"""
Multi-checkpoint MedSAM2 loader.

Loads every available checkpoint at startup and keeps a dict of predictors
keyed by checkpoint filename. `get_predictor_for_modality(modality)` returns
the predictor that best matches the requested imaging modality, falling back
to MedSAM2_latest.pt when the exact checkpoint is missing.

Routing table (hard-coded, matches the UI selector):
    "cardiac"   → MedSAM2_US_Heart.pt
    "lung"      → MedSAM2_2411.pt
    "abdominal" → MedSAM2_2411.pt
    "other"     → MedSAM2_latest.pt
    None/missing → MedSAM2_latest.pt  (safe fallback)

Priority order if GPU memory is tight — attempted in this order, warns for any
that fail to load:
    1. MedSAM2_2411.pt
    2. MedSAM2_US_Heart.pt
    3. MedSAM2_latest.pt
"""

import os
import logging
from typing import Dict, Optional

import torch

logger = logging.getLogger(__name__)

# ── Checkpoint discovery ───────────────────────────────────────────

CHECKPOINT_DIR = os.getenv(
    "MEDSAM2_CHECKPOINT_DIR",
    "/home/ubuntu/MedSAM2/checkpoints",
)
CONFIG = os.getenv("MEDSAM2_CONFIG", "sam2.1_hiera_b+.yaml")

# Priority order for loading. Earlier entries try first, so if GPU memory is
# constrained the most-useful ones are more likely to succeed.
_CHECKPOINT_PRIORITY = [
    "MedSAM2_2411.pt",
    "MedSAM2_US_Heart.pt",
    "MedSAM2_latest.pt",
]

# Modality → checkpoint mapping. Unmapped modalities fall through to the
# "latest" safe fallback.
_MODALITY_TO_CHECKPOINT = {
    "cardiac":   "MedSAM2_US_Heart.pt",
    "lung":      "MedSAM2_2411.pt",
    "abdominal": "MedSAM2_2411.pt",
    "other":     "MedSAM2_latest.pt",
}

_FALLBACK_CHECKPOINT = "MedSAM2_latest.pt"

# ── Internal state ────────────────────────────────────────────────

_predictors: Dict[str, object] = {}  # checkpoint filename → predictor


# ── Public API ────────────────────────────────────────────────────

def load_all_checkpoints() -> None:
    """Called once at startup. Loads every checkpoint we can find."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(f"Loading MedSAM2 checkpoints from {CHECKPOINT_DIR} on {device}...")

    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as e:
        logger.error(
            f"sam2 package not importable ({e}). Service will serve MOCK results "
            "until the sam2 Python package is installed on the GPU instance."
        )
        return

    for filename in _CHECKPOINT_PRIORITY:
        ckpt_path = os.path.join(CHECKPOINT_DIR, filename)
        if not os.path.exists(ckpt_path):
            logger.warning(f"⚠️  Checkpoint not found: {ckpt_path} (skipping)")
            continue
        try:
            logger.info(f"Loading {filename}...")
            model = build_sam2(CONFIG, ckpt_path, device=device)
            predictor = SAM2ImagePredictor(model)
            _predictors[filename] = predictor
            logger.info(f"✅ Loaded {filename}")
        except Exception as e:  # noqa: BLE001 — we intentionally catch all for diagnostics
            logger.warning(f"⚠️  Failed to load {filename}: {e}")

    if not _predictors:
        logger.error(
            "No MedSAM2 checkpoints loaded. Service will return MOCK results "
            "until at least one checkpoint is present and loadable."
        )
    else:
        logger.info(
            f"MedSAM2 ready with {len(_predictors)} checkpoint(s): "
            f"{sorted(_predictors.keys())}"
        )


def get_predictor_for_modality(modality: Optional[str]) -> (tuple):
    """
    Look up a predictor by modality. Returns (predictor, checkpoint_filename)
    or (None, None) if no checkpoint is loaded at all.

    Falls back through:
      1. exact modality mapping
      2. MedSAM2_latest.pt
      3. any loaded checkpoint (in priority order)
    """
    if not _predictors:
        return None, None

    # Step 1: try the exact mapping
    if modality and modality in _MODALITY_TO_CHECKPOINT:
        target = _MODALITY_TO_CHECKPOINT[modality]
        if target in _predictors:
            return _predictors[target], target

    # Step 2: fall back to the "latest" general-purpose checkpoint
    if _FALLBACK_CHECKPOINT in _predictors:
        return _predictors[_FALLBACK_CHECKPOINT], _FALLBACK_CHECKPOINT

    # Step 3: any loaded checkpoint, preferring higher-priority ones
    for filename in _CHECKPOINT_PRIORITY:
        if filename in _predictors:
            return _predictors[filename], filename

    # Exhausted
    return None, None


def is_model_loaded() -> bool:
    """Back-compat boolean — true iff at least one predictor is loaded."""
    return len(_predictors) > 0


def loaded_checkpoints() -> list:
    """Diagnostic for /health: sorted list of checkpoint filenames currently in memory."""
    return sorted(_predictors.keys())


# ── Back-compat shims ─────────────────────────────────────────────
# Older code paths may still reference `get_predictor()` with no args.
# Route them to the fallback modality so nothing breaks on deploy.

def get_predictor():
    predictor, _ = get_predictor_for_modality(None)
    return predictor
