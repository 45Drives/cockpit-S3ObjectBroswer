#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict

import botocore.session # type: ignore
from botocore.config import Config # type: ignore
from botocore.exceptions import BotoCoreError, ClientError # type: ignore

BASE_DIR = "/etc/45drives/s3-object-browser/connections"

def cfg_path(conn_id: str) -> str:
  return os.path.join(BASE_DIR, f"{conn_id}.json")

def read_json(path: str) -> Dict[str, Any]:
  if not os.path.exists(path):
    raise ValueError("Connection not found")
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)

def endpoint_url_from_cfg(cfg: Dict[str, Any]) -> str:
  raw = (cfg.get("endpoint") or "").strip()
  if not raw:
    raise ValueError("Missing endpoint")

  # If user stored a full URL, respect it
  if raw.startswith("http://") or raw.startswith("https://"):
    return raw.rstrip("/")

  scheme = "https" if bool(cfg.get("useTls")) else "http"
  return f"{scheme}://{raw}"


def make_client(cfg: Dict[str, Any]):
  endpoint = endpoint_url_from_cfg(cfg)
  region = (cfg.get("region") or "us-east-1").strip()

  access_key = cfg.get("accessKeyId") or ""
  secret_key = cfg.get("secretAccessKey") or ""
  if not access_key or not secret_key:
    raise ValueError("Missing credentials")

  sess = botocore.session.get_session()
  return sess.create_client(
    "s3",
    endpoint_url=endpoint,
    region_name=region,
    aws_access_key_id=access_key,
    aws_secret_access_key=secret_key,
    verify=True,  # always verify certs
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
  )

def cmd_list_buckets(conn_id: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}

  client = make_client(cfg)
  resp = client.list_buckets()

  buckets = []
  for b in (resp.get("Buckets") or []):
    name = b.get("Name")
    cd = b.get("CreationDate")
    if name:
      buckets.append({
        "name": name,
        "creationDate": (cd.isoformat() if cd else None),
      })

  sys.stdout.write(json.dumps({"ok": True, "buckets": buckets}) + "\n")

def main() -> None:
  if len(sys.argv) < 2:
    raise ValueError("Usage: s3browser-cli [list-buckets] ...")
  cmd = sys.argv[1]

  if cmd == "list-buckets":
    if len(sys.argv) < 3:
      raise ValueError("Usage: s3browser-cli list-buckets <connectionId>")
    cmd_list_buckets(sys.argv[2])
    return

  raise ValueError("Unknown command")

if __name__ == "__main__":
  try:
    main()
  except (ClientError, BotoCoreError) as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(2)
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(1)
