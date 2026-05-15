import json
import os
import sys
from typing import Any, Dict, List, Optional
import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import signal
import time
import botocore.session # type: ignore
from botocore.config import Config # type: ignore
import pwd
from botocore.exceptions import  ClientError # type: ignore
import tempfile

def get_base_dir() -> str:
  xdg = os.environ.get("XDG_CONFIG_HOME")
  if xdg:
    base = xdg
  else:
    home = os.environ.get("HOME") or pwd.getpwuid(os.getuid()).pw_dir
    base = os.path.join(home, ".config")

  return os.path.join(base, "45drives", "s3-object-browser", "connections")

def get_job_dir() -> str:
  rt = os.environ.get("XDG_RUNTIME_DIR")
  if rt:
    return os.path.join(rt, "s3browser", "downloads")
  return os.path.join(tempfile.gettempdir(), f"s3browser-{os.getuid()}", "downloads")

JOB_DIR = get_job_dir()


BASE_DIR = get_base_dir()
JOB_DIR = get_job_dir()

DEFAULT_CONCURRENCY = 6
MIN_PART_SIZE = 5 * 1024 * 1024
MAX_PARTS = 10000
_abort_lock = threading.Lock()
_abort_fns: List[callable] = []
_handler_installed = False


def new_job_id() -> str:
  # no uuid import needed
  return f"{int(time.time()*1000)}-{os.getpid()}-{abs(hash(os.urandom(8)))%10_000_000}"

def get_job_id(argv: List[str]) -> str:
  return (get_flag_value(argv, "--job-id", "") or "").strip() or new_job_id()

def read_json(path: str) -> Dict[str, Any]:
  if not os.path.exists(path):
    raise ValueError("Connection not found")
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)

def make_client(cfg: Dict[str, Any]):
    endpoint = endpoint_url_from_cfg(cfg)
    region = (cfg.get("region") or "us-east-1").strip()
    access_key = cfg.get("accessKeyId") or ""
    secret_key = cfg.get("secretAccessKey") or ""
    if not access_key or not secret_key:
        raise ValueError("Missing credentials")

    use_tls = bool(cfg.get("useTls"))
    tls_verify = cfg.get("tlsVerify", not use_tls)
    if tls_verify is None:
        tls_verify = not use_tls

    sess = botocore.session.get_session()
    return sess.create_client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        verify=tls_verify,
        config=Config(signature_version="s3v4"),
    )

def endpoint_url_from_cfg(cfg: Dict[str, Any]) -> str:
    raw = (cfg.get("endpoint") or "").strip()
    if not raw:
        raise ValueError("Missing endpoint")
    if raw.startswith("http"):
        return raw.rstrip("/")
    scheme = "https" if cfg.get("useTls") else "http"
    return f"{scheme}://{raw.rstrip('/')}"
    
def _format_err(e: BaseException) -> str:
    if isinstance(e, ClientError):
        err = (getattr(e, "response", None) or {}).get("Error") or {}
        code = err.get("Code") or "ClientError"
        msg = err.get("Message") or str(e)
        return f"{code}: {msg}"
    return str(e)

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


def get_flag_value(argv: List[str], name: str, default: Optional[str] = None) -> Optional[str]:
  if name not in argv:
    return default
  i = argv.index(name)
  if i + 1 >= len(argv):
    raise ValueError(f"Missing value for {name}")
  return argv[i + 1]

def _wants_ndjson(cmd: str, argv: List[str]) -> bool:
  if cmd in ("delete-prefix", "upload-stdin"):
    return True
  if cmd == "rename-object":
    return "--stream" in argv
  if cmd == "change-storage-class":
    return True
  return False

def _emit_ndjson(obj: Dict[str, Any]) -> None:
  # identical format, but semantically "one line of NDJSON"
  sys.stdout.write(json.dumps(obj) + "\n")
  sys.stdout.flush()



def _emit_json_stderr(obj: Dict[str, Any]) -> None:
  sys.stderr.write(json.dumps(obj) + "\n")
  sys.stderr.flush()

def _format_err(e: BaseException) -> str:
  if isinstance(e, KeyboardInterrupt):
    return "Canceled"
  if isinstance(e, ClientError):
    err = (getattr(e, "response", None) or {}).get("Error") or {}
    code = err.get("Code") or "ClientError"
    msg = err.get("Message") or str(e)
    return f"{code}: {msg}"
  s = str(e).strip()
  return s if s else e.__class__.__name__

def _emit_json_stdout(obj: Dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(obj) + "\n")
  sys.stdout.flush()

BINARY_STDOUT_CMDS = {
  "download-object",
  "download-prefix-targz",
  "download-object-version",
}

#Commands that are NDJSON on STDOUT in some/most cases (streaming progress/result)
NDJSON_STDOUT_CMDS = {
  "delete-prefix",
  "upload-stdin",
  "rename-object",         
  "change-storage-class",   
}

def cfg_path(conn_id: str) -> str:
  return os.path.join(BASE_DIR, f"{conn_id}.json")

def choose_part_size(size: int) -> int:
  if size <= 0:
    return MIN_PART_SIZE
  min_size_for_limit = int(math.ceil(size / MAX_PARTS))
  return max(MIN_PART_SIZE, min_size_for_limit)


def normalize_prefix(p: str) -> str:
  s = (p or "").lstrip("/")
  if s and not s.endswith("/"):
    s += "/"
  return s

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

def install_cancel_handler(abort_fn=None):
  """
  Register an abort callback that should run on SIGINT/SIGTERM, and (only once)
  install signal handlers from the main thread.

  Safe to call from worker threads:
    - worker threads will only register abort_fn
    - signal handlers are installed only in the main thread
  """
  global _handler_installed

  # Register abort callback from any thread
  if abort_fn is not None:
    try:
      with _abort_lock:
        _abort_fns.append(abort_fn)
    except Exception:
      pass

  # Only main thread can install signal handlers
  if threading.current_thread() is not threading.main_thread():
    return

  # Install handlers once
  if _handler_installed:
    return
  _handler_installed = True

  def _run_aborts_best_effort() -> None:
    try:
      with _abort_lock:
        fns = list(_abort_fns)
    except Exception:
      fns = []

    # Most-recent first (helps nested operations abort first)
    for fn in reversed(fns):
      try:
        fn()
      except Exception:
        pass

  def _handler(signum, frame):
    try:
      _run_aborts_best_effort()
    finally:
      raise KeyboardInterrupt("Canceled")

  signal.signal(signal.SIGTERM, _handler)
  signal.signal(signal.SIGINT, _handler)
