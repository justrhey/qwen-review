"""Discover enabled skills through the installed Codex app-server."""
import json
from pathlib import Path
import subprocess
import threading
import time

import codex_agent

CATALOGS = {}


def list_skills(root, refresh=False):
    root = str(Path(root).resolve())
    cached = CATALOGS.get(root)
    if not refresh and cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    binary = codex_agent.executable()
    if not binary:
        return []
    with subprocess.Popen([binary, 'app-server', '--listen', 'stdio://'], cwd=root,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True) as process:
        timer = threading.Timer(15, process.kill)
        timer.start()
        def send(message):
            process.stdin.write(json.dumps(message) + '\n')
            process.stdin.flush()
        try:
            send({'id': 1, 'method': 'initialize', 'params': {
                'clientInfo': {'name': 'qwen_review_skills', 'version': '0.1.0'}}})
            for line in process.stdout:
                event = json.loads(line)
                if event.get('error'):
                    raise ValueError(event['error'].get('message', 'Could not load skills'))
                if event.get('id') == 1:
                    send({'method': 'initialized', 'params': {}})
                    send({'id': 2, 'method': 'skills/list', 'params': {'cwds': [root], 'forceReload': refresh}})
                elif event.get('id') == 2:
                    skills = {}
                    for entry in event['result']['data']:
                        for skill in entry['skills']:
                            if skill.get('enabled', True) and skill['name'] not in skills:
                                skills[skill['name']] = {'name': skill['name'], 'path': skill['path'],
                                                        'description': skill.get('shortDescription') or skill.get('description', '')}
                    result = sorted(skills.values(), key=lambda skill: skill['name'])
                    CATALOGS[root] = (time.monotonic(), result)
                    return result
            raise ValueError('Codex did not return a skill list')
        finally:
            timer.cancel()
            process.stdin.close()
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
