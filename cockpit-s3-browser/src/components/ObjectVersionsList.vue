<!-- src/components/ObjectVersionsList.vue -->
<template>
    <div class="w-full min-w-0">
        <div class="rounded-md border border-default bg-default">
            <!-- header -->
            <div class="border-b border-default px-3 py-2 flex items-center justify-between gap-2">
                <div class="min-w-0">
                    <div class="text-sm font-semibold text-default truncate">Versions</div>
                    <div class="text-xs text-default opacity-70 truncate">
                        <span v-if="busy">Loading…</span>
                        <span v-else-if="err">{{ err }}</span>
                        <span v-else>{{ summaryText }}</span>
                    </div>
                </div>

                <button type="button"
                    class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-2 py-1.5 text-sm font-semibold text-default disabled:opacity-60"
                    :disabled="busy" @click="clearSelection" title="Clear selection">
                    Clear
                </button>
            </div>

            <!-- error block -->
            <div v-if="err && !busy" class="m-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
                {{ err }}
            </div>

            <!-- hint / status -->
            <div class="px-3 py-2 border-b border-default flex items-center justify-between gap-2">
                <div class="text-xs text-default opacity-80">
                    Selected: <span class="font-semibold">{{ selectedCount }}</span>
                </div>
                <div class="text-xs text-default opacity-70">
                    Right-click for actions
                </div>
            </div>
<!-- columns header -->
<div class="bg-well text-left text-default w-full" :style="headerStyle + 'scrollbar-gutter: stable;'">
  <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">
    Version ID
  </div>
  <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">
    Size
  </div>
  <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">
    Last modified
  </div>
  <div class="px-3 py-2 font-semibold border-b border-default min-w-0 truncate">
    Storage class
  </div>
</div>

            <!-- list -->
            <div class="w-full" @contextmenu.prevent="onBlankContextMenu">
                <RecycleScroller class="w-full overflow-y-auto" style="height: 80vh; scrollbar-gutter: stable;"
                    :items="itemsWithKey" :item-size="56" key-field="__key" v-slot="{ item: v, index }">
                    <div class="w-full border-b border-default cursor-pointer outline-none hover:bg-well"
                        :class="isSelected(v.versionId) ? 'bg-well' : ''" :style="rowStyle"
                        @click="onClick($event, v, index)"
                        @contextmenu.prevent.stop="onRowContextMenu($event, v, index)">
                        <div class="px-3 py-2 min-w-0">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="shrink-0 text-xs rounded-full border border-default px-2 py-0.5"
                                    :class="v.isLatest ? 'opacity-100' : 'opacity-70'"
                                    :title="v.isLatest ? 'Latest' : 'Not latest'">
                                    {{ v.isLatest ? "Latest" : "Version" }}
                                </span>

                                <div class="min-w-0">
                                    <div class="text-sm text-default truncate" :title="v.versionId">
                                        {{ v.versionId }}
                                    </div>
                                    <div class="text-xs text-default opacity-70 truncate">
                                        {{ subline(v) }}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="px-3 py-2 text-default min-w-0 truncate text-sm">
                            {{ formatBytesSafe(v.size) }}
                        </div>

                        <div class="px-3 py-2 text-default min-w-0 truncate text-sm">
                            {{ formatDateSafe(v.lastModified) }}
                        </div>

                        <div class="px-3 py-2 text-default min-w-0 truncate text-sm">
                            {{ v.storageClass || "—" }}
                        </div>
                    </div>
                </RecycleScroller>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { VersionRow } from "../types";
import { formatBytes, formatDate } from "../lib/helpers";

type MenuPos = { x: number; y: number };
const headerStyle =
  "display:grid; grid-template-columns: 1.6fr 0.6fr 0.9fr 0.8fr; width:100%;";

const props = defineProps<{
    busy: boolean;
    err: string;
    items: VersionRow[];
    selectedVersionIds: Set<string>;
}>();

const emit = defineEmits<{
    (e: "select", ids: Set<string>): void;
    (e: "contextmenu", payload: { pos: MenuPos; versionId: string | null; index: number | null }): void;
}>();

const rowStyle =
    "display:grid; grid-template-columns: 1.6fr 0.6fr 0.9fr 0.8fr; width:100%; align-items:center; height:56px;";

const itemsWithKey = computed(() =>
    props.items.map((x) => ({ ...x, __key: x.__key ?? `v:${x.versionId}` })),
);

const selectedCount = computed(() => props.selectedVersionIds?.size ?? 0);

const summaryText = computed(() => {
    const n = props.items.length;
    const total = props.items.reduce((acc, v) => acc + (Number(v.size) || 0), 0);
    return `${n} version${n === 1 ? "" : "s"} · ${formatBytes(total)}`;
});

function isSelected(versionId: string) {
    return props.selectedVersionIds?.has(versionId) ?? false;
}

function clearSelection() {
    emit("select", new Set());
}

function formatBytesSafe(n: number | null | undefined) {
    const v = Number(n ?? 0);
    return formatBytes(Number.isFinite(v) ? v : 0);
}

function formatDateSafe(iso: string | null | undefined) {
    if (!iso) return "—";
    return formatDate(iso);
}

function subline(v: VersionRow) {
    const parts: string[] = [];
    if (v.etag) parts.push(`ETag ${v.etag}`);
    return parts.join(" · ") || "—";
}

function onClick(e: MouseEvent, v: VersionRow, index: number) {
    if (props.busy) return;

    const isToggle = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift) {
        const all = props.items;
        const ids = all.map((x) => x.versionId);
        const current = [...props.selectedVersionIds];
        const anchor = current.length ? current[current.length - 1] : v.versionId;

        const a = ids.indexOf(anchor);
        const b = ids.indexOf(v.versionId);

        if (a >= 0 && b >= 0) {
            const from = Math.min(a, b);
            const to = Math.max(a, b);
            const next = isToggle ? new Set(props.selectedVersionIds) : new Set<string>();
            for (let i = from; i <= to; i++) next.add(ids[i]);
            emit("select", next);
            return;
        }
    }

    if (isToggle) {
        const next = new Set(props.selectedVersionIds);
        if (next.has(v.versionId)) next.delete(v.versionId);
        else next.add(v.versionId);
        emit("select", next);
        return;
    }

    emit("select", new Set([v.versionId]));
}

function ensureSelectedForContext(versionId: string, index: number) {
    if (!props.selectedVersionIds.has(versionId)) {
        emit("select", new Set([versionId]));
    }
}

function onRowContextMenu(e: MouseEvent, v: VersionRow, index: number) {
    if (props.busy) return;

    ensureSelectedForContext(v.versionId, index);

    emit("contextmenu", {
        pos: { x: e.clientX, y: e.clientY },
        versionId: v.versionId,
        index,
    });
}

function onBlankContextMenu(e: MouseEvent) {
    if (props.busy) return;
    emit("contextmenu", {
        pos: { x: e.clientX, y: e.clientY },
        versionId: null,
        index: null,
    });
}
</script>