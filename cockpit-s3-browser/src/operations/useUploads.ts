// src/operations/useUploads.ts
import { computed, ref } from "vue";
import type { RateStats, UploadItem } from "../types";
import type { uploadObjectFromStdinStreamed as uploadObjectFromStdinStreamedFn } from "../lib/s3Objects";
import { rateEtaText, uid, updateRateAndEta } from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  uploadObjectFromStdinStreamed: typeof uploadObjectFromStdinStreamedFn;

  refresh?: () => Promise<void> | void;
  onUploaded?: (key: string) => void;
  onBatchFinished?: (info: {
    isBulk: boolean;
    total: number;
    done: number;
    failed: number;
    canceled: boolean;
  }) => void;
};

const BULK_UPLOAD_THRESHOLD = 50; // still used for pickFiles only

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

  // Bulk/batch state (per hook instance)
  const currentIsBulk = ref(false);
  const bulkTaskId = ref<string | null>(null);
  const bulkTotalBytes = ref(0);

  let bulkUploadedBytes = 0;
  let bulkCompleted = 0;
  let bulkFailed = 0;

  function resetBulkState() {
    bulkTaskId.value = null;
    bulkTotalBytes.value = 0;
    bulkUploadedBytes = 0;
    bulkCompleted = 0;
    bulkFailed = 0;
  }

  function maybeUpsertItemTask(u: UploadItem, isBulk: boolean) {
    if (isBulk) return;
    upsertTaskForItem(u);
  }

  function upsertBulkTask(
    name: string,
    state: "running" | "done" | "failed" | "canceled" | "canceling",
    text?: string
  ) {
    const id = bulkTaskId.value;
    if (!id) return;

    taskCenter.upsert({
      id,
      kind: "upload",
      name,
      state,
      progressCurrent:
        bulkTotalBytes.value > 0
          ? Math.min(bulkUploadedBytes, bulkTotalBytes.value)
          : 0,
      progressTotal: bulkTotalBytes.value > 0 ? bulkTotalBytes.value : null,
      progressPct:
        bulkTotalBytes.value > 0
          ? Math.max(
              0,
              Math.min(
                100,
                Math.floor((bulkUploadedBytes * 100) / bulkTotalBytes.value)
              )
            )
          : null,
      progressText: text || "",
      actions:
        state === "running" || state === "canceling"
          ? { cancel: () => uploadCancelAll.value?.() }
          : { dismiss: () => taskCenter.remove(id) },
    });
  }

  const uploadPct = computed(() => {
    const p = uploadProgress.value;
    if (!p || p.size <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
  });

  // Avoid expensive reducers in bulk mode (and for folder bulk)
  const overallBytes = computed(() => {
    if (uploadItems.value.length >= BULK_UPLOAD_THRESHOLD) return 0;
    return uploadItems.value.reduce((s, u) => s + (u.file.size || 0), 0);
  });

  const overallSent = computed(() => {
    if (uploadItems.value.length >= BULK_UPLOAD_THRESHOLD) return 0;
    return uploadItems.value.reduce((s, u) => s + (u.bytes || 0), 0);
  });

  const overallPct = computed(() => {
    if (uploadItems.value.length >= BULK_UPLOAD_THRESHOLD) return null;
    const t = overallBytes.value;
    if (!t) return null;
    return Math.max(0, Math.min(100, Math.floor((overallSent.value / t) * 100)));
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

  function notifyBatchSummary(opts: {
    total: number;
    done: number;
    failed: number;
    canceled: boolean;
  }) {
    if (opts.total <= 1) return;

    if (opts.canceled) {
      pushNotification(
        new Notification(
          "Upload canceled",
          `Canceled upload. ${opts.done} done, ${opts.failed} failed, ${opts.total} total.`,
          "error",
          5000
        )
      );
      return;
    }

    if (opts.failed > 0) {
      pushNotification(
        new Notification(
          "Upload finished with errors",
          `Uploaded ${opts.done} of ${opts.total} files (${opts.failed} failed).`,
          "error",
          5000
        )
      );
      return;
    }

    pushNotification(
      new Notification(
        "Upload completed",
        `Uploaded ${opts.total} files.`,
        "success",
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

  function upsertTaskForItem(u: UploadItem) {
    const total = u.file.size || 0;
    const cur = typeof u.bytes === "number" ? u.bytes : 0;

    taskCenter.upsert({
      id: u.id,
      kind: "upload",
      name: u.file.name,
      state: taskStateForStatus(u.status),
      progressText: rateEtaText(rateStats, u.id),
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

      currentIsBulk.value = false;
      resetBulkState();

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
      await uploadManyWithPool(conc, { isBulk: false });
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

      // Folder uploads always use a single TaskCenter entry.
      const isBulk = true;
      const isBatch = true;

      currentIsBulk.value = isBulk;
      resetBulkState();

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

      bulkTaskId.value = uid();
      bulkTotalBytes.value = files.reduce((s, f) => s + (f.size || 0), 0);

      upsertBulkTask(
        `Uploading folder (${files.length} files)`,
        "running",
        "Starting…"
      );

      const conc = chooseSafeConcurrency(files);
      await uploadManyWithPool(conc, { isBulk, isBatch });
    };

    input.click();
  }

  async function uploadManyWithPool(
    limit: number,
    opts?: { isBulk?: boolean; isBatch?: boolean }
  ) {
    const isBulk = Boolean(opts?.isBulk);
    const isBatch = Boolean(opts?.isBatch);
    const isMulti = uploadItems.value.length > 1;

    uploadBusy.value = true;
    uploadProgress.value = null;
    uploadCancel.value = null;

    let canceledAll = false;

    uploadCancelAll.value = () => {
      canceledAll = true;

      if (isBulk && bulkTaskId.value) {
        upsertBulkTask(
          `Uploading ${uploadItems.value.length} files`,
          "canceling",
          "Canceling…"
        );
      }

      for (const u of uploadItems.value) {
        if (u.status === "uploading") {
          try {
            u.cancel?.();
          } catch {}
        }

        if (u.status === "queued") {
          u.canceled = true;
          u.status = "canceled";
          maybeUpsertItemTask(u, isBulk);
          if (!isBulk && !isBatch && !isMulti) notify(u, "canceled");
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
        maybeUpsertItemTask(item, isBulk);

        try {
          await uploadOneItemViaStdin(item, isBulk);

          if (!item.canceled) {
            item.status = "done";
            maybeUpsertItemTask(item, isBulk);

            // Track batch counts always for accurate onBatchFinished
            bulkCompleted += 1;

            if (isBulk) {
              upsertBulkTask(
                `Uploading ${uploadItems.value.length} files`,
                "running",
                `${bulkCompleted} done, ${bulkFailed} failed`
              );
            } else {
              if (!isBatch && !isMulti) notify(item, "done");
            }

            if (!isBatch) deps.onUploaded?.(item.dstKey);
          } else {
            item.status = "canceled";
            maybeUpsertItemTask(item, isBulk);
          }
        } catch (e: any) {
          if (!item.canceled) {
            item.status = "failed";
            item.error = e?.message || "Upload failed";
            maybeUpsertItemTask(item, isBulk);

            // Track batch counts always for accurate onBatchFinished
            bulkFailed += 1;

            if (isBulk) {
              upsertBulkTask(
                `Uploading ${uploadItems.value.length} files`,
                "running",
                `${bulkCompleted} done, ${bulkFailed} failed`
              );
            } else {
              if (!isBatch) notify(item, "failed");
            }
          } else {
            item.status = "canceled";
            maybeUpsertItemTask(item, isBulk);
            if (!isBulk && !isBatch && !isMulti) notify(item, "canceled");
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
      if (isBulk && bulkTaskId.value) {
        if (canceledAll) {
          upsertBulkTask(
            `Upload canceled (${uploadItems.value.length} files)`,
            "canceled",
            `${bulkCompleted} done, ${bulkFailed} failed`
          );
        } else if (bulkFailed > 0) {
          upsertBulkTask(
            `Uploaded ${bulkCompleted} files (${bulkFailed} failed)`,
            "failed",
            `${bulkCompleted} done, ${bulkFailed} failed`
          );
        } else {
          upsertBulkTask(
            `Uploaded ${bulkCompleted} files`,
            "done",
            `${bulkCompleted} files uploaded`
          );
        }
      }

      deps.onBatchFinished?.({
        isBulk: isBulk,
        total: uploadItems.value.length,
        done: bulkCompleted,
        failed: bulkFailed,
        canceled: canceledAll,
      });

      // Single summary notification for multi-file runs (folder or multi-select)
      if (isMulti) {
        notifyBatchSummary({
          total: uploadItems.value.length,
          done: bulkCompleted,
          failed: bulkFailed,
          canceled: canceledAll,
        });
      }

      uploadBusy.value = false;
      uploadCancelAll.value = null;
      uploadCancel.value = null;
      uploadProgress.value = null;
    }
  }

  async function uploadOneItemViaStdin(item: UploadItem, isBulk: boolean) {
    const file = item.file;
    maybeUpsertItemTask(item, isBulk);

    uploadProgress.value = {
      filename: file.name,
      bytes: item.bytes,
      size: file.size,
    };

    let bytesSent = 0;
    let bytesReadAck = 0;

    const CHUNK_SIZE = 8 * 1024 * 1024;
    const MAX_INFLIGHT = CHUNK_SIZE * 3;

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

    let pendingUiBytes: number | null = null;
    let uiTimer: number | null = null;

    const flushUi = () => {
      uiTimer = null;
      const b = pendingUiBytes;
      if (b == null) return;
      pendingUiBytes = null;

      item.bytes = b;
      uploadProgress.value = { filename: file.name, bytes: b, size: file.size };
      maybeUpsertItemTask(item, isBulk);
    };

    const scheduleUi = (b: number) => {
      pendingUiBytes = b;
      if (uiTimer != null) return;
      uiTimer = window.setTimeout(flushUi, 250);
    };

    let lastAck = 0;

    const job = deps.uploadObjectFromStdinStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      key: item.dstKey,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      onEvent: (ev) => {
        if (ev.type === "progress") {
          const b = Number((ev as any).bytesRead ?? 0);
          if (Number.isFinite(b) && b >= 0) {
            bytesReadAck = b;

            const delta = Math.max(0, b - lastAck);
            lastAck = b;

            updateRateAndEta(rateStats, item.id, b, file.size);

            scheduleUi(b);

            if (isBulk && bulkTaskId.value) {
              bulkUploadedBytes += delta;
              upsertBulkTask(
                `Uploading ${uploadItems.value.length} files`,
                "running",
                `${bulkCompleted} done, ${bulkFailed} failed`
              );
            }

            signalAck();
          }
          return;
        }

        if (ev.type === "result") {
          if (!(ev as any).ok) {
            item.status = "failed";
            item.error = (ev as any).error || "Upload failed";
            maybeUpsertItemTask(item, isBulk);
            rateStats.delete(item.id);
          }
          signalAck();
        }
      },
    });

    item.cancel = () => {
      item.canceled = true;
      item.status = "canceled";
      maybeUpsertItemTask(item, isBulk);
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

    const isBulk = currentIsBulk.value;

    if (it.status === "queued") {
      it.canceled = true;
      it.status = "canceled";
      maybeUpsertItemTask(it, isBulk);
      if (!isBulk) notify(it, "canceled");
      return;
    }

    if (it.status === "uploading") {
      try {
        it.cancel?.();
      } catch {}
      maybeUpsertItemTask(it, isBulk);
      return;
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

  return {
    uploadBusy,
    uploadItems,
    uploadProgress,
    uploadCancel,
    uploadCancelAll,

    uploadPct,
    overallPct,

    pickFiles,
    pickFolder,
    cancelAll,
    cancelById,
    dismiss,
    clearFinished,
  };
}
