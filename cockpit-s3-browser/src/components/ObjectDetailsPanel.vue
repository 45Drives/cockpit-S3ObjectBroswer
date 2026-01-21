<!-- src/components/ObjectDetailsPanel.vue -->

<template>
  <aside class="w-full h-[96vh] min-h-0 flex flex-col border-l border-default bg-default ml-4">
    <!-- Header (fixed) -->
    <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-default truncate">
          {{ title }}
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
  v-if="showBackToObjects"
  type="button"
  class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-2 py-1.5 text-sm font-semibold text-default"
  @click="emitBackToObjects"
>
  Back
</button>


<button
  type="button"
  class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-2 py-1.5 text-sm font-semibold
         disabled:opacity-60 disabled:cursor-not-allowed disabled:text-muted disabled:border-default"
  :disabled="!isFile || Boolean(versionId) || isMultiSelected"
  @click="emitOpenVersions"
>
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
      <div
  v-if="showSelectionSummary"
  class="text-sm text-default"
>
  <div class="rounded-md border border-default bg-default p-3">
    <div class="text-sm font-semibold text-default">
      {{ selectionSummaryTitle }}
    </div>
    <div class="text-xs text-default opacity-70 mt-1">
      {{ selectionSummaryHint }}
    </div>
  </div>
</div>
<div v-else-if="!row" class="text-sm text-default opacity-80">
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
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Name</div>
                <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">{{ nameText }}
                </div>
              </div>

              <div class="flex items-start justify-between gap-4 py-2">
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Size</div>
                <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">{{ sizeText }}
                </div>
              </div>

              <div class="flex items-start justify-between gap-4 py-2">
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Last Modified</div>
                <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">{{
                  lastModifiedPretty }}</div>
              </div>

              <div class="flex items-start justify-between gap-4 py-2">
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">ETAG</div>
                <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">{{ meta?.etag ||
                  "—" }}</div>
              </div>
              <div class="flex items-start justify-between gap-4 py-2">
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Legal Hold</div>

                <div class="text-default flex-1">
                  <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">
                    <div class="text-right">{{ legalHoldText }}</div>

                    <button v-if="canEditObjectLock" type="button"
                      class="btn-secondary inline-flex items-center rounded-md border border-default px-2 py-1 text-xs font-semibold"
                      :disabled="legalHoldBusy"
                      @click="editingLegalHold ? cancelEditLegalHold() : startEditLegalHold()">
                      {{ editingLegalHold ? "Cancel" : "Edit" }}
                    </button>
                  </div>

                  <div v-if="editingLegalHold" class="mt-2 flex flex-col items-end gap-2">
                    <div v-if="legalHoldErr" class="text-xs text-red-700">{{ legalHoldErr }}</div>

                    <select class="w-full max-w-[220px] rounded-md border border-default bg-default px-2 py-1 text-sm"
                      v-model="legalHoldDraft" :disabled="legalHoldBusy">
                      <option value="OFF">Off</option>
                      <option value="ON">On</option>
                    </select>

                    <button type="button"
                      class="btn-primary inline-flex items-center rounded-md border border-default px-2 py-1 text-xs font-semibold"
                      :disabled="legalHoldBusy" @click="saveLegalHold">
                      {{ legalHoldBusy ? "Saving…" : "Save" }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="flex items-start justify-between gap-4 py-2">
                <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Retention Policy</div>

                <div class="text-default flex-1">
                  <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">
                    <div class="text-right">{{ retentionText }}</div>

                    <button v-if="canEditObjectLock" type="button"
                      class="btn-secondary inline-flex items-center rounded-md border border-default px-2 py-1 text-xs font-semibold"
                      :disabled="retentionBusy"
                      @click="editingRetention ? cancelEditRetention() : startEditRetention()">
                      {{ editingRetention ? "Cancel" : "Edit" }}
                    </button>
                  </div>

                  <div v-if="editingRetention" class="mt-2 flex flex-col items-end gap-2">
                    <div v-if="retentionErr" class="text-xs text-red-700">{{ retentionErr }}</div>

                    <div class="w-full max-w-[280px] grid grid-cols-1 gap-2">
                      <select class="w-full rounded-md border border-default bg-default px-2 py-1 text-sm"
                        v-model="retentionModeDraft" :disabled="retentionBusy">
                        <option value="GOVERNANCE">GOVERNANCE</option>
                        <option value="COMPLIANCE">COMPLIANCE</option>
                      </select>

                      <input class="w-full rounded-md border border-default bg-default px-2 py-1 text-sm"
                        type="datetime-local" v-model="retentionUntilDraft" :disabled="retentionBusy" />

                      <label class="flex items-center justify-end gap-2 text-xs text-default opacity-80">
                        <input type="checkbox" v-model="retentionBypassDraft" :disabled="retentionBusy" />
                        Bypass governance (if permitted)
                      </label>
                    </div>

                    <button type="button"
                      class="btn-primary inline-flex items-center rounded-md border border-default px-2 py-1 text-xs font-semibold"
                      :disabled="retentionBusy" @click="saveRetention">
                      {{ retentionBusy ? "Saving…" : "Save" }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="isFile" class="flex items-start justify-between gap-4 py-2">
  <div class="text-default font-semibold opacity-70 shrink-0 w-[7.5rem]">Version</div>
  <div class="text-default text-right flex-1 whitespace-normal break-words leading-snug">
    <div v-if="versionId">
      {{ versionId }}
    </div>
    <div v-else class="opacity-70">
      Latest
    </div>
  </div>
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
                <div class="text-default opacity-70 shrink-0 w-[7.5rem] break-all">{{ t.key }}</div>
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

            <div v-else-if="!metaLoading && metaEntries.length === 0" class="text-sm text-default opacity-80">
              None
            </div>

            <div v-else class="divide-y divide-default text-sm">
              <div v-for="[k, v] in metaEntries" :key="k" class="flex items-start justify-between gap-4 py-2">
                <div class="text-default opacity-70 shrink-0 w-[7.5rem] break-all">{{ k }}</div>
                <div class="text-default text-right flex-1 break-all">{{ v }}</div>
              </div>
            </div>
          </section>
        </div>
      </template>
    </div>


  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Row, FileRow } from "../types";
import type { TagKV } from "./TagsModal.vue";
import { formatBytes, formatDate } from "../lib/helpers";
import {
  statObject, getObjectTags, getObjectVersions, getBucketObjectLock, getObjectLegalHold,
  getObjectRetention, putObjectLegalHold, putObjectRetention,
} from "../lib/s3Objects";

type Stat = {
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
  metadata?: Record<string, string>;
  legalHold: "ON" | "OFF" | null;
  retentionMode: string | null;
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
  versionId?: string | null;
  inVersionsMode?: boolean;

  selectionSummary?: { mode: "objects" | "versions"; count: number } | null;
}>();

const showBackToObjects = computed(() => Boolean(props.inVersionsMode));
const versionId = computed(() => props.versionId ?? null);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "openVersions", payload: { key: string; name: string }): void;
  (e: "backToObjects"): void;
}>();
const showSelectionSummary = computed(() => {
  const s = props.selectionSummary;
  return Boolean(s && s.count > 1);
});

const selectionSummaryTitle = computed(() => {
  const s = props.selectionSummary;
  if (!s || s.count <= 1) return "";
  const label = s.mode === "versions" ? "version" : "item";
  return `${s.count} ${label}${s.count === 1 ? "" : "s"} selected`;
});

const selectionSummaryHint = computed(() => {
  const s = props.selectionSummary;
  if (!s || s.count <= 1) return "";
  return s.mode === "versions"
    ? "Select a single version to see details."
    : "Select a single item to see properties.";
});



const err = ref("");
const currentReq = ref(0);

const loading = ref(false);
const metaLoading = ref(false);
const tagsLoading = ref(false);

const meta = ref<Stat | null>(null);
const tags = ref<TagKV[]>([]);
  const isMultiSelected = computed(() => (props.selectionSummary?.count ?? 0) > 1);

const metaEntries = computed<[string, string][]>(() => {
  const m = meta.value?.metadata || {};
  return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
});

const isFile = computed(() => props.row?.type === "file");

const title = computed(() => {
  if (showSelectionSummary.value) return "Multiple selection";
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
const isVersionsView = computed(() => Boolean(props.versionId));

function emitBackToObjects() {
  emit("backToObjects");
}


const objectLock = ref<{ supported: boolean; enabled: boolean; reason?: string } | null>(null);
const objectLockLoading = ref(false);
const canEditObjectLock = computed(() => {
  if (!props.row || props.row.type !== "file") return false;
  const cap = objectLock.value;
  return Boolean(cap?.supported && cap?.enabled);
});

const editingLegalHold = ref(false);
const legalHoldBusy = ref(false);
const legalHoldErr = ref("");

const legalHoldDraft = ref<"ON" | "OFF">("OFF");

/* Retention editor */
const editingRetention = ref(false);
const retentionBusy = ref(false);
const retentionErr = ref("");
const retentionModeDraft = ref<"GOVERNANCE" | "COMPLIANCE">("GOVERNANCE");
const retentionUntilDraft = ref<string>(""); // ISO string in <input type="datetime-local">
const retentionBypassDraft = ref(false);

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

function toDatetimeLocalValue(iso: string): string {
  // Convert ISO -> "YYYY-MM-DDTHH:mm" for datetime-local
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromDatetimeLocalValue(v: string): string | null {
  // Interpret as local time and convert to ISO
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

const lastModifiedPretty = computed(() => {
  if (!props.row || props.row.type !== "file") return "—";
  const lm = meta.value?.lastModified ?? (props.row as any).lastModified ?? null;
  if (!lm) return "—";
  return `${relativeFromNow(lm)} (${formatDate(lm)})`;
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
  () => [props.connectionId, props.bucket, props.row, props.versionId] as const,
  async ([, , row]) => {
    const myReq = ++reqId;
    currentReq.value = myReq;

    err.value = "";
    meta.value = null;
    tags.value = [];

    loading.value = false;
    metaLoading.value = false;
    tagsLoading.value = false;

    if (!row) return;
    if (row.type !== "file") return;

    if (isMultiSelected.value) return;

    await Promise.all([loadStat(row, myReq), loadTags(row, myReq), loadObjectLockInfo(row, myReq)]);

    const m = meta.value as Stat | null;
    if (!m) return;

    legalHoldDraft.value = m.legalHold === "ON" ? "ON" : "OFF";
    const mode = (m.retentionMode ?? "").toUpperCase();
    retentionModeDraft.value = mode === "COMPLIANCE" ? "COMPLIANCE" : "GOVERNANCE";
    retentionUntilDraft.value = m.retainUntil ? toDatetimeLocalValue(m.retainUntil) : "";
  },
  { immediate: true },
);


async function loadObjectLockInfo(r: FileRow, myReq: number) {
  objectLockLoading.value = true;
  try {
    const bucketRes = await getBucketObjectLock({
      connectionId: props.connectionId,
      bucket: props.bucket,
    });

    if (reqId !== myReq) return;

    if (bucketRes.isErr()) {
      objectLock.value = { supported: false, enabled: false, reason: bucketRes.error.message };
      // Clear per-object fields
      meta.value = { ...(meta.value ?? { size: 0, lastModified: null, etag: null, storageClass: null }), legalHold: null, retentionMode: null, retainUntil: null };
      return;
    }

    objectLock.value = bucketRes.value;

    if (!bucketRes.value.supported || !bucketRes.value.enabled) {
      // Don’t call per-object APIs (they’ll fail); show message instead.
      meta.value = {
        ...(meta.value ?? { size: 0, lastModified: null, etag: null, storageClass: null }),
        legalHold: null,
        retentionMode: null,
        retainUntil: null,
      };
      return;
    }

    // Bucket supports & enabled: fetch per-object status 
    const [holdRes, retRes] = await Promise.all([
      getObjectLegalHold({ connectionId: props.connectionId, bucket: props.bucket, key: r.key ,versionId: versionId.value,}),
      getObjectRetention({ connectionId: props.connectionId, bucket: props.bucket, key: r.key,versionId: versionId.value, }),
    ]);

    if (reqId !== myReq) return;

    meta.value = {
      ...(meta.value ?? { size: 0, lastModified: null, etag: null, storageClass: null }),
      legalHold: holdRes.isOk() ? (holdRes.value.status as any) : null,
      retentionMode: retRes.isOk() ? retRes.value.mode : null,
      retainUntil: retRes.isOk() ? retRes.value.retainUntil : null,
    };
  } finally {
    if (reqId === myReq) objectLockLoading.value = false;
  }
}
const legalHoldText = computed(() => {
  if (!props.row || props.row.type !== "file") return "—";

  const cap = objectLock.value;
  if (!cap) return "—";
  if (!cap.supported) return "Not supported";
  if (!cap.enabled) return "Not supported (bucket Object Lock disabled)";

  const v = meta.value?.legalHold;
  if (v === "ON") return "On";
  if (v === "OFF") return "Off";
  return "Off";
});

const retentionText = computed(() => {
  if (!props.row || props.row.type !== "file") return "—";

  const cap = objectLock.value;
  if (!cap) return "—";
  if (!cap.supported) return "Not supported";
  if (!cap.enabled) return "Not supported (bucket Object Lock disabled)";

  const mode = meta.value?.retentionMode ?? null;
  const until = meta.value?.retainUntil ?? null;

  if (!mode && !until) return "None";
  if (mode && until) return `${mode} until ${formatDate(until)}`;
  if (mode) return mode;
  return until ? `Until ${formatDate(until)}` : "None";
});

function startEditLegalHold() {
  legalHoldErr.value = "";
  legalHoldDraft.value = meta.value?.legalHold === "ON" ? "ON" : "OFF";
  editingLegalHold.value = true;
}

function cancelEditLegalHold() {
  editingLegalHold.value = false;
  legalHoldErr.value = "";
}

async function saveLegalHold() {
  if (!props.row || props.row.type !== "file") return;

  legalHoldErr.value = "";
  legalHoldBusy.value = true;

  try {
    const res =  await putObjectLegalHold({
  connectionId: props.connectionId,
  bucket: props.bucket,
  key: props.row.key,
  versionId: versionId.value,
  status: legalHoldDraft.value,
});

    if (res.isErr()) {
      legalHoldErr.value = res.error.message;
      return;
    }

    editingLegalHold.value = false;

    const myReq = ++reqId;
    currentReq.value = myReq;
    await loadObjectLockInfo(props.row, myReq);
  } finally {
    legalHoldBusy.value = false;
  }
}

function startEditRetention() {
  retentionErr.value = "";
  const mode = (meta.value?.retentionMode ?? "").toUpperCase();
  retentionModeDraft.value = mode === "COMPLIANCE" ? "COMPLIANCE" : "GOVERNANCE";
  retentionUntilDraft.value = meta.value?.retainUntil ? toDatetimeLocalValue(meta.value.retainUntil) : "";
  retentionBypassDraft.value = false;
  editingRetention.value = true;
}

function cancelEditRetention() {
  editingRetention.value = false;
  retentionErr.value = "";
}

async function saveRetention() {
  if (!props.row || props.row.type !== "file") return;

  retentionErr.value = "";

  const iso = fromDatetimeLocalValue(retentionUntilDraft.value);
  if (!iso) {
    retentionErr.value = "Please choose a valid Retain Until date/time.";
    return;
  }

  retentionBusy.value = true;
  try {
    const res = await putObjectRetention({
  connectionId: props.connectionId,
  bucket: props.bucket,
  key: props.row.key,
  versionId: versionId.value,
  mode: retentionModeDraft.value,
  retainUntil: iso,
  bypassGovernance: retentionBypassDraft.value,
});


    if (res.isErr()) {
      retentionErr.value = res.error.message;
      return;
    }

    editingRetention.value = false;

    const myReq = ++reqId;
    currentReq.value = myReq;
    await loadObjectLockInfo(props.row, myReq);
  } finally {
    retentionBusy.value = false;
  }
}


function emitOpenVersions() {
  if (!props.row || props.row.type !== "file") return;
  emit("openVersions", { key: props.row.key, name: props.row.name });
}


</script>