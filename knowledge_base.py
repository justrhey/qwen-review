#!/usr/bin/env python3
"""Private full-text knowledge index for useful files on this machine."""
import argparse
import json
import os
from pathlib import Path
import sqlite3

DATABASE = Path.home() / ".local/state/local-qwen/knowledge.sqlite3"
ROOTS = (Path.home(), Path("/mnt/storage"))
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_CONTENT_CHARS = 200_000
SKIP_DIRS = {
    ".cache", ".git", ".gradle", ".idea", ".local", ".mozilla", ".npm",
    ".steam", ".venv", ".vscode", "Applications", "Cache", "CacheStorage",
    "GPUCache", "Service Worker", "Trash", "__pycache__", "backups", "build",
    "coverage", "dist", "downloads", "lost+found", "models", "node_modules",
    "runtime", "target", "venv",
}
SKIP_SUFFIXES = {
    ".7z", ".a", ".apk", ".bin", ".class", ".db", ".dll", ".dmg", ".exe",
    ".gguf", ".gif", ".gz", ".ico", ".iso", ".jar", ".jpeg", ".jpg",
    ".lock", ".mp3", ".mp4", ".o", ".pdf", ".png", ".pyc", ".so",
    ".sqlite", ".sqlite3", ".tar", ".ttf", ".webm", ".webp", ".woff",
    ".woff2", ".xz", ".zip",
}
SECRET_NAMES = {
    ".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "credentials",
    "credentials.json", "id_ed25519", "id_rsa", "known_hosts",
}


def allowed(path):
    if path.name.lower() in SECRET_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
        return False
    lower = path.name.lower()
    return not any(word in lower for word in ("secret", "credential", "private_key"))


def files(roots=ROOTS):
    for root in roots:
        if not root.is_dir():
            continue
        for directory, names, filenames in os.walk(root, followlinks=False):
            names[:] = [name for name in names if name not in SKIP_DIRS and not name.startswith(".")]
            base = Path(directory)
            for name in filenames:
                path = base / name
                try:
                    if allowed(path) and not path.is_symlink() and path.stat().st_size <= MAX_FILE_BYTES:
                        yield path
                except OSError:
                    continue


def read_text(path):
    try:
        data = path.read_bytes()
        if b"\0" in data[:8192]:
            return None
        return data.decode("utf-8")[:MAX_CONTENT_CHARS]
    except (OSError, UnicodeDecodeError):
        return None


def connect(database=DATABASE):
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(path UNINDEXED, content, tokenize='unicode61')")
    connection.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return connection


def rebuild(database=DATABASE, roots=ROOTS):
    connection = connect(database)
    indexed = 0
    with connection:
        connection.execute("DELETE FROM documents")
        for path in files(roots):
            content = read_text(path)
            if content and content.strip():
                connection.execute("INSERT INTO documents(path, content) VALUES (?, ?)", (str(path), content))
                indexed += 1
        connection.execute("INSERT OR REPLACE INTO metadata VALUES ('indexed_files', ?)", (str(indexed),))
        connection.execute("INSERT OR REPLACE INTO metadata VALUES ('updated_at', datetime('now'))")
    connection.close()
    return indexed


def search(query, database=DATABASE, limit=6):
    terms = [part for part in query.replace("_", " ").split() if any(c.isalnum() for c in part)]
    expression = " OR ".join('"' + term.replace('"', '""') + '"' for term in terms[:12])
    if not expression or not database.exists():
        return {"results": [], "error": "Knowledge index is empty." if not database.exists() else None}
    connection = sqlite3.connect(database)
    rows = connection.execute(
        "SELECT path, snippet(documents, 1, '[', ']', ' … ', 28), bm25(documents) "
        "FROM documents WHERE documents MATCH ? ORDER BY bm25(documents) LIMIT ?",
        (expression, max(1, min(limit, 10))),
    ).fetchall()
    connection.close()
    return {"results": [{"path": path, "excerpt": excerpt, "score": round(-score, 3)} for path, excerpt, score in rows]}


def stats(database=DATABASE):
    if not database.exists():
        return {"indexed_files": 0, "updated_at": None}
    connection = sqlite3.connect(database)
    values = dict(connection.execute("SELECT key, value FROM metadata"))
    connection.close()
    return {"indexed_files": int(values.get("indexed_files", 0)), "updated_at": values.get("updated_at")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("rebuild", "search", "stats"))
    parser.add_argument("query", nargs="?")
    args = parser.parse_args()
    if args.action == "rebuild":
        print(json.dumps({"indexed_files": rebuild()}))
    elif args.action == "search":
        print(json.dumps(search(args.query or ""), ensure_ascii=False))
    else:
        print(json.dumps(stats()))


if __name__ == "__main__":
    main()
