#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List
import math
import time
from utils import DEFAULT_CONCURRENCY, _emit_ndjson, cfg_path, get_job_id, install_cancel_handler, make_client, get_flag_value, multipart_copy_parallel, read_exact, read_json, write_job

MAX_PARTS = 10000

def choose_upload_part_size(size: int, min_part: int = 8 * 1024 * 1024) -> int:
  if size <= 0:
    return min_part
  by_max_parts = int(math.ceil(size / MAX_PARTS))
  return max(min_part, by_max_parts)


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
    _emit_ndjson(obj)

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
    return

  except KeyboardInterrupt:
    abort()
    emit({"type": "result", "ok": False, "bucket": bucket, "key": key, "size": total_size, "error": "Canceled"})
    return

  except Exception as e:
    abort()
    emit({"type": "result", "ok": False, "bucket": bucket, "key": key, "size": total_size, "error": str(e)})
    return



def cmd_copy_object(conn_id: str, src_bucket: str, src_key: str, dst_bucket: str, dst_key: str, argv: List[str]) -> None:
  job_id = get_job_id(argv)

  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  if not src_key or not dst_key:
    raise ValueError("Missing src or dst key")
  if src_bucket == dst_bucket and src_key == dst_key:
    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": "copy-object",
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcKey": src_key,
      "dstKey": dst_key,
      "bytes": 0,
      "totalBytes": 0,
      "state": "done",
      "phase": "copying",
    })
    sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key}) + "\n")
    return

  conc_raw = get_flag_value(argv, "--concurrency", str(DEFAULT_CONCURRENCY)) or str(DEFAULT_CONCURRENCY)
  try:
    concurrency = int(conc_raw)
  except ValueError:
    raise ValueError("Invalid --concurrency")
  concurrency = max(1, min(32, concurrency))

  canceled = {"yes": False}
  def abort():
    canceled["yes"] = True
  install_cancel_handler(abort)

  # Size
  head = client.head_object(Bucket=src_bucket, Key=src_key)
  size = int(head.get("ContentLength") or 0)

  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

  # Create job file immediately
  write_job(job_id, {
    "type": "start",
    "ok": True,
    "kind": "copy-object",
    "pid": os.getpid(),
    "srcBucket": src_bucket,
    "dstBucket": dst_bucket,
    "srcKey": src_key,
    "dstKey": dst_key,
    "bytes": 0,
    "totalBytes": size,
    "state": "running",
    "phase": "copying",
  })

  last_write = 0.0
  copied = {"bytes": 0}

  def write_progress(force: bool = False) -> None:
    nonlocal last_write
    now = time.time()
    if not force and (now - last_write) < 0.2:
      return
    last_write = now
    write_job(job_id, {
      "type": "progress",
      "ok": True,
      "kind": "copy-object",
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcKey": src_key,
      "dstKey": dst_key,
      "bytes": int(copied["bytes"]),
      "totalBytes": size,
      "state": "running",
      "phase": "copying",
    })

  try:
    if canceled["yes"]:
      raise KeyboardInterrupt("Canceled")

    if size >= MULTIPART_THRESHOLD:
      def emit(ev: Any) -> None:
        # If multipart_copy_parallel calls emit with bytesCopied, we surface it.
        try:
          b = ev.get("bytesCopied")
        except Exception:
          b = None
        if b is None:
          try:
            b = ev.get("bytes")
          except Exception:
            b = None
        try:
          b = int(b or 0)
        except Exception:
          b = 0
        if b < 0:
          b = 0
        if b > size:
          b = size

        copied["bytes"] = b
        write_progress(False)

      multipart_copy_parallel(client, src_bucket, src_key, dst_bucket, dst_key, concurrency, emit=emit)
      copied["bytes"] = size
      write_progress(True)
    else:
      client.copy_object(
        Bucket=dst_bucket,
        Key=dst_key,
        CopySource={"Bucket": src_bucket, "Key": src_key},
        MetadataDirective="COPY",
      )
      copied["bytes"] = size
      write_progress(True)

    write_job(job_id, {
      "type": "result",
      "ok": True,
      "kind": "copy-object",
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcKey": src_key,
      "dstKey": dst_key,
      "bytes": size,
      "totalBytes": size,
      "state": "done",
      "phase": "copying",
    })

    sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key, "size": size}) + "\n")
    return

  except KeyboardInterrupt:
    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "copy-object",
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcKey": src_key,
      "dstKey": dst_key,
      "bytes": int(copied["bytes"]),
      "totalBytes": size,
      "error": "Canceled",
      "state": "canceled",
      "phase": "copying",
    })
    sys.stdout.write(json.dumps({"ok": False, "error": "Canceled"}) + "\n")
    return

  except Exception as e:
    write_job(job_id, {
      "type": "result",
      "ok": False,
      "kind": "copy-object",
      "pid": os.getpid(),
      "srcBucket": src_bucket,
      "dstBucket": dst_bucket,
      "srcKey": src_key,
      "dstKey": dst_key,
      "bytes": int(copied["bytes"]),
      "totalBytes": size,
      "error": str(e),
      "state": "failed",
      "phase": "copying",
    })
    sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
    return


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
        _emit_ndjson(obj)

    # Head to check size of the object
    try:
        head = client.head_object(Bucket=bucket, Key=src_key)
        size = int(head.get("ContentLength") or 0)
    except client.exceptions.NoSuchKey:
        sys.stdout.write(json.dumps({"ok": False, "error": "Source object not found"}) + "\n")
        return

    MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

    try:
        if size >= MULTIPART_THRESHOLD:
            # Handle multipart copy for large files (5GB+)
            multipart_copy_parallel(client, bucket, src_key, bucket, dst_key, concurrency, emit if stream else None)
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

            # Copy the object
            client.copy_object(
                Bucket=bucket,
                Key=dst_key,
                CopySource={"Bucket": bucket, "Key": src_key},
                MetadataDirective="COPY",
            )

            if stream:
                emit({"type": "progress", "ok": True, "partsDone": 1, "totalParts": 1, "bytesCopied": size, "size": size})

        # Delete the source object after successful copy
        client.delete_object(Bucket=bucket, Key=src_key)

        # Emit the final result (success)
        if stream:
            emit({"type": "result", "ok": True, "src": src_key, "dst": dst_key, "size": size})

        if not stream:
            sys.stdout.write(json.dumps({"ok": True, "src": src_key, "dst": dst_key}) + "\n")

    except Exception as e:
        if stream and not emitted_result:
            emit({"type": "result", "ok": False, "src": src_key, "dst": dst_key, "size": size, "error": str(e)})
        sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")

def cmd_delete_object(conn_id: str, bucket: str, key: str) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  client.delete_object(Bucket=bucket, Key=key)
  sys.stdout.write(json.dumps({"ok": True}) + "\n")


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

