## ADDED Requirements

### Requirement: Protected networking waits for a confirmed session
The web app SHALL NOT start protected network activity (REST calls, `/ws` and `/ws/events` connections, version checks) against its own origin until a same-origin access probe has reported a valid session. Only a positive probe answer SHALL count as a valid session; an HTML body, a missing route answer other than the documented no-proxy case, or a thrown error SHALL NOT.

#### Scenario: Cached shell launches with a valid session
- **WHEN** the app starts and the probe confirms the session
- **THEN** the app renders and starts its networking exactly once

#### Scenario: No identity proxy in front of copa
- **WHEN** the probe route does not exist (the server answers 404)
- **THEN** the app treats the session as valid and starts normally

#### Scenario: Probe cannot complete
- **WHEN** the probe fails because the device is offline or the server is unreachable
- **THEN** the app shows a retry screen, starts no protected networking, and does not navigate to the login page

### Requirement: Expired session at startup leads to sign-in
When the probe reports a missing or expired session while the app starts, the app SHALL send the user to the sign-in entry by top-level navigation, and after sign-in the user SHALL land on the same app route, including query string and hash.

#### Scenario: Expired cookie, cached shell
- **WHEN** the shell is served from the service worker cache and the probe is redirected to sign-in
- **THEN** the app navigates to the sign-in entry carrying its current path, query and hash as the return target

#### Scenario: Sign-in does not take effect
- **WHEN** the app already navigated to sign-in automatically and the probe still reports an expired session on the next start within a short window
- **THEN** the app stops navigating automatically and shows a manual "Sign in" action with an explanation

### Requirement: Mid-session expiry blocks the UI with a sign-in prompt
When the session expires while the app is visible, the app SHALL show a blocking dialog that offers to sign in again, and SHALL NOT navigate away without the user's action. The sign-in action SHALL be a top-level navigation. The dialog SHALL also offer a retry that re-checks the session without leaving the page.

#### Scenario: REST call returns the login page
- **WHEN** a REST call to the app's own origin fails with a network error, a redirect, or an HTML response in place of the API's data
- **THEN** the app re-checks the session once and, if it has expired, shows the sign-in dialog

#### Scenario: Application authorization failure
- **WHEN** a REST call answers 401 or 403 from the copa API itself
- **THEN** the app treats it as a token problem and does not show the session-expired dialog

#### Scenario: Tab returns to the foreground
- **WHEN** the tab or installed app becomes visible, the device comes back online, or the service worker reports an expired session
- **THEN** the app re-checks the session, and concurrent triggers share a single check

### Requirement: Live connections pause while signed out and resume after sign-in
While the session is expired the app SHALL NOT attempt to reconnect `/ws` or `/ws/events`. When the session is confirmed valid again, without a page reload, the app SHALL re-establish those connections and refresh history and capabilities.

#### Scenario: Socket closes with expired session
- **WHEN** a live connection closes and the re-check reports an expired session
- **THEN** no reconnect is scheduled and the sign-in dialog is shown

#### Scenario: User signs in and retries
- **WHEN** the user signs in elsewhere (for example another tab) and chooses "I've signed in — retry"
- **THEN** the dialog closes and the live connections reconnect, and the clipboard and history views update without a manual reload

#### Scenario: Offline socket close
- **WHEN** a live connection closes while the device is offline
- **THEN** the app does not show the sign-in dialog and retries after connectivity returns

### Requirement: Login responses are never treated as data
Responses from the app's own origin that are a redirect or an HTML page where the API promises text or JSON SHALL be treated as an expired-session signal and never parsed, displayed, counted as a successful sync, or reported as an absent feature. This SHALL hold for clipboard pull and push, history and capability queries, and the server version check.

#### Scenario: Clipboard push receives the login page
- **WHEN** a clipboard push returns HTTP 200 with an HTML body
- **THEN** the app reports the sync as failed and re-checks the session

#### Scenario: Version check receives the login page
- **WHEN** the server version request returns HTML or fails at the network level
- **THEN** the app re-checks the session and does not log the server as an older build without a version endpoint

### Requirement: Service worker never caches or serves the login flow
The service worker SHALL let the sign-in control routes, the API and the live-connection routes go to the network unmodified. It SHALL NOT store a redirect or an HTML login page under an asset key, SHALL NOT answer those routes from cache, and SHALL notify open pages when it observes an expired session.

#### Scenario: Asset request intercepted by the proxy
- **WHEN** a cached script or stylesheet is requested and the network answers with a redirect or HTML
- **THEN** the cached copy is served, the answer is not cached, and open pages are told the session expired

#### Scenario: Control route requested
- **WHEN** the page requests `/__access/probe` or `/__access/login`
- **THEN** the service worker does not respond from cache or app-shell fallback

### Requirement: Sign-in return target is same-origin only
The server's sign-in entry SHALL redirect only to a same-origin relative target that begins with exactly one `/` and contains no backslash or control character, and SHALL redirect to `/` for any other target. Probe and sign-in entry responses SHALL NOT be cacheable.

#### Scenario: Open-redirect attempt
- **WHEN** the return target is `//evil.com`, `https://evil.com`, `/\evil.com`, or contains a line break
- **THEN** the server redirects to `/`

#### Scenario: Deep link preserved
- **WHEN** the return target is `/#token=x&url=y`
- **THEN** the server redirects to exactly that target

### Requirement: Session cookie is not handled by page code
The web app SHALL NOT read, parse, store or forward the identity-proxy session cookie or its token from page code, and SHALL NOT perform sign-in through `fetch` or XHR.

#### Scenario: Sign-in action
- **WHEN** the user chooses to sign in
- **THEN** the browser performs a top-level navigation to the sign-in entry and no credential is placed in app storage or request headers by the app
