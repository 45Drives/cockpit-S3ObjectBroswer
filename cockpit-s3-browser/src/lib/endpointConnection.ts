import { Command, server } from "@45drives/houston-common-lib";
import type { ProcessError } from "@45drives/houston-common-lib";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

import type { EndpointConfig, ConnectionSummary } from "../types";

// @ts-ignore
import connection_store_script from "../scripts/connection-store.py?raw";

function safeJsonParse<T>(raw: string): ResultAsync<T, SyntaxError> {
  try {
    return okAsync(JSON.parse(raw) as T);
  } catch (e: any) {
    return errAsync(e instanceof SyntaxError ? e : new SyntaxError(String(e)));
  }
}

function toB64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type UpsertPayload = { id?: string; config: EndpointConfig };
type UpsertResult = { ok: boolean; id: string };

function pyCmd(args: string[], superuser: "try" | "require" = "try") {
  return new Command(
    ["/usr/bin/env", "python3", "-c", connection_store_script, ...args],
    { superuser }
  );
}

export function listConnections(): ResultAsync<
  ConnectionSummary[],
  ProcessError | SyntaxError
> {
  return server
    .execute(pyCmd(["list"], "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => {
      if (!stdout || stdout === "null")
        return okAsync([] as ConnectionSummary[]);
      return safeJsonParse<ConnectionSummary[]>(stdout);
    });
}

export function getConnection(
  id: string
): ResultAsync<EndpointConfig | null, ProcessError | SyntaxError> {
  return server
    .execute(pyCmd(["get", id], "try"))
    .map((proc) => proc.getStdout().trim())
    .andThen((stdout) => {
      if (!stdout || stdout === "null") return okAsync(null);
      return safeJsonParse<EndpointConfig>(stdout).map((cfg) => cfg);
    });
}

export function upsertConnection(
  config: EndpointConfig,
  id?: string
): ResultAsync<string, ProcessError | SyntaxError> {
  const payload: UpsertPayload = { id, config };
  const arg = `b64:${toB64Utf8(JSON.stringify(payload))}`;

  return server
    .execute(pyCmd(["upsert", arg], "require"))
    .map((proc) => proc.getStdout().trim())
    .andThen(safeJsonParse<UpsertResult>)
    .andThen((res) => {
      if (!res.ok || !res.id)
        return errAsync(new SyntaxError("Helper did not return ok/id"));
      return okAsync(res.id);
    });
}

export function deleteConnection(id: string): ResultAsync<null, ProcessError> {
  return server.execute(pyCmd(["delete", id], "require")).map(() => null);
}

export function touchLastUsed(id: string): ResultAsync<null, ProcessError> {
  return server.execute(pyCmd(["touch", id], "require")).map(() => null);
}
