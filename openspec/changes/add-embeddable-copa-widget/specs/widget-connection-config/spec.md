# Spec Delta

## Purpose

Defines the JSON configuration file that tells the embeddable widget which copa endpoints to use and how to authenticate or pair with each of them.

## ADDED Requirements

### Requirement: JSON configuration document
The widget SHALL be configured by a JSON document, supplied as a URL, an object, or a file, with a top-level `version`, an `endpoints` array, an optional `defaultEndpoint` and optional UI settings. Each endpoint SHALL declare `id`, `url`, optional `namespace` (default `default`) and exactly one `auth` object.

#### Scenario: Minimal config
- **WHEN** the document has one endpoint with `url` and `auth: { "method": "static-token", "token": "..." }`
- **THEN** the widget connects to that endpoint's `default` namespace

#### Scenario: Multiple endpoints
- **WHEN** the document lists two endpoints
- **THEN** the user can switch between them and the choice is remembered per browser

### Requirement: Supported authentication methods
The `auth.method` field SHALL accept `static-token`, `oauth2` and `pairing`. `static-token` takes `token` or `tokenFrom`; `oauth2` takes `tokenService` (a base URL, or explicit `loginUrl`, `tokenUrl`, `refreshUrl`, `logoutUrl`), optional `audience`, `popup` and `persist` (`memory`, `session`, `local`); `pairing` takes `protocol` (`spake2` or `ecdh`) and optional `ttlHint`. An unknown method or a missing required parameter SHALL be a configuration error.

#### Scenario: No provider secrets in widget config
- **WHEN** an `oauth2` endpoint includes a `clientSecret` or `clientId` key
- **THEN** the widget rejects the endpoint and explains that identity-provider settings belong to the token service

#### Scenario: Unknown method
- **WHEN** an endpoint declares `auth.method` equal to `"kerberos"`
- **THEN** the widget refuses that endpoint and reports which field is invalid

#### Scenario: Missing token service
- **WHEN** an `oauth2` endpoint lacks `tokenService`
- **THEN** the widget reports the missing key and does not start a login

#### Scenario: Insecure token service URL
- **WHEN** the token service URL is `http` and not a loopback address
- **THEN** the widget rejects the endpoint

### Requirement: Validation before use
The widget SHALL validate the configuration against a published JSON Schema before any network request to an endpoint, SHALL ignore unknown optional keys with a console warning, and SHALL reject documents with a newer major `version` than it supports. Endpoint URLs MUST use `https`, except for loopback addresses.

#### Scenario: Insecure URL
- **WHEN** an endpoint URL is `http://copa.example.com`
- **THEN** the widget rejects the endpoint with an explanatory error

#### Scenario: Loopback allowed
- **WHEN** an endpoint URL is `http://127.0.0.1:8080`
- **THEN** the endpoint is accepted

#### Scenario: Newer version
- **WHEN** the document declares a major version the widget does not support
- **THEN** the widget shows an upgrade-needed error and makes no requests

### Requirement: Secrets handling
Static tokens placed in the configuration SHALL be documented as visible to anyone who can load the page. The widget SHALL support `tokenFrom` (host-provided function or named storage key) so the host can supply credentials at run time, and SHALL NOT write tokens, refresh tokens or pairing secrets to logs, URLs or query strings. Issued time-limited credentials SHALL be stored only in memory unless the configuration opts in to `session` or `local` persistence.

#### Scenario: Host-provided token
- **WHEN** an endpoint uses `tokenFrom` and the host registers a token provider
- **THEN** the widget obtains the token from the provider on demand and never persists it

#### Scenario: No token in URL
- **WHEN** the widget calls any API
- **THEN** the credential is sent only in the `Authorization` header

### Requirement: Config load failures are visible
When the configuration cannot be fetched or parsed, the widget SHALL render an error state naming the cause (network, HTTP status, JSON syntax, schema violation) and SHALL emit `onError`.

#### Scenario: Syntax error
- **WHEN** the config file is not valid JSON
- **THEN** the widget shows a JSON error and emits `onError` with the cause
