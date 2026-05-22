<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-default">RustFS KMS Configuration</h2>
      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-secondary"
        :disabled="refreshing" @click="refreshAll">
        {{ refreshing ? 'Loading...' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{{ error }}</div>
    <div v-if="successMsg" class="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">{{ successMsg }}</div>

    <!-- Service Status -->
    <div class="rounded-md border border-default bg-accent p-4 space-y-3">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">RustFS Service Status</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <span class="text-default opacity-60 block text-xs">Binary</span>
          <span :class="preflight?.binaryFound ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ preflight ? (preflight.binaryFound ? '● Installed' : '✗ Not found') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Service</span>
          <span :class="preflight?.serviceActive ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ preflight ? (preflight.serviceActive ? '● Running' : '○ Stopped') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Config File</span>
          <span :class="preflight?.envFileExists ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ preflight ? (preflight.envFileExists ? '✓ Present' : '✗ Missing') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">KMS</span>
          <span :class="config?.kmsEnabled ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ config ? (config.kmsEnabled ? '✓ Enabled' : '✗ Disabled') : '...' }}
          </span>
        </div>
      </div>

      <!-- Detail row when KMS is enabled -->
      <div v-if="config?.kmsEnabled" class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-t border-default pt-3">
        <div>
          <span class="text-default opacity-60 block text-xs">Backend</span>
          <span class="text-default">{{ config.kmsBackend || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Vault Address</span>
          <span class="text-default">{{ config.vaultAddress || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Default Key ID</span>
          <span class="text-default"><code>{{ config.defaultKeyId || '(none)' }}</code></span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Vault Token</span>
          <span class="text-default">{{ config.vaultToken ? '***' : '(not set)' }}</span>
        </div>
      </div>
    </div>

    <!-- Prerequisites check detail -->
    <div v-if="preflight && !preflight.ready" class="rounded-md border border-default bg-accent p-4 space-y-3">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">Prerequisites</h3>
      <div class="space-y-1.5">
        <div v-for="check in preflight.checks" :key="check.name" class="flex items-center gap-2 text-sm">
          <span :class="check.passed ? 'text-green-600' : (check.critical ? 'text-red-600' : 'text-yellow-600')">
            {{ check.passed ? '✓' : (check.critical ? '✗' : '○') }}
          </span>
          <span class="text-default">{{ check.message }}</span>
          <span v-if="check.critical && !check.passed" class="text-xs text-red-500 font-medium">(required)</span>
        </div>
      </div>

      <!-- SSH Setup helper when SSH fails on remote host -->
      <div v-if="preflight.sshFailed && preflight.isRemote" class="border-t border-default pt-3 space-y-3">
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

      <p v-if="!preflight.sshFailed" class="text-xs text-default opacity-60">
        Install and start RustFS before configuring KMS. The RustFS binary should be at
        <code>/usr/local/bin/rustfs</code> with a systemd unit file for <code>rustfs.service</code>.
      </p>
    </div>

    <!-- Configure KMS Section -->
    <div v-if="preflight?.ready" class="rounded-md border border-default bg-accent p-4 space-y-4">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">
        {{ config?.kmsEnabled ? 'Reconfigure KMS (Vault)' : 'Configure RustFS KMS (Vault)' }}
      </h3>
      <p class="text-sm text-default opacity-60">
        {{ config?.kmsEnabled
          ? 'KMS is currently configured. You can update the Vault address, token, or default key.'
          : 'Connect RustFS to your Vault server for SSE-KMS encryption. This writes environment variables to /etc/default/rustfs and restarts the service.' }}
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">KMS Provider</label>
          <select v-model="selectedProviderId"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default">
            <option value="">— Select provider —</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">
              {{ p.name }} ({{ p.url }})
            </option>
          </select>
          <p class="text-xs text-default opacity-60 mt-1">Selects the Vault address automatically.</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Default Key ID</label>
          <select v-model="defaultKeyId" :disabled="!selectedProviderId"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default disabled:opacity-50">
            <option value="">{{ selectedProviderId ? '— Select key —' : '— Select a provider first —' }}</option>
            <option v-for="p in rustfsPolicies" :key="p.id" :value="p.transit_key_name || p.name">
              {{ p.name }} ({{ p.transit_key_name || p.id }})
            </option>
          </select>
          <p class="text-xs text-default opacity-60 mt-1">
            {{ !selectedProviderId ? 'Select a KMS provider to see available keys.' : rustfsPolicies.length ? 'Compatible kv2_rustfs key policies for this provider.' : 'No kv2_rustfs policies found for this provider.' }}
          </p>
        </div>
        <div v-if="!selectedProviderId">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Vault Address</label>
          <input v-model="vaultAddr" type="text"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="https://10.20.0.142:8200" />
        </div>
        <div>
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Vault Token</label>
          <input v-model="vaultToken" type="password"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="hvs.xxxxx" />
          <p class="text-xs text-default opacity-60 mt-1">{{ selectedProviderId ? 'Leave blank to use token from provider credentials.' : 'Token with read access to the KV v2 secrets engine.' }}</p>
        </div>
      </div>

      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-primary"
        :disabled="(!vaultAddr && !selectedProviderId) || (!vaultToken && !selectedProviderId) || configuring" @click="configureKms">
        {{ configuring ? 'Configuring...' : (config?.kmsEnabled ? 'Update KMS Configuration' : 'Enable KMS') }}
      </button>

      <div v-if="configResult" class="border border-default rounded-md p-4 space-y-2 text-sm">
        <div :class="configResult.success ? 'text-green-600' : 'text-red-600'" class="font-semibold">
          {{ configResult.success ? '✓ Configuration applied' : '✗ Configuration failed' }}
        </div>
        <p class="text-default opacity-60">{{ configResult.message }}</p>
        <div v-if="configResult.changes && configResult.changes.length > 0" class="space-y-1">
          <div v-for="change in configResult.changes" :key="change.param" class="flex items-center gap-2 text-xs">
            <span :class="change.success ? 'text-green-600' : 'text-red-600'">
              {{ change.success ? '✓' : '✗' }}
            </span>
            <code class="font-medium text-default">{{ change.param }}</code>
            <span class="text-default opacity-60">{{ change.old ? `${change.old} →` : '→' }} {{ change.value }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import {
  kmsPreflight,
  rustfsGetConfig,
  rustfsConfigureVault,
  listProviders,
  listPolicies,
  sshCopyId,
} from '../lib/controlplane-client';
import type {
  RustfsKmsConfig,
  RustfsConfigureResult,
  KmsPreflightResult,
} from '../lib/controlplane-client';
import type { ProviderSummary, PolicySummary } from '../lib/controlplane-types';

const props = defineProps<{
  connectionHost?: string;
}>();

const error = ref('');
const successMsg = ref('');
const refreshing = ref(false);

// Effective host for SSH
const effectiveHost = computed(() => props.connectionHost || 'localhost');

// SSH setup
const sshPassword = ref('');
const sshSetupBusy = ref(false);
const sshSetupResult = ref<{ success: boolean; message: string } | null>(null);

// Preflight & config
const preflight = ref<KmsPreflightResult | null>(null);
const config = ref<RustfsKmsConfig | null>(null);

// Providers & policies
const providers = ref<ProviderSummary[]>([]);
const policies = ref<PolicySummary[]>([]);

const rustfsPolicies = computed(() =>
  policies.value.filter(p =>
    p.key_engine === 'kv2_rustfs' &&
    (!selectedProviderId.value || p.provider_id === selectedProviderId.value)
  ),
);

// Configure form
const selectedProviderId = ref('');
const vaultAddr = ref('');
const vaultToken = ref('');
const defaultKeyId = ref('');
const configuring = ref(false);
const configResult = ref<RustfsConfigureResult | null>(null);

watch(selectedProviderId, (id) => {
  if (id) {
    const p = providers.value.find(prov => prov.id === id);
    if (p) vaultAddr.value = p.url;
  }
  // Reset key if it doesn't belong to the new provider
  if (defaultKeyId.value) {
    const stillValid = rustfsPolicies.value.some(
      p => (p.transit_key_name || p.name) === defaultKeyId.value
    );
    if (!stillValid) defaultKeyId.value = '';
  }
});

async function loadPreflight() {
  const result = await kmsPreflight('rustfs', props.connectionHost ? { host: props.connectionHost } : {});
  result.match(
    val => { preflight.value = val; },
    err => { error.value = err.message; },
  );
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
      if (val?.success) loadPreflight();
    },
    err => { sshSetupResult.value = { success: false, message: err.message }; },
  );
  sshSetupBusy.value = false;
}

async function loadConfig() {
  const result = await rustfsGetConfig(props.connectionHost);
  result.match(
    val => {
      config.value = val;
      if (val?.vaultAddress) vaultAddr.value = val.vaultAddress;
      if (val?.defaultKeyId) defaultKeyId.value = val.defaultKeyId;
    },
    () => { /* non-fatal */ },
  );
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
  configResult.value = null;
  refreshing.value = true;
  try {
    await Promise.all([loadPreflight(), loadConfig(), loadProviders(), loadPolicies()]);
  } finally {
    refreshing.value = false;
  }
}

async function configureKms() {
  error.value = '';
  successMsg.value = '';
  configuring.value = true;
  configResult.value = null;

  const result = await rustfsConfigureVault({
    providerId: selectedProviderId.value || undefined,
    vaultAddr: vaultAddr.value,
    vaultToken: vaultToken.value,
    defaultKeyId: defaultKeyId.value || undefined,
    host: props.connectionHost,
  });
  result.match(
    val => {
      configResult.value = val;
      if (val?.success) {
        successMsg.value = val.message;
        Promise.all([loadPreflight(), loadConfig()]);
      }
    },
    err => { error.value = err.message; },
  );
  configuring.value = false;
}

onMounted(refreshAll);
</script>
