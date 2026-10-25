"""
Main FastAPI server initialization.
"""

import asyncio
import sys
from contextlib import asynccontextmanager
from importlib import import_module

# Resolve optional runtime dependencies dynamically so static analysis does not
# require FastAPI to be installed in its inspection environment.
FastAPI = import_module("fastapi").FastAPI
CORSMiddleware = import_module("fastapi.middleware.cors").CORSMiddleware

from .api.live import router as live_router
from .api.live import transfer_hub
from .api.routes import router
from .api.telemetry import router as telemetry_router
from .storage.db import init_db
from .telemetry.hub import telemetry_hub
from .telemetry.link import TELEMETRY_HOST, TELEMETRY_PORT, serve_ingest


@asynccontextmanager
async def lifespan(_app):
    init_db()
    loop = asyncio.get_running_loop()
    transfer_hub.bind(loop)
    telemetry_hub.bind(loop)

    # The TCP server process links here to feed /ws/telemetry. If the port is
    # taken (a second worker, a stale process) the API still starts.
    ingest = None
    try:
        ingest = await serve_ingest(telemetry_hub)
        print(f"[*] Telemetry ingest listening on {TELEMETRY_HOST}:{TELEMETRY_PORT}")
    except OSError as err:
        print(f"[!] Telemetry ingest unavailable on port {TELEMETRY_PORT}: {err}", file=sys.stderr)

    try:
        yield
    finally:
        if ingest is not None:
            ingest.close()
        await telemetry_hub.close()


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
app.include_router(telemetry_router)


@app.get("/")
def health_check():
    return {"status": "ok", "service": "NetTransfer Control Plane"}