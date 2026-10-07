# Axiom Editor

Axiom Editor is a local-first, browser-native video editor designed to run entirely offline and deploy cleanly to GitHub Pages.

## Core behavior

- PWA installable from GitHub Pages
- IndexedDB project library and local project metadata
- OPFS-backed media copies when the browser exposes OPFS
- No server upload or cloud project requirement
- Multi-track video, audio, and dedicated text tracks
- Timeline scrubbing with draggable playhead
- Clip selection, move, trim, razor/cut, duplicate, copy, paste, and snapping
- `Ctrl+B` cuts the clip at the playhead by default
- `V` selection tool and `B` razor tool
- Custom context menus across the editor
- Persistent editor settings and configurable keybinds
- Resizable workspace panels and timeline
- Arrange Panels mode for dragging the main editor panels into a different order
- Optional color scopes (off by default)
- Context-sensitive Inspector sections
- Color adjustments, chroma key, LUT import, keyframes, typography, audio controls, and effects
- Local AI-assisted object cutout with directional motion tracking
- Text-behind-object setup helper
- Browser-native WebM export with local audio mixing
- WebCodecs/WebGPU/WebGL2 capability detection with compatibility fallbacks

## AI object cutout

Axiom's cutout tool is deliberately offline. It uses a local color-guided segmentation pass around a user-selected object color, an adjustable object range, edge softness, and a directional tracker. It is useful for compositing text behind a subject without uploading footage to a remote service.

It is an assisted local segmentation system, not a hosted cloud AI model. A future model-backed segmentation engine can plug into the same mask structure without changing the project format.

## GitHub Pages

Upload the contents of this directory to a repository and enable GitHub Pages from the branch/folder you use for deployment. All application URLs are relative, so sub-path deployments work.

Open the deployed app once while online so the service worker can cache the application shell. After that, the editor interface remains available offline from the installed PWA/browser cache.

## Icons

The PWA uses:

- `icons/icon-192.png`
- `icons/icon-512.png`

There are no duplicate icon files at the project root.

## Browser APIs

Axiom progressively detects and uses IndexedDB, OPFS, WebCodecs, WebGPU, WebGL2, MediaRecorder, Canvas 2D, and Web Audio when available. Browsers without the advanced APIs use compatibility fallbacks rather than requiring a server.
