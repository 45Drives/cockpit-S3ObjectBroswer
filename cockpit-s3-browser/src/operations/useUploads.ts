// src/operations/useUploads.ts
import { computed, onBeforeUnmount, ref } from "vue";
import type { UploadItem } from "../types";
import type { uploadObjectFromStdinStreamed as uploadObjectFromStdinStreamedFn } from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  uploadObjectFromStdinStreamed: typeof uploadObjectFromStdinStreamedFn;

  refresh?: () => Promise<void> | void;
  onUploaded?: (key: string) => void;
};
type RateStats = {
  lastT: number;
  lastB: number;
  rateAvg: number | null; // bytes/sec
  etaSec: number | null; // seconds
};

export function useUploads(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const uploadBusy = ref(false);
  const uploadProgress = ref<{
    bytes: number;
    size: number;
    filename: string;
  } | null>(null);
  const uploadCancel = ref<null | (() => void)>(null);

  const uploadItems = ref<UploadItem[]>([]);
  const uploadCancelAll = ref<null | (() => void)>(null);
  const rateStats = new Map<string, RateStats>();

  const uploadPct = computed(() => {
    const p = uploadProgress.value;
    if (!p || p.size <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
  });

  const overallBytes = computed(() =>
    uploadItems.value.reduce((s, u) => s + (u.file.size || 0), 0)
  );

  const overallSent = computed(() =>
    uploadItems.value.reduce((s, u) => s + (u.bytes || 0), 0)
  );

  const overallPct = computed(() => {
    const t = overallBytes.value;
    if (!t) return null;
    return Math.max(
      0,
      Math.min(100, Math.floor((overallSent.value / t) * 100))
    );
  });

  const notified = new Set<string>();

  function notify(u: UploadItem, state: "done" | "failed" | "canceled") {
    if (notified.has(u.id)) return;
    notified.add(u.id);

    const bucket = deps.bucket.value;
    const key = u.dstKey;
    const name = u.file.name;

    if (state === "done") {
      pushNotification(
        new Notification(
          "Upload completed",
          `Uploaded ${name} to ${bucket}:${key}`,
          "success",
          5000
        )
      );
      return;
    }

    if (state === "canceled") {
      pushNotification(
        new Notification(
          "Upload canceled",
          `Canceled ${name} (${bucket}:${key})`,
          "error",
          5000
        )
      );
      return;
    }

    // failed
    const msg = u.error || "Upload failed";
    pushNotification(
      new Notification(
        "Upload failed",
        `Failed ${name} (${bucket}:${key}) - ${msg}`,
        "error",
        5000
      )
    );
  }

  function chooseSafeConcurrency(files: File[]) {
    const sizes = files.map((f) => f.size || 0);
    const total = sizes.reduce((a, b) => a + b, 0);
    const max = sizes.reduce((a, b) => Math.max(a, b), 0);
    const count = files.length;

    const MiB = 1024 * 1024;

    if (max >= 512 * MiB) return 2;
    if (count >= 6 && total <= 512 * MiB) return 3;
    return 2;
  }

  function nextQueuedItem(): UploadItem | null {
    return uploadItems.value.find((u) => u.status === "queued") || null;
  }

  function anyUploading(): UploadItem | null {
    return uploadItems.value.find((u) => u.status === "uploading") || null;
  }

  function isActiveStatus(s: UploadItem["status"]) {
    return s === "queued" || s === "uploading";
  }

  function taskStateForStatus(s: UploadItem["status"]) {
    switch (s) {
      case "queued":
      case "uploading":
        return "running" as const;
      case "done":
        return "done" as const;
      case "failed":
        return "failed" as const;
      case "canceled":
        return "canceled" as const;
      default:
        return "running" as const;
    }
  }

  function progressTextForItem(u: UploadItem) {
    if (u.status === "uploading") {
      const total = u.file.size || 0;
      const cur = typeof u.bytes === "number" ? u.bytes : 0;

      const st = rateStats.get(u.id);
      const rateTxt = st?.rateAvg != null ? formatBytesPerSec(st.rateAvg) : "—";
      const etaTxt  = st?.etaSec  != null ? formatEta(st.etaSec)  : "—";
      if (total > 0)
        return `${rateTxt} • ETA ${etaTxt}`;
      return `${cur} bytes • ${rateTxt} • ETA ${etaTxt}`;
    }

    if (u.status === "queued") return "Queued";
    return undefined;
  }

  function upsertTaskForItem(u: UploadItem) {
    const total = u.file.size || 0;
    const cur = typeof u.bytes === "number" ? u.bytes : 0;

    taskCenter.upsert({
      id: u.id,
      kind: "upload",
      name: u.file.name,
      state: taskStateForStatus(u.status),

      progressText: progressTextForItem(u),

      progressCurrent: total > 0 ? cur : null,
      progressTotal: total > 0 ? total : null,
      progressPct:
        total > 0
          ? Math.max(0, Math.min(100, Math.round((cur * 100) / total)))
          : null,

      error: u.error,
      actions: {
        cancel: () => cancelById(u.id),
        dismiss: () => dismiss(u.id),
      },
    });
  }

  function removeTask(id: string) {
    taskCenter.remove(id);
  }

  async function pickFiles() {
    if (!deps.connectionId.value || !deps.bucket.value) return;

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;

    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;

      const base = deps.prefix.value || "";

      uploadItems.value = files.map((f) => ({
        id: uid(),
        file: f,
        dstKey: base + f.name,
        bytes: 0,
        status: "queued",
        canceled: false,
      }));

      for (const u of uploadItems.value) upsertTaskForItem(u);

      const conc = chooseSafeConcurrency(files);
      await uploadManyWithPool(conc);
    };

    input.click();
  }

  async function pickFolder() {
    if (!deps.connectionId.value || !deps.bucket.value) return;

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");

    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;

      const base = deps.prefix.value || "";

      uploadItems.value = files.map((f) => {
        const rel =
          ((f as any).webkitRelativePath as string | undefined) || f.name;
        const relNorm = rel.replace(/\\/g, "/").replace(/^\/+/, "");

        return {
          id: uid(),
          file: f,
          dstKey: base + relNorm,
          bytes: 0,
          status: "queued",
          canceled: false,
        } satisfies UploadItem;
      });

      for (const u of uploadItems.value) upsertTaskForItem(u);

      const conc = chooseSafeConcurrency(files);
      await uploadManyWithPool(conc);
    };

    input.click();
  }

  async function uploadManyWithPool(limit: number) {
    uploadBusy.value = true;
    uploadProgress.value = null;
    uploadCancel.value = null;

    let canceledAll = false;

    uploadCancelAll.value = () => {
      canceledAll = true;

      for (const u of uploadItems.value) {
        if (u.status === "uploading") {
          try {
            u.cancel?.();
          } catch {}
        }

        if (u.status === "queued") {
          u.canceled = true;
          u.status = "canceled";
          upsertTaskForItem(u);
          notify(u, "canceled");
        }
      }

      try {
        uploadCancel.value?.();
      } catch {}
    };

    async function worker() {
      while (true) {
        if (canceledAll) return;

        const item = nextQueuedItem();
        if (!item) return;

        item.status = "uploading";
        item.error = undefined;
        upsertTaskForItem(item);

        try {
          await uploadOneItemViaStdin(item);

          if (!item.canceled) {
            item.status = "done";
            upsertTaskForItem(item);
            notify(item, "done");
            deps.onUploaded?.(item.dstKey);
          } else {
            item.status = "canceled";
            upsertTaskForItem(item);
          }
        } catch (e: any) {
          if (!item.canceled) {
            item.status = "failed";
            item.error = e?.message || "Upload failed";
            upsertTaskForItem(item);
            notify(item, "failed");
          } else {
            item.status = "canceled";
            upsertTaskForItem(item);
            notify(item, "canceled");
          }
        } finally {
          rateStats.delete(item.id);
        }
      }
    }

    try {
      const n = Math.max(1, Math.min(limit, uploadItems.value.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
    } finally {
      uploadBusy.value = false;
      uploadCancelAll.value = null;
      uploadCancel.value = null;
      uploadProgress.value = null;
    }
  }

  async function uploadOneItemViaStdin(item: UploadItem) {
    const file = item.file;
    upsertTaskForItem(item);

    uploadProgress.value = {
      filename: file.name,
      bytes: item.bytes,
      size: file.size,
    };

    // Backpressure tracking
    let bytesSent = 0;
    let bytesReadAck = 0;

    // If inflight grows beyond this, pause feeding stdin until we get more progress acks.
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB (reduce overhead vs 1 MiB)
    const MAX_INFLIGHT = CHUNK_SIZE * 3; // allow some buffering (tweak 2-6 chunks)

    // A simple "wait until progress arrives" primitive
    let unblock: null | (() => void) = null;
    const waitForAck = () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      });
    const signalAck = () => {
      const fn = unblock;
      unblock = null;
      if (fn) fn();
    };

    // Throttle UI updates so progress events don't spam Vue/store
    let pendingUiBytes: number | null = null;
    let uiTimer: number | null = null;

    const flushUi = () => {
      uiTimer = null;
      const b = pendingUiBytes;
      if (b == null) return;
      pendingUiBytes = null;

      item.bytes = b;
      uploadProgress.value = { filename: file.name, bytes: b, size: file.size };
      upsertTaskForItem(item);
    };

    const scheduleUi = (b: number) => {
      pendingUiBytes = b;
      if (uiTimer != null) return;
      uiTimer = window.setTimeout(flushUi, 150); // ~6-7 UI updates/sec
    };

    const job = deps.uploadObjectFromStdinStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      key: item.dstKey,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      onEvent: (ev) => {
        if (ev.type === "progress") {
          const b = Number(ev.bytesRead ?? 0);
          if (Number.isFinite(b) && b >= 0) {
            bytesReadAck = b;
            updateRateAndEta(item.id, b, file.size);
            scheduleUi(b);
            signalAck();
          }
          return;
        }

        if (ev.type === "result") {
          if (!ev.ok) {
            item.status = "failed";
            item.error = ev.error || "Upload failed";
            upsertTaskForItem(item);
            rateStats.delete(item.id);
          }
          // Wake any waiter so the loop can exit promptly.
          signalAck();
        }
      },
    });

    item.cancel = () => {
      item.canceled = true;
      item.status = "canceled";
      upsertTaskForItem(item);
      try {
        job.cancel();
      } catch {}
      signalAck();
      rateStats.delete(item.id);
    };

    uploadCancel.value = () => item.cancel?.();

    let offset = 0;

    try {
      while (offset < file.size) {
        if (item.canceled) throw new Error("Canceled");

        // Backpressure gate: if too much inflight, wait for server to read more
        while (!item.canceled && bytesSent - bytesReadAck > MAX_INFLIGHT) {
          await waitForAck();
        }
        if (item.canceled) throw new Error("Canceled");

        const end = Math.min(file.size, offset + CHUNK_SIZE);
        const ab = await file.slice(offset, end).arrayBuffer();

        const chunk = new Uint8Array(ab);
        job.writeChunk(chunk);

        bytesSent += chunk.byteLength;
        offset = end;
      }

      job.end();

      const res = await job.run;
      if (res.isErr()) throw new Error(res.error.message);

      // Ensure final UI flush if we have pending bytes
      flushUi();
    } finally {
      if (uiTimer != null) window.clearTimeout(uiTimer);
      unblock = null;

      const still = anyUploading();
      if (!still) uploadProgress.value = null;
    }
  }

  function cancelAll() {
    uploadCancelAll.value?.();
  }

  function cancelById(id: string) {
    const it = uploadItems.value.find((x) => x.id === id);
    if (!it) return;

    // queued: mark canceled immediately
    if (it.status === "queued") {
      it.canceled = true;
      it.status = "canceled";
      upsertTaskForItem(it);
      notify(it, "canceled");
      return;
    }

    // uploading: invoke per-item cancel handler
    if (it.status === "uploading") {
      try {
        it.cancel?.();
      } catch {}
      upsertTaskForItem(it);
      return;
    }

    // done/failed/canceled: nothing
  }

  function formatBytesPerSec(bps: number) {
    if (!Number.isFinite(bps) || bps <= 0) return "—";
    const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
    let u = 0;
    let v = bps;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function formatEta(sec: number) {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function updateRateAndEta(
    uploadId: string,
    currentBytes: number,
    totalBytes: number
  ) {
    const now = performance.now();
    const st = rateStats.get(uploadId);

    if (!st) {
      rateStats.set(uploadId, {
        lastT: now,
        lastB: currentBytes,
        rateAvg: null,
        etaSec: null,
      });
      return;
    }

    const dtMs = now - st.lastT;
    const db = currentBytes - st.lastB;

    st.lastT = now;
    st.lastB = currentBytes;

    if (dtMs <= 0 || db < 0) return;

    const rate = (1000 * db) / dtMs; // bytes/sec
    const alpha = 0.125; // same style as Navigator code
    st.rateAvg =
      st.rateAvg == null ? rate : alpha * rate + (1 - alpha) * st.rateAvg;

    if (st.rateAvg && st.rateAvg > 1 && totalBytes > 0) {
      st.etaSec = (totalBytes - currentBytes) / st.rateAvg;
    } else {
      st.etaSec = null;
    }
  }
  function dismiss(id: string) {
    const it = uploadItems.value.find((x) => x.id === id);
    if (!it) return;
    if (isActiveStatus(it.status)) return;

    uploadItems.value = uploadItems.value.filter((x) => x.id !== id);
    rateStats.delete(id);
    removeTask(id);
  }

  function clearFinished() {
    const keep = uploadItems.value.filter((x) => isActiveStatus(x.status));
    const removed = uploadItems.value.filter((x) => !isActiveStatus(x.status));

    uploadItems.value = keep;
    for (const u of removed) {
      rateStats.delete(u.id);
      removeTask(u.id);
    }
  }

  onBeforeUnmount(() => {
    try {
      cancelAll();
    } catch {}
  });

  return {
    // state
    uploadBusy,
    uploadItems,
    uploadProgress,
    uploadCancel,
    uploadCancelAll,

    // derived
    uploadPct,
    overallPct,

    // actions
    pickFiles,
    pickFolder,
    cancelAll,
    cancelById,
    dismiss,
    clearFinished,
  };
}
