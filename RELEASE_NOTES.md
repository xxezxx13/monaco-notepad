# Monaco Notepad v6 Release Notes

Monaco Notepad v6 introduces independent document windows, upgrades Monaco Editor to 0.57.0, and improves native Flatpak theme alignment. It preserves the focused, single-document-per-window design and existing file-safety protections.

## Multi-window document editing

- Added support for multiple independent document windows without introducing tabs or workspace management.
- Opening another file from a window that already contains a file-backed document creates a separate document window instead of replacing the open file.
- Each editor window continues to contain at most one document.
- Document windows maintain independent lifecycle, renderer readiness, and pending-open state.
- Closing an individual document window does not require closing other document windows.

## Per-window file and save isolation

- Isolated save baselines and external file-change monitoring for individual document windows.
- Scoped file watchers, external-change notifications, and Follow File operations to their respective windows.
- Updated native menu routing so document operations target the appropriate focused window.
- Hardened menu behavior when the desktop does not report a focused native window.
- Preserved independent document editing while keeping Preferences separate from document windows.

## Startup and recovery ownership

- Retained a designated startup document window for recovery and persistent scratchpad ownership.
- Prevented secondary document windows from independently taking ownership of startup recovery state.
- Preserved existing startup priority rules for explicit file requests, recovery, scratchpad restoration, and last-document reopening.
- Kept the established startup visibility and renderer-ready fallback protections.

## Monaco Editor upgrade

- Upgraded Monaco Editor from 0.56.0 to 0.57.0.
- Preserved the lightweight editor architecture without adding language servers, IDE diagnostics, IntelliSense, or workspace features.
- Retained the existing syntax-highlighting, text-editing, navigation, and transformation features.

## Native Linux appearance

- Improved native Flatpak title-bar, window-control, and menu appearance for explicitly selected Light and Dark themes.
- The Flatpak launcher reads the saved appearance preference before starting Electron and configures GTK accordingly.
- Switching Light or Dark continues to update the editor immediately.
- Native Flatpak window controls and menus adopt the newly selected Light or Dark appearance on the next application launch.
- System appearance leaves the Flatpak GTK theme override unset, allowing desktop theme selection.
- Preserved native window controls and menus rather than replacing them with custom renderer-owned chrome.

## Flatpak dependency and packaging integrity

- Regenerated offline Flatpak dependency sources against the current package lockfile.
- Updated the bundled source references for Monaco Editor 0.57.0 and DOMPurify 3.4.15.
- Preserved the Electron Flatpak BaseApp and Zypak launcher architecture.
- Retained offline npm installation during Flatpak package construction.
- Preserved the existing Flatpak application ID and Linux x86_64 target.

## Validation

- Passed the complete static test suites and full sandboxed Electron runtime suites.
- Added runtime coverage for simultaneous document windows, focused Save routing, independent file monitoring, Follow File isolation, and Preferences separation.
- Retained coverage for the 28 canonical shortcuts and eight startup scenarios.
- Passed the production application build.
- Validated the Flatpak launcher against saved Light, Dark, System, invalid, and missing theme preferences.
- Completed visual acceptance of native Flatpak Light and Dark appearance across application restarts.
- Successfully built the V6 Flatpak development candidate using regenerated offline dependency sources.
- Final V6 release artifacts and publication are separate release-preparation steps.

## Preserved file-safety guarantees

V6 retains Monaco Notepad file protections, including atomic saves, backup-on-save, read-only handling, guarded external file-change decisions, encoding integrity, Safe Open, large-file safeguards, symbolic-link-safe operations, and unsaved-change protection.

Existing text utilities, recovery safeguards, line-ending controls, and document inspection features remain part of the application.

## Platform and scope

- Linux x86_64 remains the only supported architecture.
- AppImage and Flatpak remain the supported package formats.
- Windows, macOS, ARM, ARM64, aarch64, Snap, DEB, and RPM remain unsupported release targets.
- Monaco Notepad remains a text editor rather than an IDE.
- V6 does not introduce tabs, workspaces, project trees, language servers, plugins, cloud accounts, telemetry, or AI features.
