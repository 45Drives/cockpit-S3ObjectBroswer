<template>
  <div class="w-full px-6 py-6">
    <div class="mx-auto w-full ">
      <div class="rounded-md border border-default bg-accent shadow-sm">
        <div class="border-b border-default px-4 py-3 flex items-center justify-between gap-3">
          <div class="flex items-start gap-3">


            <div>
              <div class="text-base font-semibold text-default">Buckets</div>
              <div class="text-sm text-default">Connection: {{ connectionName || "—" }}</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button"
              class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="busy" @click="goBack">
              Back
            </button>

            <button type="button"
              class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="busy" @click="refresh">
              <ArrowPathIcon class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="p-4">
          <div v-if="error" class="mb-3 rounded-md border border-red-300 bg-default p-3 text-sm text-red-700">
            {{ error }}
          </div>

          <div class="mb-3 flex items-center gap-3">
            <div class="relative w-full">
              <div class="pointer-events-none absolute left-3 top-2">
                <MagnifyingGlassIcon class="h-6 w-6 text-default" :stroke-width="2.5" />
              </div>

              <input v-model.trim="query" type="text" placeholder="Search buckets..."
                class="block w-full rounded-md border border-default bg-default px-3 py-2 pl-9 text-sm text-default shadow-sm placeholder:text-default/60 focus:outline-none focus:ring-2 focus:ring-default"
                :disabled="busy || buckets.length === 0" />
            </div>
          </div>

          <div class="mb-3 flex items-center justify-between text-sm text-default">
            <div>
              Total: <span class="text-default font-medium">{{ buckets.length }}</span>
              <span v-if="query">
                · Showing: <span class="text-default font-medium">{{ filteredBuckets.length }}</span>
              </span>
            </div>
          </div>

          <div v-if="busy" class="py-8 text-center text-default">
            Loading buckets...
          </div>

          <div v-else-if="buckets.length === 0" class="py-8 text-center text-default">
            No buckets found.
          </div>

          <div v-else-if="filteredBuckets.length === 0" class="py-8 text-center text-default">
            No buckets match "{{ query }}".
          </div>

          <div class="overflow-x-auto rounded-md border border-default">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="bg-well text-center text-default">
                  <th class="px-3 py-2 font-semibold border-b border-default w-[22rem]">Bucket</th>
                  <th class="px-3 py-2 font-semibold border-b border-default">Created</th>
                  <th class="px-3 py-2 font-semibold border-b border-default">Actions</th>
                </tr>
              </thead>

              <tbody>
                <tr v-for="b in filteredBuckets" :key="b.name" class="text-center hover:bg-default/20">
                  <td class="px-3 py-2 text-default font-medium border-b border-default">
                    <div class="flex">
                      <div class="w-1/2 text-right flex justify-end items-center">
                        <ArchiveBoxIcon class="h-4 w-4 icon-default justify-self-end shrink-0" />

                      </div>
                      <div class="truncate w-1/2 text-left">{{ b.name }}</div>
                    </div>
                  </td>


                  <td class="px-3 py-2 text-default border-b border-default">
                    {{ formatDate(b.creationDate) }}
                  </td>

                  <td class="px-3 py-2 border-b border-default">
                    <div class="flex justify-center">
                      <button type="button"
                        class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                        :disabled="busy" @click="openBucket(b.name)">
                        Open
                      </button>
                    </div>
                  </td>
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
import { ArchiveBoxIcon, MagnifyingGlassIcon, ArrowPathIcon } from "@heroicons/vue/20/solid";
import { pushNotification, Notification } from "@45drives/houston-common-ui";


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
  router.push({ name: "Home" });
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
      pushNotification(new Notification("Connection failed", `Unable to list buckets for "${connectionName.value || connectionId.value}": ${res.error.message}`,
        "error", 5000,
      ),
      );
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
