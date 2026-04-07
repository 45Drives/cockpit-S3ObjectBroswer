import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  BackendType,
  BucketEncryptionConfig,
  ProviderSummary,
  PolicySummary,
  HostFipsStatus,
} from "../lib/controlplane-types";
import {
  isControlPlaneAvailable,
  listProviders,
  listPolicies,
  getHostFipsStatus,
  getBucketEncryption,
  setBucketEncryption as cpSetBucketEncryption,
  removeBucketEncryption as cpRemoveBucketEncryption,
  verifyBucketEncryption as cpVerifyBucketEncryption,
  navigateToEncryptionManager,
} from "../lib/controlplane-client";

export const useControlPlaneStore = defineStore("controlPlane", () => {
  const available = ref<boolean | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const providers = ref<ProviderSummary[]>([]);
  const policies = ref<PolicySummary[]>([]);
  const fipsStatus = ref<HostFipsStatus | null>(null);
  const bucketEncryptionCache = ref<Map<string, BucketEncryptionConfig>>(new Map());

  // ─── Getters ────────────────────────────────────────────────────────────

  const isAvailable = computed(() => available.value === true);
  const primaryProvider = computed(() => providers.value[0] ?? null);
  const hasProviders = computed(() => providers.value.length > 0);

  // ─── Actions ────────────────────────────────────────────────────────────

  async function checkAvailability(): Promise<boolean> {
    const result = await isControlPlaneAvailable();
    // isControlPlaneAvailable never errors; always Ok
    result.map((v) => { available.value = v; });
    return available.value === true;
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;

    const isAvail = await checkAvailability();
    if (!isAvail) {
      loading.value = false;
      return;
    }

    const [provResult, polResult, fipsResult] = await Promise.all([
      listProviders(),
      listPolicies(),
      getHostFipsStatus(),
    ]);

    provResult.match(
      (val) => { providers.value = val ?? []; },
      (err) => { error.value = String(err); }
    );
    polResult.match(
      (val) => { policies.value = val ?? []; },
      (err) => { if (!error.value) error.value = String(err); }
    );
    fipsResult.match(
      (val) => { fipsStatus.value = val; },
      (err) => { if (!error.value) error.value = String(err); }
    );

    loading.value = false;
  }

  async function fetchBucketEncryption(
    bucketName: string,
    backendType: BackendType
  ): Promise<BucketEncryptionConfig | null> {
    const cached = bucketEncryptionCache.value.get(bucketName);
    if (cached) return cached;

    const result = await getBucketEncryption(bucketName, backendType);
    let config: BucketEncryptionConfig | null = null;
    result.match(
      (val) => {
        config = val;
        if (val) bucketEncryptionCache.value.set(bucketName, val);
      },
      () => { /* silently fail for individual bucket queries */ }
    );
    return config;
  }

  function clearBucketCache(bucketName?: string): void {
    if (bucketName) {
      bucketEncryptionCache.value.delete(bucketName);
    } else {
      bucketEncryptionCache.value.clear();
    }
  }

  async function setBucketEncryptionAction(
    bucket: string,
    algorithm: "AES256" | "aws:kms",
    backendType: BackendType,
    kmsKeyId?: string
  ): Promise<{ success: boolean; message?: string }> {
    const result = await cpSetBucketEncryption(bucket, algorithm, backendType, kmsKeyId);
    let outcome: { success: boolean; message?: string } = { success: false, message: "Control plane unavailable" };
    result.match(
      (val) => {
        outcome = val ?? { success: false, message: "Not supported for this backend" };
        clearBucketCache(bucket);
      },
      (err) => { outcome = { success: false, message: String(err) }; }
    );
    return outcome;
  }

  async function removeBucketEncryptionAction(
    bucket: string,
    backendType: BackendType
  ): Promise<{ success: boolean; message?: string }> {
    const result = await cpRemoveBucketEncryption(bucket, backendType);
    let outcome: { success: boolean; message?: string } = { success: false, message: "Control plane unavailable" };
    result.match(
      (val) => {
        outcome = val ?? { success: false, message: "Not supported for this backend" };
        clearBucketCache(bucket);
      },
      (err) => { outcome = { success: false, message: String(err) }; }
    );
    return outcome;
  }

  async function verifyBucketEncryptionAction(
    bucket: string,
    backendType: BackendType
  ): Promise<{ success: boolean; message?: string }> {
    const result = await cpVerifyBucketEncryption(bucket, backendType);
    let outcome: { success: boolean; message?: string } = { success: false, message: "Control plane unavailable" };
    result.match(
      (val) => { outcome = val ?? { success: false, message: "Not supported for this backend" }; },
      (err) => { outcome = { success: false, message: String(err) }; }
    );
    return outcome;
  }

  function goToEncryptionManager(targetId?: string, action?: string): void {
    navigateToEncryptionManager(targetId, action);
  }

  return {
    // State
    available,
    loading,
    error,
    providers,
    policies,
    fipsStatus,
    bucketEncryptionCache,
    // Getters
    isAvailable,
    primaryProvider,
    hasProviders,
    // Actions
    checkAvailability,
    refresh,
    fetchBucketEncryption,
    clearBucketCache,
    setBucketEncryptionAction,
    removeBucketEncryptionAction,
    verifyBucketEncryptionAction,
    goToEncryptionManager,
  };
});
