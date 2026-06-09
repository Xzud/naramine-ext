from __future__ import annotations

import os
from dataclasses import dataclass

import httpx


@dataclass(slots=True)
class ModalTTSRequest:
    text: str
    voice: str
    format: str


class ModalKokoroClient:
    def __init__(self, endpoint_url: str | None = None, token: str | None = None) -> None:
        self.endpoint_url = endpoint_url or os.getenv("MODAL_TTS_URL", "")
        self.token = token or os.getenv("MODAL_TTS_TOKEN", "")

    async def synthesize(self, request: ModalTTSRequest) -> tuple[bytes, str]:
        if not self.endpoint_url:
            raise RuntimeError("MODAL_TTS_URL is not configured")

        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                self.endpoint_url,
                headers=headers,
                json={
                    "text": request.text,
                    "voice": request.voice,
                    "format": request.format,
                },
            )
            response.raise_for_status()
            return response.content, response.headers.get("content-type", f"audio/{request.format}")
