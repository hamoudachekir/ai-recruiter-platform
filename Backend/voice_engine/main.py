from __future__ import annotations

import os
import sys
from pathlib import Path


def _maybe_reexec_with_project_venv() -> None:
    current_python = Path(sys.executable).resolve()
    repo_root = Path(__file__).resolve().parents[2]
    project_venv_python = repo_root / ".venv" / "Scripts" / "python.exe"

    if not project_venv_python.exists():
        return

    project_venv_python = project_venv_python.resolve()
    if current_python == project_venv_python:
        return

    os.execv(str(project_venv_python), [str(project_venv_python), __file__, *sys.argv[1:]])


if os.name == "nt":
    _maybe_reexec_with_project_venv()


if __package__ in {None, ""}:
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from voice_engine.manual_test import main


if __name__ == "__main__":
    raise SystemExit(main())