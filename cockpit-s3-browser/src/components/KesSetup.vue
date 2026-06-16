<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-default">MinIO KES Configuration</h2>
      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-secondary"
        :disabled="discovering" @click="refreshAll">
        {{ discovering ? 'Loading...' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{{ error }}</div>
    <div v-if="successMsg" class="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">{{ successMsg }}</div>

    <!-- Service Status -->
    <div class="rounded-md border border-default bg-accent p-4 space-y-3">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">Service Status</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <span class="text-default opacity-60 block text-xs">MinIO</span>
          <span :class="discovery?.minioRunning ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ discovery ? (discovery.minioRunning ? '● Running' : (discovery.minioInstalled ? '○ Stopped' : '✗ Not installed')) : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">KES</span>
          <span :class="discovery?.kesRunning ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ discovery ? (discovery.kesRunning ? '● Running' : (discovery.kesInstalled ? '○ Stopped' : '✗ Not installed')) : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">SSE Configured</span>
          <span :class="discovery?.sseConfigured ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ discovery?.sseConfigured ? '✓ Yes' : '✗ No' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">KES Endpoint</span>
          <span class="text-default">{{ discovery?.kesEndpoint || '—' }}</span>
        </div>
      </div>

      <!-- Detail row when SSE is configured -->
      <div v-if="discovery?.sseConfigured" class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-t border-default pt-3">
        <div>
          <span class="text-default opacity-60 block text-xs">MinIO Endpoint</span>
          <span class="text-default">{{ discovery.minioEndpoint || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Default Key</span>
          <span class="text-default"><code>{{ discovery.config?.MINIO_KMS_KES_KEY_NAME || '(none)' }}</code></span>
        </div>
      </div>

      <div class="flex gap-2 pt-2 border-t border-default">
        <button v-if="discovery && !discovery.kesInstalled"
          class="inline-flex items-center justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 btn-primary"
          :disabled="installing" @click="installKes">
          {{ installing ? 'Installing...' : 'Install KES' }}
        </button>
        <button v-if="discovery?.kesInstalled"
          class="inline-flex items-center justify-center rounded-md border border-default px-3 py-1.5 text-sm font-semibold text-default shadow-sm hover:opacity-90 btn-secondary"
          :disabled="restartingKes" @click="startKes">
          {{ restartingKes ? '...' : (discovery.kesRunning ? 'Restart KES' : 'Start KES') }}
        </button>
      </div>
      <div v-if="installResult" class="text-sm" :class="installResult.success ? 'text-green-600' : 'text-red-600'">
        {{ installResult.message }}
      </div>
      <div v-if="restartResult" class="text-sm" :class="restartResult.success ? 'text-green-600' : 'text-red-600'">
        {{ restartResult.message }}
      </div>

      <!-- SSH Setup helper when SSH fails on remote host -->
      <div v-if="discovery?.sshFailed && discovery?.isRemote" class="border-t border-default pt-3 space-y-3">
        <p class="text-sm text-default opacity-80">
          <strong>Set up SSH access:</strong> Enter the password for <code>root@{{ effectiveHost }}</code>
          to automatically deploy the SSH key.
        </p>
        <div class="flex gap-3 items-end">
          <div class="flex-1">
            <label class="block text-xs font-medium text-default opacity-60 mb-1">Password for root@{{ effectiveHost }}</label>
            <input v-model="sshPassword" type="password"
              class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
              placeholder="Enter password..." @keyup.enter="setupSshKey" />
          </div>
          <button
            class="inline-flex items-center justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-primary"
            :disabled="!sshPassword || sshSetupBusy" @click="setupSshKey">
            {{ sshSetupBusy ? 'Setting up...' : 'Deploy SSH Key' }}
          </button>
        </div>
        <div v-if="sshSetupResult" class="text-sm" :class="sshSetupResult.success ? 'text-green-600' : 'text-red-600'">
          {{ sshSetupResult.success ? '✓' : '✗' }} {{ sshSetupResult.message }}
        </div>
        <p v-if="!sshSetupResult" class="text-xs text-default opacity-60">
          Or manually configure passwordless SSH: <code>ssh-copy-id root@{{ effectiveHost }}</code>
        </p>
      </div>
    </div>

    <!-- Configure KES → Vault -->
    <div v-if="discovery && discovery.kesInstalled"
      class="rounded-md border border-default bg-accent p-4 space-y-4">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">
        {{ discovery.sseConfigured && discovery.kesRunning && discovery.minioRunning ? 'Reconfigure KES → Vault' :
           discovery.sseConfigured && !discovery.kesRunning ? 'Complete KES Setup' :
           discovery.sseConfigured && !discovery.minioRunning ? 'Restart MinIO' :
           'Configure KES → Vault' }}
      </h3>
      <p class="text-sm text-default opacity-60">
        {{ discovery.sseConfigured && discovery.kesRunning && discovery.minioRunning
          ? 'KES is configured and running. You can update the Vault connection, key, or re-run the setup.'
          : !discovery.kesRunning && discovery.sseConfigured
          ? 'KES is configured but not running. Complete the setup to start the services.'
          : !discovery.minioRunning && discovery.sseConfigured
          ? 'KES is running but MinIO failed to start. Run setup again to restart MinIO.'
          : 'Connect KES to your Vault server. This auto-generates TLS certs, creates a Vault AppRole, writes the config, and configures MinIO.' }}
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">KMS Provider</label>
          <select v-model="selectedProviderId"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default">
            <option value="" disabled>Select Vault provider</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }} ({{ p.url }})</option>
          </select>
          <p class="text-xs text-default opacity-60 mt-1">Selects the Vault address and token automatically.</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Default Key Name</label>
          <select v-model="transitKey" :disabled="!selectedProviderId"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default disabled:opacity-50">
            <option value="">{{ selectedProviderId ? '— Select key —' : '— Select a provider first —' }}</option>
            <option v-for="p in kesPolicies" :key="p.id" :value="p.transit_key_name || p.name">
              {{ p.name }} ({{ p.transit_key_name || p.id }})
            </option>
          </select>
          <p class="text-xs text-default opacity-60 mt-1">
            {{ !selectedProviderId ? 'Select a KMS provider to see available keys.' : kesPolicies.length ? 'Compatible kv1_kes key policies for this provider.' : 'No kv1_kes policies found for this provider.' }}
          </p>
        </div>
        <div v-if="!selectedProviderId">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Vault Address</label>
          <input v-model="vaultAddr"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="https://10.20.0.142:8200" />
        </div>
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Vault Token (one-time, for AppRole setup)</label>
          <input v-model="vaultToken" type="password"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="hvs.xxxxx" />
          <p class="text-xs text-default opacity-60 mt-1">{{ selectedProviderId ? 'Leave blank to use token from provider credentials.' : 'Token with permissions to create a Vault AppRole. Used once during setup.' }}</p>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <input id="kes-skip-tls-verify" v-model="skipTlsVerify" type="checkbox"
          class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
        <label for="kes-skip-tls-verify" class="text-sm text-default">Skip TLS certificate verification</label>
      </div>
      <p v-if="skipTlsVerify" class="text-xs text-yellow-600 -mt-2 ml-6">
        Warning: Disables certificate validation for Vault connections. Use only if your Vault server uses a self-signed certificate or has mismatched SANs.
      </p>

      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-primary"
        :disabled="(!vaultAddr && !selectedProviderId) || (!vaultToken && !selectedProviderId) || configuring" @click="configureKes">
        {{ configuring ? 'Configuring...' : (discovery?.sseConfigured ? 'Reconfigure KES + MinIO' : 'Setup KES + MinIO') }}
      </button>

      <div v-if="configResult" class="border border-default rounded-md p-4 space-y-2 text-sm">
        <div :class="configResult.success ? 'text-green-600' : 'text-red-600'" class="font-semibold">
          {{ configResult.success ? '✓ Setup complete' : '✗ Setup failed' }}
        </div>
        <p class="text-default opacity-60">{{ configResult.message }}</p>
        <div v-for="step in configResult.steps" :key="step.step" class="flex items-center gap-2 text-xs">
          <span :class="(step.result as any)?.success ? 'text-green-600' : 'text-red-600'">
            {{ (step.result as any)?.success ? '✓' : '✗' }}
          </span>
          <span class="font-medium text-default">{{ step.step }}</span>
          <span v-if="(step.result as any)?.message" class="text-default opacity-60">— {{ (step.result as any).message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  minioDiscover,
  minioInstallKes,
  minioConfigureKes,
  minioRestartKes,
  listProviders,
  listPolicies,
  sshCopyId,
} from '../lib/controlplane-client';
import type { MinIODiscovery, MinIOKesConfigResult } from '../lib/controlplane-client';
import type { ProviderSummary, PolicySummary } from '../lib/controlplane-types';

const props = defineProps<{
  connectionHost?: string;
}>();

const error = ref('');
const successMsg = ref('');

// Effective host for SSH
const effectiveHost = computed(() => props.connectionHost || 'localhost');

// SSH setup
const sshPassword = ref('');
const sshSetupBusy = ref(false);
const sshSetupResult = ref<{ success: boolean; message: string } | null>(null);

// Discovery
const discovering = ref(false);
const discovery = ref<MinIODiscovery | null>(null);

// Providers & policies
const providers = ref<ProviderSummary[]>([]);
const policies = ref<PolicySummary[]>([]);

const kesPolicies = computed(() =>
  policies.value.filter(p =>
    p.key_engine === 'kv1_kes' &&
    (!selectedProviderId.value || p.provider_id === selectedProviderId.value)
  ),
);

// Configure form
const selectedProviderId = ref('');
const vaultAddr = ref('');
const vaultToken = ref('');
const transitKey = ref('');
const skipTlsVerify = ref(false);
const configuring = ref(false);
const configResult = ref<MinIOKesConfigResult | null>(null);

// Install/restart
const installing = ref(false);
const installResult = ref<{ success: boolean; message: string } | null>(null);
const restartingKes = ref(false);
const restartResult = ref<{ success: boolean; message: string } | null>(null);

watch(selectedProviderId, (id) => {
  if (id) {
    const p = providers.value.find(prov => prov.id === id);
    if (p) vaultAddr.value = p.url;
  }
  // Reset key if it doesn't belong to the new provider
  if (transitKey.value) {
    const stillValid = kesPolicies.value.some(
      p => (p.transit_key_name || p.name) === transitKey.value
    );
    if (!stillValid) transitKey.value = '';
  }
});

async function runDiscover() {
  discovering.value = true;
  const result = await minioDiscover(props.connectionHost);
  result.match(
    val => { discovery.value = val; },
    err => { error.value = err.message; },
  );
  discovering.value = false;
}

async function setupSshKey() {
  if (!sshPassword.value || !effectiveHost.value) return;
  sshSetupBusy.value = true;
  sshSetupResult.value = null;
  const result = await sshCopyId(effectiveHost.value, sshPassword.value);
  result.match(
    val => {
      sshSetupResult.value = val;
      sshPassword.value = '';
      if (val?.success) runDiscover();
    },
    err => { sshSetupResult.value = { success: false, message: err.message }; },
  );
  sshSetupBusy.value = false;
}

async function loadProviders() {
  const result = await listProviders();
  result.match(
    val => { providers.value = val ?? []; },
    () => {},
  );
}

async function loadPolicies() {
  const result = await listPolicies();
  result.match(
    val => { policies.value = val ?? []; },
    () => {},
  );
}

async function refreshAll() {
  error.value = '';
  successMsg.value = '';
  await Promise.all([runDiscover(), loadProviders(), loadPolicies()]);
}

async function installKes() {
  installing.value = true;
  installResult.value = null;
  const result = await minioInstallKes(props.connectionHost);
  result.match(
    val => {
      installResult.value = val;
      if (val?.success) runDiscover();
    },
    err => { installResult.value = { success: false, message: err.message }; },
  );
  installing.value = false;
}

async function startKes() {
  restartingKes.value = true;
  restartResult.value = null;
  const result = await minioRestartKes(props.connectionHost);
  result.match(
    val => {
      restartResult.value = val;
      if (val?.success) runDiscover();
    },
    err => { restartResult.value = { success: false, message: err.message }; },
  );
  restartingKes.value = false;
}

async function configureKes() {
  configuring.value = true;
  configResult.value = null;
  const result = await minioConfigureKes({
    providerId: selectedProviderId.value || undefined,
    vaultAddr: vaultAddr.value || undefined,
    vaultToken: vaultToken.value || undefined,
    transitKey: transitKey.value || undefined,
    skipTlsVerify: skipTlsVerify.value || undefined,
    host: props.connectionHost,
  });
  result.match(
    val => {
      configResult.value = val;
      if (val?.success) {
        successMsg.value = 'KES + MinIO configured successfully.';
        runDiscover();
      }
    },
    err => { error.value = err.message; },
  );
  configuring.value = false;
}

onMounted(refreshAll);
</script>
