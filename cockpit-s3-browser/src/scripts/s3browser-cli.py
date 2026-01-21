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
_current_abort = None  # type: Optional[callable]
JOB_DIR = "/run/s3browser/downloads"

BASE_DIR = "/etc/45drives/s3-object-browser/connections"

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ]"
    r"(\d{2}):(\d{2}):(\d{2})"
    r"(\.\d{1,6})?"
    r"(Z|[+-]\d{2}:\d{2})?$"
)

def parse_iso8601_to_datetime(value: str) -> datetime:
    if value is None:
        raise ValueError("retain-until is required")
    s = str(value).strip()
    m = _ISO_RE.match(s)
    if not m:
        raise ValueError("Invalid ISO timestamp: %r" % (s,))

    (yy, mo, dd, hh, mi, ss, frac, tz) = m.groups()

    micro = 0
    if frac:
        digits = frac[1:]
        digits = (digits + "000000")[:6]
        micro = int(digits)

    dt = datetime(int(yy), int(mo), int(dd), int(hh), int(mi), int(ss), micro)

    if tz in (None, "", "Z"):
        return dt.replace(tzinfo=timezone.utc)

    sign = 1 if tz[0] == "+" else -1
    off_h = int(tz[1:3])
    off_m = int(tz[4:6])
    offset = timezone(sign * timedelta(hours=off_h, minutes=off_m))
    dt = dt.replace(tzinfo=offset)

    return dt.astimezone(timezone.utc)

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

def write_job(job_id: str, data: Dict[str, Any]) -> None:
  if not job_id:
    return

  os.makedirs(JOB_DIR, mode=0o700, exist_ok=True)

  path = os.path.join(JOB_DIR, f"{job_id}.json")
  data2 = dict(data)
  data2["jobId"] = job_id
  data2["updatedAt"] = int(time.time())

  tmp = path + ".tmp"
  with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data2, f)
  os.replace(tmp, path)  # atomic write

def new_job_id() -> str:
  # no uuid import needed
  return f"{int(time.time()*1000)}-{os.getpid()}-{abs(hash(os.urandom(8)))%10_000_000}"

def get_job_id(argv: List[str]) -> str:
  return (get_flag_value(argv, "--job-id", "") or "").strip() or new_job_id()

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

def basename_of_key(key: str) -> str:
  parts = (key or "").split("/")
  return parts[-1] if parts else key

def folder_name_from_prefix(prefix: str) -> str:
  s = normalize_prefix(prefix)
  t = s[:-1] if s.endswith("/") else s
  parts = [x for x in t.split("/") if x]
  return parts[-1] if parts else t

def normalize_prefix(p: str) -> str:
  s = (p or "").lstrip("/")
  if s and not s.endswith("/"):
    s += "/"
  return s

def iter_keys_under_prefix(client: Any, bucket: str, prefix: str):
  token = None
  while True:
    req: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
    if token:
      req["ContinuationToken"] = token

    resp = client.list_objects_v2(**req)
    for o in (resp.get("Contents") or []):
      key = o.get("Key")
      if not key:
        continue
      # ignore "folder marker" keys if present
      if key.endswith("/"):
        continue
      yield key, int(o.get("Size") or 0), o.get("LastModified")

    if not resp.get("IsTruncated"):
      break
    token = resp.get("NextContinuationToken")


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
    verify=True,
    config=Config(
      signature_version="s3v4",
      s3={
        "addressing_style": "path",
        "payload_signing_enabled": False,  # important for some gateways
      },
    ),
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
  src_bucket: str,
  src_key: str,
  dst_bucket: str,
  dst_key: str,
  concurrency: int,
  emit: Optional[Any] = None,
) -> None:
  head = client.head_object(Bucket=src_bucket, Key=src_key)
  size = int(head.get("ContentLength") or 0)

  part_size = choose_part_size(size)
  total_parts = int(math.ceil(size / part_size)) if size > 0 else 1

  # Create multipart upload on DESTINATION bucket
  create_args: Dict[str, Any] = {
    "Bucket": dst_bucket,
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
      client.abort_multipart_upload(Bucket=dst_bucket, Key=dst_key, UploadId=upload_id)
    except Exception:
      pass

  install_cancel_handler(abort)

  if emit:
    emit({
      "type": "start",
      "ok": True,
      "multipart": True,
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
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
      Bucket=dst_bucket,
      Key=dst_key,
      PartNumber=part_num,
      UploadId=upload_id,
      CopySource={"Bucket": src_bucket, "Key": src_key},
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
    parts: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
      futures = [ex.submit(copy_one_part, i) for i in range(1, total_parts + 1)]
      for fut in as_completed(futures):
        parts.append(fut.result())

    parts.sort(key=lambda p: int(p["PartNumber"]))

    client.complete_multipart_upload(
      Bucket=dst_bucket,
      Key=dst_key,
      UploadId=upload_id,
      MultipartUpload={"Parts": parts},
    )

    if emit:
      emit({
        "type": "result",
        "ok": True,
        "srcBucket": src_bucket,
        "dstBucket": dst_bucket,
        "src": src_key,
        "dst": dst_key,
        "size": size,
      })

  except KeyboardInterrupt:
    abort()
    if emit:
      emit({
        "type": "result",
        "ok": False,
        "srcBucket": src_bucket,
        "dstBucket": dst_bucket,
        "src": src_key,
        "dst": dst_key,
        "error": "Canceled",
      })
    raise

  except Exception as e:
    abort()
    if emit:
      emit({
        "type": "result",
        "ok": False,
        "srcBucket": src_bucket,
        "dstBucket": dst_bucket,
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
def read_exact(stream, n: int) -> bytes:
  chunks = []
  remaining = n
  while remaining > 0:
    b = stream.read(remaining)
    if not b:
      break
    chunks.append(b)
    remaining -= len(b)
  return b"".join(chunks)



def cmd_copy_object(conn_id: str, src_bucket: str, src_key: str, dst_bucket: str, dst_key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  if not src_key or not dst_key:
    raise ValueError("Missing src or dst key")
  if src_bucket == dst_bucket and src_key == dst_key:
    sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key}) + "\n")
    return

  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  if concurrency < 1:
    concurrency = 1
  if concurrency > 32:
    concurrency = 32

  head = client.head_object(Bucket=src_bucket, Key=src_key)

  size = int(head.get("ContentLength") or 0)

  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

  try:
    if size >= MULTIPART_THRESHOLD:
      multipart_copy_parallel(client, src_bucket, src_key, dst_bucket, dst_key, concurrency, emit=None)
    else:
      client.copy_object(
        Bucket=dst_bucket,
        Key=dst_key,
        CopySource={"Bucket": src_bucket, "Key": src_key},
        MetadataDirective="COPY",
      )

    sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key, "size": size}) + "\n")

  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    raise


def cmd_copy_prefix(conn_id: str, src_bucket: str, src_prefix: str, dst_bucket: str, dst_prefix: str, argv: List[str]) -> None:


  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  src_p = normalize_prefix(src_prefix)
  dst_p = normalize_prefix(dst_prefix)

  if not src_p or not dst_p:
    raise ValueError("Missing srcPrefix or dstPrefix")
  if src_p == dst_p:
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0}) + "\n")
    return

  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  if concurrency < 1:
    concurrency = 1
  if concurrency > 32:
    concurrency = 32

  # Collect keys first (so we can show totals if you later stream)
  keys: List[Dict[str, Any]] = []
  total_bytes = 0
  for key, size, lm in iter_keys_under_prefix(client, src_bucket, src_p):
    rel = key[len(src_p):] if key.startswith(src_p) else key
    dst_key = dst_p + rel
    keys.append({"src": key, "dst": dst_key, "size": int(size or 0)})
    total_bytes += int(size or 0)

  if not keys:
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0}) + "\n")
    return

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  def do_one(it: Dict[str, Any]) -> Dict[str, Any]:
    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    src_key = it["src"]
    dst_key = it["dst"]

    # Simple copy; overwrite if exists (S3 semantics)
    client.copy_object(
    Bucket=dst_bucket,
    Key=dst_key,
    CopySource={"Bucket": src_bucket, "Key": src_key},
    MetadataDirective="COPY",
    )

    return it

  done_files = 0
  done_bytes = 0

  try:
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
      futs = [ex.submit(do_one, it) for it in keys]
      for fut in as_completed(futs):
        it = fut.result()
        done_files += 1
        done_bytes += int(it.get("size") or 0)

    sys.stdout.write(json.dumps({
      "ok": True,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")

  except KeyboardInterrupt:
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": "Canceled",
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    raise

  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": str(e),
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    raise

def cmd_move_prefix(conn_id: str, src_bucket: str, src_prefix: str, dst_bucket: str, dst_prefix: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  src_p = normalize_prefix(src_prefix)
  dst_p = normalize_prefix(dst_prefix)

  if not src_p or not dst_p:
    raise ValueError("Missing srcPrefix or dstPrefix")
  if src_p == dst_p:
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0}) + "\n")
    return

  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  if concurrency < 1:
    concurrency = 1
  if concurrency > 32:
    concurrency = 32

  keys: List[Dict[str, Any]] = []
  total_bytes = 0
  for key, size, lm in iter_keys_under_prefix(client, bucket, src_p):
    rel = key[len(src_p):] if key.startswith(src_p) else key
    dst_key = dst_p + rel
    keys.append({"src": key, "dst": dst_key, "size": int(size or 0)})
    total_bytes += int(size or 0)

  if not keys:
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0}) + "\n")
    return

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  def do_one(it: Dict[str, Any]) -> Dict[str, Any]:
    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    src_key = it["src"]
    dst_key = it["dst"]

    client.copy_object(
      Bucket=dst_bucket,
      Key=dst_key,
      CopySource={"Bucket": src_bucket, "Key": src_key},
      MetadataDirective="COPY",
    )

    # Only delete after successful copy
    client.delete_object(Bucket=src_bucket, Key=src_key)

    return it

  done_files = 0
  done_bytes = 0

  try:
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
      futs = [ex.submit(do_one, it) for it in keys]
      for fut in as_completed(futs):
        it = fut.result()
        done_files += 1
        done_bytes += int(it.get("size") or 0)

    sys.stdout.write(json.dumps({
      "ok": True,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")

  except KeyboardInterrupt:
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": "Canceled",
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    raise

  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": str(e),
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    raise


def choose_upload_part_size(size: int, min_part: int = 8 * 1024 * 1024) -> int:
  if size <= 0:
    return min_part
  by_max_parts = int(math.ceil(size / MAX_PARTS))
  return max(min_part, by_max_parts)


def cmd_stat_object(conn_id: str, bucket: str, key: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  head = client.head_object(Bucket=bucket, Key=key)
  lm = head.get("LastModified")

  # user-defined metadata: x-amz-meta-*
  user_meta = head.get("Metadata") or {}
  if not isinstance(user_meta, dict):
    user_meta = {}

  # x-amz-tagging-count (boto3 exposes it as TagCount)
  tag_count = head.get("TagCount")
  try:
    tag_count_int = int(tag_count) if tag_count is not None else None
  except Exception:
    tag_count_int = None

  sys.stdout.write(json.dumps({
    "ok": True,
    "key": key,
    "size": int(head.get("ContentLength") or 0),
    "lastModified": (lm.isoformat() if lm else None),
    "etag": str(head.get("ETag") or "").strip('"') or None,
    "storageClass": head.get("StorageClass"),

    # useful “system” metadata
    "contentType": head.get("ContentType") or None,
    "taggingCount": tag_count_int,

    # user metadata
    "metadata": {str(k): str(v) for (k, v) in user_meta.items()},
  }) + "\n")




def cmd_upload_stdin(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  size_raw = (get_flag_value(argv, "--size", None) or "").strip()
  if not size_raw:
    raise ValueError("Missing --size")
  try:
    total_size = int(size_raw)
  except ValueError:
    raise ValueError("Invalid --size")
  if total_size < 0:
    raise ValueError("Invalid --size")

  content_type = (get_flag_value(argv, "--content-type", "application/octet-stream") or "application/octet-stream").strip()

  multipart_threshold = 64 * 1024 * 1024  # 64 MiB

  def emit(obj: Dict[str, Any]) -> None:
    emit_ndjson(obj)

  bytes_read = 0
  upload_id_holder = {"id": None}

  def abort():
    uid = upload_id_holder["id"]
    if not uid:
      return
    try:
      client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=uid)
    except Exception:
      pass

  install_cancel_handler(abort)

  emit({
    "type": "start",
    "ok": True,
    "bucket": bucket,
    "key": key,
    "size": total_size,
    "contentType": content_type,
    "multipart": bool(total_size >= multipart_threshold),
  })

  stream = sys.stdin.buffer

  try:
    if total_size < multipart_threshold:
      buf = read_exact(stream, total_size)
      bytes_read = len(buf)
      emit({"type": "progress", "ok": True, "bytesRead": bytes_read, "size": total_size})

      if bytes_read != total_size:
        raise ValueError(f"Incomplete upload: read {bytes_read} of {total_size} bytes")

      client.put_object(
        Bucket=bucket,
        Key=key,
        Body=buf,
        ContentType=content_type or "application/octet-stream",
        ContentLength=total_size,
      )

      emit({"type": "result", "ok": True, "bucket": bucket, "key": key, "size": total_size})
      return



    part_size = choose_upload_part_size(total_size, min_part=8 * 1024 * 1024)
    total_parts = int(math.ceil(total_size / part_size)) if total_size > 0 else 1

    mpu = client.create_multipart_upload(
      Bucket=bucket,
      Key=key,
      ContentType=content_type or "application/octet-stream",
    )
    upload_id = mpu["UploadId"]
    upload_id_holder["id"] = upload_id

    emit({"type": "mpu", "ok": True, "uploadId": upload_id, "partSize": part_size, "totalParts": total_parts})

    parts: List[Dict[str, Any]] = []
    part_number = 1

    while bytes_read < total_size:
      want = min(part_size, total_size - bytes_read)
      buf = read_exact(stream, want)
      if not buf:
        break

      bytes_read += len(buf)
      emit({"type": "progress", "ok": True, "bytesRead": bytes_read, "size": total_size})

      resp = client.upload_part(
        Bucket=bucket,
        Key=key,
        UploadId=upload_id,
        PartNumber=part_number,
        Body=buf,
      )
      etag = resp.get("ETag")
      if not etag:
        raise ValueError(f"Missing ETag for part {part_number}")

      parts.append({"ETag": str(etag).strip('"'), "PartNumber": part_number})
      emit({"type": "part", "ok": True, "partNumber": part_number, "partsDone": len(parts), "totalParts": total_parts})
      part_number += 1

    if bytes_read != total_size:
      raise ValueError(f"Incomplete upload: read {bytes_read} of {total_size} bytes")

    client.complete_multipart_upload(
      Bucket=bucket,
      Key=key,
      UploadId=upload_id,
      MultipartUpload={"Parts": parts},
    )

    emit({"type": "result", "ok": True, "bucket": bucket, "key": key, "size": total_size})

  except KeyboardInterrupt:
    emit({"type": "result", "ok": False, "bucket": bucket, "key": key, "size": total_size, "error": "Canceled"})
    raise
  except Exception as e:
    emit({"type": "result", "ok": False, "bucket": bucket, "key": key, "size": total_size, "error": str(e)})
    raise

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

def cmd_download_prefix_targz(conn_id: str, bucket: str, prefix: str, argv: List[str]) -> None:
  job_id = get_job_id(argv)

  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  # Normalize prefix: no leading "/" and always trailing "/" (unless empty)
  p = (prefix or "").lstrip("/")
  if p and not p.endswith("/"):
    p += "/"

  # Optional flags
  strip_components_raw = (get_flag_value(argv, "--strip-components", "0") or "0").strip()
  try:
    strip_components = max(0, int(strip_components_raw))
  except ValueError:
    strip_components = 0

  # Progress must go to STDERR only. STDOUT must be the tar.gz bytes only.
  def emit_err(obj: Dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  # Collect keys first so we can emit totals
  keys: List[Dict[str, Any]] = []
  total_bytes = 0
  for key, size, lm in iter_keys_under_prefix(client, bucket, p):
    keys.append({"key": key, "size": int(size or 0), "lastModified": lm})
    total_bytes += int(size or 0)

  # Emit start to STDERR + write start job file
  emit_err({
    "type": "start",
    "ok": True,
    "jobId": job_id,
    "bucket": bucket,
    "prefix": p,
    "files": len(keys),
    "totalBytes": total_bytes,
  })

  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": "prefix-targz",
    "pid": os.getpid(),
    "bucket": bucket,
    "prefix": p,
    "files": len(keys),
    "totalBytes": total_bytes,
    "state": "running",
  })


  out = sys.stdout.buffer  # tar.gz stream destination

  sent_bytes = 0
  file_index = 0

  try:
    # Stream tar.gz directly (no buffering full archive)
    with tarfile.open(fileobj=out, mode="w|gz") as tar:
      for it in keys:
        if canceled["yes"]:
          raise KeyboardInterrupt("Canceled")

        key = it["key"]
        size = int(it["size"] or 0)
        lm = it.get("lastModified")

        # Name inside tar: remove selected prefix
        arcname = key[len(p):] if p and key.startswith(p) else key

        # Optionally strip path components inside the tar
        if strip_components > 0:
          parts = [x for x in arcname.split("/") if x]
          if len(parts) > strip_components:
            arcname = "/".join(parts[strip_components:])
          else:
            arcname = parts[-1] if parts else ""

        if not arcname:
          continue

        # Fetch object stream
        obj = client.get_object(Bucket=bucket, Key=key)
        body = obj["Body"]  # streaming file-like object

        try:
          # Build tar header first
          ti = tarfile.TarInfo(name=arcname)
          ti.size = size

          try:
            if lm is not None:
              ti.mtime = int(lm.timestamp())
            else:
              ti.mtime = int(time.time())
          except Exception:
            ti.mtime = int(time.time())

          # Add file content (streamed)
          tar.addfile(ti, fileobj=body)

        finally:
          # Always close the streaming body
          try:
            body.close()
          except Exception:
            pass

        file_index += 1
        sent_bytes += size

        emit_err({
          "type": "progress",
          "ok": True,
          "jobId": job_id,
          "fileIndex": file_index,
          "files": len(keys),
          "bytes": sent_bytes,
          "totalBytes": total_bytes,
          "key": key,
        })

        write_job(job_id, {
          "type": "progress",
          "ok": True,
          "kind": "prefix-targz",
          "pid": os.getpid(),
          "bucket": bucket,
          "prefix": p,
          "fileIndex": file_index,
          "files": len(keys),
          "bytes": sent_bytes,
          "totalBytes": total_bytes,
          "key": key,
          "state": "running",
        })

    emit_err({
      "type": "result",
      "ok": True,
      "jobId": job_id,
      "files": len(keys),
      "bytes": sent_bytes,
      "totalBytes": total_bytes,
    })

    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": "prefix-targz",
      "pid": os.getpid(),
      "bucket": bucket,
      "prefix": p,
      "files": len(keys),
      "bytes": sent_bytes,
      "totalBytes": total_bytes,
      "state": "done",
    })

  except KeyboardInterrupt:
    emit_err({"type": "result", "ok": False, "jobId": job_id, "error": "Canceled"})

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "prefix-targz",
      "pid": os.getpid(),
      "bucket": bucket,
      "prefix": p,
      "bytes": sent_bytes,
      "totalBytes": total_bytes,
      "error": "Canceled",
      "state": "canceled",
    })
    raise

  except Exception as e:
    emit_err({"type": "result", "ok": False, "jobId": job_id, "error": str(e)})

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "prefix-targz",
      "pid": os.getpid(),
      "bucket": bucket,
      "prefix": p,
      "bytes": sent_bytes,
      "totalBytes": total_bytes,
      "error": str(e),
      "state": "failed",
    })
    raise


def cmd_download_object(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  job_id = get_job_id(argv)

  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  # Optional: chunk size for streaming reads
  chunk_raw = (get_flag_value(argv, "--chunk", "8388608") or "8388608").strip()
  try:
    chunk_size = max(64 * 1024, int(chunk_raw))
  except ValueError:
    chunk_size = 8 * 1024 * 1024

  # Progress to STDERR only
  def emit_err(obj: Dict[str, Any]) -> None:
    try:
      sys.stderr.write(json.dumps(obj) + "\n")
      sys.stderr.flush()
    except Exception:
      # If client disconnected, stderr may be closed too
      pass

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  # Head for metadata/size (also confirms existence early)
  head = client.head_object(Bucket=bucket, Key=key)
  size = int(head.get("ContentLength") or 0)
  lm = head.get("LastModified")

  emit_err({
    "type": "start",
    "ok": True,
    "jobId": job_id,
    "bucket": bucket,
    "key": key,
    "size": size,
    "lastModified": (lm.isoformat() if lm else None),
    "chunkSize": chunk_size,
  })

  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": "object",
    "pid": os.getpid(),
    "bucket": bucket,
    "key": key,
    "size": size,
    "lastModified": (lm.isoformat() if lm else None),
    "chunkSize": chunk_size,
    "state": "running",
  })


  out = sys.stdout.buffer
  sent = 0

  try:
    obj = client.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]

    try:
      while True:
        if canceled["yes"]:
          raise KeyboardInterrupt("Canceled")

        b = body.read(chunk_size)
        if not b:
          break

        out.write(b)
        sent += len(b)

        emit_err({
          "type": "progress",
          "ok": True,
          "jobId": job_id,
          "bytes": sent,
          "size": size,
          "key": key,
        })

        write_job(job_id, {
          "type": "progress",
          "ok": True,
          "kind": "object",
          "pid": os.getpid(),

          "bucket": bucket,
          "key": key,
          "bytes": sent,
          "size": size,
          "state": "running",
        })

    finally:
      try:
        body.close()
      except Exception:
        pass

    emit_err({
      "type": "result",
      "ok": True,
      "jobId": job_id,
      "bytes": sent,
      "size": size,
      "key": key,
    })

    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": "object",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "bytes": sent,
      "size": size,
      "state": "done",
    })

  except BrokenPipeError:
    # Browser canceled / channel closed mid-stream.
    # Mark canceled (best effort), then exit cleanly.
    try:
      write_job(job_id, {
        "type": "result",
        "ok": False,
        "kind": "object",
        "pid": os.getpid(),
        "bucket": bucket,
        "key": key,
        "bytes": sent,
        "size": size,
        "error": "BrokenPipe",
        "state": "canceled",
      })
    except Exception:
      pass
    raise SystemExit(0)

  except KeyboardInterrupt:
    emit_err({"type": "result", "ok": False, "jobId": job_id, "error": "Canceled", "bytes": sent, "size": size, "key": key})

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "object",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "bytes": sent,
      "size": size,
      "error": "Canceled",
      "state": "canceled",
    })
    raise

  except Exception as e:
    emit_err({"type": "result", "ok": False, "jobId": job_id, "error": str(e), "bytes": sent, "size": size, "key": key})

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "object",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "bytes": sent,
      "size": size,
      "error": str(e),
      "state": "failed",
    })
    raise

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

def _parse_tag_kv(s: str) -> Dict[str, str]:
  s = (s or "").strip()
  if not s:
    raise ValueError("Empty tag")
  if "=" not in s:
    raise ValueError(f"Invalid tag '{s}' (expected key=value)")
  k, v = s.split("=", 1)
  k = k.strip()
  v = v.strip()
  if not k:
    raise ValueError(f"Invalid tag '{s}' (empty key)")
  return {k: v}

def _get_repeat_flags(argv: List[str], name: str) -> List[str]:
  out: List[str] = []
  i = 0
  while i < len(argv):
    if argv[i] == name and i + 1 < len(argv):
      out.append(argv[i + 1])
      i += 2
      continue
    i += 1
  return out

def cmd_put_object_tags(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  # Collect tags from repeated --tag key=value
  tag_args = _get_repeat_flags(argv, "--tag")

  # Collect tags from --tags-json (expects {"k":"v", ...} or [{"Key":"k","Value":"v"}, ...])
  tags_json_raw = (get_flag_value(argv, "--tags-json", "") or "").strip()

  final_tags: Dict[str, str] = {}

  for t in tag_args:
    final_tags.update(_parse_tag_kv(t))

  if tags_json_raw:
    try:
      data = json.loads(tags_json_raw)
    except Exception as e:
      raise ValueError(f"Invalid --tags-json: {e}")

    if isinstance(data, dict):
      for k, v in data.items():
        # allow explicit empty value, but skip nulls
        if v is None:
          continue
        kk = str(k).strip()
        if not kk:
          continue
        final_tags[kk] = str(v)
    elif isinstance(data, list):
      for it in data:
        if isinstance(it, dict) and "Key" in it and "Value" in it:
          kk = str(it.get("Key") or "").strip()
          if not kk:
            continue
          final_tags[kk] = str(it.get("Value") or "")
        else:
          raise ValueError("Invalid --tags-json list (expected [{Key,Value}, ...])")
    else:
      raise ValueError("Invalid --tags-json (expected object or list)")

  # Since UI sends the complete list, allow empty tagset to mean "remove all tags"
  tagset = [{"Key": k, "Value": v} for k, v in final_tags.items()]

  client.put_object_tagging(
    Bucket=bucket,
    Key=key,
    Tagging={"TagSet": tagset},
  )

  sys.stdout.write(json.dumps({
    "ok": True,
    "bucket": bucket,
    "key": key,
    "tags": [{"key": k, "value": v} for k, v in final_tags.items()],
  }) + "\n")



def cmd_get_object_tags(conn_id: str, bucket: str, key: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  try:
    res = client.get_object_tagging(Bucket=bucket, Key=key)
    tagset = res.get("TagSet") or []

    tags = []
    for it in tagset:
      if not isinstance(it, dict):
        continue
      k = str(it.get("Key") or "").strip()
      if not k:
        continue
      v = str(it.get("Value") or "")
      tags.append({"key": k, "value": v})

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "tags": tags,
    }) + "\n")

  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "bucket": bucket,
      "key": key,
      "error": str(e),
    }) + "\n")
    raise

def cmd_change_storage_class(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  storage_class = (get_flag_value(argv, "--storage-class", "") or "").strip()
  if not storage_class:
    raise ValueError("Missing --storage-class")

  conc_raw = (get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)).strip()
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  if concurrency < 1:
    concurrency = 1
  if concurrency > 32:
    concurrency = 32

  force = (get_flag_value(argv, "--force", "0") or "0").strip() in ("1", "true", "yes", "on")

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  head = client.head_object(Bucket=bucket, Key=key)
  size = int(head.get("ContentLength") or 0)
  lm = head.get("LastModified")
  cur_sc = head.get("StorageClass")  # may be None

  # If already set and not forcing, short-circuit
  if (not force) and cur_sc and str(cur_sc) == storage_class:
    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "changed": False,
      "requestedStorageClass": storage_class,
      "storageClass": cur_sc,
      "size": size,
      "lastModified": (lm.isoformat() if lm else None),
    }) + "\n")
    return

  if canceled["yes"]:
    # print and return (do not raise -> avoid double JSON)
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": "Canceled",
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
      "storageClass": (str(cur_sc) if cur_sc else None),
      "size": size,
      "lastModified": (lm.isoformat() if lm else None),
    }) + "\n")
    return

  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

  try:
    if size >= MULTIPART_THRESHOLD:
      def emit(_obj: Dict[str, Any]) -> None:
        emit_ndjson(_obj)

      part_size = choose_part_size(size)
      total_parts = int(math.ceil(size / part_size)) if size > 0 else 1

      create_args: Dict[str, Any] = {
        "Bucket": bucket,
        "Key": key,
        "ContentType": head.get("ContentType") or "application/octet-stream",
        "StorageClass": storage_class,
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

      def abort_mpu():
        try:
          client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        except Exception:
          pass

      install_cancel_handler(abort_mpu)

      emit({
        "type": "start",
        "ok": True,
        "bucket": bucket,
        "key": key,
        "size": size,
        "multipart": True,
        "uploadId": upload_id,
        "partSize": part_size,
        "totalParts": total_parts,
        "requestedStorageClass": storage_class,
      })

      lock = threading.Lock()
      parts_done = 0

      def copy_one_part(part_num: int) -> Dict[str, Any]:
        if canceled["yes"]:
          raise KeyboardInterrupt("Canceled")

        start = (part_num - 1) * part_size
        end = min(size - 1, start + part_size - 1)
        byte_range = f"bytes={start}-{end}" if size > 0 else "bytes=0-0"

        resp = client.upload_part_copy(
          Bucket=bucket,
          Key=key,
          PartNumber=part_num,
          UploadId=upload_id,
          CopySource={"Bucket": bucket, "Key": key},
          CopySourceRange=byte_range,
        )
        etag = (resp.get("CopyPartResult") or {}).get("ETag")
        if not etag:
          raise ValueError(f"Missing ETag for part {part_num}")

        nonlocal parts_done
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

      parts: List[Dict[str, Any]] = []
      try:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
          futures = [ex.submit(copy_one_part, i) for i in range(1, total_parts + 1)]
          for fut in as_completed(futures):
            parts.append(fut.result())

        parts.sort(key=lambda p: int(p["PartNumber"]))

        client.complete_multipart_upload(
          Bucket=bucket,
          Key=key,
          UploadId=upload_id,
          MultipartUpload={"Parts": parts},
        )

      except Exception as e:
        abort_mpu()
        raise e

      head2 = client.head_object(Bucket=bucket, Key=key)
      lm2 = head2.get("LastModified")
      new_sc = head2.get("StorageClass")

      emit({
        "type": "result",
        "ok": True,
        "bucket": bucket,
        "key": key,
        "size": int(head2.get("ContentLength") or 0),
        "lastModified": (lm2.isoformat() if lm2 else None),
        "requestedStorageClass": storage_class,
        "storageClass": (str(new_sc) if new_sc else None),
      })
      return

    # Small/medium: single self-copy with StorageClass
    copy_args: Dict[str, Any] = {
      "Bucket": bucket,
      "Key": key,
      "CopySource": {"Bucket": bucket, "Key": key},
      "MetadataDirective": "COPY",
      "StorageClass": storage_class,
    }

    ct = head.get("ContentType")
    if ct:
      copy_args["ContentType"] = ct

    client.copy_object(**copy_args)

    head2 = client.head_object(Bucket=bucket, Key=key)
    lm2 = head2.get("LastModified")
    new_sc = head2.get("StorageClass")

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "changed": True,
      "requestedStorageClass": storage_class,
      "storageClass": (str(new_sc) if new_sc else None),
      "size": int(head2.get("ContentLength") or 0),
      "lastModified": (lm2.isoformat() if lm2 else None),
    }) + "\n")
    return

  except KeyboardInterrupt:
    # IMPORTANT: do not re-raise; print once and return
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": "Canceled",
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
      "storageClass": (str(cur_sc) if cur_sc else None),
      "size": size,
      "lastModified": (lm.isoformat() if lm else None),
    }) + "\n")
    return

  except Exception as e:
    # IMPORTANT: do not re-raise; print once and return
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": str(e),
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
      "storageClass": (str(cur_sc) if cur_sc else None),
      "size": size,
      "lastModified": (lm.isoformat() if lm else None),
    }) + "\n")
    return

def cmd_list_object_versions(conn_id: str, bucket: str, key: str, max_keys: int = 200) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  out = []
  key_marker = None
  version_marker = None

  while True:
    kwargs = {
      "Bucket": bucket,
      "Prefix": key,
      "MaxKeys": max_keys,
    }
    if key_marker is not None:
      kwargs["KeyMarker"] = key_marker
    if version_marker is not None:
      kwargs["VersionIdMarker"] = version_marker

    res = client.list_object_versions(**kwargs)

    for v in (res.get("Versions") or []):
      if v.get("Key") != key:
        continue
      lm = v.get("LastModified")
      out.append({
        "key": key,
        "versionId": v.get("VersionId"),
        "isLatest": bool(v.get("IsLatest")),
        "lastModified": (lm.isoformat() if lm else None),
        "size": int(v.get("Size") or 0),
        "etag": str(v.get("ETag") or "").strip('"') or None,
      })

    if not res.get("IsTruncated"):
      break

    key_marker = res.get("NextKeyMarker")
    version_marker = res.get("NextVersionIdMarker")
    if not key_marker:
      break

  # sort latest first (best-effort)
  out.sort(key=lambda x: (x["lastModified"] or ""), reverse=True)

  sys.stdout.write(json.dumps({
    "ok": True,
    "versions": out,
  }) + "\n")

def cmd_delete_object_version(conn_id: str, bucket: str, key: str, version_id: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  if not version_id:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing versionId"}) + "\n")
    return

  try:
    client.delete_object(Bucket=bucket, Key=key, VersionId=version_id)
    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
    }) + "\n")
  except ClientError as e:
    err = (e.response or {}).get("Error") or {}
    code = err.get("Code") or "ClientError"
    msg = err.get("Message") or str(e)
    sys.stdout.write(json.dumps({
      "ok": False,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "error": f"{code}: {msg}",
    }) + "\n")
  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "error": str(e) or e.__class__.__name__,
    }) + "\n")

def cmd_download_object_version(conn_id: str, bucket: str, key: str, version_id: str, argv: List[str]) -> None:
  job_id = get_job_id(argv)

  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  if not version_id:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing versionId"}) + "\n")
    return

  chunk_raw = (get_flag_value(argv, "--chunk", "8388608") or "8388608").strip()
  try:
    chunk_size = max(64 * 1024, int(chunk_raw))
  except ValueError:
    chunk_size = 8 * 1024 * 1024

  def emit_err(obj: Dict[str, Any]) -> None:
    try:
      sys.stderr.write(json.dumps(obj) + "\n")
      sys.stderr.flush()
    except Exception:
      pass

  canceled = {"yes": False}

  def abort():
    canceled["yes"] = True

  install_cancel_handler(abort)

  # HEAD for this version (size/lastModified). Some backends support VersionId in head_object.
  head = client.head_object(Bucket=bucket, Key=key, VersionId=version_id)
  size = int(head.get("ContentLength") or 0)
  lm = head.get("LastModified")

  emit_err({
    "type": "start",
    "ok": True,
    "jobId": job_id,
    "bucket": bucket,
    "key": key,
    "versionId": version_id,
    "size": size,
    "lastModified": (lm.isoformat() if lm else None),
    "chunkSize": chunk_size,
  })

  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": "object-version",
    "pid": os.getpid(),
    "bucket": bucket,
    "key": key,
    "versionId": version_id,
    "size": size,
    "lastModified": (lm.isoformat() if lm else None),
    "chunkSize": chunk_size,
    "state": "running",
  })

  out = sys.stdout.buffer
  sent = 0

  try:
    obj = client.get_object(Bucket=bucket, Key=key, VersionId=version_id)
    body = obj["Body"]

    try:
      while True:
        if canceled["yes"]:
          raise KeyboardInterrupt("Canceled")

        b = body.read(chunk_size)
        if not b:
          break

        out.write(b)
        sent += len(b)

        emit_err({
          "type": "progress",
          "ok": True,
          "jobId": job_id,
          "bytes": sent,
          "size": size,
          "key": key,
          "versionId": version_id,
        })

        write_job(job_id, {
          "type": "progress",
          "ok": True,
          "kind": "object-version",
          "pid": os.getpid(),
          "bucket": bucket,
          "key": key,
          "versionId": version_id,
          "bytes": sent,
          "size": size,
          "state": "running",
        })

    finally:
      try:
        body.close()
      except Exception:
        pass

    emit_err({
      "type": "result",
      "ok": True,
      "jobId": job_id,
      "bytes": sent,
      "size": size,
      "key": key,
      "versionId": version_id,
    })

    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": "object-version",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "bytes": sent,
      "size": size,
      "state": "done",
    })

  except BrokenPipeError:
    try:
      write_job(job_id, {
        "type": "result",
        "ok": False,
        "kind": "object-version",
        "pid": os.getpid(),
        "bucket": bucket,
        "key": key,
        "versionId": version_id,
        "bytes": sent,
        "size": size,
        "error": "BrokenPipe",
        "state": "canceled",
      })
    except Exception:
      pass
    raise SystemExit(0)

  except KeyboardInterrupt:
    emit_err({
      "type": "result",
      "ok": False,
      "jobId": job_id,
      "error": "Canceled",
      "bytes": sent,
      "size": size,
      "key": key,
      "versionId": version_id,
    })

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "object-version",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "bytes": sent,
      "size": size,
      "error": "Canceled",
      "state": "canceled",
    })
    raise

  except Exception as e:
    emit_err({
      "type": "result",
      "ok": False,
      "jobId": job_id,
      "error": str(e),
      "bytes": sent,
      "size": size,
      "key": key,
      "versionId": version_id,
    })

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "object-version",
      "pid": os.getpid(),
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "bytes": sent,
      "size": size,
      "error": str(e),
      "state": "failed",
    })
    raise

def cmd_rollback_object_version(conn_id: str, bucket: str, key: str, version_id: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  if not version_id:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing versionId"}) + "\n")
    return

  src = f"{bucket}/{key}"
  copy_source = {"Bucket": bucket, "Key": key, "VersionId": version_id}

  # Copy onto the same key (creates a new latest version)
  client.copy_object(
    Bucket=bucket,
    Key=key,
    CopySource=copy_source,
    MetadataDirective="COPY",
  )

  sys.stdout.write(json.dumps({
    "ok": True,
    "bucket": bucket,
    "key": key,
    "fromVersionId": version_id,
  }) + "\n")

def cmd_get_bucket_object_lock(conn_id: str, bucket: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  try:
    res = client.get_object_lock_configuration(Bucket=bucket)
    cfg0 = (res.get("ObjectLockConfiguration") or {})
    enabled = (cfg0.get("ObjectLockEnabled") == "Enabled")

    # Optional: default retention configured on the bucket
    rule = ((cfg0.get("Rule") or {}).get("DefaultRetention") or {})
    out: Dict[str, Any] = {
      "ok": True,
      "supported": True,
      "enabled": bool(enabled),
    }
    if rule:
      out["defaultRetention"] = {
        "mode": rule.get("Mode"),
        "days": rule.get("Days"),
        "years": rule.get("Years"),
      }

    sys.stdout.write(json.dumps(out) + "\n")
    return

  except ClientError as e:
    code = (e.response.get("Error") or {}).get("Code") or ""
    # Common for buckets without object-lock: ObjectLockConfigurationNotFoundError
    if code in ("ObjectLockConfigurationNotFoundError", "NoSuchObjectLockConfiguration", "InvalidRequest"):
      sys.stdout.write(json.dumps({
        "ok": True,
        "supported": True,
        "enabled": False,
        "reason": "Bucket Object Lock disabled",
      }) + "\n")
      return

    sys.stdout.write(json.dumps({
      "ok": False,
      "error": f"{code}: {str(e)}",
    }) + "\n")
    return

  except Exception as e:
    # S3-compatible backends may raise different errors or not implement this API
    sys.stdout.write(json.dumps({
      "ok": True,
      "supported": False,
      "enabled": False,
      "reason": str(e),
    }) + "\n")
    return
  
def cmd_get_object_legal_hold(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  version_id = (get_flag_value(argv, "--version-id") or "").strip() or None

  try:
    kwargs: Dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
      kwargs["VersionId"] = version_id

    res = client.get_object_legal_hold(**kwargs)
    hold = (res.get("LegalHold") or {})
    status = hold.get("Status")  # "ON" or "OFF" (may be missing)

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "status": status,
    }) + "\n")
    return

  except ClientError as e:
    code = (e.response.get("Error") or {}).get("Code") or ""
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": f"{code}: {str(e)}",
    }) + "\n")
    return
def cmd_put_object_legal_hold(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  version_id = (get_flag_value(argv, "--version-id") or "").strip() or None
  status = (get_flag_value(argv, "--status") or "").strip().upper()

  if status not in ("ON", "OFF"):
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing/invalid --status (ON|OFF)"}) + "\n")
    return

  try:
    kwargs: Dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
      kwargs["VersionId"] = version_id

    client.put_object_legal_hold(
      **kwargs,
      LegalHold={"Status": status},
    )

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "status": status,
    }) + "\n")
    return

  except ClientError as e:
    code = (e.response.get("Error") or {}).get("Code") or ""
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": f"{code}: {str(e)}",
    }) + "\n")
    return

  
def cmd_get_object_retention(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  version_id = (get_flag_value(argv, "--version-id") or "").strip() or None

  try:
    kwargs: Dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
      kwargs["VersionId"] = version_id

    res = client.get_object_retention(**kwargs)
    r = (res.get("Retention") or {})

    until = r.get("RetainUntilDate")
    until_iso = until.isoformat() if until else None

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "mode": r.get("Mode"),  # GOVERNANCE/COMPLIANCE
      "retainUntil": until_iso,
    }) + "\n")
    return

  except ClientError as e:
    code = (e.response.get("Error") or {}).get("Code") or ""
    # If no retention is set, AWS may return an error rather than empty retention.
    # Treat "no retention" as ok=None so UI shows "None".
    if code in ("NoSuchObjectLockConfiguration", "ObjectLockConfigurationNotFoundError", "InvalidRequest", "NoSuchRetentionConfiguration"):
      sys.stdout.write(json.dumps({
        "ok": True,
        "bucket": bucket,
        "key": key,
        "versionId": version_id,
        "mode": None,
        "retainUntil": None,
      }) + "\n")
      return

    sys.stdout.write(json.dumps({
      "ok": False,
      "error": f"{code}: {str(e)}",
    }) + "\n")
    return

def cmd_put_object_retention(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  version_id = (get_flag_value(argv, "--version-id") or "").strip() or None
  mode = (get_flag_value(argv, "--mode") or "").strip().upper()  # GOVERNANCE|COMPLIANCE
  retain_until_raw = (get_flag_value(argv, "--retain-until") or "").strip()
  bypass_raw = (get_flag_value(argv, "--bypass-governance") or "").strip()

  if mode not in ("GOVERNANCE", "COMPLIANCE"):
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing/invalid --mode (GOVERNANCE|COMPLIANCE)"}) + "\n")
    return

  if not retain_until_raw:
    sys.stdout.write(json.dumps({"ok": False, "error": "Missing --retain-until (ISO-8601 timestamp)"} ) + "\n")
    return

  try:
    retain_until_dt = parse_iso8601_to_datetime(retain_until_raw)
  except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": f"Invalid --retain-until: {str(e)}"}) + "\n")
    return

  bypass = False
  if bypass_raw:
    bypass = str(bypass_raw).strip() in ("1", "true", "True", "yes", "YES", "on", "ON")

  try:
    kwargs: Dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
      kwargs["VersionId"] = version_id

    # This flag is only meaningful for GOVERNANCE scenarios where you have permission.
    if bypass:
      kwargs["BypassGovernanceRetention"] = True

    client.put_object_retention(
      **kwargs,
      Retention={
        "Mode": mode,
        "RetainUntilDate": retain_until_dt,
      },
    )

    sys.stdout.write(json.dumps({
      "ok": True,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "mode": mode,
      "retainUntil": retain_until_dt.isoformat(),
      "bypassGovernance": bool(bypass),
    }) + "\n")
    return

  except ClientError as e:
    code = (e.response.get("Error") or {}).get("Code") or ""
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": f"{code}: {str(e)}",
    }) + "\n")
    return


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

  if cmd == "upload-stdin":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli upload-stdin <connectionId> <bucket> <key> --size N [--content-type CT]")
    cmd_upload_stdin(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return

  if cmd == "download-prefix-targz":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli download-prefix-targz <connectionId> <bucket> <prefix> [--strip-components N]")
    cmd_download_prefix_targz(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return

  if cmd == "download-object":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli download-object <connectionId> <bucket> <key> [--chunk N]")
    cmd_download_object(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return

  if cmd == "download-job-status":
    if len(sys.argv) < 3:
      raise ValueError("Usage: s3browser-cli download-job-status <jobId>")
    cmd_download_job_status(sys.argv[2])
    return
  
  if cmd == "copy-object":
    if len(sys.argv) < 7:
      raise ValueError("Usage: s3browser-cli copy-object <connectionId> <srcBucket> <srcKey> <dstBucket> <dstKey> [--concurrency N]")
    cmd_copy_object(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7:])
    return

  if cmd == "copy-prefix":
    if len(sys.argv) < 7:
      raise ValueError("Usage: s3browser-cli copy-prefix <connectionId> <srcBucket> <srcPrefix> <dstBucket> <dstPrefix> [--concurrency N]")
    cmd_copy_prefix(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7:])
    return


  if cmd == "move-prefix":
    if len(sys.argv) < 7:
      raise ValueError("Usage: s3browser-cli move-prefix <connectionId> <srcBucket> <srcPrefix> <dstBucket> <dstPrefix> [--concurrency N]")
    cmd_move_prefix(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7:])
    return
  if cmd == "stat-object":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli stat-object <connectionId> <bucket> <key>")
    cmd_stat_object(sys.argv[2], sys.argv[3], sys.argv[4])
    return
  
  if cmd == "put-object-tags":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli put-object-tags <connectionId> <bucket> <key> [--tag k=v ...] [--tags-json JSON]")
    cmd_put_object_tags(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return

  
  if cmd == "get-object-tags":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli get-object-tags <connectionId> <bucket> <key>")
    cmd_get_object_tags(sys.argv[2], sys.argv[3], sys.argv[4])
    return
  
  if cmd == "change-storage-class":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli change-storage-class <connectionId> <bucket> <key> --storage-class CLASS [--force 1] [--concurrency N]")
    cmd_change_storage_class(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return
  if cmd == "cancel-download-job":
    if len(sys.argv) < 3:
      raise ValueError("Usage: cancel-download-job <job_id>")
    cmd_cancel_download_job(sys.argv[2])
    return
  
  if cmd == "list-object-versions":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli list-object-versions <connectionId> <bucket> <key> [--max-keys N]")
    conn_id = sys.argv[2]
    bucket = sys.argv[3]
    key = sys.argv[4]
    argv = sys.argv[5:]

    max_keys = 200
    try:
      mk = get_flag_value(argv, "--max-keys")
      if mk is not None and str(mk).strip() != "":
        max_keys = int(mk)
    except Exception:
      max_keys = 200

    cmd_list_object_versions(conn_id, bucket, key, max_keys=max_keys)
    return
  if cmd == "delete-object-version":
    if len(sys.argv) < 6:
      raise ValueError("Usage: delete-object-version <connectionId> <bucket> <key> <versionId>")
    cmd_delete_object_version(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    return

  if cmd == "rollback-object-version":
    if len(sys.argv) < 6:
      raise ValueError("Usage: rollback-object-version <connectionId> <bucket> <key> <versionId>")
    cmd_rollback_object_version(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    return

  if cmd == "download-object-version":
    if len(sys.argv) < 6:
      raise ValueError("Usage: download-object-version <connectionId> <bucket> <key> <versionId> --job-id JOB [--chunk N]")
    cmd_download_object_version(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    return
  if cmd == "get-bucket-object-lock":
    if len(sys.argv) < 4:
      raise ValueError("Usage: s3browser-cli get-bucket-object-lock <connectionId> <bucket>")
    cmd_get_bucket_object_lock(sys.argv[2], sys.argv[3])
    return

  if cmd == "get-object-legal-hold":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli get-object-legal-hold <connectionId> <bucket> <key> [--version-id VID]")
    cmd_get_object_legal_hold(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return

  if cmd == "get-object-retention":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli get-object-retention <connectionId> <bucket> <key> [--version-id VID]")
    cmd_get_object_retention(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return
  
  if cmd == "put-object-legal-hold":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli put-object-legal-hold <connectionId> <bucket> <key> --status (ON|OFF) [--version-id VID]")
    cmd_put_object_legal_hold(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return
  
  if cmd == "put-object-retention":
    if len(sys.argv) < 5:
      raise ValueError("Usage: s3browser-cli put-object-retention <connectionId> <bucket> <key> --mode (GOVERNANCE|COMPLIANCE) --retain-until ISO [--version-id VID] [--bypass-governance 1]")
    cmd_put_object_retention(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    return


  raise ValueError("Unknown command")

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

