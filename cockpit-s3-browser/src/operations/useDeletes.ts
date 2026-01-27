// src/operations/useDeletes.ts
import { computed } from "vue";
import { storeToRefs } from "pinia";
import type { Row } from "../types";
import { useTaskCenterStore, type DeleteTaskMeta } from "../stores/taskCenter";
import type {
  deleteObject as deleteObjectFn,
  deletePrefixStreamed as deletePrefixStreamedFn,
  deleteObjectVersion as deleteObjectVersionFn,
} from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  deletePrefixStreamed: typeof deletePrefixStreamedFn;
  deleteObject: typeof deleteObjectFn;
  deleteObjectVersion: typeof deleteObjectVersionFn;

  refresh?: () => Promise<void> | void;
  onDeleted?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string }
  ) => void;
};

function isAbortish(e: any): boolean {
  const name = String(e?.name || "");
  const msg = String(e?.message || "");
  return (
    name === "AbortError" ||
    name === "CanceledError" ||
    msg.toLowerCase().includes("aborted") ||
    msg.toLowerCase().includes("canceled") ||
    msg.toLowerCase().includes("cancelled")
  );
}

function isResultLike(res: any): boolean {
  // We cannot rely on res.value being truthy for Result<void, E>
  return !!res && typeof res.isErr === "function";
}

export function useDeletes(deps: Deps) {
  const taskCenter = useTaskCenterStore();
  const { items: tcItems } = storeToRefs(taskCenter);

  const deleteBusy = computed(() =>
    tcItems.value.some(
      (t) =>
        t.kind === "delete" &&
        (t.state === "running" || t.state === "canceling")
    )
  );

  function isDeletingRow(r: Row): boolean {
    const conn = deps.connectionId.value;
    const bucket = deps.bucket.value;

    for (const t of tcItems.value) {
      if (t.kind !== "delete") continue;
      if (t.state !== "running" && t.state !== "canceling") continue;

      const meta = t.meta as DeleteTaskMeta | undefined;
      if (!meta || meta.op !== "delete") continue;
      if (meta.connectionId !== conn) continue;
      if (meta.bucket !== bucket) continue;

      if (meta.target.kind === "file" && r.type === "file") {
        if (r.key === meta.target.key) return true;
      }

      if (meta.target.kind === "versions" && r.type === "file") {
        if (r.key === meta.target.key) return true;
      }

      if (meta.target.kind === "folder") {
        const path = r.type === "folder" ? r.prefix : r.key;
        if (path === meta.target.prefix || path.startsWith(meta.target.prefix))
          return true;
      }
    }

    return false;
  }

  function upsertDeleteTask(opts: {
    id: string;
    name: string;
    state: "running" | "done" | "failed" | "canceled" | "canceling";
    progressText?: string;
    progressPct?: number;
    error?: string;
    cancel?: () => void;
    dismiss?: () => void;
    meta?: DeleteTaskMeta;
  }) {
    taskCenter.upsert({
      id: opts.id,
      kind: "delete",
      name: opts.name,
      state: opts.state,
      progressText: opts.progressText,
      progressPct: opts.progressPct,
      error: opts.error,
      meta: opts.meta,
      actions: {
        cancel: opts.cancel,
        dismiss: opts.dismiss,
      },
    });
  }

  function notifyDelete(
    target:
      | { kind: "file"; name: string; key: string }
      | { kind: "folder"; name: string; prefix: string }
      | { kind: "versions"; name: string; key: string; total: number },
    state: "done" | "failed" | "canceled",
    errMsg?: string
  ) {
    const bucket = deps.bucket.value;

    if (state === "done") {
      const msg =
        target.kind === "file"
          ? `Deleted ${target.name} (${bucket}:${target.key})`
          : target.kind === "folder"
            ? `Deleted ${target.name} (${bucket}:${target.prefix})`
            : `Deleted ${target.total} version(s) for ${target.name} (${bucket}:${target.key})`;

      pushNotification(
        new Notification("Delete completed", msg, "success", 5000)
      );
      return;
    }

    if (state === "canceled") {
      const msg =
        target.kind === "file"
          ? `Canceled delete of ${target.name} (${bucket}:${target.key})`
          : target.kind === "folder"
            ? `Canceled delete of ${target.name} (${bucket}:${target.prefix})`
            : `Canceled delete of ${target.total} version(s) for ${target.name} (${bucket}:${target.key})`;

      pushNotification(new Notification("Delete canceled", msg, "error", 5000));
      return;
    }

    const msgBase =
      target.kind === "file"
        ? `Failed to delete ${target.name} (${bucket}:${target.key})`
        : target.kind === "folder"
          ? `Failed to delete ${target.name} (${bucket}:${target.prefix})`
          : `Failed to delete ${target.total} version(s) for ${target.name} (${bucket}:${target.key})`;

    pushNotification(
      new Notification(
        "Delete failed",
        `${msgBase}${errMsg ? ` - ${errMsg}` : ""}`,
        "error",
        5000
      )
    );
  }

  function notifyDeleteBatchSummary(opts: {
    total: number;
    done: number;
    failed: number;
    canceled: number;
  }) {
    if (opts.total <= 1) return;

    if (opts.failed > 0) {
      pushNotification(
        new Notification(
          "Delete finished with errors",
          `Deleted ${opts.done} of ${opts.total} item(s) (${opts.failed} failed, ${opts.canceled} canceled).`,
          "error",
          5000
        )
      );
      return;
    }

    if (opts.canceled > 0) {
      pushNotification(
        new Notification(
          "Delete canceled",
          `Deleted ${opts.done} of ${opts.total} item(s) (${opts.canceled} canceled).`,
          "error",
          5000
        )
      );
      return;
    }

    pushNotification(
      new Notification(
        "Delete completed",
        `Deleted ${opts.total} item(s).`,
        "success",
        5000
      )
    );
  }

  async function deleteNow(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;

    const conn = deps.connectionId.value;
    const bucket = deps.bucket.value;

    const isMulti = items.length > 1;

    let doneCount = 0;
    let failedCount = 0;
    let canceledCount = 0;

    const jobs: Promise<void>[] = [];

    for (const it of items) {
      if (isDeletingRow(it)) continue;

      const tcId = uid();
      const displayName = it.type === "folder" ? `${it.name}/` : it.name;

      if (it.type === "folder") {
        const ac = new AbortController();
        let canceled = false;

        const meta: DeleteTaskMeta = {
          op: "delete",
          connectionId: conn,
          bucket,
          target: { kind: "folder", prefix: it.prefix },
        };

        upsertDeleteTask({
          id: tcId,
          name: displayName,
          state: "running",
          progressText: "Deleting…",
          progressPct: 0,
          meta,
          cancel: () => {
            canceled = true;
            try {
              ac.abort();
            } catch {}
          },
          dismiss: () => taskCenter.remove(tcId),
        });

        jobs.push(
          (async () => {
            try {
              const res = await (deps.deletePrefixStreamed as any)({
                connectionId: conn,
                bucket,
                prefix: it.prefix,
                signal: ac.signal,
                onEvent: (ev: any) => {
                  if (canceled) return;

                  if (ev?.type === "start") {
                    upsertDeleteTask({
                      id: tcId,
                      name: displayName,
                      state: "running",
                      progressText: "Deleting…",
                      progressPct: 0,
                      meta,
                      dismiss: () => taskCenter.remove(tcId),
                    });
                    return;
                  }

                  if (ev?.type === "progress") {
                    upsertDeleteTask({
                      id: tcId,
                      name: displayName,
                      state: "running",
                      progressText: `Deleting folder…`,
                      progressPct: 50,
                      meta,
                      dismiss: () => taskCenter.remove(tcId),
                    });
                  }
                },
              });

              if (!isResultLike(res)) {
                throw new Error("Invalid response from deletePrefixStreamed");
              }

              if (canceled) {
                canceledCount += 1;
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "canceled",
                  progressText: "Canceled",
                  progressPct: 0,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "folder", name: displayName, prefix: it.prefix },
                    "canceled"
                  );
                }
                return;
              }

              if (res.isErr()) {
                failedCount += 1;
                const msg = res.error?.message || "Delete failed";
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "failed",
                  progressText: "Failed",
                  progressPct: 0,
                  error: msg,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "folder", name: displayName, prefix: it.prefix },
                    "failed",
                    msg
                  );
                }
                return;
              }

              doneCount += 1;
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "done",
                progressText: `Done. Deleted prefix.`,
                progressPct: 100,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              deps.onDeleted?.({ type: "folder", prefix: it.prefix });
              if (!isMulti) {
                notifyDelete(
                  { kind: "folder", name: displayName, prefix: it.prefix },
                  "done"
                );
              }
            } catch (e: any) {
              if (canceled || isAbortish(e)) {
                canceledCount += 1;
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "canceled",
                  progressText: "Canceled",
                  progressPct: 0,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "folder", name: displayName, prefix: it.prefix },
                    "canceled"
                  );
                }
                return;
              }

              failedCount += 1;
              const msg = e?.message || "Delete failed";
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                progressPct: 0,
                error: msg,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              if (!isMulti) {
                notifyDelete(
                  { kind: "folder", name: displayName, prefix: it.prefix },
                  "failed",
                  msg
                );
              }
            }
          })()
        );
      } else {
        const ac = new AbortController();
        let canceled = false;

        const meta: DeleteTaskMeta = {
          op: "delete",
          connectionId: conn,
          bucket,
          target: { kind: "file", key: it.key },
        };

        upsertDeleteTask({
          id: tcId,
          name: displayName,
          state: "running",
          progressText: "Deleting…",
          progressPct: 0,
          meta,
          cancel: () => {
            canceled = true;
            try {
              ac.abort();
            } catch {}
          },
          dismiss: () => taskCenter.remove(tcId),
        });

        jobs.push(
          (async () => {
            try {
              const res = await (deps.deleteObject as any)({
                connectionId: conn,
                bucket,
                key: it.key,
                signal: ac.signal,
              });

              if (!isResultLike(res)) {
                throw new Error("Invalid response from deleteObject");
              }

              if (canceled) {
                canceledCount += 1;
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "canceled",
                  progressText: "Canceled",
                  progressPct: 0,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "file", name: displayName, key: it.key },
                    "canceled"
                  );
                }
                return;
              }

              if (res.isErr()) {
                failedCount += 1;
                const msg = res.error?.message || "Delete failed";
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "failed",
                  progressText: "Failed",
                  progressPct: 0,
                  error: msg,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "file", name: displayName, key: it.key },
                    "failed",
                    msg
                  );
                }
                return;
              }

              doneCount += 1;
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "done",
                progressText: "Done",
                progressPct: 100,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              deps.onDeleted?.({ type: "file", key: it.key });
              if (!isMulti) {
                notifyDelete(
                  { kind: "file", name: displayName, key: it.key },
                  "done"
                );
              }
            } catch (e: any) {
              if (canceled || isAbortish(e)) {
                canceledCount += 1;
                upsertDeleteTask({
                  id: tcId,
                  name: displayName,
                  state: "canceled",
                  progressText: "Canceled",
                  progressPct: 0,
                  meta,
                  dismiss: () => taskCenter.remove(tcId),
                });
                if (!isMulti) {
                  notifyDelete(
                    { kind: "file", name: displayName, key: it.key },
                    "canceled"
                  );
                }
                return;
              }

              failedCount += 1;
              const msg = e?.message || "Delete failed";
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                progressPct: 0,
                error: msg,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              if (!isMulti) {
                notifyDelete(
                  { kind: "file", name: displayName, key: it.key },
                  "failed",
                  msg
                );
              }
            }
          })()
        );
      }
    }

    if (jobs.length > 0) {
      await Promise.all(jobs);
    }

    if (isMulti) {
      notifyDeleteBatchSummary({
        total: jobs.length,
        done: doneCount,
        failed: failedCount,
        canceled: canceledCount,
      });
    }
  }

  async function deleteVersionsForKey(opts: {
    key: string;
    versionIds: string[];
    displayName?: string;
  }) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!opts.key || !opts.versionIds.length) return;

    const conn = deps.connectionId.value;
    const bucket = deps.bucket.value;

    const tcId = uid();
    const name = opts.displayName || opts.key;
    const total = opts.versionIds.length;

    const meta: DeleteTaskMeta = {
      op: "delete",
      connectionId: conn,
      bucket,
      target: { kind: "versions", key: opts.key },
    };

    let canceled = false;
    const ac = new AbortController();

    upsertDeleteTask({
      id: tcId,
      name: `Delete ${total} version(s): ${name}`,
      state: "running",
      progressText: `0 / ${total}`,
      progressPct: 0,
      meta,
      cancel: () => {
        canceled = true;
        try {
          ac.abort();
        } catch {}
      },
      dismiss: () => taskCenter.remove(tcId),
    });

    let done = 0;

    const notifyTarget = {
      kind: "versions" as const,
      name,
      key: opts.key,
      total,
    };

    for (const vid of opts.versionIds) {
      if (canceled) {
        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "canceled",
          progressText: `Canceled at ${done} / ${total}`,
          progressPct: (done / total) * 100,
          meta,
          dismiss: () => taskCenter.remove(tcId),
        });

        notifyDelete(notifyTarget, "canceled");
        return;
      }

      let res: any;
      try {
        res = await (deps.deleteObjectVersion as any)({
          connectionId: conn,
          bucket,
          key: opts.key,
          versionId: vid,
          signal: ac.signal,
        });
      } catch (e: any) {
        if (canceled || isAbortish(e)) {
          upsertDeleteTask({
            id: tcId,
            name: `Delete ${total} version(s): ${name}`,
            state: "canceled",
            progressText: `Canceled at ${done} / ${total}`,
            progressPct: (done / total) * 100,
            meta,
            dismiss: () => taskCenter.remove(tcId),
          });

          notifyDelete(notifyTarget, "canceled");
          return;
        }

        const msg = e?.message || "Delete failed";

        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "failed",
          progressText: `Failed at ${done} / ${total}`,
          progressPct: (done / total) * 100,
          error: msg,
          meta,
          dismiss: () => taskCenter.remove(tcId),
        });

        console.error(
          `Failed to delete version ${vid} for ${opts.key}: ${msg}`,
          e
        );

        notifyDelete(notifyTarget, "failed", msg);
        return;
      }

      if (!isResultLike(res)) {
        const msg = "Invalid response from deleteObjectVersion";

        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "failed",
          progressText: `Failed at ${done} / ${total}`,
          progressPct: (done / total) * 100,
          error: msg,
          meta,
          dismiss: () => taskCenter.remove(tcId),
        });

        notifyDelete(notifyTarget, "failed", msg);
        return;
      }

      if (canceled) {
        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "canceled",
          progressText: `Canceled at ${done} / ${total}`,
          progressPct: (done / total) * 100,
          meta,
          dismiss: () => taskCenter.remove(tcId),
        });

        notifyDelete(notifyTarget, "canceled");
        return;
      }

      if (res.isErr()) {
        const e = res.error;
        const msg = e instanceof Error ? e.message : String(e);

        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "failed",
          progressText: `Failed at ${done} / ${total}`,
          progressPct: (done / total) * 100,
          error: msg,
          meta,
          dismiss: () => taskCenter.remove(tcId),
        });

        console.error(
          `Failed to delete version ${vid} for ${opts.key}: ${msg}`,
          e
        );

        notifyDelete(notifyTarget, "failed", msg);
        return;
      }

      done += 1;

      upsertDeleteTask({
        id: tcId,
        name: `Delete ${total} version(s): ${name}`,
        state: "running",
        progressText: `${done} / ${total}`,
        progressPct: (done / total) * 100,
        meta,
        dismiss: () => taskCenter.remove(tcId),
      });
    }

    upsertDeleteTask({
      id: tcId,
      name: `Delete ${total} version(s): ${name}`,
      state: "done",
      progressText: "Done",
      progressPct: 100,
      meta,
      dismiss: () => taskCenter.remove(tcId),
    });

    notifyDelete(notifyTarget, "done");
  }

  return {
    deleteVersionsForKey,
    deleteBusy,
    isDeletingRow,
    deleteNow,
  };
}
