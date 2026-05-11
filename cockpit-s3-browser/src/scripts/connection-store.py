#!/usr/bin/env python3
import base64
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from uuid import uuid4
from typing import Optional

def ensure_store() -> None:
  os.makedirs(BASE_DIR, mode=0o700, exist_ok=True)
  if not os.path.exists(INDEX_PATH):
    atomic_write(INDEX_PATH, "[]\n")

def get_base_dir() -> str:
  xdg = os.environ.get("XDG_CONFIG_HOME")
  if xdg:
    return os.path.join(xdg, "45drives", "s3-object-browser", "connections")
  return os.path.join(os.path.expanduser("~/.config"), "45drives", "s3-object-browser", "connections")

BASE_DIR = get_base_dir()
INDEX_PATH = os.path.join(BASE_DIR, "index.json")

def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()

def atomic_write(path: str, content: str) -> None:
  dir_path = os.path.dirname(path)
  os.makedirs(dir_path, mode=0o700, exist_ok=True)

  fd, tmp_path = tempfile.mkstemp(prefix=".tmp.", dir=dir_path)
  try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
      f.write(content)
      f.flush()
      os.fsync(f.fileno())
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)
  finally:
    try:
      if os.path.exists(tmp_path):
        os.unlink(tmp_path)
    except Exception:
      pass

def read_json(path: str):
  if not os.path.exists(path):
    return None
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)

def write_json(path: str, obj) -> None:
  atomic_write(path, json.dumps(obj, indent=2) + "\n")

def cfg_path(conn_id: str) -> str:
  return os.path.join(BASE_DIR, f"{conn_id}.json")

def index_load():
  idx = read_json(INDEX_PATH)
  if idx is None:
    return []
  if not isinstance(idx, list):
    raise ValueError("index.json is corrupted (expected list)")
  return idx

def index_save(entries) -> None:
  write_json(INDEX_PATH, entries)

def summarize(conn_id: str, cfg: dict, updated_at: str, last_used_at: Optional[str]) -> dict:
  return {
    "id": conn_id,
    "name": cfg.get("name") or cfg.get("endpoint") or "",
    "endpoint": cfg.get("endpoint") or "",
    "region": cfg.get("region"),
    "useTls": bool(cfg.get("useTls")),
    "tlsVerify": cfg.get("tlsVerify", True) is not False,
    "updatedAt": updated_at,
    "lastUsedAt": last_used_at,
  }

def decode_payload(arg: str) -> str:
  if not arg.startswith("b64:"):
    raise ValueError("Expected payload arg starting with b64:")
  b64 = arg[4:]
  return base64.b64decode(b64.encode("ascii")).decode("utf-8")

def cmd_list() -> None:
  ensure_store()
  entries = index_load()
  sys.stdout.write(json.dumps(entries) + "\n")

def cmd_get(conn_id: str) -> None:
  ensure_store()
  p = cfg_path(conn_id)
  cfg = read_json(p)
  if cfg is None:
    sys.stdout.write("null\n")
    return
  # Return only the EndpointConfig shape
  sys.stdout.write(json.dumps(cfg.get("config")) + "\n")

def cmd_upsert(payload_arg: str) -> None:
  raw = decode_payload(payload_arg)
  payload = json.loads(raw)

  # payload: { id?: string, config: EndpointConfig }
  cfg = payload.get("config")
  if not isinstance(cfg, dict):
    raise ValueError("Missing config object")

  required = ["name", "endpoint", "accessKeyId", "secretAccessKey", "useTls"]
  for k in required:
    if k not in cfg or cfg[k] in [None, ""]:
      raise ValueError(f"Missing required field: {k}")

  conn_id = payload.get("id") or str(uuid4())
  updated_at = now_iso()

  record = read_json(cfg_path(conn_id)) or {}
  last_used_at = record.get("lastUsedAt")

  record = {
    "id": conn_id,
    "updatedAt": updated_at,
    "lastUsedAt": last_used_at,
    "config": {
      "name": cfg.get("name"),
      "endpoint": cfg.get("endpoint"),
      "region": cfg.get("region"),
      "accessKeyId": cfg.get("accessKeyId"),
      "secretAccessKey": cfg.get("secretAccessKey"),
      "useTls": bool(cfg.get("useTls")),
      "tlsVerify": cfg.get("tlsVerify", True) is not False,
    },
  }

  write_json(cfg_path(conn_id), record)

  entries = index_load()
  entries = [e for e in entries if e.get("id") != conn_id]
  entries.append(summarize(conn_id, record["config"], updated_at, last_used_at))
  entries.sort(key=lambda e: e.get("updatedAt", ""), reverse=True)
  index_save(entries)

  sys.stdout.write(json.dumps({"ok": True, "id": conn_id}) + "\n")

def cmd_delete(conn_id: str) -> None:
  try:
    ensure_store()
    os.unlink(cfg_path(conn_id))
  except FileNotFoundError:
    pass

  entries = index_load()
  entries = [e for e in entries if e.get("id") != conn_id]
  index_save(entries)
  sys.stdout.write("OK\n")

def cmd_touch_last_used(conn_id: str) -> None:
  ensure_store()
  p = cfg_path(conn_id)
  record = read_json(p)
  if record is None:
    sys.stdout.write("null\n")
    return

  record["lastUsedAt"] = now_iso()
  record["updatedAt"] = record.get("updatedAt") or now_iso()
  write_json(p, record)

  entries = index_load()
  for e in entries:
    if e.get("id") == conn_id:
      e["lastUsedAt"] = record["lastUsedAt"]
      break
  index_save(entries)

  sys.stdout.write("OK\n")

def main() -> None:
  if len(sys.argv) < 2:
    raise ValueError("Usage: connection-store [list|get|upsert|delete|touch] ...")
  cmd = sys.argv[1]

  if cmd == "list":
    cmd_list()
    return
  if cmd == "get":
    if len(sys.argv) < 3:
      raise ValueError("Usage: connection-store get <id>")
    cmd_get(sys.argv[2])
    return
  if cmd == "upsert":
    if len(sys.argv) < 3:
      raise ValueError("Usage: connection-store upsert <b64:payload>")
    cmd_upsert(sys.argv[2])
    return
  if cmd == "delete":
    if len(sys.argv) < 3:
      raise ValueError("Usage: connection-store delete <id>")
    cmd_delete(sys.argv[2])
    return
  if cmd == "touch":
    if len(sys.argv) < 3:
      raise ValueError("Usage: connection-store touch <id>")
    cmd_touch_last_used(sys.argv[2])
    return

  raise ValueError("Unknown command")

if __name__ == "__main__":
  try:
    main()
  except Exception as e:
    sys.stderr.write(str(e) + "\n")
    sys.exit(1)
