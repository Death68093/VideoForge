# VideoForge

VideoForge is an offline-first, browser-native non-linear video editor designed for static hosting such as GitHub Pages. The current workspace follows the dense three-panel conventions of professional desktop NLEs while keeping the project dependency-free and local.

## Run it

Upload the contents of this folder to a GitHub Pages site. Open the site once while online so the service worker can cache the application shell. After that, the editor can be launched as a standalone PWA and project/media data remains local to the browser profile.

For local development:

```bash
python -m http.server 4173
```

Then open `http://localhost:4173/`.

## Workspace

- Professional three-panel layout: Media / Program / Inspector
- Dense transport and command bars with configurable keyboard shortcuts
- Fully resizable Media / Viewer / Inspector / Timeline workspace with saved layout
- Ctrl/⌘ + Wheel timeline zoom and Shift + Wheel horizontal timeline pan without browser zoom
- Context-sensitive Inspector sections (video, audio, stills, and text only show relevant controls)
- Persistent Editor Settings window for autosave, timeline behavior, playback, appearance, and keybinds
- Media search, type filters, grid/list browser, drag/drop import
- Multi-track video/audio/text timeline with snapping, trim handles, razor, keyframe markers and thumbnails/waveforms
- Track mute, solo, lock, clip selection, frame stepping and loop playback
- Inspector controls for timing, transform, opacity, color, keying, LUTs and typography
- Histogram, waveform and vectorscope monitoring
- Local IndexedDB metadata/project persistence plus OPFS asset copies when supported
- Browser capability detection for WebCodecs, WebGPU and WebGL2
- Local WebM rendering through MediaRecorder + Web Audio; no server upload

## Browser capability note

Browser APIs do not expose a universal native MP4/MOV/AAC encoder/muxer. VideoForge therefore uses browser-native WebM as its portable offline export baseline and detects WebCodecs for lower-level workflows where available. A deterministic MP4/MOV pipeline would require bundling a local codec/muxer implementation, typically through WASM.

Exact hardware acceleration for H.264, HEVC, AV1, and VP9 depends on the browser, operating system, and GPU. VideoForge falls back to media elements when lower-level APIs are unavailable.
