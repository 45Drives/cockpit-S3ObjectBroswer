// src/operations/useDownloads.ts
import { computed, onBeforeUnmount, ref } from "vue";
import type { DownloadJob, DownloadState, Row, FolderRow, FileRow } from "../types";
import type {
  downloadObject as downloadObjectFn,
  downloadPrefixTarGz as downloadPrefixTarGzFn,
  getDownloadJobStatus as getDownloadJobStatusFn,
  cancelDownloadJob as cancelDownloadJobFn,
} from "../lib/s3Objects";
import { newJobId } from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  getDownloadJobStatus: typeof getDownloadJobStatusFn;
  downloadObject: typeof downloadObjectFn;
  downloadPrefixTarGz: typeof downloadPrefixTarGzFn;
  cancelDownloadJob: typeof cancelDownloadJobFn;

  setError?: (msg: string) => void;
};

export function useDownloads(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const downloadJobs = ref<DownloadJob[]>([]);
  const downloadBusy = computed(() =>
    downloadJobs.value.some((j) => j.state === "running" || j.state === "canceling"),
  );

  let pollTimer: number | null = null;

  function stopPolling() {
    if (pollTimer == null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function syncTask(j: DownloadJob) {
    const cur = typeof j.bytes === "number" ? j.bytes : null;
    const tot =
      typeof j.totalBytes === "number" && j.totalBytes > 0 ? j.totalBytes : null;
  
    taskCenter.upsert({
      id: j.id,
      kind: "download",
      name: j.name,
      state: j.state,
  
      progressCurrent: cur,
      progressTotal: tot,
      progressPct:
        cur != null && tot != null ? Math.round((cur * 100) / tot) : null,
  
      progressText:
        cur != null && tot != null ? `${cur} / ${tot}` : undefined,
  
      error: j.error || undefined,
      actions: {
        cancel: () => cancelJob(j.id),
        dismiss: () => dismiss(j.id),
      },
    });
  }
  
  function startPolling() {
    if (pollTimer != null) return;

    pollTimer = window.setInterval(async () => {
      const active = downloadJobs.value.filter(
        (j) => j.state === "running" || j.state === "canceling",
      );

      if (active.length === 0) {
        stopPolling();
        return;
      }

      for (const j of active) {
        const res = await deps.getDownloadJobStatus({ jobId: j.id });
        if (res.isErr()) continue;

        const s = res.value;

        if (typeof s.state === "string") j.state = s.state as DownloadState;
        if (typeof s.bytes === "number") j.bytes = s.bytes;
        if (typeof s.totalBytes === "number") j.totalBytes = s.totalBytes;
        if (typeof s.error === "string") j.error = s.error;
        if (typeof s.updatedAt === "number") j.updatedAt = s.updatedAt;

        // keep TaskCenter in sync
        syncTask(j);
      }

      // force UI update
      downloadJobs.value = [...downloadJobs.value];
    }, 500);
  }

  function markJobFailed(jobId: string, msg: string) {
    const j = downloadJobs.value.find((x) => x.id === jobId);
    if (!j) return;
    j.state = "failed";
    j.error = msg;
    downloadJobs.value = [...downloadJobs.value];
    syncTask(j);
  }

  function markJobCanceled(jobId: string) {
    const j = downloadJobs.value.find((x) => x.id === jobId);
    if (!j) return;
    j.state = "canceled";
    downloadJobs.value = [...downloadJobs.value];
    syncTask(j);
  }

  function isFileRow(r: Row): r is FileRow {
    return r.type === "file";
  }

  function isFolderRow(r: Row): r is FolderRow {
    return r.type === "folder";
  }

  async function enqueueFolderDownload(d: FolderRow) {
    const jobId = newJobId();

    const job: DownloadJob = {
      id: jobId,
      kind: "prefix-targz",
      name: `${d.name}.tar.gz`,
      state: "running",
      bytes: 0,
      totalBytes: 0,
    };

    downloadJobs.value.unshift(job);
    downloadJobs.value = [...downloadJobs.value];

    // register in TaskCenter
    syncTask(job);

    startPolling();

    const res = await deps.downloadPrefixTarGz({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      prefix: d.prefix,
      jobId,
      filename: `${d.name}.tar.gz`,
    });

    if (res.isErr()) {
      const msg = res.error.message;
      markJobFailed(jobId, msg);
      deps.setError?.(msg);
      return;
    }
  }

  async function enqueueFileDownload(f: FileRow) {
    const jobId = newJobId();

    const job: DownloadJob = {
      id: jobId,
      kind: "object",
      name: f.name,
      state: "running",
      bytes: 0,
      totalBytes: f.size,
    };

    downloadJobs.value.unshift(job);
    downloadJobs.value = [...downloadJobs.value];

    // register in TaskCenter
    syncTask(job);

    startPolling();

    const res = await deps.downloadObject({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      key: f.key,
      filename: f.name,
      jobId,
    });

    if (res.isErr()) {
      const msg = res.error.message;
      markJobFailed(jobId, msg);
      deps.setError?.(msg);
      return;
    }
  }

  async function cancelJob(jobId: string) {
    const j = downloadJobs.value.find((x) => x.id === jobId);
    if (!j) return;

    if (j.state !== "running" && j.state !== "canceling") return;

    j.state = "canceling";
    j.error = undefined;
    downloadJobs.value = [...downloadJobs.value];
    syncTask(j);

    startPolling();

    const res = await deps.cancelDownloadJob({ jobId });
    if (res.isErr()) {
      // revert
      j.state = "running";
      j.error = res.error.message;
      downloadJobs.value = [...downloadJobs.value];
      syncTask(j);
      deps.setError?.(res.error.message);
      return;
    }
  }

  async function downloadSelection(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;

    startPolling();

    const folders = items.filter(isFolderRow);
    const files = items.filter(isFileRow);

    for (const d of folders) {
      await enqueueFolderDownload(d);
      await new Promise((r) => window.setTimeout(r, 250));
    }

    for (const f of files) {
      await enqueueFileDownload(f);
      await new Promise((r) => window.setTimeout(r, 250));
    }
  }

  function dismiss(jobId: string) {
    const j = downloadJobs.value.find((x) => x.id === jobId);
    if (!j) return;

    // don’t allow dismiss while active
    if (j.state === "running" || j.state === "canceling") return;

    downloadJobs.value = downloadJobs.value.filter((x) => x.id !== jobId);
    taskCenter.remove(jobId);
  }

  onBeforeUnmount(() => {
    stopPolling();
  });

  return {
    downloadJobs,
    downloadBusy,
    startPolling,
    stopPolling,
    downloadSelection,
    cancelJob,
    dismiss,
  };
}
