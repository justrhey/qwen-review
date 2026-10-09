#!/usr/bin/env python3
"""Loopback-only code-review workspace backed by the existing Qwen agent."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
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
import codex_agent
import codex_skills
import editor_tools
import preview_tools
import jev_helper
import workspace_state as disk

BASE = Path(__file__).resolve().parent
WEB = BASE / 'workspace'
TOKEN = secrets.token_urlsafe(32)
RUNS = {}
RUN_RECORDS = {}
RUN_LOCK = threading.Lock()
SESSION_LOCK = threading.Lock()
INFERENCE_LOCK = threading.Lock()
LOGS = Path.home() / '.local/state/local-qwen/reviews'
PORT = int(os.environ.get('QWEN_WORKSPACE_PORT', '8766'))


def state_directory():
    return LOGS.parent / 'workspace'


def checkpoint_run(run_id, record):
    disk.write_json(state_directory() / 'runs' / (run_id + '.json'),
                    {key: record[key] for key in ('root', 'account_id', 'finished')})


def recover_run(run_id):
    if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{32}', run_id):
        return None
    saved = disk.read_json(state_directory() / 'runs' / (run_id + '.json'))
    if not saved:
        return None
    events = disk.read_events(state_directory() / 'runs' / (run_id + '.jsonl'))
    if not saved['finished'] and not any(event.get('type') == 'done' for event in events):
        events.append({'type':'error', 'interrupted':True,
                       'text':'The server restarted. Your work is saved. Continue this task when ready.'})
    return {**saved, 'events':events, 'finished':True, 'condition':threading.Condition()}


def stop_process(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
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
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            return self.respond({'error': 'Invalid host'}, 403)
        parsed = urlsplit(self.path)
        if parsed.path == '/api/bootstrap':
            saved = disk.read_json(state_directory() / 'last-project.json', {})
            default_root = saved.get('root') if Path(saved.get('root') or '').is_dir() and saved.get('root') else str(BASE)
            return self.respond({'token': TOKEN, 'model': 'Qwen3.5 · 2B', 'home': str(Path.home()), 'default_root': default_root, 'default_provider': saved.get('provider'), 'full_access': os.environ.get('ARKO_CODEX_FULL_ACCESS') == '1', 'archify': repo.ARCHIFY.is_file(), 'codex': bool(codex_agent.executable()), 'codex_models': codex_agent.models(), 'jev': jev_helper.configured()})
        if parsed.path == '/api/codex/status':
            return self.respond(codex_agent.account_status())
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
        assets.update({'/forge.css': ('forge.css', 'text/css; charset=utf-8'),
                       '/code-ui.js': ('code-ui.js', 'text/javascript; charset=utf-8'),
                       '/assets/forge-geist.woff2': ('assets/forge-geist.woff2', 'font/woff2'),
                       '/assets/forge-geist-mono.woff2': ('assets/forge-geist-mono.woff2', 'font/woff2')})
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
            if length < 1 or length > 12 * 1024 * 1024:
                raise ValueError('Request size is invalid')
            data = json.loads(self.rfile.read(length))
            route = urlsplit(self.path).path
            if route in {'/api/codex/login', '/api/codex/logout'}:
                if not INFERENCE_LOCK.acquire(blocking=False):
                    return self.respond({'error': 'Finish or stop the current run before changing accounts.'}, 409)
                try:
                    result = codex_agent.login() if route.endswith('/login') else codex_agent.logout()
                finally:
                    INFERENCE_LOCK.release()
                return self.respond(result)
            if urlsplit(self.path).path == '/api/stop':
                with RUN_LOCK:
                    process = RUNS.get(data.get('id'))
                    record = RUN_RECORDS.get(data.get('id'))
                    if record and not record['finished']:
                        record['stop_requested'] = True
                if process:
                    stop_process(process)
                return self.respond({'stopped': bool(process or (record and not record['finished']))})
            root = repo.project_root(data['root'])
            route = urlsplit(self.path).path
            if route in {'/api/sessions/load', '/api/sessions/save'}:
                provider = data.get('provider', 'qwen')
                if provider not in {'qwen', 'codex'}:
                    raise ValueError('Unknown assistant mode')
                account_id = None
                if provider == 'codex':
                    account = codex_agent.account_status()
                    if not account.get('signed_in') or account.get('account_id') != data.get('account_id'):
                        return self.respond({'error':'Sign in with this session’s Codex account.'}, 403)
                    account_id = account['account_id']
                key = hashlib.sha256(json.dumps([str(root), provider, account_id]).encode()).hexdigest()
                path = state_directory() / 'sessions' / (key + '.json')
                if route.endswith('/load'):
                    return self.respond({'saved':disk.read_json(path)})
                saved = data.get('saved')
                if not isinstance(saved, dict) or not isinstance(saved.get('sessions'), list) or len(saved['sessions']) > 100 or len(json.dumps(saved)) > 4 * 1024 * 1024:
                    raise ValueError('Invalid saved sessions')
                if any(not isinstance(session, dict) or not isinstance(session.get('id'), str) or not isinstance(session.get('messages'), list) for session in saved['sessions']):
                    raise ValueError('Invalid saved session')
                with SESSION_LOCK:
                    previous = disk.read_json(path, {}).get('sessions', [])
                    merged = {session['id']:session for session in previous}
                    for session in saved['sessions']:
                        older = merged.get(session['id'])
                        if older is None or session.get('updatedAt', 0) >= older.get('updatedAt', 0):
                            merged[session['id']] = session
                    saved = {**saved, 'sessions':sorted(merged.values(), key=lambda session:session.get('updatedAt', 0), reverse=True)[:100]}
                    disk.write_json(path, saved)
                    disk.write_json(state_directory() / 'last-project.json', {'root':str(root), 'provider':provider})
                return self.respond({'saved':True})
            if route == '/api/preview/connect':
                return self.respond(preview_tools.connect(root, data['url'], PORT))
            if route == '/api/scan':
                return self.respond(repo.scan_repository(root))
            if route == '/api/skills':
                return self.respond({'skills': codex_skills.list_skills(root, data.get('refresh') is True)})
            if route == '/api/file':
                return self.respond(repo.read_project_file(root, data['path'], data.get('offset', 1), data.get('limit', 200)))
            if route == '/api/editor/read':
                return self.respond(editor_tools.read_source(root, data['path']))
            if route == '/api/editor/save':
                if not INFERENCE_LOCK.acquire(blocking=False):
                    return self.respond({'error': 'Wait for the assistant to finish before saving.'}, 409)
                try:
                    result = editor_tools.save_source(root, data['path'], data['content'], data['version'])
                finally:
                    INFERENCE_LOCK.release()
                return self.respond(result)
            if route == '/api/trace':
                return self.respond(repo.trace_connections(repo.scan_repository(root), data['path']))
            if route == '/api/diff':
                return self.respond(repo.review_diff(root))
            if route == '/api/diagram':
                return self.respond(repo.archify_diagram(repo.scan_repository(root), data.get('path'), data.get('scope', 'file')))
            if route == '/api/run':
                return self.reconnect(root, data)
            if route == '/api/chat':
                return self.chat(root, data)
            self.respond({'error': 'Not found'}, 404)
        except (KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired) as exc:
            self.respond({'error': str(exc)}, 400)

    def chat(self, root, data):
        provider = data.get('provider', 'qwen')
        if provider not in {'qwen', 'codex'}:
            raise ValueError('Unknown assistant mode')
        if provider == 'codex' and not codex_agent.executable():
            raise ValueError('Install Codex CLI and run codex login first')
        if provider == 'codex':
            account = codex_agent.account_status()
            if not account['signed_in']:
                return self.respond({'error': 'Sign in to Codex, then send your request again.'}, 401)
            if data.get('account_id') != account['account_id']:
                return self.respond({'error': 'Codex account changed. Refresh the account before sending.'}, 409)
        model = data.get('codex_model', '')
        jev_enabled = data.get('jev_enabled', False)
        live = data.get('live', False)
        full_access = data.get('full_access', os.environ.get('ARKO_CODEX_FULL_ACCESS') == '1')
        if not isinstance(full_access, bool):
            raise ValueError('Full access must be enabled or disabled')
        if not isinstance(live, bool):
            raise ValueError('Live editing must be enabled or disabled')
        if not isinstance(jev_enabled, bool):
            raise ValueError('Jev must be enabled or disabled')
        if not isinstance(model, str) or (model and model not in {m['id'] for m in codex_agent.models()}):
            raise ValueError('Choose an available Codex model')
        images = data.get('images', [])
        skill_names = data.get('skills', [])
        if not isinstance(skill_names, list) or len(skill_names) > 10 or any(not isinstance(name, str) for name in skill_names):
            raise ValueError('Choose up to 10 installed skills')
        skills = []
        if skill_names:
            if provider != 'codex':
                raise ValueError('Use Codex for skills')
            available = {skill['name']: skill for skill in codex_skills.list_skills(root)}
            for name in dict.fromkeys(skill_names):
                if name not in available:
                    raise ValueError('Skill is unavailable: ' + name)
                skills.append({'name': name, 'path': available[name]['path']})
        codex_agent.validate_images(images)
        if images and provider != 'codex':
            raise ValueError('Switch to Codex to send images. This Qwen setup supports text only.')
        messages = data.get('messages')
        if not isinstance(messages, list) or not messages or len(messages) > 30 or any(not isinstance(m, dict) or m.get('role') not in {'user', 'assistant'} or not isinstance(m.get('content'), str) for m in messages):
            raise ValueError('Chat needs user and assistant text messages')
        selected = data.get('selected_file')
        if selected:
            repo.project_file(root, selected)
        if not INFERENCE_LOCK.acquire(blocking=False):
            return self.respond({'error': 'An assistant is already answering. Wait for it to finish or stop the current run.'}, 409)
        run_id = data.get('request_id') or uuid.uuid4().hex
        if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{32}', run_id):
            INFERENCE_LOCK.release()
            raise ValueError('Invalid run ID')
        record = {'root': str(root), 'account_id': data.get('account_id') if provider == 'codex' else None,
                  'events': [{'type': 'run', 'id': run_id}], 'finished': False,
                  'condition': threading.Condition()}
        with RUN_LOCK:
            if run_id in RUN_RECORDS:
                INFERENCE_LOCK.release()
                return self.respond({'error': 'Run ID already exists. Reconnect to the existing run.'}, 409)
            RUN_RECORDS[run_id] = record
            # Keep recent completed runs available for refresh without retaining unlimited history.
            completed = [key for key, value in RUN_RECORDS.items() if value['finished']]
            for key in completed[:-20]:
                RUN_RECORDS.pop(key, None)
        payload = {'review_root': str(root), 'selected_file': selected, 'messages': messages,
                   'images': images, 'codex_model': model, 'jev_enabled': provider == 'codex' and jev_enabled,
                   'full_access': provider == 'codex' and full_access, 'live': provider == 'codex' and (live or bool(skills)), 'skills': skills}
        try:
            checkpoint_run(run_id, record)
            disk.append_event(state_directory() / 'runs' / (run_id + '.jsonl'), record['events'][0])
        except OSError:
            RUN_RECORDS.pop(run_id, None)
            INFERENCE_LOCK.release()
            raise
        threading.Thread(target=run_assistant, args=(run_id, record, provider, payload), daemon=True).start()
        return self.stream_run(record)

    def reconnect(self, root, data):
        with RUN_LOCK:
            record = RUN_RECORDS.get(data.get('id'))
            if record is None:
                record = recover_run(data.get('id'))
                if record is not None:
                    RUN_RECORDS[data['id']] = record
        if record is None or record['root'] != str(root):
            return self.respond({'error': 'This run is no longer available. The workspace server may have restarted.'}, 404)
        if record['account_id'] is not None:
            account = codex_agent.account_status()
            if not account.get('signed_in') or account.get('account_id') != record['account_id'] or data.get('account_id') != record['account_id']:
                return self.respond({'error': 'Sign in with the account that started this run.'}, 403)
        return self.stream_run(record)

    def stream_run(self, record):
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            cursor = 0
            while True:
                with record['condition']:
                    record['condition'].wait_for(lambda: len(record['events']) > cursor or record['finished'])
                    events = record['events'][cursor:]
                    finished = record['finished']
                for event in events:
                    self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode())
                    self.wfile.flush()
                cursor += len(events)
                if finished:
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass


def run_assistant(run_id, record, provider, payload):
    process = None
    trace = []
    def publish(event):
        with record['condition']:
            disk.append_event(state_directory() / 'runs' / (run_id + '.jsonl'), event)
            record['events'].append(event)
            record['condition'].notify_all()
    try:
        script = 'codex_agent.py' if provider == 'codex' else 'agent.py'
        process = subprocess.Popen([sys.executable, '-u', str(BASE / script)], cwd=BASE,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, start_new_session=True)
        with RUN_LOCK:
            RUNS[run_id] = process
            stopped = record.get('stop_requested', False)
        if stopped:
            stop_process(process)
        process.stdin.write(json.dumps(payload) + '\n')
        process.stdin.close()
        finished = False
        for line in process.stdout:
            event = json.loads(line)
            trace.append(event)
            if event.get('type') == 'done':
                finished = True
            if event.get('type') != 'history':
                publish(event)
        process.wait()
        if not finished:
            publish({'type': 'error', 'text': 'Review stopped before completion.'})
    except (OSError, ValueError) as exc:
        publish({'type': 'error', 'text': str(exc)})
    finally:
        if process:
            stop_process(process)
            if process.stdout:
                process.stdout.close()
        with RUN_LOCK:
            RUNS.pop(run_id, None)
        INFERENCE_LOCK.release()
        with record['condition']:
            record['finished'] = True
            checkpoint_run(run_id, record)
            record['condition'].notify_all()
        LOGS.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = LOGS / f'{run_id}.json'
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'provider': provider, 'codex_model': payload['codex_model'],
                       'image_count': len(payload['images']), 'project': payload['review_root'],
                       'selected_file': payload['selected_file'], 'messages': payload['messages'],
                       'events': trace}, out, ensure_ascii=False)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Arko Workspace: http://127.0.0.1:{PORT}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with RUN_LOCK:
            for process in list(RUNS.values()):
                stop_process(process)
        server.server_close()
