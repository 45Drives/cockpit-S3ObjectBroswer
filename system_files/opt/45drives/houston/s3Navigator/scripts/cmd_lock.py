from datetime import datetime, timedelta, timezone
import json
import re
import sys
from typing import Any, Dict, List
from utils import cfg_path, get_flag_value, make_client, read_json
from botocore.exceptions import ClientError # type: ignore

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})"
    r"(\.\d+)?"
    r"(Z|[+-]\d{2}:\d{2})?$"
)


def parse_iso8601_to_datetime(value: str) -> datetime:
    if value is None:
        raise ValueError("retain-until is required")
    s = str(value).strip()
    m = _ISO_RE.match(s) # type: ignore
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

  except ClientError as e: # type: ignore
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
  
