<!-- src/components/ObjectDetailsPanel.vue -->
<template>
<aside class="w-[22rem] shrink-0 border-l border-default bg-default flex flex-col h-[80vh] min-h-0">
    <!-- Header (fixed) -->
        <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-2">
            <div class="min-w-0">
                <div class="text-sm font-semibold text-default truncate">
                    {{ title }}
                </div>
            </div>

            <div class="flex items-center gap-2">
                <button type="button"
                    class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-2 py-1.5 text-sm font-semibold text-default"
                    :disabled="!isFile" @click="openVersionsModal">
                    Versions
                </button>

                <button type="button"
                    class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-2 py-1.5 text-sm font-semibold text-default"
                    @click="$emit('close')">
                    Close
                </button>
            </div>
        </div>

        <!-- Body (fills remaining height + scrolls) -->
        <div class="p-4 flex-1 min-h-0 overflow-y-auto">
            <div v-if="!row" class="text-sm text-default opacity-80">
                Select an item to see its properties.
            </div>

            <template v-else>
                <div v-if="err" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                    {{ err }}
                </div>

                <div class="flex flex-col gap-6">
                    <!-- PROPERTIES -->
                    <section class="rounded-md border border-default bg-default p-3">
                        <div class="flex items-center justify-between gap-2 mb-2">
                            <div class="text-sm font-semibold text-default opacity-80">Properties</div>
                            <div v-if="loading" class="text-xs text-default opacity-70">Loading…</div>
                        </div>

                        <div class="divide-y divide-default text-sm">
                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">Name</div>
                                <div class="text-default break-all text-right flex-1">{{ nameText }}</div>
                            </div>

                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">Size</div>
                                <div class="text-default text-right flex-1">{{ sizeText }}</div>
                            </div>

                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">Last Modified</div>
                                <div class="text-default text-right flex-1">{{ lastModifiedPretty }}</div>
                            </div>

                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">ETAG</div>
                                <div class="text-default break-all text-right flex-1">{{ meta?.etag || "—" }}</div>
                            </div>

                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">Legal Hold</div>
                                <div class="text-default text-right flex-1">{{ legalHoldText }}</div>
                            </div>

                            <div class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default font-semibold opacity-70 shrink-0 w-[120px]">Retention Policy</div>
                                <div class="text-default text-right flex-1">{{ retentionText }}</div>
                            </div>
                        </div>
                    </section>

                    <!-- TAGS -->
                    <section class="rounded-md border  border-default bg-default p-3">
                        <div class="flex items-center justify-between gap-2 mb-2">
                            <div class="text-sm font-semibold text-default opacity-80">Tags</div>
                            <div v-if="tagsLoading" class="text-xs text-default opacity-70">Loading…</div>
                        </div>

                        <div v-if="!isFile" class="text-sm text-default opacity-80">
                            N/A
                        </div>

                        <div v-else-if="!tagsLoading && tags.length === 0" class="text-sm text-default opacity-80">
                            N/A
                        </div>

                        <div v-else class="divide-y divide-default text-sm">
                            <div v-for="t in tags" :key="t.key" class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default opacity-70 shrink-0 w-[120px] break-all">{{ t.key }}</div>
                                <div class="text-default text-right flex-1 break-all">{{ t.value }}</div>
                            </div>
                        </div>
                    </section>

                    <!-- METADATA -->
                    <section class="rounded-md border border-default bg-default p-3">
                        <div class="flex items-center justify-between gap-2 mb-2">
                            <div class="text-sm font-semibold text-default opacity-80">Metadata</div>
                            <div v-if="metaLoading" class="text-xs text-default opacity-70">Loading…</div>
                        </div>

                        <div v-if="!isFile" class="text-sm text-default opacity-80">None</div>

                        <div v-else-if="!metaLoading && metaEntries.length === 0"
                            class="text-sm text-default opacity-80">
                            None
                        </div>

                        <div v-else class="divide-y divide-default text-sm">
                            <div v-for="[k, v] in metaEntries" :key="k"
                                class="flex items-start justify-between gap-4 py-2">
                                <div class="text-default opacity-70 shrink-0 w-[120px] break-all">{{ k }}</div>
                                <div class="text-default text-right flex-1 break-all">{{ v }}</div>
                            </div>
                        </div>
                    </section>
                </div>
            </template>
        </div>

        <ObjectVersionsModal
  :open="versionsOpen"
  :busy="versionsLoading"
  :err="versionsErr"
  :title="versionsTitle"
  :versions="versionItems"
  :summary="versionsText"
  @close="versionsOpen = false"
  @version-action="onVersionAction"
/>

    </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Row, FileRow } from "../types";
import type { TagKV } from "./TagsModal.vue";
import { formatBytes, formatDate } from "../lib/helpers";
import { statObject, getObjectTags, getObjectVersions, rollbackObjectVersion, deleteObjectVersion, downloadObjectVersion } from "../lib/s3Objects";
import ObjectVersionsModal from "./ObjectVersionsModal.vue";

type Stat = {
    size: number;
    lastModified: string | null;
    etag: string | null;
    storageClass: string | null;
    metadata?: Record<string, string>;
    legalHold?: "ON" | "OFF" | null;
    retentionMode?: string | null;
    retainUntil?: string | null;
};

type VersionItem = {
    versionId: string | null;
    isLatest: boolean;
    lastModified: string | null;
    size: number;
    etag: string | null;
};

const props = defineProps<{
    connectionId: string;
    bucket: string;
    row: Row | null;
}>();

defineEmits<{ (e: "close"): void }>();

const err = ref("");
const currentReq = ref(0);

const loading = ref(false);
const metaLoading = ref(false);
const tagsLoading = ref(false);

const meta = ref<Stat | null>(null);
const tags = ref<TagKV[]>([]);

const metaEntries = computed<[string, string][]>(() => {
    const m = meta.value?.metadata || {};
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
});

const isFile = computed(() => props.row?.type === "file");

const title = computed(() => {
    if (!props.row) return "Properties";
    return props.row.type === "folder" ? `${props.row.name}/` : props.row.name;
});

const nameText = computed(() => {
    if (!props.row) return "—";
    return props.row.type === "folder" ? `${props.row.name}/` : props.row.name;
});

const sizeText = computed(() => {
    if (!props.row || props.row.type !== "file") return "—";
    const s = meta.value?.size ?? (props.row as any).size ?? 0;
    return formatBytes(s);
});

function relativeFromNow(iso: string) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return iso;

    const diffMs = Date.now() - t;
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);

    if (day > 0) return `${day} day${day === 1 ? "" : "s"} ago`;
    if (hr > 0) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    if (min > 0) return `${min} minute${min === 1 ? "" : "s"} ago`;
    return "just now";
}

const lastModifiedPretty = computed(() => {
    if (!props.row || props.row.type !== "file") return "—";
    const lm = meta.value?.lastModified ?? (props.row as any).lastModified ?? null;
    if (!lm) return "—";
    return `${relativeFromNow(lm)} (${formatDate(lm)})`;
});

const legalHoldText = computed(() => {
    if (!props.row || props.row.type !== "file") return "—";
    const v = meta.value?.legalHold;
    if (v === "ON") return "On";
    if (v === "OFF") return "Off";
    return "Unknown";
});

const retentionText = computed(() => {
    if (!props.row || props.row.type !== "file") return "—";
    const mode = meta.value?.retentionMode ?? null;
    const until = meta.value?.retainUntil ?? null;

    if (!mode && !until) return "None";
    if (mode && until) return `${mode} until ${formatDate(until)}`;
    if (mode) return mode;
    return until ? `Until ${formatDate(until)}` : "None";
});

/* Versions modal state */
const versionsOpen = ref(false);
const versionsLoading = ref(false);
const versionsErr = ref("");
const versions = ref<{ count: number; totalBytes: number } | null>(null);
const versionItems = ref<VersionItem[]>([]);

const versionsTitle = computed(() => {
    if (!props.row || props.row.type !== "file") return "Versions";
    return `Versions: ${props.row.name}`;
});

const versionsText = computed(() => {
    if (!props.row || props.row.type !== "file") return "—";
    if (!versions.value) return "—";
    const c = versions.value.count;
    const sz = formatBytes(versions.value.totalBytes);
    return `${c} version${c === 1 ? "" : "s"}, ${sz}`;
});

let reqId = 0;

async function loadStat(r: FileRow, myReq: number) {
    loading.value = true;
    metaLoading.value = true;
    try {
        const res = await statObject({
            connectionId: props.connectionId,
            bucket: props.bucket,
            key: r.key,
        });

        if (reqId !== myReq) return;
        if (res.isErr()) {
            err.value = res.error.message;
            return;
        }

        meta.value = {
            size: res.value.size,
            lastModified: res.value.lastModified ?? null,
            etag: res.value.etag ?? null,
            storageClass: res.value.storageClass ?? null,
            metadata: (res.value as any).metadata ?? {},
            legalHold: (res.value as any).legalHold ?? null,
            retentionMode: (res.value as any).retentionMode ?? null,
            retainUntil: (res.value as any).retainUntil ?? null,
        };
    } finally {
        if (reqId === myReq) {
            loading.value = false;
            metaLoading.value = false;
        }
    }
}

async function loadTags(r: FileRow, myReq: number) {
    tagsLoading.value = true;
    tags.value = [];
    try {
        const res = await getObjectTags({
            connectionId: props.connectionId,
            bucket: props.bucket,
            key: r.key,
        });

        if (reqId !== myReq) return;
        if (res.isErr()) return;

        const raw = (res.value as any).tags ?? [];
        tags.value = raw.map((x: any) => ({ key: x.key, value: x.value }));
    } finally {
        if (reqId === myReq) tagsLoading.value = false;
    }
}

async function loadVersionsForModal(r: FileRow, myReq: number) {
    versionsErr.value = "";
    versionsLoading.value = true;
    versions.value = null;
    versionItems.value = [];

    try {
        const res = await getObjectVersions({
            connectionId: props.connectionId,
            bucket: props.bucket,
            key: r.key,
            maxKeys: 200,
        });

        if (reqId !== myReq) return;
        if (res.isErr()) {
            versionsErr.value = res.error.message;
            return;
        }

        const items: VersionItem[] = (res.value.versions ?? []).map((v: any) => ({
            versionId: v.versionId ?? null,
            isLatest: Boolean(v.isLatest),
            lastModified: v.lastModified ?? null,
            size: Number(v.size ?? 0),
            etag: v.etag ?? null,
        }));

        const total = items.reduce((acc, v) => acc + (v.size || 0), 0);
        versions.value = { count: items.length, totalBytes: total };
        versionItems.value = items.slice(0, 500);
    } finally {
        if (reqId === myReq) versionsLoading.value = false;
    }
}

async function openVersionsModal() {
  if (!props.row || props.row.type !== "file") return;

  versionsErr.value = "";
  versionsOpen.value = true;

  const myReq = ++reqId;
  currentReq.value = myReq;

  await loadVersionsForModal(props.row, myReq);
}


watch(
    () => [props.connectionId, props.bucket, props.row] as const,
    async ([, , row]) => {
        const myReq = ++reqId;
        currentReq.value = myReq;
        err.value = "";
        meta.value = null;
        tags.value = [];

        versionsOpen.value = false;
        versionsErr.value = "";
        versionsLoading.value = false;
        versions.value = null;
        versionItems.value = [];

        loading.value = false;
        metaLoading.value = false;
        tagsLoading.value = false;

        if (!row) return;
        if (row.type !== "file") return;

        await Promise.all([loadStat(row, myReq), loadTags(row, myReq)]);
    },
    { immediate: true }
);

async function onVersionAction(payload: {
  action: "download" | "delete" | "rollback";
  versions: VersionItem[];
}) {
  if (!props.row || props.row.type !== "file") return;

  const key = props.row.key;

  if (payload.action === "rollback") {
    const v = payload.versions[0];
    if (!v?.versionId) return;

    await rollbackObjectVersion({
      connectionId: props.connectionId,
      bucket: props.bucket,
      key,
      versionId: v.versionId,
    });

    const myReq = ++reqId;
    currentReq.value = myReq;

    await Promise.all([loadStat(props.row, myReq), loadVersionsForModal(props.row, myReq)]);
    return;
  }

  if (payload.action === "delete") {
    for (const v of payload.versions) {
      if (!v.versionId) continue;
      await deleteObjectVersion({
        connectionId: props.connectionId,
        bucket: props.bucket,
        key,
        versionId: v.versionId,
      });
    }

    const myReq = ++reqId;
    currentReq.value = myReq;

    await loadVersionsForModal(props.row, myReq);
    return;
  }

  if (payload.action === "download") {
    for (const v of payload.versions) {
      if (!v.versionId) continue;

      const jobId = (globalThis.crypto as any)?.randomUUID?.() ?? String(Date.now());

      await downloadObjectVersion({
        connectionId: props.connectionId,
        bucket: props.bucket,
        key,
        versionId: v.versionId,
        jobId,
        filename: props.row.name,
      });
    }
  }
}

</script>