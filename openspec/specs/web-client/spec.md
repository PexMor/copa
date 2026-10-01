# web-client Specification

## Purpose

Defines how the copa web app lets users share files by drag-and-drop, file picker or paste, and browse, retrieve and delete server-side clipboard history items.

## Requirements

### Requirement: File features follow server capability
The web app SHALL query the selected copa server's capabilities and SHALL show file upload controls only when the server reports file support for the selected namespace. Against a server without the capability endpoint, and for MQTT servers, the app SHALL behave as it does today.

#### Scenario: Server supports files
- **WHEN** the selected server reports `files: true`
- **THEN** the drop zone and file picker are shown

#### Scenario: Older server
- **WHEN** the capability request returns 404
- **THEN** no file or history controls are shown and text push/pull works as before

### Requirement: Upload files by drop, picker or paste
The web app SHALL upload a file to the selected namespace when the user drops it onto the clipboard panel, chooses it with a file picker, or pastes a file from the system clipboard. Multiple files SHALL be uploaded as separate items. The app SHALL show upload progress and report success or failure per file.

#### Scenario: Drag and drop
- **WHEN** the user drops a file onto the clipboard panel
- **THEN** the file is uploaded, progress is shown, and on completion the file appears at the top of the history list

#### Scenario: Paste an image
- **WHEN** the user pastes while the system clipboard holds an image and focus is in the panel
- **THEN** the image is uploaded as a file item and no text is inserted

#### Scenario: Too large
- **WHEN** the chosen file exceeds the `max_file_size` reported by the server
- **THEN** the app shows an error naming the limit and sends no upload request

#### Scenario: Upload fails
- **WHEN** the transfer to the object store fails or is rejected
- **THEN** the app shows an error for that file and no item is added to the history list

### Requirement: Browse history
The web app SHALL show the selected namespace's history newest first, with kind, name or text preview, size and time remaining until expiry for each item. The list SHALL update when items are added, deleted or expire while the live connection is enabled, and on manual refresh otherwise.

#### Scenario: Item pushed elsewhere appears
- **WHEN** live mode is on and another client completes a file upload
- **THEN** the new item appears in the list without user action

#### Scenario: Expired item disappears
- **WHEN** an item's expiry time passes
- **THEN** it is no longer shown as available

### Requirement: Retrieve and delete history items
For each text item the app SHALL offer loading it into the editor and copying it to the system clipboard. For each file item the app SHALL offer downloading it under its original name. For each item the app SHALL offer deletion when the server token permits writing.

#### Scenario: Download a file
- **WHEN** the user activates download on a file item
- **THEN** the browser saves the file under the item's name

#### Scenario: Restore older text
- **WHEN** the user activates an older text item
- **THEN** its full text is loaded into the editor

#### Scenario: Delete an item
- **WHEN** the user deletes an item and the server confirms
- **THEN** the item is removed from the list

### Requirement: Presigned URLs are not retained
The web app SHALL request a presigned URL only at the moment of upload or download and SHALL NOT persist presigned URLs in IndexedDB, local storage or the service-worker cache. The service worker SHALL NOT intercept or cache requests to the object store.

#### Scenario: Offline cache excludes object store
- **WHEN** a file is downloaded and the app is later opened offline
- **THEN** no response from the object store is served from the service-worker cache
