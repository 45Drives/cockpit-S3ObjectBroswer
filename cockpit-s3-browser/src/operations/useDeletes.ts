// src/operations/useDeletes.ts
import { computed } from "vue";
import type { Row } from "../types";
import type { useDeleteTasksStore } from "../stores/deleteTasks";
import type {
  deleteObject as deleteObjectFn,
  deletePrefixStreamed as deletePrefixStreamedFn,
} from "../lib/s3Objects";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  delStore: ReturnType<typeof useDeleteTasksStore>;
  deletePrefixStreamed: typeof deletePrefixStreamedFn;
  deleteObject: typeof deleteObjectFn;

  refresh?: () => Promise<void> | void;
};

export function useDeletes(deps: Deps) {
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

  function deleteNow(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;

    for (const it of items) {
      if (isDeletingRow(it)) continue;

      if (it.type === "folder") {
        const task = deps.delStore.createTask({
          connectionId: deps.connectionId.value,
          bucket: deps.bucket.value,
          kind: "folder",
          name: it.name,
          prefix: it.prefix,
        });
        void deps.delStore.run(task, {
          deletePrefixStreamed: deps.deletePrefixStreamed,
          deleteObject: deps.deleteObject,
        });
      } else {
        const task = deps.delStore.createTask({
          connectionId: deps.connectionId.value,
          bucket: deps.bucket.value,
          kind: "file",
          name: it.name,
          key: it.key,
        });
        void deps.delStore.run(task, {
          deletePrefixStreamed: deps.deletePrefixStreamed,
          deleteObject: deps.deleteObject,
        });
      }
    }

    void Promise.resolve(deps.refresh?.());
  }

  return {
    deleteBusy,
    isDeletingRow,
    deleteNow,
  };
}
