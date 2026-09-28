# Monaco Notepad v4 Release Notes

Monaco Notepad v4 focuses on interaction consistency, recovery clarity, security hardening, and regression resistance. It builds on the V3 Graphite Utility interface while strengthening the command, menu, dialog, file-opening, printing, and automated-validation architecture.

## Commands and keyboard shortcuts

- Added a canonical shared registry for application commands and keyboard shortcuts.
- Centralized shortcut labels, accelerators, modifying-command metadata, and menu integration.
- Added Find Previous as a canonical `Shift+F3` command.
- Preserved Monaco-owned shortcuts where Monaco remains the correct execution path.
- Added deterministic runtime coverage for all 28 canonical shortcuts: 23 native-menu routes and 5 Monaco-owned keyboard routes.

## Dialog and menu consistency

- Introduced reusable modal-controller behavior for Keyboard Shortcuts and Document Inspector.
- Unified Close, Escape, backdrop dismissal, focus restoration, and mutual exclusion behavior.
- Made native menu checked and enabled state follow authoritative document context.
- Expanded tests around read-only state, Follow File state, and command availability.

## Recent Files and file opening

- Hardened Recent Files normalization.
- Pruned missing entries, removed duplicates, preserved ordering, and retained the 10-entry cap.
- Kept clearing Recent Files separate from last-document reopening state.
- Routed drag-and-drop file opening through the normal guarded open-file pipeline.
- Preserved dirty-buffer protection, Safe Open checks, large-file handling, and other existing open safeguards.

## Recovery and transient feedback

- Improved recovered-session presentation, including explicit recovered-document identification.
- Expanded Document Inspector recovery/session reporting.
- Strengthened startup behavior across explicit-file, recovery, scratchpad, last-document, missing-file, invalid-state, and save-cleanup cases.
- Added transient feedback for operations that should remain visible even when the optional status bar is hidden.
- Added concise feedback for path/filename copying, voluntary read-only changes, encoding changes, reload, revert, and blocked commands.

## Security hardening

- Centralized external web URL handling.
- Restricted external navigation to HTTP and HTTPS URLs.
- Denied popup navigation inside privileged renderer windows.
- Prevented privileged renderer windows from navigating away from application content.
- Added permanent security-contract tests for BrowserWindow hardening and navigation policy.
- Preserved context isolation, disabled Node integration, renderer sandboxing, and narrow preload APIs.

## Printing

- Added configured-printer preflight before invoking Electron printing.
- Added a clear error when no CUPS printer destinations are available.
- Captured Electron print success and failure results instead of silently discarding them.
- Treated user-cancelled print jobs separately from genuine print failures.
- Preserved the hardened temporary BrowserWindow used for printing.
- Added permanent print-contract tests and deterministic print behavior in accelerator runtime testing.

## Validation and regression coverage

- Added permanent command-registry contract tests.
- Added permanent Electron security-contract tests.
- Added permanent print-contract tests.
- Added dedicated accelerator runtime coverage.
- Expanded the main runtime suite for menus, modals, Recent Files, recovery, drag-and-drop, transient feedback, and interaction state.
- Expanded startup coverage for recovery/session priority and cleanup.
- Final V4 validation passed typechecking, unit tests, production build, runtime/startup tests, repeated accelerator execution, command contracts, security contracts, and print contracts.

## Preserved safety and architecture

V4 does not weaken Monaco Notepad's existing file-safety model. Atomic writes, read-only handling, symbolic-link-safe saves, executable-bit preservation, external-change conflict detection, Safe Open behavior, large-file safeguards, optional backup-on-save, encoding protection, mixed-EOL safeguards, and dirty-buffer protection remain part of the application.

## Platform and packaging

- Linux x86_64 remains the only supported platform.
- AppImage and Flatpak remain the supported package formats.
- Windows, macOS, ARM, ARM64, aarch64, Snap, DEB, and RPM remain outside the supported release scope.

## Scope

Monaco Notepad remains a focused single-document text editor. V4 does not add tabs, workspaces, project trees, an embedded terminal, source-control UI, LSP features, IntelliSense, plugins, cloud accounts, telemetry, AI features, or other IDE architecture.
