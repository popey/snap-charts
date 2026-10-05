from datetime import date
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from collect import merge, validate, collect_one, publish, run_snapcraft, select_backfill, main


def metric(days, series):
    return {'status': 'OK', 'metric_name': 'installed_base_by_channel',
            'buckets': days, 'series': [{'name': n, 'values': v} for n, v in series.items()]}


class CollectorTests(unittest.TestCase):
    def test_overview_backfill_catches_up_apps_before_deepening_breakdowns(self):
        boundaries = {
            ('old','installed_base_by_architecture'):'2020-01-01',
            ('new','installed_base_by_architecture'):'2026-08-23',
            ('new','weekly_installed_base_by_architecture'):'2026-08-23',
            ('old','installed_base_by_country'):'2015-01-01',
            ('done','weekly_installed_base_by_architecture'):'2014-01-01',
        }
        selected = select_backfill(boundaries,date(2014,1,1),3,overview_first=True)
        self.assertEqual(selected,{('old','installed_base_by_architecture'),
                                   ('new','installed_base_by_architecture'),
                                   ('new','weekly_installed_base_by_architecture')})
        self.assertEqual(select_backfill(boundaries,date(2014,1,1),1,overview_first=True),
                         {('new','installed_base_by_architecture')})
    def test_continuous_backfill_prioritises_depth_and_excludes_finished_series(self):
        boundaries = {('old','m'):'2020-01-01', ('new','m'):'2025-01-01', ('done','m'):'2014-01-01'}
        self.assertEqual(select_backfill(boundaries,date(2014,1,1),1,oldest_first=True), {('old','m')})
        self.assertEqual(select_backfill(boundaries,date(2014,1,1),1), {('new','m')})

    def test_continuous_run_does_not_stop_after_one_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / 'config.json'
            config.write_text(json.dumps({'historyStart':'2014-01-01','backfillRequests':120,'workers':1}))
            argv = ['collect.py','--config',str(config),'--state',str(root/'state'),
                    '--output',str(root/'output'),'--backfill-until-complete']
            with patch('sys.argv',argv), patch('collect.discover',return_value=[{'name':'app'}]), patch('collect.collect_batch',side_effect=[120,120,0]) as batch:
                main()
            self.assertEqual(batch.call_count,3)
            progress = json.loads((root/'state/backfill-progress.json').read_text())
            self.assertEqual(progress['status'],'complete')
            self.assertEqual(progress['completedBatches'],2)

    def test_continuous_failure_is_not_reported_as_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);config=root/'config.json'
            config.write_text(json.dumps({'historyStart':'2014-01-01','backfillRequests':120,'workers':1}))
            argv=['collect.py','--config',str(config),'--state',str(root/'state'),'--backfill-until-complete']
            with patch('sys.argv',argv), patch('collect.discover',return_value=[]), patch('collect.collect_batch',side_effect=RuntimeError('Store unavailable')):
                with self.assertRaises(SystemExit): main()
            self.assertEqual(json.loads((root/'state/backfill-progress.json').read_text())['status'],'failed')
    def test_no_data_status_is_a_valid_empty_historical_response(self):
        empty = {**metric([], {}), 'status':'NO DATA'}
        self.assertEqual(validate(empty, 'installed_base_by_channel'), empty)
        with self.assertRaises(ValueError):
            validate({**metric(['2025-01-01'], {'stable':[5]}), 'status':'NO DATA'}, 'installed_base_by_channel')
    def test_history_only_preserves_recent_data_and_freshness(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root / 'app' / 'installed_base_by_channel.json'
            path.parent.mkdir()
            record = {'data': metric(['2026-01-01'], {'stable':[12]}), 'historyFrom':'2026-01-01',
                      'recentThrough':'2026-01-01', 'updatedAt':'2026-01-02T00:00:00Z'}
            path.write_text(json.dumps(record))
            with patch('collect.fetch_metric', return_value=metric(['2025-01-01'], {'stable':[5]})) as fetch:
                _,_,result = collect_one(('app','installed_base_by_channel',root,date(2025,1,1),date(2026,2,1),True),refresh=False)
            self.assertEqual(fetch.call_count,1)
            self.assertEqual(fetch.call_args.args[2:],(date(2025,1,1),date(2025,12,31)))
            self.assertEqual(result['updatedAt'],record['updatedAt'])
            self.assertEqual(result['recentThrough'],record['recentThrough'])
            self.assertEqual(result['data']['series'][0]['values'],[5,12])
    def test_null_bug_retries_with_compatibility_runner(self):
        failed = subprocess.CompletedProcess(['snapcraft'], 70, '', 'MetricsResponse input_value=None')
        success = subprocess.CompletedProcess(['compat'], 0, '{}', '')
        with patch('collect.NULL_COMPAT', False), patch('collect.Path.exists', return_value=True), patch('collect.subprocess.run', side_effect=[failed, success]) as run:
            self.assertEqual(run_snapcraft(['metrics', 'app']).stdout, '{}')
            self.assertEqual(run.call_args_list[0].args[0][0], 'snapcraft')
            self.assertTrue(run.call_args_list[1].args[0][1].endswith('snapcraft_metrics_compat.py'))

    def test_unrelated_cli_failure_does_not_use_compatibility_runner(self):
        failed = subprocess.CompletedProcess(['snapcraft'], 1, '', 'Permission denied')
        with patch('collect.NULL_COMPAT', False), patch('collect.subprocess.run', return_value=failed) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                run_snapcraft(['metrics', 'app'])
            self.assertEqual(run.call_count, 1)
    def test_publish_partitions_and_removes_obsolete_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'obsolete.json').write_text('{}')
            record = {'data': metric(['2026-01-31', '2026-02-01'], {'stable': [10, 12], 'edge': [None, 2]}), 'historyFrom': '2026-01-01'}
            publish([('app', 'installed_base_by_channel', record)], [{'name': 'app'}], root, '2026-01-01')
            self.assertFalse((root / 'obsolete.json').exists())
            first = json.loads((root / 'installed_base_by_channel/2026-01.json').read_text())
            self.assertEqual(first['app']['series'], [{'name':'stable', 'values':[10]}])
            manifest = json.loads((root / 'manifest.json').read_text())
            self.assertEqual(manifest['partitions']['installed_base_by_channel'], ['2026-01','2026-02'])
            self.assertNotIn('data', manifest['records']['installed_base_by_channel']['app'])
    def test_merge_revises_overlap_and_retains_old_history(self):
        old = metric(['2026-01-01', '2026-01-02'], {'stable': [10, 12], 'edge': [2, 3]})
        new = metric(['2026-01-02', '2026-01-03'], {'stable': [11, None]})
        result = merge(old, new)
        self.assertEqual(result['series'], [{'name': 'edge', 'values': [2, None, None]}, {'name': 'stable', 'values': [10, 11, None]}])

    def test_empty_response_preserves_observations(self):
        old = metric(['2026-01-01'], {'stable': [2]})
        self.assertEqual(merge(old, metric([], {}))['series'], old['series'])

    def test_reject_bad_metric_and_malformed_values(self):
        for payload in [metric(['2026-01-01'], {'stable': []}), metric(['2026-01-01'], {'stable': [-1]}), metric(['bad'], {})]:
            with self.assertRaises(ValueError):
                validate(payload, 'installed_base_by_channel')
        with self.assertRaises(ValueError):
            validate(metric([], {}), 'daily_device_change')

    def test_failed_refresh_retains_history_and_reports_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root / 'app' / 'installed_base_by_channel.json'
            path.parent.mkdir()
            old = {'data': metric(['2026-01-01'], {'stable': [12]}), 'historyFrom': '2026-01-01'}
            path.write_text(json.dumps(old))
            with patch('collect.fetch_metric', side_effect=RuntimeError('failed')):
                _, _, result = collect_one(('app', 'installed_base_by_channel', root, date(2026,1,1), date(2026,2,1), True))
            self.assertEqual(result['data'], old['data'])
            self.assertIn('error', result)
            self.assertEqual(result['historyFrom'], old['historyFrom'])

    def test_backfill_resumes_with_bounded_requests(self):
        calls = []
        def fetch(snap, name, start, end):
            calls.append((start, end))
            return metric([str(start)], {'stable': [10]})
        with tempfile.TemporaryDirectory() as tmp, patch('collect.fetch_metric', side_effect=fetch):
            task = ('app','installed_base_by_channel',Path(tmp),date(2020,1,1),date(2026,2,1),True)
            _,_,first = collect_one(task)
            _,_,second = collect_one(task)
            self.assertLess(second['historyFrom'], first['historyFrom'])
            self.assertTrue(all((end-start).days <= 364 for start,end in calls))


if __name__ == '__main__': unittest.main()
