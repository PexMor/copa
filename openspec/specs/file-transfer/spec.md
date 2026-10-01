# file-transfer Specification

## Purpose

Lets clients share files through the clipboard by uploading and downloading them directly to S3-compatible object storage using short-lived presigned URLs issued by the copa server, without exposing storage credentials or routing file bytes through the server.

## Requirements

### Requirement: File support is an opt-in configuration
File items SHALL be available only when the server configuration contains a storage section providing the object store's client-reachable base URL, bucket, region and credentials. A namespace SHALL be able to opt out with `files = false`. When files are unavailable for a namespace, every file endpoint SHALL respond 404 with a JSON error and no other behaviour SHALL change.

#### Scenario: Storage not configured
- **WHEN** the server starts without a storage section and a client calls `POST /api/files`
- **THEN** the server responds 404 with `{"error":"files not enabled"}`

#### Scenario: Namespace opted out
- **WHEN** storage is configured and namespace `shared` sets `files = false`
- **THEN** file endpoints respond 404 for `shared` and work for other namespaces

#### Scenario: Incomplete storage configuration
- **WHEN** the storage section is present but lacks the base URL, bucket or credentials
- **THEN** the server refuses to start and prints which key is missing

### Requirement: Storage credentials stay on the server
The storage secret key SHALL be readable from configuration or from the `COPA_S3_SECRET_ACCESS_KEY` environment variable (environment taking precedence). The server SHALL NOT send storage credentials to any client and SHALL NOT write credentials, bearer tokens or presigned URLs to its log output.

#### Scenario: Secret from environment
- **WHEN** `COPA_S3_SECRET_ACCESS_KEY` is set and the config file omits `secret_access_key`
- **THEN** the server starts with files enabled

#### Scenario: Presigned URL not logged
- **WHEN** the server issues an upload or download URL
- **THEN** the corresponding log line contains the namespace and item id but not the URL or its signature

### Requirement: Request an upload
The server SHALL expose `POST /api/files` to clients with write permission. The JSON request SHALL declare `name`, `size` and optionally `content_type`. The response SHALL contain the new item `id`, an `upload_url`, the HTTP `method`, the exact `headers` the client must send, and `expires_at` of the URL. The URL SHALL permit uploading only that one object, and SHALL expire after the configured presign lifetime (default 300 s).

#### Scenario: Upload granted
- **WHEN** a writer posts `{"name":"report.pdf","size":1048576,"content_type":"application/pdf"}`
- **THEN** the server responds 200 with an id, a presigned upload URL, method `PUT`, required headers and an expiry

#### Scenario: Read-only token cannot upload
- **WHEN** a client holding only a read token calls `POST /api/files`
- **THEN** the server responds 401

#### Scenario: Token in query string rejected
- **WHEN** a client calls a file endpoint with the token only in a `?token=` query parameter
- **THEN** the server responds 401

### Requirement: Upload size is declared and enforced
The server SHALL reject an upload request whose declared `size` is zero, exceeds the namespace `max_file_size` (default 50 MiB), or would push the namespace's stored and pending file bytes above `file_quota_bytes` (default 500 MiB). The presigned upload SHALL be bound to the declared size so that the object store rejects a body of a different length.

#### Scenario: File too large
- **WHEN** a writer declares a size above `max_file_size`
- **THEN** the server responds 413 and issues no URL

#### Scenario: Quota exceeded
- **WHEN** a writer declares a size that would exceed `file_quota_bytes` for the namespace
- **THEN** the server responds 507 and issues no URL

#### Scenario: Body larger than declared
- **WHEN** a client uses an upload URL issued for 1000 bytes to send 2000 bytes
- **THEN** the object store rejects the upload and no file item appears in the history

### Requirement: Upload must be completed to become visible
A requested upload SHALL remain pending and invisible in history until the client calls `POST /api/files/{id}/complete`. On completion the server SHALL verify with the object store that the object exists and its size equals the declared size, then add the `file` item to the namespace history and emit `item_added`. A failed verification SHALL delete the object and respond 409.

#### Scenario: Successful completion
- **WHEN** a client uploads the bytes and calls complete
- **THEN** the server responds 200 with the item metadata and the item appears in `GET /api/history`

#### Scenario: Complete without upload
- **WHEN** a client calls complete without having uploaded the object
- **THEN** the server responds 409 and no item appears

#### Scenario: Abandoned upload
- **WHEN** an upload is requested but not completed within the presign lifetime plus 60 seconds
- **THEN** the pending upload is discarded, any uploaded object is deleted, and its bytes no longer count against the quota

### Requirement: Request a download
The server SHALL expose `GET /api/files/{id}` to clients with read permission, returning JSON with a presigned `download_url`, `name`, `size`, `content_type` and the URL's `expires_at`. The URL lifetime SHALL be the lesser of the presign lifetime and the item's remaining time to expiry.

#### Scenario: Download granted
- **WHEN** a reader requests `GET /api/files/{id}` for an unexpired file item
- **THEN** the server responds 200 with a presigned URL from which the exact uploaded bytes can be fetched

#### Scenario: URL does not outlive the item
- **WHEN** a file item expires in 30 seconds and the presign lifetime is 300 seconds
- **THEN** the issued download URL expires in at most 30 seconds

#### Scenario: Write-only token cannot download
- **WHEN** a client holding only a write token calls `GET /api/files/{id}`
- **THEN** the server responds 401

### Requirement: Stored objects are safe to serve
Object keys SHALL be derived from server-generated random ids and SHALL NOT contain the client-supplied file name. File names SHALL be sanitized (path separators and control characters removed, length limited to 255 bytes) before being stored or returned. Objects SHALL be served with a generic binary content type and an attachment content disposition so that browsers download rather than render them.

#### Scenario: Path traversal in name
- **WHEN** a client declares the name `../../etc/passwd`
- **THEN** the stored and returned name contains no path separator and the object key is unaffected by the name

#### Scenario: HTML file is not rendered
- **WHEN** an uploaded `.html` file is opened via its download URL in a browser
- **THEN** the response carries `Content-Disposition: attachment` and a non-HTML content type

### Requirement: No stored object outlives its item
The server SHALL delete the stored object whenever its file item is removed for any reason (expiry, eviction, explicit deletion). Failed deletions SHALL be retried. The server SHALL periodically, and at startup, remove objects under its configured key prefix that do not correspond to a current item or pending upload.

#### Scenario: Object removed after expiry
- **WHEN** a file item expires
- **THEN** a request to the object store for its key returns not-found within 60 seconds, assuming the store is reachable

#### Scenario: Store temporarily unreachable
- **WHEN** deleting an object fails because the store is unreachable
- **THEN** the item is still removed from history and the deletion is retried until it succeeds

#### Scenario: Orphans after restart
- **WHEN** the server restarts while objects exist under its key prefix
- **THEN** those objects are deleted during startup reconciliation

### Requirement: Presigned URLs work behind a reverse proxy
Presigned URLs SHALL be generated against the configured client-reachable base URL using path-style addressing, so that a single public hostname suffices. The server SHALL support a separate internal endpoint for its own storage calls. The server SHALL warn at startup when the client-reachable base URL is plain `http` on a non-loopback host.

#### Scenario: Public and internal endpoints differ
- **WHEN** the base URL is `https://s3.example.com` and the internal endpoint is `http://127.0.0.1:3900`
- **THEN** URLs handed to clients start with `https://s3.example.com/` and the server's own verification and deletion calls go to `127.0.0.1:3900`

#### Scenario: Insecure public base URL
- **WHEN** the base URL is `http://files.example.com`
- **THEN** the server logs a warning that presigned URLs will travel unencrypted
