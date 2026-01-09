<template>
    <div class="w-full px-6 py-6">
        <div class="mx-auto w-full max-w-6xl">
            <div class="rounded-md border border-default bg-accent shadow-sm">
                <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-base font-semibold text-default truncate">{{ bucket || "—" }}</div>
                        <div class="text-sm text-default truncate">Connection: {{ connectionName || "—" }}</div>
                    </div>

                    <div class="flex items-center gap-2">
                        <button type="button"
                            class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                            :disabled="busy" @click="goBack">
                            Back
                        </button>

                        <button type="button"
                            class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                            :disabled="busy" @click="refresh">
                            <ArrowPathIcon class="h-4 w-4"></ArrowPathIcon>
                        </button>
                    </div>
                </div>

                <div class="p-4">
                    <div v-if="error" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                        {{ error }}
                    </div>

                    <div class="mb-3 flex items-center gap-2">
                        <button type="button"
                            class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                            :disabled="busy || !(prefix || '').length" @click="goUp()" title="Up one folder">
                            <ArrowUpIcon class="h-4 w-4"></ArrowUpIcon>
                        </button>

                        <div class="flex items-center gap-2 w-[60%] min-w-0">
                            <div class="text-xs text-default shrink-0">Path</div>

                            <input v-model.trim="pathInput" type="text"
                                class="w-full min-w-0 rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none"
                                placeholder="e.g. photos/2025/" :disabled="busy" @keyup.enter="goToPath()" />

                            <button type="button"
                                class="inline-flex items-center btn-secondary justify-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                                :disabled="busy" @click="goToPath()">
                                <ArrowRightEndOnRectangleIcon class="h-4 w-4"></ArrowRightEndOnRectangleIcon>
                            </button>
                        </div>

                        <div class="flex items-center gap-2 w-[20%] min-w-0">
                            <input v-model.trim="search" type="text"
                                class="w-full min-w-0 rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none"
                                placeholder="Search..." :disabled="busy && virtualRows.length === 0" />
                        </div>

                        <div class="flex-1"></div>
                    </div>

                    <!-- TABLE VIEW -->
                    <div v-if="viewMode === 'table'" class="rounded-md border border-default ">
                        <div class="bg-well text-left text-default w-full"
                            :style="colsStyle + 'scrollbar-gutter: stable;'">
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Name</div>
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Type</div>
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Size</div>
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Last modified
                            </div>
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Owner</div>
                            <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">Storage class
                            </div>
                        </div>

                        <RecycleScroller class="w-full overflow-y-auto  h-[96vh]"
                            style="scrollbar-gutter: stable; height: 96vh;;" :items="virtualRows" :item-size="56"
                            key-field="__key" v-slot="{ item: r }">
                            <div class="w-full hover:bg-default border-b border-default cursor-pointer outline-none"
                                :style="colsStyle + 'align-items:center; height:56px;'"
                                :class="selectedId === rowId(r) ? 'bg-well' : ''" tabindex="0" @click="selectRow(r)"
                                @dblclick="activateRow(r)" @keydown.enter.prevent="activateRow(r)">
                                <div class="px-3 py-2 text-default min-w-0">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <span class="shrink-0 opacity-80 w-4 h-4"></span>

                                        <button v-if="r.type === 'folder'" type="button"
                                            class="font-semibold text-default hover:opacity-90 truncate min-w-0"
                                            :disabled="busy" @click.stop="openPrefix(r.prefix)">
                                            {{ r.name }}/
                                        </button>

                                        <div v-else class="min-w-0">
                                            <div class="text-default text-sm truncate" :title="r.key">{{ r.name }}</div>
                                        </div>
                                    </div>
                                </div>

                                <div class="px-3 py-2 text-default min-w-0 truncate">
                                    <span v-if="r.type === 'file'">{{ r.fileType || "—" }}</span>
                                    <span v-else>folder</span>
                                </div>

                                <div class="px-3 py-2 text-default min-w-0 truncate">
                                    <span v-if="r.type === 'file'">{{ formatBytes(r.size) }}</span>
                                    <span v-else>—</span>
                                </div>

                                <div class="px-3 py-2 text-default min-w-0 truncate">
                                    <span v-if="r.type === 'file'">{{ formatDate(r.lastModified) }}</span>
                                    <span v-else>—</span>
                                </div>

                                <div class="px-3 py-2 text-default min-w-0 truncate">
                                    <span v-if="r.type === 'file'">{{ r.ownerDisplayName || r.ownerId || "—" }}</span>
                                    <span v-else>—</span>
                                </div>

                                <div class="px-3 py-2 text-default min-w-0 truncate">
                                    <span v-if="r.type === 'file'">{{ r.storageClass || "—" }}</span>
                                    <span v-else>—</span>
                                </div>
                            </div>
                        </RecycleScroller>
                    </div>

                    <!-- ICON VIEW -->
                    <div v-else class="rounded-md border border-default overflow-y-scroll">
                        <RecycleScroller ref="iconScroller" class=" w-full overflow-y-auto p-4  "
                            style="height: 96vh; scrollbar-gutter: stable; " :items="virtualRows"
                            :grid-items="gridItems" :item-size="120" :item-secondary-size="150" key-field="__key"
                            v-slot="{ item: r }">
                            <button type="button"
                                class="w-full h-full rounded-md border border-default bg-default p-3 text-left hover:opacity-90 active:opacity-80"
                                :class="selectedId === rowId(r) ? 'ring-2 ring-default' : ''" :disabled="busy"
                                @click="selectRow(r)" @dblclick="activateRow(r)">
                                <div class="flex flex-col items-center gap-2 h-full">
                                    <span class="shrink-0 opacity-80 flex justify-center">
                                        <svg v-if="iconForRow(r) === 'folder'" class="w-8 h-8" viewBox="0 0 24 24"
                                            fill="none" xmlns="http://www.w3.org/2000/svg" stroke-width="1.8"
                                            stroke="currentColor">
                                            <path
                                                d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
                                        </svg>
                                        <svg v-else class="w-8 h-8" viewBox="0 0 24 24" fill="none"
                                            xmlns="http://www.w3.org/2000/svg" stroke-width="1.8" stroke="currentColor">
                                            <path
                                                d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
                                            <path d="M8 7h8" />
                                            <path d="M8 11h8" />
                                            <path d="M8 15h5" />
                                        </svg>
                                    </span>

                                    <div class="w-full text-center min-w-0">
                                        <!-- Filename: clamp to 2 lines, adds "..." -->
                                        <div class="min-w-0 w-full text-default text-sm leading-snug line-clamp-2"
                                            style="display: block;
    max-width: 98%;
    white-space: nowrap;
    overflow: hidden !important;
    text-overflow: ellipsis" :title="r.type === 'folder' ? (r.name + '/') : r.name">

                                            {{ r.type === "folder" ? (r.name + "/") : r.name }}
                                        </div>

                                        <!-- Meta: always visible -->
                                        <div v-if="r.type === 'file'" class="text-xs text-default mt-1 truncate"
                                            :title="`${r.fileType || '—'} · ${formatBytes(r.size)}`">
                                            {{ r.fileType || "—" }} · {{ formatBytes(r.size) }}
                                        </div>
                                    </div>

                                </div>
                            </button>
                        </RecycleScroller>

                    </div>


                    <div class="mt-3 flex items-center justify-between">
                        <div class="text-xs text-default">
                            Loaded: <span class="text-default">{{ virtualRows.length }}</span>
                        </div>

                        <button type="button"
                            class="inline-flex items-center justify-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                            :disabled="busy" @click="toggleView()">
                            {{ viewMode === "table" ? "Icon view" : "Table view" }}
                        </button>

                        <div class="text-xs text-default">
                            <span v-if="prefetching">Loading items…</span>
                            <span v-else>All items loaded</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listObjects } from "../lib/s3Objects";
import { ArrowRightEndOnRectangleIcon, ArrowUpIcon, ArrowPathIcon, MagnifyingGlassCircleIcon } from "@heroicons/vue/20/solid";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";



const iconScroller = ref<any>(null);
const gridItems = ref(1);
function recalcGrid() {
    const el: HTMLElement | null = iconScroller.value?.$el ?? null;
    if (!el) return;

    const width = el.clientWidth;
    const cardW = 150;  // must match item-secondary-size / your w-[220px]
    const cols = Math.max(1, Math.floor(width / cardW));
    gridItems.value = cols;
}
let ro: ResizeObserver | null = null;
onMounted(async () => {
    await nextTick();
    recalcGrid();

    const el: HTMLElement | null = iconScroller.value?.$el ?? null;
    if (!el) return;

    ro = new ResizeObserver(() => recalcGrid());
    ro.observe(el);
});

onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
});
type FolderRow = { type: "folder"; prefix: string; name: string };
type FileRow = {
    type: "file";
    key: string;
    name: string;
    size: number;
    lastModified?: string | null;

    etag?: string | null;
    storageClass?: string | null;

    ownerDisplayName?: string | null;
    ownerId?: string | null;

    fileType?: string | null; // derived from extension/mime guess
};
type Row = FolderRow | FileRow;
type ViewMode = "table" | "icons";

const colsStyle =
    "display:grid; grid-template-columns: 1.6fr 0.6fr 0.6fr 0.9fr 0.8fr 0.7fr; width:100%;";

const viewMode = ref<ViewMode>("table");
const route = useRoute();
const router = useRouter();

const connectionId = computed(() => String(route.query.connectionId || ""));
const connectionName = computed(() => String(route.query.connectionName || ""));
const bucket = computed(() => String(route.query.bucket || ""));
const prefix = computed(() => String(route.query.prefix || ""));
const prefetchAll = ref(true);
const busy = ref(false);
const error = ref("");
const search = ref("");
const pathInput = ref("");

// Keep folders/files separately so we can always render folder-first.
const rows = ref<Row[]>([]);

const continuationToken = ref<string | null>(null);
const hasMore = ref(false);
const selectedId = ref<string>("");
let runId = 0;

onBeforeUnmount(() => {
    runId++;
});
const prefetching = ref(false);

async function fetchAllPagesSequentially() {
    const myRun = ++runId;
    prefetching.value = true;
    try {
        continuationToken.value = null;
        hasMore.value = false;
        resetLists();

        await fetchPage(true);
        if (runId !== myRun) return;

        while (hasMore.value) {
            if (runId !== myRun) return;
            await fetchPage(false);
            await nextTick();
            await yieldToUI();
        }
    } finally {
        if (runId === myRun) prefetching.value = false;
    }
}

function yieldToUI(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function rowId(r: Row) {
    return r.type === "folder" ? `d:${r.prefix}` : `f:${r.key}`;
}

function selectRow(r: Row) {
    selectedId.value = rowId(r);
}

function activateRow(r: Row) {
    if (r.type === "folder") openPrefix(r.prefix);
    else openFile(r);
}



function goBack() {
    router.back();
}

function openPrefix(p: string) {
    router.push({
        name: "Objects",
        query: {
            connectionId: connectionId.value,
            connectionName: connectionName.value,
            bucket: bucket.value,
            prefix: normalizePrefix(p),
        },
    });
}

function toggleView() {
    viewMode.value = viewMode.value === "table" ? "icons" : "table";
}

function rowKey(r: Row) {
    return r.type === "folder" ? `d:${r.prefix}` : `f:${r.key}`;
}

function nameFromPrefix(p: string) {
    const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
    const parts = trimmed.split("/").filter(Boolean);
    return parts[parts.length - 1] || trimmed;
}

function nameFromKey(k: string) {
    const parts = (k || "").split("/");
    return parts[parts.length - 1] || k;
}

function formatDate(iso?: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
}

function formatBytes(n: number) {
    if (!Number.isFinite(n)) return "—";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    const dp = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
    return `${v.toFixed(dp)} ${units[i]}`;
}

function resetLists() {
    rows.value = [];
}

// Folder-first, stable rendering.
const virtualRows = computed<(Row & { __key: string })[]>(() => {
    const q = search.value.trim().toLowerCase();
    const base = !q
        ? rows.value
        : rows.value.filter((r) =>
            r.type === "folder"
                ? r.name.toLowerCase().includes(q) || r.prefix.toLowerCase().includes(q)
                : r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)
        );

    return base.map((r) => ({ ...r, __key: rowKey(r) }));
});




async function fetchPage(reset: boolean) {
    error.value = "";

    if (!connectionId.value || !bucket.value) {
        resetLists();
        error.value = "Missing connectionId or bucket.";
        return;
    }

    if (busy.value) return;

    const effectivePrefix = prefix.value || "";
    const effectiveDelimiter: string | null = "/";

    if (reset) {
        continuationToken.value = null;
        hasMore.value = false;
        resetLists();
    }

    busy.value = true;
    try {
        const res = await listObjects({
            connectionId: connectionId.value,
            bucket: bucket.value,
            prefix: effectivePrefix,
            continuationToken: reset ? null : continuationToken.value,
            maxKeys: 1000,
            delimiter: effectiveDelimiter,
        });

        if (res.isErr()) {
            if (reset) resetLists();
            error.value = res.error.message;
            return;
        }

        // Keep S3 order: prefixes then contents (as returned by API)
        for (const p of res.value.commonPrefixes) {
            const r: FolderRow = { type: "folder", prefix: p, name: nameFromPrefix(p) };
            rows.value.push(r);

        }

        for (const o of res.value.contents) {
            const r: FileRow = {
                type: "file",
                key: o.key,
                name: nameFromKey(o.key),
                size: o.size,
                lastModified: o.lastModified ?? null,
                ownerDisplayName: o.owner?.displayName ?? null,
                ownerId: o.owner?.id ?? null,
                storageClass: o.storageClass ?? null,
                fileType: guessFileTypeFromKey(o.key),
            };

            rows.value.push(r);

        }

        continuationToken.value = res.value.nextContinuationToken ?? null;
        hasMore.value = Boolean(res.value.isTruncated && continuationToken.value);
    } finally {
        busy.value = false;
    }
}



async function refresh() {
    await fetchPage(true);
}


// --- Icon logic + minimal inline SVG component ---

type IconName = "folder" | "text" | "application" | "system";

function fileExt(name: string) {
    const base = (name || "").split("/").pop() || "";
    const i = base.lastIndexOf(".");
    if (i <= 0) return "";
    return base.slice(i + 1).toLowerCase();
}

function isSystemFile(name: string, key: string) {
    const base = (name || "").split("/").pop() || name || "";
    if (base.startsWith(".")) return true;
    if (base.toLowerCase() === "thumbs.db") return true;
    if (base.toLowerCase() === "desktop.ini") return true;
    if (base.endsWith("~")) return true;
    if (key.includes("/.") || key.includes("\\.")) return true;
    return false;
}

function isTextFile(ext: string) {
    return new Set([
        "txt", "md", "markdown", "log",
        "json", "yaml", "yml", "xml", "csv",
        "ini", "cfg", "conf",
        "js", "ts", "tsx", "jsx",
        "py", "go", "rs", "java", "c", "cpp", "h", "hpp",
        "html", "css", "scss",
        "sh", "bash", "zsh",
    ]).has(ext);
}

function isApplicationFile(ext: string) {
    return new Set([
        "exe", "msi", "dmg", "pkg", "app",
        "deb", "rpm", "apk",
        "jar", "war",
        "bin",
    ]).has(ext);
}

function iconForRow(r: Row): IconName {
    if (r.type === "folder") return "folder";

    const ext = fileExt(r.name);
    if (isSystemFile(r.name, r.key)) return "system";
    if (isApplicationFile(ext)) return "application";
    if (isTextFile(ext)) return "text";
    return "application";
}

watch(
    [connectionId, bucket, prefix],
    async () => {
        error.value = "";

        if (!connectionId.value || !bucket.value) {
            resetLists();
            error.value = "Missing connectionId or bucket.";
            return;
        }

        if (prefetchAll.value) {
            await fetchAllPagesSequentially();
        } else {
            await fetchPage(true);
        }
    },
    { immediate: true }
);


function normalizePrefix(p: string): string {
    let s = (p || "").trim();

    // allow users to paste "/photos/2025/" or "photos/2025"
    while (s.startsWith("/")) s = s.slice(1);

    // collapse multiple slashes
    s = s.replace(/\/+/g, "/");

    // root
    if (s === "" || s === "/") return "";

    // ensure trailing slash so S3 "folder view" works with Delimiter="/"
    if (!s.endsWith("/")) s += "/";

    return s;
}

function goToPath() {
    const next = normalizePrefix(pathInput.value);

    router.push({
        name: "Objects",
        query: {
            connectionId: connectionId.value,
            connectionName: connectionName.value,
            bucket: bucket.value,
            prefix: next,
        },
    });
}

function goUp() {
    const p = normalizePrefix(prefix.value || "");
    if (!p) return;

    const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
    const i = trimmed.lastIndexOf("/");
    const parent = i >= 0 ? trimmed.slice(0, i + 1) : "";

    router.push({
        name: "Objects",
        query: {
            connectionId: connectionId.value,
            connectionName: connectionName.value,
            bucket: bucket.value,
            prefix: parent,
        },
    });
}
function guessFileTypeFromKey(key: string): string {
    const ext = fileExt(key);
    if (!ext) return "File";

    if (isTextFile(ext)) return "text";
    if (isApplicationFile(ext)) return "application";

    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"].includes(ext)) return "image";
    if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";
    if (["mp3", "wav", "flac", "aac", "ogg"].includes(ext)) return "audio";
    if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive";
    if (["pdf"].includes(ext)) return "pdf";

    return ext; // fallback: show extension
}
function openFile(r: FileRow) {
    // placeholder: later you can implement download / preview
    // for now do nothing or log
    // console.log("open file", r.key);
}




watch(
    () => prefix.value,
    (p) => {
        pathInput.value = p && p.length ? p : "/";

    },
    { immediate: true }
);

watch(
    () => viewMode.value,
    async (m) => {
        if (m !== "icons") return;

        await nextTick();

        const el: HTMLElement | null = iconScroller.value?.$el ?? null;
        if (!el) return;

        recalcGrid();

        ro?.disconnect();
        ro = new ResizeObserver(() => recalcGrid());
        ro.observe(el);
    },
    { immediate: true }
);

</script>