import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from sync_archive import sync_archive


class ArchiveSyncTests(unittest.TestCase):
    @patch('sync_archive.time.sleep')
    @patch('sync_archive.subprocess.run')
    def test_restore_recovers_from_partial_transfer(self, run, sleep):
        run.side_effect = [subprocess.CompletedProcess([], code) for code in (1, 0)]
        sync_archive('restore')
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0], run.call_args_list[1])
        args = run.call_args.args[0]
        self.assertEqual(args[3:5], ['s3://snap-charts-history/state/', '.state/'])
        self.assertEqual(args[5:], ['--exclude', '*', '--include', '*/*.json', '--only-show-errors'])
        sleep.assert_called_once_with(15)

    @patch('sync_archive.time.sleep')
    @patch('sync_archive.subprocess.run')
    def test_persistent_failure_rejects_partial_archive(self, run, sleep):
        run.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaises(subprocess.CalledProcessError):
            sync_archive('restore')
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [15, 30])

    @patch('sync_archive.time.sleep')
    @patch('sync_archive.subprocess.run')
    def test_save_success_does_not_retry_or_delete_remote_objects(self, run, sleep):
        run.return_value = subprocess.CompletedProcess([], 0)
        sync_archive('save')
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][3:5], ['.state/', 's3://snap-charts-history/state/'])
        self.assertNotIn('--delete', run.call_args.args[0])
        sleep.assert_not_called()
