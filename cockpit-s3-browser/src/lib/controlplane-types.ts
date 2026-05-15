/**
 * Lightweight TypeScript types for the cockpit-storage-encryption control plane.
 * Minimal interfaces needed by the S3 browser — not the full controlplane.ts.
 */

/** S3 backend types supported for control plane routing */
export type BackendType = "rgw" | "minio" | "rustfs" | "generic";

/**
 * Resolve backend type from the connection config.
 * Returns the explicitly configured type, or "generic" when set to "auto" / unset.
 * Heuristic guessing (name, port, endpoint) was removed because it is unreliable —
 * users should select the correct backend type in the connection setup form.
 */
export function resolveBackendType(backendType?: string): BackendType {
  if (backendType && backendType !== "auto") return backendType as BackendType;
  return "generic";
}

/** KMS provider summary */
export interface ProviderSummary {
  id: string;
  name: string;
  type: string; // 'qxvault' | 'qxhsm' | 'mock'
  url: string;
  status?: string;
}

/** Key policy summary */
export interface PolicySummary {
  id: string;
  name: string;
  algorithm: string;
  transit_key_name: string;
  provider_id: string;
  key_engine?: string;
  rotation_interval_days: number | null;
}

/** Storage target as returned by the control plane */
export interface StorageTarget {
  id: string;
  type: string;
  identifier: string;
  display_name: string;
  hostname: string;
  governance_state: string;
  metadata_json: string | null;
  discovered_at: string;
  updated_at: string;
}

/** Policy binding summary */
export interface PolicyBinding {
  id: string;
  policy_id: string;
  policy_name: string;
  target_id: string;
  state: string;
  encryption_state: string;
  dek_key_version: number | null;
  apply_method: string | null;
  bound_by: string;
  bound_at: string;
  last_verified: string | null;
}

/** FIPS status of the host */
export interface HostFipsStatus {
  fipsEnabled: boolean;
  fipsMode: string;
  kernelFips: boolean;
}

/** Bucket encryption configuration from control plane or direct S3 query */
export interface BucketEncryptionConfig {
  encrypted: boolean;
  algorithm?: "AES256" | "aws:kms" | null;
  kmsKeyId?: string | null;
  bucketKeyEnabled?: boolean | null;
}

/** Result of a control plane write action */
export interface ActionResult {
  success: boolean;
  message?: string;
}

/** Result of a binding sync operation */
export interface BindingSyncResult {
  synced: number;
  errors: number;
  details?: string[];
}
