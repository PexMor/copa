# Spec Delta

## Purpose

Provides a reference, dockerized S3-compatible backend (Garage) for testing and as a deployment template, and defines what a deployment must satisfy to expose copa file sharing to the internet through a reverse proxy safely.

## ADDED Requirements

### Requirement: Reference Garage backend
The repository SHALL contain a reference deployment that starts a single-node Garage object store with Docker Compose and bootstraps it for copa: a bucket, an access key granted read/write on that bucket only, and a bucket CORS policy permitting browser uploads and downloads from configured web app origins. Bootstrapping SHALL be repeatable without error and SHALL print or write the `[server.storage]` values to put into the copa config.

#### Scenario: First start
- **WHEN** an operator runs the documented start command on a machine with Docker
- **THEN** Garage is running, the bucket and key exist, and the operator is shown the storage settings for `config.toml`

#### Scenario: Re-run bootstrap
- **WHEN** the bootstrap is run a second time
- **THEN** it completes successfully without creating duplicate buckets or keys

#### Scenario: End-to-end with reference backend
- **WHEN** `copasrv` is configured with the printed settings and a file is put with `copacli put` and fetched with `copacli get`
- **THEN** the fetched file is byte-identical to the original

### Requirement: Reference deployment is secure by default
The reference deployment SHALL NOT contain committed secrets; secrets SHALL be generated locally into an untracked file. Published ports SHALL bind to loopback only by default, and only the S3 API port SHALL be published — Garage's admin and RPC ports SHALL NOT be. The bucket SHALL NOT allow anonymous access or website hosting. CORS allowed origins SHALL be an explicit list, not a wildcard, in the internet-facing example.

#### Scenario: No secrets in repository
- **WHEN** the repository is searched after generating local secrets
- **THEN** `git status` shows no tracked file containing the RPC secret, admin token or S3 secret key

#### Scenario: Anonymous request denied
- **WHEN** an unsigned request lists the bucket or fetches an object key
- **THEN** the object store responds with an access-denied error

#### Scenario: Admin API not reachable from the network
- **WHEN** another host attempts to connect to the Garage admin or RPC port
- **THEN** the connection fails

### Requirement: Reverse proxy examples
The reference deployment SHALL include working example configurations for Caddy, HAProxy and cloudflared that publish the copa server (including WebSocket endpoints) and the S3 API over HTTPS. Each example SHALL preserve the request host, path and query string toward the object store so presigned signatures validate, and SHALL allow request bodies up to the configured maximum file size.

#### Scenario: Upload through Caddy
- **WHEN** the Caddy example fronts Garage and a client uploads with a presigned URL for the public hostname
- **THEN** the upload succeeds and the object store accepts the signature

#### Scenario: WebSocket through the proxy
- **WHEN** a client connects to `/ws` and `/ws/events` through the proxy
- **THEN** both connections upgrade and deliver messages

### Requirement: Deployment documentation
The documentation SHALL describe how to enable file sharing, every storage and per-namespace option with its default, the upload/download flow, and a security checklist covering: HTTPS for both hostnames, keeping `copasrv` and Garage bound to loopback behind the proxy, bucket-scoped credentials, restricting CORS and `allowed_origins`, proxy body-size limits (including Cloudflare's), token rotation, one key prefix per copa instance, and adding a bucket lifecycle rule as a backstop for expiry.

#### Scenario: Operator follows the guide
- **WHEN** an operator follows the documented steps on a fresh host
- **THEN** file upload and download work from the web app and from `copacli` through the public hostnames

#### Scenario: Documented limits match behaviour
- **WHEN** the documented default `max_file_size`, `file_quota_bytes`, `item_ttl_secs` and presign lifetime are compared with a server started with no overrides
- **THEN** `GET /api/capabilities` and observed behaviour match the documented values
