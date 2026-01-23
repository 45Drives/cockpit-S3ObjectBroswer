#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List, Optional
import math
import urllib.parse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import signal
import tarfile
import time
from datetime import datetime, timezone, timedelta
import re
import botocore.session # type: ignore
from botocore.config import Config # type: ignore
from botocore.exceptions import BotoCoreError, ClientError # type: ignore


MIN_PART_SIZE = 64 * 1024 * 1024  # 64 MiB
MAX_PARTS = 10000
DEFAULT_CONCURRENCY = 6
JOB_DIR = "/run/s3browser/downloads"

BASE_DIR = "/etc/45drives/s3-object-browser/connections"

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ]"
    r"(\d{2}):(\d{2}):(\d{2})"
    r"(\.\d{1,6})?"
    r"(Z|[+-]\d{2}:\d{2})?$"
)

# Commands that write NON-JSON bytes to STDOUT (must not print JSON to stdout on failure)








# s3browser-cli.py (full cmd_delete_prefix function with streaming progress)




















def main() -> None:
  cmd = None
  try:
    if len(sys.argv) < 2:
      raise ValueError("Usage: s3browser-cli <command> ...")

    cmd = sys.argv[1]




    if cmd == "presign-get":
      if len(sys.argv) < 5:
        raise ValueError("Usage: s3browser-cli presign-get <connectionId> <bucket> <key> [--expires SEC]")
      conn_id = sys.argv[2]
      bucket = sys.argv[3]
      key = sys.argv[4]
      cmd_presign_get(conn_id, bucket, key, sys.argv[5:])
      return



    if cmd == "download-prefix-targz":
      if len(sys.argv) < 5:
        raise ValueError("Usage: s3browser-cli download-prefix-targz <connectionId> <bucket> <prefix> [--strip-components N]")
      cmd_download_prefix_targz(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
      return



    if cmd == "download-job-status":
      if len(sys.argv) < 3:
        raise ValueError("Usage: s3browser-cli download-job-status <jobId>")
      cmd_download_job_status(sys.argv[2])
      return


    if cmd == "stat-object":
      if len(sys.argv) < 5:
        raise ValueError("Usage: s3browser-cli stat-object <connectionId> <bucket> <key>")
      cmd_stat_object(sys.argv[2], sys.argv[3], sys.argv[4])
      return



    if cmd == "cancel-download-job":
      if len(sys.argv) < 3:
        raise ValueError("Usage: cancel-download-job <job_id>")
      cmd_cancel_download_job(sys.argv[2])
      return








    # Unknown command -> convert to JSON error instead of raising
    raise ValueError("Unknown command")

  except BaseException as e:
    # cmd may be None if failure happens before parsing
    c = cmd or ""

    msg = _format_err(e)

    # For binary stdout commands, never write to stdout
    if c in BINARY_STDOUT_CMDS:
      _emit_json_stderr({"type": "result", "ok": False, "error": msg})
      raise SystemExit(1)

    # For NDJSON commands, emit a final result line
    if _wants_ndjson(c, sys.argv[2:]):
      _emit_ndjson({"type": "result", "ok": False, "error": msg})
      raise SystemExit(0)

    # Default: one-shot JSON on stdout
    _emit_json_stdout({"ok": False, "error": msg})
    raise SystemExit(0)


if __name__ == "__main__":
  cmd0 = sys.argv[1] if len(sys.argv) > 1 else ""
  try:
    main()
  except (ClientError, BotoCoreError) as e:
    if cmd0 == "download-prefix-targz":
      sys.stderr.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    else:
      sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(2)
  except Exception as e:
    if cmd0 == "download-prefix-targz":
      sys.stderr.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    else:
      sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(1)
