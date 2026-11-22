# -*- coding: utf-8 -*-
"""Голосовой движок тренажёра — Silero TTS в отдельном процессе.

Запускается автоматически из server.py интерпретатором из D:\\AI CENTR\\tts\\.venv
(там уже стоят torch + torchaudio + кэш Silero). Держит модель в памяти,
поэтому первая фраза ~2-4 с, следующие — доли секунды.

Слушает только 127.0.0.1:50556.
    GET  /health          -> {"ready": true, "voices": [...]}
    GET  /voices          -> {"voices": [...]}
    POST /say {"text": "...", "voice": "baya"} -> audio/wav
"""
import io
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 50556
SAMPLE_RATE = 48000
VOICES = ["baya", "aidar", "baritone", "kseniya", "xenia", "eugene"]
BASE_VOICES = ["baya", "aidar", "kseniya", "xenia", "eugene"]

_model = None
_lock = threading.Lock()
_load_error = None


def log(msg):
    print(msg, flush=True)


def load_model():
    global _model, _load_error
    try:
        import torch
        log("silero: загружаю модель …")
        model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-models",
            model="silero_tts",
            language="ru",
            speaker="v3_1_ru",
            trust_repo=True,
        )
        _model = model
        log("silero: модель готова")
    except Exception:
        _load_error = traceback.format_exc()
        log(_load_error)


def synth(text, voice):
    import torch
    import torchaudio

    if voice not in VOICES:
        voice = "baya"
    base = voice
    out_rate = SAMPLE_RATE
    if voice == "baritone":          # низкий мужской: Айдар, на 3 полутона ниже
        base = "aidar"
        out_rate = int(round(SAMPLE_RATE * 2 ** (-3 / 12.0)))
    with _lock:
        audio = _model.apply_tts(text=text, speaker=base, sample_rate=SAMPLE_RATE)
    buf = io.BytesIO()
    torchaudio.save(buf, audio.unsqueeze(0), out_rate,
                    format="wav", encoding="PCM_S", bits_per_sample=16)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/voices"):
            self._json(200, {"ready": _model is not None,
                             "voices": VOICES,
                             "error": bool(_load_error)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/say":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        if _model is None:
            return self._json(503, {"error": "голос ещё загружается"})
        text = str(payload.get("text", "")).strip()
        if not text:
            return self._json(400, {"error": "пустой текст"})
        voice = str(payload.get("voice", "baya")).strip().lower()
        try:
            wav = synth(text[:1200], voice)
            self._send(200, wav, "audio/wav")
        except Exception:
            log(traceback.format_exc())
            self._json(500, {"error": "ошибка синтеза"})


def main():
    threading.Thread(target=load_model, daemon=True).start()
    log("silero-сервер слушает 127.0.0.1:%d" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
