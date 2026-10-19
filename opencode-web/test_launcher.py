import contextlib
import importlib.util
import io
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('opencode_launcher', pathlib.Path(__file__).with_name('launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_windowless_single_launch_and_durable_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / 'state'
            state.mkdir()
            with patch.object(sys, 'argv', ['launcher.py', '--powershell', 'powershell.exe', '--instance-root', directory]), \
                    patch.object(launcher.subprocess, 'run', return_value=subprocess.CompletedProcess([], 7)) as run:
                self.assertEqual(launcher.main(), 7)
                run.assert_called_once()
                command = run.call_args.args[0]
                self.assertEqual(command[0], 'powershell.exe')
                self.assertEqual(command[-5:], ['-Mode', 'Start', '-InstanceRoot', directory, '-WaitForExit'])
                self.assertNotIn('password', ' '.join(command).lower())
                options = run.call_args.kwargs
                self.assertIs(options['stdout'], options['stderr'])
                self.assertEqual(options['stdin'], subprocess.DEVNULL)
                if sys.platform == 'win32':
                    self.assertEqual(options['creationflags'], subprocess.CREATE_NO_WINDOW)
            log = (state / 'launcher.log').read_text()
            self.assertIn('launcher exit 7', log)

    def test_missing_arguments_do_not_launch(self):
        with patch.object(sys, 'argv', ['launcher.py']), patch.object(launcher.subprocess, 'run') as run, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                launcher.main()
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
