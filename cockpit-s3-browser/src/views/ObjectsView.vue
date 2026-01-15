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
                        <div class="relative" ref="uploadMenuRef">
                            <button type="button"
                                class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                                :disabled="busy || uploadBusy" @click="toggleUploadMenu">
                                Upload
                            </button>

                            <div v-if="uploadMenuOpen"
                                class="absolute right-0 mt-2 w-44 rounded-md border border-default bg-default shadow-lg z-[9999]">
                                <button type="button" class="w-full text-left px-3 py-2 text-sm hover:bg-well"
                                    :disabled="busy || uploadBusy" @click="chooseUpload('files')">
                                    Files…
                                </button>

                                <button type="button" class="w-full text-left px-3 py-2 text-sm hover:bg-well"
                                    :disabled="busy || uploadBusy" @click="chooseUpload('folder')">
                                    Folder…
                                </button>
                            </div>
                        </div>


                    </div>
                </div>

                <div class="p-4">
                    <div v-if="error" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                        {{ error }}
                    </div>
                    <div v-if="downloadBusy" class="mb-3 rounded-md border border-yellow-300 bg-default p-3 text-sm">
                        <div class="font-semibold">Download in progress</div>
                        <div class="opacity-80">Do not close or refresh this tab.</div>

                        <div class="mt-2 space-y-1 text-xs">
                            <div v-for="j in downloadJobs" :key="j.id">
                                <span class="font-semibold">{{ j.name }}</span>
                                <span class="opacity-80"> — {{ j.state }}</span>
                                <span v-if="j.totalBytes && j.bytes != null" class="opacity-80">
                                    ({{ formatBytes(j.bytes) }} / {{ formatBytes(j.totalBytes) }})
                                </span>
                                <span v-if="j.error" class="text-red-700"> — {{ j.error }}</span>
                            </div>
                        </div>
                    </div>
                    <div v-if="pasteItems.length" class="mb-3 rounded-md border border-default bg-default p-3 text-sm">
                        <div class="flex items-center justify-between gap-3">
                            <div class="font-semibold">
                                Pasting: {{ pasteDone }} / {{ pasteTotal }}
                            </div>
                            <div v-if="pastePct != null" class="text-xs opacity-80">{{ pastePct }}%</div>
                        </div>

                        <div v-if="pastePct != null" class="mt-2">
                            <div class="h-2 w-full rounded bg-well overflow-hidden">
                                <div class="h-2 bg-default" :style="{ width: pastePct + '%' }"></div>
                            </div>
                        </div>

                        <div class="mt-2 max-h-44 overflow-auto space-y-1 text-xs">
                            <div v-for="p in pasteItems" :key="p.id" class="flex items-center justify-between gap-2">
                                <div class="min-w-0 truncate" :title="p.dstKey">{{ p.name }}</div>
                                <div class="shrink-0 opacity-80">
                                    <span v-if="p.step === 'queued'">Queued</span>
                                    <span v-else-if="p.step === 'copying'">Copying…</span>
                                    <span v-else-if="p.step === 'done'">Done</span>
                                    <span v-else-if="p.step === 'canceled'">Canceled</span>
                                    <span v-else>Failed</span>
                                </div>
                            </div>

                            <template v-for="p in pasteItems" :key="p.id + ':err'">
                                <div v-if="p.step === 'failed' && p.error" class="text-red-700">
                                    {{ p.name }}: {{ p.error }}
                                </div>
                            </template>

                        </div>
                    </div>

                    <div v-if="uploadItems.length" class="mb-3 rounded-md border border-default bg-default p-3 text-sm">
                        <div class="flex items-center justify-between gap-3">
                            <div class="font-semibold">Upload queue: {{ uploadItems.length }}</div>
                            <div v-if="overallPct != null" class="text-xs opacity-80">Overall: {{ overallPct }}%</div>
                        </div>

                        <div class="mt-2 max-h-44 overflow-auto space-y-1">
                            <div v-for="u in uploadItems" :key="u.id" class="flex items-center justify-between gap-2">
                                <div class="min-w-0 truncate" :title="u.file.name">{{ u.file.name }}</div>

                                <div class="shrink-0 text-xs opacity-80">
                                    <span v-if="u.status === 'uploading'">
                                        {{ formatBytes(u.bytes) }} / {{ formatBytes(u.file.size) }}
                                    </span>
                                    <span v-else-if="u.status === 'queued'">Queued</span>
                                    <span v-else-if="u.status === 'done'">Done</span>
                                    <span v-else-if="u.status === 'canceled'">Canceled</span>
                                    <span v-else>Failed</span>
                                </div>
                            </div>
                            <template v-for="u in uploadItems" :key="u.id + ':err'">
                                <div v-if="u.status === 'failed' && u.error" class="text-xs text-red-700">
                                    {{ u.file.name }}: {{ u.error }}
                                </div>
                            </template>



                        </div>
                    </div>

                    <div v-if="uploadProgress" class="mb-3 rounded-md border border-default bg-default p-3 text-sm">
                        <div class="flex items-center justify-between gap-3">
                            <div class="font-semibold">Uploading: {{ uploadProgress.filename }}</div>

                            <button type="button"
                                class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold"
                                :disabled="!(uploadCancelAll || uploadCancel)" @click="(uploadCancelAll || uploadCancel)?.()
                                    ">
                                Cancel
                            </button>
                        </div>

                        <div class="mt-1">{{ formatBytes(uploadProgress.bytes) }} / {{ formatBytes(uploadProgress.size)
                            }}</div>

                        <div v-if="uploadPct != null" class="mt-2">
                            <div class="h-2 w-full rounded bg-well overflow-hidden">
                                <div class="h-2 bg-default" :style="{ width: uploadPct + '%' }"></div>
                            </div>
                            <div class="mt-1 text-xs opacity-80">{{ uploadPct }}%</div>
                        </div>
                    </div>

                    <div v-if="renameProgress" class="mb-3 rounded-md border border-default bg-default p-3 text-sm">
                        <div class="font-semibold">Renaming</div>
                        <button type="button"
                            class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold"
                            :disabled="!renameCancel" @click="cancelRename">
                            Cancel
                        </button>
                        <div class="mt-1">{{ renameStatusText }}</div>

                        <div v-if="renamePct != null" class="mt-2">
                            <div class="h-2 w-full rounded bg-well overflow-hidden">
                                <div class="h-2 bg-default" :style="{ width: renamePct + '%' }"></div>
                            </div>
                            <div class="mt-1 text-xs opacity-80">{{ renamePct }}%</div>
                        </div>
                    </div>
                    <div v-if="transferBusy" class="mb-3 rounded-md border border-yellow-300 bg-default p-3 text-sm">
                        <div class="font-semibold">Transfer in progress</div>
                        <div class="opacity-80">Do not close or refresh this tab.</div>

                        <div class="mt-2 space-y-1 text-xs">
                            <div v-for="j in transferJobs" :key="j.id">
                                <span class="font-semibold">{{ j.kind.toUpperCase() }}</span>
                                <span class="opacity-80"> — {{ j.name }}</span>
                                <span class="opacity-80"> — {{ j.state }}</span>
                                <span v-if="j.error" class="text-red-700"> — {{ j.error }}</span>
                            </div>
                        </div>
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
                        <div class="w-full" @contextmenu="openMenuAtPoint">
                            <RecycleScroller class="w-full overflow-y-auto h-[96vh]"
                                style="scrollbar-gutter: stable; height: 96vh;;" :items="virtualRows" :item-size="56"
                                key-field="__key" v-slot="{ item: r, index }">
                                <div class="w-full hover:bg-default border-b border-default cursor-pointer outline-none"
                                    :style="colsStyle + 'align-items:center; height:56px;'"
                                    :class="selectedIds.has(rowId(r)) ? 'bg-well' : ''"
                                    @click="onRowClick($event, r, index)" @dblclick="onRowDblClick(r)"
                                    @keydown.enter.prevent="onRowDblClick(r)"
                                    @contextmenu.prevent.stop="openMenu($event, r, index)">
                                    <div class="px-3 py-2 text-default min-w-0">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <span class="shrink-0 opacity-80 w-4 h-4"></span>

                                            <div class="min-w-0 flex items-center gap-2">
                                                <button v-if="r.type === 'folder'" type="button"
                                                    class="font-semibold text-default hover:opacity-90 truncate min-w-0"
                                                    :disabled="busy || isDeletingRow(r)"
                                                    @click.stop="onRowClick($event, r, index)"
                                                    @dblclick.stop.prevent="openPrefix(r.prefix)"
                                                    @keydown.enter.stop.prevent="openPrefix(r.prefix)"
                                                    @contextmenu.stop.prevent="openMenu($event, r, index)">
                                                    {{ r.name }}/
                                                </button>

                                                <div v-else class="min-w-0">
                                                    <div class="text-default text-sm truncate" :title="r.key">{{ r.name
                                                    }}
                                                    </div>
                                                </div>

                                                <span v-if="isDeletingRow(r)"
                                                    class="text-xs rounded-full border border-default px-2 py-0.5 opacity-80">
                                                    Deleting…
                                                </span>
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
                                        <span v-if="r.type === 'file'">{{ r.ownerDisplayName || r.ownerId || "—"
                                        }}</span>
                                        <span v-else>—</span>
                                    </div>

                                    <div class="px-3 py-2 text-default min-w-0 truncate">
                                        <span v-if="r.type === 'file'">{{ r.storageClass || "—" }}</span>
                                        <span v-else>—</span>
                                    </div>
                                </div>
                            </RecycleScroller>
                        </div>
                    </div>

                    <!-- ICON VIEW -->
                    <div v-else class="rounded-md border border-default overflow-y-scroll"
                        @contextmenu="openMenuAtPoint">
                        <RecycleScroller ref="iconScroller" class=" w-full overflow-y-auto p-4  "
                            style="height: 96vh; scrollbar-gutter: stable; " :items="virtualRows"
                            :grid-items="gridItems" :item-size="120" :item-secondary-size="150" key-field="__key"
                            v-slot="{ item: r, index }">
                            <button type="button"
                                class="w-full h-full rounded-md border border-default bg-default p-3 text-left hover:opacity-90 active:opacity-80"
                                :class="selectedIds.has(rowId(r)) ? 'ring-2 ring-default' : ''"
                                @click="onRowClick($event, r, index)" @dblclick="onRowDblClick(r)"
                                @contextmenu.prevent.stop="openMenu($event, r, index)">
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
                                    <div v-if="isDeletingRow(r)"
                                        class="text-xs mt-1 rounded-full border border-default px-2 py-0.5 opacity-80">
                                        Deleting…
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
    <ObjectContextMenu :open="menuOpen" :pos="menuPos" :canPaste="canPasteHere" @close="menuOpen = false"
        @action="onMenuAction" />
    <ConfirmDeleteModal :open="deleteOpen" :kind="pendingDeleteKind" :name="pendingDeleteName" :busy="deleteBusy"
        :progressText="deleteBusy ? 'Deleting…' : ''" @cancel="cancelDelete" @confirm="confirmDeleteNow" />




</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
    listObjects, deleteObject, deletePrefixStreamed, renameObjectStreamed, uploadObjectFromStdinStreamed, downloadPrefixTarGz, downloadObject, getDownloadJobStatus
    , copyPrefix, movePrefix, copyObject
} from "../lib/s3Objects";
import { useClipboardStore } from "../stores/clipboard";
import { ArrowRightEndOnRectangleIcon, ArrowUpIcon, ArrowPathIcon, MagnifyingGlassCircleIcon } from "@heroicons/vue/20/solid";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import ObjectContextMenu, { type MenuAction } from "../components/ObjectContextMenu.vue";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal.vue";
import { useDeleteTasksStore } from "../stores/deleteTasks";
import {
    formatBytes, formatDate, normalizePrefix, guessFileTypeFromKey, fileExt,
    isSystemFile, isTextFile, isApplicationFile, nameFromKey, nameFromPrefix,
} from "../lib/helpers";
import { DeleteKind, FileRow, FolderRow, Row, ViewMode } from "../types";
import { useDownloads } from "../operations/useDownloads";
import { useUploads } from "../operations/useUploads";
import { useTransfers } from "../operations/useTransfers";
import { useRename } from "../operations/useRename";
import { useDeletes } from "../operations/useDeletes";


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



const delStore = useDeleteTasksStore();


// confirm modal pending target (separate from tasks)
const pendingDeleteItems = ref<Row[]>([]);
const pendingDeleteKind = computed<DeleteKind>(() => {
    if (pendingDeleteItems.value.length === 1) {
        return pendingDeleteItems.value[0].type === "folder" ? "folder" : "file";
    }
    // if multiple, modal can still show "file" or "folder" but better to show file
    return "file";
});

const pendingDeleteName = computed(() => {
    const items = pendingDeleteItems.value;
    if (items.length === 0) return "";
    if (items.length === 1) return items[0].type === "folder" ? `${items[0].name}/` : items[0].name;
    return `${items.length} items`;
});

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
const menuOpen = ref(false);
const menuPos = ref({ x: 0, y: 0 });
const menuRow = ref<Row | null>(null);
const selectedIds = ref<Set<string>>(new Set());
const anchorIndex = ref<number | null>(null);
const clip = useClipboardStore();

const canPasteHere = computed(() =>
    clip.canPaste(connectionId.value, bucket.value)
);
// Keep folders/files separately so we can always render folder-first.
const rows = ref<Row[]>([]);

const continuationToken = ref<string | null>(null);
const hasMore = ref(false);
let runId = 0;
const deleteOpen = ref(false);


const downloads = useDownloads({
    connectionId,
    bucket,
    downloadObject,
    downloadPrefixTarGz,
    getDownloadJobStatus,
    setError: (m) => (error.value = m),
});

const downloadJobs = downloads.downloadJobs;
const downloadBusy = downloads.downloadBusy;


const uploads = useUploads({
    connectionId,
    bucket,
    prefix,
    uploadObjectFromStdinStreamed,
    refresh,
    setError: (m) => (error.value = m),
});

const uploadBusy = uploads.uploadBusy;
const uploadItems = uploads.uploadItems;
const uploadProgress = uploads.uploadProgress;
const uploadPct = uploads.uploadPct;
const overallPct = uploads.overallPct;
const uploadCancel = uploads.uploadCancel;
const uploadCancelAll = uploads.uploadCancelAll;

const transfers = useTransfers({
    connectionId,
    bucket,
    prefix,
    clip,
    copyObject,
    copyPrefix,
    movePrefix,
    renameObjectStreamed,
    refresh,
    setError: (m) => (error.value = m),
    setBusy: (b) => (busy.value = b),
});

const transferJobs = transfers.transferJobs;
const transferBusy = transfers.transferBusy;

const pasteItems = transfers.pasteItems;
const pasteBusy = transfers.pasteBusy;
const pasteTotal = transfers.pasteTotal;
const pasteDone = transfers.pasteDone;
const pastePct = transfers.pastePct;

const renamer = useRename({
    connectionId,
    bucket,
    renameObjectStreamed,
    setError: (m) => (error.value = m),
    setBusy: (b) => (busy.value = b),
    onRenamed: (srcKey, dstKey) => updateRowAfterRename(srcKey, dstKey),
});

const renameProgress = renamer.renameProgress;
const renameStatusText = renamer.renameStatusText;
const renamePct = renamer.renamePct;
const renameCancel = renamer.renameCancel;


const deletes = useDeletes({
    connectionId,
    bucket,
    delStore,
    deletePrefixStreamed,
    deleteObject,
    refresh,
});

const deleteBusy = deletes.deleteBusy;
const isDeletingRow = deletes.isDeletingRow;



async function chooseUpload(kind: UploadPickKind) {
    closeUploadMenu();
    if (kind === "files") await uploads.pickFiles();
    else await uploads.pickFolder();
}


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

function activateRow(r: Row) {
    if (isDeletingRow(r)) return;
    if (r.type === "folder") openPrefix(r.prefix);
    else openFile(r);
}

const selectedRows = computed<Row[]>(() => {
    const ids = selectedIds.value;
    return virtualRows.value.filter((r) => ids.has(rowId(r)));
});

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




function cancelRename() {
    renamer.cancelRename();
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



async function refresh() {
    await fetchPage(true);
}

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

// --- Icon logic + minimal inline SVG component ---

type IconName = "folder" | "text" | "application" | "system";



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

function openMenuAtPoint(e: MouseEvent) {
  e.preventDefault();
  menuRow.value = null;

  menuOpen.value = true;
  menuPos.value = { x: e.clientX, y: e.clientY };
}

function openMenu(e: MouseEvent, r: Row, index: number) {
    if (isDeletingRow(r)) return;
    e.preventDefault();

    const id = rowId(r);

    // Desktop convention: right-click selects row if not already selected
    if (!selectedIds.value.has(id)) {
        setSingleSelection(id, index);
    } else {
        // keep anchor sensible for next shift-click
        anchorIndex.value = index;
    }

    menuOpen.value = true;
    menuPos.value = { x: e.clientX, y: e.clientY };
    menuRow.value = r;
}


async function onMenuAction(action: MenuAction) {
    const r = menuRow.value;
    if (action !== "paste" && !r) return;

    if (action === "copy") {
        const items = effectiveSelection();
        if (items.length === 0) return;
        clip.set("copy", connectionId.value, bucket.value, selectionToClipItems(items));
        return;
    }

    if (action === "cut") {
        const items = effectiveSelection();
        if (items.length === 0) return;
        clip.set("cut", connectionId.value, bucket.value, selectionToClipItems(items));
        return;
    }

    if (action === "download") {
        const items = effectiveSelection();
        if (items.length === 0) return;
        await downloads.downloadSelection(items);
        return;
    }

    if (action === "delete") {
        const items = effectiveSelection();
        if (items.length === 0) return;

        // filter out items already deleting
        const filtered = items.filter((it) => !isDeletingRow(it));
        if (filtered.length === 0) return;

        pendingDeleteItems.value = filtered;
        menuOpen.value = false;

        deleteOpen.value = true;
        return;
    }


    if (action === "rename") {
        const items = effectiveSelection();
        const files = items.filter(isFileRow);
        if (files.length !== 1 || items.length !== 1) {
            error.value = "Select a single file to rename.";
            return;
        }

        const f = files[0];
        const newName = window.prompt("Rename to:", f.name);
        if (!newName) return;

        const basePrefix = prefix.value || "";
        const cleaned = newName.replace(/\//g, "").trim();
        if (!cleaned) return;

        const dstKey = (basePrefix ? basePrefix : "") + cleaned;
        await renamer.renameFile(f.key, dstKey);
        return;
    }

    if (action === "paste") {
        await transfers.pasteHere();
        return;
    }
}


function confirmDeleteNow() {
    const items = pendingDeleteItems.value;
    deleteOpen.value = false;
    pendingDeleteItems.value = [];

    if (!items.length) return;
    deletes.deleteNow(items);
}

function cancelDelete() {
    deleteOpen.value = false;
    pendingDeleteItems.value = [];
}

function setSingleSelection(id: string, index: number) {
    selectedIds.value = new Set([id]);
    anchorIndex.value = index;
}

function toggleSelection(id: string, index: number) {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
    anchorIndex.value = index;
}

function selectRange(from: number, to: number, replace: boolean) {
    const a = Math.min(from, to);
    const b = Math.max(from, to);

    const next = replace ? new Set<string>() : new Set(selectedIds.value);

    for (let i = a; i <= b; i++) {
        const rr = virtualRows.value[i];
        if (!rr) continue;
        next.add(rowId(rr));
    }

    selectedIds.value = next;
}

function onRowClick(e: MouseEvent, r: Row, index: number) {
    if (isDeletingRow(r)) return;

    const id = rowId(r);
    const isToggle = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    // Shift-click: range selection
    if (isShift && anchorIndex.value != null) {
        // Windows Explorer behavior:
        // - Shift alone replaces selection with range
        // - Ctrl/Cmd + Shift adds range
        selectRange(anchorIndex.value, index, !isToggle);
        return;
    }

    // Ctrl/Cmd-click: toggle
    if (isToggle) {
        toggleSelection(id, index);
        return;
    }

    // Normal click: single
    setSingleSelection(id, index);
}

function onRowDblClick(r: Row) {
    if (isDeletingRow(r)) return;

    // Ensure it becomes selected (optional; keeps desktop feel)
    const id = rowId(r);
    if (!selectedIds.value.has(id)) {
        const idx = virtualRows.value.findIndex((x) => rowId(x) === id);
        if (idx >= 0) setSingleSelection(id, idx);
        else selectedIds.value = new Set([id]);
    }

    activateRow(r);
}

watch([connectionId, bucket, prefix], () => {
    selectedIds.value = new Set();
    anchorIndex.value = null;
});

function effectiveSelection(): Row[] {
    const sel = selectedRows.value;
    if (sel.length > 0) return sel;
    return menuRow.value ? [menuRow.value] : [];
}


function isFileRow(r: Row): r is FileRow {
    return r.type === "file";
}


function updateRowAfterRename(srcKey: string, dstKey: string) {
    const i = rows.value.findIndex((r) => r.type === "file" && r.key === srcKey);
    if (i < 0) return;

    const old = rows.value[i] as FileRow;

    const newName = nameFromKey(dstKey);
    rows.value[i] = {
        ...old,
        key: dstKey,
        name: newName,
        fileType: guessFileTypeFromKey(dstKey),
    };
}


type UploadPickKind = "files" | "folder";

const uploadMenuOpen = ref(false);
const uploadMenuRef = ref<HTMLElement | null>(null);

function toggleUploadMenu() {
    if (busy.value || uploadBusy.value) return;
    uploadMenuOpen.value = !uploadMenuOpen.value;
}

function closeUploadMenu() {
    uploadMenuOpen.value = false;
}

function onDocMouseDown(e: MouseEvent) {
    if (!uploadMenuOpen.value) return;
    const el = uploadMenuRef.value;
    if (!el) return;
    if (e.target instanceof Node && !el.contains(e.target)) {
        closeUploadMenu();
    }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!downloadBusy.value && !transferBusy.value && !pasteBusy.value) return;
    e.preventDefault();
    e.returnValue = "";
}






onMounted(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("beforeunload", onBeforeUnload);

});

onBeforeUnmount(() => {
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("beforeunload", onBeforeUnload);

});



function selectionToClipItems(items: Row[]) {
    return items.map((it) =>
        it.type === "folder"
            ? ({ type: "folder", prefix: it.prefix, name: it.name } as const)
            : ({ type: "file", key: it.key, name: it.name } as const)
    );
}
</script>