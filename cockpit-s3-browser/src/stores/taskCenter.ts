// src/stores/taskCenter.ts
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { TaskKind, UiTask } from "../types";

export type TaskActions = {
  cancel?: () => void;
  dismiss?: () => void;
};

export type DeleteTaskMeta = {
  op: "delete";
  connectionId: string;
  bucket: string;
  target:
    | { kind: "file"; key: string }
    | { kind: "folder"; prefix: string }
    | { kind: "versions"; key: string };
};

export type TaskRecord = UiTask & {
  actions?: TaskActions;

  progressPct?: number | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;

  meta?: DeleteTaskMeta | Record<string, unknown>;
};

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.floor(n);
}

export const useTaskCenterStore = defineStore("taskCenter", () => {
  const items = ref<TaskRecord[]>([]);

  function upsert(task: TaskRecord) {
    const i = items.value.findIndex((t) => t.id === task.id);
    if (i >= 0) {
      const prev = items.value[i];
      items.value[i] = {
        ...prev,
        ...task,
        actions: { ...prev.actions, ...task.actions },
        meta: task.meta ?? prev.meta,
      };
    } else {
      items.value.unshift(task);
    }
  }

  function remove(id: string) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  function cancel(id: string) {
    const i = items.value.findIndex((x) => x.id === id);
    if (i < 0) return;

    const t = items.value[i];

    if (t.state === "running") {
      items.value[i] = { ...t, state: "canceling" };
    }

    t.actions?.cancel?.();
  }

  function dismiss(id: string) {
    const t = items.value.find((x) => x.id === id);
    t?.actions?.dismiss?.();
  }

  function clearFinished() {
    items.value = items.value.filter(
      (t) => t.state === "running" || t.state === "canceling"
    );
  }

  const hasAny = computed(() => items.value.length > 0);
  const hasActive = computed(() =>
    items.value.some((t) => t.state === "running" || t.state === "canceling")
  );
  const activeTotal = computed(() =>
    items.value.reduce(
      (n, t) => n + (t.state === "running" || t.state === "canceling" ? 1 : 0),
      0
    )
  );

  const countsByKind = computed(() => {
    const m: Record<TaskKind, number> = {
      delete: 0,
      download: 0,
      upload: 0,
      copy: 0,
      move: 0,
      rename: 0,
      transfer: 0,
    };
    for (const t of items.value) {
      if (t.state === "running" || t.state === "canceling") m[t.kind] += 1;
    }
    return m;
  });

  const overallPct = computed(() => {
    const active = items.value.filter(
      (t) => t.state === "running" || t.state === "canceling"
    );
    const pcts: number[] = [];

    for (const t of active) {
      if (typeof t.progressPct === "number") {
        pcts.push(clampPct(t.progressPct));
        continue;
      }
      const cur = t.progressCurrent;
      const tot = t.progressTotal;
      if (typeof cur === "number" && typeof tot === "number" && tot > 0) {
        pcts.push(clampPct((cur * 100) / tot));
      }
    }

    if (pcts.length === 0) return null;
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  });

  return {
    items,

    upsert,
    remove,
    cancel,
    dismiss,
    clearFinished,

    hasAny,
    hasActive,
    activeTotal,
    countsByKind,
    overallPct,
  };
});
