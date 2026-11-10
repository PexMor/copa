# Spec Delta

## Purpose

Defines the embeddable Preact component that lets any web application share text and files through a copa server, with content-type aware handling of what is sent and received.

## ADDED Requirements

### Requirement: Embed as component or script tag
The widget SHALL be usable as a Preact/React-compatible `<CopaShare>` component imported from an ES module, and as a self-mounting custom element or global `Copa.mount(el, options)` for pages without a build step. It SHALL NOT require the copa server to serve the host page.

#### Scenario: Mounted from a module
- **WHEN** a host app renders `<CopaShare config={cfg} />`
- **THEN** the widget renders inside the host's DOM and connects to the configured endpoint

#### Scenario: Mounted from a script tag
- **WHEN** a plain HTML page loads the widget script and calls `Copa.mount(el, { configUrl })`
- **THEN** the widget loads the JSON configuration from `configUrl` and renders in `el`

#### Scenario: Cross-origin host
- **WHEN** the host page origin differs from the copa server and is listed in the server's `allowed_origins`
- **THEN** the widget's API calls succeed

### Requirement: Style isolation and theming
The widget SHALL render so that its styles do not leak into, and are not overridden by, the host page, and SHALL expose theming through documented CSS custom properties. It SHALL honour light, dark and auto themes.

#### Scenario: Host CSS does not break layout
- **WHEN** the host page defines global styles for `button` and `input`
- **THEN** the widget's controls keep their own appearance

#### Scenario: Host sets theme variables
- **WHEN** the host sets the widget's accent-colour custom property
- **THEN** the widget uses that colour

### Requirement: Share and receive text
The widget SHALL let the user push text to, and pull the current value from, the configured endpoint and namespace, honouring the namespace `size_limit` and the read/write permission of the credential. Controls that the credential cannot use SHALL be disabled or hidden.

#### Scenario: Push text
- **WHEN** the user submits text and the credential has write permission
- **THEN** the text is stored as the namespace's current clipboard value and a success state is shown

#### Scenario: Read-only credential
- **WHEN** the credential only allows reading
- **THEN** push controls are not offered and pull still works

#### Scenario: Text too large
- **WHEN** the text exceeds the namespace `size_limit`
- **THEN** the widget shows the limit and does not send the request

### Requirement: Content-type aware items
The widget SHALL classify each shared or received item as text, URL, JSON, HTML, image or generic file using its MIME type and, for text, its content. The widget SHALL render a preview suited to the class (for example an image thumbnail, formatted JSON, a clickable URL) and SHALL NOT execute or inject HTML from received items into the host page.

#### Scenario: Image preview
- **WHEN** a received item has an `image/*` content type
- **THEN** the widget shows a thumbnail obtained through a short-lived download URL

#### Scenario: HTML is inert
- **WHEN** a received text item contains `<script>` markup
- **THEN** the markup is displayed as text and no script runs

#### Scenario: Pasted URL
- **WHEN** the user pushes text that is a single http(s) URL
- **THEN** the item is classified as URL and offered as a link opening with `rel="noopener noreferrer"`

### Requirement: Route payloads by type and size
The widget SHALL send text up to the namespace `size_limit` through the clipboard endpoint, and SHALL send files, images from the system clipboard, and text exceeding the limit as file items through the presigned object-storage flow. The browser SHALL never hold object-store credentials.

#### Scenario: Small text uses clipboard endpoint
- **WHEN** the user shares 200 bytes of plain text
- **THEN** no file upload is requested

#### Scenario: File upload
- **WHEN** the user drops a PDF onto the widget and the server reports file support
- **THEN** the widget requests an upload grant, transfers the bytes directly to the object store with progress, confirms completion, and the item appears in history

#### Scenario: Files not supported
- **WHEN** the server reports no file capability for the namespace
- **THEN** file controls are not shown and text sharing is unaffected

#### Scenario: File too large
- **WHEN** a chosen file exceeds the reported `max_file_size`
- **THEN** the widget names the limit and sends no upload request

### Requirement: Programmatic host integration
The widget SHALL expose to the host application a typed API and events: `share(data | File | Blob)`, `paste()`, `onItem(item)`, `onAuthChange(state)` and `onError(error)`. Calls made before authentication completes SHALL be rejected with a typed error rather than silently queued.

#### Scenario: Host shares data
- **WHEN** the host calls `share(new Blob([...], { type: "image/png" }))`
- **THEN** the blob is uploaded as a file item with that content type and `onItem` fires with the stored item

#### Scenario: Not authenticated
- **WHEN** the host calls `share()` while the widget is unauthenticated
- **THEN** the call rejects with an authentication error and the sign-in or pairing UI is shown

### Requirement: Live updates and history
The widget SHALL show the namespace history newest first and SHALL update it live when the server offers the event stream, falling back to manual refresh otherwise. Items SHALL be removable by credentials with write permission.

#### Scenario: Item from another device
- **WHEN** another client adds an item and live mode is active
- **THEN** it appears in the widget without user action

#### Scenario: Delete item
- **WHEN** a writer deletes an item
- **THEN** it disappears from the list and from the server history
