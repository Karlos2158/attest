# -*- coding: utf-8 -*-
"""Тренажёр аттестации — локальный сервер.

Запуск: python server.py  (или start.bat)
Открыть: http://localhost:8765
"""
import atexit
import base64
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
DATA_FILE = ROOT / "data" / "questions.json"
STATIC = ROOT / "static"
LOG = ROOT / "logs" / "server.log"
SECRETS = ROOT / "data" / "secrets.json"

OLLAMA_URL = "http://192.168.1.199:11434/api/chat"
DEFAULT_MODEL = "qwen3:14b"
PORT = 8765

# Общий словарь произношения из проекта «Войс» (ударения и замены).
VOICE_DICT_DIR = Path(r"D:\AI CENTR\tts")
sys.path.insert(0, str(VOICE_DICT_DIR))
try:
    import voice_dict
except Exception:          # словарь не обязателен для работы тренажёра
    voice_dict = None

# Доступ с телефона в домашней сети: тот же сервер, но по HTTPS на 0.0.0.0.
# HTTP на localhost остаётся как был — ярлык на рабочем столе не меняется.
LAN_PORT = int(os.environ.get("ATTEST_LAN_PORT", "8766"))
LAN_ENABLED = os.environ.get("ATTEST_LAN", "1") != "0"
CERTS = ROOT / "certs"
CERT_FILE = CERTS / "server.crt"
KEY_FILE = CERTS / "server.key"
CA_FILE = CERTS / "ca.crt"

# Локальный голос (Silero) — отдельный процесс из окружения D:\AI CENTR\tts\.venv,
# модель держится в памяти. Запускается сам при старте сервера.
TTS_URL = "http://127.0.0.1:50556"
TTS_PY = Path(r"D:\AI CENTR\tts\.venv\Scripts\python.exe")
VOICE_SERVER = ROOT / "voice_server.py"
DEFAULT_VOICE = "baya"
_voice_proc = None
_voice_lock = threading.Lock()

DATA = json.loads(DATA_FILE.read_text(encoding="utf-8"))
QUESTIONS = DATA["questions"]
BY_ID = {q["id"]: q for q in QUESTIONS}


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_secrets() -> dict:
    try:
        return json.loads(SECRETS.read_text(encoding="utf-8"))
    except Exception:
        return {}


# ---------------------------------------------------------------- голос

def tts_health(timeout: float = 1.5):
    try:
        with urllib.request.urlopen(TTS_URL + "/health", timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def ensure_voice_server() -> bool:
    """Поднимает голосовой процесс, если он ещё не запущен. True — уже готов."""
    global _voice_proc
    health = tts_health()
    if health and health.get("ready"):
        return True
    with _voice_lock:
        health = tts_health()
        if health and health.get("ready"):
            return True
        if _voice_proc is not None and _voice_proc.poll() is None:
            return False
        if not TTS_PY.exists():
            log("голос: нет интерпретатора " + str(TTS_PY))
            return False
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        _voice_proc = subprocess.Popen(
            [str(TTS_PY), str(VOICE_SERVER)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        log("голос: запущен движок Silero (pid %d)" % _voice_proc.pid)
        atexit.register(_stop_voice_server)
        return False


def _stop_voice_server():
    if _voice_proc is not None and _voice_proc.poll() is None:
        try:
            _voice_proc.terminate()
        except Exception:
            pass


def wait_voice_server(seconds: float = 45.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if ensure_voice_server():
            return True
        time.sleep(0.7)
    return False


def tts_wav(text: str, voice: str) -> bytes:
    body = json.dumps({"text": text, "voice": voice or DEFAULT_VOICE}).encode("utf-8")
    req = urllib.request.Request(TTS_URL + "/say", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


# ---------------------------------------------------------------- LLM

# Бесплатный DeepSeek считается в локальном OpenCode-сервисе на этой машине
# (тот же движок, что у бота продаж). Ключ api.deepseek.com не нужен.
OPENCODE_MODEL = "deepseek-v4.1-flash-free"
OPENCODE_PROVIDER = "opencode"
OPENCODE_SERVICE_FILES = [
    Path(os.path.expanduser("~")) / ".local" / "state" / "opencode" / "service.json",
    Path(os.path.expanduser("~")) / ".config" / "opencode" / "service.json",
]


def opencode_service():
    """Адрес и пароль локального OpenCode-сервиса или None."""
    for f in OPENCODE_SERVICE_FILES:
        try:
            cfg = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if cfg.get("url") and cfg.get("password"):
            return cfg["url"].rstrip("/"), cfg["password"]
    return None


def _opencode_call(base, auth, method, path, body=None, timeout=180):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Authorization": auth,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode("utf-8", "replace")
        raise RuntimeError(f"DeepSeek (OpenCode) ответил {e.code}: {detail}")
    return json.loads(raw) if raw else {}


def opencode_ask(messages: list, json_mode: bool = False, timeout: float = 180.0) -> str:
    """Один вопрос-ответ через бесплатный DeepSeek в локальном OpenCode."""
    svc = opencode_service()
    if not svc:
        raise RuntimeError("Локальный сервис OpenCode не запущен — DeepSeek недоступен")
    base, password = svc
    auth = "Basic " + base64.b64encode(
        ("opencode:" + password).encode()).decode()

    system = "\n".join(str(m.get("content", "")) for m in messages
                       if m.get("role") == "system").strip()
    lines = []
    for m in messages:
        role = m.get("role")
        if role == "user":
            lines.append("Пользователь: " + str(m.get("content", "")))
        elif role == "assistant":
            lines.append("Тренер: " + str(m.get("content", "")))
    text = ""
    if system:
        text += system + "\n\n"
    text += "\n\n".join(lines)
    if json_mode:
        text += "\n\nОтветь ТОЛЬКО корректным JSON-объектом, без markdown и пояснений."
    text += "\n\n(Инструменты, файлы и команды не нужны — просто ответь текстом.)"

    sid = _opencode_call(base, auth, "POST", "/api/session", {})["data"]["id"]
    try:
        _opencode_call(base, auth, "POST", f"/api/session/{sid}/model",
                       {"model": {"id": OPENCODE_MODEL, "providerID": OPENCODE_PROVIDER}})
        _opencode_call(base, auth, "POST", f"/api/session/{sid}/prompt", {"text": text})
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.6)
            _deny_permissions(base, auth, sid)
            data = _opencode_call(base, auth, "GET", f"/api/session/{sid}/message").get("data", [])
            idle = [m for m in data if m.get("type") == "idle"]
            if not idle:
                continue
            last_idle = max(idle, key=lambda m: m.get("time", {}).get("created", 0))
            if last_idle.get("outcome") not in (None, "succeeded"):
                err = last_idle.get("error") or {}
                msg = err.get("message") or json.dumps(err, ensure_ascii=False)[:200]
                raise RuntimeError("DeepSeek: " + str(msg))
            parts = []
            for m in data:
                if m.get("type") != "assistant":
                    continue
                for c in m.get("content") or []:
                    if c.get("type") == "text" and c.get("text"):
                        parts.append(c["text"])
            if not parts:
                raise RuntimeError("DeepSeek вернул пустой ответ")
            return "\n".join(parts).strip()
        raise RuntimeError("DeepSeek не ответил за %d с" % int(timeout))
    finally:
        try:
            _opencode_call(base, auth, "DELETE", f"/api/session/{sid}", timeout=10)
        except Exception:
            pass


def _deny_permissions(base, auth, sid) -> None:
    """Если модель зачем-то просит доступ к файлам/командам — отказываем молча."""
    try:
        reqs = _opencode_call(base, auth, "GET", "/api/permission/request", timeout=8).get("data", [])
    except Exception:
        return
    for r in reqs:
        if r.get("sessionID") != sid:
            continue
        try:
            _opencode_call(base, auth, "POST",
                           f"/api/session/{sid}/permission/{r['id']}/reply",
                           {"decision": "deny", "message": "не требуется"}, timeout=8)
        except Exception:
            pass


def call_llm(model: str, messages: list, json_mode: bool = False,
             temperature: float = 0.3, predict: int = 900) -> str:
    """Вызов локальной Ollama или DeepSeek (бесплатный через OpenCode, либо API с ключом)."""
    secrets = read_secrets()
    if model.startswith("deepseek"):
        key = secrets.get("deepseek_api_key", "").strip()
        if key:
            body = {
                "model": "deepseek-chat",
                "messages": messages,
                "temperature": temperature,
                "max_tokens": predict,
            }
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            req = urllib.request.Request(
                "https://api.deepseek.com/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {key}"},
            )
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.load(r)
            return data["choices"][0]["message"]["content"]
        return opencode_ask(messages, json_mode)

    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,
        "options": {"temperature": temperature, "num_predict": predict},
    }
    if json_mode:
        body["format"] = "json"
    req = urllib.request.Request(
        OLLAMA_URL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
    return data["message"]["content"]


def parse_json_loose(text: str) -> dict:
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return {}


GRADE_SYSTEM = """Ты — опытный тренер консультантов по продажам ювелирного бренда EGO Bottego.
Ученик готовится к аттестации и отвечает устно, своими словами. Твоя задача — проверить, понял ли он СУТЬ,
и дать полезный разбор как живой преподаватель. Не требуй дословного совпадения с эталоном: если мысль
передана верно другими словами — это правильный ответ.

Оцени по рубрике (в сумме 0–5):
- Смысл: понял ли суть вопроса (0–2)
- Полнота: названы ли ключевые пункты эталона (0–2)
- Точность: нет ли фактических ошибок и путаницы (0–1)

Правила:
- Будь доброжелательным, но честным. Не завышай оценку из вежливости.
- Если ответ пустой или не по теме — 0–1.
- Пиши по-русски, коротко и конкретно, как тренер на разборе.
- В missing перечисляй только действительно важные пропущенные пункты (не больше 5).
- model_answer — образец устного ответа на 2–5 предложений, живой речью.
- followup — один уточняющий вопрос, который поможет ученику доработать ответ.

Верни ТОЛЬКО JSON без пояснений:
{"score": 0-5, "verdict": "одна фраза-итог", "correct": ["..."], "missing": ["..."],
 "errors": ["..."], "model_answer": "...", "followup": "..."}"""


def grade_answer(question: str, reference: str, student: str, model: str) -> dict:
    if reference:
        ref_block = f"ЭТАЛОННЫЙ ОТВЕТ (из конспекта):\n{reference}"
    else:
        ref_block = ("ЭТАЛОН В КОНСПЕКТЕ ОТСУТСТВУЕТ. Оцени по общим профессиональным критериям "
                     "консультанта по продажам и здравому смыслу, но в missing не выдумывай "
                     "факты о компании. Если ответ содержательный и по делу — не занижай оценку.")
    user = (f"ВОПРОС:\n{question}\n\n{ref_block}\n\n"
            f"ОТВЕТ УЧЕНИКА (расшифровка устной речи, могут быть оговорки распознавания):\n{student}\n\n"
            "Дай разбор и оценку в формате JSON.")
    messages = [{"role": "system", "content": GRADE_SYSTEM},
                {"role": "user", "content": user}]
    raw = call_llm(model, messages, json_mode=True, temperature=0.25, predict=900)
    result = parse_json_loose(raw)
    if not result or "score" not in result:
        raw = call_llm(model, messages, json_mode=True, temperature=0.1, predict=900)
        result = parse_json_loose(raw)

    # нормализация
    try:
        score = int(round(float(result.get("score", 0))))
    except Exception:
        score = 0
    score = max(0, min(5, score))

    def arr(key):
        v = result.get(key)
        if isinstance(v, str):
            return [v] if v.strip() else []
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        return []

    return {
        "score": score,
        "verdict": str(result.get("verdict", "")).strip(),
        "correct": arr("correct"),
        "missing": arr("missing"),
        "errors": arr("errors"),
        "model_answer": str(result.get("model_answer", "")).strip(),
        "followup": str(result.get("followup", "")).strip(),
        "hasReference": bool(reference),
    }


ASK_SYSTEM = """Ты — преподаватель-наставник консультантов по продажам EGO Bottego.
Отвечай на вопрос ученика, опираясь на материалы конспекта, которые даны ниже.
Говори живой устной речью: ответ будет озвучен вслух. 3–8 предложений, по делу, без markdown-разметки,
без списков с дефисами и звёздочками. Если в конспекте ответа нет — честно скажи: «В конспекте этого нет»,
и дай короткий ответ по общим правилам продаж, упомянув, что это общая практика.
Если ученик просит объяснить проще, привести пример из магазина или спрашивает уточнение — сделай это.
В конце можно задать один встречный вопрос, чтобы проверить понимание."""


def _tokens(text: str) -> set:
    text = text.lower().replace("ё", "е")
    words = re.findall(r"[a-zа-я0-9]+", text)
    return {w for w in words if len(w) > 3}


def find_context(question: str, k: int = 4) -> list:
    qt = _tokens(question)
    if not qt:
        return []
    scored = []
    for q in QUESTIONS:
        t = _tokens(q["question"] + " " + q["answer"])
        if not t:
            continue
        overlap = len(qt & t)
        scored.append((overlap, q))
    scored.sort(key=lambda x: -x[0])
    picked = [q for score, q in scored[:k] if score > 0]
    return picked or [q for _, q in scored[:2]]


def ask_teacher(question: str, history: list, model: str) -> dict:
    ctx_items = find_context(question)
    ctx = "\n\n".join(
        f"Вопрос {q['id']}: {q['question']}\nОтвет: {q['answer'][:1800]}"
        for q in ctx_items
    )
    messages = [{"role": "system", "content": ASK_SYSTEM +
                 f"\n\nМАТЕРИАЛЫ КОНСПЕКТА:\n{ctx}"}]
    for m in history[-8:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:4000]})
    messages.append({"role": "user", "content": question})
    answer = call_llm(model, messages, json_mode=False, temperature=0.5, predict=700).strip()
    return {
        "answer": answer,
        "sources": [{"id": q["id"], "question": q["question"]} for q in ctx_items],
    }


CHAT_SYSTEM = """Ты — живой наставник консультантов по продажам ювелирного бренда EGO Bottego.
Ученик готовится к аттестации и хочет просто поговорить: спросить своими словами, услышать рассуждения,
рекомендации и примеры из магазина. Общайся по-человечески, как опытный коллега за чашкой кофе:
без канцелярита, без markdown и списков с дефисами — ответ будет озвучен вслух.
Опирайся на материалы конспекта, если они относятся к вопросу, но можешь рассуждать шире:
разбирать ситуации, предлагать формулировки, объяснять «почему так», приводить примеры диалогов с покупателем.
Не выдумывай факты о компании и ценах. Если чего-то не знаешь — так и скажи.
Отвечай 3–8 предложений живой устной речью и в конце можешь задать один встречный вопрос."""


def chat_with_coach(question: str, history: list, model: str) -> dict:
    ctx_items = find_context(question, k=3)
    ctx = "\n\n".join(
        f"Вопрос {q['id']}: {q['question']}\nОтвет: {q['answer'][:1500]}"
        for q in ctx_items
    )
    system = CHAT_SYSTEM
    if ctx:
        system += f"\n\nМАТЕРИАЛЫ КОНСПЕКТА (если пригодятся):\n{ctx}"
    messages = [{"role": "system", "content": system}]
    for m in history[-12:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:4000]})
    messages.append({"role": "user", "content": question})
    answer = call_llm(model, messages, json_mode=False, temperature=0.7, predict=700).strip()
    return {
        "answer": answer,
        "sources": [{"id": q["id"], "question": q["question"]} for q in ctx_items],
    }


def run_with_fallback(fn, model, *args):
    """Если DeepSeek недоступен (лимит, нет сервиса) — отвечаем локальной моделью."""
    try:
        return fn(*args, model), None
    except RuntimeError as exc:
        text = str(exc)
        if model.startswith("deepseek") and ("DeepSeek" in text or "OpenCode" in text
                                            or "ключа" in text.lower()):
            log("DeepSeek недоступен (" + text[:120] + ") — отвечаю локальной " + DEFAULT_MODEL)
            return fn(*args, DEFAULT_MODEL), DEFAULT_MODEL
        raise


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path in ("/", "/index.html"):
                self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif path == "/api/questions":
                self._json(200, DATA)
            elif path == "/api/health":
                self._json(200, {"ok": True, "defaultModel": DEFAULT_MODEL,
                                 "lanUrl": lan_url()})
            elif path == "/ca.crt":
                if CA_FILE.exists():
                    self._send(200, CA_FILE.read_bytes(), "application/x-x509-ca-cert")
                else:
                    self._send(404, b"no ca", "text/plain")
            elif path == "/api/config":
                self._json(200, {"hasDeepseekKey": bool(read_secrets().get("deepseek_api_key"))})
            elif path == "/api/tts/voices":
                h = tts_health() or {}
                self._json(200, {"ready": bool(h.get("ready")),
                                 "voices": h.get("voices") or [],
                                 "default": DEFAULT_VOICE})
            elif path.startswith("/static/"):
                f = STATIC / path[len("/static/"):]
                if f.is_file() and f.resolve().is_relative_to(STATIC.resolve()):
                    ctype = {".js": "application/javascript; charset=utf-8",
                             ".css": "text/css; charset=utf-8",
                             ".svg": "image/svg+xml",
                             ".png": "image/png"}.get(f.suffix, "application/octet-stream")
                    self._send(200, f.read_bytes(), ctype)
                else:
                    self._send(404, b"not found", "text/plain")
            else:
                self._send(404, b"not found", "text/plain")
        except Exception:
            log(traceback.format_exc())
            self._send(500, b"server error", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})

        try:
            if path == "/api/config":
                key = str(payload.get("deepseek_api_key", "")).strip()
                secrets = read_secrets()
                if key:
                    secrets["deepseek_api_key"] = key
                    SECRETS.parent.mkdir(exist_ok=True)
                    SECRETS.write_text(json.dumps(secrets, ensure_ascii=False, indent=2), encoding="utf-8")
                    log("DeepSeek key saved")
                return self._json(200, {"hasDeepseekKey": bool(secrets.get("deepseek_api_key"))})

            if path == "/api/grade":
                qid = str(payload.get("questionId", ""))
                q = BY_ID.get(qid)
                question = payload.get("question") or (q and q["question"]) or ""
                reference = payload.get("reference")
                if reference is None and q:
                    reference = q["answer"]
                student = str(payload.get("studentAnswer", "")).strip()
                model = payload.get("model") or DEFAULT_MODEL
                if not student:
                    return self._json(400, {"error": "Пустой ответ"})
                t = time.time()
                result, used = run_with_fallback(grade_answer, model, question, reference or "", student)
                result["questionId"] = qid
                result["elapsed"] = round(time.time() - t, 1)
                if used:
                    result["modelFallback"] = used
                log(f"grade {qid} model={model} score={result['score']} {result['elapsed']}s")
                return self._json(200, result)

            if path == "/api/ask":
                question = str(payload.get("question", "")).strip()
                if not question:
                    return self._json(400, {"error": "Пустой вопрос"})
                model = payload.get("model") or DEFAULT_MODEL
                t = time.time()
                result, used = run_with_fallback(ask_teacher, model, question, payload.get("history") or [])
                result["elapsed"] = round(time.time() - t, 1)
                if used:
                    result["modelFallback"] = used
                log(f"ask model={model} {result['elapsed']}s q={question[:60]}")
                return self._json(200, result)

            if path == "/api/chat":
                question = str(payload.get("question", "")).strip()
                if not question:
                    return self._json(400, {"error": "Пустой вопрос"})
                model = payload.get("model") or DEFAULT_MODEL
                t = time.time()
                result, used = run_with_fallback(chat_with_coach, model, question, payload.get("history") or [])
                result["elapsed"] = round(time.time() - t, 1)
                if used:
                    result["modelFallback"] = used
                log(f"chat model={model} {result['elapsed']}s q={question[:60]}")
                return self._json(200, result)

            if path == "/api/spoken":
                text = str(payload.get("text", "")).strip()
                if text and voice_dict is not None:
                    voice_dict.note_spoken(text)
                return self._json(200, {"ok": True})

            if path == "/api/tts":
                text = str(payload.get("text", "")).strip()
                if not text:
                    return self._json(400, {"error": "Пустой текст"})
                voice = str(payload.get("voice") or DEFAULT_VOICE).strip().lower()
                if not wait_voice_server():
                    return self._json(503, {"error": "Голос не запустился"})
                try:
                    if voice_dict is not None:
                        text = voice_dict.apply(text)
                    wav = tts_wav(text[:1200], voice)
                except Exception as e:
                    log(f"tts error: {e}")
                    return self._json(502, {"error": "Голос недоступен"})
                self._send(200, wav, "audio/wav")
                return

            return self._json(404, {"error": "not found"})
        except urllib.error.URLError as e:
            log(f"LLM unreachable: {e}")
            return self._json(502, {"error": "ИИ недоступен. Проверьте, что SPQR (Ollama) включён."})
        except Exception as e:
            log(traceback.format_exc())
            return self._json(500, {"error": str(e)})


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def lan_url() -> str:
    if not LAN_ENABLED or not CERT_FILE.exists():
        return ""
    return f"https://{lan_ip()}:{LAN_PORT}"


def start_lan_server():
    """Второй слушатель — HTTPS на всю домашнюю сеть, для телефона."""
    if not LAN_ENABLED:
        return
    if not (CERT_FILE.exists() and KEY_FILE.exists()):
        log("телефон: сертификатов нет — сетевой доступ выключен (python make_cert.py)")
        return
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_FILE, KEY_FILE)
    httpd = ThreadingHTTPServer(("0.0.0.0", LAN_PORT), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    log(f"телефон: {lan_url()}  (или https://{socket.gethostname()}:{LAN_PORT})")


def main():
    log(f"Сервер запущен: http://localhost:{PORT}  модель по умолчанию: {DEFAULT_MODEL}")
    start_lan_server()
    threading.Thread(target=_preload_voice, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


def _preload_voice():
    t = time.time()
    if wait_voice_server():
        log("голос: готов за %.1f с (Silero, %s)" % (time.time() - t, DEFAULT_VOICE))
    else:
        log("голос: не запустился, останется голос Windows")


if __name__ == "__main__":
    main()
