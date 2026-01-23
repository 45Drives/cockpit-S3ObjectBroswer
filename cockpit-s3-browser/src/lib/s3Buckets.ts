import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

import type { BucketSummary } from "../types";


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
    ["/usr/bin/env", "python3", "-u", S3BROWSER_CLI_PATH, ...args],
    { superuser }
  );
}

const S3BROWSER_CLI_PATH = "/opt/45drives/houston/s3Navigator/scripts/main.py";

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
