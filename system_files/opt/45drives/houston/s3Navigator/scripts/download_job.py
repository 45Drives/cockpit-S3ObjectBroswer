#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, List
import signal
from utils import JOB_DIR

def cmd_cancel_download_job(job_id: str) -> None:
  job_id = (job_id or "").strip()
  if not job_id:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing jobId"}) + "\n")
    return

  path = os.path.join(JOB_DIR, f"{job_id}.json")
  if not os.path.exists(path):
    sys.stdout.write(json.dumps({"ok": False, "error": "Job not found"}) + "\n")
    return

  try:
    with open(path, "r", encoding="utf-8") as f:
      data = json.load(f) if f else {}
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    return

  pid = int((data or {}).get("pid") or 0)
  if pid <= 0:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing pid for job" }) + "\n")
    return

  try:
    os.kill(pid, signal.SIGINT)  # your install_cancel_handler turns this into KeyboardInterrupt
  except ProcessLookupError:
    sys.stdout.write(json.dumps({"ok": True, "alreadyExited": True}) + "\n")
    return
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    return

  sys.stdout.write(json.dumps({"ok": True}) + "\n")


def cmd_download_job_status(job_id: str) -> None:
  job_id = (job_id or "").strip()
  if not job_id:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing jobId"}) + "\n")
    return

  path = os.path.join(JOB_DIR, f"{job_id}.json")
  if not os.path.exists(path):
    sys.stdout.write(json.dumps({"ok": False, "error": "Job not found"}) + "\n")
    return

  try:
    with open(path, "r", encoding="utf-8") as f:
      data = json.load(f)
    # ensure ok present for UI wrapper
    out = {"ok": True}
    if isinstance(data, dict):
      out.update(data)
    else:
      out["data"] = data
    sys.stdout.write(json.dumps(out) + "\n")
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
