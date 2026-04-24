from pydantic import BaseModel
from typing import Optional, List, Literal


class Point(BaseModel):
    x: float
    y: float
    label: int = 1  # 1 = foreground, 0 = background


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


# Imaging modality — drives checkpoint routing in model_loader.
# Must match the values accepted by the frontend selector.
Modality = Literal["cardiac", "lung", "abdominal", "other"]


class SegmentRequest(BaseModel):
    job_id: str
    image_b64: str                          # base64-encoded PNG or JPEG frame
    target: str                             # e.g. "pleural effusion", "b-lines"
    modality: Optional[Modality] = None     # selects which MedSAM2 checkpoint to use
    bbox: Optional[BoundingBox] = None      # preferred prompt for MedSAM2
    points: Optional[List[Point]] = None    # fallback if no bbox provided
    use_auto_prompt: bool = True            # auto-generate center bbox if nothing provided
