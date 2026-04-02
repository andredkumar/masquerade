# MedSAM2 Service — Claude Code Context
## What this is
FastAPI service running MedSAM2 on the GPU instance (18.222.109.87).
Receives base64-encoded frames from the Node.js backend and returns segmentation masks.
MedSAM2 repo: https://github.com/bowang-lab/MedSAM2
## Stack
- Python 3.12 (required by MedSAM2)
- FastAPI + Uvicorn
- MedSAM2 (bowang-lab, Apache-2.0) installed as editable package from ~/MedSAM2
- PyTorch 2.5.1 + CUDA 12.4
- Pydantic v2
## Key conventions
- All images travel as base64 PNG strings — never written to disk (privacy-first)
- Every response includes a `job_id` so the Node.js backend can track async jobs
- Errors always return { success: false, error: "..." } — never raw 500 HTML
- MedSAM2 model is loaded ONCE at startup via singleton in model_loader.py
- Bounding box prompt preferred over point prompt — MedSAM2 was trained on bbox prompts
- If no bbox or points supplied, service auto-generates a center-region bbox
## Env vars required
MEDSAM2_CHECKPOINT=/home/ubuntu/MedSAM2/checkpoints/MedSAM2_pretrain.pth
MEDSAM2_CONFIG=sam2.1_hiera_b+.yaml
PORT=8000
LOG_LEVEL=info
## GPU instance setup (one-time, run manually over SSH)
conda create -n medsam2 python=3.12 -y
conda activate medsam2
pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124
git clone https://github.com/bowang-lab/MedSAM2.git ~/MedSAM2
cd ~/MedSAM2 && pip install -e ".[dev]"
bash download.sh   # pulls MedSAM2_pretrain.pth from HuggingFace into ~/MedSAM2/checkpoints/
cd ~/sam2-service && pip install -r requirements.txt
## Running
conda activate medsam2
bash start.sh
## Testing the endpoint (once running)
curl http://localhost:8000/health
