# Monaco Notepad v3 Release Notes

Monaco Notepad v3 is a focused visual and interaction modernization of the Linux desktop editor. It preserves the single-document Notepad-style architecture and V2 file-safety behavior while rebuilding the interface around a more cohesive Graphite Utility design language.

## Editor shell and visual language

- Introduced the V3 Graphite Utility visual foundation.
- Modernized the main editor shell while keeping the editor surface dominant.
- Refined Graphite Dark as the flagship dark appearance.
- Refined Clean Light as an intentionally designed light appearance.
- Preserved synchronized System-theme behavior across the main window, Preferences, Electron native theme handling, and menus.
- Unified spacing, borders, typography, control sizing, and interaction feedback across the application.

## Controls and working surfaces

- Modernized text fields, selects, buttons, checkboxes, and other compact controls.
- Modernized Filter Lines and Regex Extract without changing their underlying behavior.
- Modernized Compare Against Disk while preserving its existing safety semantics.
- Improved narrow-window behavior for Filter Lines and Compare Against Disk.
- Kept the application text-first and utility-focused rather than introducing toolbar, sidebar, or IDE-style chrome.

## Dialogs, progress, and inspection

- Modernized modal surfaces and overlay treatment.
- Modernized large-file opening progress and cancellation presentation.
- Modernized the keyboard-shortcuts reference.
- Modernized Document Inspector while preserving its separation between saved-source and current-editor facts.
- Unified semantic warning, error, Follow, read-only, large-file, and transient-status presentation.

## Preferences and defaults

- Reworked Preferences into a compact native-settings layout.
- Improved Preferences behavior at narrow window sizes.
- The bottom status bar is hidden by default.
- Line numbers and the editor gutter are hidden by default.
- Both settings remain persistent and user-toggleable.

## Theme architecture and accessibility

- Consolidated shell styling around semantic V3 theme tokens.
- Removed obsolete compatibility aliases left from the transition to the V3 theme system.
- Centralized overlay styling and retained explicit Monaco syntax-theme palettes where appropriate.
- Added `prefers-reduced-motion` handling for V3 transitions.
- Preserved keyboard focus behavior and accessible labeling while applying the visual refresh.
- Retained responsive status-bar behavior and added final small-window polish.

## Preserved safety and architecture

V3 does not weaken Monaco Notepad's existing file-safety or Electron security model. Atomic writes, read-only handling, symbolic-link-safe saves, executable-bit preservation, external-change conflict detection, Safe Open behavior, large-file safeguards, optional backup-on-save, context isolation, renderer sandboxing, and narrow preload APIs remain part of the application.

## Platform and packaging

- Linux x86_64 remains the only supported platform.
- AppImage and Flatpak remain the supported package formats.
- Windows, macOS, ARM, ARM64, aarch64, Snap, DEB, and RPM remain outside the supported release scope.

## Scope

Monaco Notepad remains a focused single-document text editor. V3 does not add tabs, workspaces, project trees, an embedded terminal, source-control UI, LSP features, IntelliSense, plugins, cloud accounts, telemetry, or other IDE architecture.
