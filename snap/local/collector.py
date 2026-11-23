#!/usr/bin/python3
"""Daily collection loop configured through snap settings."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SNAP = Path(os.environ['SNAP'])
COMMON = Path(os.environ['SNAP_COMMON'])
CONFIG = COMMON / 'config' / 'snaps.json'
INTERVAL = 24 * 3600
RETRY_INTERVAL = 30 * 60


def snap_get(key):
    return subprocess.run(['snapctl', 'get', key], capture_output=True, text=True).stdout.strip()


def prepare_config(publisher):
    """Create the config on first use; discovery fills in the snap list for a new publisher."""
    existing = json.loads(CONFIG.read_text()) if CONFIG.exists() else None
    if existing and existing.get('publisher') == publisher:
        return
    template = json.loads((SNAP / 'config' / 'snaps.json').read_text())
    template.update(publisher=publisher, snaps=[], exclude=[])
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(template, indent=2) + '\n')


def main():
    while True:
        wait = INTERVAL
        publisher = snap_get('publisher')
        credentials = snap_get('credentials')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', publisher):
            print('Set a publisher: sudo snap set snap-charts-server publisher=<name>', flush=True)
        elif not credentials:
            print('Set credentials: sudo snap set snap-charts-server credentials="$(cat snap-charts.credentials)"',
                  flush=True)
        else:
            prepare_config(publisher)
            env = {**os.environ, 'SNAPCRAFT_STORE_CREDENTIALS': credentials,
                   # The staged Python's default OpenSSL paths do not exist inside the snap.
                   'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt'}
            result = subprocess.run([
                sys.executable, str(SNAP / 'scripts' / 'collect.py'),
                '--config', str(CONFIG), '--state', str(COMMON / 'state'),
                '--output', str(COMMON / 'data'), '--sync-config'], env=env)
            print(f'Collection finished with status {result.returncode}', flush=True)
            if result.returncode:
                wait = RETRY_INTERVAL
        # Wake early when settings change: the configure hook restarts this service.
        time.sleep(wait)


if __name__ == '__main__':
    main()
