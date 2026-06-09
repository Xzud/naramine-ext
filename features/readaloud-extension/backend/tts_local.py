from __future__ import annotations

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx


@dataclass(slots=True)
class TTSRequest:
    text: str
    voice: str
    format: str


@dataclass(slots=True)
class StreamingTTSResponse:
    stream: AsyncIterator[bytes]
    content_type: str
    close: Callable[[], Awaitable[None]]


class LocalKokoroClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or os.getenv("LOCAL_KOKORO_URL") or "http://localhost:8880").rstrip("/")

    def _build_payload(self, request: TTSRequest) -> dict[str, str]:
        response_format = "wav" if request.format == "webm" else request.format
        return {
            "model": "kokoro",
            "voice": request.voice,
            "input": request.text,
            "response_format": response_format,
        }

    async def synthesize(self, request: TTSRequest) -> tuple[bytes, str]:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self.base_url}/v1/audio/speech",
                json=self._build_payload(request),
            )
            response.raise_for_status()
            response_format = "wav" if request.format == "webm" else request.format
            return response.content, response.headers.get("content-type", f"audio/{response_format}")

    async def stream_synthesize(self, request: TTSRequest) -> StreamingTTSResponse:
        client = httpx.AsyncClient(timeout=120.0)
        response = await client.send(
            client.build_request(
                "POST",
                f"{self.base_url}/v1/audio/speech",
                json=self._build_payload(request),
            ),
            stream=True,
        )
        response.raise_for_status()

        async def close() -> None:
            await response.aclose()
            await client.aclose()

        return StreamingTTSResponse(
            stream=response.aiter_bytes(),
            content_type=response.headers.get("content-type", f"audio/{request.format}"),
            close=close,
        )
