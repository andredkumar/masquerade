from fastapi import APIRouter
import torch
from models.model_loader import is_model_loaded, loaded_checkpoints

router = APIRouter()


@router.get("/health")
def health():
    gpu = torch.cuda.is_available()
    device = torch.cuda.get_device_name(0) if gpu else "cpu"
    return {
        "status": "ok",
        "model_loaded": is_model_loaded(),
        "loaded_checkpoints": loaded_checkpoints(),
        "gpu_available": gpu,
        "device": device,
    }
