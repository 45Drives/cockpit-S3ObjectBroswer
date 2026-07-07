# Encryption User Guide — Cockpit S3 Browser

This guide covers how to configure and use server-side encryption (SSE) in the Cockpit S3 Browser plugin to protect data at rest.

## Overview

The S3 Browser supports two types of server-side encryption:

| Type | Algorithm value | Description |
|------|----------------|-------------|
| **SSE-S3** | `AES256` | Amazon S3-managed keys. Objects are encrypted with AES-256. No additional key management required. |
| **SSE-KMS** | `aws:kms` | Key Management Service encryption. Uses a KMS key (e.g. from HashiCorp Vault via the Encryption Manager) to encrypt objects. Offers more control and auditability. |

Encryption can be configured at two levels:

1. **Connection level** — a default applied to all uploads through a given connection.
2. **Bucket level** — a default applied to all new objects in a specific bucket.

Bucket-level settings take priority over connection-level defaults.

---

## 1. Setting Connection-Level Default Encryption

When creating or editing an S3 endpoint connection, you can specify a default encryption algorithm that will automatically apply to every upload made through that connection.

1. Open the **S3 Browser** in Cockpit.
2. Click **Add Connection** (or edit an existing connection).
3. Scroll to the **Default Encryption** section.
4. Under **Algorithm**, choose one of:
   - **None** — no default encryption.
   - **SSE-S3 (AES256)** — S3-managed encryption.
   - **SSE-KMS** — KMS-managed encryption.
5. If you selected **SSE-KMS**, a **KMS Key / Policy** field appears:
   - If the **Encryption Manager** is installed and key policies are configured, a dropdown will list available policies. Select the appropriate policy.
   - Otherwise, manually enter your KMS key ID or alias in the text field.
6. Click **Save** to save the connection.

All future uploads through this connection will use the selected encryption unless the destination bucket has its own encryption configured (which takes priority).

---

## 2. Setting Bucket-Level Encryption

Bucket-level encryption ensures every new object written to that bucket is encrypted by default, regardless of the connection settings.

### Enable Encryption on a Bucket

1. Navigate to the **Buckets** view.
2. Find the bucket you want to encrypt in the table.
3. Click the **⋮** (three-dot menu) in the **Actions** column.
4. Click **Set Encryption**.
5. In the modal that appears:
   - **Algorithm**: Choose **AES-256 (SSE-S3)** or **SSE-KMS**.
   - If you chose **SSE-KMS**:
     - **KMS Key / Policy**: Select a policy from the Encryption Manager dropdown, or enter a KMS key ID manually if the Encryption Manager is not available.
     - **Enable S3 Bucket Key**: Check this box to reduce the number of KMS API calls by generating a single bucket-level encryption key. This is recommended for high-throughput buckets.
6. Click **Apply**.

The bucket table will update to show a green **🔒 AES256** or **🔒 aws:kms** badge in the Encryption column.

### Remove Encryption from a Bucket

1. In the **Buckets** view, click the **⋮** menu for the encrypted bucket.
2. Click **Remove Encryption**.
3. A confirmation dialog will appear warning that:
   - Existing encrypted objects **remain encrypted**.
   - New objects will **no longer** be automatically encrypted by default.
4. Click **Remove** to confirm.

---

## 3. Viewing Encryption Status

### Bucket List

The **Buckets** view shows an **Encryption** column for each bucket:

- **🔒 AES256** or **🔒 aws:kms** (green badge) — bucket has default encryption enabled.
- **🔓 None** (gray badge) — no default encryption configured.

### Objects View Header

When you open a bucket, the header bar displays the bucket's encryption status:

- A green **SSE-KMS** or **SSE-S3** badge showing the algorithm and KMS key ID (if applicable).
- A gray **No Encryption** badge if the bucket is unencrypted.

### Individual Object Details

Select any file and open the **Details** side panel. The **Encryption** section shows:

- **Algorithm** — `AES256` (blue badge) or `aws:kms` (green badge).
- **KMS Key ID** — the key used to encrypt the object (only shown for SSE-KMS).
- **Bucket Key** — whether S3 Bucket Key optimization is Enabled or Disabled.

If the object is not encrypted, the section simply displays "None".

---

## 4. Verifying Encryption

If the **Encryption Manager** (control plane) is installed, additional verification actions become available in the bucket's **⋮** menu:

### Verify Encryption

- Available for any encrypted bucket.
- Checks that the bucket's encryption configuration is correctly applied and readable.

### Deep Verify (Round-trip)

- Available for **SSE-KMS** encrypted buckets only.
- Performs a full round-trip test: writes a test object → reads its metadata → downloads it → deletes it.
- Confirms that the KMS key is accessible and encryption/decryption works end-to-end.

---

## 5. How Encryption is Applied to Operations

Once encryption is configured (at the bucket or connection level), the S3 Browser **automatically** injects the appropriate SSE parameters into the following operations:

| Operation | SSE applied? |
|-----------|-------------|
| File upload | ✅ |
| Folder creation | ✅ |
| Copy object | ✅ |
| Copy folder (prefix) | ✅ |
| Move / rename object | ✅ |
| Move folder (prefix) | ✅ |
| Change storage class | ✅ |
| Download | N/A (decryption is handled server-side) |
| Delete | N/A |

You do **not** need to manually specify encryption for each operation — the plugin handles it automatically based on the bucket and connection configuration.

### Priority Order

When determining which encryption settings to use, the plugin follows this priority:

1. **Bucket encryption config** — if the bucket has default encryption set, use that.
2. **Connection default encryption** — if the bucket has no encryption configured, fall back to the connection-level default.
3. **No encryption** — if neither is configured, objects are uploaded without server-side encryption.

If a bucket is configured for SSE-KMS but no KMS Key ID is set at the bucket level, the plugin will use the KMS Key ID from the connection-level default (if one is configured).

---

## 6. Encryption Manager Integration

The S3 Browser integrates with the **45Drives Encryption Manager** for KMS key management. When the Encryption Manager is installed:

- KMS key policies are automatically populated in dropdown menus (both in the connection editor and the Set Encryption modal).
- Each policy displays its **name**, **provider**, and **algorithm** for easy identification.
- The **Verify Encryption** and **Deep Verify (Round-trip)** actions become available.

If the Encryption Manager is **not** installed:

- KMS key fields fall back to a free-text input where you can enter the key ID or alias manually.
- Verification actions are hidden from the bucket menu.

To access the Encryption Manager directly, look for the **Encryption Manager** link in the bucket actions menu or in error messages when KMS is not yet configured.

---

## Frequently Asked Questions

**Q: Does enabling bucket encryption retroactively encrypt existing objects?**
No. Bucket default encryption only applies to **new** objects written after the configuration is set. Existing objects retain their original encryption status.

**Q: What happens when I remove bucket encryption?**
Existing encrypted objects **stay encrypted**. Only new objects will no longer be automatically encrypted. You can still upload encrypted objects by setting connection-level defaults or by re-enabling bucket encryption later.

**Q: Can I use SSE-KMS without the Encryption Manager?**
Yes. You can manually enter a KMS key ID in the text field. However, the Encryption Manager provides a more convenient experience with key policy dropdowns and encryption verification tools.

**Q: What is the S3 Bucket Key option?**
S3 Bucket Key is an optimization for SSE-KMS. Instead of calling KMS for every object, a single bucket-level data key is generated and reused. This reduces KMS API costs and improves upload throughput. It is recommended for buckets with frequent writes.

**Q: Which S3 backends are supported?**
The plugin supports Ceph RGW, RustFS, MinIO, and generic S3-compatible backends. Note that some features (e.g., S3 Bucket Key) may not be supported by all backends — the plugin handles these gracefully.
