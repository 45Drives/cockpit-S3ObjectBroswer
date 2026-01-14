import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

// @ts-ignore
// import s3browser_cli_script from "../scripts/s3browser-cli.py?raw";
import { ListObjectsCliResult, ListObjectsResponse, PresignGetCliResult } from "../types";

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

const S3BROWSER_CLI_PATH = "/conn.py";

export function listObjects(params: {
connectionId: string;
bucket: string;
prefix?: string;
delimiter?: string | null; // "/" for folder view, null/"" for flat view
continuationToken?: string | null;
maxKeys?: number;
}): ResultAsync<ListObjectsResponse, ProcessError | SyntaxError> {
  const args: string[] = [
    "list-objects",
    params.connectionId,
    params.bucket,
    "--prefix",
    params.prefix ?? "",
    "--max-keys",
    String(params.maxKeys ?? 1000),
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
      if (!res.ok) return errAsync(new SyntaxError(res.error || "Failed to list objects"));

      return okAsync({
        prefix: res.prefix ?? (params.prefix ?? ""),
        commonPrefixes: Array.isArray(res.commonPrefixes) ? res.commonPrefixes : [],
        contents: Array.isArray(res.contents) ? res.contents : [],
        isTruncated: Boolean(res.isTruncated),
        nextContinuationToken: res.nextContinuationToken ?? null,
      });
    });
}


export function presignGetObject(params: {
  connectionId: string;
  bucket: string;
  key: string;
  expiresSeconds?: number; // default 900
}): ResultAsync<{ url: string; expiresIn: number }, ProcessError | SyntaxError> {
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
        console.log("download ", res)
      if (!res.ok) return errAsync(new SyntaxError(res.error || "Failed to presign download URL"));
      return okAsync({ url: res.url, expiresIn: res.expiresIn });
    });
}


export function deleteObject(params: {
    connectionId: string;
    bucket: string;
    key: string;
  }): ResultAsync<void, ProcessError | SyntaxError> {
    const args: string[] = ["delete-object", params.connectionId, params.bucket, params.key];
  
    return server
      .execute(pyCmd(args, "try"))
      .map((proc) => proc.getStdout().trim())
      .andThen((stdout) => safeJsonParse<{ ok: boolean; error?: string }>(stdout))
      .andThen((res) => {
        if (!res.ok) return errAsync(new SyntaxError(res.error || "Failed to delete object"));
        return okAsync(undefined);
      });
  }
  
  type DeletePrefixEvent =
  | { type: "start"; ok: boolean; prefix?: string }
  | { type: "progress"; ok: boolean; deletedRequested?: number; errors?: number }
  | { type: "result"; ok: boolean; deletedRequested?: number; errors?: number; error?: string };

  export function deletePrefixStreamed(params: {
    connectionId: string;
    bucket: string;
    prefix: string;
    onEvent: (ev: DeletePrefixEvent) => void;
  }): ResultAsync<{ deletedRequested: number; errors: number }, ProcessError | SyntaxError> {
    const args: string[] = ["delete-prefix", params.connectionId, params.bucket, params.prefix];
  
    // Spawn so we can stream output as it arrives
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
          const obj = JSON.parse(line) as any;
        
          if (obj && typeof obj === "object") {
            if ("type" in obj) {
              params.onEvent(obj as DeletePrefixEvent);
            } else if (obj.ok === false) {
              params.onEvent({ type: "result", ok: false, error: String(obj.error ?? "Failed") });
            }
          }
        } catch {
          // ignore parse errors from partial / non-JSON lines
        }
      }
    });
  
    // Wait for exit, then parse the last line to produce a final ResultAsync
    return proc.wait(true).andThen((exited: any) => {
      const stdout = String(exited.getStdout?.() ?? "").trim();
      const last = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() ?? "";
  
      return safeJsonParse<any>(last).andThen((obj) => {
        // NDJSON protocol final message
        if (obj && obj.type === "result") {
          if (!obj.ok) return errAsync(new SyntaxError(obj.error || "Failed to delete prefix"));
          return okAsync({
            deletedRequested: Number(obj.deletedRequested ?? 0),
            errors: Number(obj.errors ?? 0),
          });
        }
  
        // Legacy one-shot protocol fallback (if python hasn't been updated yet)
        if (obj && typeof obj.ok === "boolean") {
          if (!obj.ok) return errAsync(new SyntaxError(obj.error || "Failed to delete prefix"));
          return okAsync({
            deletedRequested: Number(obj.deletedRequested ?? obj.deleted ?? 0),
            errors: Number(obj.errors ?? 0),
          });
        }
  
        return errAsync(new SyntaxError("Malformed delete-prefix output"));
      });
    });
  }  

  type RenameObjectEvent =
  | { type: "start"; ok: boolean; src?: string; dst?: string; size?: number; totalParts?: number; partSize?: number; concurrency?: number }
  | { type: "progress"; ok: boolean; partsDone?: number; totalParts?: number; bytesCopied?: number; size?: number }
  | { type: "result"; ok: boolean; src?: string; dst?: string; size?: number; error?: string };

export function renameObjectStreamed(params: {
  connectionId: string;
  bucket: string;
  srcKey: string;
  dstKey: string;
  concurrency?: number;
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
      if (!finalResult.ok) return errAsync(new SyntaxError(finalResult.error || "Failed to rename object"));
      return okAsync(undefined);
    }
    return errAsync(new SyntaxError("Rename did not return a final result message"));
  });

  const cancel = () => {
    try {
      (proc as any).kill?.("SIGTERM");
      (proc as any).terminate?.();
      (proc as any).signal?.("SIGTERM");
    } catch {
      // ignore
    }
  };

  return { run, cancel };
}


export type UploadStdinEvent =
  | { type: "start"; ok: boolean; bucket?: string; key?: string; size?: number; contentType?: string; multipart?: boolean }
  | { type: "mpu"; ok: boolean; uploadId?: string; partSize?: number; totalParts?: number }
  | { type: "progress"; ok: boolean; bytesRead?: number; size?: number }
  | { type: "part"; ok: boolean; partNumber?: number; partsDone?: number; totalParts?: number }
  | { type: "result"; ok: boolean; bucket?: string; key?: string; size?: number; error?: string };

export type UploadStdinJob = {
  writeChunk: (chunk: Uint8Array) => void;
  end: () => void;
  cancel: () => void;
  run: ResultAsync<void, ProcessError | SyntaxError>;
};

export function uploadObjectFromStdinStreamed(params: {
  connectionId: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
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
          final = { type: "result", ok: false, error: String(obj.error ?? "Upload failed") };
          params.onEvent(final as UploadStdinEvent);
        }
      } catch {
        // ignore non-JSON / partial
      }
    }
  });

  const run: ResultAsync<void, ProcessError | SyntaxError> = proc.wait(true).andThen(() => {
    if (final && final.type === "result") {
      if (!final.ok) return errAsync(new SyntaxError(final.error || "Upload failed"));
      return okAsync(undefined);
    }
    return errAsync(new SyntaxError("Upload did not return a final result message"));
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
      (proc as any).kill?.("SIGTERM");
      return;
    } catch {}
    try {
      (proc as any).terminate?.();
      return;
    } catch {}
  };

  return { writeChunk, end, cancel, run };
}


export function downloadPrefixTarGz(params: {
  connectionId: string;
  bucket: string;
  prefix: string; // folder prefix like "photos/2025/" (or "photos/2025")
  filename?: string; // optional override
  stripComponents?: number; // optional, if you implemented it in python
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
  ];

  if (typeof params.stripComponents === "number") {
    args.push("--strip-components", String(params.stripComponents));
  }
  const cmd = pyCmd(args, "try");
  console.log("[download-prefix] argv:", cmd);
  // This triggers a browser download via Cockpit channel
  return okAsync(undefined).map(() => {
    server.downloadCommandOutput(pyCmd(args, "try"), filename);
  });

}
