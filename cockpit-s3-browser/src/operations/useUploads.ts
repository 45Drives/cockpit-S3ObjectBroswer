// src/operations/useUploads.ts
import { computed, onBeforeUnmount, ref } from "vue";
import type { UploadItem } from "../types";
import type { uploadObjectFromStdinStreamed as uploadObjectFromStdinStreamedFn } from "../lib/s3Objects";
import { uid } from "../lib/helpers";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  uploadObjectFromStdinStreamed: typeof uploadObjectFromStdinStreamedFn;

  refresh?: () => Promise<void> | void;
  setError?: (msg: string) => void;
};

export function useUploads(deps: Deps) {
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
        if (u.status === "uploading") u.cancel?.();
        if (u.status === "queued") {
          u.canceled = true;
          u.status = "canceled";
        }
      }

      uploadCancel.value?.();
    };

    async function worker() {
      while (true) {
        if (canceledAll) return;

        const item = nextQueuedItem();
        if (!item) return;

        item.status = "uploading";
        item.error = undefined;

        try {
          await uploadOneItemViaStdin(item);
          if (!item.canceled) item.status = "done";
        } catch (e: any) {
          if (!item.canceled) {
            item.status = "failed";
            item.error = e?.message || "Upload failed";
          }
        }
      }
    }

    try {
      const n = Math.max(1, Math.min(limit, uploadItems.value.length));
      await Promise.all(Array.from({ length: n }, () => worker()));
      await deps.refresh?.();
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
        } else if (ev.type === "result") {
          if (!ev.ok) {
            item.status = "failed";
            item.error = ev.error || "Upload failed";
          }
        }
      },
    });

    item.cancel = () => {
      item.canceled = true;
      item.status = "canceled";
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

  onBeforeUnmount(() => {
    // avoid a dangling "Cancel" callback if user navigates away
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
  };
}
