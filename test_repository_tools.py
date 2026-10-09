import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import agent
import repository_tools as repo


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qwen-repo-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write('src/main.tsx', 'import App from "./App";\nexport default App;\n')
        self.write('src/App.tsx', 'import { Button } from "@/Button";\nexport { value } from "./barrel";\nconst text = "import fake from \'./fake\'";\n// import nope from "./fake";\nconst lazy = import(`./lazy`);\nconst unknown = import(somePath);\n')
        self.write('src/Button.tsx', 'export const Button = 1;\n')
        self.write('src/barrel.ts', 'export { value } from "./value";\n')
        self.write('src/value.ts', 'export const value = 1;\n')
        self.write('src/lazy.ts', 'const app = require("./App");\n')
        self.write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}')

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, capture_output=True, check=True)

    def test_whole_project_preserves_files_and_import_counts(self):
        self.write('docs/overview.md', '# Overview\n')
        self.write('isolated.json', '{}')
        graph = repo.scan_repository(self.root)
        with patch.object(repo, 'ARTIFACTS', self.root / 'artifacts'):
            result = repo.archify_diagram(graph, scope='project')
        html = Path(result['path']).read_text()
        self.assertNotIn('__TREE_', html)
        self.assertIn('TREE_DATA = ', html)
        data = json.loads(html.split('const TREE_DATA = ', 1)[1].split(';</script>', 1)[0])
        self.assertEqual(set(data['paths']), {node['id'] for node in graph['nodes']})
        self.assertEqual(data['connections'], len(graph['edges']))
        for node in graph['nodes']:
            self.assertIn(node['id'], html)
        self.assertIn('isolated.json', html)
        self.assertIn('docs/overview.md', html)
        self.assertEqual(result['shown_files'], len(graph['nodes']))
        self.assertEqual(result['scope'], 'project')
        with self.assertRaisesRegex(ValueError, 'scope'):
            repo.archify_diagram(graph, scope='invalid')

    def test_project_tree_escapes_inline_script_boundary(self):
        self.write('src/evil<script>.tsx', 'export const value = 1;')
        graph = repo.scan_repository(self.root)
        graph['name'] = '</script><script>alert(1)</script>'
        with patch.object(repo, 'ARTIFACTS', self.root / 'artifacts'):
            result = repo.project_tree_diagram(graph)
        html = Path(result['path']).read_text()
        self.assertNotIn('</script><script>alert(1)</script>', html)
        self.assertIn('\\u003c/script\\u003e', html)

    def test_review_reads_named_file_before_model_and_recovers_access_refusal(self):
        request = {'review_root': str(self.root), 'messages': [{'role': 'user', 'content': 'Review src/value.ts'}]}
        seen = []
        def reply(messages, tools):
            seen.append(tools)
            self.assertTrue(any(message['role'] == 'tool' and 'export const value = 1' in message['content'] for message in messages))
            if len(seen) == 1:
                return {'role': 'assistant', 'content': 'I cannot access src/value.ts. Run read_project_file.'}
            self.assertEqual(tools, [])
            return {'role': 'assistant', 'content': 'src/value.ts exports value as 1.'}
        with patch.object(agent.sys, 'stdin', io.StringIO(json.dumps(request)+'\n')), patch.object(agent, 'completion', side_effect=reply), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(agent.main(), 0)
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        text = ''.join(event.get('text', '') for event in events if event['type'] == 'text')
        self.assertNotIn('cannot access', text)
        self.assertIn('exports value as 1', text)
        self.assertEqual(len(seen), 2)

    def test_invalid_raw_tool_text_is_recovered_without_displaying_markup(self):
        request = {'review_root': str(self.root), 'messages': [{'role': 'user', 'content': 'Explain the value module'}]}
        replies = [{'role': 'assistant', 'content': '<tool_call><function=read_project_file><parameter=path>src/value.ts</parameter></parameter>'},
                   {'role': 'assistant', 'content': 'value.ts exports a number.'}]
        with patch.object(agent.sys, 'stdin', io.StringIO(json.dumps(request)+'\n')), patch.object(agent, 'completion', side_effect=replies), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(agent.main(), 0)
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        text = ''.join(event.get('text', '') for event in events if event['type'] == 'text')
        self.assertNotIn('<tool_call>', text)
        self.assertIn('[src/value.ts:1](source:src/value.ts:1)', text)

    def test_long_source_tool_results_keep_valid_json_and_truncation(self):
        result = {'path': 'src/value.ts', 'content': '1: export const value = 1;\n' * 1000, 'total_lines': 1000, 'offset': 1}
        output = agent.source_tool_output(result)
        self.assertLessEqual(len(output), agent.OUTPUT_LIMIT)
        parsed = json.loads(output)
        self.assertEqual(parsed['path'], result['path'])
        self.assertTrue(parsed['truncated'])
        self.assertIn('export const value = 1;', parsed['content'])

    def test_file_resolution_rejects_unknown_and_ambiguous_names(self):
        self.write('other/value.ts', '')
        graph = repo.scan_repository(self.root)
        self.assertEqual(agent.referenced_project_files('value.ts /etc/passwd', graph), [])
        self.assertEqual(agent.referenced_project_files('Read `src/value.ts`', graph), ['src/value.ts'])
        self.assertEqual(agent.referenced_project_files('../src/value.ts', graph), [])

    def test_empty_whole_project_has_clear_error(self):
        with self.assertRaisesRegex(ValueError, 'No readable source files'):
            repo.project_tree_diagram({'nodes': [], 'edges': []})

    def test_ast_aliases_reexports_dynamic_imports_and_comments(self):
        graph = repo.scan_repository(self.root)
        facts = {(e['source'], e['target'], e['line']) for e in graph['edges']}
        self.assertIn(('src/App.tsx', 'src/Button.tsx', 1), facts)
        self.assertIn(('src/App.tsx', 'src/barrel.ts', 2), facts)
        self.assertIn(('src/App.tsx', 'src/lazy.ts', 5), facts)
        self.assertIn(('src/lazy.ts', 'src/App.tsx', 1), facts)
        self.assertFalse(any('fake' in e['specifier'] for e in graph['edges'] + graph['external'] + graph['unresolved']))
        self.assertEqual(graph['unresolved'][0]['specifier'], 'somePath')

    def test_reach_follows_reverse_edges_and_terminates_cycles(self):
        graph = repo.scan_repository(self.root)
        trace = repo.trace_connections(graph, 'src/value.ts')
        self.assertEqual(set(trace['potential_dependents']), {'src/barrel.ts', 'src/App.tsx', 'src/main.tsx', 'src/lazy.ts'})
        self.assertNotIn('src/Button.tsx', trace['potential_dependents'])
        self.assertEqual(repo.trace_connections(graph, 'src/App.tsx')['potential_dependents'], ['src/lazy.ts', 'src/main.tsx'])

    def test_sensitive_ignored_binary_and_symlinked_files_excluded(self):
        self.git('init', '-q')
        self.write('.gitignore', 'ignored/\n')
        self.write('ignored/no.ts', 'export const no = 1;')
        self.write('.env', 'secret')
        self.write('secrets.json', '{"password":"secret"}')
        self.write('node_modules/dep/index.js', 'module.exports = 1;')
        self.write('src/linked.ts', 'discard').unlink()
        (self.root / 'src/linked.ts').symlink_to('/etc/passwd')
        files = {n['id'] for n in repo.scan_repository(self.root)['nodes']}
        self.assertNotIn('ignored/no.ts', files)
        self.assertNotIn('secrets.json', files)
        self.assertNotIn('src/linked.ts', files)
        for path in ['../etc/passwd', '/etc/passwd', '.env', 'secrets.json', 'src/linked.ts']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                repo.read_project_file(self.root, path)

    def test_python_absolute_and_relative_imports(self):
        self.write('main.py', 'from package import helper\nimport main\n')
        self.write('package/__init__.py', '')
        self.write('package/helper.py', 'from . import sibling\n')
        self.write('package/sibling.py', '')
        graph = repo.scan_repository(self.root)
        facts = {(e['source'], e['target']) for e in graph['edges']}
        self.assertIn(('main.py', 'package/helper.py'), facts)
        self.assertIn(('package/helper.py', 'package/sibling.py'), facts)

    def test_review_includes_staged_unstaged_and_deleted_source(self):
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
        self.write('src/Button.tsx', 'export const Button = 2;\n')
        self.git('add', 'src/Button.tsx')
        self.write('src/value.ts', 'export const value = 3;\n')
        (self.root / 'src/lazy.ts').unlink()
        self.write('.env', 'hidden secret')
        self.write('src/new.ts', 'export const fresh = 1;\n')
        result = repo.review_diff(self.root)
        self.assertIn('+export const Button = 2;', result['diff'])
        self.assertIn('+export const value = 3;', result['diff'])
        self.assertIn('deleted file mode', result['diff'])
        self.assertIn('src/new.ts', result['status'])
        self.assertNotIn('hidden secret', result['diff'])
        self.assertNotIn('.env', result['status'])

    def test_review_agent_enforces_tool_and_root_scope(self):
        call = lambda name, args: {'id': 'test', 'function': {'name': name, 'arguments': json.dumps(args)}}
        with patch.object(agent, 'REVIEW_ROOT', self.root), contextlib.redirect_stdout(io.StringIO()), patch.object(agent, 'approve') as approval:
            result = agent.execute(call('run_command', {'cwd': str(self.root), 'command': 'touch nope'}))
            self.assertIn('only repository-reading', result)
            approval.assert_not_called()
            result = agent.execute(call('read_project_file', {'root': '/tmp', 'path': 'file.ts'}))
            self.assertIn('only inspect the selected project', result)
            result = agent.execute(call('read_project_file', {'root': str(self.root), 'path': 'src/value.ts'}))
            self.assertIn('1: export const value', result)
        self.assertFalse((self.root / 'nope').exists())

    def test_workspace_tool_schema_binds_root_and_reads_relative_path(self):
        for tool in agent.REVIEW_TOOLS:
            self.assertNotIn('root', tool['function']['parameters']['properties'])
        with patch.object(agent, 'REVIEW_ROOT', self.root), contextlib.redirect_stdout(io.StringIO()):
            result = agent.execute({'id': 'bound', 'function': {'name': 'read_project_file', 'arguments': '{"path":"src/value.ts"}'}})
        self.assertIn('1: export const value', result)

    def test_round_limit_keeps_system_prompt_at_beginning(self):
        request = json.dumps({'messages': [{'role': 'user', 'content': 'test'}]}) + '\n'
        def reply(messages, tools):
            self.assertEqual([m['role'] for m in messages], ['system', 'user'])
            self.assertIn('Tool round limit reached', messages[0]['content'])
            self.assertEqual(tools, [])
            return {'role': 'assistant', 'content': 'done'}
        with patch.object(agent.sys, 'stdin', io.StringIO(request)), patch.object(agent, 'MAX_STEPS', 0), patch.object(agent, 'completion', side_effect=reply), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(agent.main(), 0)

    def test_runtime_adds_links_from_verified_tool_evidence(self):
        request = json.dumps({'messages': [{'role': 'user', 'content': 'Which file imports App?'}]}) + '\n'
        call = {'id': 'trace', 'function': {'name': 'trace_connections', 'arguments': json.dumps({'root': str(self.root), 'path': 'src/App.tsx'})}}
        responses = [{'role': 'assistant', 'content': '', 'tool_calls': [call]}, {'role': 'assistant', 'content': 'src/main.tsx imports it.'}]
        with patch.object(agent.sys, 'stdin', io.StringIO(request)), patch.object(agent, 'completion', side_effect=responses), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(agent.main(), 0)
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertIn('[src/main.tsx:1](source:src/main.tsx:1)', ''.join(e.get('text', '') for e in events if e['type'] == 'text'))


if __name__ == '__main__':
    unittest.main()
