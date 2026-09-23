"""
Main FastAPI server initialization.
"""

import asyncio
from contextlib import asynccontextmanager
from importlib import import_module

# Resolve optional runtime dependencies dynamically so static analysis does not
# require FastAPI to be installed in its inspection environment.
FastAPI = import_module("fastapi").FastAPI
CORSMiddleware = import_module("fastapi.middleware.cors").CORSMiddleware

from .api.live import router as live_router
from .api.live import transfer_hub
from .api.routes import router
from .storage.db import init_db


@asynccontextmanager
async def lifespan(_app):
    init_db()
    transfer_hub.bind(asyncio.get_running_loop())
    yield


app = FastAPI(
    title="NetTransfer API",
    description="HTTP Control Plane for the NetTransfer TCP File System",
    version="0.1.0",
    lifespan=lifespan,
)

# Enable CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(live_router)


@app.get("/")
def health_check():
    return {"status": "ok", "service": "NetTransfer Control Plane"}