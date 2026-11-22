# -*- coding: utf-8 -*-
"""Бот-дверь в мини-приложение «Тренажёр аттестации EGO Bottego».

Сам ничего не тренирует: его задача — дать кнопку, которая открывает
тренажёр внутри Telegram. Токен берётся из data/secrets.json
(ключ telegram_bot_token), публичный адрес — из data/miniapp.json
(ключ public_url) или переменной ATTEST_PUBLIC_URL.

Запуск: python telegram_bot.py  (сервер запускает его сам, если токен есть)
"""
import io
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
SECRETS = ROOT / "data" / "secrets.json"
MINIAPP = ROOT / "data" / "miniapp.json"
LOG = ROOT / "logs" / "bot.log"
API = "https://api.telegram.org/bot"

# В России api.telegram.org напрямую часто обрывается; Happ/xray держит
# локальный HTTP-прокси. Если он выключен — пробуем прямое подключение.
PROXY = os.environ.get("TELEGRAM_PROXY", "http://127.0.0.1:10809")
_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))

TITLE = "Тренажёр EGO Bottego"


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    LOG.parent.mkdir(exist_ok=True)
    with io.open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return dict(default)


def token() -> str:
    return str(os.environ.get("TELEGRAM_BOT_TOKEN")
               or read_json(SECRETS, {}).get("telegram_bot_token") or "").strip()


def public_url() -> str:
    url = os.environ.get("ATTEST_PUBLIC_URL") or read_json(MINIAPP, {}).get("public_url") or ""
    return str(url).strip().rstrip("/")


def call(tok: str, method: str, data: dict, timeout: int = 45) -> dict:
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(API + tok + "/" + method, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    for opener, note in ((_opener, "proxy"), (urllib.request.build_opener(), "direct")):
        try:
            with opener.open(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            log(f"{method}: HTTP {e.code} {detail}")
            return {"ok": False, "error": detail}
        except Exception as e:
            log(f"{method} ({note}): {e}")
    return {"ok": False, "error": "api.telegram.org недоступен"}


def main_text(url: str) -> str:
    if url:
        return (f"{TITLE}\n\n"
                "Вопросы, плеер с озвучкой, разбор ответов и ИИ-тренер — всё внутри.\n"
                "Нажмите кнопку ниже.")
    return (f"{TITLE}\n\n"
            "Мини-приложение ещё не опубликовано: нужен публичный HTTPS-адрес.\n"
            "Как только он появится, здесь будет кнопка «Открыть тренажёр».")


def keyboard(url: str) -> dict:
    if not url:
        return {"remove_keyboard": True}
    return {"inline_keyboard": [[{"text": "▶ Открыть тренажёр",
                                  "web_app": {"url": url}}]]}


def configure(tok: str, url: str) -> None:
    call(tok, "setMyCommands", {"commands": [
        {"command": "start", "description": "Открыть тренажёр"},
    ]})
    if url:
        call(tok, "setChatMenuButton", {"menu_button": {
            "type": "web_app", "text": "Тренажёр", "web_app": {"url": url}}})
    else:
        call(tok, "setChatMenuButton", {"menu_button": {"type": "default"}})


def handle(tok: str, url: str, msg: dict) -> None:
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if not chat_id:
        return
    text = msg.get("text") or ""
    if text.startswith("/start") or text.startswith("/menu") or not text:
        answer = main_text(url)
    else:
        answer = main_text(url)
    call(tok, "sendMessage", {
        "chat_id": chat_id,
        "text": answer,
        "reply_markup": keyboard(url),
        "disable_web_page_preview": True,
    })


def run() -> int:
    tok = token()
    if not tok:
        log("нет токена telegram_bot_token в data/secrets.json — бот не запущен")
        return 1
    url = public_url()
    me = call(tok, "getMe", {})
    if not me.get("ok"):
        log("getMe не прошёл — проверьте токен")
        return 1
    username = (me.get("result") or {}).get("username")
    log(f"бот @{username} запущен, адрес: {url or 'не задан'}")
    configure(tok, url)
    offset = 0
    while True:
        upd = call(tok, "getUpdates", {"offset": offset, "timeout": 30,
                                       "allowed_updates": ["message"]}, timeout=45)
        if not upd.get("ok"):
            time.sleep(3)
            continue
        for item in upd.get("result") or []:
            offset = max(offset, int(item.get("update_id", 0)) + 1)
            msg = item.get("message")
            if msg:
                try:
                    handle(tok, url, msg)
                except Exception:
                    log(traceback.format_exc())


if __name__ == "__main__":
    try:
        sys.exit(run())
    except KeyboardInterrupt:
        sys.exit(0)
