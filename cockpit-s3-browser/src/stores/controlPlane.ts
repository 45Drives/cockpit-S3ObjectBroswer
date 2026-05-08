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
  verifyRoundtrip as cpVerifyRoundtrip,
  getTargetByBucketName,
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

  async function resolveTargetId(bucket: string, backendType: BackendType): Promise<string | undefined> {
    const targetResult = await getTargetByBucketName(bucket, backendType);
    let targetId: string | undefined;
    targetResult.match(
      (target) => { targetId = target?.id; },
      () => { /* ignore lookup failures */ }
    );
    return targetId;
  }

  async function setBucketEncryptionAction(
    bucket: string,
    algorithm: "AES256" | "aws:kms",
    backendType: BackendType,
    kmsKeyId?: string,
    endpoint?: string,
    connectionName?: string
  ): Promise<{ success: boolean; message?: string }> {
    const targetId = await resolveTargetId(bucket, backendType);
    const result = await cpSetBucketEncryption(bucket, algorithm, backendType, kmsKeyId, targetId, endpoint, connectionName);
    let outcome: { success: boolean; message?: string } = { success: false, message: "Control plane unavailable" };
    result.match(
      (val) => {
        outcome = val ?? { success: false, message: "Not supported for this backend" };
        clearBucketCache(bucket);
      },
      (err) => { outcome = { success: false, message: String(err) }; }
    );
    if (!outcome.success) return outcome;

    // For SSE-KMS, verify RustFS can actually use the key with a roundtrip test
    if (algorithm === "aws:kms") {
      const rtResult = await cpVerifyRoundtrip(bucket, kmsKeyId);
      let roundtripOk = false;
      let roundtripError = "";
      rtResult.match(
        (val) => {
          if (val && val.roundtripVerified) {
            roundtripOk = true;
          } else {
            roundtripError = val?.error || "Roundtrip encryption test failed — the S3 backend cannot use this key.";
          }
        },
        (err) => { roundtripError = String(err); }
      );
      if (!roundtripOk) {
        // Roll back: remove the encryption config we just set
        await cpRemoveBucketEncryption(bucket, backendType, targetId, endpoint, connectionName);
        clearBucketCache(bucket);
        return { success: false, message: roundtripError };
      }
    }

    return outcome;
  }

  async function removeBucketEncryptionAction(
    bucket: string,
    backendType: BackendType,
    endpoint?: string,
    connectionName?: string
  ): Promise<{ success: boolean; message?: string }> {
    const targetId = await resolveTargetId(bucket, backendType);
    const result = await cpRemoveBucketEncryption(bucket, backendType, targetId, endpoint, connectionName);
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
    backendType: BackendType,
    endpoint?: string,
    connectionName?: string
  ): Promise<{ success: boolean; message?: string }> {
    const targetId = await resolveTargetId(bucket, backendType);
    const result = await cpVerifyBucketEncryption(bucket, backendType, targetId, endpoint, connectionName);
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
