# Axiom Editor

A dark, local-first, browser-based video editing workspace built with plain HTML, CSS, and JavaScript. It is a functional starter editor, not a claim of full Premiere Pro or DaVinci Resolve parity.

## Run it

Axiom uses IndexedDB, OPFS, service workers, and (where supported) the File System Access API. Open it through a local web server or host it on HTTPS; opening `index.html` as a `file://` URL disables important browser features.

**Python:**

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` and choose `axiom-editor/` if you started the server in its parent directory, or serve this folder directly.

Open the localhost URL in a current Chromium-based browser for the best support of local file handles and PWA installation. Install Axiom from the browser menu when the site is served on localhost or HTTPS.

## Included and implemented

- Local-first import of video, audio, and still images, persisted through OPFS when available with IndexedDB fallback.
- Direct folder/file handles in supported browsers, with a normal file-input fallback.
- Editable video/audio tracks, drag-to-place and drag-to-move clips, trim handles, source slip, basic ripple movement, magnetic snapping, clip splitting, duplicate/delete, markers, and additional tracks.
- Program viewer, title overlays, transform and opacity controls, CSS preview grading/effects, adjustment-layer grading for clips below the layer, basic audio clip properties, sequence settings, and a simple serial-grade node list.
- Local IndexedDB project recovery, autosave, undo/redo, project JSON import/export, timeline zoom, custom keyboard bindings and familiar preset mappings.
- Browser canvas recording export to a supported MediaRecorder container. Export runs in real time and depends on browser decode/record support.
- PWA shell caching and optional Whisper Tiny local transcription setup. AI download begins only after the user selects the option and clicks Install. Scene-cut detection uses local frame-difference analysis.

## Important limitations

- Browser codec support varies. Proprietary camera RAW formats, every H.265 profile, ProRes, guaranteed hardware encoder selection, external video I/O, and Avid AAF are not promised.
- Export is real-time Canvas + MediaRecorder, not a frame-exact professional render engine. It does not guarantee embedded audio from camera footage is mixed into the output. Audio clips are mixed where Web Audio and browser playback allow it.
- The viewer currently shows the topmost active video/image clip rather than a full live composite of all overlapping video tracks. Export composites active video tracks, so complex overlapping layers can differ from the on-screen viewer. Grade controls are browser preview filters, not a calibrated 32-bit-float ACES/Rec.2020 mastering pipeline; scope panels are diagnostic-style displays, not reference scopes.
- Keyframes can be added from the inspector and are evaluated with smooth interpolation for supported preview/export parameters. A dedicated curve graph and full Bezier-handle editing are not included yet.
- AI transcription downloads `@huggingface/transformers` and the Whisper model from jsDelivr/Hugging Face on explicit user consent. Browser/WebGPU/WASM compatibility and memory requirements vary; the app does not silently fetch AI files. The scene-cut tool is local and model-free.
- Background proxy generation, multi-user collaboration, proprietary OFX plug-ins, robust planar tracking/rotoscoping, high-end RAW pipelines, multi-monitor hardware control integration, C2PA export signing, and multi-job render queues are not implemented in this baseline.
- Browser origin storage is not an archival backup. Export project JSON regularly and keep original media files.

## Data and privacy

Imported media stays in local browser storage unless users explicitly choose a remote AI model download. There is no media upload endpoint or account backend. The service worker caches the application shell by default and only caches optional AI runtime/model responses after explicit opt-in. Imported media is never cached by the service worker. Linked file handles can require permission again after a browser restart.
