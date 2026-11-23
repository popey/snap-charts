import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HOOK = Path(__file__).resolve().parents[1] / 'snap' / 'hooks' / 'configure'


class ConfigureHookTests(unittest.TestCase):
    def run_hook(self, port):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapctl = root / 'snapctl'
            snapctl.write_text('''#!/bin/sh
case "$1:$2" in
    get:publisher) printf '%s' 'test-publisher' ;;
    get:port) printf '%s' "$TEST_PORT" ;;
    restart:*) touch "$TEST_RESTART" ;;
    *) exit 1 ;;
esac
''')
            snapctl.chmod(0o755)
            restart = root / 'restarted'
            result = subprocess.run(['sh', str(HOOK)], capture_output=True, text=True, timeout=5,
                                    env={**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                                         'TEST_PORT': port, 'TEST_RESTART': str(restart),
                                         'SNAP_INSTANCE_NAME': 'snap-charts-server'})
            return result, restart.exists()

    def test_valid_ports_restart_services(self):
        for port in ('', '1', '8080', '65535'):
            with self.subTest(port=port):
                result, restarted = self.run_hook(port)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(restarted)

    def test_invalid_ports_are_rejected_before_restarting_services(self):
        for port in ('0', '-1', '65536', '999999999999999999999999', 'abc', '1.5', '08080', '80\n123', ' 80'):
            with self.subTest(port=port):
                result, restarted = self.run_hook(port)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('between 1 and 65535', result.stderr)
                self.assertFalse(restarted)


if __name__ == '__main__':
    unittest.main()
