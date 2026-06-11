"""Kokoro TTS served from Modal.com.

Deploy:
    modal deploy kokoro_modal_app.py

The deployed endpoint accepts the same payload the FastAPI proxy sends in
modal mode ({"text", "voice", "format"}) and streams a WAV response, so the
proxy needs only:

    TTS_MODE=modal
    MODAL_TTS_URL=<deployed endpoint URL>
    MODAL_TTS_TOKEN=<value of TTS_TOKEN in the kokoro-tts-token Modal secret>

Auth is enforced only when the `kokoro-tts-token` secret defines TTS_TOKEN.
"""

from __future__ import annotations

import os
import struct

import modal

MODEL_REPO = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"
# Voices are prefixed with their language: af_/am_ American, bf_/bm_ British, etc.
SUPPORTED_LANG_CODES = set("ab")


def download_kokoro_assets() -> None:
    from kokoro import KPipeline

    pipeline = KPipeline(lang_code="a", repo_id=MODEL_REPO)
    pipeline.load_voice(DEFAULT_VOICE)


kokoro_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("espeak-ng")
    .pip_install(
        "kokoro==0.9.4",
        "soundfile",
        "numpy",
        "fastapi[standard]",
    )
    .env({"HF_HOME": "/cache/huggingface"})
    .run_function(download_kokoro_assets)
)

app = modal.App("readaloud-kokoro")

with kokoro_image.imports():
    import numpy as np
    import torch
    from fastapi import HTTPException, Request
    from fastapi.responses import StreamingResponse


def streaming_wav_header(sample_rate: int = SAMPLE_RATE, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """WAV header with a sentinel data size, for streams of unknown length."""
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = 0xFFFFFFFF - 36
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_size)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample)
        + b"data"
        + struct.pack("<I", data_size)
    )


def resolve_lang_code(voice: str) -> str:
    lang_code = (voice or DEFAULT_VOICE)[0].lower()
    return lang_code if lang_code in SUPPORTED_LANG_CODES else "a"


@app.cls(
    image=kokoro_image,
    gpu="T4",
    scaledown_window=240,
    secrets=[modal.Secret.from_name("kokoro-tts-token")],
)
@modal.concurrent(max_inputs=4)
class KokoroTTS:
    @modal.enter()
    def load(self) -> None:
        from kokoro import KPipeline

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.pipelines = {}
        self.get_pipeline("a")

    def get_pipeline(self, lang_code: str):
        from kokoro import KPipeline

        if lang_code not in self.pipelines:
            self.pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id=MODEL_REPO, device=self.device)
        return self.pipelines[lang_code]

    def check_auth(self, request: "Request") -> None:
        expected = os.environ.get("TTS_TOKEN", "")
        if not expected:
            return
        provided = request.headers.get("authorization", "")
        if provided != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="Invalid or missing bearer token")

    @modal.fastapi_endpoint(method="POST")
    async def tts_stream(self, body: dict, request: "Request") -> "StreamingResponse":
        self.check_auth(request)

        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="text is required")
        if len(text) > 5000:
            raise HTTPException(status_code=422, detail="text exceeds the 5000 character limit")
        voice = body.get("voice") or DEFAULT_VOICE
        pipeline = self.get_pipeline(resolve_lang_code(voice))

        def generate():
            yield streaming_wav_header()
            for result in pipeline(text, voice=voice):
                audio = getattr(result, "audio", None)
                if audio is None:
                    continue
                samples = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
                pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2").tobytes()
                if pcm:
                    yield pcm

        return StreamingResponse(
            generate(),
            media_type="audio/wav",
            headers={"Cache-Control": "no-store"},
        )

    @modal.fastapi_endpoint(method="GET")
    async def health(self) -> dict:
        return {"status": "ok", "model": MODEL_REPO, "device": self.device}
