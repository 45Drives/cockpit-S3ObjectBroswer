// src/operations/useRename.ts
import { computed, ref } from "vue";
import type { renameObjectStreamed as renameObjectStreamedFn } from "../lib/s3Objects";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";
import { rateEtaText, updateRateAndEta } from "../lib/helpers";
import type { RateStats } from "../types";

type RenameProgress = {
  done: number;
  total: number;
  bytes: number;
  size: number;
};

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  renameObjectStreamed: typeof renameObjectStreamedFn;

  setBusy?: (busy: boolean) => void;
  onRenamed?: (srcKey: string, dstKey: string) => void;
};

type TaskState = "running" | "canceling" | "done" | "failed" | "canceled";

type ProgressSnap = {
  done: number | null;
  total: number | null;
  bytes: number | null;
  size: number | null;
};

export function useRename(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  // Optional inline UI (if you show it somewhere else)
  const renameProgress = ref<RenameProgress | null>(null);
  const renameCancel = ref<null | (() => void)>(null);

  const currentTaskId = ref<string | null>(null);
  const currentTaskName = ref<string>("");

  // For task UI: keep last-known progress even after inline UI is cleared
  const snap = ref<ProgressSnap>({
    done: null,
    total: null,
    bytes: null,
    size: null,
  });

  // Rate/ETA stats for this one rename task
  const rateStats = new Map<string, RateStats>();

  const renamePct = computed(() => {
    const p = renameProgress.value;
    if (!p) return null;

    // Prefer bytes if available
    if (p.size > 0) {
      return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
    }

    // Fall back to parts-based percentage
    if (p.total > 0) {
      return Math.max(0, Math.min(100, Math.floor((p.done / p.total) * 100)));
    }

    return null;
  });

  function taskProgressFor(state: TaskState) {
    const s = snap.value;

    // Byte-based progress if we have total size
    if (typeof s.size === "number" && s.size > 0) {
      const tot = s.size;
      let cur = typeof s.bytes === "number" ? s.bytes : 0;

      // clamp while running, force to 100% on done
      if (state === "done") cur = tot;
      else cur = Math.min(cur, tot);

      let pct = Math.round((cur * 100) / tot);
      pct = Math.max(0, Math.min(100, pct));
      if (state === "done") pct = 100;

      return {
        progressCurrent: cur,
        progressTotal: tot,
        progressPct: pct,
        mode: "bytes" as const,
      };
    }

    // Otherwise parts-based progress (show bar using progressPct only)
    if (typeof s.total === "number" && s.total > 0) {
      const done = typeof s.done === "number" ? s.done : 0;
      let pct = Math.round((done * 100) / s.total);
      pct = Math.max(0, Math.min(100, pct));
      if (state === "done") pct = 100;

      return {
        progressCurrent: null as number | null,
        progressTotal: null as number | null,
        progressPct: pct,
        mode: "parts" as const,
      };
    }

    // Unknown progress
    return {
      progressCurrent: null as number | null,
      progressTotal: null as number | null,
      progressPct: state === "done" ? 100 : null,
      mode: "none" as const,
    };
  }

  function buildProgressText(state: TaskState) {
    const id = currentTaskId.value;

    if (state === "done") return "Rename completed";
    if (state === "canceling") return "Canceling…";
    if (state === "canceled") return "Rename canceled";
    if (state === "failed") return "Rename failed";

    // running
    const s = snap.value;

    if (id && typeof s.size === "number" && s.size > 0) {
      const re = rateEtaText(rateStats, id);
      const cur = typeof s.bytes === "number" ? Math.min(s.bytes, s.size) : 0;
      const pct = Math.max(0, Math.min(100, Math.floor((cur / s.size) * 100)));
      return `Renaming… ${pct}% • ${re}`;
    }

    if (typeof s.total === "number" && s.total > 0) {
      const done = typeof s.done === "number" ? s.done : 0;
      return `Renaming… ${done} / ${s.total} parts`;
    }

    return "Renaming…";
  }

  function upsertTask(state: TaskState, error?: string) {
    const id = currentTaskId.value;
    if (!id) return;

    const prog = taskProgressFor(state);

    taskCenter.upsert({
      id,
      kind: "rename",
      name: currentTaskName.value || "Rename",
      state,

      progressText: buildProgressText(state),
      progressCurrent: prog.progressCurrent,
      progressTotal: prog.progressTotal,
      progressPct: prog.progressPct,

      error,
      actions: {
        cancel: () => cancelRename(),
        dismiss: () => dismiss(),
      },
    });
  }

  // Throttle expensive UI writes
  let uiTimer: number | null = null;
  let pendingState: TaskState = "running";
  let pendingError: string | undefined;

  function flushUi() {
    uiTimer = null;
    upsertTask(pendingState, pendingError);
    pendingError = undefined;
  }

  function scheduleUi(state: TaskState, error?: string) {
    pendingState = state;
    pendingError = error;
    if (uiTimer != null) return;
    uiTimer = window.setTimeout(flushUi, 250);
  }

  function cancelRename() {
    const id = currentTaskId.value;
    if (!id) return;

    scheduleUi("canceling");
    try {
      renameCancel.value?.();
    } catch {
      // ignore
    }
  }

  function dismiss() {
    const id = currentTaskId.value;
    if (!id) return;

    taskCenter.remove(id);

    currentTaskId.value = null;
    currentTaskName.value = "";
    renameProgress.value = null;
    renameCancel.value = null;

    snap.value = { done: null, total: null, bytes: null, size: null };
    rateStats.delete(id);

    if (uiTimer != null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
  }

  async function renameFile(srcKey: string, dstKey: string, concurrency = 6) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!srcKey || !dstKey) return;
    if (srcKey === dstKey) return;

    deps.setBusy?.(true);

    const id = `rename:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    currentTaskId.value = id;
    currentTaskName.value = `${srcKey} → ${dstKey}`;

    // Reset state
    renameProgress.value = null;
    renameCancel.value = null;
    snap.value = { done: null, total: null, bytes: null, size: null };
    rateStats.delete(id);

    // Create the task immediately (even before we have progress)
    taskCenter.upsert({
      id,
      kind: "rename",
      name: currentTaskName.value,
      state: "running",
      progressText: "Renaming…",
      progressCurrent: null,
      progressTotal: null,
      progressPct: 0, // show the bar right away
      actions: {
        cancel: () => cancelRename(),
        dismiss: () => dismiss(),
      },
    });

    let finalized = false;
    const finalize = (state: "done" | "failed" | "canceled", msg?: string) => {
      if (finalized) return;
      finalized = true;

      if (uiTimer != null) {
        window.clearTimeout(uiTimer);
        uiTimer = null;
      }

      // IMPORTANT: keep snap for task UI; only clear inline UI
      renameProgress.value = null;
      renameCancel.value = null;

      upsertTask(state, msg);

      rateStats.delete(id);

      if (state === "done") {
        pushNotification(
          new Notification(
            "Rename completed",
            `Rename completed ${srcKey} → ${dstKey}`,
            "success",
            5000
          )
        );
        deps.onRenamed?.(srcKey, dstKey);
        return;
      }

      const em = msg || (state === "canceled" ? "Rename canceled" : "Rename failed");
      pushNotification(
        new Notification(
          state === "canceled" ? "Rename canceled" : "Rename failed",
          `${state === "canceled" ? "Rename canceled" : "Rename failed"} ${srcKey} → ${dstKey}: ${em}`,
          "error",
          5000
        )
      );
    };

    const job = deps.renameObjectStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      srcKey,
      dstKey,
      concurrency,
      onEvent: (ev) => {
        if (ev.type === "start") {
          const total = Number(ev.totalParts ?? 0);
          const size = Number(ev.size ?? 0);

          const totalOk = Number.isFinite(total) ? total : 0;
          const sizeOk = Number.isFinite(size) ? size : 0;

          renameProgress.value = { done: 0, total: totalOk, bytes: 0, size: sizeOk };
          snap.value = { done: 0, total: totalOk || null, bytes: 0, size: sizeOk || null };

          if (sizeOk > 0) {
            updateRateAndEta(rateStats, id, 0, sizeOk);
          }

          scheduleUi("running");
          return;
        }

        if (ev.type === "progress") {
          if (!renameProgress.value) {
            renameProgress.value = { done: 0, total: 0, bytes: 0, size: 0 };
          }

          const done = Number(ev.partsDone ?? renameProgress.value.done);
          const total = Number(ev.totalParts ?? renameProgress.value.total);
          const bytes = Number(ev.bytesCopied ?? renameProgress.value.bytes);
          const size = Number(ev.size ?? renameProgress.value.size);

          const doneOk = Number.isFinite(done) ? done : renameProgress.value.done;
          const totalOk = Number.isFinite(total) ? total : renameProgress.value.total;
          const bytesOk = Number.isFinite(bytes) ? bytes : renameProgress.value.bytes;
          const sizeOk = Number.isFinite(size) ? size : renameProgress.value.size;

          renameProgress.value.done = doneOk;
          renameProgress.value.total = totalOk;
          renameProgress.value.bytes = bytesOk;
          renameProgress.value.size = sizeOk;

          snap.value.done = Number.isFinite(doneOk) ? doneOk : snap.value.done;
          snap.value.total = totalOk > 0 ? totalOk : snap.value.total;
          snap.value.bytes = Number.isFinite(bytesOk) ? bytesOk : snap.value.bytes;
          snap.value.size = sizeOk > 0 ? sizeOk : snap.value.size;

          if (typeof snap.value.size === "number" && snap.value.size > 0 && typeof snap.value.bytes === "number") {
            updateRateAndEta(rateStats, id, snap.value.bytes, snap.value.size);
          }

          scheduleUi("running");
          return;
        }

        if (ev.type === "result") {
          if (ev.ok) {
            finalize("done");
          } else {
            const msg = ev.error || "Rename canceled/failed";
            const canceled = msg.toLowerCase().includes("cancel");
            finalize(canceled ? "canceled" : "failed", msg);
          }
        }
      },
    });

    renameCancel.value = () => {
      try {
        job.cancel();
      } catch {
        // ignore
      }
    };

    try {
      const res = await job.run;

      // If stream didn't send a final "result" event, finalize here.
      if (res.isErr()) {
        const msg = res.error.message || "Rename failed";
        const canceled = msg.toLowerCase().includes("cancel");
        finalize(canceled ? "canceled" : "failed", msg);
        return;
      }

      finalize("done");
    } finally {
      deps.setBusy?.(false);
    }
  }

  return {
    renameProgress,
    renameCancel,
    renamePct,

    renameFile,
    cancelRename,
    dismiss,
  };
}
