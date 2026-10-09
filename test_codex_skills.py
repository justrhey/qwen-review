import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import codex_skills


class CodexSkillTests(unittest.TestCase):
    def test_inventory_uses_native_handshake_filters_disabled_and_caches_by_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'fake-codex'
            binary.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'id': request['id'], 'result': {}}), flush=True)
    elif request.get('method') == 'skills/list':
        Path('skill-query.json').write_text(json.dumps(request['params']))
        print(json.dumps({'id': request['id'], 'result': {'data': [{'skills': [
            {'name':'user-expi','path':'/installed/user-expi/SKILL.md','enabled':True,'description':'Design flows'},
            {'name':'disabled-skill','path':'/installed/disabled/SKILL.md','enabled':False},
            {'name':'user-expi','path':'/duplicate/SKILL.md','enabled':True}
        ]}]}}), flush=True)
''')
            binary.chmod(0o700)
            with patch.object(codex_skills.codex_agent, 'executable', return_value=str(binary)) as executable:
                skills = codex_skills.list_skills(root, refresh=True)
                self.assertEqual(skills, [{'name':'user-expi','path':'/installed/user-expi/SKILL.md','description':'Design flows'}])
                query = json.loads(root.joinpath('skill-query.json').read_text())
                self.assertEqual(query, {'cwds':[str(root.resolve())],'forceReload':True})
                self.assertEqual(codex_skills.list_skills(root), skills)
                self.assertEqual(executable.call_count, 1)


if __name__ == '__main__':
    unittest.main()
