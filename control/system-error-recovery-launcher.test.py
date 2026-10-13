import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('launcher', pathlib.Path(__file__).with_name('system-error-recovery-launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='recovery 日本語 ')
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'control').mkdir()
        self.module = self.root / 'control' / 'system-error-recovery.mjs'
        self.module.write_text('console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exit(7);', encoding='utf8')
    def tearDown(self):
        self.temp.cleanup()
    def test_worker_exit_and_unicode_space_arguments_survive(self):
        node = pathlib.Path(sys.argv[1])
        result = launcher.launch(node, 'dry-run', self.root)
        self.assertEqual(result.returncode, 7)
        body = json.loads(result.stdout)
        self.assertEqual(body['args'], ['dry-run'])
        self.assertEqual(pathlib.Path(body['cwd']), self.root)
    def test_windows_worker_cannot_allocate_console_or_inherit_interactive_stdin(self):
        with mock.patch.object(launcher.sys, 'platform', 'win32'), mock.patch.object(launcher.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), mock.patch.object(launcher.subprocess, 'run') as run:
            launcher.launch(pathlib.Path(sys.argv[1]), 'run', self.root)
        self.assertEqual(run.call_args.kwargs['creationflags'], 0x08000000)
        self.assertFalse(run.call_args.kwargs['shell'])
        self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)
        self.assertTrue(run.call_args.kwargs['capture_output'])
    def test_missing_runtime_is_refused_before_spawn(self):
        with mock.patch.object(launcher.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                launcher.launch(self.root/'missing.exe', 'run', self.root)
        run.assert_not_called()
    def test_missing_fixed_module_is_refused_before_spawn(self):
        self.module.unlink()
        with mock.patch.object(launcher.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                launcher.launch(pathlib.Path(sys.argv[1]), 'run', self.root)
        run.assert_not_called()
    def test_unknown_mode_cannot_reach_recovery_worker(self):
        with mock.patch.object(launcher.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                launcher.launch(pathlib.Path(sys.argv[1]), 'restart-anything', self.root)
        run.assert_not_called()
    def test_main_propagates_nonzero_worker_result(self):
        with mock.patch.object(launcher, 'launch', return_value=subprocess.CompletedProcess([], 9, b'', b'')):
            self.assertEqual(launcher.main(['--node-path', sys.argv[1], '--mode', 'status']), 9)

if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(LauncherTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
