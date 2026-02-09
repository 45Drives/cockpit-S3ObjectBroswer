#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List, Optional

from botocore.exceptions import ClientError # type: ignore
from utils import cfg_path, get_flag_value, get_job_id, install_cancel_handler, make_client, read_json, write_job

def cmd_list_object_versions(conn_id: str, bucket: str, key: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  out = []
  key_marker = None
  version_marker = None
  max_keys = 1000
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
    raise SystemExit(0)

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
    raise SystemExit(1)


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
    raise SystemExit(0)

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
    raise SystemExit(1)
