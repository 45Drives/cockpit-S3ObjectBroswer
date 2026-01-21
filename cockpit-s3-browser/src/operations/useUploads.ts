// src/operations/useUploads.ts
import { computed, onBeforeUnmount, ref } from "vue";
import type { UploadItem } from "../types";
import type { uploadObjectFromStdinStreamed as uploadObjectFromStdinStreamedFn } from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from '@45drives/houston-common-ui';


type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  uploadObjectFromStdinStreamed: typeof uploadObjectFromStdinStreamedFn;

  refresh?: () => Promise<void> | void;
  setError?: (msg: string) => void;
  onUploaded?: (key: string) => void;
};


export function useUploads(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const uploadBusy = ref(false);
  const uploadProgress = ref<{ bytes: number; size: number; filename: string } | null>(null);
  const uploadCancel = ref<null | (() => void)>(null);

  const uploadItems = ref<UploadItem[]>([]);
  const uploadCancelAll = ref<null | (() => void)>(null);

  const uploadPct = computed(() => {
    const p = uploadProgress.value;
    if (!p || p.size <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
  });

  const overallBytes = computed(() =>
    uploadItems.value.reduce((s, u) => s + (u.file.size || 0), 0),
  );

  const overallSent = computed(() =>
    uploadItems.value.reduce((s, u) => s + (u.bytes || 0), 0),
  );

  const overallPct = computed(() => {
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
      new Notification("Upload completed",`Uploaded ${name} to ${bucket}:${key}`,"success",5000
      )
    );
    return;
  }

  if (state === "canceled") {
    pushNotification(
      new Notification("Upload canceled",`Canceled ${name} (${bucket}:${key})`,"error",5000
      )
    );
    return;
  }

  // failed
  const msg = u.error || "Upload failed";
  pushNotification(
    new Notification("Upload failed",`Failed ${name} (${bucket}:${key}) - ${msg}`,"error",5000
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
      return total > 0 ? `${u.bytes} / ${total} bytes` : `${u.bytes} bytes`;
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
        const rel = ((f as any).webkitRelativePath as string | undefined) || f.name;
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
    deps.setError?.("");
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

    uploadProgress.value = { filename: file.name, bytes: item.bytes, size: file.size };

    const job = deps.uploadObjectFromStdinStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      key: item.dstKey,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      onEvent: (ev) => {
        if (ev.type === "progress") {
          const b = Number(ev.bytesRead ?? 0);
          item.bytes = b;
          uploadProgress.value = { filename: file.name, bytes: b, size: file.size };
          upsertTaskForItem(item);
        } else if (ev.type === "result") {
          if (!ev.ok) {
            item.status = "failed";
            item.error = ev.error || "Upload failed";
            upsertTaskForItem(item);
          }
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
    };

    uploadCancel.value = () => item.cancel?.();

    const chunkSize = 1024 * 1024;
    let offset = 0;

    try {
      while (offset < file.size) {
        if (item.canceled) throw new Error("Canceled");

        const end = Math.min(file.size, offset + chunkSize);
        const ab = await file.slice(offset, end).arrayBuffer();
        job.writeChunk(new Uint8Array(ab));
        offset = end;
      }

      job.end();

      const res = await job.run;
      if (res.isErr()) throw new Error(res.error.message);
    } finally {
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

  function dismiss(id: string) {
    const it = uploadItems.value.find((x) => x.id === id);
    if (!it) return;

    // don’t allow dismiss while active
    if (isActiveStatus(it.status)) return;

    uploadItems.value = uploadItems.value.filter((x) => x.id !== id);
    removeTask(id);
  }

  function clearFinished() {
    const keep = uploadItems.value.filter((x) => isActiveStatus(x.status));
    const removed = uploadItems.value.filter((x) => !isActiveStatus(x.status));

    uploadItems.value = keep;
    for (const u of removed) removeTask(u.id);
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
