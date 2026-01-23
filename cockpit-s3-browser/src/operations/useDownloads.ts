// src/operations/useDownloads.ts
import { computed, onBeforeUnmount, ref } from "vue";
import type {
  DownloadJob,
  DownloadState,
  Row,
  FolderRow,
  FileRow,
} from "../types";
import type {
  downloadObject as downloadObjectFn,
  downloadObjectVersion as downloadObjectVersionFn,
  downloadPrefixTarGz as downloadPrefixTarGzFn,
  getDownloadJobStatus as getDownloadJobStatusFn,
  cancelDownloadJob as cancelDownloadJobFn,
} from "../lib/s3Objects";
import {  newJobId, rateEtaText, updateRateAndEta } from "../lib/helpers";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  getDownloadJobStatus: typeof getDownloadJobStatusFn;
  downloadObject: typeof downloadObjectFn;
  downloadObjectVersion: typeof downloadObjectVersionFn;
  downloadPrefixTarGz: typeof downloadPrefixTarGzFn;
  cancelDownloadJob: typeof cancelDownloadJobFn;
};

type RateStats = {
  lastT: number;
  lastB: number;
  rateAvg: number | null; // bytes/sec
  etaSec: number | null;  // seconds
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}


export function useDownloads(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const downloadJobs = ref<DownloadJob[]>([]);
  const downloadBusy = computed(() =>
    downloadJobs.value.some((j) => j.state === "running" || j.state === "canceling")
  );

  // Non-overlapping poll loop
  let pollTimer: number | null = null;
  let pollRunning = false;

  // Grace window for "job not found" races
  const jobStartAt = new Map<string, number>();

  // Rate/ETA per job
  const rateStats = new Map<string, RateStats>();

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

  function syncTask(j: DownloadJob) {
    const cur = typeof j.bytes === "number" ? j.bytes : null;
    const tot =
      typeof j.totalBytes === "number" && j.totalBytes > 0 ? j.totalBytes : null;

    const pct =
      cur != null && tot != null && tot > 0 ? Math.round((cur * 100) / tot) : null;

    taskCenter.upsert({
      id: j.id,
      kind: "download",
      name: j.name,
      state: j.state,

      progressCurrent: cur,
      progressTotal: tot,
      progressPct: pct,

      // includes rate + ETA (TaskCenter must render it)
      progressText: rateEtaText(rateStats, j.id),

      error: j.error || undefined,
      actions: {
        cancel: () => cancelJob(j.id),
        dismiss: () => dismiss(j.id),
      },
    });
  }

  async function pollOnce() {
    if (pollRunning) {
      schedulePoll(500);
      return;
    }
    pollRunning = true;

    try {
      const active = downloadJobs.value.filter(
        (j) => j.state === "running" || j.state === "canceling"
      );

      if (active.length === 0) {
        stopPolling();
        return;
      }

      const results = await Promise.all(
        active.map(async (j) => {
          const res = await deps.getDownloadJobStatus({ jobId: j.id });
          return { j, res };
        })
      );

      for (const { j, res } of results) {
        const prevState = j.state;

        if (res.isErr()) {
          const msg = res.error.message || "Unknown error";
          const started = jobStartAt.get(j.id) ?? Date.now();
          const ageMs = Date.now() - started;

          const lower = msg.toLowerCase();
          const looksNotFound =
            lower.includes("job not found") || lower.includes("not found");

          if (looksNotFound && ageMs < 4000) {
            // don’t fail yet; backend might not have created the job file
            continue;
          }

          j.state = "failed";
          j.error = msg;
          syncTask(j);

          if (prevState !== "failed") {
            console.error(`[download] failed ${j.name}: ${j.error}`);
            pushNotification(
              new Notification(
                "Download failed",
                `Download failed ${j.name}: ${j.error}`,
                "error",
                5000
              )
            );
          }
          continue;
        }

        const s: any = res.value;

        if (typeof s.state === "string") j.state = s.state as DownloadState;

        const newBytes = toNum(s.bytes);
        if (newBytes != null) j.bytes = newBytes;

        const tb = toNum(s.totalBytes);
        const sz = toNum(s.size);
        if (tb != null) j.totalBytes = tb;
        else if (sz != null) j.totalBytes = sz;

        if (typeof s.error === "string") j.error = s.error;

        // update rate+eta when we have numbers
        if (typeof j.bytes === "number") {
          const total = typeof j.totalBytes === "number" ? j.totalBytes : 0;
          updateRateAndEta(rateStats,j.id, j.bytes, total);
        }

        if (j.state !== prevState) {
          if (j.state === "done") {
            console.log(`[download] completed ${j.name}`);
            pushNotification(
              new Notification(
                "Download completed",
                `Download completed ${j.name}`,
                "success",
                5000
              )
            );
            jobStartAt.delete(j.id);
            rateStats.delete(j.id);
          } else if (j.state === "canceled") {
            console.log(`[download] canceled ${j.name}`);
            pushNotification(
              new Notification(
                "Download Canceled",
                `Download canceled ${j.name}`,
                "error",
                5000
              )
            );
            jobStartAt.delete(j.id);
            rateStats.delete(j.id);
          } else if (j.state === "failed") {
            console.error(`[download] failed ${j.name}: ${j.error ?? "Unknown error"}`);
            pushNotification(
              new Notification(
                "Download failed",
                `Download failed ${j.name}: ${j.error ?? "Unknown error"}`,
                "error",
                5000
              )
            );
            jobStartAt.delete(j.id);
            rateStats.delete(j.id);
          }
        }

        syncTask(j);
      }

      downloadJobs.value = [...downloadJobs.value];
    } finally {
      pollRunning = false;

      if (downloadJobs.value.some((j) => j.state === "running" || j.state === "canceling")) {
        schedulePoll(500);
      } else {
        stopPolling();
      }
    }
  }

  function markJobFailed(jobId: string, msg: string) {
    const j = downloadJobs.value.find((x) => x.id === jobId);
    if (!j) return;
    j.state = "failed";
    j.error = msg;
    downloadJobs.value = [...downloadJobs.value];
    syncTask(j);
    jobStartAt.delete(jobId);
    rateStats.delete(jobId);
  }

  function isFileRow(r: Row): r is FileRow {
    return r.type === "file";
  }

  function isFolderRow(r: Row): r is FolderRow {
    return r.type === "folder";
  }

  async function enqueueFolderDownload(d: FolderRow) {
    const jobId = newJobId();
    jobStartAt.set(jobId, Date.now());

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
      markJobFailed(jobId, res.error.message);
      return;
    }
  }

  async function enqueueFileDownload(f: FileRow) {
    const jobId = newJobId();
    jobStartAt.set(jobId, Date.now());

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
      markJobFailed(jobId, res.error.message);
      return;
    }
  }

  async function enqueueObjectVersionDownload(params: {
    key: string;
    versionId: string;
    filename?: string;
  }) {
    const jobId = newJobId();
    jobStartAt.set(jobId, Date.now());

    const base = params.filename || params.key.split("/").pop() || "download";
    const safeVid = (params.versionId || "").slice(0, 8) || "version";
    const name = `${base}.v-${safeVid}`;

    const job: DownloadJob = {
      id: jobId,
      kind: "object-version",
      name,
      state: "running",
      bytes: 0,
      totalBytes: 0,
    };

    downloadJobs.value.unshift(job);
    downloadJobs.value = [...downloadJobs.value];

    syncTask(job);
    startPolling();

    const res = await deps.downloadObjectVersion({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      key: params.key,
      versionId: params.versionId,
      jobId,
      filename: base,
    });

    if (res.isErr()) {
      markJobFailed(jobId, res.error.message);
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

    if (j.state === "running" || j.state === "canceling") return;

    downloadJobs.value = downloadJobs.value.filter((x) => x.id !== jobId);
    taskCenter.remove(jobId);
    jobStartAt.delete(jobId);
    rateStats.delete(jobId);
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
    enqueueObjectVersionDownload,
    dismiss,
  };
}
