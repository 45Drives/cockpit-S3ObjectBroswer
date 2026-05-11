<template>
  <div v-if="open" class="fixed inset-0 z-50">
    <div class="absolute inset-0 bg-black/40" @click="emitClose"></div>

    <div class="absolute inset-0 flex items-start justify-center p-4 sm:p-6">
      <div class="w-1/2 rounded-lg border border-default bg-accent shadow-lg" role="dialog" aria-modal="true">
        <div class="flex max-h-[calc(100vh-3rem)] flex-col">
          <!-- Header -->
          <div class="flex items-start justify-between gap-4 border-b border-default px-6 py-5">
            <div class="w-full text-center">
              <h2 class="text-lg font-semibold text-default">
                {{ mode === "create" ? "Add connection" : "Edit connection" }}
              </h2>
              <p class="mt-1 text-sm text-default/70">
                {{
                  mode === "create"
                    ? "Create a new saved endpoint."
                    : "Update the saved endpoint details."
                }}
              </p>
            </div>
          </div>

          <!-- Body -->
          <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
            <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
                <!-- Name -->
                <div class="mb-4 md:col-span-2">
                  <label class="text-sm font-semibold text-default" for="m-name">
                    Endpoint name
                  </label>
                  <p class="mt-1 text-xs text-default/70">
                    A descriptive name used to identify this connection within the application.
                  </p>
                  <input id="m-name" v-model.trim="form.name" type="text" autocomplete="off" placeholder="My connection"
                    :class="inputClass(false)" />
                </div>

                <!-- Endpoint -->
                <div class="mb-4 md:col-span-2">
                  <label class="text-sm font-semibold text-default" for="m-endpoint">
                    Endpoint URL
                  </label>
                  <p class="mt-1 text-xs text-default/70">
                    The hostname and optional port of the S3-compatible service. Do not include the protocol.
                  </p>

                  <input id="m-endpoint" v-model.trim="endpointHost" type="text" autocomplete="off"
                    placeholder="s3.example.com"
                    class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default" />

                  <p v-if="errors.endpoint" class="mt-1 text-sm text-red-600">
                    {{ errors.endpoint }}
                  </p>
                </div>

                <!-- Region -->
                <div class="mb-4">
                  <label class="text-sm font-semibold text-default" for="m-region">
                    Region (optional)
                  </label>
                  <p class="mt-1 text-xs text-default/70">
                    The region used for request signing. Required by some providers and optional for others.
                  </p>
                  <input id="m-region" v-model.trim="form.region" type="text" autocomplete="off" placeholder="us-east-1"
                    :class="inputClass(false)" />
                </div>

                <!-- Access key -->
                <div class="mb-4">
                  <label class="text-sm font-semibold text-default" for="m-access">
                    Access key
                  </label>
                  <p class="mt-1 text-xs text-default/70">
                    The access key identifier used to authenticate requests.
                  </p>
                  <input id="m-access" v-model.trim="form.accessKeyId" type="text" autocomplete="username"
                    placeholder="AKIA..." :class="inputClass(!!errors.accessKeyId)" />
                  <p v-if="errors.accessKeyId" class="mt-1 text-sm text-red-600">
                    {{ errors.accessKeyId }}
                  </p>
                </div>

                <!-- Secret -->
                <div class="mb-4 md:col-span-2">
                  <label class="text-sm font-semibold text-default" for="m-secret">
                    Secret key
                  </label>
                  <p class="mt-1 text-xs text-default/70">
                    The secret key used to cryptographically sign requests. Treat this value as confidential.
                  </p>

                  <div class="mt-1 flex items-center gap-2">
                    <input id="m-secret" v-model="form.secretAccessKey" :type="showSecret ? 'text' : 'password'"
                      autocomplete="current-password" placeholder="••••••••••"
                      :class="inputClass(!!errors.secretAccessKey) + ' flex-1'" />

                    <button type="button"
                      class="inline-flex items-center rounded-md border border-default bg-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:opacity-60"
                      :disabled="busy" @click="showSecret = !showSecret">
                      {{ showSecret ? "Hide" : "Show" }}
                    </button>
                  </div>

                  <p v-if="errors.secretAccessKey" class="mt-1 text-sm text-red-600">
                    {{ errors.secretAccessKey }}
                  </p>
                </div>

                <!-- Options -->
                <div class="space-y-3 md:col-span-2">
                  <p class="text-sm font-semibold text-default">Options</p>

                  <label class="flex items-start gap-3 rounded-md border border-default bg-default p-4">
                    <input type="checkbox" v-model="form.useTls"
                      class="mt-1 h-4 w-4 rounded border-default bg-default text-default focus:ring-default/30" />
                    <div class="min-w-0">
                      <p class="text-sm font-semibold text-default">
                        Use secure transfer (SSL/TLS)
                      </p>
                      <p class="mt-1 text-xs text-default/70">
                        When enabled, all connections to this endpoint will use HTTPS.
                      </p>
                    </div>
                  </label>

                  <label v-if="form.useTls" class="flex items-start gap-3 rounded-md border border-default bg-default p-4">
                    <input type="checkbox" v-model="form.tlsVerify"
                      class="mt-1 h-4 w-4 rounded border-default bg-default text-default focus:ring-default/30" />
                    <div class="min-w-0">
                      <p class="text-sm font-semibold text-default">
                        Verify TLS certificate
                      </p>
                      <p class="mt-1 text-xs text-default/70">
                        Disable this if your endpoint uses a self-signed certificate.
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="border-t border-default px-6 py-4">
              <div class="flex w-full items-center gap-2">
                <button type="button"
                  class="inline-flex items-center rounded-md border border-default btn-danger px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="busy" @click="emitClose">
                  Cancel
                </button>

                <button type="submit"
                  class="ml-auto inline-flex items-center rounded-md bg-default btn-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="busy">
                  Save
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>


<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import type { ConnectionSummary, EndpointConfig } from "../../types";
import { getConnection, upsertConnection } from "../../lib/endpointConnection";

type Mode = "create" | "edit";

const props = defineProps<{
  open: boolean;
  mode: Mode;
  id?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved", payload: ConnectionSummary): void;
  (e: "error", message: string): void;
}>();

const busy = ref(false);
const showSecret = ref(false);
const endpointHost = ref("");

const form = reactive<EndpointConfig>({
  name: "",
  endpoint: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  useTls: false,
  tlsVerify: true,
});

const errors = reactive<Record<string, string>>({
  endpoint: "",
  accessKeyId: "",
  secretAccessKey: "",
});

function inputClass(invalid: boolean): string {
  return [
    "block w-full  rounded-md border px-3 py-2   placeholder:text-muted",
    "input-textlike bg-default text-default",
    invalid
      ? "border-red-300 text-default focus:border-red-400 focus:ring-red-100"
      : "border-default text-default focus:border-default focus:ring-default",
  ].join(" ");
}

function clearErrors() {
  errors.endpoint = "";
  errors.accessKeyId = "";
  errors.secretAccessKey = "";
}

function normalizeHost(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function resetForm() {
  form.name = "";
  form.endpoint = "";
  form.region = "";
  form.accessKeyId = "";
  form.secretAccessKey = "";
  endpointHost.value = "";
  showSecret.value = false;
  form.useTls = false;
  form.tlsVerify = true;

  clearErrors();
}

async function loadForEdit(id: string) {
  busy.value = true;
  try {
    const res = await getConnection(id);
    if (res.isErr()) {
      emit("error", res.error.message);
      return;
    }
    if (!res.value) {
      emit("error", "Connection not found.");
      return;
    }

    form.name = res.value.name;
    form.endpoint = res.value.endpoint;
    form.region = res.value.region || "";
    form.accessKeyId = res.value.accessKeyId;
    form.secretAccessKey = res.value.secretAccessKey;
    form.useTls = !!(res.value as any).useTls;
    form.tlsVerify = (res.value as any).tlsVerify !== false;
    endpointHost.value = normalizeHost(res.value.endpoint);
    showSecret.value = false;
    clearErrors();
  } finally {
    busy.value = false;
  }
}

watch(
  () => [props.open, props.mode, props.id] as const,
  async ([open, mode, id]) => {
    if (!open) return;

    if (mode === "create") {
      resetForm();
      return;
    }

    if (mode === "edit" && id) {
      await loadForEdit(id);
      return;
    }

    resetForm();
  },
  { immediate: true }
);

function validate(): boolean {
  clearErrors();

  const host = normalizeHost(endpointHost.value);
  form.endpoint = host;


  if (!form.endpoint) {
    errors.endpoint = "Endpoint is required.";
  } else {
    try {
      new URL(`http://${form.endpoint}`);
    } catch {
      errors.endpoint = "Endpoint must be a valid host:port.";
    }
  }


  if (!form.accessKeyId) errors.accessKeyId = "Access key is required.";
  if (!form.secretAccessKey) errors.secretAccessKey = "Secret key is required.";

  return !errors.endpoint && !errors.accessKeyId && !errors.secretAccessKey;
}

function emitClose() {
  if (busy.value) return;
  emit("close");
}

async function save() {
  if (!validate()) return;

  busy.value = true;
  try {
    const cfg: EndpointConfig = {
      name: (form.name || "").trim() || form.endpoint,
      endpoint: form.endpoint,
      region: (form.region || "").trim() || undefined,
      accessKeyId: (form.accessKeyId || "").trim(),
      useTls: form.useTls,
      tlsVerify: form.tlsVerify,
      secretAccessKey: form.secretAccessKey,

    };

    const res = await upsertConnection(cfg, props.mode === "edit" ? props.id : undefined);
    if (res.isErr()) {
      emit("error", res.error.message);
      return;
    }

    const id = res.value;
    const now = new Date().toISOString();

    const summary: ConnectionSummary = {
      id,
      name: cfg.name,
      endpoint: cfg.endpoint,
      region: cfg.region,
      updatedAt: now,
      useTls: cfg.useTls,
      tlsVerify: cfg.tlsVerify,
      lastUsedAt: undefined,
    };

    emit("saved", summary);
    emit("close");
  } finally {
    busy.value = false;
  }
}
</script>