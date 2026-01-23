# s3browser.py
import sys

from cmd_list import cmd_list_buckets, cmd_list_objects
from cmd_object import cmd_download_object, cmd_copy_object, cmd_rename_object, cmd_delete_object, cmd_upload_stdin, cmd_stat_object
from cmd_version import cmd_list_object_versions, cmd_delete_object_version, cmd_rollback_object_version
from cmd_tag import cmd_put_object_tags, cmd_get_object_tags
from cmd_lock import cmd_get_object_legal_hold, cmd_put_object_legal_hold, cmd_get_object_retention, cmd_put_object_retention, cmd_get_bucket_object_lock
from download_job import cmd_download_job_status, cmd_cancel_download_job
from cmd_prefix import cmd_copy_prefix, cmd_delete_prefix, cmd_download_prefix_targz, cmd_move_prefix
from cmd_storage_class import cmd_change_storage_class
from utils import BINARY_STDOUT_CMDS, _emit_json_stderr, _emit_json_stdout, _emit_ndjson, _format_err, _wants_ndjson, get_flag_value
from cmd_version import cmd_delete_object_version, cmd_download_object_version,cmd_list_object_versions,cmd_rollback_object_version



def main() -> None:
  cmd = None
  try:
    if len(sys.argv) < 2:
      raise ValueError("Usage: s3browser-cli <command> ...")

    cmd = sys.argv[1]

    # ---- your existing dispatch exactly as-is, but WITHOUT the final raises ----
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
        raise ValueError("Usage: s3browser-cli put-object-tags <connectionId> <bucket> <key> [--version-id VID] [--tag k=v ...] [--tags-json JSON]")
      cmd_put_object_tags(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
      return


    if cmd == "get-object-tags":
      if len(sys.argv) < 5:
        raise ValueError("Usage: s3browser-cli get-object-tags <connectionId> <bucket> <key> [--version-id VID]")
      cmd_get_object_tags(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
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

    # Unknown command -> convert to JSON error instead of raising
    raise ValueError("Unknown command")

  except BaseException as e:
    # cmd may be None if failure happens before parsing
    c = cmd or ""

    msg = _format_err(e)

    # For binary stdout commands, never write to stdout
    if c in BINARY_STDOUT_CMDS:
      _emit_json_stderr({"type": "result", "ok": False, "error": msg})
      raise SystemExit(1)

    # For NDJSON commands, emit a final result line
    if _wants_ndjson(c, sys.argv[2:]):
      _emit_ndjson({"type": "result", "ok": False, "error": msg})
      raise SystemExit(0)

    # Default: one-shot JSON on stdout
    _emit_json_stdout({"ok": False, "error": msg})
    raise SystemExit(0)

if __name__ == "__main__":
    main()
