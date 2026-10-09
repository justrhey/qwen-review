"""Read and save whole source files with stale-write protection."""
import hashlib
import os
import stat
import tempfile
import threading

import repository_tools as repo

SAVE_LOCK = threading.Lock()


def read_source(root, relative):
    file = repo.project_file(root, relative)
    data = file.read_bytes()
    if b'\0' in data:
        raise ValueError('Binary files cannot be edited')
    return {'path': relative, 'content': data.decode('utf-8'),
            'version': hashlib.sha256(data).hexdigest()}


def save_source(root, relative, content, version):
    if not isinstance(content, str) or not isinstance(version, str):
        raise ValueError('Source text and version are required')
    data = content.encode('utf-8')
    if len(data) > repo.MAX_FILE or '\0' in content:
        raise ValueError('Source must be UTF-8 text under 1 MiB')
    with SAVE_LOCK:
        file = repo.project_file(root, relative)
        if read_source(root, relative)['version'] != version:
            raise ValueError('File changed on disk. Your edits are kept; reload before saving over newer changes.')
        fd, temporary = tempfile.mkstemp(prefix='.qwen-edit-', dir=file.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), stat.S_IMODE(file.stat().st_mode))
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            if read_source(root, relative)['version'] != version:
                raise ValueError('File changed while saving. Your edits are kept.')
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {'path': relative, 'version': hashlib.sha256(data).hexdigest()}
