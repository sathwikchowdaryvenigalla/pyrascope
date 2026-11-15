"""PyraScope backend. Run from the project root:  uvicorn backend.main:app --reload --port 8000"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend import config
from backend.routers import gee, harmonization, history, impact
from backend.services.gee_service import gee_service

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    gee_service.initialize()  # once; failure is recorded, not fatal
    yield


app = FastAPI(title="PyraScope API", version="0.3.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins(),
                   allow_methods=["GET"], allow_headers=["*"])
app.include_router(gee.router)
app.include_router(harmonization.router)
app.include_router(impact.router)
app.include_router(history.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "earth_engine_initialized": gee_service.status()["earth_engine_initialized"]}
