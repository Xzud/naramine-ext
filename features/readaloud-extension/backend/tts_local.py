from __future__ import annotations

import os
from dataclasses import dataclass

import httpx


@dataclass(slots=True)
class TTSRequest:
    text: str
    voice: str
    format: str


class LocalKokoroClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or os.getenv("LOCAL_KOKORO_URL") or "http://localhost:8880").rstrip("/")

    async def synthesize(self, request: TTSRequest) -> tuple[bytes, str]:
        response_format = "wav" if request.format == "webm" else request.format
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json={
                    "model": "kokoro",
                    "voice": request.voice,
                    "input": request.text,
                    "response_format": response_format,
                },
            )
            response.raise_for_status()
            return response.content, response.headers.get("content-type", f"audio/{response_format}")
