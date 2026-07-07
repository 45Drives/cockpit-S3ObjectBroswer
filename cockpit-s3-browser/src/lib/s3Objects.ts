import { Command, server } from "@45drives/houston-common-lib";
import { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

// @ts-ignore
// import s3browser_cli_script from "../scripts/s3browser-cli.py?raw";
import {
  DeletePrefixEvent,
  GetObjectVersionsCliResult,
  ListObjectsCliResult,
  ListObjectsResponse,
  ObjectVersionItem,
  PresignGetCliResult,
  RenameObjectEvent,
  TagKV,
  TagMap,
  UploadStdinEvent,
} from "../types";

 type UploadStdinJob = {
  writeChunk: (chunk: Uint8Array) => void;
  end: () => void;
  cancel: () => void;
  run: ResultAsync<void, ProcessError | SyntaxError>;
};
function safeJsonParse<T>(raw: string): ResultAsync<T, SyntaxError> {
  try {
    return okAsync(JSON.parse(raw) as T);
  } catch (e: any) {
    return errAsync(e instanceof SyntaxError ? e : new SyntaxError(String(e)));
  }
}

function pyCmd(args: string[], superuser: "try" | "require" = "try") {
  return new Command(
    ["/usr/bin/env", "python3", "-u", S3BROWSER_CLI_PATH, ...args],
    { superuser }
  );
}

const S3BROWSER_CLI_PATH = "/opt/45drives/houston/s3Navigator/scripts/main.py";

export function listObjects(params: {
  connectionId: string;
  bucket: string;
  prefix?: string;
  delimiter?: string | null; // "/" for folder view, null/"" for flat view
  continuationToken?: string | null;
}): ResultAsync<ListObjectsResponse, ProcessError | SyntaxError> {
  const args: string[] = [
    "list-objects",
    params.connectionId,
    params.bucket,
    "--prefix",
    params.prefix ?? "",

  ];

  if (params.delimiter) {
    args.push("--delimiter", params.delimiter);
  }

  if (params.continuationToken) {
    args.push("--continuation-token", params.continuationToken);
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<ListObjectsCliResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Failed to list objects"));

      return okAsync({
        prefix: res.prefix ?? params.prefix ?? "",
        commonPrefixes: Array.isArray(res.commonPrefixes)
          ? res.commonPrefixes
          : [],
        contents: Array.isArray(res.contents) ? res.contents : [],
        isTruncated: Boolean(res.isTruncated),
        nextContinuationToken: res.nextContinuationToken ?? null,
      });
    });
}

//this function it to generate presigned urls for downloading objects
export function presignGetObject(params: {
  connectionId: string;
  bucket: string;
  key: string;
  expiresSeconds?: number; // default 900
}): ResultAsync<
  { url: string; expiresIn: number },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "presign-get",
    params.connectionId,
    params.bucket,
    params.key,
    "--expires",
    String(params.expiresSeconds ?? 900),
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<PresignGetCliResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to presign download URL")
        );
      return okAsync({ url: res.url, expiresIn: res.expiresIn });
    });
}

export function deleteObject(params: {
  connectionId: string;
  bucket: string;
  key: string;
}): ResultAsync<void, ProcessError | SyntaxError> {
  const args: string[] = [
    "delete-object",
    params.connectionId,
    params.bucket,
    params.key,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<{ ok: boolean; error?: string }>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to delete object")
        );
      return okAsync(undefined);
    });
}

export function deletePrefixStreamed(params: {
  connectionId: string;
  bucket: string;
  prefix: string;
  onEvent: (ev: DeletePrefixEvent) => void;
}): ResultAsync<
  { deletedRequested: number; errors: number },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "delete-prefix",
    params.connectionId,
    params.bucket,
    params.prefix,
  ];

  // Spawn the process
  const proc = server.spawnProcess(pyCmd(args, "try"));

  // NDJSON line buffer
  let buf = "";

  proc.stream((chunk) => {
    buf += chunk;

    while (true) {
      const i = buf.indexOf("\n");
      if (i < 0) break;

      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;

      try {
        // Check for empty or invalid response
        if (line.trim() === "") {
          console.error("Received empty response.");
          return; // Handle empty response
        }

        const obj = JSON.parse(line) as any;

        if (obj && typeof obj === "object") {
          if ("type" in obj) {
            params.onEvent(obj as DeletePrefixEvent);
          } else if (obj.ok === false) {
            params.onEvent({
              type: "result",
              ok: false,
              error: String(obj.error ?? "Failed"),
            });
          }
        }
      } catch (e) {
        console.error("Error parsing JSON:", e, "Line content:", line); // Log error and line for debugging
      }
    }
  });

  // Wait for the process to complete
  return proc.wait(true).andThen((exited: any) => {
    const stdout = String(exited.getStdout?.() ?? "").trim();

    // Handle case where stdout is empty
    if (stdout === "") {
      console.log("No output received. Treating as completed.");
      return okAsync({ deletedRequested: 0, errors: 0 }); // Treat as completed successfully
    }

    const last =
      stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() ?? "";

    console.log("Raw stdout:", stdout); // Log stdout for debugging

    return safeJsonParse<any>(last).andThen((obj) => {
      // Check for result type message
      if (obj && obj.type === "result") {
        if (!obj.ok)
          return errAsync(
            new SyntaxError(obj.error || "Failed to delete prefix")
          );
        return okAsync({
          deletedRequested: Number(obj.deletedRequested ?? 0),
          errors: Number(obj.errors ?? 0),
        });
      }

      // Legacy one-shot protocol fallback (if python hasn't been updated yet)
      if (obj && typeof obj.ok === "boolean") {
        if (!obj.ok)
          return errAsync(
            new SyntaxError(obj.error || "Failed to delete prefix")
          );
        return okAsync({
          deletedRequested: Number(obj.deletedRequested ?? obj.deleted ?? 0),
          errors: Number(obj.errors ?? 0),
        });
      }

      return errAsync(new SyntaxError("Malformed delete-prefix output"));
    });
  });
}



export function renameObjectStreamed(params: {
  connectionId: string;
  bucket: string;
  srcKey: string;
  dstKey: string;
  concurrency?: number;
  sse?: string;
  sseKmsKeyId?: string;
  onEvent: (ev: RenameObjectEvent) => void;
}): { run: ResultAsync<void, ProcessError | SyntaxError>; cancel: () => void } {
  const args: string[] = [
    "rename-object",
    params.connectionId,
    params.bucket,
    params.srcKey,
    params.dstKey,
    "--stream",
    "--concurrency",
    String(params.concurrency ?? 6),
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  const proc = server.spawnProcess(pyCmd(args, "try"));

  let buf = "";
  let finalResult: any = null;

  proc.stream((chunk) => {
    buf += chunk;

    while (true) {
      const i = buf.indexOf("\n");
      if (i < 0) break;

      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;

      try {
        const obj = JSON.parse(line) as any;
        if (obj && typeof obj === "object" && typeof obj.type === "string") {
          params.onEvent(obj as RenameObjectEvent);
          if (obj.type === "result") finalResult = obj;
        }
      } catch {
        // ignore
      }
    }
  });

  const run = proc.wait(true).andThen(() => {
    if (finalResult && finalResult.type === "result") {
      if (!finalResult.ok)
        return errAsync(
          new SyntaxError(finalResult.error || "Failed to rename object")
        );
      return okAsync(undefined);
    }
    return errAsync(
      new SyntaxError("Rename did not return a final result message")
    );
  });

  const cancel = () => {
    try {
      (proc as any).kill?.("SIGTERM");
    } catch {}
    try {
      (proc as any).terminate?.();
    } catch {}
    try {
      (proc as any).signal?.("SIGTERM");
    } catch {}

    window.setTimeout(() => {
      try {
        (proc as any).kill?.("SIGKILL");
      } catch {}
    }, 500);
  };

  return { run, cancel };
}


export function uploadObjectFromStdinStreamed(params: {
  connectionId: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  sse?: string;
  sseKmsKeyId?: string;
  onEvent: (ev: UploadStdinEvent) => void;
}): UploadStdinJob {
  const args: string[] = [
    "upload-stdin",
    params.connectionId,
    params.bucket,
    params.key,
    "--size",
    String(params.size),
    "--content-type",
    params.contentType || "application/octet-stream",
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  const proc = server.spawnProcess(pyCmd(args, "try"));

  let buf = "";
  let final: any = null;

  proc.stream((chunk: string) => {
    buf += chunk;

    while (true) {
      const i = buf.indexOf("\n");
      if (i < 0) break;

      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);

      if (!line) continue;

      try {
        const obj = JSON.parse(line) as any;
        if (obj && typeof obj === "object" && typeof obj.type === "string") {
          params.onEvent(obj as UploadStdinEvent);
          if (obj.type === "result") final = obj;
        } else if (obj && obj.ok === false) {
          // fallback / crash-style message
          final = {
            type: "result",
            ok: false,
            error: String(obj.error ?? "Upload failed"),
          };
          params.onEvent(final as UploadStdinEvent);
        }
      } catch {
        // ignore non-JSON / partial
      }
    }
  });

  const run: ResultAsync<void, ProcessError | SyntaxError> = proc
    .wait(true)
    .andThen(() => {
      if (final && final.type === "result") {
        if (!final.ok)
          return errAsync(new SyntaxError(final.error || "Upload failed"));
        return okAsync(undefined);
      }
      return errAsync(
        new SyntaxError("Upload did not return a final result message")
      );
    });

  const writeChunk = (chunk: Uint8Array) => {
    // IMPORTANT: stream=true to keep stdin open
    proc.write(chunk, true);
  };

  const end = () => {
    try {
      (proc as any).closeStdin?.();
      return;
    } catch {}
    try {
      (proc as any).end?.();
      return;
    } catch {}
  };

  const cancel = () => {
    try {
      (proc as any).closeStdin?.();
    } catch {}
    try {
      (proc as any).end?.();
    } catch {}

    try {
      (proc as any).kill?.("SIGTERM");
    } catch {}
    try {
      (proc as any).terminate?.();
    } catch {}
    try {
      (proc as any).signal?.("SIGTERM");
    } catch {}

    window.setTimeout(() => {
      try {
        (proc as any).kill?.("SIGKILL");
      } catch {}
    }, 500);
  };

  return { writeChunk, end, cancel, run };
}

export function downloadPrefixTarGz(params: {
  connectionId: string;
  bucket: string;
  prefix: string;
  filename?: string;
  stripComponents?: number;
  jobId: string;
}): ResultAsync<void, ProcessError> {
  const p = (params.prefix || "").replace(/^\/+/, "");
  const normalized = p === "" ? "" : p.endsWith("/") ? p : p + "/";

  const filename =
    params.filename ||
    (normalized
      ? `${normalized.replace(/\/$/, "").split("/").pop() || "folder"}.tar.gz`
      : "bucket.tar.gz");

  const args: string[] = [
    "download-prefix-targz",
    params.connectionId,
    params.bucket,
    normalized,
    "--job-id",
    params.jobId,
  ];

  if (typeof params.stripComponents === "number") {
    args.push("--strip-components", String(params.stripComponents));
  }

  return okAsync(undefined).map(() => {
    server.downloadCommandOutputSelfUrl(pyCmd(args, "try"), filename);
  });
}

export function downloadObject(params: {
  connectionId: string;
  bucket: string;
  key: string;
  filename?: string;
  jobId: string;
}): ResultAsync<void, ProcessError> {
  const filename = params.filename || params.key.split("/").pop() || "download";

  const args: string[] = [
    "download-object",
    params.connectionId,
    params.bucket,
    params.key,
    "--job-id",
    params.jobId,
  ];

  return okAsync(undefined).map(() => {
    server.downloadCommandOutputSelfUrl(pyCmd(args, "try"), filename);
  });
}

export function getDownloadJobStatus(params: {
  jobId: string;
}): ResultAsync<any, ProcessError | SyntaxError> {
  const args: string[] = ["download-job-status", params.jobId];

  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<any>(stdout))
    .andThen((res) => {
      if (!res || res.ok === false) {
        return errAsync(
          new SyntaxError(res?.error || "Failed to read job status")
        );
      }
      return okAsync(res);
    });
}

export function copyObject(params: {
  connectionId: string;
  srcBucket: string;
  srcKey: string;
  dstBucket: string;
  dstKey: string;
  jobId: string;
  concurrency?: number;
  sse?: string;
  sseKmsKeyId?: string;
}): ResultAsync<void, ProcessError | SyntaxError> {
  const conc = params.concurrency ?? 6;

  const args: string[] = [
    "copy-object",
    params.connectionId,
    params.srcBucket,
    params.srcKey,
    params.dstBucket,
    params.dstKey,
    "--job-id",
    params.jobId,
    "--concurrency",
    String(conc),
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<{ ok: boolean; error?: string }>(s))
    .andThen((res) =>
      res.ok
        ? okAsync(undefined)
        : errAsync(new SyntaxError(res.error || "Copy failed"))
    );
}

export function copyPrefix(params: {
  connectionId: string;
  srcBucket: string;
  srcPrefix: string;
  dstBucket: string;
  dstPrefix: string;
  jobId: string;
  concurrency?: number;
  sse?: string;
  sseKmsKeyId?: string;
}): ResultAsync<void, ProcessError | SyntaxError> {
  const conc = params.concurrency ?? 6;

  const args: string[] = [
    "copy-prefix",
    params.connectionId,
    params.srcBucket,
    params.srcPrefix,
    params.dstBucket,
    params.dstPrefix,
    "--job-id",
    params.jobId,
    "--concurrency",
    String(conc),
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<{ ok: boolean; error?: string }>(s))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Copy prefix failed"));
      return okAsync(undefined);
    });
}

export function movePrefix(params: {
  connectionId: string;
  srcBucket: string;
  srcPrefix: string;
  dstBucket: string;
  dstPrefix: string;
  jobId: string;
  concurrency?: number;
  sse?: string;
  sseKmsKeyId?: string;
}): ResultAsync<void, ProcessError | SyntaxError> {
  const conc = params.concurrency ?? 6;

  const args: string[] = [
    "move-prefix",
    params.connectionId,
    params.srcBucket,
    params.srcPrefix,
    params.dstBucket,
    params.dstPrefix,
    "--job-id",
    params.jobId,
    "--concurrency",
    String(conc),
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<{ ok: boolean; error?: string }>(s))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Move prefix failed"));
      return okAsync(undefined);
    });
}

export function statObject(params: {
  connectionId: string;
  bucket: string;
  key: string;
}): ResultAsync<
  {
    key: string;
    size: number;
    lastModified: string | null;
    storageClass: string | null;
    etag: string | null;

    // new
    contentType: string | null;
    taggingCount: number | null;
    metadata: Record<string, string>;

    // encryption
    serverSideEncryption: string | null;
    sseKmsKeyId: string | null;
    bucketKeyEnabled: boolean;
  },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "stat-object",
    params.connectionId,
    params.bucket,
    params.key,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) =>
      safeJsonParse<{
        ok: boolean;
        key?: string;
        size?: number;
        lastModified?: string | null;
        storageClass?: string | null;
        etag?: string | null;

        // new
        contentType?: string | null;
        taggingCount?: number | null;
        metadata?: Record<string, string> | null;

        // encryption
        serverSideEncryption?: string | null;
        sseKmsKeyId?: string | null;
        bucketKeyEnabled?: boolean;

        error?: string;
      }>(s)
    )
    .andThen((res) => {
      if (!res.ok) return errAsync(new SyntaxError(res.error || "Stat failed"));

      const md = res.metadata;
      const metadata: Record<string, string> =
        md && typeof md === "object" && !Array.isArray(md)
          ? (md as Record<string, string>)
          : {};

      const tcRaw = res.taggingCount;
      const taggingCount =
        typeof tcRaw === "number" && Number.isFinite(tcRaw)
          ? tcRaw
          : tcRaw == null
            ? null
            : Number(tcRaw);

      return okAsync({
        key: String(res.key || params.key),
        size: Number(res.size ?? 0),
        lastModified: (res.lastModified ?? null) as string | null,
        storageClass: (res.storageClass ?? null) as string | null,
        etag: (res.etag ?? null) as string | null,

        contentType: (res.contentType ?? null) as string | null,
        taggingCount: Number.isFinite(taggingCount as number)
          ? (taggingCount as number)
          : null,
        metadata,

        serverSideEncryption: (res.serverSideEncryption ?? null) as string | null,
        sseKmsKeyId: (res.sseKmsKeyId ?? null) as string | null,
        bucketKeyEnabled: Boolean(res.bucketKeyEnabled),
      });
    });
}

export function getObjectTags(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId?: string | null;
}): ResultAsync<{ tags: TagKV[] }, ProcessError | SyntaxError> {
  const args: string[] = [
    "get-object-tags",
    params.connectionId,
    params.bucket,
    params.key,
  ];

  if (params.versionId) {
    args.push("--version-id", String(params.versionId));
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false) {
        return okAsync({ tags: [] });
      }

      const raw = Array.isArray(res.tags) ? res.tags : [];

      const tags: TagKV[] = raw
        .map((t: any) => ({
          key: String(t?.key ?? t?.Key ?? "").trim(),
          value: String(t?.value ?? t?.Value ?? ""),
        }))
        .filter((t) => !!t.key);

      return okAsync({ tags });
    });
}

export function putObjectTags(params: {
  connectionId: string;
  bucket: string;
  key: string;
  tags: TagMap;
  versionId?: string | null;
}): ResultAsync<
  { bucket: string; key: string; tags: TagKV[] },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "put-object-tags",
    params.connectionId,
    params.bucket,
    params.key,
    "--tags-json",
    JSON.stringify(params.tags ?? {}),
  ];

  if (params.versionId) {
    args.push("--version-id", String(params.versionId));
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false) {
        return errAsync(new SyntaxError(res?.error || "Failed to apply tags"));
      }

      const raw = Array.isArray(res.tags) ? res.tags : [];
      const tags: TagKV[] = raw
        .map((t: any) => ({
          key: String(t?.key ?? t?.Key ?? "").trim(),
          value: String(t?.value ?? t?.Value ?? ""),
        }))
        .filter((t) => !!t.key);

      return okAsync({
        bucket: String(res.bucket ?? params.bucket),
        key: String(res.key ?? params.key),
        tags,
      });
    });
}

function lastNonEmptyLine(s: string): string {
  const lines = String(s ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function changeStorageClass(params: {
  connectionId: string;
  bucket: string;
  key: string;
  storageClass: string;
  concurrency?: number;
  force?: boolean;
  sse?: string;
  sseKmsKeyId?: string;
}): ResultAsync<{ storageClass: string | null }, ProcessError | SyntaxError> {
  const args: string[] = [
    "change-storage-class",
    params.connectionId,
    params.bucket,
    params.key,
    "--storage-class",
    params.storageClass,
  ];

  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  if (params.concurrency != null)
    args.push("--concurrency", String(params.concurrency));
  if (params.force) args.push("--force", "1");

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => lastNonEmptyLine(p.getStdout()))
    .andThen((s) =>
      safeJsonParse<{
        ok: boolean;
        storageClass?: string | null;
        requestedStorageClass?: string;
        error?: string;
      }>(s)
    )
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to change storage class")
        );
      return okAsync({
        storageClass: (res.storageClass ?? null) as string | null,
      });
    });
}

export function cancelDownloadJob(params: {
  jobId: string;
}): ResultAsync<void, ProcessError | SyntaxError> {
  const args: string[] = ["cancel-download-job", params.jobId];

  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<{ ok: boolean; error?: string }>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to cancel download job")
        );
      return okAsync(undefined);
    });
}

export function getObjectVersions(params: {
  connectionId: string;
  bucket: string;
  key: string;
}): ResultAsync<{ versions: ObjectVersionItem[] }, ProcessError | SyntaxError> {
  const args: string[] = [
    "list-object-versions",
    params.connectionId,
    params.bucket,
    params.key,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<GetObjectVersionsCliResult>(s))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to list object versions")
        );

      const raw = Array.isArray(res.versions) ? res.versions : [];

      const versions: ObjectVersionItem[] = raw.map((v) => ({
        key: String(v.key ?? params.key),
        versionId: v.versionId != null ? String(v.versionId) : null,
        isLatest: Boolean(v.isLatest),
        lastModified: (v.lastModified ?? null) as string | null,
        size: Number(v.size ?? 0),
        etag: v.etag != null ? String(v.etag) : null,
      }));

      return okAsync({ versions });
    });
}

export function deleteObjectVersion(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId: string;
}): ResultAsync<
  { bucket: string; key: string; versionId: string },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "delete-object-version",
    params.connectionId,
    params.bucket,
    params.key,
    params.versionId,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) =>
      safeJsonParse<{
        ok: boolean;
        bucket?: string;
        key?: string;
        versionId?: string;
        error?: string;
      }>(s)
    )
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to delete version")
        );
      return okAsync({
        bucket: String(res.bucket ?? params.bucket),
        key: String(res.key ?? params.key),
        versionId: String(res.versionId ?? params.versionId),
      });
    });
}

export function rollbackObjectVersion(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId: string;
}): ResultAsync<
  { bucket: string; key: string; fromVersionId: string },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "rollback-object-version",
    params.connectionId,
    params.bucket,
    params.key,
    params.versionId,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) =>
      safeJsonParse<{
        ok: boolean;
        bucket?: string;
        key?: string;
        fromVersionId?: string;
        error?: string;
      }>(s)
    )
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to rollback version")
        );
      return okAsync({
        bucket: String(res.bucket ?? params.bucket),
        key: String(res.key ?? params.key),
        fromVersionId: String(res.fromVersionId ?? params.versionId),
      });
    });
}

export function downloadObjectVersion(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId: string;
  filename?: string;
  jobId: string;
}): ResultAsync<void, ProcessError> {
  const base = params.filename || params.key.split("/").pop() || "download";
  const safeVid = (params.versionId || "").slice(0, 8) || "version";
  const filename = `${base}.v-${safeVid}`;

  const args: string[] = [
    "download-object-version",
    params.connectionId,
    params.bucket,
    params.key,
    params.versionId,
    "--job-id",
    params.jobId,
  ];

  return okAsync(undefined).map(() => {
    server.downloadCommandOutputSelfUrl(pyCmd(args, "try"), filename);
  });
}

export function getBucketObjectLock(params: {
  connectionId: string;
  bucket: string;
}): ResultAsync<
  {
    supported: boolean;
    enabled: boolean;
    reason?: string;
    defaultRetention?: { mode?: string; days?: number; years?: number };
  },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "get-bucket-object-lock",
    params.connectionId,
    params.bucket,
  ];

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false)
        return errAsync(
          new SyntaxError(res?.error || "Failed to get bucket object lock")
        );
      return okAsync({
        supported: Boolean(res.supported),
        enabled: Boolean(res.enabled),
        reason: res.reason != null ? String(res.reason) : undefined,
        defaultRetention: res.defaultRetention
          ? {
              mode:
                res.defaultRetention.mode != null
                  ? String(res.defaultRetention.mode)
                  : undefined,
              days:
                res.defaultRetention.days != null
                  ? Number(res.defaultRetention.days)
                  : undefined,
              years:
                res.defaultRetention.years != null
                  ? Number(res.defaultRetention.years)
                  : undefined,
            }
          : undefined,
      });
    });
}

type LegalHoldStatus = "ON" | "OFF";
function isLegalHoldStatus(x: unknown): x is LegalHoldStatus {
  return x === "ON" || x === "OFF";
}

export function getObjectLegalHold(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId?: string | null;
}): ResultAsync<
  { status: LegalHoldStatus | null },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "get-object-legal-hold",
    params.connectionId,
    params.bucket,
    params.key,
  ];
  if (params.versionId) args.push("--version-id", String(params.versionId));

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false)
        return errAsync(
          new SyntaxError(res?.error || "Failed to get legal hold")
        );

      const raw = res.status;
      const status = isLegalHoldStatus(raw) ? raw : null;

      return okAsync({ status });
    });
}

export function getObjectRetention(params: {
  connectionId: string;
  bucket: string;
  key: string;
  versionId?: string | null;
}): ResultAsync<
  { mode: string | null; retainUntil: string | null },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "get-object-retention",
    params.connectionId,
    params.bucket,
    params.key,
  ];
  if (params.versionId) args.push("--version-id", String(params.versionId));

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false)
        return errAsync(
          new SyntaxError(res?.error || "Failed to get retention")
        );
      return okAsync({
        mode: res.mode != null ? String(res.mode) : null,
        retainUntil: (res.retainUntil ?? null) as string | null,
      });
    });
}

export function putObjectLegalHold(params: {
  connectionId: string;
  bucket: string;
  key: string;
  status: LegalHoldStatus; // "ON" | "OFF"
  versionId?: string | null;
}): ResultAsync<{ status: LegalHoldStatus }, ProcessError | SyntaxError> {
  const args: string[] = [
    "put-object-legal-hold",
    params.connectionId,
    params.bucket,
    params.key,
    "--status",
    params.status,
  ];
  if (params.versionId) args.push("--version-id", String(params.versionId));

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false)
        return errAsync(
          new SyntaxError(res?.error || "Failed to set legal hold")
        );

      const raw = res.status;
      const status = isLegalHoldStatus(raw) ? raw : null;
      if (!status)
        return errAsync(new SyntaxError("Invalid legal hold status from CLI"));

      return okAsync({ status });
    });
}

export type RetentionMode = "GOVERNANCE" | "COMPLIANCE";

function isRetentionMode(v: any): v is RetentionMode {
  return v === "GOVERNANCE" || v === "COMPLIANCE";
}

export function putObjectRetention(params: {
  connectionId: string;
  bucket: string;
  key: string;
  mode: RetentionMode;
  retainUntil: string; // ISO timestamp
  bypassGovernance?: boolean;
  versionId?: string | null;
}): ResultAsync<
  { mode: RetentionMode; retainUntil: string; bypassGovernance: boolean },
  ProcessError | SyntaxError
> {
  const args: string[] = [
    "put-object-retention",
    params.connectionId,
    params.bucket,
    params.key,
    "--mode",
    params.mode,
    "--retain-until",
    params.retainUntil,
  ];
  if (params.versionId) args.push("--version-id", String(params.versionId));
  if (params.bypassGovernance) args.push("--bypass-governance", "1");

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) => safeJsonParse<any>(s))
    .andThen((res) => {
      if (!res || res.ok === false)
        return errAsync(
          new SyntaxError(res?.error || "Failed to set retention")
        );

      const rawMode = res.mode;
      const mode = isRetentionMode(rawMode) ? rawMode : null;
      if (!mode)
        return errAsync(new SyntaxError("Invalid retention mode from CLI"));

      const retainUntil =
        res.retainUntil != null ? String(res.retainUntil) : null;
      if (!retainUntil)
        return errAsync(new SyntaxError("Missing retainUntil from CLI"));

      const bypassGovernance = Boolean(res.bypassGovernance);

      return okAsync({ mode, retainUntil, bypassGovernance });
    });
}
export function createFolder(params: {
  connectionId: string;
  bucket: string;
  prefix: string; // current prefix ("" or "photos/2025/")
  name: string;   // folder name (already validated/sanitized by UI)
  sse?: string;
  sseKmsKeyId?: string;
}): ResultAsync<{ prefix: string }, ProcessError | SyntaxError> {
  const args: string[] = [
    "create-folder",
    params.connectionId,
    params.bucket,
    params.prefix || "",
    params.name,
  ];
  if (params.sse && params.sse !== "none") {
    args.push("--sse", params.sse);
    if (params.sseKmsKeyId) args.push("--sse-kms-key-id", params.sseKmsKeyId);
  }

  return server
    .execute(pyCmd(args, "try"))
    .map((p) => p.getStdout().trim())
    .andThen((s) =>
      safeJsonParse<{ ok: boolean; prefix?: string; error?: string }>(s)
    )
    .andThen((res) => {
      if (!res.ok)
        return errAsync(
          new SyntaxError(res.error || "Failed to create folder")
        );

      // Python returns the full folder prefix (ending with "/")
      return okAsync({
        prefix: String(res.prefix ?? ""),
      });
    });
}

