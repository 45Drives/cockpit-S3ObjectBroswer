// src/operations/useTransfers.ts
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { PasteItem, TransferJob, RateStats } from "../types";
import type { useClipboardStore } from "../stores/clipboard";
import type {
  copyObject as copyObjectFn,
  copyPrefix as copyPrefixFn,
  movePrefix as movePrefixFn,
  renameObjectStreamed as renameObjectStreamedFn,
  getDownloadJobStatus as getDownloadJobStatusFn,
  cancelDownloadJob as cancelDownloadJobFn,
} from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import {
  basenameFromKey,
  folderNameFromPrefix,
  normalizePrefixNoLead,
  rateEtaText,
  updateRateAndEta,
} from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type TransferJobEx = TransferJob & {
  backendJobId?: string;

  // progress
  bytes?: number;
  totalBytes?: number;

  // optional details from job file
  phase?: string;
  error?: string;
};

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  clip: ReturnType<typeof useClipboardStore>;

  copyObject: typeof copyObjectFn;
  copyPrefix: typeof copyPrefixFn;
  movePrefix: typeof movePrefixFn;
  renameObjectStreamed: typeof renameObjectStreamedFn;

  // NEW: reuse existing "download job status" infra
  getDownloadJobStatus: typeof getDownloadJobStatusFn;
  cancelDownloadJob: typeof cancelDownloadJobFn;

  refresh?: () => Promise<void> | void;
  setBusy?: (busy: boolean) => void;
  onCreated?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string }
  ) => void;
  onDeleted?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string }
  ) => void;
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isFinalState(s: string) {
  return s === "done" || s === "failed" || s === "canceled";
}

export function useTransfers(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const transferJobs = ref<TransferJobEx[]>([]);
  const transferBusy = computed(() =>
    transferJobs.value.some((j) => j.state === "running" || j.state === "canceling")
  );

  const pasteItems = ref<PasteItem[]>([]);
  const pasteBusy = computed(() =>
    pasteItems.value.some((i) => i.step === "queued" || i.step === "copying")
  );

  const pasteTotal = computed(() => pasteItems.value.length);
  const pasteDone = computed(
    () => pasteItems.value.filter((i) => i.step === "done").length
  );

  const pastePct = computed(() => {
    const t = pasteTotal.value;
    if (!t) return null;
    return Math.floor((pasteDone.value / t) * 100);
  });

  // auto-clear paste UI when finished
  watch(pasteBusy, (b) => {
    if (!b && pasteItems.value.length && pasteItems.value.every((p) => p.step === "done")) {
      setTimeout(() => {
        if (!pasteBusy.value) pasteItems.value = [];
      }, 2000);
    }
  });

  // Rate/ETA per transfer job (by transferJobs[i].id)
  const rateStats = new Map<string, RateStats>();

  // "Job not found" grace window (backend might create file slightly later)
  const jobStartAt = new Map<string, number>();

  // throttle taskCenter/reactivity updates
  let uiTimer: number | null = null;
  let pendingUi = false;

  const scheduleUi = () => {
    pendingUi = true;
    if (uiTimer != null) return;
    uiTimer = window.setTimeout(() => {
      uiTimer = null;
      if (!pendingUi) return;
      pendingUi = false;
      transferJobs.value = [...transferJobs.value];
      // (we also upsert tasks during polling / state changes)
    }, 250);
  };

  // polling loop (non-overlapping)
  let pollTimer: number | null = null;
  let pollRunning = false;

  function stopPolling() {
    if (pollTimer != null) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(delayMs: number) {
    stopPolling();
    pollTimer = window.setTimeout(pollOnce, delayMs);
  }

  function startPolling() {
    schedulePoll(500);
  }

  function taskIdForJob(j: TransferJobEx) {
    return `transfer:${j.id}`;
  }

  function progressTextForJob(j: TransferJobEx) {
    // Force a final phase label based on state
    const phase =
      j.state === "done"
        ? "done"
        : j.state === "failed"
          ? "failed"
          : j.state === "canceled"
            ? "canceled"
            : (j.phase ? String(j.phase) : "");
  
    const re = rateEtaText(rateStats, j.id);
  
    let pct =
      typeof j.bytes === "number" &&
      typeof j.totalBytes === "number" &&
      j.totalBytes > 0
        ? Math.floor((j.bytes * 100) / j.totalBytes)
        : null;
  
    if (j.state === "done") pct = 100;
  
    // For final states, don't keep showing ETA/rate noise
    if (j.state === "done") {
      return pct != null ? `Done • ${pct}%` : "Done";
    }
    if (j.state === "failed") {
      return "Failed";
    }
    if (j.state === "canceled") {
      return "Canceled";
    }
  
    // Running/canceling text
    if (pct != null && phase) return `${phase}… ${pct}% • ${re}`;
    if (pct != null) return `${pct}% • ${re}`;
    if (phase) return `${phase}… • ${re}`;
    return re;
  }

    function syncTask(j: TransferJobEx) {
    const tid = taskIdForJob(j);
  
    let cur = typeof j.bytes === "number" ? j.bytes : null;
    const tot =
      typeof j.totalBytes === "number" && j.totalBytes > 0 ? j.totalBytes : null;
  
    // If the job is finished, force progress to 100% for UI consistency.
    // Also clamp displayed bytes to total when we know the total.
    if (j.state === "done") {
      if (tot != null) cur = tot;
    } else if (cur != null && tot != null) {
      // While running, never show more than total
      cur = Math.min(cur, tot);
    }
  
    let pct =
      cur != null && tot != null
        ? Math.max(0, Math.min(100, Math.round((cur * 100) / tot)))
        : null;
  
    if (j.state === "done") pct = 100;
  
    taskCenter.upsert({
      id: tid,
      kind: j.kind,
      name: j.name,
      state: j.state,
  
      progressCurrent: cur,
      progressTotal: tot,
      progressPct: pct,
  
      progressText: progressTextForJob(j),
  
      error: j.error || undefined,
  
      actions: {
        cancel: () => cancelJob(j.id),
        dismiss: () => dismiss(j.id),
      },
    });
  }
  

  
  function removeTaskForJob(id: string) {
    taskCenter.remove(`transfer:${id}`);
  }

  async function pollOnce() {
    if (pollRunning) {
      schedulePoll(500);
      return;
    }
    pollRunning = true;

    try {
      const active = transferJobs.value.filter(
        (j) =>
          (j.state === "running" || j.state === "canceling") &&
          typeof j.backendJobId === "string" &&
          j.backendJobId.length > 0
      );

      if (active.length === 0) {
        stopPolling();
        return;
      }

      const results = await Promise.all(
        active.map(async (j) => {
          const res = await deps.getDownloadJobStatus({ jobId: j.backendJobId! });
          return { j, res };
        })
      );

      for (const { j, res } of results) {
        const prevState = j.state;

        if (res.isErr()) {
          const msg = res.error.message || "Unknown error";

          const started = jobStartAt.get(j.backendJobId!) ?? Date.now();
          const ageMs = Date.now() - started;

          const lower = msg.toLowerCase();
          const looksNotFound =
            lower.includes("job not found") || lower.includes("not found");

          if (looksNotFound && ageMs < 4000) {
            // backend hasn't created the job file yet; keep polling
            continue;
          }

          j.state = "failed";
          j.error = msg;
          j.phase = j.phase || "transfer";
          syncTask(j);
          scheduleUi();

          if (prevState !== "failed") {
            pushNotification(
              new Notification(
                "Transfer failed",
                `Transfer failed: ${j.name} - ${msg}`,
                "error",
                5000
              )
            );
          }
          continue;
        }

        const s: any = res.value;

        // job "phase" is optional (we write it in python)
        if (typeof s.phase === "string") j.phase = s.phase;

        const newBytes = toNum(s.bytes);
        if (newBytes != null) j.bytes = newBytes;

        const tb = toNum(s.totalBytes);
        const sz = toNum(s.size);
        if (tb != null) j.totalBytes = tb;
        else if (sz != null) j.totalBytes = sz;

        if (typeof s.error === "string") j.error = s.error;

        // update rate/eta when we have bytes and total
        if (typeof j.bytes === "number") {
          const total = typeof j.totalBytes === "number" ? j.totalBytes : 0;
          updateRateAndEta(rateStats, j.id, j.bytes, total);
        }

        if (typeof s.state === "string") {
          // python writes: running/done/failed/canceled
          j.state = s.state;
        }

        // if we just entered a final state, cleanup
        if (j.state !== prevState && isFinalState(j.state)) {
          jobStartAt.delete(j.backendJobId!);
          rateStats.delete(j.id);
        }

        syncTask(j);
      }

      scheduleUi();
    } finally {
      pollRunning = false;

      if (
        transferJobs.value.some(
          (j) =>
            (j.state === "running" || j.state === "canceling") &&
            typeof j.backendJobId === "string" &&
            j.backendJobId.length > 0
        )
      ) {
        schedulePoll(500);
      } else {
        stopPolling();
      }
    }
  }

  function makeUniqueName(base: string, used: Set<string>) {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let i = 1;
    while (true) {
      const cand = `${stem} (${i})${ext}`;
      if (!used.has(cand)) {
        used.add(cand);
        return cand;
      }
      i += 1;
    }
  }

  function isPasteIntoSelfPrefix(srcPrefix: string, dstPrefix: string) {
    const s = normalizePrefixNoLead(srcPrefix);
    const d = normalizePrefixNoLead(dstPrefix);
    return d === s || d.startsWith(s);
  }

  async function pasteHere() {
    if (!deps.connectionId.value) return;
    if (!deps.clip.canPaste(deps.connectionId.value)) return;

    const dstBucket = deps.bucket.value;
    const dstBasePrefix = normalizePrefixNoLead(deps.prefix.value || "");
    const kind = deps.clip.kind; // "copy" | "cut"
    const srcItems = [...deps.clip.items];

    deps.setBusy?.(true);

    try {
      // 1) Plan
      const planned: PasteItem[] = [];
      const usedNames = new Set<string>();

      for (const it of srcItems) {
        if (it.type === "file") {
          const originalName = basenameFromKey(it.key);
          const name = makeUniqueName(originalName, usedNames);
          const dstKey = dstBasePrefix ? dstBasePrefix + name : name;

          if (it.bucket === dstBucket && dstKey === it.key) continue;

          planned.push({
            id: uid(),
            itemType: "file",
            srcBucket: it.bucket,
            srcKey: it.key,
            dstKey,
            name,
            step: "queued",
          });
        } else {
          const srcPrefix = normalizePrefixNoLead(it.prefix);
          const folderName = makeUniqueName(folderNameFromPrefix(it.prefix), usedNames);
          const dstPrefix = dstBasePrefix ? `${dstBasePrefix}${folderName}/` : `${folderName}/`;

          if (kind === "cut" && it.bucket === dstBucket && isPasteIntoSelfPrefix(srcPrefix, dstPrefix)) {
            pushNotification(
              new Notification(
                "Not Allowed",
                `Cannot move "${folderName}" into itself.`,
                "error",
                5000
              )
            );
            return;
          }

          if (it.bucket === dstBucket && srcPrefix === dstPrefix) continue;

          planned.push({
            id: uid(),
            itemType: "folder",
            srcBucket: it.bucket,
            srcKey: srcPrefix,
            dstKey: dstPrefix,
            name: folderName + "/",
            step: "queued",
          });
        }
      }

      pasteItems.value = planned;

      // 2) Execute sequentially (your current behavior)
      for (const p of pasteItems.value) {
        p.step = "copying";
        pasteItems.value = [...pasteItems.value];

        const transferId = uid();
        const backendJobId = uid(); // this is the one python uses for JOB_DIR status files
        jobStartAt.set(backendJobId, Date.now());

        const kindLabel = kind === "cut" ? "move" : "copy";
        const srcLabel = `${p.srcBucket}:${p.srcKey}`;
        const dstLabel = `${dstBucket}:${p.dstKey}`;

        const tj: TransferJobEx = {
          id: transferId,
          kind: kind === "cut" ? "move" : "copy",
          itemType: p.itemType,
          name: p.name,
          src: srcLabel,
          dst: dstLabel,
          state: "running",
          startedAt: Date.now(),

          backendJobId,
          bytes: 0,
          totalBytes: 0,
          phase: "starting",
        };

        transferJobs.value.push(tj);
        syncTask(tj);
        startPolling();

        try {
          const sameBucket = p.srcBucket === dstBucket;

          if (kind === "cut" && !sameBucket) {
            throw new Error("Move across buckets is not supported. Use Copy instead.");
          }

          if (p.itemType === "file") {
            if (kind === "cut") {
              const job = deps.renameObjectStreamed({
                connectionId: deps.connectionId.value,
                bucket: dstBucket,
                srcKey: p.srcKey,
                dstKey: p.dstKey,
                concurrency: 6,
                onEvent: (ev) => {
                  if (ev.type === "start") {
                    tj.phase = "renaming";
                    syncTask(tj);
                    scheduleUi();
                  }
                  if (ev.type === "progress") {
                    tj.phase = "renaming";
                    const b = toNum((ev as any).bytesCopied);
                    const sz = toNum((ev as any).size);
                    if (b != null) tj.bytes = b;
                    if (sz != null) tj.totalBytes = sz;
                    if (typeof tj.bytes === "number") {
                      updateRateAndEta(rateStats, tj.id, tj.bytes, tj.totalBytes || 0);
                    }
                    syncTask(tj);
                    scheduleUi();
                  }
                  if (ev.type === "result") {
                    if ((ev as any).ok) {
                      tj.state = "done";
                      tj.finishedAt = Date.now();
                    } else {
                      tj.state = "failed";
                      tj.error = (ev as any).error || "Move failed";
                      tj.finishedAt = Date.now();
                    }
                    syncTask(tj);
                    scheduleUi();
                  }
                },
              });

              const res = await job.run;
              if (res.isErr()) throw new Error(res.error.message);
            } else {
              tj.phase = "copying";
              syncTask(tj);

              const res = await deps.copyObject({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcKey: p.srcKey,
                dstBucket,
                dstKey: p.dstKey,
                concurrency: 6,
                jobId: backendJobId,
              } as any);

              if (res.isErr()) throw new Error(res.error.message);
            }
          } else {
            // folder
            if (kind === "cut") {
              tj.phase = "moving";
              syncTask(tj);

              const res = await deps.movePrefix({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcPrefix: p.srcKey,
                dstBucket,
                dstPrefix: p.dstKey,
                concurrency: 6,
                jobId: backendJobId,
              } as any);

              if (res.isErr()) throw new Error(res.error.message);
            } else {
              tj.phase = "copying";
              syncTask(tj);

              const res = await deps.copyPrefix({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcPrefix: p.srcKey,
                dstBucket,
                dstPrefix: p.dstKey,
                concurrency: 6,
                jobId: backendJobId,
              } as any);

              if (res.isErr()) throw new Error(res.error.message);
            }
          }

          // success
          p.step = "done";

          // created at destination (only update UI if destination is current view)
          if (p.itemType === "file") deps.onCreated?.({ type: "file", key: p.dstKey });
          else deps.onCreated?.({ type: "folder", prefix: p.dstKey });

          if (kind === "cut" && p.srcBucket === dstBucket) {
            if (p.itemType === "file") deps.onDeleted?.({ type: "file", key: p.srcKey });
            else deps.onDeleted?.({ type: "folder", prefix: p.srcKey });
          }

          pasteItems.value = [...pasteItems.value];

          tj.state = "done";
          tj.finishedAt = Date.now();
          tj.phase = tj.phase || "done";
          syncTask(tj);
          scheduleUi();

          pushNotification(
            new Notification(
              "Transfer completed",
              `Transfer ${kindLabel} ${p.itemType} completed: ${p.name} (${srcLabel} → ${dstLabel})`,
              "success",
              5000
            )
          );
        } catch (e: any) {
          const msg = e?.message || "Paste failed";

          p.step = "failed";
          p.error = msg;
          pasteItems.value = [...pasteItems.value];

          tj.state = "failed";
          tj.error = msg;
          tj.finishedAt = Date.now();
          syncTask(tj);
          scheduleUi();

          pushNotification(
            new Notification(
              "Transfer failed",
              `Transfer ${kindLabel} ${p.itemType} failed: ${p.name} (${srcLabel} → ${dstLabel}) - ${msg}`,
              "error",
              5000
            )
          );

          return;
        } finally {
          // cleanup once finished
          if (isFinalState(tj.state)) {
            jobStartAt.delete(tj.backendJobId || "");
            rateStats.delete(tj.id);
          }
        }
      }

      // 3) Clear clipboard if cut
      if (deps.clip.kind === "cut") deps.clip.clear();
    } finally {
      deps.setBusy?.(false);
    }
  }

  function dismiss(id: string) {
    // transferJobs
    const tj = transferJobs.value.find((x) => x.id === id);
    if (tj) {
      if (tj.state === "running" || tj.state === "canceling") return;
      transferJobs.value = transferJobs.value.filter((x) => x.id !== id);
      rateStats.delete(id);
      removeTaskForJob(id);
      scheduleUi();
      return;
    }

    // pasteItems
    const p = pasteItems.value.find((x) => x.id === id);
    if (p) {
      if (p.step === "queued" || p.step === "copying") return;
      pasteItems.value = pasteItems.value.filter((x) => x.id !== id);
    }
  }

  async function cancelJob(id: string) {
    const j = transferJobs.value.find((x) => x.id === id);
    if (!j) return;

    if (j.state !== "running" && j.state !== "canceling") return;

    j.state = "canceling";
    j.error = "Canceled";
    j.phase = j.phase || "canceling";
    syncTask(j);
    scheduleUi();

    // If it's a job-based transfer, actually cancel the python process
    if (j.backendJobId) {
      startPolling();
      const res = await deps.cancelDownloadJob({ jobId: j.backendJobId });
      if (res.isErr()) {
        // keep as running if cancel failed
        j.state = "running";
        j.error = res.error.message;
        syncTask(j);
        scheduleUi();
        return;
      }
    }

    // Also try to cancel matching paste item (UI)
    const p = pasteItems.value.find((x) => x.name === j.name && x.step === "copying");
    if (p) {
      p.step = "canceled";
      pasteItems.value = [...pasteItems.value];
    }
  }

  onBeforeUnmount(() => {
    stopPolling();
    if (uiTimer != null) window.clearTimeout(uiTimer);
    uiTimer = null;
  });

  return {
    // transfer jobs
    transferJobs,
    transferBusy,

    // paste progress
    pasteItems,
    pasteBusy,
    pasteTotal,
    pasteDone,
    pastePct,

    // actions
    pasteHere,
    dismiss,
    cancelJob,
  };
}
