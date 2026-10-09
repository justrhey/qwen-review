"""Stream Codex app-server patch updates into the local editor."""
import json
from pathlib import Path
import subprocess

import jev_helper


def patch_event(params, root, status='writing'):
    changes = []
    for change in params.get('changes', []):
        path = Path(change['path'])
        path = (path if path.is_absolute() else root / path).resolve()
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        changes.append({'path': relative, 'diff': change.get('diff', ''),
                        'kind': change.get('kind', {}).get('type', 'update')})
    return {'type': 'patch', 'id': params.get('itemId', params.get('id', '')),
            'status': status, 'changes': changes}


def run(binary, root, prompt, model, images, effort, emit, skills=(), jev_data=None, full_access=False):
    root = Path(root).resolve()
    policy = 'on-request' if jev_data is not None and not full_access else 'never'
    args = [binary, 'app-server', '--listen', 'stdio://', '--enable', 'apply_patch_streaming_events',
            '-c', 'approval_policy=' + json.dumps(policy)]
    streamed_messages = set()
    commands = {}
    items = {}
    evidence = []
    answer_parts = []

    def approve(method, params):
        action_id = 'jev-gate-' + str(params.get('approvalId') or params.get('itemId', 'action'))
        emit({'type':'action', 'id':action_id, 'name':'jev_gate', 'summary':'Checking action scope', 'status':'running'})
        decision = 'decline'
        try:
            item = items.get(params.get('itemId'), {})
            if method == 'item/fileChange/requestApproval':
                if params.get('grantRoot'):
                    raise ValueError('Session-wide write grants are not automatically approved')
                changes = item.get('changes', [])
                if not changes:
                    raise ValueError('No proposed file changes were supplied')
                for change in changes:
                    path = Path(change['path'])
                    (path if path.is_absolute() else root / path).resolve().relative_to(root)
                    move = change.get('kind', {}).get('move_path') or change.get('kind', {}).get('movePath')
                    if move:
                        moved = Path(move)
                        (moved if moved.is_absolute() else root / moved).resolve().relative_to(root)
                action = {'type':'fileChange', 'changes':patch_event(item, root)['changes']}
                if len(json.dumps(action)) > 12000:
                    raise ValueError('Proposed patch is too large for a bounded scope check')
            elif method == 'item/commandExecution/requestApproval':
                if params.get('kind', 'command') != 'command':
                    raise ValueError('Interactive command input is not automatically approved')
                if params.get('additionalPermissions') or params.get('networkApprovalContext'):
                    raise ValueError('Additional filesystem or network grants are not automatically approved')
                Path(params.get('cwd') or str(root)).resolve().relative_to(root)
                command = params.get('command') or item.get('command', '')
                if not command or len(command) > 4000:
                    raise ValueError('No bounded command was supplied')
                action = {'type':'commandExecution', 'command':command, 'reason':str(params.get('reason') or '')[:1000]}
            else:
                raise ValueError('This interactive request is not supported by the action gate')
            result = jev_helper.check_action(jev_data, action)
            allowed = result['action'] == 'allow' and result['action_confidence'] >= .85
            available = params.get('availableDecisions')
            if available is not None and 'accept' not in available:
                allowed = False
            decision = 'accept' if allowed else 'decline'
            output = json.dumps(result)
            summary = 'Action allowed' if allowed else 'Action declined · scope uncertain or outside request'
        except (ValueError, KeyError, TypeError) as error:
            output = str(error)
            summary = 'Action declined · scope check unavailable'
        emit({'type':'action', 'id':action_id, 'name':'jev_gate', 'summary':summary,
              'status':'done' if decision == 'accept' else 'error', 'output':output})
        return decision

    with subprocess.Popen(args, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, bufsize=1) as process:
        def send(message):
            process.stdin.write(json.dumps(message) + '\n')
            process.stdin.flush()

        def request(request_id, method, params):
            send({'id': request_id, 'method': method, 'params': params})

        try:
            request(1, 'initialize', {'clientInfo': {'name': 'qwen_review', 'version': '0.1.0'},
                                    'capabilities': {'experimentalApi': True}})
            for line in process.stdout:
                event = json.loads(line)
                if 'method' not in event:
                    if event.get('error'):
                        raise ValueError(event['error'].get('message', 'Codex request failed'))
                    if event.get('id') == 1:
                        send({'method': 'initialized', 'params': {}})
                        params = {'cwd': str(root), 'sandbox': 'danger-full-access' if full_access else 'read-only' if jev_data is not None else 'workspace-write',
                                  'approvalPolicy': policy, 'ephemeral': True,
                                  'developerInstructions': 'Use apply_patch for code edits so the editor can show live patches. Keep explanations concise. ' + ('Mutating actions require individual scope checks. Request approval when the read-only sandbox blocks an authorized project edit or command. Do not bypass declined actions or claim checks passed unless their actual recorded results support it.' if jev_data is not None and not full_access else '')}
                        if model:
                            params['model'] = model
                        request(2, 'thread/start', params)
                    elif event.get('id') == 2:
                        inputs = [{'type': 'text', 'text': prompt, 'text_elements': []}]
                        inputs += [{'type': 'localImage', 'path': str(path)} for path in images]
                        inputs += [{'type': 'skill', 'name': skill['name'], 'path': skill['path']} for skill in skills]
                        params = {'threadId': event['result']['thread']['id'], 'input': inputs}
                        if effort:
                            params['effort'] = effort
                        request(3, 'turn/start', params)
                    continue
                method, params = event['method'], event.get('params', {})
                if 'id' in event and jev_data is not None and method in {'item/fileChange/requestApproval', 'item/commandExecution/requestApproval'}:
                    send({'id':event['id'], 'result':{'decision':approve(method, params)}})
                elif 'id' in event:
                    send({'id': event['id'], 'error': {'code': -32601, 'message': 'Interactive requests are unavailable in this workspace.'}})
                    emit({'type': 'notice', 'text': 'Codex requested an interactive action. It was not approved.'})
                elif method == 'item/agentMessage/delta':
                    item_id = params['itemId']
                    answer_parts.append(params['delta'])
                    emit({'type': 'text', 'text': params['delta'], 'block': item_id not in streamed_messages})
                    streamed_messages.add(item_id)
                elif method == 'item/fileChange/patchUpdated':
                    items[params['itemId']] = {'id':params['itemId'], 'changes':params.get('changes', [])}
                    emit(patch_event(params, root))
                elif method in {'item/started', 'item/completed'}:
                    item = params['item']
                    items[item['id']] = item
                    kind = item['type']
                    status = 'error' if item.get('status') in {'failed', 'declined'} or item.get('exitCode') not in (None, 0) else 'done' if method == 'item/completed' else 'running'
                    if kind == 'fileChange':
                        emit(patch_event(item, root, 'applied' if status == 'done' else 'error' if status == 'error' else 'writing'))
                    if kind in {'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'}:
                        emit({'type': 'action', 'id': item['id'], 'name': kind,
                              'summary': item.get('command') or item.get('tool') or kind,
                              'status': status, 'output': item.get('aggregatedOutput') or ''})
                    if method == 'item/completed' and kind in {'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'}:
                        evidence.append({'type':kind, 'status':status, 'command':str(item.get('command') or item.get('tool') or '')[:2000], 'exitCode':item.get('exitCode'), 'output':str(item.get('aggregatedOutput') or '')[-2000:], 'files':[c['path'] for c in patch_event(item, root)['changes']] if kind == 'fileChange' else []})
                    if kind == 'commandExecution':
                        commands[item['id']] = item
                    if kind == 'agentMessage' and method == 'item/completed':
                        if item['id'] not in streamed_messages:
                            answer_parts.append(item['text'])
                            emit({'type': 'text', 'text': item['text'], 'block': True})
                elif method == 'item/commandExecution/outputDelta':
                    command = commands.get(params['itemId'], {})
                    emit({'type': 'action', 'id': params['itemId'], 'name': 'commandExecution',
                          'summary': command.get('command', 'Command'), 'status': 'running',
                          'output_delta': params['delta']})
                elif method == 'error' and not params.get('willRetry'):
                    raise ValueError(params.get('error', {}).get('message', 'Codex failed'))
                elif method == 'turn/completed':
                    turn = params['turn']
                    if turn['status'] != 'completed':
                        raise ValueError((turn.get('error') or {}).get('message', 'Codex stopped before completion'))
                    if jev_data is not None:
                        emit({'type':'action', 'id':'jev-completion', 'name':'jev_eval', 'summary':'Checking completion claims', 'status':'running'})
                        try:
                            result = jev_helper.check_completion(jev_data, ''.join(answer_parts), evidence)
                            supported = result['completion'] == 'supported' and result['completion_confidence'] >= .85
                            emit({'type':'action', 'id':'jev-completion', 'name':'jev_eval', 'summary':'Completion claims supported' if supported else 'Completion claims need review', 'status':'done' if supported else 'error', 'output':json.dumps(result)})
                            if not supported:
                                emit({'type':'notice', 'text':'JEV could not substantiate the completion claims from the recorded actions. Review the edits and check results.'})
                        except ValueError as error:
                            emit({'type':'action', 'id':'jev-completion', 'name':'jev_eval', 'summary':'Completion check unavailable', 'status':'error', 'output':str(error)})
                    emit({'type': 'done'})
                    return
            raise ValueError('Codex stream ended before completion')
        finally:
            process.stdin.close()
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
