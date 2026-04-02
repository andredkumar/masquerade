from fastapi import APIRouter, HTTPException
from schemas.requests import SegmentRequest
from models.sam2_runner import run_segmentation
from utils.image_utils import b64_to_numpy
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/segment")
def segment(req: SegmentRequest):
    try:
        image_rgb = b64_to_numpy(req.image_b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")

    result = run_segmentation(
        image_rgb=image_rgb,
        bbox=req.bbox,
        points=req.points,
        use_auto_prompt=req.use_auto_prompt,
    )

    return {
        "job_id": req.job_id,
        "target": req.target,
        **result,
    }
