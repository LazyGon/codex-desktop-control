"""Run the existing recovery command without allocating a Windows console."""
import argparse
import pathlib
import subprocess
import sys

MODES = ('run', 'dry-run', 'status', 'stop', 'enable')

def launch(node_path, mode, root):
    if mode not in MODES:
        raise ValueError('Unknown recovery mode')
    node = pathlib.Path(node_path)
    module = pathlib.Path(root) / 'control' / 'system-error-recovery.mjs'
    if not node.is_absolute() or not node.is_file() or not module.is_file():
        raise ValueError('Recovery executable or module unavailable')
    options = dict(cwd=str(root), shell=False, stdin=subprocess.DEVNULL, capture_output=True)
    if sys.platform == 'win32':
        options['creationflags'] = subprocess.CREATE_NO_WINDOW
    return subprocess.run([str(node), str(module), mode], **options)

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=MODES, default='run')
    parser.add_argument('--node-path', required=True)
    args = parser.parse_args(argv)
    root = pathlib.Path(__file__).resolve().parent.parent
    try:
        result = launch(args.node_path, args.mode, root)
    except (OSError, ValueError):
        if sys.stderr is not None:
            sys.stderr.write('Recovery launcher failed before a confirmed worker exit.\n')
        return 1
    for stream, data in ((sys.stdout, result.stdout), (sys.stderr, result.stderr)):
        if stream is not None and data:
            stream.buffer.write(data)
            stream.flush()
    return result.returncode

if __name__ == '__main__':
    raise SystemExit(main())
