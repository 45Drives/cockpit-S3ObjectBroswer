import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

import type { BucketSummary } from "../types";

// @ts-ignore
import s3browser_cli_script from "../scripts/s3browser-cli.py?raw";

function safeJsonParse<T>(raw: string): ResultAsync<T, SyntaxError> {
  try {
    return okAsync(JSON.parse(raw) as T);
  } catch (e: any) {
    return errAsync(e instanceof SyntaxError ? e : new SyntaxError(String(e)));
  }
}

type ListBucketsResult = {
  ok: boolean;
  buckets?: BucketSummary[];
  error?: string;
};

function pyCmd(args: string[], superuser: "try" | "require" = "try") {
  return new Command(
    ["/usr/bin/env", "python3", "-c", s3browser_cli_script, ...args],
    { superuser }
  );
}

export function listBuckets(
  connectionId: string
): ResultAsync<BucketSummary[], ProcessError | SyntaxError> {
  return server
    .execute(pyCmd(["list-buckets", connectionId], "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<ListBucketsResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Failed to list buckets"));
      return okAsync(Array.isArray(res.buckets) ? res.buckets : []);
    });
}
