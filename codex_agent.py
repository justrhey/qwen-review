"""Translate installed Codex CLI JSON events into workspace chat events."""
import json
import base64
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
import jev_helper


def executable():
    return shutil.which('codex') or (str(Path.home() / '.local/bin/codex')
                                   if (Path.home() / '.local/bin/codex').is_file() else None)


def models():
    cache = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'models_cache.json'
    try:
        return [{'id': item['slug'], 'name': item.get('display_name') or item['slug']}
                for item in json.loads(cache.read_text()).get('models', [])
                if item.get('visibility') == 'list' and isinstance(item.get('slug'), str)]
    except (OSError, ValueError, TypeError):
        return []


def account_status():
    binary = executable()
    result = {'installed': bool(binary), 'signed_in': False, 'account_id': '', 'label': 'Signed out', 'models': []}
    if not binary:
        result['label'] = 'Codex is not installed'
        return result
    try:
        login = subprocess.run([binary, 'login', 'status'], capture_output=True, text=True, timeout=5)
        if login.returncode:
            return result
        home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        try:
            auth = json.loads((home / 'auth.json').read_text())
        except (OSError, ValueError):
            auth = {}
        mode = auth.get('auth_mode', '')
        identity = (auth.get('tokens') or {}).get('account_id') or auth.get('OPENAI_API_KEY') or 'cli'
        result.update(signed_in=True, account_id=hashlib.sha256((mode + ':' + identity).encode()).hexdigest()[:24],
                      label='Signed in with ChatGPT' if mode == 'chatgpt' else 'Signed in with Codex', models=models())
    except (OSError, subprocess.TimeoutExpired):
        result['label'] = 'Could not check account · Refresh'
    return result


def login():
    binary = executable()
    if not binary:
        raise ValueError('Install Codex CLI first')
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        raise ValueError('Open your terminal and run codex login, then refresh the account here.')
    for name, flags in [('xdg-terminal-exec', []), ('kitty', []), ('konsole', ['-e']), ('gnome-terminal', ['--']), ('xterm', ['-e'])]:
        terminal = shutil.which(name)
        if terminal:
            subprocess.Popen([terminal, *flags, binary, 'login'], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {'message': 'Finish Codex login in the terminal that opened. This workspace updates automatically.'}
    raise ValueError('Open your terminal and run codex login, then refresh the account here.')


def logout():
    binary = executable()
    if not binary:
        raise ValueError('Codex CLI is not installed')
    result = subprocess.run([binary, 'logout'], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError('Codex could not sign out. Run codex logout in your terminal.')
    return account_status()


def validate_images(images):
    if not isinstance(images, list) or len(images) > 4:
        raise ValueError('Attach up to four images')
    decoded = []
    for image in images:
        if not isinstance(image, dict) or not isinstance(image.get('data'), str):
            raise ValueError('Invalid image attachment')
        data = base64.b64decode(image['data'], validate=True)
        if not data or len(data) > 2 * 1024 * 1024:
            raise ValueError('Each image must be under 2 MiB')
        mime = image.get('mime')
        valid = ((mime == 'image/png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or
                 (mime == 'image/jpeg' and data.startswith(b'\xff\xd8\xff')) or
                 (mime == 'image/webp' and data.startswith(b'RIFF') and data[8:12] == b'WEBP'))
        if not valid:
            raise ValueError('Attach a PNG, JPEG or WebP image')
        decoded.append(({'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}[mime], data))
    return decoded


def reasoning_levels(model):
    home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    try:
        if not model:
            config = tomllib.loads((home / 'config.toml').read_text())
            profile = config.get('profiles', {}).get(config.get('profile'), {})
            model = profile.get('model', config.get('model'))
        catalog = json.loads((home / 'models_cache.json').read_text())
        for item in catalog.get('models', []):
            if item.get('slug') == model:
                supported = {level['effort'] for level in item.get('supported_reasoning_levels', [])}
                return [effort for effort in jev_helper.EFFORTS if effort in supported]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return []


def command(binary, root, output, model='', images=(), effort='', full_access=False):
    args = [binary, 'exec', '--json', '--ephemeral', '--sandbox', 'danger-full-access' if full_access else 'workspace-write',
            '-c', 'approval_policy="never"', '--skip-git-repo-check', '--color', 'never',
            '--cd', str(root), '--output-last-message', str(output)]
    if model:
        args += ['--model', model]
    if effort:
        if effort not in jev_helper.EFFORTS:
            raise ValueError('Invalid reasoning effort')
        args += ['-c', 'model_reasoning_effort=' + json.dumps(effort)]
    for image in images:
        args += ['--image', str(image)]
    return args + ['-']


def translate(event):
    kind = event.get('type')
    if kind in {'error', 'turn.failed'}:
        error = event.get('error') or {}
        return {'type': 'error', 'text': event.get('message') or error.get('message') or 'Codex failed.'}
    item = event.get('item', {})
    if kind not in {'item.started', 'item.completed'}:
        return None
    if item.get('type') == 'agent_message' and kind == 'item.completed':
        return {'type': 'text', 'text': item.get('text', '') + '\n\n', 'block': True}
    if item.get('type') in {'command_execution', 'file_change', 'mcp_tool_call', 'web_search'}:
        failed = item.get('status') == 'failed' or item.get('exit_code') not in (None, 0)
        return {'type': 'action', 'id': item['id'], 'name': item['type'],
                'summary': item.get('command') or item.get('query') or item['type'].replace('_', ' '),
                'status': 'error' if failed else 'done' if kind == 'item.completed' else 'running',
                'output': (item.get('aggregated_output') or json.dumps(item.get('changes', [])))[:16000]}
    return None


def emit(event):
    print(json.dumps(event), flush=True)


def main():
    data = json.loads(sys.stdin.readline())
    binary = executable()
    if not binary:
        emit({'type': 'error', 'text': 'Codex CLI is not installed. Install it and run codex login.'})
        return
    root = Path(data['review_root']).resolve()
    prompt = ('You are working in the project shown in a code review workspace. '
              'Read actual source before conclusions; cite paths and lines. Follow project AGENTS.md. '
              'For review/explanation requests do not edit. For explicit implementation requests, '
              'make focused changes and run relevant checks. Never push, publish, or discard user changes '
              'unless explicitly requested. Report blocked commands honestly. '
              'Previous conversation is context; act on the latest user request.\n'
              + 'Selected file: ' + str(data.get('selected_file') or '(none)') + '\n'
              + json.dumps(data['messages'], ensure_ascii=False))
    effort = ''
    if data.get('jev_enabled') is True:
        emit({'type': 'action', 'id': 'jev-profile', 'name': 'jev_reasoning',
              'summary': 'Jev · choosing reasoning effort and programming focus', 'status': 'running'})
        try:
            profile = jev_helper.select_profile(data, reasoning_levels(data.get('codex_model', '')))
            effort = profile.get('effort', '') if profile.get('effort_confidence', 0) >= .85 else ''
            if profile.get('focus_confidence', 0) < .85:
                profile['focus'] = 'general'
            prompt += '\nProgramming focus suggestion (does not change the user’s scope): ' + jev_helper.GUIDANCE[profile['focus']]
            emit({'type': 'action', 'id': 'jev-profile', 'name': 'jev_reasoning',
                  'summary': 'Jev · ' + (effort or 'CLI default') + ' reasoning · ' + profile['focus'],
                  'status': 'done', 'output': json.dumps(profile, indent=2)})
        except ValueError as error:
            emit({'type': 'action', 'id': 'jev-profile', 'name': 'jev_reasoning',
                  'summary': 'Jev unavailable · continuing with Codex defaults', 'status': 'error', 'output': str(error)})
    with tempfile.TemporaryDirectory(prefix='qwen-codex-') as directory:
        output = Path(directory) / 'answer.txt'
        images = []
        for index, (extension, content) in enumerate(validate_images(data.get('images', []))):
            path = Path(directory) / f'image-{index}{extension}'
            path.write_bytes(content)
            path.chmod(0o600)
            images.append(path)
        if data.get('live') is True or data.get('jev_enabled') is True:
            from codex_live import run
            run(binary, root, prompt, data.get('codex_model', ''), images, effort, emit, data.get('skills', []), jev_data=data if data.get('jev_enabled') is True else None, full_access=data.get('full_access') is True)
            return
        with (Path(directory) / 'stderr.log').open('w+') as errors:
            process = subprocess.Popen(command(binary, root, output, data.get('codex_model', ''), images, effort, data.get('full_access') is True), cwd=root, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=errors, text=True)
            try:
                process.stdin.write(prompt)
                process.stdin.close()
                had_text = failed = completed = False
                for line in process.stdout:
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    completed |= raw.get('type') == 'turn.completed'
                    event = translate(raw)
                    if event:
                        had_text |= event['type'] == 'text'
                        failed |= event['type'] == 'error'
                        emit(event)
                code = process.wait()
                if code or failed or not completed:
                    if not failed:
                        emit({'type': 'error', 'text': f'Codex exited before completion (exit {code}). Check codex login status and CLI configuration.'})
                else:
                    if not had_text and output.is_file():
                        emit({'type': 'text', 'text': output.read_text()})
                    emit({'type': 'done'})
            finally:
                process.stdout.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'type': 'error', 'text': str(error)})
