## s3-browser 1.2.7-1

* Apply SSE encryption params (--sse, --sse-kms-key-id) to prefix copy/move operations
* Fix NotImplemented fallback (RGW SSE-KMS) to preserve encryption on re-upload
* Support SSE params in multipart copy for large objects
* Remove unused _bucket_default_sse helper function
* Add debian architecture to manifest.json