#!/usr/bin/env python3
import json
import sys
from typing import Any, Dict, List
import os
from utils import cfg_path, get_flag_value, read_json, make_client



def cmd_list_buckets(conn_id: str) -> None:
  try:
    record = read_json(cfg_path(conn_id))
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    return

  cfg = (record.get("config") or {}) if isinstance(record, dict) else {}
  if not cfg:
    sys.stdout.write(json.dumps({"ok": False, "error": "Connection not found"}) + "\n")
    return

  client = make_client(cfg)
  resp = client.list_buckets()
  buckets = [
    {"name": b["Name"], "creationDate": b["CreationDate"].isoformat()}
    for b in (resp.get("Buckets") or [])
  ]
  sys.stdout.write(json.dumps({"ok": True, "buckets": buckets}) + "\n")


def cmd_list_objects(conn_id: str, bucket: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}

  prefix = (get_flag_value(argv, "--prefix", "") or "").strip()
  delimiter = (get_flag_value(argv, "--delimiter", None) or None)
  token = (get_flag_value(argv, "--continuation-token", None) or None)

  client = make_client(cfg)

  req: Dict[str, Any] = {
    "Bucket": bucket,
    "MaxKeys": 1000,  
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

    # Hide folder markers
    if str(key).endswith("/") and int(o.get("Size") or 0) == 0:
      continue

    lastModified = o.get("LastModified")
    etag = o.get("ETag")
    storageClass= o.get("StorageClass")

    contents.append({
      "key": key,
      "size": int(o.get("Size") or 0),
      "lastModified": (lastModified.isoformat() if lastModified else None),
      "etag": (str(etag).strip('"') if etag else None),
      "storageClass": (str(storageClass) if storageClass else None),
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
