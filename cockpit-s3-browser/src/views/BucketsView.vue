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
            <TaskCenter></TaskCenter>
            <button type="button"
              class="inline-flex items-center btn-secondary justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="busy" @click="goBack">
              <ArrowUturnLeftIcon class="h-4 w-4 mr-1"></ArrowUturnLeftIcon> Back
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
              <MagnifyingGlassIcon
                class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />

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

          <div class="rounded-md border border-default">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr class="bg-well text-center text-default">
                  <th class="px-3 py-2 font-semibold border-b border-default w-[22rem]">Bucket</th>
                  <th class="px-3 py-2 font-semibold border-b border-default">Created</th>
                  <th class="px-3 py-2 font-semibold border-b border-default">Encryption</th>
                  <th class="px-3 py-2 font-semibold border-b border-default">Actions</th>
                </tr>
              </thead>

              <tbody>
                <tr v-for="(b, bIdx) in filteredBuckets" :key="b.name" class="text-center hover:bg-default/20">
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
                      <span v-if="encryptionLabel(b.name) === '…'" class="text-xs text-default opacity-50">…</span>
                      <span v-else-if="isEncrypted(b.name)"
                        class="inline-flex items-center gap-1 text-xs rounded-full border border-green-400 text-green-700 bg-green-50 px-2 py-0.5">
                        <LockClosedIcon class="h-3 w-3" />
                        {{ encryptionLabel(b.name) }}
                      </span>
                      <span v-else
                        class="inline-flex items-center gap-1 text-xs rounded-full border border-default text-default opacity-60 px-2 py-0.5">
                        <LockOpenIcon class="h-3 w-3" />
                        None
                      </span>
                    </div>
                  </td>

                  <td class="px-3 py-2 border-b border-default">
                    <div class="flex justify-center gap-2">
                      <button type="button"
                        class="inline-flex items-center btn-primary justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                        :disabled="busy" @click="openBucket(b.name)">
                        Open
                      </button>
                      <Menu as="div" class="relative">
                        <MenuButton
                          class="inline-flex items-center justify-center rounded-md border border-default px-2 py-1.5 text-sm text-default shadow-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                          :disabled="busy">
                          <EllipsisVerticalIcon class="h-4 w-4" />
                        </MenuButton>
                        <transition enter-active-class="transition duration-100 ease-out"
                          enter-from-class="transform scale-95 opacity-0"
                          enter-to-class="transform scale-100 opacity-100"
                          leave-active-class="transition duration-75 ease-in"
                          leave-from-class="transform scale-100 opacity-100"
                          leave-to-class="transform scale-95 opacity-0">
                          <MenuItems
                            :class="[
                              'absolute right-0 z-50 min-w-[200px] overflow-hidden rounded-md border border-default bg-default shadow-lg outline-none',
                              shouldOpenMenuUp(bIdx, filteredBuckets.length)
                                ? 'bottom-full mb-1 origin-bottom-right'
                                : 'mt-1 origin-top-right'
                            ]">
                            <div class="py-1">
                              <MenuItem v-slot="{ active }">
                                <button type="button"
                                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                                  :class="active ? 'bg-accent text-default' : 'text-default'"
                                  @click="openSetEncryptionModal(b.name)">
                                  <LockClosedIcon class="h-4 w-4" />
                                  <span>Set Encryption</span>
                                </button>
                              </MenuItem>
                              <MenuItem v-slot="{ active }">
                                <button type="button"
                                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                                  :class="active ? 'bg-accent text-default' : 'text-default'"
                                  @click="confirmRemoveEncryption(b.name)">
                                  <LockOpenIcon class="h-4 w-4" />
                                  <span>Remove Encryption</span>
                                </button>
                              </MenuItem>
                              <MenuItem v-if="isEncrypted(b.name) && cpStore.isAvailable" v-slot="{ active }">
                                <button type="button"
                                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                                  :class="active ? 'bg-accent text-default' : 'text-default'"
                                  :disabled="verifyBusy === b.name"
                                  @click="verifyEncryption(b.name)">
                                  <ArrowPathIcon class="h-4 w-4" />
                                  <span>{{ verifyBusy === b.name ? 'Verifying…' : 'Verify Encryption' }}</span>
                                </button>
                              </MenuItem>
                              <MenuItem v-if="isKmsEncrypted(b.name) && cpStore.isAvailable" v-slot="{ active }">
                                <button type="button"
                                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                                  :class="active ? 'bg-accent text-default' : 'text-default'"
                                  :disabled="roundtripBusy === b.name"
                                  @click="deepVerify(b.name)">
                                  <ArrowPathIcon class="h-4 w-4" />
                                  <span>{{ roundtripBusy === b.name ? 'Testing…' : 'Deep Verify (Round-trip)' }}</span>
                                </button>
                              </MenuItem>
                              <div class="my-1 h-px bg-default"></div>
                              <MenuItem v-slot="{ active }">
                                <button type="button"
                                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                                  :class="active ? 'bg-accent text-default' : 'text-default'"
                                  @click="openEncryptionManager()">
                                  <ArrowTopRightOnSquareIcon class="h-4 w-4" />
                                  <span>Encryption Manager</span>
                                </button>
                              </MenuItem>
                            </div>
                          </MenuItems>
                        </transition>
                      </Menu>
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

  <!-- Set Encryption Modal -->
  <Teleport to="body">
    <div v-if="showSetEncModal" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/40" @click="showSetEncModal = false"></div>
      <div class="relative z-10 w-full max-w-md rounded-lg border border-default bg-default p-6 shadow-xl">
        <h3 class="text-lg font-semibold text-default mb-4">Set Bucket Encryption</h3>
        <p class="text-sm text-default mb-4">
          Bucket: <span class="font-medium">{{ setEncBucket }}</span>
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-default mb-1">Algorithm</label>
            <select v-model="setEncAlgo"
              class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default">
              <option value="AES256">AES-256 (SSE-S3)</option>
              <option value="aws:kms">SSE-KMS</option>
            </select>
          </div>

          <div v-if="setEncAlgo === 'aws:kms'">
            <label class="block text-sm font-medium text-default mb-1">KMS Key / Policy</label>

            <!-- Control plane available: show policy dropdown -->
            <template v-if="cpStore.isAvailable && cpStore.policies.length > 0">
              <select v-model="setEncKmsKeyId"
                class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default">
                <option value="">— Use bucket default —</option>
                <option v-for="p in cpStore.policies" :key="p.id" :value="p.transit_key_name">
                  {{ p.name }} ({{ cpProviderName(p.provider_id) }} · {{ p.algorithm }})
                </option>
              </select>
              <p class="mt-1 text-xs text-default opacity-60">Key policies from the Encryption Manager.</p>
            </template>

            <!-- Fallback: free-text input -->
            <template v-else>
              <input v-model.trim="setEncKmsKeyId" type="text" placeholder="KMS key ID or alias"
                class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm placeholder:text-default/60 focus:outline-none focus:ring-2 focus:ring-default" />
              <p class="mt-1 text-xs text-default opacity-60">
                {{ cpStore.isAvailable === false
                  ? 'Encryption Manager not installed — enter key ID manually.'
                  : 'No key policies configured. Enter key ID manually.' }}
              </p>
            </template>
          </div>

          <div v-if="setEncAlgo === 'aws:kms'" class="flex items-start gap-2">
            <input id="bucketKeyEnabled" v-model="setEncBucketKey" type="checkbox"
              class="h-4 w-4 mt-0.5 rounded border-default text-blue-600 focus:ring-default" />
            <div>
              <label for="bucketKeyEnabled" class="text-sm text-default">Enable S3 Bucket Key</label>
              <p class="text-xs text-default opacity-60">
                Reduces KMS requests by generating a single bucket-level key instead of
                calling KMS for every object. Recommended for high-throughput buckets.
              </p>
            </div>
          </div>

          <!-- KMS readiness check -->
          <div v-if="setEncAlgo === 'aws:kms' && !kmsReady"
            class="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
            <p class="font-medium">KMS backend not configured</p>
            <p class="mt-1 text-xs">
              No encryption policies found. Configure a KMS provider and policy in the
              <a href="#" class="underline font-medium" @click.prevent="openEncryptionManager()">Encryption Manager</a>
              before enabling SSE-KMS.
            </p>
          </div>
        </div>

        <div v-if="setEncError" class="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <p>{{ setEncError }}</p>
          <p v-if="isKmsNotConfiguredError" class="mt-2 text-xs">
            The S3 backend does not have a KMS provider configured. You can set this up in the
            <a href="#" class="underline font-medium" @click.prevent="openEncryptionManager()">Encryption Manager</a>.
          </p>
        </div>

        <div class="mt-6 flex justify-end gap-3">
          <button type="button"
            class="inline-flex items-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90"
            :disabled="setEncBusy" @click="showSetEncModal = false">
            Cancel
          </button>
          <button type="button"
            class="inline-flex items-center btn-primary rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="setEncBusy || !kmsReady" @click="applySetEncryption">
            {{ setEncBusy ? "Applying…" : "Apply" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Remove Encryption Confirmation Modal -->
  <Teleport to="body">
    <div v-if="showRemoveEncModal" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/40" @click="showRemoveEncModal = false"></div>
      <div class="relative z-10 w-full max-w-md rounded-lg border border-default bg-default p-6 shadow-xl">
        <h3 class="text-lg font-semibold text-default mb-4">Remove Bucket Encryption</h3>
        <p class="text-sm text-default mb-4">
          Are you sure you want to remove the default encryption configuration from
          <span class="font-medium">{{ removeEncBucket }}</span>?
        </p>
        <p class="text-sm text-default opacity-70 mb-4">
          Existing encrypted objects will remain encrypted, but new objects will no longer be
          automatically encrypted by default.
        </p>

        <div v-if="removeEncError" class="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">
          {{ removeEncError }}
        </div>

        <div class="flex justify-end gap-3">
          <button type="button"
            class="inline-flex items-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90"
            :disabled="removeEncBusy" @click="showRemoveEncModal = false">
            Cancel
          </button>
          <button type="button"
            class="inline-flex items-center rounded-md border border-red-400 bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="removeEncBusy" @click="applyRemoveEncryption">
            {{ removeEncBusy ? "Removing…" : "Remove" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { listBuckets, getBucketEncryption, putBucketEncryption, deleteBucketEncryption } from "../lib/s3Buckets";
import { navigateToEncryptionManager, validateKmsKey, verifyRoundtrip } from "../lib/controlplane-client";
import { useControlPlaneStore } from "../stores/controlPlane";
import { getConnection } from "../lib/endpointConnection";
import type { BucketSummary, EndpointConfig } from "../types";
import type { BackendType, BucketEncryptionConfig } from "../lib/controlplane-types";
import { detectBackendType } from "../lib/controlplane-types";
import { ArchiveBoxIcon, ArrowUturnLeftIcon, MagnifyingGlassIcon, ArrowPathIcon, LockClosedIcon, LockOpenIcon, EllipsisVerticalIcon, ArrowTopRightOnSquareIcon } from "@heroicons/vue/20/solid";
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/vue";
import { pushNotification, Notification } from "@45drives/houston-common-ui";
import TaskCenter from "../components/TaskCenter.vue";

const route = useRoute();
const router = useRouter();
const cpStore = useControlPlaneStore();

const connectionId = computed(() => String(route.query.connectionId || ""));
const connectionName = computed(() => String(route.query.connectionName || ""));

const connConfig = ref<EndpointConfig | null>(null);
const effectiveBackendType = computed<BackendType>(() => {
  const cfg = connConfig.value;
  if (cfg?.backendType && cfg.backendType !== "auto") return cfg.backendType as BackendType;
  return detectBackendType(connectionName.value, cfg?.endpoint);
});

const buckets = ref<BucketSummary[]>([]);
const busy = ref(false);
const error = ref("");

const query = ref("");

const filteredBuckets = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return buckets.value;
  return buckets.value.filter((b) => (b.name || "").toLowerCase().includes(q));
});

const bucketEncryption = ref<Record<string, BucketEncryptionConfig | null>>({});

function encryptionLabel(name: string): string {
  const enc = bucketEncryption.value[name];
  if (enc === undefined) return "…";
  if (!enc || !enc.encrypted) return "None";
  if (enc.algorithm === "aws:kms") return "SSE-KMS";
  if (enc.algorithm === "AES256") return "SSE-S3";
  return enc.algorithm || "Encrypted";
}

function isEncrypted(name: string): boolean {
  const enc = bucketEncryption.value[name];
  return Boolean(enc && enc.encrypted);
}

function isKmsEncrypted(name: string): boolean {
  const enc = bucketEncryption.value[name];
  return Boolean(enc && enc.encrypted && enc.algorithm === "aws:kms");
}

async function fetchBucketEncryptions(bucketNames: string[]) {
  for (const name of bucketNames) {
    getBucketEncryption(connectionId.value, name).then((res) => {
      if (res.isOk()) {
        bucketEncryption.value = { ...bucketEncryption.value, [name]: res.value };
      } else {
        bucketEncryption.value = { ...bucketEncryption.value, [name]: null };
      }
    });
  }
}

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
    // Load connection config for backend type detection
    const connRes = await getConnection(connectionId.value);
    if (connRes.isOk() && connRes.value) {
      connConfig.value = connRes.value;
    }

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
    fetchBucketEncryptions(res.value.map((b) => b.name));
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
      backendType: effectiveBackendType.value,
    },
  });
}

// ── Set Encryption modal ──────────────────────────────────────────────────

const showSetEncModal = ref(false);
const setEncBucket = ref("");
const setEncAlgo = ref<"AES256" | "aws:kms">("AES256");
const setEncKmsKeyId = ref("");
const setEncBucketKey = ref(false);
const setEncBusy = ref(false);
const setEncError = ref("");

const isKmsNotConfiguredError = computed(() => {
  const e = setEncError.value.toLowerCase();
  return e.includes("kms is not configured") || e.includes("kms not configured");
});

// KMS readiness — based on whether the control plane has providers & policies
const kmsReady = computed(() => {
  if (setEncAlgo.value !== "aws:kms") return true;
  // If the control plane hasn't loaded yet, be permissive (let the API error surface naturally)
  if (cpStore.available === null) return true;
  // If CP is available, require at least one policy for SSE-KMS
  if (cpStore.available && cpStore.policies.length > 0) return true;
  return false;
});

function openSetEncryptionModal(bucketName: string) {
  setEncBucket.value = bucketName;
  const current = bucketEncryption.value[bucketName];
  if (current && current.encrypted) {
    setEncAlgo.value = current.algorithm === "aws:kms" ? "aws:kms" : "AES256";
    setEncKmsKeyId.value = current.kmsKeyId || "";
    setEncBucketKey.value = current.bucketKeyEnabled || false;
  } else {
    setEncAlgo.value = "AES256";
    setEncKmsKeyId.value = "";
    setEncBucketKey.value = false;
  }
  setEncError.value = "";
  setEncBusy.value = false;
  showSetEncModal.value = true;
  // Load control plane policies if not yet loaded
  if (cpStore.available === null || cpStore.policies.length === 0) {
    cpStore.refresh();
  }
}

function cpProviderName(providerId: string): string {
  const p = cpStore.providers.find((prov) => prov.id === providerId);
  return p ? p.name : "Unknown provider";
}

async function applySetEncryption() {
  setEncBusy.value = true;
  setEncError.value = "";

  // Pre-validate KMS key if SSE-KMS with a specific key
  if (setEncAlgo.value === "aws:kms" && setEncKmsKeyId.value && cpStore.isAvailable) {
    const vr = await validateKmsKey(setEncKmsKeyId.value, "transit", true);
    if (vr.isOk() && vr.value) {
      const v = vr.value;
      if (!v.valid) {
        setEncBusy.value = false;
        if (!v.exists) {
          setEncError.value = `Transit key "${setEncKmsKeyId.value}" does not exist in Vault.`;
        } else if (v.exportable === false) {
          setEncError.value = `Transit key "${setEncKmsKeyId.value}" exists but is not exportable. Ceph RGW requires exportable keys. Recreate the key with exportable=true.`;
        } else {
          setEncError.value = v.error || "KMS key validation failed.";
        }
        return;
      }
    }
    // If validation call itself fails, proceed anyway — the backend will catch it
  }

  const backend = effectiveBackendType.value;

  // Prefer control plane path when available — uses backend-specific tooling
  // (mc CLI for MinIO, ceph CLI for RGW) and records audit/governance state
  if (cpStore.isAvailable) {
    const cpRes = await cpStore.setBucketEncryptionAction(
      setEncBucket.value,
      setEncAlgo.value,
      backend,
      setEncAlgo.value === "aws:kms" ? setEncKmsKeyId.value || undefined : undefined,
    );
    setEncBusy.value = false;
    if (!cpRes.success) {
      const msg = cpRes.message || "Failed to set encryption";
      if (backend === "minio" && /kms|kes|encrypt/i.test(msg)) {
        setEncError.value = "MinIO requires KES (Key Encryption Service) configured to support SSE-KMS. "
          + "Set up KES in the Encryption Manager first, or use AES-256 (SSE-S3) for server-managed encryption.";
      } else if (/InvalidEncryptionMethod|kms.*not.*configured|kms.*not.*enabled/i.test(msg)) {
        setEncError.value = "KMS is not configured on this S3 backend. Configure it in the Encryption Manager first.";
      } else {
        setEncError.value = msg;
      }
      return;
    }
    showSetEncModal.value = false;
    pushNotification(
      new Notification("Encryption updated", `Default encryption set on "${setEncBucket.value}".`, "success", 4000)
    );
    fetchBucketEncryptions([setEncBucket.value]);
    return;
  }

  // Fallback: direct S3 API when control plane is not available
  const res = await putBucketEncryption(
    connectionId.value,
    setEncBucket.value,
    setEncAlgo.value,
    setEncAlgo.value === "aws:kms" ? setEncKmsKeyId.value || undefined : undefined,
    setEncAlgo.value === "aws:kms" ? setEncBucketKey.value : undefined
  );
  setEncBusy.value = false;
  if (res.isErr()) {
    const msg = res.error.message;
    // Parse common KMS errors into actionable messages
    if (backend === "minio" && /kms|kes|encrypt/i.test(msg)) {
      setEncError.value = "MinIO requires KES (Key Encryption Service) configured to support SSE-KMS. "
        + "Set up KES in the Encryption Manager first, or use AES-256 (SSE-S3) for server-managed encryption.";
    } else if (/InvalidEncryptionMethod|kms.*not.*configured|kms.*not.*enabled/i.test(msg)) {
      setEncError.value = "KMS is not configured on this S3 backend. Configure it in the Encryption Manager first.";
    } else if (/AccessDenied|InvalidAccessKeyId/i.test(msg)) {
      setEncError.value = "Access denied — check that the S3 credentials have permission to configure encryption.";
    } else {
      setEncError.value = msg;
    }
    return;
  }
  showSetEncModal.value = false;
  pushNotification(
    new Notification("Encryption updated", `Default encryption set on "${setEncBucket.value}".`, "success", 4000)
  );
  // Refresh the encryption badge for this bucket
  fetchBucketEncryptions([setEncBucket.value]);
}

// ── Remove Encryption modal ───────────────────────────────────────────────

const showRemoveEncModal = ref(false);
const removeEncBucket = ref("");
const removeEncBusy = ref(false);
const removeEncError = ref("");

function confirmRemoveEncryption(bucketName: string) {
  removeEncBucket.value = bucketName;
  removeEncError.value = "";
  removeEncBusy.value = false;
  showRemoveEncModal.value = true;
}

async function applyRemoveEncryption() {
  removeEncBusy.value = true;
  removeEncError.value = "";
  const res = await deleteBucketEncryption(connectionId.value, removeEncBucket.value);
  removeEncBusy.value = false;
  if (res.isErr()) {
    const msg = res.error.message;
    if (/AccessDenied/i.test(msg)) {
      removeEncError.value = "Access denied — check that the S3 credentials have permission to modify encryption.";
    } else {
      removeEncError.value = msg;
    }
    return;
  }
  showRemoveEncModal.value = false;
  pushNotification(
    new Notification("Encryption removed", `Default encryption removed from "${removeEncBucket.value}".`, "success", 4000)
  );
  // Update the encryption badge
  bucketEncryption.value = { ...bucketEncryption.value, [removeEncBucket.value]: null };
}

// ── Encryption Manager deep link ──────────────────────────────────────────

function openEncryptionManager() {
  navigateToEncryptionManager();
}

// ── Verify Encryption ─────────────────────────────────────────────────────

const verifyBusy = ref<string | null>(null);

async function verifyEncryption(bucketName: string) {
  verifyBusy.value = bucketName;
  const result = await cpStore.verifyBucketEncryptionAction(bucketName, effectiveBackendType.value);
  verifyBusy.value = null;
  if (result.success) {
    pushNotification(
      new Notification("Encryption verified", result.message || `Bucket "${bucketName}" encryption verified.`, "success", 4000)
    );
  } else {
    // Fallback: check direct S3 encryption data when control plane verify fails
    // (e.g. ceph CLI not installed on this host for remote RGW)
    await fetchBucketEncryptions([bucketName]);
    const enc = bucketEncryption.value[bucketName];
    if (enc && enc.encrypted) {
      const label = enc.algorithm === "aws:kms" ? "SSE-KMS" : enc.algorithm === "AES256" ? "SSE-S3" : enc.algorithm || "encryption";
      const detail = enc.kmsKeyId ? ` with key '${enc.kmsKeyId}'` : "";
      pushNotification(
        new Notification("Encryption verified", `Bucket "${bucketName}" has ${label}${detail} configured.`, "success", 4000)
      );
    } else {
      pushNotification(
        new Notification("Verification failed", result.message || `Could not verify "${bucketName}".`, "error", 5000)
      );
    }
    return;
  }
  fetchBucketEncryptions([bucketName]);
}

// ── Deep Verify (Round-trip) ──────────────────────────────────────────────

const roundtripBusy = ref<string | null>(null);

async function deepVerify(bucketName: string) {
  roundtripBusy.value = bucketName;
  const enc = bucketEncryption.value[bucketName];
  const kmsKeyId = enc?.kmsKeyId || undefined;
  const res = await verifyRoundtrip(bucketName, kmsKeyId);
  roundtripBusy.value = null;
  if (res.isOk() && res.value) {
    if (res.value.roundtripVerified) {
      const algo = res.value.sseAlgorithm || "SSE-KMS";
      const key = res.value.sseKmsKeyId ? ` (key: ${res.value.sseKmsKeyId})` : "";
      pushNotification(
        new Notification("Round-trip verified", `PUT→HEAD→GET→DELETE succeeded on "${bucketName}" with ${algo}${key}.`, "success", 5000)
      );
    } else {
      const detail = res.value.error || "Unknown failure";
      const stepSummary = (res.value.steps || []).map(s => `${s.step}: ${s.ok ? "✓" : "✗"}`).join(", ");
      pushNotification(
        new Notification("Round-trip failed", `${detail}\nSteps: ${stepSummary}`, "error", 8000)
      );
    }
  } else {
    pushNotification(
      new Notification("Round-trip failed", res.isErr() ? res.error.message : "Control plane unavailable", "error", 5000)
    );
  }
}

function shouldOpenMenuUp(index: number, total: number): boolean {
  return total > 0 && index >= total - 3;
}

onMounted(() => {
  cpStore.checkAvailability();
  refresh();
});
</script>
