<template>
    <div class="w-full px-6 py-6">
        <div class="mx-auto w-full max-w-6xl">
            <div class="rounded-md border border-default bg-accent shadow-sm">
                <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-base font-semibold text-default truncate">{{ bucket || "—" }}</div>
                        <div class="text-sm text-default truncate">Connection: {{ connectionName || "—" }}</div>
                        <div class="text-xs text-default truncate">Prefix: {{ prefix || "/" }}</div>
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
                            Refresh
                        </button>
                    </div>
                </div>

                <div class="p-4">
                    <div v-if="error" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                        {{ error }}
                    </div>

                    <div class="overflow-x-auto rounded-md border border-default">
                        <table class="w-full border-collapse text-sm">
                            <thead>
                                <tr class="bg-well text-left text-default">
                                    <th class="px-3 py-2 font-semibold border-b border-default">Name</th>
                                    <th class="px-3 py-2 font-semibold border-b border-default">Size</th>
                                    <th class="px-3 py-2 font-semibold border-b border-default">Last modified</th>
                                    <th class="px-3 py-2 font-semibold border-b border-default">Owner</th>
                                    <th class="px-3 py-2 font-semibold border-b border-default">Storage class</th>

                                </tr>
                            </thead>

                            <tbody>
                                <tr v-if="busy && displayRows.length === 0">
                                    <td colspan="3" class="px-3 py-10 text-center text-default">Loading...</td>
                                </tr>

                                <tr v-else-if="!busy && displayRows.length === 0">
                                    <td colspan="3" class="px-3 py-10 text-center text-default">No objects found.</td>
                                </tr>

                                <tr v-for="r in displayRows" :key="rowKey(r)" class="hover:bg-default">
                                    <td class="px-3 py-2 border-b border-default text-default">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <span class="shrink-0 w-4 h-4 opacity-80">
                                                <svg v-if="iconForRow(r) === 'folder'" class="w-4 h-4"
                                                    viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
                                                    stroke-width="1.8" stroke="currentColor">
                                                    <path
                                                        d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
                                                </svg>

                                                <svg v-else-if="iconForRow(r) === 'text'" class="w-4 h-4"
                                                    viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
                                                    stroke-width="1.8" stroke="currentColor">
                                                    <path
                                                        d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
                                                    <path d="M14 3v4a2 2 0 0 0 2 2h4" />
                                                    <path d="M8 13h8" />
                                                    <path d="M8 17h8" />
                                                </svg>

                                                <svg v-else-if="iconForRow(r) === 'system'" class="w-4 h-4"
                                                    viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
                                                    stroke-width="1.8" stroke="currentColor">
                                                    <path d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z" />
                                                    <path d="M4 12h2" />
                                                    <path d="M18 12h2" />
                                                    <path d="M12 4v2" />
                                                    <path d="M12 18v2" />
                                                    <path d="M6.3 6.3l1.4 1.4" />
                                                    <path d="M16.3 16.3l1.4 1.4" />
                                                    <path d="M17.7 6.3l-1.4 1.4" />
                                                    <path d="M7.7 16.3l-1.4 1.4" />
                                                </svg>

                                                <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none"
                                                    xmlns="http://www.w3.org/2000/svg" stroke-width="1.8"
                                                    stroke="currentColor">
                                                    <path
                                                        d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
                                                    <path d="M8 7h8" />
                                                    <path d="M8 11h8" />
                                                    <path d="M8 15h5" />
                                                </svg>
                                            </span>

                                            <button v-if="r.type === 'folder'" type="button"
                                                class="font-semibold text-default hover:opacity-90 truncate"
                                                :disabled="busy" @click="openPrefix(r.prefix)">
                                                {{ r.name }}/
                                            </button>

                                            <div v-else class="min-w-0">
                                                <div class="font-medium truncate" :title="r.key">{{ r.name }}</div>
                                            </div>
                                        </div>
                                    </td>

                                    <td class="px-3 py-2 border-b border-default text-default">
                                        <span v-if="r.type === 'file'">{{ formatBytes(r.size) }}</span>
                                        <span v-else class="text-default">—</span>
                                    </td>

                                    <td class="px-3 py-2 border-b border-default text-default">
                                        <span v-if="r.type === 'file'">{{ formatDate(r.lastModified) }}</span>
                                        <span v-else class="text-default">—</span>
                                    </td>
                                    <td class="px-3 py-2 border-b border-default text-default">
                                        <span v-if="r.type === 'file'">{{ r.ownerDisplayName || r.ownerId || "—"
                                            }}</span>
                                        <span v-else>—</span>
                                    </td>

                                    <td class="px-3 py-2 border-b border-default text-default">
                                        <span v-if="r.type === 'file'">{{ r.storageClass || "—" }}</span>
                                        <span v-else>—</span>
                                    </td>

                                </tr>
                            </tbody>

                        </table>
                    </div>

                    <div class="mt-3 flex items-center justify-between">
                        <div class="text-xs text-default">
                            Loaded: <span class="text-default">{{ displayRows.length }}</span>
                        </div>

                        <button v-if="hasMore" type="button"
                            class="inline-flex items-center justify-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                            :disabled="busy" @click="loadMore">
                            Load more
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listObjects } from "../lib/s3Objects";

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



const route = useRoute();
const router = useRouter();

const connectionId = computed(() => String(route.query.connectionId || ""));
const connectionName = computed(() => String(route.query.connectionName || ""));
const bucket = computed(() => String(route.query.bucket || ""));
const prefix = computed(() => String(route.query.prefix || ""));

const busy = ref(false);
const error = ref("");

// Keep folders/files separately so we can always render folder-first.
const folders = ref<FolderRow[]>([]);
const files = ref<FileRow[]>([]);

// Dedup across pagination
const seenFolderPrefixes = ref<Set<string>>(new Set());
const seenFileKeys = ref<Set<string>>(new Set());

const continuationToken = ref<string | null>(null);
const hasMore = ref(false);

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
            prefix: p,
        },
    });
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

// Folder-first, stable rendering.
const displayRows = computed<Row[]>(() => {
    const fs = [...folders.value].sort((a, b) => a.name.localeCompare(b.name));
    const fl = [...files.value].sort((a, b) => a.name.localeCompare(b.name));
    return [...fs, ...fl];
});

function resetLists() {
    folders.value = [];
    files.value = [];
    seenFolderPrefixes.value = new Set();
    seenFileKeys.value = new Set();
}

async function fetchPage(reset: boolean) {
    error.value = "";

    if (!connectionId.value || !bucket.value) {
        resetLists();
        error.value = "Missing connectionId or bucket.";
        return;
    }

    if (busy.value) return;

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
            prefix: prefix.value || "",
            continuationToken: reset ? null : continuationToken.value,
            maxKeys: 200,
            delimiter: "/",
        });

        if (res.isErr()) {
            if (reset) resetLists();
            error.value = res.error.message;
            return;
        }

        // Add folders from every page, not just first page.
        for (const p of res.value.commonPrefixes) {
            if (!seenFolderPrefixes.value.has(p)) {
                seenFolderPrefixes.value.add(p);
                folders.value.push({ type: "folder", prefix: p, name: nameFromPrefix(p) });
            }
        }

        // Add files from every page (dedup).
        for (const o of res.value.contents) {
            if (!seenFileKeys.value.has(o.key)) {
                seenFileKeys.value.add(o.key);
                files.value.push({
                    type: "file",
                    key: o.key,
                    name: nameFromKey(o.key),
                    size: o.size,
                    lastModified: o.lastModified ?? null,
                    ownerDisplayName: o.owner?.displayName ?? null,
                    ownerId: o.owner?.id ?? null,

                });
            }
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

async function loadMore() {
    if (!hasMore.value) return;
    await fetchPage(false);
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

watch([connectionId, bucket, prefix], () => {
    refresh();
}, { immediate: true });

onMounted(refresh);
</script>