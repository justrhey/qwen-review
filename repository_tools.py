"""Source-backed, local-only repository tools for Qwen and the review workspace."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

BASE = Path(__file__).resolve().parent
ARCHIFY = Path.home() / "archify/archify/bin/archify.mjs"
ARTIFACTS = Path.home() / ".local/state/local-qwen/diagrams"
MAX_FILE = 1024 * 1024
MAX_FILES = 1500
SKIP = {"node_modules", "runtime", "models", "backups", "downloads", "venv", "env", "__pycache__", "dist", "build", "target", "coverage", "vendor"}
EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".json", ".css", ".scss", ".svg", ".md", ".html", ".qml"}


def project_root(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("Choose an existing absolute project directory")
    return path.resolve()


def allowed(relative):
    parts = Path(relative).parts
    if not parts or any(p.startswith('.') or p in SKIP for p in parts):
        return False
    name = parts[-1].lower()
    sensitive = name in {"secrets.json", "credentials.json", "tokens.json", "service-account.json", "id_rsa", "id_ed25519"} or name.endswith(('.key.json', '.credentials.json'))
    return not sensitive and not any(word in name for word in ("package-lock", "pnpm-lock", "yarn.lock")) and Path(relative).suffix.lower() in EXTENSIONS


def project_file(root, relative):
    root = project_root(root)
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or not allowed(relative):
        raise ValueError("Choose a visible source file inside the project")
    current = root
    for part in path.parts:
        current /= part
        if current.is_symlink():
            raise ValueError("Symlinked files are excluded")
    resolved = current.resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("File is outside the project or does not exist")
    if resolved.stat().st_size > MAX_FILE:
        raise ValueError("File is larger than 1 MiB")
    return resolved


def read_project_file(root, path, offset=1, limit=100):
    file = project_file(root, path)
    data = file.read_bytes()
    if b'\0' in data:
        raise ValueError("Binary files are excluded")
    lines = data.decode('utf-8').splitlines()
    offset, limit = max(1, int(offset)), max(1, min(200, int(limit)))
    return {"path": path, "total_lines": len(lines), "offset": offset,
            "content": '\n'.join(f"{i + 1}: {line}" for i, line in enumerate(lines) if offset - 1 <= i < offset - 1 + limit)}


def _run(argv, cwd, limit=120000, timeout=45, input=None):
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(argv, cwd=cwd, input=input, stdout=output, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            raise ValueError(result.stderr.decode(errors='replace')[:1000] or "Command failed")
        output.seek(0)
        data = output.read(limit + 1)
        return data[:limit].decode(errors='replace'), len(data) > limit


def scan_repository(root):
    root = project_root(root)
    files, warnings = [], []
    # rg respects .gitignore and avoids walking dependencies and build outputs.
    argv = ['rg', '--files', '-0', '--hidden']
    for directory in SKIP:
        argv += ['-g', f'!{directory}/**', '-g', f'!**/{directory}/**']
    result = subprocess.run(argv, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if result.returncode not in (0, 1):
        raise ValueError(result.stderr.decode(errors='replace')[:1000])
    for relative in sorted(result.stdout.decode('utf-8').split('\0')):
        if not allowed(relative):
            continue
        try:
            project_file(root, relative)
        except ValueError:
            continue
        files.append(relative)
        if len(files) == MAX_FILES:
            warnings.append(f"Scan limited to {MAX_FILES} files. Open a smaller project folder for complete results.")
            break
    raw, truncated = _run(['node', str(BASE / 'repo-scan.cjs')], str(root), limit=4000000,
                         input=json.dumps({"root": str(root), "files": files}).encode())
    if truncated:
        raise ValueError("Dependency graph exceeded the scan limit; choose a smaller folder")
    parsed = json.loads(raw)
    warnings += parsed['warnings']
    known = set(files)
    for relative in files:
        if not relative.endswith('.py'):
            continue
        try:
            tree = ast.parse((root / relative).read_text())
        except (SyntaxError, UnicodeError):
            warnings.append(f"Cannot parse {relative}; Python imports omitted.")
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or '']
            for module in modules:
                base = Path('.')
                if isinstance(node, ast.ImportFrom) and node.level:
                    base = Path(relative).parent
                    for _ in range(node.level - 1):
                        base = base.parent
                stem = base / module.replace('.', '/')
                candidates = [str(stem) + '.py', str(stem / '__init__.py')]
                if isinstance(node, ast.ImportFrom):
                    candidates += [str(stem / a.name) + '.py' for a in node.names]
                targets = [p for p in candidates if p in known]
                item = {"source": relative, "specifier": module, "line": node.lineno, "kind": "import"}
                if targets:
                    parsed['edges'].extend({**item, "target": p} for p in dict.fromkeys(targets))
                elif isinstance(node, ast.ImportFrom) and node.level:
                    parsed['unresolved'].append(item)
                else:
                    parsed['external'].append(item)
    nodes = [{"id": p, "name": Path(p).name, "folder": str(Path(p).parent), "extension": Path(p).suffix} for p in files]
    edges = list({(e['source'], e['target'], e['line'], e['kind']): e for e in parsed['edges']}.values())
    return {"root": str(root), "name": root.name, "nodes": nodes, "edges": edges,
            "external": parsed['external'], "unresolved": parsed['unresolved'], "warnings": warnings,
            "scanned_at": time.strftime('%Y-%m-%d %H:%M:%S'),
            "scope": "Static JS/TS and Python imports in current working-tree files. Import reach indicates potential affected dependents, not guaranteed runtime breakage."}


def trace_connections(graph, path):
    if path not in {n['id'] for n in graph['nodes']}:
        raise ValueError("File is not in this repository snapshot")
    outgoing = [e for e in graph['edges'] if e['source'] == path]
    incoming = [e for e in graph['edges'] if e['target'] == path]
    reverse = {}
    for edge in graph['edges']:
        reverse.setdefault(edge['target'], set()).add(edge['source'])
    seen, frontier = {path}, [path]
    while frontier:
        current = frontier.pop()
        for source in reverse.get(current, set()) - seen:
            seen.add(source)
            frontier.append(source)
    return {"path": path, "imports": outgoing, "imported_by": incoming,
            "potential_dependents": sorted(seen - {path}),
            "external": [e for e in graph['external'] if e['source'] == path],
            "unresolved": [e for e in graph['unresolved'] if e['source'] == path],
            "scope": graph['scope']}


def review_diff(root):
    root = project_root(root)
    graph = scan_repository(root)
    paths = [n['id'] for n in graph['nodes']]
    tracked, _ = _run(['git', 'ls-files', '-z'], str(root), limit=1000000)
    for path in tracked.split('\0'):
        if allowed(path) and path not in paths:
            # Deleted tracked source still belongs in the review.
            if not any((root / Path(*Path(path).parts[:i])).is_symlink() for i in range(1, len(Path(path).parts) + 1)):
                paths.append(path)
    if not paths:
        return {"diff": "", "status": "No source files found", "truncated": False}
    # An argument array and disabled external diff/textconv avoid executing repo hooks.
    diff, cut = _run(['git', '--literal-pathspecs', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', *paths], str(root), limit=40000)
    status, status_cut = _run(['git', '--literal-pathspecs', 'status', '--short', '--', *paths], str(root), limit=10000)
    return {"diff": diff, "status": status, "truncated": cut or status_cut,
            "scope": "Tracked working-tree and staged source changes against HEAD, including deleted source. Untracked files appear in status; read them separately."}


def repository_map(root):
    graph = scan_repository(root)
    degree = {}
    for edge in graph['edges']:
        degree[edge['source']] = degree.get(edge['source'], 0) + 1
        degree[edge['target']] = degree.get(edge['target'], 0) + 1
    return {"root": graph['root'], "name": graph['name'], "files": len(graph['nodes']), "connections": len(graph['edges']),
            "key_files": sorted(degree, key=lambda p: (-degree[p], p))[:30],
            "file_paths": [n['id'] for n in graph['nodes']][:100], "warnings": graph['warnings'], "scope": graph['scope']}


def project_tree_diagram(graph):
    """Self-contained, offline folder tree with every scanned file."""
    if not graph['nodes']:
        raise ValueError("No readable source files found in this project")
    assets = BASE / 'workspace'
    data = {"name": graph['name'], "paths": sorted(node['id'] for node in graph['nodes']),
            "connections": len(graph['edges']), "scope": graph['scope'], "warnings": graph['warnings']}
    # Protect the inline data boundary; labels are rendered with textContent.
    encoded = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    html = (assets / 'project-tree.html').read_text().replace('__TREE_CSS__', (assets / 'project-tree.css').read_text())
    html = html.replace('__TREE_JS__', (assets / 'project-tree.js').read_text()).replace('__TREE_DATA__', encoded)
    ARTIFACTS.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix='imports-', dir=ARTIFACTS))
    artifact = directory / 'map.html'
    artifact.write_text(html)
    return {"id": directory.name, "path": str(artifact), "scope": "project", "shown_files": len(graph['nodes']),
            "total_files": len(graph['nodes']), "connections": len(graph['edges']), "checks": "Self-contained offline folder tree."}


def archify_diagram(graph, path=None, scope='file'):
    if scope == 'project':
        return project_tree_diagram(graph)
    if scope != 'file':
        raise ValueError("Choose file or project diagram scope")
    trace = trace_connections(graph, path)
    incoming = sorted({e['source'] for e in trace['imported_by']} - {path})
    outgoing = sorted({e['target'] for e in trace['imports']} - {path})
    neighbors = incoming + [p for p in outgoing if p not in incoming and p != path]
    shown = neighbors[:24]
    selected = set(shown) | {path}
    identities = {p: 'file-' + hashlib.sha256(p.encode()).hexdigest()[:12] for p in selected}
    components = [{"id": identities[path], "type": "frontend" if path.endswith(('.jsx', '.tsx')) else "backend",
                   "label": Path(path).name, "sublabel": "Selected module", "pos": [360, 80 + max(len(incoming), len(outgoing), 1) * 44], "size": [220, 90]}]
    rows = {"incoming": 0, "outgoing": 0}
    for p in shown:
        side = 'incoming' if p in incoming else 'outgoing'
        row = rows[side]
        rows[side] += 1
        components.append({"id": identities[p], "type": "frontend" if p.endswith(('.jsx', '.tsx')) else "backend",
                           "label": Path(p).name, "sublabel": str(Path(p).parent)[-34:],
                           "pos": [40 if side == 'incoming' else 680, 80 + row * 150], "size": [220, 86]})
    edges = [e for e in trace['imports'] + trace['imported_by'] if e['source'] in selected and e['target'] in selected and e['source'] != e['target']]
    connections = [{"id": f"edge-{i}", "from": identities[e['source']], "to": identities[e['target']]} for i, e in enumerate({(e['source'], e['target']): e for e in edges}.values())]
    spec = {"schema_version": 1, "diagram_type": "architecture",
            "meta": {"title": f"{Path(path).name} · Import connections", "output": "map.html", "quality_profile": "standard"},
            "components": components, "connections": connections,
            "cards": [{"dot": "cyan", "title": "Source evidence", "items": [f"{e['source']}:{e['line']} — {e['kind']} {e['specifier']}" for e in edges[:12]]},
                      {"dot": "amber", "title": "Scope", "items": ["Current working-tree snapshot; arrows show parsed imports, not runtime calls.", f"Showing {len(shown)} of {len(neighbors)} direct neighbors. Full connections remain in the workspace."]}]}
    return {**render_archify(spec), "scope": "file", "shown_neighbors": len(shown), "total_neighbors": len(neighbors)}


def render_archify(spec):
    ARTIFACTS.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix='imports-', dir=ARTIFACTS))
    candidate = directory / 'candidate.json'
    candidate.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    if not ARCHIFY.is_file():
        raise ValueError(f"Archify is unavailable at {ARCHIFY}")
    _run(['node', str(ARCHIFY), 'render', 'architecture', str(candidate), str(directory / 'map.html'), '--quality', 'standard'], str(directory), timeout=60)
    return {"id": directory.name, "path": str(directory / 'map.html'), "candidate": str(candidate),
            "checks": "Archify renderer completed. Browser delivery gates were not run by this tool."}
