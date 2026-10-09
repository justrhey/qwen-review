"""Connect local static frontends to route-preserving preview updates."""
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener
import editor_tools

class LocalRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        url = urlsplit(newurl)
        if url.scheme not in {'http', 'https'} or url.hostname not in {'localhost', '127.0.0.1'} or url.username or url.password:
            raise ValueError('Preview redirected outside localhost')
        return super().redirect_request(request, response, code, message, headers, newurl)


urlopen = build_opener(LocalRedirect()).open
BRIDGE = Path(__file__).parent / 'workspace/preview-bridge.js'


def connect(root, value, workspace_port):
    url = urlsplit(value)
    if url.scheme not in {'http', 'https'} or url.hostname not in {'localhost', '127.0.0.1'} or url.username or url.password or url.port == workspace_port:
        raise ValueError('Choose a local app URL on another port')
    try:
        with urlopen(value, timeout=3) as response:
            final = urlsplit(response.url)
            if final.hostname not in {'localhost', '127.0.0.1'}:
                raise ValueError('Preview redirected outside localhost')
            served = response.read(1024 * 1024).decode('utf-8')
    except (OSError, ValueError):
        return {'connected':False}
    for relative in ['workspace/index.html', 'index.html', 'public/index.html']:
        try:
            source = editor_tools.read_source(root, relative)
        except (OSError, ValueError):
            continue
        if source['content'] != served:
            continue
        folder = Path(relative).parent
        bridge_path = root / folder / 'arko-preview.js'
        bridge_path.resolve().relative_to(root)
        if bridge_path.exists() and not bridge_path.read_text().startswith('/* Arko local preview bridge */'):
            raise ValueError('An unrelated arko-preview.js already exists')
        bridge_path.write_text(BRIDGE.read_text())
        public_folder = '' if str(folder) in {'.', 'public'} else str(folder) + '/'
        tag = f'<script src="/{public_folder}arko-preview.js" defer data-arko-preview></script>'
        if 'data-arko-preview' not in source['content']:
            if '</head>' not in source['content']:
                return {'connected':False}
            editor_tools.save_source(root, relative, source['content'].replace('</head>', '  ' + tag + '\n</head>', 1), source['version'])
        return {'connected':True}
    return {'connected':False}
