#!/usr/bin/env python3
import json
import os
import sys
from typing import Any, Dict, List, Optional
import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from botocore.exceptions import ClientError # type: ignore
from utils import DEFAULT_CONCURRENCY, _emit_ndjson, cfg_path, choose_part_size, install_cancel_handler, make_client, get_flag_value, read_json


def _client_error_info(e: ClientError) -> Dict[str, Any]:
  resp = getattr(e, "response", None) or {}
  err = (resp.get("Error") or {})
  meta = (resp.get("ResponseMetadata") or {})

  code = err.get("Code")
  msg = err.get("Message")
  return {
    "s3Code": (str(code) if code is not None else None),
    "s3Message": (str(msg) if msg is not None else None),
    "httpStatus": meta.get("HTTPStatusCode"),
    "requestId": meta.get("RequestId"),
  }


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
  concurrency = max(1, min(32, concurrency))

  force = (get_flag_value(argv, "--force", "0") or "0").strip() in ("1", "true", "yes", "on")

  canceled = {"yes": False}
  def abort():
    canceled["yes"] = True
  install_cancel_handler(abort)

  MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024  # 5 GiB

  try:
    head = client.head_object(Bucket=bucket, Key=key)
    size = int(head.get("ContentLength") or 0)
    lm = head.get("LastModified")
    cur_sc = head.get("StorageClass")  # may be None

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
      sys.stdout.write(json.dumps({
        "ok": False,
        "type": "result",
        "error": "Canceled",
        "bucket": bucket,
        "key": key,
        "requestedStorageClass": storage_class,
        "storageClass": (str(cur_sc) if cur_sc else None),
        "size": size,
        "lastModified": (lm.isoformat() if lm else None),
      }) + "\n")
      return

    if size >= MULTIPART_THRESHOLD:
      def emit(_obj: Dict[str, Any]) -> None:
        _emit_ndjson(_obj)

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

  except ClientError as e:
    info = _client_error_info(e)
    code = info.get("s3Code") or "Error"
    msg = (info.get("s3Message") or "").strip() or None

    if code in ("InvalidArgument", "InvalidStorageClass"):
      err_msg = f'Storage class "{storage_class}" is not supported or not allowed by your s3 provider.'
    else:
      err_msg = msg or str(e)

    sys.stdout.write(json.dumps({
      "ok": False,
      "type": "result",
      "error": err_msg,
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
      **info,
    }) + "\n")
    return

  except KeyboardInterrupt:
    sys.stdout.write(json.dumps({
      "ok": False,
      "type": "result",
      "error": "Canceled",
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
    }) + "\n")
    return

  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "type": "result",
      "error": str(e),
      "bucket": bucket,
      "key": key,
      "requestedStorageClass": storage_class,
    }) + "\n")
    return
