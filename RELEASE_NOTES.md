# Monaco Notepad v2 Release Notes

Monaco Notepad v2 expands the editor's file-safety, inspection, filtering, transformation, large-file, and Linux integration capabilities while preserving its single-document Notepad-style scope.

## File safety and interpretation

- Added Safe Open protection for files that appear unsuitable for normal text editing.
- Added Reopen With Encoding for explicitly reinterpreting an already-open file.
- Added exact mixed-line-ending detection and explicit LF/CRLF normalization.
- Added optional `.bak` backup creation before overwriting an existing file.
- Preserved atomic-write, read-only, symlink-safe, executable-bit, and external-change protections.

## Inspection, filtering, and extraction

- Added Filter Lines with matching and non-matching results.
- Integrated Filter Lines with Follow File.
- Added a dual-layer Document Inspector that distinguishes saved-source facts from current-editor facts.
- Added Regex Extract.
- Expanded text transformation and extraction capabilities.

## Editing and viewport behavior

- Added Typewriter Scrolling.
- Refined Follow File auto-scroll behavior and runtime handling.
- Preserved Follow File handling for append, truncation, replacement, deletion, and recreation.

## Large files

- Added responsive chunked file reading for large-file opens.
- Added opening progress reporting.
- Added cancellation while file content is being read.
- Preserved the current document when a large-file open is cancelled.
- Retained Monaco Notepad's full-buffer architecture and existing Large File Mode safeguards.

## Maintenance and packaging

- Hardened post-v1 dependencies.
- Hardened Flatpak packaging.
- Ensured runtime validation builds current application output before execution.
- Retained Linux x86_64 as the only supported platform.
- Retained AppImage and Flatpak as the supported package formats.

## Scope

Monaco Notepad remains a focused single-document text editor. v2 does not add tabs, workspaces, project trees, an embedded terminal, source-control UI, LSP features, IntelliSense, plugins, cloud accounts, telemetry, or other IDE architecture.
