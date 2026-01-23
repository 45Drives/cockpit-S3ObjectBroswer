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
    progressPct?: number; // Add progressPct to track progress
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
      progressPct: opts.progressPct, // Use progressPct to update UI progress bar
      error: opts.error,
      meta: opts.meta,
      actions: {
        cancel: opts.cancel,
        dismiss: opts.dismiss,
      },
    });
  }

  async function deleteNow(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;
  
    const conn = deps.connectionId.value;
    const bucket = deps.bucket.value;
  
    for (const it of items) {
      if (isDeletingRow(it)) continue;
  
      const tcId = uid();
      const displayName = it.type === "folder" ? `${it.name}/` : it.name;
  
      // Remove the count of deleted items and just set a default total.
      const total = it.type === "folder" ? 100 : 1; // Assuming folder has 100 items for progress.
  
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
          progressPct: 0, // Start from 0% for folder
          meta,
          cancel: () => {
            canceled = true;
            try {
              ac.abort();
            } catch {}
          },
          dismiss: () => taskCenter.remove(tcId),
        });
  
        void (async () => {
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
  
                // Simplified to always update the progress to 100% once deletion starts
                if (ev?.type === "progress") {
                  upsertDeleteTask({
                    id: tcId,
                    name: displayName,
                    state: "running",
                    progressText: `Deleting folder…`,
                    progressPct: 100, // Always set to 100% for folder deletion
                    meta,
                    dismiss: () => taskCenter.remove(tcId),
                  });
                }
              },
            });
  
            // Ensure the response is valid before processing
            if (!res || !res.value) {
              throw new Error("Invalid response from deletePrefixStreamed");
            }
  
            if (canceled) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "canceled",
                progressText: "Canceled",
                progressPct: 0,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
            if (res?.isErr?.()) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                progressPct: 0,
                error: res.error?.message || "Delete failed",
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
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
          } catch (e: any) {
            if (canceled || isAbortish(e)) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "canceled",
                progressText: "Canceled",
                progressPct: 0,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
            upsertDeleteTask({
              id: tcId,
              name: displayName,
              state: "failed",
              progressText: "Failed",
              progressPct: 0,
              error: e?.message || "Delete failed",
              meta,
              dismiss: () => taskCenter.remove(tcId),
            });
          }
        })();
      } else {
        // File Deletion logic remains similar, but we won't track progress.
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
          progressPct: 0, // Start from 0% for file
          meta,
          cancel: () => {
            canceled = true;
            try {
              ac.abort();
            } catch {}
          },
          dismiss: () => taskCenter.remove(tcId),
        });
  
        void (async () => {
          try {
            const res = await (deps.deleteObject as any)({
              connectionId: conn,
              bucket,
              key: it.key,
              signal: ac.signal,
            });
  
            // Check if the response is valid
            if (!res || !res.value) {
              throw new Error("Invalid response from deleteObject");
            }
  
            if (canceled) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "canceled",
                progressText: "Canceled",
                progressPct: 0,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
            if (res?.isErr?.()) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                progressPct: 0,
                error: res.error?.message || "Delete failed",
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
            upsertDeleteTask({
              id: tcId,
              name: displayName,
              state: "done",
              progressText: "Done",
              progressPct: 100, // Set progress to 100% when done
              meta,
              dismiss: () => taskCenter.remove(tcId),
            });
            deps.onDeleted?.({ type: "file", key: it.key });
          } catch (e: any) {
            if (canceled || isAbortish(e)) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "canceled",
                progressText: "Canceled",
                progressPct: 0,
                meta,
                dismiss: () => taskCenter.remove(tcId),
              });
              return;
            }
  
            upsertDeleteTask({
              id: tcId,
              name: displayName,
              state: "failed",
              progressText: "Failed",
              progressPct: 0,
              error: e?.message || "Delete failed",
              meta,
              dismiss: () => taskCenter.remove(tcId),
            });
          }
        })();
      }
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
      progressPct: 0, // Start from 0% for versions
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
        return;
      }

      const res = await (deps.deleteObjectVersion as any)({
        connectionId: conn,
        bucket,
        key: opts.key,
        versionId: vid,
        signal: ac.signal,
      });

      // Check if the response is valid
      if (!res || !res.value) {
        throw new Error("Invalid response from deleteObjectVersion");
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
        return;
      }

      if (res?.isErr?.()) {
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
        pushNotification(
          new Notification(
            "Failed Delete Version",
            `Failed to delete version ${vid} for ${opts.key}: ${msg}`,
            "error",
            5000
          )
        );
        return;
      }

      done += 1;

      upsertDeleteTask({
        id: tcId,
        name: `Delete ${total} version(s): ${name}`,
        state: "running",
        progressText: `${done} / ${total}`,
        progressPct: (done / total) * 100, // Update progress bar
        meta,
        dismiss: () => taskCenter.remove(tcId),
      });
    }

    upsertDeleteTask({
      id: tcId,
      name: `Delete ${total} version(s): ${name}`,
      state: "done",
      progressText: "Done",
      progressPct: 100, // Done, set to 100%
      meta,
      dismiss: () => taskCenter.remove(tcId),
    });

    pushNotification(
      new Notification(
        "Version Deleted",
        `Deleted ${done} version(s) for ${opts.key}`,
        "success",
        5000
      )
    );
  }

  return {
    deleteVersionsForKey,
    deleteBusy,
    isDeletingRow,
    deleteNow,
  };
}
