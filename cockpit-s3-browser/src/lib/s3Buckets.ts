import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

import type { BucketSummary } from "../types";
import type { BucketEncryptionConfig } from "./controlplane-types";


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

type GetBucketEncryptionResult = {
  ok: boolean;
  encryption?: {
    algorithm: string;
    kmsMasterKeyId: string | null;
    bucketKeyEnabled: boolean;
  } | null;
  error?: string;
};

export function getBucketEncryption(
  connectionId: string,
  bucket: string
): ResultAsync<BucketEncryptionConfig | null, ProcessError | SyntaxError> {
  return server
    .execute(pyCmd(["get-bucket-encryption", connectionId, bucket], "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<GetBucketEncryptionResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Failed to get bucket encryption"));
      if (!res.encryption) return okAsync(null);
      return okAsync({
        encrypted: true,
        algorithm: res.encryption.algorithm as BucketEncryptionConfig["algorithm"],
        kmsKeyId: res.encryption.kmsMasterKeyId ?? null,
        bucketKeyEnabled: res.encryption.bucketKeyEnabled ?? false,
      } as BucketEncryptionConfig);
    });
}

type SimpleResult = {
  ok: boolean;
  error?: string;
};

export function putBucketEncryption(
  connectionId: string,
  bucket: string,
  algorithm: "AES256" | "aws:kms",
  kmsKeyId?: string,
  bucketKeyEnabled?: boolean
): ResultAsync<void, ProcessError | SyntaxError> {
  const args = ["put-bucket-encryption", connectionId, bucket, "--algorithm", algorithm];
  if (kmsKeyId) {
    args.push("--kms-key-id", kmsKeyId);
  }
  if (bucketKeyEnabled) {
    args.push("--bucket-key-enabled", "true");
  }
  return server
    .execute(pyCmd(args, "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<SimpleResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Failed to set bucket encryption"));
      return okAsync(undefined);
    });
}

export function deleteBucketEncryption(
  connectionId: string,
  bucket: string
): ResultAsync<void, ProcessError | SyntaxError> {
  return server
    .execute(pyCmd(["delete-bucket-encryption", connectionId, bucket], "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => safeJsonParse<SimpleResult>(stdout))
    .andThen((res) => {
      if (!res.ok)
        return errAsync(new SyntaxError(res.error || "Failed to remove bucket encryption"));
      return okAsync(undefined);
    });
}
