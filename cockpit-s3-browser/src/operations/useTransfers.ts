// src/operations/useTransfers.ts
import { computed, ref, watch } from "vue";
import type { PasteItem, TransferJob } from "../types";
import type { useClipboardStore } from "../stores/clipboard";
import type {
  copyObject as copyObjectFn,
  copyPrefix as copyPrefixFn,
  movePrefix as movePrefixFn,
  renameObjectStreamed as renameObjectStreamedFn,
} from "../lib/s3Objects";
import { uid } from "../lib/helpers";
import {
  basenameFromKey,
  folderNameFromPrefix,
  normalizePrefixNoLead,
} from "../lib/helpers";
import { pushNotification, Notification } from "@45drives/houston-common-ui";

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };
  prefix: { value: string };

  clip: ReturnType<typeof useClipboardStore>;

  copyObject: typeof copyObjectFn;
  copyPrefix: typeof copyPrefixFn;
  movePrefix: typeof movePrefixFn;
  renameObjectStreamed: typeof renameObjectStreamedFn;

  refresh?: () => Promise<void> | void;
  setError?: (msg: string) => void;
  setBusy?: (busy: boolean) => void;
  onCreated?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string }
  ) => void;
  onDeleted?: (
    item: { type: "file"; key: string } | { type: "folder"; prefix: string }
  ) => void;
};

export function useTransfers(deps: Deps) {
  const transferJobs = ref<TransferJob[]>([]);
  const transferBusy = computed(() =>
    transferJobs.value.some((j) => j.state === "running")
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

  watch(pasteBusy, (b) => {
    if (
      !b &&
      pasteItems.value.length &&
      pasteItems.value.every((p) => p.step === "done")
    ) {
      setTimeout(() => {
        if (!pasteBusy.value) pasteItems.value = [];
      }, 2000);
    }
  });

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

    deps.setError?.("");
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

          // same bucket + same key => no-op
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
          const folderName = makeUniqueName(
            folderNameFromPrefix(it.prefix),
            usedNames
          );
          const dstPrefix = dstBasePrefix
            ? `${dstBasePrefix}${folderName}/`
            : `${folderName}/`;

          // moving folder into itself only matters if same bucket
          if (
            kind === "cut" &&
            it.bucket === dstBucket &&
            isPasteIntoSelfPrefix(srcPrefix, dstPrefix)
          ) {
            deps.setError?.(`Cannot move "${folderName}" into itself.`);
            return;
          }

          // same bucket + same prefix => no-op
          if (it.bucket === dstBucket && srcPrefix === dstPrefix) continue;

          planned.push({
            id: uid(),
            itemType: "folder",
            srcBucket: it.bucket,
            srcKey: srcPrefix, // normalized prefix
            dstKey: dstPrefix, // normalized prefix
            name: folderName + "/",
            step: "queued",
          });
        }
      }

      pasteItems.value = planned;

      // 2) Execute sequentially
      for (const p of pasteItems.value) {
        p.step = "copying";
        pasteItems.value = [...pasteItems.value];

        const jobId = uid();
        transferJobs.value.push({
          id: jobId,
          kind: kind === "cut" ? "move" : "copy",
          itemType: p.itemType,
          name: p.name,
          src: `${p.srcBucket}:${p.srcKey}`,
          dst: `${dstBucket}:${p.dstKey}`,
          state: "running",
          startedAt: Date.now(),
        });
        const kindLabel = kind === "cut" ? "move" : "copy";
        const srcLabel = `${p.srcBucket}:${p.srcKey}`;
        const dstLabel = `${dstBucket}:${p.dstKey}`;

        const tIdx = transferJobs.value.findIndex((j) => j.id === jobId);

        try {
          const sameBucket = p.srcBucket === dstBucket;

          // block cross-bucket move for now (copy+delete later if you want)
          if (kind === "cut" && !sameBucket) {
            throw new Error(
              "Move across buckets is not supported. Use Copy instead."
            );
          }

          if (p.itemType === "file") {
            if (kind === "cut") {
              // same bucket rename/move
              const job = deps.renameObjectStreamed({
                connectionId: deps.connectionId.value,
                bucket: dstBucket, // same as src bucket for cut
                srcKey: p.srcKey,
                dstKey: p.dstKey,
                concurrency: 6,
                onEvent: (ev) => {
                  if (ev.type === "result" && tIdx >= 0) {
                    transferJobs.value[tIdx].state = ev.ok ? "done" : "failed";
                    transferJobs.value[tIdx].error = ev.ok
                      ? undefined
                      : ev.error || "Move failed";
                    transferJobs.value[tIdx].finishedAt = Date.now();
                  }
                },
              });

              const res = await job.run;
              if (res.isErr()) throw new Error(res.error.message);
            } else {
              const res = await deps.copyObject({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcKey: p.srcKey,
                dstBucket,
                dstKey: p.dstKey,
                concurrency: 6,
              });
              if (res.isErr()) throw new Error(res.error.message);
            }
          } else {
            // folder
            if (kind === "cut") {
              const res = await deps.movePrefix({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcPrefix: p.srcKey,
                dstBucket,
                dstPrefix: p.dstKey,
                concurrency: 6,
              });
              if (res.isErr()) throw new Error(res.error.message);
            } else {
              const res = await deps.copyPrefix({
                connectionId: deps.connectionId.value,
                srcBucket: p.srcBucket,
                srcPrefix: p.srcKey,
                dstBucket,
                dstPrefix: p.dstKey,
                concurrency: 6,
              });
              if (res.isErr()) throw new Error(res.error.message);
            }
          }

          // success
          p.step = "done";

          // created at destination (only update UI if destination is current view)
          if (p.itemType === "file")
            deps.onCreated?.({ type: "file", key: p.dstKey });
          else deps.onCreated?.({ type: "folder", prefix: p.dstKey });

          // if cut in same bucket, remove source from current list too
          if (kind === "cut" && sameBucket) {
            if (p.itemType === "file")
              deps.onDeleted?.({ type: "file", key: p.srcKey });
            else deps.onDeleted?.({ type: "folder", prefix: p.srcKey });
          }

          pasteItems.value = [...pasteItems.value];

          if (tIdx >= 0) {
            transferJobs.value[tIdx].state = "done";
            transferJobs.value[tIdx].finishedAt = Date.now();
          }
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
          pushNotification(
            new Notification(
              "Transfer failed",
              `Transfer ${kindLabel} ${p.itemType} failed: ${p.name} (${srcLabel} → ${dstLabel}) - ${msg}`,
              "error",
              5000
            )
          );
          p.step = "failed";
          p.error = msg;
          pasteItems.value = [...pasteItems.value];

          if (tIdx >= 0) {
            transferJobs.value[tIdx].state = "failed";
            transferJobs.value[tIdx].error = msg;
            transferJobs.value[tIdx].finishedAt = Date.now();
          }

          deps.setError?.(msg);
          return;
        }
      }

      // 3) Clear clipboard if cut
      if (deps.clip.kind === "cut") deps.clip.clear();

      // no refresh; UI updates happen via onCreated/onDeleted
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
      return;
    }

    // pasteItems
    const p = pasteItems.value.find((x) => x.id === id);
    if (p) {
      if (p.step === "queued" || p.step === "copying") return;
      pasteItems.value = pasteItems.value.filter((x) => x.id !== id);
    }
  }

  function cancelJob(id: string) {
    const j = transferJobs.value.find((x) => x.id === id);
    if (!j) return;

    // only active jobs
    if (j.state !== "running" && j.state !== "canceling") return;

    // mark canceling; actual operation may still finish in background
    j.state = "canceling";
    j.error = "Canceled";
    j.finishedAt = Date.now();

    transferJobs.value = [...transferJobs.value];

    // also try to cancel the matching paste item (if any)
    const p = pasteItems.value.find(
      (x) => x.name === j.name && x.step === "copying"
    );
    if (p) {
      p.step = "canceled";
      pasteItems.value = [...pasteItems.value];
    }
  }

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
