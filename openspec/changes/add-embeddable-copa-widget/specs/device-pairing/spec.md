# Spec Delta

## Purpose

Lets a new browser or device gain clipboard access by pairing with a copa server through a password-authenticated (SPAKE2) or ECC key exchange, without pre-shared long-lived tokens, and receive a time-limited revocable credential.

## ADDED Requirements

### Requirement: Pairing is opt-in and operator initiated
Pairing SHALL be available only when enabled in the server configuration. An operator or an already authorized client SHALL be able to open a pairing window for a namespace and permission, producing a short one-time code and an expiry (default 120 s). Without an open window, pairing requests SHALL be refused.

#### Scenario: Pairing disabled
- **WHEN** a client calls a pairing endpoint on a server with pairing disabled
- **THEN** the server responds 404

#### Scenario: Window opened
- **WHEN** an authorized user opens a pairing window for namespace `team` with read-write permission
- **THEN** the server returns a one-time code, its expiry and the granted scope

#### Scenario: Window expired
- **WHEN** a device attempts to pair after the window expiry
- **THEN** the server refuses and the code cannot be reused

### Requirement: SPAKE2 pairing with a short code
With `protocol: spake2` the widget and server SHALL run a SPAKE2 exchange using the short code as the password, derive a shared key, and confirm key possession in both directions before any credential is issued. The code SHALL never be sent over the network. A window SHALL allow at most five failed attempts before it is closed.

#### Scenario: Correct code
- **WHEN** the user enters the code displayed by the operator
- **THEN** both sides derive the same key, confirmation succeeds and the device receives a credential

#### Scenario: Wrong code
- **WHEN** the user enters an incorrect code
- **THEN** confirmation fails, no credential is issued and the failure counts toward the attempt limit

#### Scenario: Attempt limit
- **WHEN** five attempts have failed in one window
- **THEN** the window is closed and a new one must be opened

### Requirement: ECC key-exchange pairing with confirmation
With `protocol: ecdh` the widget SHALL generate an ephemeral key pair in the browser, exchange public keys with the server, derive a shared key with a key-derivation function, and display a short fingerprint of the transcript on both sides. Credentials SHALL be issued only after the operator confirms the fingerprints match, or scans the widget's QR code containing its public key.

#### Scenario: Fingerprints match
- **WHEN** the operator confirms that both displays show the same fingerprint
- **THEN** the server issues a credential to that device

#### Scenario: Operator rejects
- **WHEN** the operator rejects the pending request
- **THEN** no credential is issued and the device is told the request was denied

#### Scenario: Man in the middle
- **WHEN** an attacker substitutes a public key so the fingerprints differ
- **THEN** the operator sees a mismatch and no credential is issued

### Requirement: Time-limited, revocable device credential
A successful pairing SHALL yield a credential bound to the namespace and permission of the window, with an expiry (configurable, default 24 h) and a device identifier. The credential SHALL be usable as a bearer token on all authorized endpoints, SHALL be stored by the server only as a hash or as a verifiable signature, and SHALL be revocable by the operator without affecting other devices. Renewal SHALL require a new pairing unless the server is configured to allow sliding renewal.

#### Scenario: Use credential
- **WHEN** the paired widget sends the credential in the `Authorization` header
- **THEN** requests are authorized with the paired scope

#### Scenario: Expiry
- **WHEN** the credential expires
- **THEN** the server responds 401 and the widget returns to the unpaired state, offering to pair again

#### Scenario: Revocation
- **WHEN** the operator revokes a device
- **THEN** that device's next request is refused and other devices keep working

#### Scenario: Restart
- **WHEN** the server restarts
- **THEN** still-valid device credentials remain valid and open pairing windows are discarded

### Requirement: Pairing endpoints resist abuse
The pairing endpoints SHALL rate-limit by source, SHALL bound request sizes and pending sessions, SHALL NOT reveal whether a code exists, and SHALL log events without secrets, codes or keys.

#### Scenario: Flood of requests
- **WHEN** a source exceeds the rate limit on pairing requests
- **THEN** the server responds 429 and open windows are unaffected

#### Scenario: Logs
- **WHEN** a pairing succeeds or fails
- **THEN** the log records the namespace, device id and outcome but no code, key or credential
