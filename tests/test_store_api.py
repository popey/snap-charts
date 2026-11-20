import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import signal
import sys
from threading import Barrier
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from pymacaroons import Macaroon

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect
from store_api import StoreClient, StoreError


def response(payload):
    return io.BytesIO(json.dumps(payload).encode())


def needs_refresh():
    return HTTPError('https://dashboard.snapcraft.io', 401, 'Unauthorized',
                     {'WWW-Authenticate': 'Macaroon needs_refresh=1'}, None)


class StoreClientTests(unittest.TestCase):
    def setUp(self):
        self.root = Macaroon(location='store', identifier='root', key='test-root').serialize()
        self.old = Macaroon(location='login', identifier='old', key='test-old').serialize()
        self.new = Macaroon(location='login', identifier='new', key='test-new').serialize()
        self.credentials = base64.b64encode(json.dumps({'v': {'r': self.root, 'd': self.old}}).encode()).decode()
        self.client = StoreClient(self.credentials)
        self.account = {'snaps': {'16': {'app': {'snap-id': 'app-id'}}}}

    def test_first_account_lookup_renews_and_preserves_null_metrics(self):
        metric = {'status': 'OK', 'metric_name': 'installed_base_by_architecture',
                  'buckets': ['2026-01-01', '2026-01-02'],
                  'series': [{'name': 'amd64', 'values': [10, None]}]}

        def timeout(*args):
            raise TimeoutError('Credential renewal deadlocked')

        previous = signal.signal(signal.SIGALRM, timeout)
        try:
            signal.alarm(5)
            with patch('store_api.urlopen', side_effect=[needs_refresh(),
                    response({'discharge_macaroon': self.new}), response(self.account),
                    response({'metrics': [metric]})]) as request:
                result = self.client.metrics('app', metric['metric_name'], '2026-01-01', '2026-01-02')
            self.assertEqual(result, metric)
            calls = [call.args[0] for call in request.call_args_list]
            self.assertEqual(calls[1].full_url, 'https://login.ubuntu.com/api/v2/tokens/refresh')
            self.assertEqual(json.loads(calls[1].data), {'discharge_macaroon': self.old})
            self.assertNotEqual(calls[0].get_header('Authorization'), calls[2].get_header('Authorization'))
            self.assertEqual(json.loads(calls[3].data)['filters'][0]['snap_id'], 'app-id')
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    def test_concurrent_expired_requests_only_renew_once(self):
        self.client._snap_ids = self.account['snaps']['16']
        old_header = self.client._header()
        barrier = Barrier(4, timeout=5)
        renewals = []

        def request(req, **kwargs):
            if req.full_url.endswith('/tokens/refresh'):
                renewals.append(req)
                return response({'discharge_macaroon': self.new})
            if req.get_header('Authorization') == old_header:
                barrier.wait()
                raise needs_refresh()
            return response({'metrics': [{'status': 'OK'}]})

        with patch('store_api.urlopen', side_effect=request), ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self.client.metrics, 'app', 'metric', '2026-01-01', '2026-01-02') for _ in range(4)]
            self.assertEqual([f.result(timeout=10) for f in futures], [{'status': 'OK'}] * 4)
        self.assertEqual(len(renewals), 1)

    def test_failed_renewal_is_retryable_without_leaking_diagnostics(self):
        for error in (OSError('secret diagnostic'), HTTPError('url', 500, 'secret', {}, None)):
            with self.subTest(error=type(error).__name__), patch('store_api.urlopen', side_effect=[needs_refresh(), error]):
                with self.assertRaisesRegex(StoreError, '^Store credential renewal failed: (OSError|HTTPError)$'):
                    self.client.snap_id('app')
        with patch('store_api.urlopen', return_value=response(self.account)):
            self.assertEqual(self.client.snap_id('app'), 'app-id')

    def test_collector_workers_share_one_client(self):
        with patch.object(collect, '_CLIENT', None), patch('store_api.StoreClient') as constructor, \
                ThreadPoolExecutor(max_workers=4) as pool:
            clients = list(pool.map(lambda _: collect.store_client(), range(8)))
            constructor.assert_called_once()
            self.assertTrue(all(client is clients[0] for client in clients))


if __name__ == '__main__':
    unittest.main()
