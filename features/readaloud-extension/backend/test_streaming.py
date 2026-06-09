from __future__ import annotations

import asyncio
import unittest

from fastapi.responses import StreamingResponse

import app
from tts_local import StreamingTTSResponse


class StreamingBackendTests(unittest.TestCase):
    def test_tts_stream_returns_streaming_response(self) -> None:
        async def fake_stream() -> object:
            yield b"chunk-1"
            yield b"chunk-2"

        closed = {"value": False}

        async def fake_close() -> None:
            closed["value"] = True

        async def fake_stream_synthesize(_self, _request):
            return StreamingTTSResponse(
                stream=fake_stream(),
                content_type="audio/wav",
                close=fake_close,
            )

        original_mode = app.get_mode
        original_stream = app.LocalKokoroClient.stream_synthesize
        app.get_mode = lambda: "local"
        app.LocalKokoroClient.stream_synthesize = fake_stream_synthesize

        try:
            response = asyncio.run(
                app.tts_stream(app.TTSBody(text="Hello", voice="af_heart", format="wav"))
            )
            self.assertIsInstance(response, StreamingResponse)
            self.assertEqual(response.media_type, "audio/wav")

            async def collect() -> list[bytes]:
                return [chunk async for chunk in response.body_iterator]

            chunks = asyncio.run(collect())
            self.assertEqual(chunks, [b"chunk-1", b"chunk-2"])
            asyncio.run(response.background())
            self.assertTrue(closed["value"])
        finally:
            app.get_mode = original_mode
            app.LocalKokoroClient.stream_synthesize = original_stream


if __name__ == "__main__":
    unittest.main()
