<template>
  <div class=" w-full px-6 py-6">
    <div class="mx-auto w-full ">
      <div class="rounded-md border border-default bg-accent shadow-sm">
        <div class="border-b border-default px-4 py-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-3 w-full">
              <!-- Left: search -->
              <div class="flex-1 max-w-md">
                <div class="relative w-full">
                  <MagnifyingGlassIcon
                    class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />

                  <input v-model.trim="search" type="text" placeholder="Search connections..."
                    class="block w-full rounded-md border border-default px-3 py-2 pl-9 text-sm shadow-sm placeholder:text-default input-textlike bg-default text-default" />
                </div>
              </div>

              <!-- Right: actions -->
              <div class="ml-auto flex items-center gap-2">
                <TaskCenter></TaskCenter>

                <button type="button"
                  class="inline-flex items-center justify-center btn-primary rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 flex-shrink-0"
                  :disabled="busy" @click="openCreate">
                  Add connection
                </button>
              </div>
            </div>

          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr class="border border-default border-collapse  bg-well w-full text-center items-center rounded-sm p-1">
                <th class="px-4 py-3 font-semibold">Name</th>
                <th class="px-4 py-3 font-semibold">Endpoint</th>
                <th class="px-4 py-3 font-semibold">Region</th>
                <th class="px-4 py-3 font-semibold">TLS</th>
                <th class="px-4 py-3 font-semibold">Updated</th>
                <th class="px-4 py-3 font-semibold">Last used</th>
                <th class="px-4 py-3 font-semibold ">Actions</th>
              </tr>
            </thead>

            <tbody>
              <tr v-if="!busy && filtered.length === 0">
                <td colspan="7" class="px-4 py-10 text-center text-default">
                  No connections found.
                </td>
              </tr>

              <tr v-for="c in filtered" :key="c.id"
                class=" border border-default border-collapse  w-full text-center items-center rounded-sm p-1">
                <td class="px-4 py-3 text-default">
                  <div class="font-medium">{{ c.name }}</div>
                </td>

                <td class="px-4 py-3 text-default">
                  <div class="max-w-[32rem] truncate" :title="c.endpoint">{{ c.endpoint }}</div>
                </td>

                <td class="px-4 py-3 text-default">{{ c.region || "—" }}</td>

                <td class="px-4 py-3">
                  <span
                    class="inline-flex items-center rounded-md border border-default bg-default px-2 py-0.5 text-xs font-semibold"
                    :class="c.useTls ? 'text-red-700' : 'text-default'">
                    {{ c.useTls ? "Insecure" : "Verify" }}
                  </span>
                </td>

                <td class="px-4 py-3 text-default">{{ formatDate(c.updatedAt) }}</td>
                <td class="px-4 py-3 text-default">{{ formatDate(c.lastUsedAt) }}</td>

                <td class="px-4 py-3">
                  <div class="flex justify-center gap-2">
                    <button type="button"
                      class="inline-flex btn-primary items-center justify-center rounded-md border border-default  px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                      :disabled="busy" @click="connect(c)">
                      Connect <LinkIcon class="ml-1 h-4 w-4"></LinkIcon>
                    </button>

                    <button type="button"
                      class="inline-flex items-center justify-center btn-secondary rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                      :disabled="busy" @click="openEdit(c.id)">
                      Edit <PencilSquareIcon class="ml-1 h-4 w-4"></PencilSquareIcon>
                    </button>

                    <button type="button"
                      class="inline-flex items-center justify-center btn-danger rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                      :disabled="busy" @click="openDelete(c)">
                      Delete <TrashIcon class="ml-1 h-4 w-4"></TrashIcon>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <!-- Delete confirm -->
      <div v-if="confirmDelete.open" class="fixed inset-0 z-50">
        <div class="absolute inset-0 bg-black/40" @click="closeDelete"></div>

        <div class="absolute inset-0 flex items-start justify-center overflow-auto p-6">
          <div class="w-full max-w-lg rounded-md border border-default bg-accent shadow-lg">
            <div class="border-b border-default px-5 py-4">
              <h2 class="text-base font-semibold text-default">Delete connection</h2>
              <p class="mt-1 text-sm text-default">
                This will remove the saved connection from the system.
              </p>
            </div>

            <div class="space-y-3 px-5 py-4 text-sm text-default">
              <div class="rounded-md border border-default bg-default p-3">
                <div class="font-medium">{{ confirmDelete.item?.name }}</div>
                <div class="mt-1 text-default">{{ confirmDelete.item?.endpoint }}</div>
              </div>

              <p class="text-default">
                This action cannot be undone.
              </p>
            </div>

            <div class="flex justify-end gap-2 px-5 py-4">
              <button type="button"
                class="inline-flex items-center justify-center rounded-md border border-default bg-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80"
                :disabled="busy" @click="closeDelete">
                Cancel
              </button>

              <button type="button"
                class="inline-flex items-center justify-center rounded-md border border-red-300 bg-default px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="busy" @click="confirmDeleteNow">
                Delete
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
  <ConnectionModal :open="modalState.open" :mode="modalState.mode"
    :id="modalState.mode === 'edit' ? modalState.id : undefined" @close="closeModal" @error="handleModalError"
    @saved="(summary) => { upsertSummaryLocal(summary); status.ok = true; status.message = 'Saved.'; }" />

</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import type { ConnectionSummary } from "../types";
import { deleteConnection, listConnections, touchLastUsed } from "../lib/endpointConnection";
import ConnectionModal from "../components/Modals/EndpointConnectionModal.vue";
import { MagnifyingGlassIcon, LinkIcon, PencilSquareIcon, TrashIcon } from "@heroicons/vue/20/solid";
import TaskCenter from "../components/TaskCenter.vue";

const router = useRouter();

const connections = ref<ConnectionSummary[]>([]);
const busy = ref(false);
const search = ref("");

const status = reactive<{ ok: boolean; message: string }>({ ok: true, message: "" });

const confirmDelete = reactive({
  open: false as boolean,
  item: null as ConnectionSummary | null,
});

const modalState = reactive({
  open: false as boolean,
  mode: "create" as "create" | "edit",
  id: "" as string,
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return connections.value;
  return connections.value.filter((c) => {
    return (
      c.name.toLowerCase().includes(q) ||
      c.endpoint.toLowerCase().includes(q) ||
      (c.region || "").toLowerCase().includes(q)
    );
  });
});

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

async function refreshList() {
  busy.value = true;
  status.message = "";
  try {
    const res = await listConnections();
    if (res.isOk()) {
      connections.value = res.value;
      status.ok = true;
      status.message = "";
    } else {
      status.ok = false;
      status.message = res.error.message;
    }
  } finally {
    busy.value = false;
  }
}

function openCreate() {
  modalState.open = true;
  modalState.mode = "create";
  modalState.id = "";
}

function openEdit(id: string) {
  modalState.open = true;
  modalState.mode = "edit";
  modalState.id = id;
}

function closeModal() {
  modalState.open = false;
}

function handleModalError(message: string) {
  status.ok = false;
  status.message = message;
}

function upsertSummaryLocal(summary: ConnectionSummary) {
  const i = connections.value.findIndex((x) => x.id === summary.id);
  const existing = i >= 0 ? connections.value[i] : undefined;

  const merged: ConnectionSummary = {
    ...summary,
    lastUsedAt: existing?.lastUsedAt,
  };

  if (i >= 0) connections.value.splice(i, 1, merged);
  else connections.value.unshift(merged);
}

function patchLastUsedLocal(id: string, iso: string) {
  const i = connections.value.findIndex((x) => x.id === id);
  if (i >= 0) connections.value[i] = { ...connections.value[i], lastUsedAt: iso };
}

function removeSummaryLocal(id: string) {
  const i = connections.value.findIndex((x) => x.id === id);
  if (i >= 0) connections.value.splice(i, 1);
}

async function connect(c: ConnectionSummary) {
  busy.value = true;
  status.message = "";

  try {
    const touchRes = await touchLastUsed(c.id);
    if (touchRes.isErr()) {
      status.ok = false;
      status.message = touchRes.error.message;
      return;
    }

    patchLastUsedLocal(c.id, new Date().toISOString());

    await router.push({
      name: "Buckets",
      query: { connectionId: c.id, connectionName: c.name },
    });
  } finally {
    busy.value = false;
  }
}

function openDelete(item: ConnectionSummary) {
  confirmDelete.open = true;
  confirmDelete.item = item;
}

function closeDelete() {
  confirmDelete.open = false;
  confirmDelete.item = null;
}

async function confirmDeleteNow() {
  if (!confirmDelete.item) return;

  busy.value = true;
  status.message = "";
  const id = confirmDelete.item.id;

  try {
    const res = await deleteConnection(id);
    if (res.isErr()) {
      status.ok = false;
      status.message = res.error.message;
      return;
    }

    removeSummaryLocal(id);
    closeDelete();
    status.ok = true;
    status.message = "Deleted.";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await refreshList();
});
</script>