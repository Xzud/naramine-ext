from __future__ import annotations

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx


@dataclass(slots=True)
class ModalTTSRequest:
    text: str
    voice: str
    format: str


@dataclass(slots=True)
class StreamingModalTTSResponse:
    stream: AsyncIterator[bytes]
    content_type: str
    close: Callable[[], Awaitable[None]]


class ModalKokoroClient:
    def __init__(self, endpoint_url: str | None = None, token: str | None = None) -> None:
        self.endpoint_url = endpoint_url or os.getenv("MODAL_TTS_URL", "")
        self.token = token or os.getenv("MODAL_TTS_TOKEN", "")

    def _build_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _build_payload(self, request: ModalTTSRequest) -> dict[str, str]:
        return {
            "text": request.text,
            "voice": request.voice,
            "format": request.format,
        }

    async def synthesize(self, request: ModalTTSRequest) -> tuple[bytes, str]:
        if not self.endpoint_url:
            raise RuntimeError("MODAL_TTS_URL is not configured")

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                self.endpoint_url,
                headers=self._build_headers(),
                json=self._build_payload(request),
            )
            response.raise_for_status()
            return response.content, response.headers.get("content-type", f"audio/{request.format}")

    async def stream_synthesize(self, request: ModalTTSRequest) -> StreamingModalTTSResponse:
        if not self.endpoint_url:
            raise RuntimeError("MODAL_TTS_URL is not configured")

        client = httpx.AsyncClient(timeout=120.0)
        response = await client.send(
            client.build_request(
                "POST",
                self.endpoint_url,
                headers=self._build_headers(),
                json=self._build_payload(request),
            ),
            stream=True,
        )
        response.raise_for_status()

        async def close() -> None:
            await response.aclose()
            await client.aclose()

        return StreamingModalTTSResponse(
            stream=response.aiter_bytes(),
            content_type=response.headers.get("content-type", f"audio/{request.format}"),
            close=close,
        )
