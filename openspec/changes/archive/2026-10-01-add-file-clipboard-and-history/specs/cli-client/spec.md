# Spec Delta

## Purpose

Defines how the `copacli` command-line client uploads and downloads files and works with server-side clipboard history items.

## ADDED Requirements

### Requirement: Upload a file
`copacli put <FILE>` SHALL upload the file as a file item to the selected remote and namespace, streaming it from disk to the object store, and SHALL print the new item id on success. It SHALL accept `--name` to override the stored name and `--ttl <secs>` to request a shorter expiry. It SHALL use the same remote, namespace, token and extra-header resolution as `paste`.

#### Scenario: Successful put
- **WHEN** the user runs `copacli put -r local report.pdf` against a server with files enabled
- **THEN** the file is uploaded, the upload is completed, the item id is printed and the exit code is 0

#### Scenario: Server without file support
- **WHEN** the user runs `copacli put` against a server where files are not enabled
- **THEN** copacli prints that the server does not support files and exits non-zero without uploading anything

#### Scenario: File exceeds server limit
- **WHEN** the server rejects the upload request with 413 or 507
- **THEN** copacli prints the reason and exits non-zero

#### Scenario: Upload fails midway
- **WHEN** the transfer to the object store fails
- **THEN** copacli exits non-zero and does not call complete

### Requirement: Download a file
`copacli get [ID]` SHALL download a file item; without an id it SHALL download the newest file item. By default it SHALL write into the current directory using the item's name; `-o <PATH>` SHALL select a file or directory and `-o -` SHALL write to stdout. It SHALL never write outside the chosen directory regardless of the item name, SHALL refuse to overwrite an existing file unless `--force` is given, and SHALL not leave a partial file at the destination on failure.

#### Scenario: Get newest file
- **WHEN** the user runs `copacli get -r local` and the newest file item is `report.pdf`
- **THEN** `./report.pdf` is created with the uploaded bytes

#### Scenario: Existing file is protected
- **WHEN** `./report.pdf` already exists and `--force` is not given
- **THEN** copacli exits non-zero and leaves the existing file untouched

#### Scenario: Hostile item name
- **WHEN** an item's name returned by the server contains path separators or `..`
- **THEN** copacli writes only a file directly inside the target directory, using the final path component

#### Scenario: No file items
- **WHEN** `copacli get` is run without an id and the history has no file item
- **THEN** copacli prints that no file is available and exits non-zero

### Requirement: List and manage history
`copacli history` SHALL list the namespace's items newest first, showing id, kind, size, time remaining until expiry and the name (files) or a preview (text); `--json` SHALL print the server's listing verbatim. `copacli history rm <ID>` SHALL delete one item and `copacli history clear` SHALL delete all items of the namespace.

#### Scenario: List history
- **WHEN** the user runs `copacli history -r local` with one text and one file item present
- **THEN** two lines are printed, newest first, each with id, kind, size and remaining lifetime

#### Scenario: Remove an item
- **WHEN** the user runs `copacli history rm <ID>`
- **THEN** the item no longer appears in `copacli history`

### Requirement: Retrieve an older text item
`copacli copy --item <ID>` SHALL fetch the given text item and route it through the same output options as `copy` (tmux buffer, file, stdout, output command). When the id refers to a file item it SHALL tell the user to use `get` and exit non-zero.

#### Scenario: Older text to stdout
- **WHEN** the user runs `copacli copy -r local --item <ID> -o -` for an unexpired text item
- **THEN** that item's text is written to stdout

#### Scenario: Expired item
- **WHEN** the id refers to an item that has expired
- **THEN** copacli reports that the item was not found or has expired and exits non-zero

### Requirement: Existing commands are unchanged
`copy`, `paste`, `watch`, their aliases and the MQTT subcommands SHALL behave as before when the new options are not used, against both old and new servers.

#### Scenario: Plain copy against new server
- **WHEN** the user runs `copacli copy -r local` after a file item and a text item were pushed
- **THEN** the newest text item's content is delivered to the default output
