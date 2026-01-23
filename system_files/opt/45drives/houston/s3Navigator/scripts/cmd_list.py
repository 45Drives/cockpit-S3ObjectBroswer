#!/usr/bin/env python3
import json
import sys
from typing import Any, Dict, List

from utils import cfg_path, get_flag_value, read_json, make_client

def cmd_list_buckets(conn_id: str) -> None:
    record = read_json(f"/etc/45drives/s3-object-browser/connections/{conn_id}.json")
    cfg = record.get("config", {})
    client = make_client(cfg)

    resp = client.list_buckets()
    buckets = [{"name": b["Name"], "creationDate": b["CreationDate"].isoformat()} for b in resp.get("Buckets", [])]
    sys.stdout.write(json.dumps({"ok": True, "buckets": buckets}) + "\n")

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

  req: Dict[str, Any] = {
    "Bucket": bucket,
    "MaxKeys": max_keys,
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



    contents.append({
      "key": key,
      "size": int(o.get("Size") or 0),
      "lastModified": (lm.isoformat() if lm else None),
      "etag": (str(et).strip('"') if et else None),
      "storageClass": (str(sc) if sc else None),
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
