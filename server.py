#!/usr/bin/env python3
"""俄语学习系统 —— 本地服务（Python 3 标准库实现，零第三方依赖）。

用法:
    python server.py                 # 启动并自动打开浏览器
    python server.py --port 9000     # 指定起始端口
    python server.py --no-browser    # 不自动打开浏览器

只读引用工作区里已有的资源:
    ../russian_flashcards/vocabulary.csv   3200 词条
    ../russian_flashcards/audio/*.mp3      3200 条发音
进度写入 ./data/progress.json（含每日备份，保留最近 7 份）。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import socket
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(ROOT)
VOCAB_CSV = os.path.join(WORKSPACE, "russian_flashcards", "vocabulary.csv")
AUDIO_DIR = os.path.join(WORKSPACE, "russian_flashcards", "audio")
WEB_DIR = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(ROOT, "data")
PROGRESS_PATH = os.path.join(DATA_DIR, "progress.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")
KEEP_BACKUPS = 7
MAX_BODY = 64 * 1024 * 1024

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

DEFAULT_PROGRESS = {
    "version": 1,
    "settings": {
        "autoReviewDays": 30,
        "autoReviewEnabled": True,
        "virtualKeyboard": True,
        "showExamples": True,
    },
    "words": {},
    "recite": {
        "groups": [],
        "plan": [],
        "pageSubmitted": {},
        "cursor": 1,
        "nextSlot": 1,
        "nextGroupId": 0,
    },
    "ui": {
        "copyPage": 1,
        "copyTab": "learn",
        "reciteTab": "learn",
        "copyReviewPage": 1,
        "reciteReviewPage": 1,
        "masteredPage": 1,
        "wrongPage": 1,
    },
    "stats": {"createdAt": None, "lastOpenedAt": None},
}

VERBOSE = False
WORDS: list[dict] = []
STATIC: dict[str, str] = {}
AUDIO_FILES: set[str] = set()


def load_vocab() -> list[dict]:
    """读取词表 CSV，按 CSV 顺序（频率降序）生成前端所需的词条列表。"""
    rows: list[dict] = []
    with open(VOCAB_CSV, encoding="utf-8", newline="") as fh:
        for i, raw in enumerate(csv.DictReader(fh)):
            word = (raw.get("word") or "").strip()
            if not word:
                continue
            rank_raw = (raw.get("frequency_rank") or "").strip()
            rows.append(
                {
                    "idx": len(rows) + 1,
                    "word": word,
                    "stress": (raw.get("stress") or "").strip() or word,
                    "pos": (raw.get("pos") or "").strip(),
                    "zh": (raw.get("zh") or "").strip(),
                    "en": (raw.get("en") or "").strip(),
                    "example_ru": (raw.get("example_ru") or "").strip(),
                    "example_zh": (raw.get("example_zh") or "").strip(),
                    "rank": int(rank_raw) if rank_raw.isdigit() else i + 1,
                    "part": (raw.get("part") or "").strip(),
                    "audio": "/audio/" + quote(word, safe="") + ".mp3",
                }
            )
    return rows


def scan_static() -> dict[str, str]:
    """把 web 目录下的文件登记成白名单路由（避免任何路径穿越）。"""
    routes: dict[str, str] = {}
    for dirpath, _dirnames, filenames in os.walk(WEB_DIR):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, WEB_DIR).replace(os.sep, "/")
            routes["/" + rel] = full
    return routes


def newest_backup() -> str | None:
    if not os.path.isdir(BACKUP_DIR):
        return None
    files = sorted(
        (os.path.join(BACKUP_DIR, n) for n in os.listdir(BACKUP_DIR) if n.endswith(".json")),
        reverse=True,
    )
    return files[0] if files else None


def read_progress() -> dict:
    """读取进度文件；损坏时改名留档并回退到最近的每日备份。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(PROGRESS_PATH):
        return json.loads(json.dumps(DEFAULT_PROGRESS))
    try:
        with open(PROGRESS_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("进度文件顶层不是 JSON 对象")
        return data
    except Exception as exc:  # noqa: BLE001
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        broken = os.path.join(DATA_DIR, f"progress.corrupt-{stamp}.json")
        try:
            shutil.move(PROGRESS_PATH, broken)
            print(f"[警告] 进度文件损坏（{exc}），已改名为 {os.path.basename(broken)}")
        except OSError:
            pass
        fallback = newest_backup()
        if fallback:
            print(f"[提示] 已从备份恢复：{os.path.basename(fallback)}")
            with open(fallback, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        return json.loads(json.dumps(DEFAULT_PROGRESS))


def prune_backups() -> None:
    files = sorted(n for n in os.listdir(BACKUP_DIR) if n.endswith(".json"))
    for name in files[:-KEEP_BACKUPS]:
        try:
            os.remove(os.path.join(BACKUP_DIR, name))
        except OSError:
            pass


def write_progress(payload: dict) -> None:
    """每日留一份备份，然后原子写入（临时文件 + os.replace）。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(PROGRESS_PATH):
        os.makedirs(BACKUP_DIR, exist_ok=True)
        backup = os.path.join(BACKUP_DIR, f"progress-{datetime.now().strftime('%Y-%m-%d')}.json")
        if not os.path.exists(backup):
            try:
                shutil.copy2(PROGRESS_PATH, backup)
                prune_backups()
            except OSError:
                pass
    tmp = PROGRESS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, PROGRESS_PATH)


class Handler(BaseHTTPRequestHandler):
    server_version = "RussianTrainer/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if VERBOSE:
            super().log_message(fmt, *args)

    def _body(self, data: bytes, ctype: str, status: int = 200, cache: str = "no-cache") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status: int = 200) -> None:
        self._body(json.dumps(obj, ensure_ascii=False).encode("utf-8"), MIME[".json"], status, "no-store")

    def _file(self, path: str) -> None:
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            self._json({"error": "file not found"}, 404)
            return
        ctype = MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        cache = "public, max-age=86400" if ctype.startswith("audio/") else "no-cache"
        self._body(data, ctype, 200, cache)

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Content-Length 非法") from None
        if length <= 0:
            raise ValueError("请求体为空")
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/vocab":
            self._json({"total": len(WORDS), "words": WORDS})
            return
        if path == "/api/progress":
            self._json(read_progress())
            return
        if path.startswith("/audio/"):
            name = unquote(path[len("/audio/"):])
            if name in AUDIO_FILES:
                self._file(os.path.join(AUDIO_DIR, name))
            else:
                self._json({"error": "audio not found", "name": name}, 404)
            return
        if path == "/":
            path = "/index.html"
        target = STATIC.get(path)
        if target:
            self._file(target)
        else:
            self._json({"error": "not found", "path": path}, 404)

    def do_PUT(self) -> None:  # noqa: N802
        self._save_progress()

    def do_POST(self) -> None:  # noqa: N802
        self._save_progress()

    def _save_progress(self) -> None:
        path = urlparse(self.path).path
        if path != "/api/progress":
            self._json({"error": "not found", "path": path}, 404)
            return
        try:
            payload = json.loads(self._read_body().decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload 必须是 JSON 对象")
            write_progress(payload)
        except Exception as exc:  # noqa: BLE001
            self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 400)
            return
        self._json({"ok": True, "savedAt": datetime.now().isoformat(timespec="seconds")})


def pick_port(start: int, tries: int = 20) -> int:
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"端口 {start}-{start + tries - 1} 都被占用，请用 --port 指定其他端口。")


def main() -> None:
    global VERBOSE, WORDS, STATIC, AUDIO_FILES
    parser = argparse.ArgumentParser(description="俄语学习系统本地服务")
    parser.add_argument("--port", type=int, default=8765, help="起始端口（默认 8765，被占用则自动 +1）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("-v", "--verbose", action="store_true", help="打印每次请求日志")
    args = parser.parse_args()
    VERBOSE = args.verbose

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    for path, label in ((VOCAB_CSV, "词表 CSV"), (AUDIO_DIR, "音频目录"), (WEB_DIR, "前端目录")):
        if not os.path.exists(path):
            raise SystemExit(f"缺少{label}：{path}")

    WORDS = load_vocab()
    STATIC = scan_static()
    AUDIO_FILES = {n for n in os.listdir(AUDIO_DIR) if n.endswith(".mp3")}
    missing = [w["word"] for w in WORDS if w["word"] + ".mp3" not in AUDIO_FILES]

    os.makedirs(DATA_DIR, exist_ok=True)
    progress = read_progress()
    stats = progress.setdefault("stats", {})
    now = datetime.now().isoformat(timespec="seconds")
    stats["createdAt"] = stats.get("createdAt") or now
    stats["lastOpenedAt"] = now
    write_progress(progress)

    port = pick_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    print(f"词条载入: {len(WORDS)} 条")
    print(f"发音音频: {len(AUDIO_FILES)} 个，缺失 {len(missing)} 个" + (f" -> {missing[:5]}" if missing else ""))
    print(f"进度文件: {PROGRESS_PATH}")
    print(f"服务已启动: {url}   （关闭本窗口即停止服务，Ctrl+C 亦可）")

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
