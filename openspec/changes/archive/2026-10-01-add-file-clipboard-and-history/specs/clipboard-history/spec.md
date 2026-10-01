# Spec Delta

## Purpose

Keeps a bounded, expiring, per-namespace history of clipboard items (text and files) on the server so clients can retrieve older items, not only the most recent one.

## ADDED Requirements

### Requirement: Namespace keeps a bounded item history
The server SHALL keep, per namespace, an ordered history of clipboard items. Each item SHALL have a unique unguessable id, a kind (`text` or `file`), a creation time, an expiry time and a size. The history SHALL hold at most the namespace's configured `history_limit` items (default 20); adding an item beyond the limit SHALL remove the oldest item.

#### Scenario: Push creates a new history item
- **WHEN** a client with write permission posts text to `POST /api/clipboard`
- **THEN** a new `text` item is added as the newest item of that namespace's history and earlier items remain retrievable

#### Scenario: Oldest item is evicted at the limit
- **WHEN** a namespace with `history_limit = 3` already holds 3 items and a 4th item is added
- **THEN** the oldest item is removed and the history holds exactly 3 items

#### Scenario: Evicted file item releases its storage
- **WHEN** the item evicted by the limit is a `file` item
- **THEN** its stored object is deleted from the object store

#### Scenario: Repeated identical text does not flood history
- **WHEN** a client pushes text byte-identical to the newest text item of the namespace
- **THEN** no additional item is created and the existing item's creation and expiry times are refreshed

### Requirement: Every item expires
Every item SHALL have an expiry time equal to its creation time plus the namespace's `item_ttl_secs` (default 86400), or plus a shorter TTL requested by the client when adding the item. A client-requested TTL longer than the namespace TTL SHALL be clamped to the namespace TTL. A namespace TTL of zero or less SHALL be rejected at startup.

#### Scenario: Default expiry applied
- **WHEN** an item is added without a requested TTL to a namespace with `item_ttl_secs = 3600`
- **THEN** the item's expiry time is one hour after its creation time

#### Scenario: Shorter TTL requested
- **WHEN** a client adds an item with the header `X-Copa-TTL: 60` to a namespace with `item_ttl_secs = 3600`
- **THEN** the item's expiry time is 60 seconds after its creation time

#### Scenario: Longer TTL is clamped
- **WHEN** a client adds an item with `X-Copa-TTL: 999999` to a namespace with `item_ttl_secs = 3600`
- **THEN** the item's expiry time is 3600 seconds after its creation time

### Requirement: Expired items are never served and are removed
The server SHALL NOT return an expired item from any endpoint, from the instant its expiry time passes. The server SHALL remove expired items from the history within 60 seconds of expiry, and for `file` items SHALL delete the stored object as part of removal.

#### Scenario: Expired item is not listed
- **WHEN** an item's expiry time has passed and a client lists the history
- **THEN** the item is absent from the response

#### Scenario: Expired item is not retrievable by id
- **WHEN** a client requests an expired item by id
- **THEN** the server responds 404

#### Scenario: Expired file object is deleted
- **WHEN** a `file` item expires
- **THEN** its object is deleted from the object store within 60 seconds, or deletion is retried until it succeeds

#### Scenario: Latest text expires
- **WHEN** the newest text item of a namespace has expired and no other unexpired text item exists
- **THEN** `GET /api/clipboard` responds 200 with an empty body

### Requirement: History listing
The server SHALL expose `GET /api/history`, which returns the unexpired items of the selected namespace as JSON, newest first, to clients with read permission. Each entry SHALL contain `id`, `kind`, `created_at`, `expires_at` and `size`; `text` entries SHALL also contain a `preview` of at most 200 characters; `file` entries SHALL also contain `name` and `content_type`. The listing SHALL NOT contain presigned URLs or full text content.

#### Scenario: List newest first
- **WHEN** a namespace holds text item A, then file item B, and a reader calls `GET /api/history`
- **THEN** the response is a JSON list with B first and A second, each with its metadata

#### Scenario: Unauthorized listing
- **WHEN** a client without read permission for the namespace calls `GET /api/history`
- **THEN** the server responds 401

### Requirement: Retrieve an item by id
The server SHALL expose `GET /api/history/{id}` for clients with read permission. For a `text` item it SHALL return the full content as `text/plain`. For a `file` item it SHALL respond 409 with a JSON error directing the client to the file download endpoint. Items SHALL only be reachable through the namespace they belong to.

#### Scenario: Fetch older text item
- **WHEN** a reader requests `GET /api/history/{id}` for an unexpired text item that is not the newest
- **THEN** the server responds 200 with that item's full text

#### Scenario: Item id from another namespace
- **WHEN** a client authorized for namespace `a` requests an id that belongs to namespace `b`
- **THEN** the server responds 404

### Requirement: Delete items
The server SHALL expose `DELETE /api/history/{id}` and `DELETE /api/history` to clients with write permission, removing one item or all items of the namespace respectively. Removing a `file` item SHALL delete its stored object.

#### Scenario: Delete a single item
- **WHEN** a writer calls `DELETE /api/history/{id}` for an existing item
- **THEN** the server responds 200 and the item is no longer listed or retrievable

#### Scenario: Clear the namespace
- **WHEN** a writer calls `DELETE /api/history`
- **THEN** the history is empty and every object belonging to that namespace's file items is deleted from the object store

#### Scenario: Read-only token cannot delete
- **WHEN** a client holding only a read token calls `DELETE /api/history/{id}`
- **THEN** the server responds 401 and the item remains

### Requirement: Existing clipboard API remains compatible
`GET /api/clipboard` SHALL return the content of the newest unexpired `text` item of the namespace (empty body if none). `POST /api/clipboard` SHALL keep its request format, status codes and size limit. The `/ws` endpoint SHALL keep sending plain text frames containing only text item content; file items SHALL NOT produce frames on `/ws`.

#### Scenario: Old client against new server
- **WHEN** a client that only knows `GET`/`POST /api/clipboard` pushes text and then pulls
- **THEN** it receives exactly the text it pushed

#### Scenario: File item does not disturb text clients
- **WHEN** a file item is added after a text item
- **THEN** `GET /api/clipboard` still returns the text item's content and `/ws` subscribers receive no frame

### Requirement: Item event stream
The server SHALL expose a WebSocket endpoint `/ws/events`, authorized like `/ws` and requiring read permission, that sends one JSON text frame per history change: `{"type":"item_added","item":{…}}` with the same metadata as a listing entry, and `{"type":"item_removed","id":"…","reason":"expired"|"deleted"|"evicted"}`. Frames received from the client on this endpoint SHALL be ignored.

#### Scenario: Subscriber learns about a new file
- **WHEN** a file upload is completed in a namespace with a connected `/ws/events` subscriber
- **THEN** the subscriber receives an `item_added` frame with the file's metadata

#### Scenario: Subscriber learns about expiry
- **WHEN** an item is removed because it expired
- **THEN** subscribers receive an `item_removed` frame with `reason` `expired`

### Requirement: Capability discovery
The server SHALL expose `GET /api/capabilities` to any client holding a token for the selected namespace, returning JSON with at least `history` (true), `history_limit`, `item_ttl_secs`, `files` (boolean) and, when files are enabled, `max_file_size`.

#### Scenario: Client detects file support
- **WHEN** a client calls `GET /api/capabilities` on a server with storage configured for the namespace
- **THEN** the response contains `"files": true` and the namespace's `max_file_size`

#### Scenario: Server without storage
- **WHEN** a client calls `GET /api/capabilities` on a server with no storage configured
- **THEN** the response contains `"files": false`
