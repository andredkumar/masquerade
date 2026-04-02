#!/bin/bash
# Run on GPU instance (18.222.109.87)
# Prereq: conda activate medsam2

export MEDSAM2_CHECKPOINT=/home/ubuntu/MedSAM2/checkpoints/MedSAM2_pretrain.pth
export MEDSAM2_CONFIG=sam2.1_hiera_b+.yaml
export PORT=8000
export LOG_LEVEL=info

cd /home/ubuntu/sam2-service
uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1 --log-level $LOG_LEVEL
