/**
 * Control Plane IPC Bridge for cockpit-S3ObjectBrowser.
 *
 * Communicates with cockpit-storage-encryption's api_service.py backend via
 * cockpit.spawn() + JSON-RPC on stdin. Uses neverthrow ResultAsync to match
 * the S3 browser's error handling pattern.
 *
 * All functions gracefully return err() when the control plane is not installed.
 */
import { okAsync, ResultAsync } from "neverthrow";
import type {
  BackendType,
  ProviderSummary,
  PolicySummary,
  StorageTarget,
  PolicyBinding,
  HostFipsStatus,
  BucketEncryptionConfig,
  ActionResult,
} from "./controlplane-types";

const API_SERVICE_PATH = "/opt/45drives/controlplane/api_service.py";

// ─── Availability ───────────────────────────────────────────────────────────

let _availabilityCache: boolean | null = null;

/**
 * Check whether the cockpit-storage-encryption control plane is installed.
 * Result is cached for the session.
 */
export function isControlPlaneAvailable(): ResultAsync<boolean, never> {
  if (_availabilityCache !== null) return okAsync(_availabilityCache);
  return ResultAsync.fromSafePromise(
    new Promise<boolean>((resolve) => {
      try {
        const handle = cockpit.file(API_SERVICE_PATH, { superuser: "try" });
        handle
          .read()
          .then((content: string | null) => {
            handle.close();
            _availabilityCache = content != null && content.length > 0;
            resolve(_availabilityCache);
          })
          .catch(() => {
            _availabilityCache = false;
            resolve(false);
          });
      } catch {
        _availabilityCache = false;
        resolve(false);
      }
    })
  );
}

/** Reset the cached availability (e.g. after install/removal). */
export function resetAvailabilityCache(): void {
  _availabilityCache = null;
}

// ─── Low-level transport ────────────────────────────────────────────────────

type RpcResponse<T> = { result: T; error?: never } | { error: { code: string; message: string }; result?: never };

/**
 * Call the control plane backend via JSON-RPC over cockpit.spawn stdin.
 * Uses cockpit.spawn directly because server.execute does not support piping stdin.
 */
function rpc<T>(method: string, params: Record<string, unknown> = {}): ResultAsync<T, Error> {
  return ResultAsync.fromPromise(
    new Promise<T>((resolve, reject) => {
      try {
        const proc = cockpit.spawn(
          ["python3", API_SERVICE_PATH],
          { superuser: "try", err: "message" }
        );
        proc.input(JSON.stringify({ method, params }));
        proc
          .then((stdout: string) => {
            try {
              const resp: RpcResponse<T> = JSON.parse(stdout);
              if (resp.error) {
                const msg = resp.error.message ?? JSON.stringify(resp.error);
                reject(new Error(msg));
              } else {
                resolve(resp.result as T);
              }
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          })
          .catch((err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }),
    (e) => (e instanceof Error ? e : new Error(String(e)))
  );
}

/**
 * Guard wrapper — returns null if unavailable, otherwise calls fn.
 */
function guarded<T>(fn: () => ResultAsync<T, Error>): ResultAsync<T | null, Error> {
  return isControlPlaneAvailable().andThen((available) => {
    if (!available) return okAsync(null);
    return fn();
  });
}

// ─── Provider queries ───────────────────────────────────────────────────────

export function listProviders(): ResultAsync<ProviderSummary[] | null, Error> {
  return guarded(() => rpc<ProviderSummary[]>("providers.list"));
}

// ─── Policy queries ─────────────────────────────────────────────────────────

export function listPolicies(): ResultAsync<PolicySummary[] | null, Error> {
  return guarded(() => rpc<PolicySummary[]>("policies.list"));
}

// ─── Target queries ─────────────────────────────────────────────────────────

export function listBucketTargets(backendType: BackendType): ResultAsync<StorageTarget[] | null, Error> {
  return guarded((): ResultAsync<StorageTarget[], Error> =>
    rpc<any>("targets.list").map((raw) => {
      const all: StorageTarget[] = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const typeMap: Record<string, string> = {
        rgw: "ceph_rgw_bucket",
        minio: "minio_bucket",
        rustfs: "s3_bucket",
        generic: "s3_bucket",
      };
      const targetType = typeMap[backendType];
      if (!targetType) return all;
      return all.filter((t) => t.type === targetType);
    })
  );
}

export function getTargetByBucketName(
  bucketName: string,
  backendType: BackendType
): ResultAsync<StorageTarget | null, Error> {
  return listBucketTargets(backendType).map((targets) => {
    if (!targets) return null;
    return targets.find((t) => t.identifier === bucketName) ?? null;
  });
}

// ─── Binding queries ────────────────────────────────────────────────────────

export function listBindings(): ResultAsync<PolicyBinding[] | null, Error> {
  return guarded(() => rpc<PolicyBinding[]>("bindings.list"));
}

export function getBindingForTarget(targetId: string): ResultAsync<PolicyBinding | null, Error> {
  return listBindings().map((bindings) => {
    if (!bindings) return null;
    return bindings.find((b) => b.target_id === targetId && b.state !== "unbound") ?? null;
  });
}

// ─── FIPS status ────────────────────────────────────────────────────────────

export function getHostFipsStatus(): ResultAsync<HostFipsStatus | null, Error> {
  return guarded(() => rpc<HostFipsStatus>("host.fipsStatus"));
}

// ─── Bucket encryption queries ──────────────────────────────────────────────

export function getBucketEncryption(
  bucket: string,
  backendType: BackendType,
  targetId?: string
): ResultAsync<BucketEncryptionConfig | null, Error> {
  const methodMap: Partial<Record<BackendType, string>> = {
    rgw: "ceph.rgwGetBucketEncryption",
    minio: "minio.getBucketEncryption",
    rustfs: "s3.getBucketEncryption",
    generic: "s3.getBucketEncryption",
  };
  const method = methodMap[backendType];
  if (!method) return okAsync(null);

  const params: Record<string, unknown> = { bucket, bucketName: bucket };
  if (targetId) params.targetId = targetId;

  return guarded(() =>
    rpc<BucketEncryptionConfig>(method, params)
  );
}

// ─── Bucket encryption write actions ────────────────────────────────────────

export function setBucketEncryption(
  bucket: string,
  algorithm: "AES256" | "aws:kms",
  backendType: BackendType,
  kmsKeyId?: string,
  targetId?: string
): ResultAsync<ActionResult | null, Error> {
  const methodMap: Partial<Record<BackendType, string>> = {
    rgw: "ceph.rgwSetBucketEncryption",
    minio: "minio.setBucketEncryption",
    rustfs: "s3.setBucketEncryption",
    generic: "s3.setBucketEncryption",
  };
  const method = methodMap[backendType];
  if (!method) return okAsync(null);

  const params: Record<string, unknown> = { bucket, bucketName: bucket, algorithm };
  if (kmsKeyId) params.kmsKeyId = kmsKeyId;
  if (targetId) params.targetId = targetId;

  return guarded(() => rpc<ActionResult>(method, params));
}

export function removeBucketEncryption(
  bucket: string,
  backendType: BackendType,
  targetId?: string
): ResultAsync<ActionResult | null, Error> {
  const methodMap: Partial<Record<BackendType, string>> = {
    rgw: "ceph.rgwRemoveBucketEncryption",
    minio: "minio.removeBucketEncryption",
    rustfs: "s3.removeBucketEncryption",
    generic: "s3.removeBucketEncryption",
  };
  const method = methodMap[backendType];
  if (!method) return okAsync(null);

  const params: Record<string, unknown> = { bucket, bucketName: bucket };
  if (targetId) params.targetId = targetId;

  return guarded(() => rpc<ActionResult>(method, params));
}

export function verifyBucketEncryption(
  bucket: string,
  backendType: BackendType,
  targetId?: string
): ResultAsync<ActionResult | null, Error> {
  const methodMap: Partial<Record<BackendType, string>> = {
    rgw: "ceph.rgwVerifyBucket",
    minio: "minio.verify",
    rustfs: "s3.verifyBucket",
    generic: "s3.verifyBucket",
  };
  const method = methodMap[backendType];
  if (!method) return okAsync(null);

  const params: Record<string, unknown> = { bucket, bucketName: bucket };
  if (targetId) params.targetId = targetId;

  return guarded(() => rpc<ActionResult>(method, params));
}

// ─── Deep-link helpers ──────────────────────────────────────────────────────

// ─── RustFS / RGW KMS readiness ─────────────────────────────────────────────

export interface KmsPreflightResult {
  passed: boolean;
  checks: { name: string; passed: boolean; message: string; critical: boolean }[];
  // RustFS flat fields
  binaryFound?: boolean;
  serviceActive?: boolean;
  envFileExists?: boolean;
  kmsEnabled?: boolean;
  ready?: boolean;
  message?: string;
}

export interface RustfsKmsConfig {
  kmsEnabled: boolean;
  kmsBackend: string | null;
  vaultAddress: string | null;
  defaultKeyId: string | null;
}

/** Check KMS readiness for the given backend type */
export function kmsPreflight(
  backendType: BackendType,
  params: Record<string, unknown> = {}
): ResultAsync<KmsPreflightResult | null, Error> {
  const methodMap: Partial<Record<BackendType, string>> = {
    rgw: "s3.rgwPreflight",
    rustfs: "rustfs.preflight",
  };
  const method = methodMap[backendType];
  if (!method) return okAsync(null);
  return guarded(() => rpc<KmsPreflightResult>(method, params));
}

/** Get current RustFS KMS configuration */
export function rustfsGetConfig(): ResultAsync<RustfsKmsConfig | null, Error> {
  return guarded(() => rpc<RustfsKmsConfig>("rustfs.getConfig"));
}

// ─── Deep-link helpers ──────────────────────────────────────────────────────

const ENCRYPTION_MODULE_PATH = "/storage-encryption-test";

/** Build a deep-link URL to the cockpit-storage-encryption module */
export function encryptionManagerUrl(targetId?: string, action?: string): string {
  let url = `/cockpit/@localhost${ENCRYPTION_MODULE_PATH}/index.html`;
  const params: string[] = [];
  if (targetId) params.push(`target=${encodeURIComponent(targetId)}`);
  if (action) params.push(`action=${encodeURIComponent(action)}`);
  if (params.length > 0) url += "#" + params.join("&");
  return url;
}

/** Navigate to the encryption manager within the Cockpit shell */
export function navigateToEncryptionManager(targetId?: string, action?: string): void {
  const url = encryptionManagerUrl(targetId, action);
  if (window.top) {
    window.top.location.href = url;
  } else {
    window.location.href = url;
  }
}