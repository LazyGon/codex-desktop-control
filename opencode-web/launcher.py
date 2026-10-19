"""Run only the OpenCode launcher without allocating a console."""
import argparse
import datetime
import pathlib
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--powershell', required=True)
    parser.add_argument('--instance-root', required=True)
    parser.add_argument('--mode', choices=('Start', 'ShowLogin', 'Ollama'), default='Start')
    args = parser.parse_args()
    script = pathlib.Path(__file__).with_name('OpenCode-Web.ps1')
    log_name = {'Start': 'launcher.log', 'ShowLogin': 'login-launcher.log', 'Ollama': 'ollama-launcher.log'}[args.mode]
    log = pathlib.Path(args.instance_root) / 'state' / log_name
    command = [args.powershell, '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
               str(script), '-Mode', args.mode, '-InstanceRoot', args.instance_root]
    if args.mode == 'Start':
        command.append('-WaitForExit')
    with log.open('ab', buffering=0) as stream:
        stream.write(('\n' + datetime.datetime.now(datetime.timezone.utc).isoformat() + '\n').encode())
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
            check=False,
        )
        stream.write(('\nlauncher exit ' + str(result.returncode) + '\n').encode())
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
