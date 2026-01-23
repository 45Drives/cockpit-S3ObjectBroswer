#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List, Optional
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import tarfile
import time
from utils import DEFAULT_CONCURRENCY, cfg_path, get_job_id, install_cancel_handler, make_client, get_flag_value, multipart_copy_parallel, normalize_prefix, read_json, write_job



def _parse_concurrency(argv: List[str]) -> int:
  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    c = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  return max(1, min(32, c))


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



def cmd_transfer_prefix(
  conn_id: str,
  src_bucket: str,
  src_prefix: str,
  dst_bucket: str,
  dst_prefix: str,
  argv: List[str],
  *,
  kind: str,           # "copy-prefix" | "move-prefix"
  phase_run: str,      # "copying" | "moving"
  delete_source: bool,
) -> None:
  job_id = get_job_id(argv)

  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  src_p = normalize_prefix(src_prefix)
  dst_p = normalize_prefix(dst_prefix)

  if not src_p or not dst_p:
    raise ValueError("Missing srcPrefix or dstPrefix")
  if src_bucket == dst_bucket and src_p == dst_p:
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0}) + "\n")
    return

  concurrency = _parse_concurrency(argv)
  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

  canceled = {"yes": False}
  def abort():
    canceled["yes"] = True
  install_cancel_handler(abort)

  # start job
  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": kind,
    "pid": os.getpid(),
    "srcBucket": src_bucket,
    "dstBucket": dst_bucket,
    "srcPrefix": src_p,
    "dstPrefix": dst_p,
    "files": 0,
    "doneFiles": 0,
    "bytes": 0,
    "totalBytes": 0,
    "state": "running",
    "phase": "scanning",
  })

  # scan
  keys: List[Dict[str, Any]] = []
  total_bytes = 0
  scanned = 0

  for key, size, lm in iter_keys_under_prefix(client, src_bucket, src_p):
    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    sz = int(size or 0)
    rel = key[len(src_p):] if key.startswith(src_p) else key
    dst_key = dst_p + rel

    keys.append({"src": key, "dst": dst_key, "size": sz})
    total_bytes += sz
    scanned += 1

    if scanned % 200 == 0:
      write_job(job_id, {
        "type": "progress",
        "ok": True,
        "kind": kind,
        "pid": os.getpid(),
        "srcBucket": src_bucket,
        "dstBucket": dst_bucket,
        "srcPrefix": src_p,
        "dstPrefix": dst_p,
        "files": scanned,
        "doneFiles": 0,
        "bytes": 0,
        "totalBytes": total_bytes,
        "state": "running",
        "phase": "scanning",
      })

  if not keys:
    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": kind,
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": 0,
      "doneFiles": 0,
      "bytes": 0,
      "totalBytes": 0,
      "state": "done",
      "phase": phase_run,
    })
    sys.stdout.write(json.dumps({"ok": True, "srcPrefix": src_p, "dstPrefix": dst_p, "files": 0, "bytes": 0, "totalBytes": 0}) + "\n")
    return

  # progress state
  lock = threading.Lock()
  done_files = 0
  done_bytes = 0
  partial: Dict[str, int] = {}
  last_write = 0.0

  def write_progress(force: bool = False) -> None:
    nonlocal last_write
    now = time.time()
    if not force and (now - last_write) < 0.2:
      return
    last_write = now

    with lock:
      inprog = 0
      for v in partial.values():
        try:
          inprog += int(v or 0)
        except Exception:
          pass
      bytes_so_far = int(done_bytes + inprog)
      df = int(done_files)

    write_job(job_id, {
      "type": "progress",
      "ok": True,
      "kind": kind,
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": len(keys),
      "doneFiles": df,
      "bytes": bytes_so_far,
      "totalBytes": total_bytes,
      "state": "running",
      "phase": phase_run,
    })

  # switch to run phase
  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": kind,
    "pid": os.getpid(),
    "srcBucket": src_bucket,
    "dstBucket": dst_bucket,
    "srcPrefix": src_p,
    "dstPrefix": dst_p,
    "files": len(keys),
    "doneFiles": 0,
    "bytes": 0,
    "totalBytes": total_bytes,
    "state": "running",
    "phase": phase_run,
  })

  def do_one(it: Dict[str, Any]) -> Dict[str, Any]:
    nonlocal done_files, done_bytes  # must be at top of function (not inside a with block)

    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    src_key = it["src"]
    dst_key = it["dst"]
    sz = int(it.get("size") or 0)

    if sz >= MULTIPART_THRESHOLD:
      with lock:
        partial[src_key] = 0

      def emit(ev: Any) -> None:
        b = 0
        try:
          b = ev.get("bytesCopied")
        except Exception:
          pass
        if b is None:
          try:
            b = ev.get("bytes")
          except Exception:
            b = 0
        try:
          b = int(b or 0)
        except Exception:
          b = 0
        if b < 0:
          b = 0
        if b > sz:
          b = sz

        with lock:
          partial[src_key] = b
        write_progress(False)

      multipart_copy_parallel(
        client,
        src_bucket,
        src_key,
        dst_bucket,
        dst_key,
        concurrency,
        emit=emit,
      )

      with lock:
        partial.pop(src_key, None)
    else:
      client.copy_object(
        Bucket=dst_bucket,
        Key=dst_key,
        CopySource={"Bucket": src_bucket, "Key": src_key},
        MetadataDirective="COPY",
      )

    if delete_source:
      client.delete_object(Bucket=src_bucket, Key=src_key)

    with lock:
      done_files += 1
      done_bytes += sz

    write_progress(False)
    return it

  try:
    write_progress(True)

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
      futs = [ex.submit(do_one, it) for it in keys]
      for fut in as_completed(futs):
        fut.result()

    write_progress(True)

    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": kind,
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": len(keys),
      "doneFiles": done_files,
      "bytes": int(done_bytes),
      "totalBytes": total_bytes,
      "state": "done",
      "phase": phase_run,
    })

    sys.stdout.write(json.dumps({
      "ok": True,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    return

  except KeyboardInterrupt:
    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": kind,
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": len(keys),
      "doneFiles": done_files,
      "bytes": int(done_bytes),
      "totalBytes": total_bytes,
      "error": "Canceled",
      "state": "canceled",
      "phase": phase_run,
    })
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": "Canceled",
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    return

  except Exception as e:
    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": kind,
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": len(keys),
      "doneFiles": done_files,
      "bytes": int(done_bytes),
      "totalBytes": total_bytes,
      "error": str(e),
      "state": "failed",
      "phase": phase_run,
    })
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": str(e),
      "srcPrefix": src_p,
      "dstPrefix": dst_p,
      "files": done_files,
      "bytes": done_bytes,
      "totalBytes": total_bytes,
    }) + "\n")
    return


def cmd_copy_prefix(conn_id: str, src_bucket: str, src_prefix: str, dst_bucket: str, dst_prefix: str, argv: List[str]) -> None:
  return cmd_transfer_prefix(
    conn_id, src_bucket, src_prefix, dst_bucket, dst_prefix, argv,
    kind="copy-prefix",
    phase_run="copying",
    delete_source=False,
  )


def cmd_move_prefix(conn_id: str, src_bucket: str, src_prefix: str, dst_bucket: str, dst_prefix: str, argv: List[str]) -> None:
  return cmd_transfer_prefix(
    conn_id, src_bucket, src_prefix, dst_bucket, dst_prefix, argv,
    kind="move-prefix",
    phase_run="moving",
    delete_source=True,
  )


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
    return
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
    return

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

  # Progress must go to STDERR only. STDOUT must be tar.gz bytes only.
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

  # Create job file immediately so UI polling never hits "Job not found"
  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": "prefix-targz",
    "pid": os.getpid(),
    "bucket": bucket,
    "prefix": p,
    "files": 0,
    "fileIndex": 0,
    "bytes": 0,
    "totalBytes": 0,
    "state": "running",
    "phase": "scanning",
    "updatedAt": int(time.time() * 1000),
  })

  # Collect keys first so we can compute totals
  keys: List[Dict[str, Any]] = []
  total_bytes = 0
  scanned = 0

  # Throttle scan-phase job writes
  last_scan_emit = 0.0

  for key, size, lm in iter_keys_under_prefix(client, bucket, p):
    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    sz = int(size or 0)
    keys.append({"key": key, "size": sz, "lastModified": lm})
    total_bytes += sz
    scanned += 1

    now = time.time()
    if scanned % 250 == 0 and (now - last_scan_emit) >= 0.25:
      last_scan_emit = now
      write_job(job_id, {
        "type": "progress",
        "ok": True,
        "kind": "prefix-targz",
        "pid": os.getpid(),
        "bucket": bucket,
        "prefix": p,
        "files": scanned,
        "fileIndex": 0,
        "bytes": 0,
        "totalBytes": total_bytes,
        "state": "running",
        "phase": "scanning",
        "updatedAt": int(now * 1000),
      })

  # Emit start to STDERR and finalize totals into the job file
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
    "fileIndex": 0,
    "bytes": 0,
    "totalBytes": total_bytes,
    "state": "running",
    "phase": "streaming",
    "updatedAt": int(time.time() * 1000),
  })

  out = sys.stdout.buffer  # tar.gz stream destination

  # Streaming counters (mutable so nested code can update safely)
  prog = {
    "sent": 0,
    "fileIndex": 0,
    "lastEmitT": 0.0,
    "lastEmitB": 0,
  }

  READ_CHUNK = 8 * 1024 * 1024   # cap reads so progress updates during huge objects
  EMIT_EVERY_SEC = 0.25          # 4 updates/sec
  EMIT_EVERY_BYTES = 16 * 1024 * 1024  # or every 16 MiB, whichever comes first

  def maybe_emit_progress(current_key: str) -> None:
    now = time.time()
    if (now - prog["lastEmitT"]) < EMIT_EVERY_SEC and (prog["sent"] - prog["lastEmitB"]) < EMIT_EVERY_BYTES:
      return

    prog["lastEmitT"] = now
    prog["lastEmitB"] = prog["sent"]

    # Job file is what getDownloadJobStatus reads
    write_job(job_id, {
      "type": "progress",
      "ok": True,
      "kind": "prefix-targz",
      "pid": os.getpid(),
      "bucket": bucket,
      "prefix": p,
      "fileIndex": prog["fileIndex"],
      "files": len(keys),
      "bytes": prog["sent"],
      "totalBytes": total_bytes,
      "key": current_key,
      "state": "running",
      "phase": "streaming",
      "updatedAt": int(now * 1000),
    })

    # Optional: also mirror to stderr (safe but can be noisy). Keep it throttled by this function.
    emit_err({
      "type": "progress",
      "ok": True,
      "jobId": job_id,
      "fileIndex": prog["fileIndex"],
      "files": len(keys),
      "bytes": prog["sent"],
      "totalBytes": total_bytes,
      "key": current_key,
    })

  class CountingReader:
    def __init__(self, body, key: str):
      self.body = body
      self.key = key

    def read(self, n: int = -1):
      if canceled["yes"]:
        raise KeyboardInterrupt("Canceled")

      # tarfile may request huge reads; cap them so we can emit progress during big files
      if n is None or n < 0:
        n = READ_CHUNK
      else:
        n = min(n, READ_CHUNK)

      b = self.body.read(n)
      if b:
        prog["sent"] += len(b)
        maybe_emit_progress(self.key)
      return b

    def close(self):
      try:
        self.body.close()
      except Exception:
        pass

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

        reader = CountingReader(body, key)

        try:
          # Build tar header
          ti = tarfile.TarInfo(name=arcname)
          ti.size = size
          try:
            if lm is not None:
              ti.mtime = int(lm.timestamp())
            else:
              ti.mtime = int(time.time())
          except Exception:
            ti.mtime = int(time.time())

          # Count this file as "current file index" before streaming it
          prog["fileIndex"] += 1
          maybe_emit_progress(key)

          # Stream file content; CountingReader updates prog["sent"] continuously
          tar.addfile(ti, fileobj=reader)

          # Ensure a final tick right after file completes
          maybe_emit_progress(key)

        finally:
          reader.close()

    emit_err({
      "type": "result",
      "ok": True,
      "jobId": job_id,
      "files": len(keys),
      "bytes": prog["sent"],
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
      "fileIndex": prog["fileIndex"],
      "bytes": prog["sent"],
      "totalBytes": total_bytes,
      "state": "done",
      "phase": "streaming",
      "updatedAt": int(time.time() * 1000),
    })

  except BrokenPipeError:
    # Browser canceled / channel closed mid-stream.
    # Mark canceled best-effort and exit cleanly.
    try:
      write_job(job_id, {
        "type": "result",
        "ok": False,
        "kind": "prefix-targz",
        "pid": os.getpid(),
        "bucket": bucket,
        "prefix": p,
        "files": len(keys),
        "fileIndex": prog["fileIndex"],
        "bytes": prog["sent"],
        "totalBytes": total_bytes,
        "error": "BrokenPipe",
        "state": "canceled",
        "phase": "streaming",
        "updatedAt": int(time.time() * 1000),
      })
    except Exception:
      pass
    raise SystemExit(0)

  except KeyboardInterrupt:
    emit_err({"type": "result", "ok": False, "jobId": job_id, "error": "Canceled"})

    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "prefix-targz",
      "pid": os.getpid(),
      "bucket": bucket,
      "prefix": p,
      "files": len(keys),
      "fileIndex": prog["fileIndex"],
      "bytes": prog["sent"],
      "totalBytes": total_bytes,
      "error": "Canceled",
      "state": "canceled",
      "phase": "streaming",
      "updatedAt": int(time.time() * 1000),
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
      "files": len(keys),
      "fileIndex": prog["fileIndex"],
      "bytes": prog["sent"],
      "totalBytes": total_bytes,
      "error": str(e),
      "state": "failed",
      "phase": "streaming",
      "updatedAt": int(time.time() * 1000),
    })
    raise
