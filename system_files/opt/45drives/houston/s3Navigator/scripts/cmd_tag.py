#!/usr/bin/env python3
import json
import sys
from typing import  Dict, List

from utils import cfg_path, get_flag_value, make_client, read_json

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

  version_id = (get_flag_value(argv, "--version-id", "") or "").strip() or None

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

  tagset = [{"Key": k, "Value": v} for k, v in final_tags.items()]

  req = {
    "Bucket": bucket,
    "Key": key,
    "Tagging": {"TagSet": tagset},
  }
  if version_id:
    req["VersionId"] = version_id

  client.put_object_tagging(**req)

  sys.stdout.write(json.dumps({
    "ok": True,
    "bucket": bucket,
    "key": key,
    "versionId": version_id,
    "tags": [{"key": k, "value": v} for k, v in final_tags.items()],
  }) + "\n")


def cmd_get_object_tags(conn_id: str, bucket: str, key: str, argv: List[str]) -> None:
  record = read_json(cfg_path(conn_id))
  cfg = record.get("config") or {}
  client = make_client(cfg)

  version_id = (get_flag_value(argv, "--version-id", "") or "").strip() or None

  try:
    req = {"Bucket": bucket, "Key": key}
    if version_id:
      req["VersionId"] = version_id

    res = client.get_object_tagging(**req)
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
      "versionId": version_id,
      "tags": tags,
    }) + "\n")

  except Exception as e:
    sys.stdout.write(json.dumps({
      "ok": False,
      "bucket": bucket,
      "key": key,
      "versionId": version_id,
      "error": str(e),
    }) + "\n")
    return
