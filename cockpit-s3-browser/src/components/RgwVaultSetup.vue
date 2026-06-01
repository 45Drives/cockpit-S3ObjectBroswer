<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-default">RGW Vault KMS Configuration</h2>
      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-3 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-secondary"
        :disabled="refreshing" @click="refreshAll">
        {{ refreshing ? 'Loading...' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{{ error }}</div>
    <div v-if="successMsg" class="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">{{ successMsg }}</div>

    <!-- Ceph Admin Host Input -->
    <div v-if="!cephHost" class="rounded-md border border-default bg-accent p-4 space-y-3">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">Ceph Admin Host</h3>
      <p class="text-sm text-default opacity-60">
        Enter the hostname or IP of a Ceph node with admin access (mon/mgr).
        This host will be used to configure the RGW Vault backend via SSH.
      </p>
      <div class="flex gap-3 items-end">
        <div class="flex-1">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Ceph Admin Node Address</label>
          <input v-model="cephHostInput" type="text"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            :placeholder="connectionHost || '192.168.x.x'" />
        </div>
        <div class="w-32">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">SSH User</label>
          <input v-model="sshUserInput" type="text"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="root" />
        </div>
        <button
          class="inline-flex items-center justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-primary"
          :disabled="!cephHostInput" @click="setCephHost">
          Connect
        </button>
      </div>
    </div>

    <!-- Status Panel (after ceph admin host is set) -->
    <div v-if="cephHost" class="rounded-md border border-default bg-accent p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">RGW Vault Status</h3>
        <button class="text-xs text-blue-600 hover:underline" @click="cephHost = ''">Change Host</button>
      </div>
      <div class="text-sm text-default mb-2">
        <span class="opacity-60">Ceph admin host:</span> <code>{{ sshUser }}@{{ cephHost }}</code>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <span class="text-default opacity-60 block text-xs">SSH</span>
          <span :class="sshOk ? 'text-green-600 font-semibold' : 'text-red-600'">
            {{ preflight ? (sshOk ? '● Connected' : '✗ Failed') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Ceph CLI</span>
          <span :class="cephCliOk ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ preflight ? (cephCliOk ? '● Available' : '✗ Not found') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Cluster</span>
          <span :class="clusterOk ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ preflight ? (clusterOk ? '● Reachable' : '✗ Unreachable') : '...' }}
          </span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Vault Backend</span>
          <span :class="vaultConfigured ? 'text-green-600 font-semibold' : 'text-yellow-600'">
            {{ config ? (vaultConfigured ? '✓ Configured' : '✗ Not set') : '...' }}
          </span>
        </div>
      </div>

      <!-- Detail row when Vault is configured -->
      <div v-if="vaultConfigured && config" class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-t border-default pt-3">
        <div>
          <span class="text-default opacity-60 block text-xs">Backend</span>
          <span class="text-default">{{ config.backend || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Vault Address</span>
          <span class="text-default">{{ config.vaultAddr || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Secret Engine</span>
          <span class="text-default">{{ config.vaultSecretEngine || '—' }}</span>
        </div>
        <div>
          <span class="text-default opacity-60 block text-xs">Token File</span>
          <span class="text-default">{{ config.vaultTokenFile || '(not set)' }}</span>
        </div>
      </div>
    </div>

    <!-- Preflight checks detail -->
    <div v-if="preflight && !preflight.passed" class="rounded-md border border-default bg-accent p-4 space-y-3">
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

      <!-- SSH Setup helper when SSH fails -->
      <div v-if="!sshOk" class="border-t border-default pt-3 space-y-3">
        <p class="text-sm text-default opacity-80">
          <strong>Set up SSH access:</strong> Enter the password for <code>{{ sshUser }}@{{ cephHost }}</code>
          to automatically deploy the SSH key.
        </p>
        <div class="flex gap-3 items-end">
          <div class="flex-1">
            <label class="block text-xs font-medium text-default opacity-60 mb-1">Password for {{ sshUser }}@{{ cephHost }}</label>
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
          Or manually configure passwordless SSH: <code>ssh-copy-id {{ sshUser }}@{{ cephHost }}</code>
        </p>
      </div>
    </div>

    <!-- Configure Vault Section -->
    <div v-if="preflight?.passed" class="rounded-md border border-default bg-accent p-4 space-y-4">
      <h3 class="text-sm font-semibold uppercase tracking-wide text-default opacity-60">
        {{ vaultConfigured ? 'Reconfigure RGW Vault Backend' : 'Configure RGW Vault Backend' }}
      </h3>
      <p class="text-sm text-default opacity-60">
        {{ vaultConfigured
          ? 'The RGW is already configured to use Vault. Update the settings below to reconfigure.'
          : 'Configure the Ceph RGW daemon to use Vault Transit engine for SSE-KMS. This runs `ceph config set` commands on the Ceph admin node and writes the token file.' }}
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
          <p class="text-xs text-default opacity-60 mt-1">Selects the Vault address and token automatically.</p>
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
          <p class="text-xs text-default opacity-60 mt-1">{{ selectedProviderId ? 'Leave blank to use token from provider credentials. A scoped read-only token will be created for RGW.' : 'Token with access to the Transit secrets engine. Written to /etc/ceph/vault.token on the Ceph admin host.' }}</p>
        </div>
        <div v-if="!selectedProviderId">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Secret Engine</label>
          <select v-model="secretEngine"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default">
            <option value="transit">transit</option>
          </select>
        </div>
        <div v-if="!selectedProviderId">
          <label class="block text-xs font-medium text-default opacity-60 mb-1">Vault Namespace <span class="opacity-60">(optional)</span></label>
          <input v-model="vaultNamespace" type="text"
            class="block w-full rounded-md border border-default bg-default px-3 py-2 text-sm text-default shadow-sm focus:outline-none focus:ring-2 focus:ring-default"
            placeholder="Leave empty for root namespace" />
        </div>
      </div>

      <button
        class="inline-flex items-center justify-center rounded-md border border-default px-4 py-2 text-sm font-semibold text-default shadow-sm hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 btn-primary"
        :disabled="(!vaultAddr && !selectedProviderId) || (!vaultToken && !selectedProviderId) || configuring" @click="configureVault">
        {{ configuring ? 'Configuring...' : (vaultConfigured ? 'Update Vault Configuration' : 'Configure Vault Backend') }}
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
            <span class="text-default opacity-60">→ {{ change.value }}</span>
            <span v-if="change.error" class="text-red-500">{{ change.error }}</span>
          </div>
        </div>
        <p v-if="configResult.success && !configResult.changes?.some(c => (c.param === 'rgw_daemon_redeploy' || c.param === 'rgw_daemon_restart') && c.success)"
          class="text-xs text-default opacity-60 border-t border-default pt-2 mt-2">
          ⚠ The RGW daemon may need to be redeployed manually for changes to take effect:
          <code>ceph orch redeploy rgw.&lt;service_id&gt;</code>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import {
  rgwPreflight,
  rgwGetConfig,
  rgwConfigureVault,
  listProviders,
  listPolicies,
  sshCopyId,
} from '../lib/controlplane-client';
import type {
  RgwVaultConfig,
  RgwConfigureResult,
  KmsPreflightResult,
} from '../lib/controlplane-client';
import type { ProviderSummary, PolicySummary } from '../lib/controlplane-types';

const props = defineProps<{
  connectionHost?: string;
}>();

const error = ref('');
const successMsg = ref('');
const refreshing = ref(false);

// Ceph admin host (user-specified or derived from connection endpoint)
const cephHostInput = ref('');
const sshUserInput = ref('root');
const cephHost = ref('');
const sshUser = ref('root');

// SSH key setup
const sshPassword = ref('');
const sshSetupBusy = ref(false);
const sshSetupResult = ref<{ success: boolean; message: string } | null>(null);

// Preflight & config
const preflight = ref<KmsPreflightResult | null>(null);
const config = ref<RgwVaultConfig | null>(null);

// Providers & policies
const providers = ref<ProviderSummary[]>([]);
const policies = ref<PolicySummary[]>([]);

const transitPolicies = computed(() =>
  policies.value.filter(p =>
    (p.key_engine === 'transit' || p.key_engine === 'transit_rgw') &&
    (!selectedProviderId.value || p.provider_id === selectedProviderId.value)
  ),
);

// Derived status from preflight checks
const sshOk = computed(() => preflight.value?.checks?.some(c => c.name === 'ssh_connectivity' && c.passed) ?? false);
const cephCliOk = computed(() => preflight.value?.checks?.some(c => c.name === 'ceph_cli_available' && c.passed) ?? false);
const clusterOk = computed(() => preflight.value?.checks?.some(c => c.name === 'ceph_cluster_reachable' && c.passed) ?? false);
const vaultConfigured = computed(() => config.value?.backend === 'vault');

// Configure form
const selectedProviderId = ref('');
const vaultAddr = ref('');
const vaultToken = ref('');
const secretEngine = ref('transit');
const vaultNamespace = ref('');
const transitKeyName = ref('');
const configuring = ref(false);
const configResult = ref<RgwConfigureResult | null>(null);

watch(selectedProviderId, (id) => {
  if (id) {
    const p = providers.value.find(prov => prov.id === id);
    if (p) vaultAddr.value = p.url;
  }
  // Reset key if it doesn't belong to the new provider
  if (transitKeyName.value) {
    const stillValid = transitPolicies.value.some(
      p => (p.transit_key_name || p.name) === transitKeyName.value
    );
    if (!stillValid) transitKeyName.value = '';
  }
});

function setCephHost() {
  cephHost.value = cephHostInput.value.trim();
  sshUser.value = sshUserInput.value.trim() || 'root';
  refreshAll();
}

async function loadPreflight() {
  if (!cephHost.value) return;
  const result = await rgwPreflight(cephHost.value, vaultAddr.value || undefined, sshUser.value || undefined);
  result.match(
    val => { preflight.value = val; },
    err => { error.value = err.message; },
  );
}

async function loadConfig() {
  if (!cephHost.value) return;
  const result = await rgwGetConfig(cephHost.value, sshUser.value || undefined);
  result.match(
    val => {
      config.value = val;
      if (val?.vaultAddr) vaultAddr.value = val.vaultAddr;
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
  sshSetupResult.value = null;
  refreshing.value = true;
  try {
    await Promise.all([loadPreflight(), loadConfig(), loadProviders(), loadPolicies()]);
  } finally {
    refreshing.value = false;
  }
}

async function setupSshKey() {
  if (!sshPassword.value || !cephHost.value) return;
  sshSetupBusy.value = true;
  sshSetupResult.value = null;
  const result = await sshCopyId(cephHost.value, sshPassword.value, sshUser.value || undefined);
  result.match(
    val => {
      sshSetupResult.value = val;
      sshPassword.value = '';
      if (val?.success) {
        // Re-run preflight to verify SSH now works
        loadPreflight();
      }
    },
    err => { sshSetupResult.value = { success: false, message: err.message }; },
  );
  sshSetupBusy.value = false;
}

async function configureVault() {
  error.value = '';
  successMsg.value = '';
  configuring.value = true;
  configResult.value = null;

  const result = await rgwConfigureVault({
    cephHost: cephHost.value,
    vaultAddr: vaultAddr.value,
    vaultToken: vaultToken.value,
    providerId: selectedProviderId.value || undefined,
    secretEngine: secretEngine.value,
    vaultNamespace: vaultNamespace.value || undefined,
    sshUser: sshUser.value || undefined,
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

onMounted(() => {
  // Pre-fill ceph host from connection endpoint if available
  if (props.connectionHost) {
    cephHostInput.value = props.connectionHost;
  }
  // Load providers/policies immediately (don't need ceph host for that)
  Promise.all([loadProviders(), loadPolicies()]);
});
</script>
