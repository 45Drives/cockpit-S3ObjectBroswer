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
import { basenameFromKey, folderNameFromPrefix, normalizePrefixNoLead } from "../lib/helpers";

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
  setBusy?: (busy: boolean) => void; // optional, if you want to toggle page "busy"
};

export function useTransfers(deps: Deps) {
  const transferJobs = ref<TransferJob[]>([]);
  const transferBusy = computed(() => transferJobs.value.some((j) => j.state === "running"));

  const pasteItems = ref<PasteItem[]>([]);
  const pasteBusy = computed(() =>
    pasteItems.value.some((i) => i.step === "queued" || i.step === "copying"),
  );

  const pasteTotal = computed(() => pasteItems.value.length);
  const pasteDone = computed(() => pasteItems.value.filter((i) => i.step === "done").length);

  const pastePct = computed(() => {
    const t = pasteTotal.value;
    if (!t) return null;
    return Math.floor((pasteDone.value / t) * 100);
  });

  watch(pasteBusy, (b) => {
    if (!b && pasteItems.value.length && pasteItems.value.every((p) => p.step === "done")) {
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
    if (!deps.clip.canPaste(deps.connectionId.value, deps.bucket.value)) return;

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

          if (dstKey === it.key) continue;

          planned.push({
            id: uid(),
            itemType: "file",
            srcKey: it.key,
            dstKey,
            name,
            step: "queued",
          });
        } else {
          const srcPrefix = normalizePrefixNoLead(it.prefix);
          const folderName = makeUniqueName(folderNameFromPrefix(it.prefix), usedNames);
          const dstPrefix = dstBasePrefix ? `${dstBasePrefix}${folderName}/` : `${folderName}/`;

          if (kind === "cut" && isPasteIntoSelfPrefix(srcPrefix, dstPrefix)) {
            deps.setError?.(`Cannot move "${folderName}" into itself.`);
            return;
          }
          if (srcPrefix === dstPrefix) continue;

          planned.push({
            id: uid(),
            itemType: "folder",
            srcKey: srcPrefix,
            dstKey: dstPrefix,
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
          src: p.srcKey,
          dst: p.dstKey,
          state: "running",
          startedAt: Date.now(),
        });

        const tIdx = transferJobs.value.findIndex((j) => j.id === jobId);

        try {
          if (p.itemType === "file") {
            if (kind === "cut") {
              const job = deps.renameObjectStreamed({
                connectionId: deps.connectionId.value,
                bucket: deps.bucket.value,
                srcKey: p.srcKey,
                dstKey: p.dstKey,
                concurrency: 6,
                onEvent: (ev) => {
                  if (ev.type === "result" && tIdx >= 0) {
                    transferJobs.value[tIdx].state = ev.ok ? "done" : "failed";
                    transferJobs.value[tIdx].error = ev.ok ? undefined : ev.error || "Move failed";
                    transferJobs.value[tIdx].finishedAt = Date.now();
                  }
                },
              });

              const res = await job.run;
              if (res.isErr()) throw new Error(res.error.message);
            } else {
              const res = await deps.copyObject({
                connectionId: deps.connectionId.value,
                bucket: deps.bucket.value,
                srcKey: p.srcKey,
                dstKey: p.dstKey,
                concurrency: 6,
              });
              if (res.isErr()) throw new Error(res.error.message);
            }
          } else {
            const res =
              kind === "cut"
                ? await deps.movePrefix({
                    connectionId: deps.connectionId.value,
                    bucket: deps.bucket.value,
                    srcPrefix: p.srcKey,
                    dstPrefix: p.dstKey,
                    concurrency: 6,
                  })
                : await deps.copyPrefix({
                    connectionId: deps.connectionId.value,
                    bucket: deps.bucket.value,
                    srcPrefix: p.srcKey,
                    dstPrefix: p.dstKey,
                    concurrency: 6,
                  });

            if (res.isErr()) throw new Error(res.error.message);
          }

          p.step = "done";
          pasteItems.value = [...pasteItems.value];

          if (tIdx >= 0) {
            transferJobs.value[tIdx].state = "done";
            transferJobs.value[tIdx].finishedAt = Date.now();
          }
        } catch (e: any) {
          const msg = e?.message || "Paste failed";

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

      await deps.refresh?.();
    } finally {
      deps.setBusy?.(false);
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
  };
}
