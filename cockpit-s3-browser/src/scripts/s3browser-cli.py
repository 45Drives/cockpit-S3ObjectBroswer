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



import botocore.session # type: ignore
from botocore.config import Config # type: ignore
from botocore.exceptions import BotoCoreError, ClientError # type: ignore


MIN_PART_SIZE = 64 * 1024 * 1024  # 64 MiB
MAX_PARTS = 10000
DEFAULT_CONCURRENCY = 6
_current_abort = None  # type: Optional[callable]

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


def s3_copy_source(bucket: str, key: str) -> str:
  return f"{bucket}/{urllib.parse.quote(key, safe='')}"

def choose_part_size(size: int) -> int:
  if size <= 0:
    return MIN_PART_SIZE
  min_size_for_limit = int(math.ceil(size / MAX_PARTS))
  return max(MIN_PART_SIZE, min_size_for_limit)

def emit_ndjson(obj: Dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(obj) + "\n")
  sys.stdout.flush()


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

def cmd_presign_get(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}

  expires_raw = (get_flag_value(argv, "--expires", "900") or "900").strip()
  try:
    expires = int(expires_raw)
  except ValueError:
    raise ValueError("Invalid --expires")

  if expires <= 0:
    expires = 900
  if expires > 7 * 24 * 3600:
    expires = 7 * 24 * 3600

  client = make_client(cfg)

  # Force download + nice filename
  filename = os.path.basename(key) or "download"
  content_disp = f'attachment; filename="{filename}"'

  url = client.generate_presigned_url(
    "get_object",
    Params={
      "Bucket": bucket,
      "Key": key,
      "ResponseContentDisposition": content_disp,
      "ResponseContentType": "application/octet-stream",
    },
    ExpiresIn=expires,
  )

  sys.stdout.write(json.dumps({"ok": True, "url": url, "expiresIn": expires}) + "\n")

def cmd_delete_object(conn_id: str, bucket: str, key: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  client.delete_object(Bucket=bucket, Key=key)
  sys.stdout.write(json.dumps({"ok": True}) + "\n")

def multipart_copy_parallel(
  client: Any,
  bucket: str,
  src_key: str,
  dst_key: str,
  concurrency: int,
  emit: Optional[Any] = None,
) -> None:
  head = client.head_object(Bucket=bucket, Key=src_key)
  size = int(head.get("ContentLength") or 0)

  part_size = choose_part_size(size)
  total_parts = int(math.ceil(size / part_size)) if size > 0 else 1

  # Create multipart upload and preserve common headers/metadata
  create_args: Dict[str, Any] = {
    "Bucket": bucket,
    "Key": dst_key,
    "ContentType": head.get("ContentType") or "application/octet-stream",
  }
  if head.get("CacheControl"):
    create_args["CacheControl"] = head["CacheControl"]
  if head.get("ContentDisposition"):
    create_args["ContentDisposition"] = head["ContentDisposition"]
  if head.get("ContentEncoding"):
    create_args["ContentEncoding"] = head["ContentEncoding"]
  if head.get("ContentLanguage"):
    create_args["ContentLanguage"] = head["ContentLanguage"]
  if head.get("Metadata"):
    create_args["Metadata"] = head["Metadata"]

  mpu = client.create_multipart_upload(**create_args)
  upload_id = mpu["UploadId"]
  def abort():
    try:
      client.abort_multipart_upload(Bucket=bucket, Key=dst_key, UploadId=upload_id)
    except Exception:
      pass

  install_cancel_handler(abort)

  if emit:
    emit({
      "type": "start",
      "ok": True,
      "multipart": True,
      "src": src_key,
      "dst": dst_key,
      "size": size,
      "partSize": part_size,
      "totalParts": total_parts,
      "concurrency": concurrency,
      "uploadId": upload_id,
    })

  lock = threading.Lock()
  parts_done = 0

  def copy_one_part(part_num: int) -> Dict[str, Any]:
    start = (part_num - 1) * part_size
    end = min(size - 1, start + part_size - 1)
    byte_range = f"bytes={start}-{end}" if size > 0 else "bytes=0-0"

    resp = client.upload_part_copy(
      Bucket=bucket,
      Key=dst_key,
      PartNumber=part_num,
      UploadId=upload_id,
      CopySource=s3_copy_source(bucket, src_key),
      CopySourceRange=byte_range,
    )

    etag = (resp.get("CopyPartResult") or {}).get("ETag")
    if not etag:
      raise ValueError(f"Missing ETag for part {part_num}")

    nonlocal parts_done
    if emit:
      with lock:
        parts_done += 1
        bytes_copied = int(min(size, parts_done * part_size))
        emit({
          "type": "progress",
          "ok": True,
          "partsDone": parts_done,
          "totalParts": total_parts,
          "bytesCopied": bytes_copied,
          "size": size,
        })

    return {"ETag": etag, "PartNumber": part_num}

  try:
    # Submit all parts with limited concurrency
    parts: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
      futures = [ex.submit(copy_one_part, i) for i in range(1, total_parts + 1)]
      for fut in as_completed(futures):
        parts.append(fut.result())

    # Must complete with parts in ascending PartNumber
    parts.sort(key=lambda p: int(p["PartNumber"]))

    client.complete_multipart_upload(
      Bucket=bucket,
      Key=dst_key,
      UploadId=upload_id,
      MultipartUpload={"Parts": parts},
    )

  except KeyboardInterrupt:
  # Cancel path: abort and report "Canceled"
    try:
      client.abort_multipart_upload(Bucket=bucket, Key=dst_key, UploadId=upload_id)
    except Exception:
      pass

    if emit:
      emit({
        "type": "result",
        "ok": False,
        "src": src_key,
        "dst": dst_key,
        "error": "Canceled",
      })
    raise

  except Exception as e:
    try:
      client.abort_multipart_upload(Bucket=bucket, Key=dst_key, UploadId=upload_id)
    except Exception:
      pass

    if emit:
      emit({
        "type": "result",
        "ok": False,
        "src": src_key,
        "dst": dst_key,
        "error": str(e),
      })
    raise


# s3browser-cli.py (full cmd_delete_prefix function with streaming progress)

def cmd_delete_prefix(conn_id: str, bucket: str, prefix: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

  p = (prefix or "").strip()
  if p and not p.endswith("/"):
    p += "/"

  token = None
  deleted_requested = 0
  error_total = 0
  first_error = None

  emit({"type": "start", "ok": True, "prefix": p})

  try:
    while True:
      req: Dict[str, Any] = {"Bucket": bucket, "Prefix": p, "MaxKeys": 1000}
      if token:
        req["ContinuationToken"] = token

      resp = client.list_objects_v2(**req)
      items = resp.get("Contents") or []
      keys = [{"Key": o["Key"]} for o in items if o.get("Key")]

      if keys:
        dresp = client.delete_objects(
          Bucket=bucket,
          Delete={"Objects": keys, "Quiet": True},
        )

        deleted_requested += len(keys)

        errs = dresp.get("Errors") or []
        if errs:
          error_total += len(errs)
          if first_error is None:
            first_error = errs[0]

        emit({
          "type": "progress",
          "ok": True,
          "deletedRequested": deleted_requested,
          "errors": error_total,
        })

      if not resp.get("IsTruncated"):
        break
      token = resp.get("NextContinuationToken")

    out: Dict[str, Any] = {
      "type": "result",
      "ok": (error_total == 0),
      "deletedRequested": deleted_requested,
      "errors": error_total,
    }
    if first_error:
      out["error"] = str(first_error)

    emit(out)

    if error_total != 0:
      raise ValueError(out.get("error") or "Delete completed with errors")

  except Exception as e:
    emit({
      "type": "result",
      "ok": False,
      "deletedRequested": deleted_requested,
      "errors": error_total,
      "error": str(e),
    })
    raise

def cmd_rename_object(conn_id: str, bucket: str, src_key: str, dst_key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)
  emitted_result = False

  if not src_key or not dst_key:
    raise ValueError("Missing src or dst key")
  if src_key == dst_key:
    sys.stdout.write(json.dumps({"ok": True}) + "\n")
    return

  stream = "--stream" in argv
  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  if concurrency < 1:
    concurrency = 1
  if concurrency > 32:
    concurrency = 32

  def emit(obj: Dict[str, Any]) -> None:
    nonlocal emitted_result
    if obj.get("type") == "result":
      emitted_result = True
    emit_ndjson(obj)

  head = client.head_object(Bucket=bucket, Key=src_key)
  size = int(head.get("ContentLength") or 0)

  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB


  try:
    if size >= MULTIPART_THRESHOLD:
      multipart_copy_parallel(client, bucket, src_key, dst_key, concurrency, emit if stream else None)
    else:
      if stream:
        emit({
          "type": "start",
          "ok": True,
          "multipart": False,
          "src": src_key,
          "dst": dst_key,
          "size": size,
          "totalParts": 1,
          "concurrency": 1,
        })
      client.copy_object(
        Bucket=bucket,
        Key=dst_key,
        CopySource={"Bucket": bucket, "Key": src_key},
        MetadataDirective="COPY",
      )
      if stream:
        emit({"type": "progress", "ok": True, "partsDone": 1, "totalParts": 1, "bytesCopied": size, "size": size})
       
    # Delete source only after successful copy
    client.delete_object(Bucket=bucket, Key=src_key)
    if stream:
      emit({"type": "result", "ok": True, "src": src_key, "dst": dst_key, "size": size})

    if not stream:
      sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key}) + "\n")

  except Exception as e:
    if stream and not emitted_result:
      emit({"type": "result", "ok": False, "src": src_key, "dst": dst_key, "size": size, "error": str(e)})
    raise


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
  if cmd == "presign-get":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli presign-get <connectionId> <bucket> <key> [--expires SEC]")
    conn_id = sys.argv[2]
    bucket = sys.argv[3]
    key = sys.argv[4]
    cmd_presign_get(conn_id, bucket, key, sys.argv[5:])
    return

  if cmd == "delete-object":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli delete-object <connectionId> <bucket> <key>")
    cmd_delete_object(sys.argv[2], sys.argv[3], sys.argv[4])
    return

  if cmd == "delete-prefix":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli delete-prefix <connectionId> <bucket> <prefix>")
    cmd_delete_prefix(sys.argv[2], sys.argv[3], sys.argv[4])
    return
  
  if cmd == "rename-object":
    if len(sys.argv) < 6:
      raise ValueError("Usage: s3browser-cli rename-object <connectionId> <bucket> <srcKey> <dstKey> [--stream] [--concurrency N]")
    cmd_rename_object(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    return
  

  raise ValueError("Unknown command")


def install_cancel_handler(abort_fn):
  global _current_abort
  _current_abort = abort_fn

  def _handler(signum, frame):
    try:
      if _current_abort:
        _current_abort()
    finally:
      raise KeyboardInterrupt("Canceled")

  signal.signal(signal.SIGTERM, _handler)
  signal.signal(signal.SIGINT, _handler)


if __name__ == "__main__":
  try:
    main()
  except (ClientError, BotoCoreError) as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(2)
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    sys.exit(1)
