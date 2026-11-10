# Spec Delta

## Purpose

Lets users sign in through a central, external token service in a popup window and use the access tokens it issues to authenticate to a copa server, which only verifies tokens from issuers it trusts.

## ADDED Requirements

### Requirement: Popup sign-in against a token service
For `oauth2` endpoints the widget SHALL open the token service's login URL in a popup started directly from the user's click. The popup SHALL close itself when the login finishes or fails, and the widget SHALL report cancellation if the user closes it first. A blocked popup SHALL produce a message and an option to retry.

#### Scenario: Successful popup login
- **WHEN** the user clicks sign-in and completes the login in the popup
- **THEN** the popup closes and the widget reports an authenticated state

#### Scenario: User closes popup
- **WHEN** the user closes the popup before finishing
- **THEN** the widget returns to the signed-out state and reports a cancelled sign-in

#### Scenario: Popup blocked
- **WHEN** the browser blocks the popup
- **THEN** the widget tells the user and offers to retry

### Requirement: Token service contract
A token service SHALL offer a login URL, a token endpoint, a refresh endpoint and a logout endpoint, discoverable from a single base URL or configured individually. The widget SHALL send the intended audience (the copa server), its own origin and the S256 challenge of a secret it keeps. The token service SHALL be independent of any one copa server and MAY serve many applications.

#### Scenario: Discovery
- **WHEN** the configuration gives only the token service base URL
- **THEN** the widget reads the endpoint URLs from the service's discovery document

#### Scenario: Audience requested
- **WHEN** the widget starts a login for a copa server
- **THEN** the login request names that server's audience so the issued token is intended for it

### Requirement: Hand-off to the opener is bound and single use
The login result SHALL reach only the widget that started the login. The token service SHALL release tokens only to a request presenting the secret behind the challenge, in exchange for a single-use login code. Tokens SHALL NOT appear in URLs or in `postMessage` payloads.

#### Scenario: Code stolen or replayed
- **WHEN** a party without the widget's secret, or a second request, presents the login code
- **THEN** the token service refuses it

#### Scenario: Message to the opener only
- **WHEN** the popup finishes a login that was started by origin A
- **THEN** the login code is posted only to origin A and the widget accepts messages only from the token service's origin

#### Scenario: Opener link severed
- **WHEN** the identity provider's page cut the popup's `window.opener`
- **THEN** the widget obtains the login code by polling with its secret and the login still completes

### Requirement: Widget token lifecycle
The widget SHALL renew the access token before it expires, and once after a 401 response, using the refresh endpoint of the token service. When renewal fails the widget SHALL return to the signed-out state and emit an auth-change event. The widget SHALL keep tokens in memory by default and SHALL persist the refresh token in session or local storage only when the endpoint configuration asks for it. It SHALL never write tokens to logs or URLs.

#### Scenario: Silent renewal
- **WHEN** the access token has under 60 seconds left and the user acts
- **THEN** the widget renews it before sending the request and the user is not prompted

#### Scenario: Refresh token expired
- **WHEN** the token service rejects the refresh token
- **THEN** the widget shows the signed-out state and offers sign-in again

#### Scenario: Default storage
- **WHEN** the page is reloaded and persistence is not configured
- **THEN** the user is signed out and must sign in again

#### Scenario: Session persistence
- **WHEN** persistence is set to session and the tab is reloaded
- **THEN** the widget restores the session by refreshing the token

### Requirement: Sign-out
A sign-out SHALL clear the widget's tokens and ask the token service to end the session, so that the refresh token stops working.

#### Scenario: User signs out
- **WHEN** the user signs out in the widget
- **THEN** the tokens are cleared locally, the logout endpoint is called, and the widget is signed out

### Requirement: Server trusts configured issuers
copasrv SHALL accept a signed JWT in the `Authorization: Bearer` header only if it was issued by a configured trusted issuer: the signature MUST verify against that issuer's published keys, `iss` and `aud` MUST match the configuration, and the token MUST be within `exp` and `nbf` allowing a bounded clock skew. Keys SHALL be fetched from the issuer's key set URL and cached, refreshing on an unknown key id without allowing refresh floods. Static tokens SHALL keep working alongside.

#### Scenario: Valid token
- **WHEN** a request carries a correctly signed, unexpired token from a trusted issuer with the right audience
- **THEN** it is authorized according to the token's mapped permissions

#### Scenario: Expired, foreign or untrusted
- **WHEN** the token is expired, has another audience, comes from an unknown issuer, or is signed by an unknown key
- **THEN** the server responds 401 and logs the reason without logging the token

#### Scenario: Algorithm confusion
- **WHEN** a token uses `alg: none`, or an algorithm not allowed for that issuer
- **THEN** the server rejects it

#### Scenario: Several issuers
- **WHEN** two issuers are configured and each signs a valid token
- **THEN** both tokens are accepted according to their own mappings

#### Scenario: Static token still works
- **WHEN** a client presents a configured static token while issuers are configured
- **THEN** the request is authorized as before

#### Scenario: Key set unavailable
- **WHEN** the issuer's key set cannot be fetched but keys are cached
- **THEN** tokens signed by cached keys keep working

### Requirement: Claims map to namespaces and permissions
The server configuration SHALL map token claims (such as scope, group, role, email or subject) per issuer to a namespace and read, write or read-write access. A valid token with no mapping for the requested namespace SHALL be refused with 403, and clipboard, history, file and ticket endpoints SHALL apply the same checks as for static tokens.

#### Scenario: Reader group
- **WHEN** the token's group claim maps to read access on namespace `team`
- **THEN** the holder can read but a write request is refused

#### Scenario: Scope claim
- **WHEN** the token carries the scope `copa:team:rw`
- **THEN** the holder has read-write access to namespace `team`

#### Scenario: Unmapped namespace
- **WHEN** a valid token requests a namespace it has no mapping for
- **THEN** the server responds 403

### Requirement: Event stream accepts the same credentials
The live event connection SHALL authenticate without placing the access token in the URL, by means of a single-use short-lived ticket obtained with the bearer token, and SHALL be closed by the server when the access token expires.

#### Scenario: Ticket used once
- **WHEN** a ticket is presented twice or after 30 seconds
- **THEN** the server refuses it

#### Scenario: Token expires on open stream
- **WHEN** the access token expires while the event stream is open
- **THEN** the server closes the stream and the widget reconnects with a renewed token
