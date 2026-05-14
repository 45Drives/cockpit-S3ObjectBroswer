#!/usr/bin/env python3
import json
import sys
from typing import Any, Dict, List
import os
from utils import cfg_path, endpoint_url_from_cfg, get_flag_value, read_json, make_client



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

  try:
    client = make_client(cfg)
    resp = client.list_buckets()
  except Exception as e:
    err_msg = str(e)
    if "CERTIFICATE_VERIFY_FAILED" in err_msg or "self-signed certificate" in err_msg.lower() or "certificate verify failed" in err_msg.lower():
      sys.stdout.write(json.dumps({
        "ok": False,
        "error": "SSL certificate verification failed. The endpoint appears to use a self-signed certificate. "
                 "Please edit this connection and uncheck 'Verify TLS certificate' to connect.",
        "errorType": "SSL_SELF_SIGNED"
      }) + "\n")
    else:
      sys.stdout.write(json.dumps({"ok": False, "error": err_msg}) + "\n")
    return

  buckets = [
    {"name": b["Name"], "creationDate": b["CreationDate"].isoformat()}
    for b in (resp.get("Buckets") or [])
  ]
  sys.stdout.write(json.dumps({"ok": True, "buckets": buckets}) + "\n")


def cmd_detect_backend_type(conn_id: str) -> None:
  """Probe the S3 endpoint to identify the backend type (RustFS, MinIO, RGW, or generic)."""
  try:
    record = read_json(cfg_path(conn_id))
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    return

  cfg = (record.get("config") or {}) if isinstance(record, dict) else {}
  if not cfg:
    sys.stdout.write(json.dumps({"ok": False, "error": "Connection not found"}) + "\n")
    return

  endpoint = endpoint_url_from_cfg(cfg)
  backend = _probe_backend_type(endpoint)

  sys.stdout.write(json.dumps({
    "ok": True,
    "backendType": backend,
  }) + "\n")


def _probe_backend_type(endpoint: str) -> str:
  """
  Probe the S3 endpoint with unauthenticated HTTP requests to known
  backend-specific paths. Returns one of: rustfs, minio, rgw, generic.
  """
  import urllib.request
  import urllib.error

  base = endpoint.rstrip("/")

  # 1. RustFS: GET /health returns JSON with "service":"rustfs-endpoint"
  try:
    req = urllib.request.Request(base + "/health", method="GET")
    req.add_header("Accept", "application/json")
    resp = urllib.request.urlopen(req, timeout=5)
    body = resp.read(1024).decode("utf-8", errors="replace").lower()
    if "rustfs" in body:
      return "rustfs"
  except Exception:
    pass

  # 2. MinIO: GET /minio/health/live returns 200
  try:
    req = urllib.request.Request(base + "/minio/health/live", method="GET")
    resp = urllib.request.urlopen(req, timeout=5)
    if resp.status == 200:
      return "minio"
  except Exception:
    pass

  # 3. Check Server header and RGW-specific headers via an unauthenticated GET /
  try:
    req = urllib.request.Request(base + "/", method="GET")
    resp = urllib.request.urlopen(req, timeout=5)
    server = (resp.headers.get("Server") or "").lower()
    if "minio" in server:
      return "minio"
    if "ceph" in server or "rgw" in server:
      return "rgw"
    if "rustfs" in server:
      return "rustfs"
  except urllib.error.HTTPError as e:
    server = (e.headers.get("Server") or "").lower()
    if "minio" in server:
      return "minio"
    if "ceph" in server or "rgw" in server:
      return "rgw"
    if "rustfs" in server:
      return "rustfs"
    # RGW often returns x-rgw-request-id in error responses
    if e.headers.get("x-rgw-request-id"):
      return "rgw"
  except Exception:
    pass

  return "generic"


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
