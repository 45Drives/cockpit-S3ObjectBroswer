// src/operations/useDeletes.ts
import { computed } from "vue";
import type { Row } from "../types";
import type { useDeleteTasksStore } from "../stores/deleteTasks";
import { useTaskCenterStore } from "../stores/taskCenter";
import type {
  deleteObject as deleteObjectFn,
  deletePrefixStreamed as deletePrefixStreamedFn,
  deleteObjectVersion as deleteObjectVersionFn,
} from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import { pushNotification, Notification } from '@45drives/houston-common-ui';


type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  delStore: ReturnType<typeof useDeleteTasksStore>;
  deletePrefixStreamed: typeof deletePrefixStreamedFn;
  deleteObject: typeof deleteObjectFn;

  deleteObjectVersion: typeof deleteObjectVersionFn; // add this

  refresh?: () => Promise<void> | void;
  onDeleted?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string },
  ) => void;
};

export function useDeletes(deps: Deps) {
    const taskCenter = useTaskCenterStore();

  const deleteBusy = computed(() => deps.delStore.list.some((t) => t.busy));

  function isDeletingRow(r: Row): boolean {
    for (const t of deps.delStore.list) {
      if (!t.busy) continue;
      if (t.connectionId !== deps.connectionId.value) continue;
      if (t.bucket !== deps.bucket.value) continue;

      if (t.kind === "file" && t.key && r.type === "file") {
        if (r.key === t.key) return true;
      }

      if (t.kind === "folder" && t.prefix) {
        const path = r.type === "folder" ? r.prefix : r.key;
        if (path === t.prefix || path.startsWith(t.prefix)) return true;
      }
    }
    return false;
  }

  function upsertDeleteTask(opts: {
    id: string;
    name: string;
    state: "running" | "done" | "failed" | "canceled";
    progressText?: string;
    error?: string;
    cancel?: () => void;
    dismiss?: () => void;
  }) {
    taskCenter.upsert({
      id: opts.id,
      kind: "delete",
      name: opts.name,
      state: opts.state,
      progressText: opts.progressText,
      error: opts.error,
      actions: {
        cancel: opts.cancel,
        dismiss: opts.dismiss,
      },
    });
  }

  function deleteNow(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;

    for (const it of items) {
      if (isDeletingRow(it)) continue;

      // Create a stable TaskCenter id (not the delStore id) so TaskCenter can own dismiss/remove.
      const tcId = uid();
      const displayName = it.type === "folder" ? `${it.name}/` : it.name;

      // Upsert into TaskCenter immediately
      upsertDeleteTask({
        id: tcId,
        name: displayName,
        state: "running",
        progressText: "Deleting…",
        cancel: () => {
          // You already have delStore.cancel(taskId), but taskId is unknown here until createTask returns.
          // We'll bind the real cancel once we have task below.
        },
        dismiss: () => {
          // dismiss should only remove from TaskCenter; the delete store has its own lifecycle.
          taskCenter.remove(tcId);
        },
      });

      if (it.type === "folder") {
        const task = deps.delStore.createTask({
          connectionId: deps.connectionId.value,
          bucket: deps.bucket.value,
          kind: "folder",
          name: it.name,
          prefix: it.prefix,
        });

        // Now we can wire cancel properly (needs task.id from delete store)
        upsertDeleteTask({
          id: tcId,
          name: displayName,
          state: "running",
          progressText: "Deleting…",
          cancel: () => deps.delStore.cancel(task.id),
          dismiss: () => taskCenter.remove(tcId),
        });

        void (async () => {
          try {
            const res = await deps.delStore.run(task, {
              deletePrefixStreamed: deps.deletePrefixStreamed,
              deleteObject: deps.deleteObject,
            });

            const ok = (res as any) !== false && !task.error;
            if (ok) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "done",
                progressText: "Done",
                dismiss: () => taskCenter.remove(tcId),
              });
              deps.onDeleted?.({ type: "folder", prefix: it.prefix });
            } else {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                error: task.error || "Delete failed",
                dismiss: () => taskCenter.remove(tcId),
              });
            }
          } catch (e: any) {
            upsertDeleteTask({
              id: tcId,
              name: displayName,
              state: "failed",
              progressText: "Failed",
              error: e?.message || "Delete failed",
              dismiss: () => taskCenter.remove(tcId),
            });
          }
        })();
      } else {
        const task = deps.delStore.createTask({
          connectionId: deps.connectionId.value,
          bucket: deps.bucket.value,
          kind: "file",
          name: it.name,
          key: it.key,
        });

        upsertDeleteTask({
          id: tcId,
          name: displayName,
          state: "running",
          progressText: "Deleting…",
          cancel: () => deps.delStore.cancel(task.id),
          dismiss: () => taskCenter.remove(tcId),
        });

        void (async () => {
          try {
            const res = await deps.delStore.run(task, {
              deletePrefixStreamed: deps.deletePrefixStreamed,
              deleteObject: deps.deleteObject,
            });

            const ok = (res as any) !== false && !task.error;
            if (ok) {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "done",
                progressText: "Done",
                dismiss: () => taskCenter.remove(tcId),
              });
              deps.onDeleted?.({ type: "file", key: it.key });
            } else {
              upsertDeleteTask({
                id: tcId,
                name: displayName,
                state: "failed",
                progressText: "Failed",
                error: task.error || "Delete failed",
                dismiss: () => taskCenter.remove(tcId),
              });
            }
          } catch (e: any) {
            upsertDeleteTask({
              id: tcId,
              name: displayName,
              state: "failed",
              progressText: "Failed",
              error: e?.message || "Delete failed",
              dismiss: () => taskCenter.remove(tcId),
            });
          }
        })();
      }
    }
  }
  async function deleteVersionsForKey(opts: { key: string; versionIds: string[]; displayName?: string }) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!opts.key || !opts.versionIds.length) return;
  
    const tcId = uid();
    const name = opts.displayName || opts.key;
    const total = opts.versionIds.length;
  
    upsertDeleteTask({
      id: tcId,
      name: `Delete ${total} version(s): ${name}`,
      state: "running",
      progressText: `0 / ${total}`,
      dismiss: () => taskCenter.remove(tcId),
    });
  
    let done = 0;
  
    for (const vid of opts.versionIds) {
      const res = await deps.deleteObjectVersion({
        connectionId: deps.connectionId.value,
        bucket: deps.bucket.value,
        key: opts.key,
        versionId: vid,
      });
  
      if (res.isErr()) {
        const e = res.error;
        const msg = e instanceof Error ? e.message : String(e);
  
        upsertDeleteTask({
          id: tcId,
          name: `Delete ${total} version(s): ${name}`,
          state: "failed",
          progressText: `Failed at ${done} / ${total}`,
          error: msg,
          dismiss: () => taskCenter.remove(tcId),
        });
  
        console.error(`Failed to delete version ${vid} for ${opts.key}: ${msg}`, e);
        pushNotification(new Notification('Failed Delete Version',
          `Failed to delete version ${vid} for ${opts.key}: ${msg}`,
          'error', 5000));
        return;
      }
  
      done += 1;
      upsertDeleteTask({
        id: tcId,
        name: `Delete ${total} version(s): ${name}`,
        state: "running",
        progressText: `${done} / ${total}`,
        dismiss: () => taskCenter.remove(tcId),
      });
    }
  
    upsertDeleteTask({
      id: tcId,
      name: `Delete ${total} version(s): ${name}`,
      state: "done",
      progressText: "Done",
      dismiss: () => taskCenter.remove(tcId),
    });
  
    console.log(`Deleted ${done} version(s) for ${opts.key}`);
    pushNotification(new Notification('Version Deleted',
      `Deleted ${done} version(s) for ${opts.key}`,
      'success', 5000));
  }
  

  return {
    deleteVersionsForKey,
    deleteBusy,
    isDeletingRow,
    deleteNow,
  };
}
