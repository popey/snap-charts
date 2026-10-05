"""Run Snapcraft's metrics command with support for Store null observations.

Snapcraft 9.1's Series model rejects null, despite the Store returning it.
This changes only the in-process field annotation; the installed snap is untouched.
Invoked with the installed snap's Python, only after the CLI reports this bug.
"""
import sys

from snapcraft.models.metrics import Metric, MetricsResponse, Series

if len(sys.argv) < 2 or sys.argv[1] != 'metrics':
    raise SystemExit('This compatibility runner only supports snapcraft metrics.')

Series.model_fields['values'].annotation = list[int | str | None]
for model in (Series, Metric, MetricsResponse):
    model.model_rebuild(force=True)

from snapcraft.application import main

sys.exit(main())
