from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from tts_local import LocalKokoroClient, TTSRequest
from tts_modal import ModalKokoroClient, ModalTTSRequest

app = FastAPI(title="Readaloud MVP Backend", version="0.2.0")


class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str = Field(default="af_heart", min_length=1)
    format: str = Field(default="wav", pattern="^(wav|opus|webm)$")


def get_mode() -> str:
    return os.getenv("TTS_MODE", "local").strip().lower() or "local"


async def synthesize_audio(text: str, voice: str, format_name: str) -> tuple[bytes, str]:
    if get_mode() == "modal":
        return await ModalKokoroClient().synthesize(
            ModalTTSRequest(text=text, voice=voice, format=format_name)
        )

    return await LocalKokoroClient().synthesize(
        TTSRequest(text=text, voice=voice, format=format_name)
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "mode": get_mode()}


@app.post("/tts")
async def tts(body: TTSBody) -> Response:
    try:
        content, content_type = await synthesize_audio(body.text, body.voice, body.format)
    except Exception as exc:  # pragma: no cover - passthrough for network/provider failures
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Response(content=content, media_type=content_type)


@app.post("/tts/stream")
async def tts_stream(body: TTSBody) -> StreamingResponse:
    try:
        if get_mode() == "modal":
            result = await ModalKokoroClient().stream_synthesize(
                ModalTTSRequest(text=body.text, voice=body.voice, format=body.format)
            )
        else:
            result = await LocalKokoroClient().stream_synthesize(
                TTSRequest(text=body.text, voice=body.voice, format=body.format)
            )
    except Exception as exc:  # pragma: no cover - passthrough for network/provider failures
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return StreamingResponse(
        result.stream,
        media_type=result.content_type,
        background=BackgroundTask(result.close),
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("APP_HOST", "127.0.0.1"), port=int(os.getenv("APP_PORT", "3000")))
