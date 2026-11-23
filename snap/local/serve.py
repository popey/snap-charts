#!/usr/bin/python3
"""Serve the built dashboard, with generated metrics read from the snap's writable data."""
import os
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SNAP = Path(os.environ['SNAP'])
COMMON = Path(os.environ['SNAP_COMMON'])
WWW = SNAP / 'www'
DATA = COMMON / 'data'


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        resolved = Path(super().translate_path(path))
        try:
            relative = resolved.relative_to(WWW / 'data')
        except ValueError:
            return str(resolved)
        return str(DATA / relative)


def snap_get(key, default):
    value = subprocess.run(['snapctl', 'get', key], capture_output=True, text=True).stdout.strip()
    return value or default


if __name__ == '__main__':
    port = int(snap_get('port', '8080'))
    print(f'Serving on port {port}', flush=True)
    ThreadingHTTPServer(('', port), partial(Handler, directory=str(WWW))).serve_forever()
