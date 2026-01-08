#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List, Optional

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

def get_flag_value(argv: List[str], name: str, default: Optional[str] = None) -> Optional[str]:
  if name not in argv:
    return default
  i = argv.index(name)
  if i + 1 >= len(argv):
    raise ValueError(f"Missing value for {name}")
  return argv[i + 1]

def cmd_list_objects(conn_id: str, bucket: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}

  prefix = (get_flag_value(argv, "--prefix", "") or "").strip()
  delimiter = (get_flag_value(argv, "--delimiter", None) or None)
  max_keys_raw = (get_flag_value(argv, "--max-keys", "200") or "200").strip()
  token = (get_flag_value(argv, "--continuation-token", None) or None)

  try:
    max_keys = int(max_keys_raw)
  except ValueError:
    raise ValueError("Invalid --max-keys")

  if max_keys <= 0:
    max_keys = 200
  if max_keys > 1000:
    max_keys = 1000  # S3 max for ListObjectsV2

  client = make_client(cfg)

  # Always request owner info (when supported)
  req: Dict[str, Any] = {
    "Bucket": bucket,
    "MaxKeys": max_keys,
    "FetchOwner": True,
  }
  if prefix:
    req["Prefix"] = prefix
  if delimiter:
    req["Delimiter"] = delimiter
  if token:
    req["ContinuationToken"] = token

  resp = client.list_objects_v2(**req)

  common_prefixes = []
  for p in (resp.get("CommonPrefixes") or []):
    pr = p.get("Prefix")
    if pr:
      common_prefixes.append(pr)

  contents = []
  for o in (resp.get("Contents") or []):
    key = o.get("Key")
    if not key:
      continue

    lm = o.get("LastModified")
    et = o.get("ETag")
    sc = o.get("StorageClass")

    owner = o.get("Owner") or {}
    owner_id = owner.get("ID")
    owner_dn = owner.get("DisplayName")

    contents.append({
      "key": key,
      "size": int(o.get("Size") or 0),
      "lastModified": (lm.isoformat() if lm else None),
      "etag": (str(et).strip('"') if et else None),
      "storageClass": (str(sc) if sc else None),
      "owner": {
        "id": (str(owner_id) if owner_id else None),
        "displayName": (str(owner_dn) if owner_dn else None),
      } if (owner_id or owner_dn) else None,
    })

  out = {
    "ok": True,
    "prefix": prefix,
    "commonPrefixes": common_prefixes,
    "contents": contents,
    "isTruncated": bool(resp.get("IsTruncated", False)),
    "nextContinuationToken": resp.get("NextContinuationToken"),
  }
  sys.stdout.write(json.dumps(out) + "\n")


def main() -> None:
  if len(sys.argv) < 2:
    raise ValueError("Usage: s3browser-cli [list-buckets|list-objects] ...")
  cmd = sys.argv[1]

  if cmd == "list-buckets":
    if len(sys.argv) < 3:
      raise ValueError("Usage: s3browser-cli list-buckets <connectionId>")
    cmd_list_buckets(sys.argv[2])
    return

  if cmd == "list-objects":
    if len(sys.argv) < 4:
      raise ValueError("Usage: s3browser-cli list-objects <connectionId> <bucket> [--prefix P] [--delimiter /] [--max-keys N] [--continuation-token T]")
    conn_id = sys.argv[2]
    bucket = sys.argv[3]
    cmd_list_objects(conn_id, bucket, sys.argv[4:])
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
