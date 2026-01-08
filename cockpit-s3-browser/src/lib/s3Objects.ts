import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

// @ts-ignore
import s3browser_cli_script from "../scripts/s3browser-cli.py?raw";
import { ListObjectsCliResult, ListObjectsResponse } from "../types";

function safeJsonParse<T>(raw: string): ResultAsync<T, SyntaxError> {
  try {
    return okAsync(JSON.parse(raw) as T);
  } catch (e: any) {
    return errAsync(e instanceof SyntaxError ? e : new SyntaxError(String(e)));
  }
}

function pyCmd(args: string[], superuser: "try" | "require" = "try") {
  return new Command(
    ["/usr/bin/env", "python3", "-c", s3browser_cli_script, ...args],
    { superuser }
  );
}


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
    String(params.maxKeys ?? 200),
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
