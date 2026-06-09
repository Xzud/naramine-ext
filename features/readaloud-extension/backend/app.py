from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from tts_local import LocalKokoroClient, TTSRequest
from tts_modal import ModalKokoroClient, ModalTTSRequest

app = FastAPI(title="Readaloud MVP Backend", version="0.1.0")


class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str = Field(default="af_heart", min_length=1)
    format: str = Field(default="wav", pattern="^(wav|opus|webm)$")


def get_mode() -> str:
    return os.getenv("TTS_MODE", "local").strip().lower() or "local"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "mode": get_mode()}


@app.post("/tts")
async def tts(body: TTSBody) -> Response:
    try:
        if get_mode() == "modal":
            content, content_type = await ModalKokoroClient().synthesize(
                ModalTTSRequest(text=body.text, voice=body.voice, format=body.format)
            )
        else:
            content, content_type = await LocalKokoroClient().synthesize(
                TTSRequest(text=body.text, voice=body.voice, format=body.format)
            )
    except Exception as exc:  # pragma: no cover - passthrough for network/provider failures
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Response(content=content, media_type=content_type)


if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("APP_HOST", "127.0.0.1"), port=int(os.getenv("APP_PORT", "3000")))
