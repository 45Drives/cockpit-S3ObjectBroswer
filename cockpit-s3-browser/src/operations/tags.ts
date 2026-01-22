// src/composables/useTags.ts
import { computed, ref } from "vue";
import type { Row, FileRow, FolderRow } from "../types";
import type {
  getObjectTags as getObjectTagsFn,
  putObjectTags as putObjectTagsFn,
} from "../lib/s3Objects";

type TagKV = { key: string; value: string };
type TagMap = Record<string, string>;
type VersionId = string | null | undefined;

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  getObjectTags: typeof getObjectTagsFn;
  putObjectTags: typeof putObjectTagsFn;
};

export function useTags(deps: Deps) {
  const tagsBusy = ref(false);

  // Optional: keep last loaded tags to populate a dialog
  const currentTags = ref<TagKV[]>([]);

  const hasConn = computed(
    () => !!deps.connectionId.value && !!deps.bucket.value
  );

  function isFileRow(r: Row): r is FileRow {
    return r.type === "file";
  }

  function isFolderRow(r: Row): r is FolderRow {
    return r.type === "folder";
  }

  function toTagMap(tags: TagKV[]): TagMap {
    const out: TagMap = {};
    for (const t of tags) {
      const k = (t.key || "").trim();
      if (!k) continue;
      out[k] = String(t.value ?? "");
    }
    return out;
  }

  function fromTagMap(m: TagMap): TagKV[] {
    return Object.entries(m).map(([key, value]) => ({ key, value }));
  }

  async function loadObjectTags(key: string, versionId?: VersionId) {
    if (!hasConn.value) return;
    tagsBusy.value = true;
    try {
      const res = await deps.getObjectTags({
        connectionId: deps.connectionId.value,
        bucket: deps.bucket.value,
        key,
        versionId: versionId ?? null,
      });
  
      if (res.isErr()) return;
  
      currentTags.value = Array.isArray(res.value.tags) ? res.value.tags : [];
    } finally {
      tagsBusy.value = false;
    }
  }
  
  async function applyObjectTags(opts: {
    key: string;
    versionId?: VersionId;
    tags: TagMap | TagKV[];
  }) {
    if (!hasConn.value) return;
  
    const tagMap: TagMap = Array.isArray(opts.tags) ? toTagMap(opts.tags) : opts.tags;
  
    tagsBusy.value = true;
    try {
      const res = await deps.putObjectTags({
        connectionId: deps.connectionId.value,
        bucket: deps.bucket.value,
        key: opts.key,
        versionId: opts.versionId ?? null,
        tags: tagMap,
      });
  
      if (res.isErr()) return;
  
      if (opts.key && Array.isArray(res.value.tags)) {
        currentTags.value = res.value.tags;
      }
    } finally {
      tagsBusy.value = false;
    }
  }
  async function applyTagsToSelection(opts: {
    items: Row[];
    tags: TagMap | TagKV[];
    includeFolders?: boolean; // default false
    folderMarkerKey?: (d: FolderRow) => string | null; // optional helper if your FolderRow doesn't store it
  }) {
    if (!hasConn.value) return;
    const tagMap: TagMap = Array.isArray(opts.tags)
      ? toTagMap(opts.tags)
      : opts.tags;

    const files = opts.items.filter(isFileRow);
    const folders = opts.items.filter(isFolderRow);

    tagsBusy.value = true;
    try {
      for (const f of files) {
        const res = await deps.putObjectTags({
          connectionId: deps.connectionId.value,
          bucket: deps.bucket.value,
          key: f.key,
          tags: tagMap,
        });

        if (res.isErr()) {
          const msg = res.error.message;
        }

        await new Promise((r) => window.setTimeout(r, 100));
      }

      if (opts.includeFolders) {
        for (const d of folders) {
          const marker =
            opts.folderMarkerKey?.(d) ??
            // best guess: prefix itself (often ends with "/")
            (typeof d.prefix === "string" && d.prefix ? d.prefix : null);

          if (!marker) continue;

          const res = await deps.putObjectTags({
            connectionId: deps.connectionId.value,
            bucket: deps.bucket.value,
            key: marker,
            tags: tagMap,
          });

          if (res.isErr()) {
            const msg = res.error.message;
          }

          await new Promise((r) => window.setTimeout(r, 100));
        }
      }
    } finally {
      tagsBusy.value = false;
    }
  }

  return {
    tagsBusy,
    currentTags,

    loadObjectTags,
    applyObjectTags,
    applyTagsToSelection,
    toTagMap,
    fromTagMap,
  };
}
