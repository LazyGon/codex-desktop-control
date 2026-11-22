"""Windowless scheduler entry; the interactive Claude console is minimized."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
session = sys.argv[1]
if session not in ("Conversation", "Haiku"):
    raise SystemExit("Unknown session")
shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
state = root.parent / "state/claude-startup"
state.mkdir(parents=True, exist_ok=True)
with (state / f"{session}-launcher.log").open("ab") as log:
    result = subprocess.run(
        [str(shell), "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
         str(root / "Start-ClaudeSession.ps1"), "-Session", session],
        cwd=root, creationflags=subprocess.CREATE_NO_WINDOW,
        stdin=subprocess.DEVNULL, stdout=log, stderr=log,
    )
raise SystemExit(result.returncode)
