import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes.health import router as health_router
from routes.segment import router as segment_router
from models.model_loader import get_predictor

logging.basicConfig(level=os.getenv("LOG_LEVEL", "info").upper())
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up — loading MedSAM2...")
    get_predictor()
    yield
    logger.info("Shutting down.")


app = FastAPI(title="Masquerade MedSAM2 Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # TODO: lock down to app EC2 IP in production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(segment_router)
