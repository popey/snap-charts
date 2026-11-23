"""Minimal Snap Store dashboard client for metrics, authenticated with exported Snapcraft credentials."""
import base64
import json
import os
from threading import Lock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pymacaroons import Macaroon

DASHBOARD_URL = os.environ.get('STORE_DASHBOARD_URL', 'https://dashboard.snapcraft.io')
LOGIN_URL = os.environ.get('STORE_AUTH_URL', 'https://login.ubuntu.com')
SERIES = '16'


class StoreError(RuntimeError):
    pass


class StoreClient:
    def __init__(self, credentials):
        try:
            data = json.loads(base64.b64decode(credentials))
            value = data.get('v', data)
            self.root, self.discharge = value['r'], value['d']
        except (ValueError, KeyError, TypeError, AttributeError):
            raise StoreError('SNAPCRAFT_STORE_CREDENTIALS is not valid exported Ubuntu One credentials') from None
        # Account lookup may need to renew a discharge. It must not hold the
        # same lock as renewal, or the first request with expired credentials hangs.
        self._account_lock = Lock()
        self._refresh_lock = Lock()
        self._snap_ids = None

    def _header(self, discharge=None):
        bound = Macaroon.deserialize(self.root).prepare_for_request(Macaroon.deserialize(discharge or self.discharge))
        return f'Macaroon root={self.root}, discharge={bound.serialize()}'

    def _refresh(self, stale):
        with self._refresh_lock:
            if self.discharge != stale:
                return
            request = Request(LOGIN_URL + '/api/v2/tokens/refresh',
                              json.dumps({'discharge_macaroon': self.discharge}).encode(),
                              {'Content-Type': 'application/json', 'Accept': 'application/json'})
            try:
                with urlopen(request, timeout=60) as response:
                    self.discharge = json.load(response)['discharge_macaroon']
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise StoreError(f'Store credential renewal failed: {type(error).__name__}') from None

    def _request(self, method, path, body=None):
        for attempt in range(2):
            stale = self.discharge
            headers = {'Authorization': self._header(stale), 'Accept': 'application/json',
                       'User-Agent': 'snap-charts/0.1'}
            data = None
            if body is not None:
                data, headers['Content-Type'] = json.dumps(body).encode(), 'application/json'
            try:
                with urlopen(Request(DASHBOARD_URL + path, data, headers, method=method), timeout=60) as response:
                    return json.load(response)
            except HTTPError as error:
                if error.code == 401 and attempt == 0 and 'needs_refresh' in error.headers.get('WWW-Authenticate', ''):
                    self._refresh(stale)
                    continue
                raise StoreError(f'Store request failed with HTTP {error.code}') from None
            except (OSError, ValueError) as error:
                raise StoreError(f'Store request failed: {type(error).__name__}') from None

    def _account_snaps(self):
        with self._account_lock:
            if self._snap_ids is None:
                self._snap_ids = self._request('GET', '/dev/api/account')['snaps'].get(SERIES, {})
            return self._snap_ids

    def snap_id(self, name):
        try:
            return self._account_snaps()[name]['snap-id']
        except KeyError:
            raise StoreError(f'Snap {name} is not accessible with these credentials') from None

    def metrics(self, snap, metric, start, end):
        result = self._request('POST', '/dev/api/snaps/metrics', {'filters': [
            {'snap_id': self.snap_id(snap), 'metric_name': metric, 'start': str(start), 'end': str(end)}]})
        if len(result.get('metrics', [])) != 1:
            raise StoreError('Unexpected metric results from the Store')
        return result['metrics'][0]
