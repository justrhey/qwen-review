#!/usr/bin/env python3
"""Loopback-only code-review workspace backed by the existing Qwen agent."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlsplit
import uuid
import repository_tools as repo

BASE = Path(__file__).resolve().parent
WEB = BASE / 'workspace'
TOKEN = secrets.token_urlsafe(32)
RUNS = {}
RUN_LOCK = threading.Lock()
INFERENCE_LOCK = threading.Lock()
LOGS = Path.home() / '.local/state/local-qwen/reviews'
PORT = int(os.environ.get('QWEN_WORKSPACE_PORT', '8766'))


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def valid_host(self):
        return self.headers.get('Host') in {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}

    def respond(self, value, status=200, content_type='application/json'):
        body = json.dumps(value, ensure_ascii=False).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            return self.respond({'error': 'Invalid host'}, 403)
        parsed = urlsplit(self.path)
        if parsed.path == '/api/bootstrap':
            return self.respond({'token': TOKEN, 'model': 'Qwen3.5 · 2B', 'home': str(Path.home()), 'default_root': str(BASE), 'archify': repo.ARCHIFY.is_file()})
        if parsed.path == '/diagram':
            key = parse_qs(parsed.query).get('id', [''])[0]
            if not re.fullmatch(r'imports-[a-z0-9_]{8}', key):
                return self.respond({'error': 'Invalid diagram'}, 400)
            file = repo.ARTIFACTS / key / 'map.html'
            if not file.is_file():
                return self.respond({'error': 'Diagram not found'}, 404)
            # Generated Archify is confined to a sandboxed iframe in the app.
            body = file.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'")
            self.end_headers()
            self.wfile.write(body)
            return
        assets = {'/': ('index.html', 'text/html; charset=utf-8'), '/diff.js': ('diff.js', 'text/javascript; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if parsed.path not in assets:
            return self.respond({'error': 'Not found'}, 404)
        name, content_type = assets[parsed.path]
        self.respond((WEB / name).read_bytes(), content_type=content_type)

    def do_POST(self):
        origin = self.headers.get('Origin')
        allowed_origins = {f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'}
        if not self.valid_host() or self.headers.get('X-Workspace-Token') != TOKEN or (origin and origin not in allowed_origins):
            return self.respond({'error': 'Open the local workspace to make this request'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 200000:
                raise ValueError('Request size is invalid')
            data = json.loads(self.rfile.read(length))
            if urlsplit(self.path).path == '/api/stop':
                with RUN_LOCK:
                    process = RUNS.get(data.get('id'))
                if process:
                    stop_process(process)
                return self.respond({'stopped': bool(process)})
            root = repo.project_root(data['root'])
            route = urlsplit(self.path).path
            if route == '/api/scan':
                return self.respond(repo.scan_repository(root))
            if route == '/api/file':
                return self.respond(repo.read_project_file(root, data['path'], data.get('offset', 1), data.get('limit', 200)))
            if route == '/api/trace':
                return self.respond(repo.trace_connections(repo.scan_repository(root), data['path']))
            if route == '/api/diff':
                return self.respond(repo.review_diff(root))
            if route == '/api/diagram':
                return self.respond(repo.archify_diagram(repo.scan_repository(root), data.get('path'), data.get('scope', 'file')))
            if route == '/api/chat':
                return self.chat(root, data)
            self.respond({'error': 'Not found'}, 404)
        except (KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired) as exc:
            self.respond({'error': str(exc)}, 400)

    def chat(self, root, data):
        messages = data.get('messages')
        if not isinstance(messages, list) or not messages or len(messages) > 30 or any(not isinstance(m, dict) or m.get('role') not in {'user', 'assistant'} or not isinstance(m.get('content'), str) for m in messages):
            raise ValueError('Chat needs user and assistant text messages')
        selected = data.get('selected_file')
        if selected:
            repo.project_file(root, selected)
        if not INFERENCE_LOCK.acquire(blocking=False):
            return self.respond({'error': 'Qwen is already answering. Wait for it to finish or stop the current review.'}, 409)
        process = None
        run_id = uuid.uuid4().hex
        trace = []
        try:
            process = subprocess.Popen([sys.executable, '-u', str(BASE / 'agent.py')], cwd=BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            with RUN_LOCK:
                RUNS[run_id] = process
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            def send(event):
                self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode())
                self.wfile.flush()
            send({'type': 'run', 'id': run_id})
            process.stdin.write(json.dumps({'review_root': str(root), 'selected_file': selected, 'messages': messages}) + '\n')
            process.stdin.flush()
            process.stdin.close()
            finished = False
            for line in process.stdout:
                event = json.loads(line)
                trace.append(event)
                if event.get('type') == 'done':
                    finished = True
                # Tool history is retained in the local audit log, not accepted back from browsers.
                if event.get('type') != 'history':
                    send(event)
            process.wait()
            if not finished:
                send({'type': 'error', 'text': 'Review stopped before completion.'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if process:
                stop_process(process)
                if process.stdout:
                    process.stdout.close()
            with RUN_LOCK:
                RUNS.pop(run_id, None)
            INFERENCE_LOCK.release()
            LOGS.mkdir(parents=True, exist_ok=True, mode=0o700)
            file = LOGS / f'{run_id}.json'
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                json.dump({'project': str(root), 'selected_file': selected, 'messages': messages, 'events': trace}, out, ensure_ascii=False)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Qwen Review: http://127.0.0.1:{PORT}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with RUN_LOCK:
            for process in list(RUNS.values()):
                stop_process(process)
        server.server_close()
