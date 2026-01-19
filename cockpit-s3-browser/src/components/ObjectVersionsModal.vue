<!-- src/components/ObjectVersionsModal.vue -->
<template>
    <div v-if="open" class="fixed inset-0 z-[10000]">
        <div class="absolute inset-0 bg-black/30" @click="$emit('close')"></div>

        <div class="absolute inset-0 flex items-center justify-center p-4">
            <div class="w-full max-w-3xl rounded-md border border-default bg-default shadow-lg overflow-hidden">
                <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-sm font-semibold text-default truncate">{{ title }}</div>
                        <div class="text-xs text-default opacity-80 truncate">{{ summary }}</div>
                    </div>

                    <button type="button"
                        class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default"
                        @click="$emit('close')">
                        Close
                    </button>
                </div>

                <div class="p-4">
                    <div v-if="err" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                        {{ err }}
                    </div>

                    <div v-if="busy" class="text-sm text-default opacity-80">Loading…</div>

                    <div v-else-if="versions.length === 0" class="text-sm text-default opacity-80">
                        No versions found.
                    </div>

                    <div v-else class="max-h-[70vh] overflow-y-auto rounded-md border border-default"
                        @contextmenu.prevent>
                        <div class="grid grid-cols-[140px_1fr_140px] gap-0 bg-well border-b border-default">
                            <div class="px-3 py-2 text-xs font-semibold text-default">When</div>
                            <div class="px-3 py-2 text-xs font-semibold text-default">Version</div>
                            <div class="px-3 py-2 text-xs font-semibold text-default text-right">Size</div>
                        </div>

                        <div v-for="(v, idx) in versions"
                            :key="(v.versionId || '') + '|' + (v.lastModified || '') + '|' + String(v.size)"
                            class="grid grid-cols-[140px_1fr_140px] gap-0 border-b border-default cursor-pointer"
                            :class="rowClass(v)" @click="onRowClick($event, v, idx)"
                            @contextmenu.prevent.stop="openMenu($event, v, idx)">
                            <div class="px-3 py-2 text-xs text-default opacity-80 truncate">
                                {{ v.lastModified ? formatDate(v.lastModified) : "—" }}
                            </div>

                            <div class="px-3 py-2 min-w-0">
                                <div class="text-sm text-default truncate">
                                    {{ v.isLatest ? "Latest" : "Version" }}
                                    <span v-if="v.versionId" class="opacity-70">({{ v.versionId }})</span>
                                </div>
                                <div v-if="v.etag" class="text-xs text-default opacity-70 truncate">
                                    ETag: {{ v.etag }}
                                </div>
                            </div>

                            <div class="px-3 py-2 text-sm text-default text-right">
                                {{ formatBytes(v.size || 0) }}
                            </div>
                        </div>
                    </div>

                    <div class="mt-3 text-xs text-default opacity-70">
                        Tip: Click to select. Ctrl/Cmd toggles. Shift selects a range.
                    </div>
                </div>
            </div>
        </div>

        <ObjectContextMenu :open="menuOpen" :pos="menuPos" mode="versions" :enabled="menuEnabled"
            @close="menuOpen = false" @action="onMenuAction" />
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatBytes, formatDate } from "../lib/helpers";
import ObjectContextMenu, { type MenuAction, type MenuPos } from "./ObjectContextMenu.vue";

export type VersionItem = {
    versionId: string | null;
    isLatest: boolean;
    lastModified: string | null;
    size: number;
    etag: string | null;
};

const props = defineProps<{
    open: boolean;
    title: string;
    summary: string;
    busy: boolean;
    err: string;
    versions: VersionItem[];
}>();

const emit = defineEmits<{
    (e: "close"): void;
    (e: "versionAction", payload: { action: "download" | "delete" | "rollback"; versions: VersionItem[] }): void;
}>();

/* Selection */
const selectedIds = ref<Set<string>>(new Set());
const anchorIndex = ref<number | null>(null);

function idFor(v: VersionItem): string {
    // If versionId is null, it can't be safely targeted for actions. Still selectable visually if you want.
    return `${v.versionId ?? ""}|${v.lastModified ?? ""}|${v.etag ?? ""}|${String(v.size ?? 0)}`;
}

function isSelected(v: VersionItem): boolean {
    return selectedIds.value.has(idFor(v));
}

function clearSelection() {
    selectedIds.value = new Set();
    anchorIndex.value = null;
}

function selectOnly(v: VersionItem, idx: number) {
    selectedIds.value = new Set([idFor(v)]);
    anchorIndex.value = idx;
}

function toggleOne(v: VersionItem, idx: number) {
    const s = new Set(selectedIds.value);
    const id = idFor(v);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selectedIds.value = s;
    anchorIndex.value = idx;
}

function selectRange(from: number, to: number) {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const s = new Set(selectedIds.value);
    for (let i = a; i <= b; i++) {
        const v = props.versions[i];
        if (!v) continue;
        s.add(idFor(v));
    }
    selectedIds.value = s;
}

function onRowClick(e: MouseEvent, v: VersionItem, idx: number) {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift && anchorIndex.value != null) {
        // Shift extends from anchor to clicked.
        // Keep existing selection, just add the range.
        selectRange(anchorIndex.value, idx);
        return;
    }

    if (isCtrl) {
        toggleOne(v, idx);
        return;
    }

    // Plain click: single select
    selectOnly(v, idx);
}

function rowClass(v: VersionItem) {
    if (isSelected(v)) return "bg-well";
    return "hover:bg-well";
}

/* Context menu */
const menuOpen = ref(false);
const menuPos = ref<MenuPos>({ x: 0, y: 0 });

function openMenu(e: MouseEvent, v: VersionItem, idx: number) {
    if (!isSelected(v)) {
        selectOnly(v, idx);
    }

    menuPos.value = { x: e.clientX, y: e.clientY };
    menuOpen.value = true;
}

const selectedVersions = computed(() => {
    const ids = selectedIds.value;
    return props.versions.filter((v) => ids.has(idFor(v)));
});

const menuEnabled = computed(() => {
    const picked = selectedVersions.value;
    if (picked.length === 0) return { download: false, delete: false, rollback: false } as const;

    // Only enable actions if every selected item has a versionId (otherwise you can't target it).
    const allHaveId = picked.every((v) => Boolean(v.versionId));

    // rollback: allow only when exactly one item selected and it's not already latest
    const canRollback = allHaveId && picked.length === 1 && !picked[0].isLatest;

    return {
        download: allHaveId,
        delete: allHaveId,
        rollback: canRollback,
    } as const;
});

function onMenuAction(action: MenuAction) {
    const picked = selectedVersions.value;
    if (picked.length === 0) return;

    if (action === "download" || action === "delete" || action === "rollback") {
        emit("versionAction", { action, versions: picked });
    }
}

/* Reset selection when list changes / modal closes */
watch(
    () => props.open,
    (v) => {
        if (!v) clearSelection();
    },
);

watch(
    () => props.versions,
    () => {
        // If versions refresh, clear selection to avoid mismatches
        clearSelection();
    },
);
</script>