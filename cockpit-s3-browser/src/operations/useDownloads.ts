import { computed, onBeforeUnmount, ref } from "vue";
import type { DownloadJob, DownloadState, Row, FolderRow, FileRow } from "../types";
import type {
  downloadObject as downloadObjectFn,
  downloadPrefixTarGz as downloadPrefixTarGzFn,
  getDownloadJobStatus as getDownloadJobStatusFn,
} from "../lib/s3Objects";
import { newJobId } from "../lib/helpers";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  getDownloadJobStatus: typeof getDownloadJobStatusFn;
  downloadObject: typeof downloadObjectFn;
  downloadPrefixTarGz: typeof downloadPrefixTarGzFn;

  setError?: (msg: string) => void;
};

export function useDownloads(deps: Deps) {
  const downloadJobs = ref<DownloadJob[]>([]);
  const downloadBusy = computed(() => downloadJobs.value.some((j) => j.state === "running"));

  let pollTimer: number | null = null;

  function stopPolling() {
    if (pollTimer == null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    if (pollTimer != null) return;

    pollTimer = window.setInterval(async () => {
      const running = downloadJobs.value.filter((j) => j.state === "running");
      if (running.length === 0) {
        stopPolling();
        return;
      }

      for (const j of running) {
        const res = await deps.getDownloadJobStatus({ jobId: j.id });
        if (res.isErr()) continue;

        const s = res.value;

        if (typeof s.state === "string") j.state = s.state as DownloadState;
        if (typeof s.bytes === "number") j.bytes = s.bytes;
        if (typeof s.totalBytes === "number") j.totalBytes = s.totalBytes;
        if (typeof s.error === "string") j.error = s.error;
        if (typeof s.updatedAt === "number") j.updatedAt = s.updatedAt;
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
  }

  function isFileRow(r: Row): r is FileRow {
    return r.type === "file";
  }

  function isFolderRow(r: Row): r is FolderRow {
    return r.type === "folder";
  }

  async function enqueueFolderDownload(d: FolderRow) {
    const jobId = newJobId();

    downloadJobs.value.unshift({
      id: jobId,
      kind: "prefix-targz",
      name: `${d.name}.tar.gz`,
      state: "running",
      bytes: 0,
      totalBytes: 0,
    });

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

    downloadJobs.value.unshift({
      id: jobId,
      kind: "object",
      name: f.name,
      state: "running",
      bytes: 0,
      totalBytes: f.size,
    });

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

  async function downloadSelection(items: Row[]) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!items.length) return;

    startPolling();

    const folders = items.filter(isFolderRow);
    const files = items.filter(isFileRow);

    // folders first
    for (const d of folders) {
      await enqueueFolderDownload(d);
      await new Promise((r) => window.setTimeout(r, 250));
    }

    for (const f of files) {
      await enqueueFileDownload(f);
      await new Promise((r) => window.setTimeout(r, 250));
    }
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
  };
}
