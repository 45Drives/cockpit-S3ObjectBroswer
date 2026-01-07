<template>
  <div class="w-full px-6 py-6">
    <div class="mx-auto w-full max-w-6xl">
      <div class="rounded-md border border-default bg-accent shadow-sm">
        <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-3">
          <div class="flex items-start gap-3">
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="busy"
              @click="goBack"
            >
              Back
            </button>

            <div>
              <div class="text-base font-semibold text-default">Buckets</div>
              <div class="text-sm text-default/70">Connection: {{ connectionName || "—" }}</div>
            </div>
          </div>

          <button
            type="button"
            class="inline-flex items-center justify-center rounded-md border border-default bg-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="busy"
            @click="refresh"
          >
            Refresh
          </button>
        </div>

        <div class="p-4">
          <div v-if="error" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
            {{ error }}
          </div>

          <div class="mb-3 flex items-center gap-3">
            <input
              v-model.trim="query"
              type="text"
              placeholder="Search buckets..."
              class="block w-full rounded-md border border-default px-3 py-2 text-sm shadow-sm placeholder:text-default/60 bg-default text-default focus:outline-none focus:ring-2 focus:ring-default"
              :disabled="busy || buckets.length === 0"
            />
            <button
              v-if="query"
              type="button"
              class="rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
              @click="query = ''"
              :disabled="busy"
            >
              Clear
            </button>
          </div>

          <div class="mb-3 flex items-center justify-between text-sm text-default/70">
            <div>
              Total: <span class="text-default font-medium">{{ buckets.length }}</span>
              <span v-if="query">
                · Showing: <span class="text-default font-medium">{{ filteredBuckets.length }}</span>
              </span>
            </div>
          </div>

          <div v-if="busy" class="py-8 text-center text-default/70">
            Loading buckets...
          </div>

          <div v-else-if="buckets.length === 0" class="py-8 text-center text-default/70">
            No buckets found.
          </div>

          <div v-else-if="filteredBuckets.length === 0" class="py-8 text-center text-default/70">
            No buckets match "{{ query }}".
          </div>

          <div v-else class="overflow-x-auto">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="border-b border-default bg-default/40 text-left text-default">
                  <th class="px-3 py-2 font-semibold">Bucket</th>
                  <th class="px-3 py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                <tr
  v-for="b in filteredBuckets"
  :key="b.name"
  class="border-b border-default/70 last:border-b-0 hover:bg-default/20 cursor-pointer"
  @click="openBucket(b.name)"
>
  <td class="px-3 py-2 text-default font-medium">{{ b.name }}</td>
  <td class="px-3 py-2 text-default/80">{{ formatDate(b.creationDate) }}</td>
</tr>

              </tbody>
            </table>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listBuckets } from "../lib/s3Buckets";
import type { BucketSummary } from "../types";

const route = useRoute();
const router = useRouter();

const connectionId = computed(() => String(route.query.connectionId || ""));
const connectionName = computed(() => String(route.query.connectionName || ""));

const buckets = ref<BucketSummary[]>([]);
const busy = ref(false);
const error = ref("");

const query = ref("");

const filteredBuckets = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return buckets.value;
  return buckets.value.filter((b) => (b.name || "").toLowerCase().includes(q));
});

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function goBack() {
  if (router.hasRoute("Connections")) {
    router.push({ name: "Connections" });
    return;
  }
  router.back();
}

async function refresh() {
  error.value = "";
  if (!connectionId.value) {
    buckets.value = [];
    error.value = "Missing connectionId.";
    return;
  }

  busy.value = true;
  try {
    const res = await listBuckets(connectionId.value);
    if (res.isErr()) {
      buckets.value = [];
      error.value = res.error.message;
      return;
    }
    buckets.value = res.value;
  } finally {
    busy.value = false;
  }
}

function openBucket(bucketName: string) {
  router.push({
    name: "Objects",
    query: {
      connectionId: connectionId.value,
      connectionName: connectionName.value,
      bucket: bucketName,
      prefix: "",
    },
  });
}

onMounted(refresh);
</script>
