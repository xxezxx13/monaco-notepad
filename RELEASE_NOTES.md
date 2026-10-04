# Monaco Notepad v5 Release Notes

Monaco Notepad v5 focuses on startup reliability, file-safety clarity, settings portability, accessibility, resource integrity, and release confidence. It builds on the V4 interaction and security architecture without expanding Monaco Notepad beyond its focused single-document editor scope.

## Startup reliability

- Hardened Flatpak startup visibility for cases where Electron does not deliver `ready-to-show`.
- Added a renderer-ready IPC fallback so a successfully loaded editor cannot remain indefinitely hidden.
- Added opt-in local JSONL startup tracing through `MONACO_NOTEPAD_STARTUP_TRACE`.
- Kept startup diagnostics local, content-free, and independent of telemetry or network reporting.
- Added deterministic startup coverage for explicit-file, recovery, scratchpad, last-document, missing-file, invalid-state, save-cleanup, and visibility-fallback paths.

## External file conflict safety

- Hardened handling for files modified, replaced, or deleted outside Monaco Notepad.
- Revalidated disk identity before destructive save decisions.
- Kept dirty buffers protected while exposing explicit Keep Editing, Compare Against Disk, Save As, and Overwrite choices where appropriate.
- Preserved the current buffer while comparing against changed disk contents.
- Prevented ordinary Save from silently recreating a deleted original path.

## Encoding and line-ending integrity

- Added exact raw-byte regression coverage for UTF-8, UTF-8 BOM, UTF-16 LE, UTF-16 BE, and Windows-1252 saves.
- Preserved lossless-only Windows-1252 behavior and rejection of unrepresentable text.
- Retained explicit mixed-EOL safeguards and LF/CRLF normalization behavior.

## Find and navigation reliability

- Expanded runtime coverage for Find Next and Find Previous.
- Verified forward and backward wraparound behavior.
- Strengthened Go To Line movement coverage.
- Preserved the canonical 28-shortcut contract: 23 native menu routes and 5 Monaco-owned keyboard routes.

## Recovery and scratchpad clarity

- Distinguished recovered-file sessions from the persistent untitled scratchpad.
- Prevented normal scratchpad restoration from being presented as a crash recovery.
- Preserved startup priority among explicit files, recovery, last-document reopening, and scratchpad state.

## Portable settings

- Added versioned JSON export and import for portable editor and appearance preferences.
- Validated imported documents completely before mutating settings.
- Preserved machine-local state such as recent files, window size, file positions, and last-document paths.
- Applied imported settings live across the editor, menus, native theme state, and Preferences window.
- Added permanent unit and runtime regression coverage for validation, round-trip integrity, and local-state preservation.

## Accessibility and focus behavior

- Improved keyboard focus containment in application modal dialogs.
- Restored Monaco editor focus consistently after dialogs close.
- Hardened large-file progress focus behavior during cancellable reads and non-cancellable model creation.
- Preserved visible keyboard focus treatment for interactive filtering results.

## Resource and performance hardening

- Retained the existing 12-cycle Compare Against Disk resource stress test.
- Added deterministic assertions that temporary Monaco diff editors and models return to baseline.
- Added BrowserWindow and Linux inotify regression guards around repeated comparison cycles.
- Added observational file-descriptor and working-set measurements without imposing brittle memory thresholds.
- Established repeatable startup timing baselines for normal and renderer-ready fallback visibility paths.
- Found no measured resource leak requiring a speculative memory or performance refactor.

## Validation architecture

- Expanded permanent unit, integration, runtime, accelerator, startup, settings-portability, accessibility, and resource-lifecycle coverage.
- Continued validating real sandboxed Electron windows with isolated temporary profiles and files.
- Kept diagnostics local and test-oriented rather than adding analytics, telemetry, or background reporting.

## Preserved safety and architecture

V5 does not weaken Monaco Notepad's existing file-safety model. Atomic writes, backup-on-save, symbolic-link-safe saves, executable-mode preservation, Safe Open behavior, read-only protection, external-change detection, encoding safeguards, large-file protections, mixed-EOL handling, and dirty-buffer guards remain part of the application.

## Platform and packaging

- Linux x86_64 remains the only supported platform.
- AppImage and Flatpak remain the only supported package formats.
- Windows, macOS, ARM, ARM64, aarch64, Snap, DEB, and RPM remain outside the supported release scope.

## Scope

Monaco Notepad remains a focused single-document text editor. V5 does not add tabs, workspaces, project trees, an embedded terminal, source-control UI, LSP features, IntelliSense, plugins, cloud accounts, telemetry, AI features, or other IDE architecture.
