/*
 * Axiom Editor — browser-native offline NLE
 * No runtime dependencies. Built for static hosting (GitHub Pages).
 *
 * The editor intentionally uses progressive enhancement:
 * - HTMLMediaElement is the compatibility decoder.
 * - WebCodecs/WebGPU are detected and reported when available.
 * - IndexedDB is the project/asset metadata store.
 * - OPFS receives a local asset copy when the browser exposes it.
 * - MediaRecorder provides a broadly compatible local WebM exporter.
 */

const $ = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
const lerp = (a, b, t) => a + (b - a) * t;

const DB_NAME = 'VideoForgeDB';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_ASSETS = 'assets';
const STORE_SETTINGS = 'settings';

const DEFAULT_KEYBINDS = {
  save: 'Ctrl+S', undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', play: 'Space', stop: 'K',
  framePrev: 'ArrowLeft', frameNext: 'ArrowRight', selectTool: 'V', razorTool: 'B', cutClip: 'Ctrl+B',
  deleteClip: 'Delete', markIn: 'I', markOut: 'O', clearRange: 'X', zoomIn: 'Ctrl+=', zoomOut: 'Ctrl+-',
  export: 'Ctrl+E', settings: 'Ctrl+,', fullscreen: 'Ctrl+Shift+F', focusTimeline: 'F6'
};
const KEYBIND_META = [
  ['save','Save project'],['undo','Undo'],['redo','Redo'],['play','Play / pause'],['stop','Stop'],
  ['framePrev','Previous frame'],['frameNext','Next frame'],['selectTool','Selection tool'],['razorTool','Razor tool'],['cutClip','Cut at playhead'],
  ['deleteClip','Delete selected clip'],['markIn','Mark In'],['markOut','Mark Out'],['clearRange','Clear In / Out'],
  ['zoomIn','Timeline zoom in'],['zoomOut','Timeline zoom out'],['export','Export'],['settings','Open settings'],
  ['fullscreen','Fullscreen'],['focusTimeline','Focus timeline']
];
const DEFAULT_EDITOR_SETTINGS = {
  leftWidth: 310, rightWidth: 320, timelineHeight: 320, timelineZoom: 100,
  autosave: true, autosaveInterval: 3, confirmDelete: false, showScopes: false, reduceMotion: false,
  trackHeight: 60, snap: true, followPlayhead: false, shiftPan: true, loopPlayback: false, frameStep: 1,
  accent: '#d9ff5f', panelVisibility: { media: true, preview: true, scopes: false, inspector: true, timeline: true }, panelOrder: ['media','preview','inspector'], keybinds: { ...DEFAULT_KEYBINDS }
};

const state = {
  db: null,
  project: null,
  assetMeta: new Map(),
  assetFiles: new Map(),
  assetUrls: new Map(),
  media: new Map(),
  thumbnails: new Map(),
  selectedClipId: null,
  playing: false,
  playStartedAt: 0,
  playOffset: 0,
  currentTime: 0,
  lastRenderAt: 0,
  raf: 0,
  timelineZoom: 100,
  snap: true,
  tool: 'select',
  drag: null,
  inPoint: null,
  outPoint: null,
  undo: [],
  redo: [],
  autosaveTimer: 0,
  lutCache: new Map(),
  runtimeAudioBuffers: new Map(),
  audioContext: null,
  previewAudioSources: [],
  previewAudioGeneration: 0,
  gpu: { webgpu: false, webgl2: false },
  pwaDeferredPrompt: null,
  fullscreen: false,
  loopPlayback: false,
  selectedAssetId: null,
  mediaFilter: 'all',
  mediaSearch: '',
  assetView: 'grid',
  lastScopeRender: 0,
  editorSettings: structuredClone(DEFAULT_EDITOR_SETTINGS),
  keybindCapture: null,
  resizeDrag: null,
  dashboardMode: false,
  dashboardFilter: 'recent',
  dashboardSearch: '',
  panelDragId: null,
  panelArrangeMode: false,
  contextTarget: null,
  clipboardClip: null,
  aiCutout: { sampled: null, picking: false, clipId: null, sourcePoint: null },
};

const canvas = $('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const timelineCanvas = $('timelineCanvas');
const tctx = timelineCanvas.getContext('2d');
const histogramCanvas = $('histogramCanvas');
const waveformCanvas = $('waveformCanvas');
const vectorscopeCanvas = $('vectorscopeCanvas');
const clipLayerCanvas = document.createElement('canvas');
const clipLayerCtx = clipLayerCanvas.getContext('2d', { alpha: true });

function defaultTrack(type, index) {
  const prefix = type === 'video' ? 'V' : type === 'audio' ? 'A' : 'T';
  return {
    id: uid('track'),
    type,
    name: `${prefix}${index}`,
    muted: false,
    solo: false,
    locked: false,
    clips: []
  };
}

function makeProject(opts = {}) {
  const width = Number(opts.width) || 1920;
  const height = Number(opts.height) || 1080;
  const fps = Number(opts.fps) || 30;
  const duration = Number(opts.duration) || 30;
  return {
    schema: 1,
    id: uid('project'),
    name: opts.name || 'Untitled',
    width,
    height,
    fps,
    duration,
    pixelRatio: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: [defaultTrack('video', 1), defaultTrack('video', 2), defaultTrack('text', 1), defaultTrack('audio', 1)],
    settings: {
      rack: { low: 0, mid: 0, high: 0, comp: 0.25, reverb: 0, duck: false },
      background: '#090c12'
    }
  };
}

async function openDatabase() {
  if (state.db) return state.db;
  state.db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return state.db;
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function saveProject(silent=false) {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  try {
    if (canvas?.width && canvas?.height && (!state.project.thumbnail || Date.now() - (state.project.thumbnailAt || 0) > 15000)) {
      const thumb = document.createElement('canvas'); thumb.width=320; thumb.height=180;
      const t=thumb.getContext('2d'); t.fillStyle='#080a0d'; t.fillRect(0,0,320,180); t.drawImage(canvas,0,0,320,180);
      state.project.thumbnail=thumb.toDataURL('image/jpeg',.72); state.project.thumbnailAt=Date.now();
    }
  } catch {}
  await idbPut(STORE_PROJECTS, structuredClone(state.project));
  if (!silent) toast('Video saved locally.', 'good');
  if (state.dashboardMode) renderDashboard();
}

async function loadProject(project) {
  state.project = project;
  state.project.tracks = Array.isArray(state.project.tracks) ? state.project.tracks : [];
  if (!state.project.tracks.some(t => t.type === 'text')) state.project.tracks.splice(Math.min(2, state.project.tracks.length), 0, defaultTrack('text', 1));
  state.selectedClipId = null;
  state.currentTime = 0;
  state.inPoint = null;
  state.outPoint = null;
  state.undo.length = 0;
  state.redo.length = 0;
  ensureProjectDuration();
  updateUI();
  render();
}

async function saveSettings() {
  const s = state.editorSettings;
  await idbPut(STORE_SETTINGS, {
    key: 'editor',
    projectId: state.project?.id || null,
    ...structuredClone(s),
    rack: state.project?.settings?.rack || null
  });
}

function mergeEditorSettings(raw = {}) {
  const merged = { ...structuredClone(DEFAULT_EDITOR_SETTINGS), ...raw, panelVisibility: { ...DEFAULT_EDITOR_SETTINGS.panelVisibility, ...(raw.panelVisibility || {}) }, panelOrder: Array.isArray(raw.panelOrder) ? raw.panelOrder.filter(x => ['media','preview','inspector'].includes(x)) : [...DEFAULT_EDITOR_SETTINGS.panelOrder], keybinds: { ...DEFAULT_KEYBINDS, ...(raw.keybinds || {}) } };
  if ((raw.workspaceVersion || 0) < 2) { merged.showScopes = false; merged.panelVisibility.scopes = false; }
  merged.workspaceVersion = 3;
  merged.panelArrangeMode = false;
  for (const id of ['media','preview','inspector']) if (!merged.panelOrder.includes(id)) merged.panelOrder.push(id);
  state.editorSettings = merged;
  state.timelineZoom = Number(merged.timelineZoom) || 100;
  state.snap = merged.snap !== false;
  state.loopPlayback = !!merged.loopPlayback;
  applyEditorSettingsToUI();
}

function applyEditorSettingsToUI() {
  const s = state.editorSettings;
  const root = document.documentElement;
  root.style.setProperty('--left-w', `${clamp(Number(s.leftWidth) || 310, 220, 520)}px`);
  root.style.setProperty('--right-w', `${clamp(Number(s.rightWidth) || 320, 240, 520)}px`);
  root.style.setProperty('--timeline-h', `${clamp(Number(s.timelineHeight) || 320, 220, Math.max(300, window.innerHeight * .68))}px`);
  root.style.setProperty('--accent', s.accent || DEFAULT_EDITOR_SETTINGS.accent);
  root.style.setProperty('--accent-strong', s.accent || DEFAULT_EDITOR_SETTINGS.accent);
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  state.panelArrangeMode = false;
  document.body.classList.toggle('panel-arrange-mode', false);
  $('scopesPanel')?.classList.toggle('hidden', !s.showScopes || s.panelVisibility?.scopes === false);
  $('scopesPanel')?.closest('.center-stage')?.classList.toggle('scopes-hidden', !s.showScopes || s.panelVisibility?.scopes === false);
  $('centerStage')?.classList.toggle('scopes-above', s.scopesPosition === 'top');
  $('app')?.classList.toggle('timeline-top', s.timelineDock === 'top');
  applyPanelLayout();
  state.snap = !!s.snap;
  state.loopPlayback = !!s.loopPlayback;
  if ($('timelineZoomLabel')) $('timelineZoomLabel').textContent = `${state.timelineZoom}%`;
  if ($('snappingBtn')) $('snappingBtn').classList.toggle('active', state.snap);
  if ($('loopBtn')) $('loopBtn').classList.toggle('active', state.loopPlayback);
}

async function restoreLastProject() {
  const settings = await idbGet(STORE_SETTINGS, 'editor').catch(() => null);
  mergeEditorSettings(settings || {});
  if (settings?.projectId) {
    const p = await idbGet(STORE_PROJECTS, settings.projectId).catch(() => null);
    if (p) { if (settings.rack) p.settings = { ...(p.settings || {}), rack: { ...(p.settings?.rack || {}), ...settings.rack } }; await loadProject(p); return; }
  }
  const projects = await idbGetAll(STORE_PROJECTS);
  if (projects.length) {
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await loadProject(projects[0]);
    return;
  }
  await loadProject(makeProject());
  await saveProject();
}


async function storeAssetFile(id, file) {
  await idbPut(STORE_ASSETS, {
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    blob: file
  });
}

async function writeOPFSAsset(id, file) {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('VideoForgeAssets', { create: true });
    const handle = await dir.getFileHandle(id.replaceAll(':', '_'), { create: true });
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable);
    return true;
  } catch (err) {
    console.warn('OPFS write failed', err);
    return false;
  }
}

async function importFiles(files) {
  if (!files?.length) return;
  let imported = 0;
  for (const file of files) {
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/') && !file.type.startsWith('image/')) continue;
    const asset = await inspectFile(file);
    state.assetMeta.set(asset.id, asset.meta);
    state.assetFiles.set(asset.id, file);
    state.assetUrls.set(asset.id, URL.createObjectURL(file));
    await storeAssetFile(asset.id, file);
    writeOPFSAsset(asset.id, file).catch(() => {});
    await makeThumbnail(asset.id, file, asset.meta);
    if (!state.project.tracks.length) state.project.tracks.push(defaultTrack('video', 1));
    imported++;
  }
  renderAssets();
  if (imported) toast(`${imported} media asset${imported === 1 ? '' : 's'} imported locally.`, 'good');
  saveProject().catch(console.error);
}

async function restoreAssetsForProject() {
  const all = await idbGetAll(STORE_ASSETS);
  for (const a of all) {
    if (!a?.blob) continue;
    state.assetMeta.set(a.id, { name: a.name, type: a.type, size: a.size, duration: 0 });
    state.assetFiles.set(a.id, a.blob);
    state.assetUrls.set(a.id, URL.createObjectURL(a.blob));
    try { await inspectBlobIntoMeta(a.id, a.blob); } catch {}
  }
  renderAssets();
}

function inspectFile(file) {
  return new Promise(resolve => {
    const id = uid('asset');
    const meta = { id, name: file.name, type: file.type, size: file.size, kind: file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image', duration: 0, width: 0, height: 0, fps: 0 };
    if (meta.kind === 'image') {
      const img = new Image();
      img.onload = () => resolve({ id, meta: { ...meta, width: img.naturalWidth, height: img.naturalHeight } });
      img.src = URL.createObjectURL(file);
      return;
    }
    const el = document.createElement(meta.kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      resolve({ id, meta: { ...meta, duration: Number.isFinite(el.duration) ? el.duration : 0, width: el.videoWidth || 0, height: el.videoHeight || 0 } });
      el.remove();
    };
    el.onerror = () => {
      resolve({ id, meta });
      el.remove();
    };
    el.src = URL.createObjectURL(file);
  });
}

async function inspectBlobIntoMeta(id, blob) {
  const old = state.assetMeta.get(id) || { id, name: blob.name || id, type: blob.type, size: blob.size };
  const kind = blob.type.startsWith('video/') ? 'video' : blob.type.startsWith('audio/') ? 'audio' : 'image';
  old.kind = kind;
  if (kind === 'image') {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = state.assetUrls.get(id); });
    old.width = img.naturalWidth; old.height = img.naturalHeight;
  } else {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.muted = true;
    await new Promise(resolve => {
      el.onloadedmetadata = () => { old.duration = Number.isFinite(el.duration) ? el.duration : 0; old.width = el.videoWidth || 0; old.height = el.videoHeight || 0; resolve(); };
      el.onerror = resolve;
      el.src = state.assetUrls.get(id);
    });
    el.remove();
  }
  state.assetMeta.set(id, old);
}

async function makeThumbnail(id, file, meta) {
  try {
    if (meta.kind === 'image') {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = state.assetUrls.get(id); });
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const cctx = c.getContext('2d'); coverDraw(cctx, img, 0, 0, c.width, c.height);
      state.thumbnails.set(id, c.toDataURL('image/jpeg', .72));
      return;
    }
    const el = document.createElement(meta.kind === 'video' ? 'video' : 'audio');
    el.src = state.assetUrls.get(id); el.preload = 'metadata'; el.muted = true;
    await new Promise(resolve => { el.onloadedmetadata = resolve; el.onerror = resolve; });
    if (meta.kind === 'video') {
      const target = Math.min(Math.max(meta.duration * .08, 0.05), Math.max(meta.duration - .05, .05));
      await seekMedia(el, target).catch(() => {});
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      coverDraw(c.getContext('2d'), el, 0, 0, c.width, c.height);
      state.thumbnails.set(id, c.toDataURL('image/jpeg', .72));
    } else {
      state.thumbnails.set(id, createAudioThumb());
    }
    el.remove();
  } catch {}
}

function createAudioThumb() {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const cctx = c.getContext('2d');
  cctx.fillStyle = '#10161e'; cctx.fillRect(0, 0, c.width, c.height);
  cctx.strokeStyle = '#6d8d2c'; cctx.lineWidth = 2;
  cctx.beginPath();
  for (let x = 0; x < c.width; x++) {
    const y = c.height / 2 + Math.sin(x * .12) * 18 * (0.3 + Math.sin(x*.017)**2);
    x ? cctx.lineTo(x, y) : cctx.moveTo(x, y);
  }
  cctx.stroke();
  return c.toDataURL('image/png');
}

function ensureMedia(assetId, kind) {
  if (state.media.has(assetId)) return state.media.get(assetId);
  const src = state.assetUrls.get(assetId);
  if (!src) return null;
  let el;
  if (kind === 'image') {
    el = new Image(); el.decoding='async'; el.onload=()=>render(); el.src=src;
  } else {
    el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload='auto'; el.muted=true; el.playsInline=true; el.src=src;
    if (kind === 'video') el.addEventListener('loadeddata',()=>render(),{once:true});
  }
  state.media.set(assetId, el);
  return el;
}

async function seekMedia(el, time) {
  const target = clamp(time, 0, Math.max(0, (el.duration || Infinity) - 0.0001));
  if (Math.abs((el.currentTime || 0) - target) < .008) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', finish); resolve(); };
    el.addEventListener('seeked', finish, { once: true });
    el.currentTime = target;
    setTimeout(finish, 120);
  });
}

function coverDraw(targetCtx, source, x, y, w, h) {
  const sw = source.videoWidth || source.naturalWidth || source.width || w;
  const sh = source.videoHeight || source.naturalHeight || source.height || h;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale, dh = sh * scale;
  targetCtx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function fitTransform(clip, meta) {
  const sw = meta?.width || state.project.width;
  const sh = meta?.height || state.project.height;
  const scale = Math.min(state.project.width / sw, state.project.height / sh);
  return {
    x: Number.isFinite(clip.transform?.x) ? clip.transform.x : state.project.width / 2,
    y: Number.isFinite(clip.transform?.y) ? clip.transform.y : state.project.height / 2,
    scale: (clip.transform?.scale || 1) * scale,
    rotation: clip.transform?.rotation || 0
  };
}

function newClip(assetId, trackId, start = state.currentTime) {
  const meta = state.assetMeta.get(assetId);
  const duration = Math.max(0.05, Number(meta?.duration) || 5);
  const type = meta?.kind === 'audio' ? 'audio' : meta?.kind === 'image' ? 'image' : 'video';
  return {
    id: uid('clip'),
    assetId,
    trackId,
    type,
    name: meta?.name || 'Clip',
    start: Math.max(0, start),
    duration: type === 'image' ? 5 : duration,
    sourceStart: 0,
    sourceDuration: duration,
    speed: 1,
    transform: { x: state.project.width / 2, y: state.project.height / 2, scale: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    blend: 'source-over',
    effects: {
      brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0,
      grayscale: 0, sepia: 0, keyStrength: 0, keyColor: '#00ff00', vignette: 0, zoom: 0, glitch: 0,
      lift: 0, gamma: 1, gain: 1
    },
    keyframes: { opacity: [], x: [], y: [], scale: [], rotation: [], volume: [] },
    text: type === 'text' ? { content: 'Axiom Editor', size: 72, weight: 700, color: '#ffffff', stroke: '#000000', strokeWidth: 0, tracking: 0 } : null,
    lut: null
  };
}

function insertAssetIntoTimeline(assetId) {
  if (!state.project) return;
  const meta = state.assetMeta.get(assetId);
  if (!meta) return;
  let track = state.project.tracks.find(t => t.type === (meta.kind === 'audio' ? 'audio' : 'video') && !t.locked);
  if (!track) {
    track = defaultTrack(meta.kind === 'audio' ? 'audio' : 'video', state.project.tracks.filter(t => t.type === (meta.kind === 'audio' ? 'audio' : 'video')).length + 1);
    state.project.tracks.push(track);
  }
  const clip = newClip(assetId, track.id, snapTime(state.currentTime));
  pushUndo();
  track.clips.push(clip);
  state.selectedClipId = clip.id;
  state.selectedAssetId = assetId;
  ensureProjectDuration();
  updateUI();
  render();
  saveProjectSoon();
}

function addTextClip() {
  const track = state.project.tracks.find(t => t.type === 'text' && !t.locked) || (() => { const t = defaultTrack('text', state.project.tracks.filter(x => x.type === 'text').length + 1); state.project.tracks.unshift(t); return t; })();
  const clip = {
    id: uid('clip'), assetId: null, trackId: track.id, type: 'text', name: 'Title',
    start: snapTime(state.currentTime), duration: 5, sourceStart: 0, sourceDuration: 5, speed: 1,
    transform: { x: state.project.width / 2, y: state.project.height / 2, scale: 1, rotation: 0 }, opacity: 1, volume: 0, blend: 'source-over',
    effects: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0, sepia: 0, keyStrength: 0, keyColor: '#00ff00', vignette: 0, zoom: 0, glitch: 0, lift: 0, gamma: 1, gain: 1 },
    keyframes: { opacity: [], x: [], y: [], scale: [], rotation: [], volume: [] },
    text: { content: 'Axiom Editor', size: 72, weight: 700, color: '#ffffff', stroke: '#000000', strokeWidth: 0, tracking: 0 }, lut: null
  };
  pushUndo(); track.clips.push(clip); state.selectedClipId = clip.id; ensureProjectDuration(); updateUI(); render(); saveProjectSoon();
}

function getSelectedClip() {
  for (const t of state.project?.tracks || []) {
    const c = t.clips.find(c => c.id === state.selectedClipId);
    if (c) return c;
  }
  return null;
}

function getTrackById(id) { return state.project?.tracks.find(t => t.id === id) || null; }
function getAssetMeta(id) { return id ? state.assetMeta.get(id) : null; }
function getClipAtTime(track, time) { return track.clips.find(c => time >= c.start && time < c.start + c.duration); }

function selectedClipTrack() { const c = getSelectedClip(); return c ? getTrackById(c.trackId) : null; }

function snapshotProject() { return structuredClone(state.project); }
function pushUndo() {
  if (!state.project) return;
  state.undo.push(snapshotProject());
  if (state.undo.length > 60) state.undo.shift();
  state.redo.length = 0;
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshotProject());
  state.project = state.undo.pop();
  state.selectedClipId = null;
  updateUI(); render(); saveProjectSoon();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshotProject());
  state.project = state.redo.pop();
  state.selectedClipId = null;
  updateUI(); render(); saveProjectSoon();
}

function saveProjectSoon() {
  if (state.editorSettings?.autosave === false) return;
  clearTimeout(state.autosaveTimer);
  const delay = clamp(Number(state.editorSettings?.autosaveInterval || 3) * 1000, 250, 60000);
  state.autosaveTimer = setTimeout(() => saveProject(true).catch(console.error), delay);
}

function ensureProjectDuration() {
  let max = state.project.duration || 0;
  for (const t of state.project.tracks) for (const c of t.clips) max = Math.max(max, c.start + c.duration);
  state.project.duration = Math.max(1, Math.ceil(max * 1000) / 1000);
}

function snapTime(t) {
  t = Math.max(0, t);
  if (!state.snap) return t;
  const step = 1 / state.project.fps;
  const points = [0, state.currentTime, ...(state.project.tracks.flatMap(tk => tk.clips.flatMap(c => [c.start, c.start + c.duration]))), state.inPoint, state.outPoint].filter(v => Number.isFinite(v));
  let best = t, dist = step * .75;
  for (const p of points) if (Math.abs(p - t) < dist) { best = p; dist = Math.abs(p - t); }
  return best;
}

function evalKeyframes(clip, prop, time, fallback) {
  const keys = clip.keyframes?.[prop];
  if (!keys?.length) return fallback;
  const local = time - clip.start;
  if (local <= keys[0].t) return keys[0].v;
  if (local >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (local >= a.t && local <= b.t) {
      const f = b.t === a.t ? 0 : (local - a.t) / (b.t - a.t);
      return lerp(Number(a.v), Number(b.v), f);
    }
  }
  return fallback;
}

function setKeyframe(clip, prop) {
  if (!clip.keyframes) clip.keyframes = {};
  if (!clip.keyframes[prop]) clip.keyframes[prop] = [];
  const value = currentPropertyValue(clip, prop);
  const local = clamp(state.currentTime - clip.start, 0, clip.duration);
  const keys = clip.keyframes[prop];
  const existing = keys.find(k => Math.abs(k.t - local) < 0.002);
  if (existing) existing.v = value; else keys.push({ t: local, v: value });
  keys.sort((a, b) => a.t - b.t);
}

function currentPropertyValue(clip, prop) {
  switch (prop) {
    case 'opacity': return clip.opacity;
    case 'x': return clip.transform.x;
    case 'y': return clip.transform.y;
    case 'scale': return clip.transform.scale;
    case 'rotation': return clip.transform.rotation;
    case 'volume': return clip.volume;
    default: return 0;
  }
}

function activeProperty(clip, prop) { return evalKeyframes(clip, prop, state.currentTime, currentPropertyValue(clip, prop)); }

function removeSelectedClip() {
  const c = getSelectedClip();
  if (!c) return;
  const track = getTrackById(c.trackId);
  if (!track) return;
  if (state.editorSettings.confirmDelete && !confirm(`Delete “${c.name}”?`)) return;
  pushUndo();
  track.clips = track.clips.filter(x => x.id !== c.id);
  state.selectedClipId = null;
  ensureProjectDuration(); updateUI(); render(); saveProjectSoon();
}

function cutSelectedClipAtPlayhead(){
  const c=getSelectedClip();
  if(c){ splitSelectedClip(); return; }
  const active=state.project?.tracks.map(t=>t.clips.find(x=>state.currentTime>=x.start&&state.currentTime<x.start+x.duration)).find(Boolean);
  if(active){state.selectedClipId=active.id;splitSelectedClip();}else toast('Place the playhead over a clip to cut it.','error');
}

function splitSelectedClip() {
  const c = getSelectedClip();
  if (!c) { toast('Select a clip first.', 'error'); return; }
  if (state.currentTime <= c.start + .001 || state.currentTime >= c.start + c.duration - .001) { toast('Place the playhead inside the selected clip.', 'error'); return; }
  const track = getTrackById(c.trackId); if (!track || track.locked) return;
  pushUndo();
  const leftDur = state.currentTime - c.start;
  const right = structuredClone(c);
  right.id = uid('clip'); right.name = `${c.name} — split`;
  right.start = state.currentTime;
  right.sourceStart = c.sourceStart + leftDur * c.speed;
  right.sourceDuration = Math.max(0.01, c.sourceDuration - leftDur * c.speed);
  right.duration = Math.max(0.01, c.duration - leftDur);
  c.duration = leftDur;
  c.sourceDuration = Math.max(0.01, leftDur * c.speed);
  track.clips.push(right);
  state.selectedClipId = right.id;
  ensureProjectDuration(); updateUI(); render(); saveProjectSoon();
}

function addTrack(type) {
  pushUndo();
  const count = state.project.tracks.filter(t => t.type === type).length;
  state.project.tracks.unshift(defaultTrack(type, count + 1));
  updateUI(); render(); saveProjectSoon();
}

function deleteTrack(trackId) {
  if (state.project.tracks.length <= 1) return;
  pushUndo(); state.project.tracks = state.project.tracks.filter(t => t.id !== trackId);
  if (state.selectedClipId && !state.project.tracks.some(t => t.clips.some(c => c.id === state.selectedClipId))) state.selectedClipId = null;
  updateUI(); render(); saveProjectSoon();
}

function splitEffect(name) {
  const c = getSelectedClip();
  if (!c) { toast('Select a clip before applying an effect.', 'error'); return; }
  pushUndo();
  switch (name) {
    case 'fade': c.effects.fade = true; break;
    case 'dissolve': c.effects.dissolve = true; break;
    case 'zoom': c.effects.zoom = .12; break;
    case 'film': c.effects.saturation = -.12; c.effects.contrast = .12; c.effects.grain = .08; break;
    case 'mono': c.effects.grayscale = 1; break;
    case 'glitch': c.effects.glitch = .12; break;
    case 'vignette': c.effects.vignette = .5; break;
    case 'chroma': c.effects.keyStrength = Math.max(c.effects.keyStrength || 0, .75); break;
  }
  updateUI(); render(); saveProjectSoon();
}

function applyProp(prop, value) {
  const c = getSelectedClip(); if (!c) return;
  pushUndo();
  value = Number(value);
  switch (prop) {
    case 'start': c.start = Math.max(0, value); break;
    case 'duration': c.duration = Math.max(.01, value); break;
    case 'sourceStart': c.sourceStart = Math.max(0, value); break;
    case 'speed': c.speed = Math.max(.05, value); break;
    case 'x': c.transform.x = value; break;
    case 'y': c.transform.y = value; break;
    case 'scale': c.transform.scale = Math.max(.01, value); break;
    case 'rotation': c.transform.rotation = value; break;
    case 'opacity': c.opacity = clamp(value, 0, 1); break;
    case 'volume': c.volume = clamp(value, 0, 2); break;
    case 'pan': c.pan = clamp(value, -1, 1); break;
  }
  ensureProjectDuration(); updateInspector(); render(); saveProjectSoon();
}

function configureInput(id, fn, event = 'change') { $(id).addEventListener(event, e => fn(e.target.value, e)); }

function selectedClipChanged() { updateInspector(); renderTimeline(); render(); }

function updateUI() {
  $('projectNameView').textContent = state.project.name;
  $('projectFormatView').textContent = `${state.project.width}×${state.project.height} · ${state.project.fps} fps`;
  $('projectNameInput').value = state.project.name;
  $('projectWidth').value = state.project.width;
  $('projectHeight').value = state.project.height;
  $('projectFps').value = state.project.fps;
  $('projectPixelRatio').value = state.project.pixelRatio || 1;
  $('exportFps').value = state.project.fps;
  $('timelineZoomLabel').textContent = `${state.timelineZoom}%`;
  $('storageStatus').textContent = navigator.storage?.getDirectory ? 'IndexedDB + OPFS' : 'IndexedDB';
  const pfs = $('projectFormatStatus'); if (pfs) pfs.textContent = `${Math.round(state.project.width)}×${Math.round(state.project.height)} / ${state.project.fps}`;
  $('engineBadge').textContent = state.gpu.webgpu ? 'WebGPU' : state.gpu.webgl2 ? 'WebGL2' : 'Canvas';
  $('gpuStatus').textContent = state.gpu.webgpu ? 'WebGPU ready' : state.gpu.webgl2 ? 'WebGL2 ready' : 'Canvas 2D';
  renderAssets(); renderTrackHeaders(); updateInspector(); updateTimecode(); renderTimeline();
}

function mediaMatchesFilter(meta) {
  if (state.mediaFilter === 'video') return meta.kind === 'video';
  if (state.mediaFilter === 'audio') return meta.kind === 'audio';
  if (state.mediaFilter === 'stills') return meta.kind === 'image';
  return true;
}

function renderAssets() {
  const grid = $('assetGrid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.classList.toggle('list-view', state.assetView === 'list');
  const query = String(state.mediaSearch || '').trim().toLowerCase();
  const entries = [...state.assetMeta.values()]
    .filter(mediaMatchesFilter)
    .filter(meta => !query || meta.name.toLowerCase().includes(query))
    .sort((a,b) => a.name.localeCompare(b.name));
  const allCount = state.assetMeta.size;
  const countEl = $('assetCount');
  if (countEl) countEl.textContent = `${entries.length} ${entries.length === 1 ? 'item' : 'items'}${entries.length !== allCount ? ` · ${allCount} total` : ''}`;
  $('assetEmpty').classList.toggle('hidden', entries.length > 0);
  for (const meta of entries) {
    const card = document.createElement('div');
    card.className = `asset-card${state.selectedAssetId === meta.id ? ' selected' : ''}`;
    card.dataset.assetId = meta.id;
    const thumb = document.createElement('img');
    thumb.className = 'asset-thumb'; thumb.alt = ''; thumb.draggable = false;
    thumb.src = state.thumbnails.get(meta.id) || createAudioThumb();
    const md = document.createElement('div'); md.className = 'asset-meta';
    const nm = document.createElement('div'); nm.className = 'asset-name'; nm.textContent = meta.name;
    const type = document.createElement('div'); type.className = 'asset-type';
    type.textContent = `${meta.kind}${meta.duration ? ` · ${fmtSeconds(meta.duration)}` : ''}${meta.width ? ` · ${meta.width}×${meta.height}` : ''}`;
    md.append(nm, type);
    card.append(thumb, md);
    grid.append(card);
    card.addEventListener('click', () => { state.selectedAssetId = meta.id; renderAssets(); });
    card.addEventListener('dblclick', () => insertAssetIntoTimeline(meta.id));
    card.draggable = true;
    card.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', meta.id));
  }
}

function renderTrackHeaders() {
  const col = $('trackHeaderColumn');
  col.innerHTML = '';
  const spacer=document.createElement('div'); spacer.className='track-header-spacer'; col.append(spacer);
  for (const track of state.project.tracks) {
    const row = document.createElement('div'); row.className = 'track-header'; row.dataset.trackId = track.id; row.style.height = `${timelineRowHeight()}px`;
    const name = document.createElement('strong'); name.textContent = track.name;
    const type = document.createElement('div'); type.className = 'track-type'; type.textContent = track.type === 'text' ? 'Text' : track.type === 'video' ? 'Video' : 'Audio';
    const actions = document.createElement('div'); actions.className = 'track-actions';
    const buttons = [['M','Mute','muted'],['S','Solo','solo'],['L','Lock','locked']];
    for (const [label,title,prop] of buttons) {
      const b=document.createElement('button'); b.textContent=label; b.title=title; b.className=track[prop]?'active':'';
      b.onclick=()=>{pushUndo();track[prop]=!track[prop];updateUI();render();saveProjectSoon();}; actions.append(b);
    }
    row.append(name, actions, type); col.append(row);
  }
  col.onclick=(e)=>{const header=e.target.closest('.track-header');if(!header||e.target.tagName==='BUTTON')return;const id=header.dataset.trackId;const track=getTrackById(id);if(e.detail===2&&track?.clips.length===0)deleteTrack(id);};
}

function updateInspector() {
  const c = getSelectedClip();
  $('inspectorEmpty').classList.toggle('hidden', !!c);
  $('inspectorBody').classList.toggle('hidden', !c);
  if (!c) return;
  $('selectedClipName').textContent = c.name;
  $('selectedClipType').textContent = c.type;
  $('propStart').value = c.start.toFixed(3);
  $('propDuration').value = c.duration.toFixed(3);
  $('propSourceStart').value = (c.sourceStart || 0).toFixed(3);
  $('propSpeed').value = (c.speed || 1).toFixed(2);
  $('propX').value = Math.round(c.transform?.x ?? state.project.width/2);
  $('propY').value = Math.round(c.transform?.y ?? state.project.height/2);
  $('propScale').value = (c.transform?.scale ?? 1).toFixed(3);
  $('propRotation').value = Math.round(c.transform?.rotation ?? 0);
  $('propOpacity').value = activeProperty(c, 'opacity');
  $('propOpacityOut').value = `${Math.round(activeProperty(c, 'opacity') * 100)}%`;
  $('fxBrightness').value = c.effects.brightness || 0;
  $('fxContrast').value = c.effects.contrast || 0;
  $('fxSaturation').value = c.effects.saturation || 0;
  $('fxHue').value = c.effects.hue || 0;
  $('fxBlur').value = c.effects.blur || 0;
  $('fxKeyStrength').value = c.effects.keyStrength || 0;
  $('fxKeyColor').value = c.effects.keyColor || '#00ff00';
  $('lutName').textContent = c.lut?.name || 'No LUT';

  const isAudio = c.type === 'audio';
  const isText = c.type === 'text';
  const isVisual = !isAudio;
  $('transformInspectorSection').classList.toggle('hidden', !isVisual);
  $('colorInspectorSection').classList.toggle('hidden', !isVisual || isText);
  $('keyLutInspectorSection').classList.toggle('hidden', !isVisual || isText);
  $('aiInspector').classList.toggle('hidden', !isVisual || isText);
  $('audioInspector').classList.toggle('hidden', !isAudio);
  $('textInspector').classList.toggle('hidden', !isText);

  if (isAudio) {
    const volume = clamp(Number(c.volume ?? 1), 0, 2);
    const pan = clamp(Number(c.pan ?? 0), -1, 1);
    $('propVolume').value = volume;
    $('propVolumeOut').value = `${Math.round(volume * 100)}%`;
    $('propPan').value = pan;
    $('propPanOut').value = pan === 0 ? 'Center' : `${Math.round(pan * 100)}% ${pan < 0 ? 'L' : 'R'}`;
  }
  if (isText) {
    $('textContent').value = c.text?.content || '';
    $('textSize').value = c.text?.size || 72;
    $('textWeight').value = c.text?.weight || 700;
    $('textColor').value = c.text?.color || '#ffffff';
    $('textStroke').value = c.text?.stroke || '#000000';
    $('textTracking').value = c.text?.tracking || 0;
    $('textStrokeWidth').value = c.text?.strokeWidth || 0;
  }
}

function updateTimecode() {
  $('timecode').textContent = formatTimecode(state.currentTime, state.project.fps);
  const c = getSelectedClip();
  $('selectionInfo').textContent = c ? `${c.name} · ${fmtSeconds(c.duration)}` : 'No selection';
}

function setCurrentTime(time) {
  state.currentTime = clamp(time, 0, state.project.duration);
  updateTimecode();
  updateInspector();
  render();
  renderTimeline(false);
}

function formatTimecode(seconds, fps) {
  seconds = Math.max(0, seconds || 0);
  const frames = Math.floor((seconds % 1) * fps + 1e-5);
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(frames).padStart(2,'0')}`;
}

function fmtSeconds(s) {
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2,'0')}:${sec.toFixed(2).padStart(5,'0')}`;
}

function render() {
  if (!state.project) return;
  canvas.width = Math.round(state.project.width * (state.project.pixelRatio || 1));
  canvas.height = Math.round(state.project.height * (state.project.pixelRatio || 1));
  ctx.save();
  ctx.scale(state.project.pixelRatio || 1, state.project.pixelRatio || 1);
  ctx.fillStyle = state.project.settings.background || '#090c12';
  ctx.fillRect(0,0,state.project.width,state.project.height);
  ctx.restore();

  const soloTracks = state.project.tracks.filter(t => t.solo);
  for (const track of [...state.project.tracks].reverse()) {
    if (track.muted || (soloTracks.length && !track.solo)) continue;
    const clip = getClipAtTime(track, state.currentTime);
    if (!clip) continue;
    renderClip(clip);
  }
  drawViewerGrid();
  const scopeNow = performance.now();
  if (!state.playing || scopeNow - state.lastScopeRender > 90) { updateScopes(); state.lastScopeRender = scopeNow; }
  const hasVideoContent = state.project.tracks.some(t => t.clips.some(c => c.type !== 'audio'));
  $('viewerOverlay').classList.toggle('hidden', hasVideoContent || state.dashboardMode);
}

function getClipLocalTime(clip) { return clamp((state.currentTime - clip.start) * clip.speed + clip.sourceStart, 0, Math.max(0, clip.sourceStart + clip.sourceDuration)); }

function buildFilter(clip, localT) {
  const e = clip.effects || {};
  const brightness = Math.round((1 + Number(e.brightness || 0)) * 100);
  const contrast = Math.round((1 + Number(e.contrast || 0)) * 100);
  const saturation = Math.round((1 + Number(e.saturation || 0)) * 100);
  let filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) hue-rotate(${Number(e.hue || 0)}deg) blur(${Number(e.blur || 0)}px)`;
  if (e.grayscale) filter += ` grayscale(${clamp(e.grayscale,0,1)})`;
  if (e.sepia) filter += ` sepia(${clamp(e.sepia,0,1)})`;
  const zoom = Number(e.zoom || 0);
  if (zoom) {
    const f = 1 + zoom * easeInOut(clamp(localT / Math.max(clip.duration, .001),0,1));
    clip.__zoomRender = f;
  } else clip.__zoomRender = 1;
  return filter;
}

function renderClip(clip) {
  const meta = getAssetMeta(clip.assetId);
  const localT = state.currentTime - clip.start;
  const opacity = clamp(activeProperty(clip, 'opacity'), 0, 1);
  if (clip.type === 'text') { drawTextClip(clip, opacity); return; }
  if (!clip.assetId || clip.type === 'audio') return;
  const kind = clip.type === 'image' ? 'image' : 'video';
  const el = ensureMedia(clip.assetId, kind);
  if (!el) return;
  const sourceTime = getClipLocalTime(clip);
  if (kind === 'video') seekMedia(el, sourceTime).catch(() => {});

  const needsLayer = !!clip.mask || !!clip.lut || (clip.effects?.keyStrength || 0) > 0.001;
  const drawCtx = needsLayer ? clipLayerCtx : ctx;
  if (needsLayer) {
    clipLayerCanvas.width = state.project.width;
    clipLayerCanvas.height = state.project.height;
    clipLayerCtx.setTransform(1,0,0,1,0,0);
    clipLayerCtx.clearRect(0,0,state.project.width,state.project.height);
  }
  drawCtx.save();
  drawCtx.globalAlpha = opacity;
  drawCtx.globalCompositeOperation = clip.blend || 'source-over';
  drawCtx.filter = buildFilter(clip, localT);

  const transform = fitTransform(clip, meta);
  transform.x = evalKeyframes(clip, 'x', state.currentTime, transform.x);
  transform.y = evalKeyframes(clip, 'y', state.currentTime, transform.y);
  transform.scale *= evalKeyframes(clip, 'scale', state.currentTime, 1);
  transform.rotation = evalKeyframes(clip, 'rotation', state.currentTime, transform.rotation);
  const zoom = clip.__zoomRender || 1;
  transform.scale *= zoom;

  drawCtx.translate(transform.x, transform.y);
  drawCtx.rotate(transform.rotation * Math.PI / 180);
  drawCtx.scale(transform.scale, transform.scale);
  const sw = meta?.width || state.project.width;
  const sh = meta?.height || state.project.height;
  drawCtx.drawImage(el, -sw/2, -sh/2, sw, sh);
  drawCtx.restore();

  if (needsLayer) {
    applyPixelEffects(clip, clipLayerCtx, clipLayerCanvas);
    ctx.save();
    ctx.globalCompositeOperation = clip.blend || 'source-over';
    ctx.drawImage(clipLayerCanvas, 0, 0);
    ctx.restore();
  }

  if (clip.effects?.vignette) drawVignette(clip.effects.vignette);
  if (clip.effects?.glitch) drawGlitch(clip.effects.glitch, state.currentTime);
  if (clip.effects?.fade) {
    const edge = Math.min(localT, clip.duration-localT) / .3;
    if (edge < 1) { ctx.save(); ctx.globalAlpha = 1-clamp(edge,0,1); ctx.fillStyle='#000'; ctx.fillRect(0,0,state.project.width,state.project.height); ctx.restore(); }
  }
}

function drawTextClip(clip, opacity) {
  const t = activeProperty(clip, 'opacity');
  const tx = evalKeyframes(clip, 'x', state.currentTime, clip.transform.x);
  const ty = evalKeyframes(clip, 'y', state.currentTime, clip.transform.y);
  const ts = evalKeyframes(clip, 'scale', state.currentTime, clip.transform.scale);
  ctx.save();
  ctx.translate(tx, ty);
  ctx.rotate((clip.transform.rotation || 0) * Math.PI / 180);
  ctx.scale(ts, ts);
  ctx.globalAlpha = opacity * t;
  ctx.font = `${clip.text.weight} ${clip.text.size}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
  const lines = String(clip.text.content || '').split('\n');
  const lh = clip.text.size * 1.14;
  const startY = -((lines.length-1) * lh)/2;
  for (let i = 0; i < lines.length; i++) {
    const y = startY + i*lh;
    drawTrackedText(ctx, lines[i], 0, y, clip.text.tracking, clip.text.stroke, clip.text.strokeWidth, clip.text.color);
  }
  ctx.restore();
}

function drawTrackedText(c, text, x, y, tracking, stroke, strokeWidth, fill) {
  if (tracking === 0) {
    if (strokeWidth > 0) { c.lineWidth = strokeWidth; c.strokeStyle = stroke; c.strokeText(text,x,y); }
    c.fillStyle = fill; c.fillText(text,x,y); return;
  }
  const widths = [...text].map(ch => c.measureText(ch).width);
  const total = widths.reduce((a,b)=>a+b,0) + Math.max(0,text.length-1)*tracking;
  let cur = x-total/2;
  c.textAlign = 'left';
  [...text].forEach((ch,i) => {
    if (strokeWidth > 0) { c.lineWidth=strokeWidth; c.strokeStyle=stroke; c.strokeText(ch,cur,y); }
    c.fillStyle=fill; c.fillText(ch,cur,y); cur += widths[i] + tracking;
  });
  c.textAlign = 'center';
}

function drawVignette(amount) {
  const g = ctx.createRadialGradient(state.project.width/2,state.project.height/2,state.project.height*.18,state.project.width/2,state.project.height/2,state.project.height*.75);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,`rgba(0,0,0,${clamp(amount,0,1)})`);
  ctx.save(); ctx.fillStyle=g; ctx.fillRect(0,0,state.project.width,state.project.height); ctx.restore();
}

function drawGlitch(amount, time) {
  if (Math.random() > .65) return;
  ctx.save(); ctx.globalAlpha = clamp(amount,0,.45);
  const h = Math.max(1,Math.floor(state.project.height * amount*.12));
  const y = Math.floor((Math.sin(time*23.7)*.5+.5)*(state.project.height-h));
  const img = ctx.getImageData(0,y,state.project.width,h);
  ctx.putImageData(img, Math.round(Math.sin(time*70)*12), y);
  ctx.restore();
}

function applyPixelEffects(clip, targetCtx = ctx, targetCanvas = canvas) {
  const e = clip.effects || {};
  const hasLut = !!clip.lut?.data;
  const hasKey = (e.keyStrength || 0) > 0.001;
  const hasMask = !!clip.mask?.enabled;
  if (!hasLut && !hasKey && !hasMask) return;
  const w = targetCanvas.width, h = targetCanvas.height;
  if (hasMask && !hasLut && !hasKey) { applyMaskRegion(clip, targetCtx, targetCanvas); return; }
  let image;
  try { image = targetCtx.getImageData(0,0,w,h); } catch { return; }
  const data = image.data;
  let lut = clip.lut?.data || null;
  const [kr,kg,kb] = hexRgb(e.keyColor || '#00ff00');
  for (let i=0; i<data.length; i+=4) {
    let r=data[i],g=data[i+1],b=data[i+2];
    if (hasKey) {
      const d = Math.sqrt((r-kr)**2+(g-kg)**2+(b-kb)**2)/441.67;
      const cut = clamp(1 - d/(Math.max(.0001, .5*(1-e.keyStrength))),0,1);
      if (cut < .5) data[i+3] = Math.round(data[i+3] * cut * 2);
    }
    if (clip.mask?.enabled && clip.mask.mode === 'color') {
      const mask = clip.mask;
      const center = mask.center || { x: w / 2, y: h / 2 };
      const motion = directionVector(mask.direction);
      const elapsed = Math.max(0, state.currentTime - clip.start);
      const tracking = clamp(Number(mask.tracking ?? 0.8), 0, 1);
      const cx = center.x + motion.x * Number(mask.speed || 0) * elapsed * tracking;
      const cy = center.y + motion.y * Number(mask.speed || 0) * elapsed * tracking;
      const px = (i / 4) % w;
      const py = Math.floor((i / 4) / w);
      const radius = Math.max(10, Number(mask.radius || Math.min(w, h) * .36));
      const dx = px - cx, dy = py - cy;
      const radial = Math.sqrt(dx * dx + dy * dy) / radius;
      const colorDistance = Math.sqrt((r-mask.color[0])**2 + (g-mask.color[1])**2 + (b-mask.color[2])**2) / 441.67;
      const tol = clamp(Number(mask.tolerance || .26), .01, 1);
      const colorKeep = clamp(1 - colorDistance / tol, 0, 1);
      const regionKeep = clamp(1 - radial, 0, 1);
      const feather = Math.max(1, Number(mask.feather || 6));
      const edgeKeep = regionKeep >= 1 ? 1 : clamp(regionKeep * Math.max(0, Math.min(1, feather / 12 + regionKeep)), 0, 1);
      data[i+3] = Math.round(data[i+3] * colorKeep * edgeKeep);
    }
    if (lut) {
      const mapped = sampleLut(lut, r,g,b);
      data[i]=mapped[0]; data[i+1]=mapped[1]; data[i+2]=mapped[2];
    }
  }
  targetCtx.putImageData(image,0,0);
}

function applyMaskRegion(clip, targetCtx, targetCanvas){
  const mask=clip.mask;if(!mask?.enabled||mask.mode!=='color'||!Array.isArray(mask.color))return;
  const w=targetCanvas.width,h=targetCanvas.height;const center=mask.center||{x:w/2,y:h/2};const motion=directionVector(mask.direction);const elapsed=Math.max(0,state.currentTime-clip.start);const tracking=clamp(Number(mask.tracking??.8),0,1);const cx=center.x+motion.x*Number(mask.speed||0)*elapsed*tracking;const cy=center.y+motion.y*Number(mask.speed||0)*elapsed*tracking;const radius=Math.max(10,Number(mask.radius||Math.min(w,h)*.36));const pad=Math.max(2,Number(mask.feather||6)*2);const x0=clamp(Math.floor(cx-radius-pad),0,w),y0=clamp(Math.floor(cy-radius-pad),0,h),x1=clamp(Math.ceil(cx+radius+pad),0,w),y1=clamp(Math.ceil(cy+radius+pad),0,h);const rw=Math.max(1,x1-x0),rh=Math.max(1,y1-y0);let image;try{image=targetCtx.getImageData(x0,y0,rw,rh);}catch{return;}const data=image.data;const tol=clamp(Number(mask.tolerance||.26),.01,1);const feather=Math.max(1,Number(mask.feather||6));for(let py=0;py<rh;py++){for(let px=0;px<rw;px++){const i=(py*rw+px)*4;const r=data[i],g=data[i+1],b=data[i+2];const ax=x0+px-cx,ay=y0+py-cy;const radial=Math.sqrt(ax*ax+ay*ay)/radius;if(radial>1+pad/radius){data[i+3]=0;continue;}const colorDistance=Math.sqrt((r-mask.color[0])**2+(g-mask.color[1])**2+(b-mask.color[2])**2)/441.67;const colorKeep=clamp(1-colorDistance/tol,0,1);const edgeKeep=radial<=1?1:clamp(1-((radial-1)*radius)/feather,0,1);data[i+3]=Math.round(data[i+3]*colorKeep*edgeKeep);}}targetCtx.putImageData(image,x0,y0);
}

function directionVector(direction) {
  const vectors = { static:[0,0], left:[-1,0], right:[1,0], up:[0,-1], down:[0,1], 'up-left':[-.707,-.707], 'up-right':[.707,-.707], 'down-left':[-.707,.707], 'down-right':[.707,.707] };
  const v=vectors[direction]||vectors.static; return {x:v[0],y:v[1]};
}

function hexRgb(hex) {
  const s = hex.replace('#','');
  return [parseInt(s.slice(0,2),16)||0, parseInt(s.slice(2,4),16)||0, parseInt(s.slice(4,6),16)||0];
}

function sampleLut(lut, r,g,b) {
  const size = lut.size;
  const fx = (r/255)*(size-1), fy=(g/255)*(size-1), fz=(b/255)*(size-1);
  const x0=Math.floor(fx), y0=Math.floor(fy), z0=Math.floor(fz);
  const x1=Math.min(size-1,x0+1), y1=Math.min(size-1,y0+1), z1=Math.min(size-1,z0+1);
  const dx=fx-x0,dy=fy-y0,dz=fz-z0;
  const c000=lut.values[(z0*size*size+y0*size+x0)], c100=lut.values[(z0*size*size+y0*size+x1)], c010=lut.values[(z0*size*size+y1*size+x0)], c110=lut.values[(z0*size*size+y1*size+x1)];
  const c001=lut.values[(z1*size*size+y0*size+x0)], c101=lut.values[(z1*size*size+y0*size+x1)], c011=lut.values[(z1*size*size+y1*size+x0)], c111=lut.values[(z1*size*size+y1*size+x1)];
  const out=[0,0,0];
  for(let k=0;k<3;k++){
    const a=lerp(lerp(c000[k],c100[k],dx),lerp(c010[k],c110[k],dx),dy);
    const z=lerp(lerp(c001[k],c101[k],dx),lerp(c011[k],c111[k],dx),dy);
    out[k]=Math.round(clamp(lerp(a,z,dz),0,1)*255);
  }
  return out;
}

function parseCube(text, name) {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const values=[];
  for (const raw of lines) {
    const line=raw.trim(); if(!line || line.startsWith('#')) continue;
    const parts=line.split(/\s+/);
    if (parts[0]==='LUT_3D_SIZE') { size=Number(parts[1]); continue; }
    if (parts.length===3 && parts.every(v => /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(v))) values.push(parts.map(Number));
  }
  if (!size || values.length < size**3) throw new Error('Invalid or incomplete .cube LUT.');
  return { name, size, values: values.slice(0,size**3) };
}

function drawViewerGrid() {
  if (!$('gridBtn').classList.contains('active')) return;
  ctx.save(); ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1;
  for(let x=state.project.width/3; x<state.project.width; x+=state.project.width/3){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,state.project.height);ctx.stroke();}
  for(let y=state.project.height/3; y<state.project.height; y+=state.project.height/3){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(state.project.width,y);ctx.stroke();}
  ctx.strokeStyle='rgba(224,255,79,.35)'; ctx.strokeRect(0,0,state.project.width,state.project.height); ctx.restore();
}

function updateScopes() {
  drawHistogram(); drawWaveform(); drawVectorscope();
}
function clearScope(c, fill='#07090d') { const cctx=c.getContext('2d'); cctx.fillStyle=fill; cctx.fillRect(0,0,c.width,c.height); return cctx; }

function drawHistogram() {
  const cctx=clearScope(histogramCanvas); const w=histogramCanvas.width,h=histogramCanvas.height;
  let bins=new Array(256).fill(0);
  const step=Math.max(1,Math.floor((canvas.width*canvas.height)/180000));
  let img; try{img=ctx.getImageData(0,0,canvas.width,canvas.height).data;}catch{return;}
  for(let i=0,p=0;i<img.length;i+=4*step,p++){const y=Math.round((.2126*img[i]+.7152*img[i+1]+.0722*img[i+2]));bins[y]++;}
  const mx=Math.max(1,...bins); cctx.strokeStyle='rgba(224,255,79,.72)'; cctx.beginPath();
  bins.forEach((v,x)=>{const y=h-(v/mx)*(h-12)-4;x?cctx.lineTo(x*(w/255),y):cctx.moveTo(x*(w/255),y);}); cctx.stroke();
}
function drawWaveform() {
  const cctx=clearScope(waveformCanvas),w=waveformCanvas.width,h=waveformCanvas.height;
  let img; try{img=ctx.getImageData(0,0,canvas.width,canvas.height).data;}catch{return;}
  const sampleX=Math.max(1,Math.floor(canvas.width/w));
  cctx.strokeStyle='rgba(99,190,255,.65)';
  for(let x=0;x<w;x++){
    let lo=1,hi=0;
    for(let sx=x*sampleX;sx<Math.min((x+1)*sampleX,canvas.width);sx+=Math.max(1,Math.floor(canvas.width/300))){
      const i=(Math.floor(canvas.height/2)*canvas.width+sx)*4;
      if(i>=img.length)continue; const y=(.2126*img[i]+.7152*img[i+1]+.0722*img[i+2])/255; lo=Math.min(lo,y);hi=Math.max(hi,y);
    }
    const y1=(1-hi)*(h-4)+2,y2=(1-lo)*(h-4)+2;cctx.beginPath();cctx.moveTo(x,y1);cctx.lineTo(x,y2);cctx.stroke();
  }
}
function drawVectorscope() {
  const cctx=clearScope(vectorscopeCanvas),w=vectorscopeCanvas.width,h=vectorscopeCanvas.height,cx=w/2,cy=h/2,r=Math.min(w,h)*.43;
  cctx.strokeStyle='rgba(130,140,155,.25)';cctx.beginPath();cctx.arc(cx,cy,r,0,Math.PI*2);cctx.stroke();cctx.beginPath();cctx.moveTo(cx-r,cy);cctx.lineTo(cx+r,cy);cctx.moveTo(cx,cy-r);cctx.lineTo(cx,cy+r);cctx.stroke();
  let img;try{img=ctx.getImageData(0,0,canvas.width,canvas.height).data;}catch{return;}
  const step=Math.max(1,Math.floor((canvas.width*canvas.height)/10000));
  cctx.fillStyle='rgba(224,255,79,.62)';
  for(let i=0;i<img.length;i+=4*step){let rr=img[i]/255,gg=img[i+1]/255,bb=img[i+2]/255;const mx=Math.max(rr,gg,bb),mn=Math.min(rr,gg,bb),d=mx-mn;if(d<.08)continue;let hue=0;if(d){if(mx===rr)hue=((gg-bb)/d)%6;else if(mx===gg)hue=(bb-rr)/d+2;else hue=(rr-gg)/d+4;}hue*=Math.PI/3;const sat=d;const mag=sat*r;const x=cx+Math.cos(hue)*mag,y=cy+Math.sin(hue)*mag;cctx.fillRect(x,y,1.5,1.5);}
}

function accentColor(){ return state.editorSettings?.accent || '#d9ff5f'; }
function timelineScale() { return Math.max(15, 75 * state.timelineZoom / 100); }
function timelineRowHeight() { return clamp(Number(state.editorSettings?.trackHeight || 60), 44, 110); }
function timeToX(t) { return t * timelineScale() + 40; }
function xToTime(x) { return Math.max(0, (x - 40) / timelineScale()); }

function renderTimeline(fitWidth=true) {
  if (!state.project) return;
  const rowH=timelineRowHeight(), rulerH=28;
  const totalWidth=Math.max(1100, timeToX(state.project.duration+3));
  const wrapWidth=$('timelineCanvasWrap').clientWidth || 900;
  timelineCanvas.width=Math.max(wrapWidth,totalWidth);
  timelineCanvas.height=Math.max(rulerH+8,state.project.tracks.length*rowH+rulerH);
  tctx.clearRect(0,0,timelineCanvas.width,timelineCanvas.height);
  tctx.fillStyle='#090c11';tctx.fillRect(0,0,timelineCanvas.width,timelineCanvas.height);
  drawTimelineRuler(timelineCanvas.width);
  const colors={video:'#345422',audio:'#174147',text:'#493b63',image:'#3f522b'};
  for(let row=0;row<state.project.tracks.length;row++){
    const track=state.project.tracks[row],y=rulerH+row*rowH;
    tctx.fillStyle=row%2?'#0c1015':'#0a0d12';tctx.fillRect(0,y,timelineCanvas.width,rowH);
    tctx.strokeStyle='#1e252e';tctx.beginPath();tctx.moveTo(0,y);tctx.lineTo(timelineCanvas.width,y);tctx.stroke();
    if(track.locked){tctx.fillStyle='rgba(255,255,255,.018)';tctx.fillRect(0,y,timelineCanvas.width,rowH);}
    for(const clip of track.clips){
      const x=timeToX(clip.start),w=Math.max(6,clip.duration*timelineScale()),selected=clip.id===state.selectedClipId,base=colors[clip.type]||colors[track.type]||'#37424d';
      const grad=tctx.createLinearGradient(0,y,0,y+rowH);grad.addColorStop(0,selected?accentColor():base);grad.addColorStop(1,selected?shadeColor(accentColor(),-.18):shadeColor(base,-.15));
      tctx.fillStyle=grad;tctx.strokeStyle=selected?shadeColor(accentColor(),.35):'#4a5664';tctx.lineWidth=selected?1.5:1;roundRect(tctx,x,y+6,w,rowH-12,5);tctx.fill();tctx.stroke();
      tctx.save();tctx.beginPath();tctx.rect(x+5,y+6,Math.max(0,w-10),rowH-12);tctx.clip();
      tctx.fillStyle=selected?'#11160a':'#d7dee6';tctx.font='600 10px system-ui';tctx.fillText(clip.name,x+7,y+19);
      if(track.type==='audio')drawAudioWave(clip,x,y+29,w,rowH-35);else if(state.thumbnails.get(clip.assetId))drawStripThumbs(clip,x,y+27,w,rowH-33);
      if(clip.type==='text'){tctx.fillStyle=selected?'rgba(17,22,10,.62)':'rgba(0,0,0,.24)';tctx.fillRect(x,y+22,w,1);tctx.fillStyle=selected?'#20290f':'#8993a0';tctx.font='8px system-ui';tctx.fillText('TITLE',x+7,y+34);}
      const keyTimes=new Set();for(const prop of ['opacity','x','y','scale','rotation','volume'])for(const k of clip.keyframes?.[prop]||[])keyTimes.add(Number(k.t)||0);
      if(keyTimes.size){tctx.fillStyle=selected?'#15200a':'#a7b1bd';for(const local of keyTimes){const kx=x+local*clip.speed*timelineScale();if(kx<x||kx>x+w)continue;tctx.save();tctx.translate(kx,y+rowH-10);tctx.rotate(Math.PI/4);tctx.fillRect(-3,-3,6,6);tctx.restore();}}
      tctx.restore();
      if(selected){tctx.fillStyle=accentColor();tctx.fillRect(x-2,y+4,2,rowH-8);tctx.fillRect(x+w,y+4,2,rowH-8);if(w>24){tctx.fillStyle='rgba(255,255,255,.55)';tctx.fillRect(x+3,y+11,2,rowH-22);tctx.fillRect(x+w-5,y+11,2,rowH-22);}}
    }
  }
  const px=timeToX(state.currentTime);tctx.strokeStyle='#ff5d6c';tctx.lineWidth=1.4;tctx.beginPath();tctx.moveTo(px,0);tctx.lineTo(px,timelineCanvas.height);tctx.stroke();
  tctx.fillStyle='#ff5d6c';tctx.beginPath();tctx.moveTo(px-6,0);tctx.lineTo(px+6,0);tctx.lineTo(px,9);tctx.closePath();tctx.fill();
  if(state.inPoint!=null){const x=timeToX(state.inPoint);tctx.strokeStyle='#85cf5a';tctx.setLineDash([4,3]);tctx.beginPath();tctx.moveTo(x,0);tctx.lineTo(x,timelineCanvas.height);tctx.stroke();tctx.setLineDash([]);}
  if(state.outPoint!=null){const x=timeToX(state.outPoint);tctx.strokeStyle='#ffb15c';tctx.setLineDash([4,3]);tctx.beginPath();tctx.moveTo(x,0);tctx.lineTo(x,timelineCanvas.height);tctx.stroke();tctx.setLineDash([]);}
}

function shadeColor(hex, amount){
  const s=String(hex).replace('#','');if(s.length!==6)return hex;const n=parseInt(s,16);let r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  r=Math.round(clamp(r+(255-r)*amount,0,255));g=Math.round(clamp(g+(255-g)*amount,0,255));b=Math.round(clamp(b+(255-b)*amount,0,255));return `#${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
}

function drawTimelineRuler(width){const h=28;tctx.fillStyle='#080b0f';tctx.fillRect(0,0,width,h);const step=niceStep(75/timelineScale());for(let t=0;t<=state.project.duration+3;t+=step){const x=timeToX(t);tctx.strokeStyle='#242b35';tctx.beginPath();tctx.moveTo(x,h);tctx.lineTo(x,0);tctx.stroke();tctx.fillStyle='#697483';tctx.font='9px ui-monospace';tctx.fillText(fmtRulerTime(t),x+3,12);if(step>=1){for(let j=1;j<Math.min(10,step*10);j++){const sx=timeToX(t+j*step/10);tctx.strokeStyle='rgba(255,255,255,.04)';tctx.beginPath();tctx.moveTo(sx,h);tctx.lineTo(sx,h-5);tctx.stroke();}}}tctx.fillStyle='#3b444f';tctx.fillRect(0,h-1,width,1);}
function fmtRulerTime(t){const m=Math.floor(t/60),s=Math.floor(t%60);return `${m}:${String(s).padStart(2,'0')}`;}
function niceStep(sec){const options=[.1,.25,.5,1,2,5,10,15,30,60,120,300];return options.find(x=>x>=sec)||600;}
function drawStripThumbs(clip,x,y,w,h){const data=state.thumbnails.get(clip.assetId);if(!data)return;const img=new Image();img.src=data;const count=Math.max(1,Math.floor(w/85));for(let i=0;i<count;i++)tctx.drawImage(img,x+i*(w/count),y,w/count+1,h);}
function drawAudioWave(clip,x,y,w,h){tctx.strokeStyle='#62b4bd';tctx.globalAlpha=.55;tctx.beginPath();const n=Math.max(3,Math.floor(w/3));for(let i=0;i<n;i++){const xx=x+i*(w/n);const amp=(.15+.85*Math.abs(Math.sin(i*1.73+clip.id.length)))*(h*.42);i?tctx.lineTo(xx,y+h/2-amp):tctx.moveTo(xx,y+h/2-amp);}for(let i=n-1;i>=0;i--){const xx=x+i*(w/n);const amp=(.15+.85*Math.abs(Math.sin(i*1.73+clip.id.length)))*(h*.42);tctx.lineTo(xx,y+h/2+amp);}tctx.stroke();tctx.globalAlpha=1;}
function roundRect(c,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);c.beginPath();c.moveTo(x+rr,y);c.arcTo(x+w,y,x+w,y+h,rr);c.arcTo(x+w,y+h,x,y+h,rr);c.arcTo(x,y+h,x,y,rr);c.arcTo(x,y,x+w,y,rr);c.closePath();}

function timelinePointer(e){const rect=timelineCanvas.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top};}
function trackAtY(y){const row=Math.floor((y-28)/timelineRowHeight());return state.project.tracks[row] || null;}

function onTimelinePointerDown(e){
  const p=timelinePointer(e);
  const time=snapTime(xToTime(p.x));
  const track=trackAtY(p.y);
  if(e.button===2){ setCurrentTime(time); return; }
  if(p.y<28){
    state.drag={mode:'playhead',startX:p.x,startTime:time};
    setCurrentTime(time);
    timelineCanvas.setPointerCapture?.(e.pointerId);
    return;
  }
  const clip=track?.clips.find(c=>time>=c.start&&time<=c.start+c.duration);
  if(state.tool==='razor'){setCurrentTime(time);if(clip){state.selectedClipId=clip.id;splitSelectedClip();}return;}
  if(!clip){setCurrentTime(time);state.selectedClipId=null;updateInspector();renderTimeline();return;}
  state.selectedClipId=clip.id;updateInspector();
  const nearLeft=Math.abs(time-clip.start)<.18;
  const nearRight=Math.abs(time-(clip.start+clip.duration))<.18;
  state.drag={mode:nearLeft?'resize-left':nearRight?'resize-right':'move',startX:p.x,startTime:time,clipId:clip.id,trackId:track.id,orig:structuredClone(clip)};
  timelineCanvas.setPointerCapture?.(e.pointerId);
  renderTimeline();
}
function onTimelinePointerMove(e){
  if(!state.drag){ const p=timelinePointer(e); if(p.y<28)timelineCanvas.style.cursor='ew-resize'; else { const tk=trackAtY(p.y),tm=xToTime(p.x),c=tk?.clips.find(x=>tm>=x.start&&tm<=x.start+x.duration); if(c){ const edge=Math.min(Math.abs(tm-c.start),Math.abs(tm-(c.start+c.duration))); timelineCanvas.style.cursor=edge<.18?'ew-resize':'grab'; } else timelineCanvas.style.cursor='default'; } return; }
  const p=timelinePointer(e);
  if(state.drag.mode==='playhead'){ setCurrentTime(snapTime(xToTime(p.x))); return; }
  const d=xToTime(p.x)-state.drag.startTime;
  const c=getClipById(state.drag.clipId);if(!c)return;
  if(!state.project||getTrackById(state.drag.trackId)?.locked)return;
  pushUndoDebounced();
  if(state.drag.mode==='move'){c.start=Math.max(0,snapTime(state.drag.orig.start+d));}
  else if(state.drag.mode==='resize-right'){c.duration=Math.max(.05,snapTime(state.drag.orig.duration+d));}
  else {const delta=snapTime(state.drag.orig.start+d)-state.drag.orig.start;const maxShrink=state.drag.orig.duration-.05;c.start=Math.max(0,state.drag.orig.start+Math.min(delta,maxShrink));c.duration=Math.max(.05,state.drag.orig.duration-(c.start-state.drag.orig.start));c.sourceStart=Math.max(0,state.drag.orig.sourceStart+(c.start-state.drag.orig.start)*c.speed);}
  ensureProjectDuration();setCurrentTime(clamp(state.currentTime,0,state.project.duration));renderTimeline();saveProjectSoon();
}
function onTimelinePointerUp(){state.drag=null;}
let undoDebounce=0;
function pushUndoDebounced(){if(undoDebounce)return;undoDebounce=setTimeout(()=>undoDebounce=0,150);pushUndo();}
function getClipById(id){for(const t of state.project.tracks){const c=t.clips.find(x=>x.id===id);if(c)return c;}return null;}

async function play(){if(state.playing)return;state.playing=true;state.playStartedAt=performance.now();state.playOffset=state.currentTime;for(const c of state.media.values()){try{c.pause();}catch{}};startPreviewAudio(state.currentTime).catch(err=>console.warn('Preview audio unavailable',err));renderLoop();$('playBtn').textContent='❚❚';}
function pause(){state.playing=false;stopPreviewAudio();for(const c of state.media.values()){try{c.pause();}catch{}};$('playBtn').textContent='▶';}
function stop(){pause();setCurrentTime(state.inPoint ?? 0);}
function keepPlayheadVisible(){const scroller=$('timelineScroller');const rect=scroller.getBoundingClientRect();const canvasRect=timelineCanvas.getBoundingClientRect();const px=canvasRect.left+timeToX(state.currentTime);const pad=80;if(px>rect.right-pad)scroller.scrollLeft+=px-(rect.right-pad);else if(px<rect.left+174+pad)scroller.scrollLeft-=((rect.left+174+pad)-px);}
function renderLoop(now){if(!state.playing)return;const elapsed=(now-state.playStartedAt)/1000;let t=state.playOffset+elapsed;const loopEnd=state.outPoint!=null?state.outPoint:state.project.duration;if(t>=loopEnd){if(state.loopPlayback){t=state.inPoint??0;state.playStartedAt=performance.now();state.playOffset=t;}else{setCurrentTime(loopEnd);pause();return;}}state.currentTime=t;render();updateTimecode();renderTimeline(false);if(state.editorSettings.followPlayhead)keepPlayheadVisible();state.raf=requestAnimationFrame(renderLoop);}

async function exportTimeline(){
  const start=$('exportRangeOnly').checked && state.inPoint!=null ? state.inPoint : 0;
  const end=$('exportRangeOnly').checked && state.outPoint!=null ? state.outPoint : state.project.duration;
  const fps=clamp(Number($('exportFps').value)||state.project.fps,1,120);
  const format=$('exportFormat').value;
  const res=$('exportResolution').value;
  let width=state.project.width,height=state.project.height;
  if(res!=='project'){[width,height]=res.split('x').map(Number);}
  const bitrate=Math.max(250,Number($('exportBitrate').value)||8000)*1000;
  const mimeCandidates=format==='webm-vp9'
    ? ['video/webm;codecs=vp9,opus','video/webm;codecs=vp9','video/webm']
    : ['video/webm;codecs=vp8,opus','video/webm;codecs=vp8','video/webm'];
  const mime=mimeCandidates.find(x=>MediaRecorder.isTypeSupported(x));
  if(!mime){toast('This browser cannot create a WebM recording.', 'error');return;}
  const exportCanvas=document.createElement('canvas');exportCanvas.width=width;exportCanvas.height=height;const exctx=exportCanvas.getContext('2d',{alpha:false});
  const stream=exportCanvas.captureStream(fps);
  let exportAudioCtx=null;
  let exportAudioDest=null;
  try{
    exportAudioCtx=new (window.AudioContext||window.webkitAudioContext)();
    exportAudioDest=exportAudioCtx.createMediaStreamDestination();
    for(const track of exportAudioDest.stream.getAudioTracks())stream.addTrack(track);
    await exportAudioCtx.resume();
    await startAudioMix(exportAudioCtx,exportAudioDest,start,end,true);
  }catch(err){
    console.warn('Audio export unavailable; exporting video only.',err);
    exportAudioCtx=null;
    exportAudioDest=null;
  }
  const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:bitrate});
  const chunks=[];recorder.ondataavailable=e=>e.data.size&&chunks.push(e.data);
  $('exportProgress').classList.remove('hidden');
  setExportProgress(0,'Preparing…');
  await preloadExportMedia();
  const duration=end-start;
  const previous=state.currentTime;
  await new Promise(async(resolve,reject)=>{
    recorder.onerror=()=>reject(recorder.error||new Error('Recorder failed'));
    recorder.onstop=resolve;
    recorder.start(250);
    const frameMs=1000/fps;
    for(let frame=0;frame<Math.ceil(duration*fps);frame++){
      const t=start+frame/fps;
      await renderToContext(exctx,width,height,t);
      setExportProgress(frame/(duration*fps),`${Math.round(frame/(duration*fps)*100)}%`);
      await new Promise(r=>setTimeout(r,Math.max(0,frameMs*.65)));
    }
    recorder.stop();
  }).catch(err=>{console.error(err);toast(`Export failed: ${err.message}`,'error');});
  if(exportAudioCtx){try{await exportAudioCtx.close();}catch{}}
  const blob=new Blob(chunks,{type:mime});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${safeName(state.project.name)}.${mime.includes('webm')?'webm':'bin'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  state.currentTime=clamp(previous,state.inPoint??0,state.outPoint??state.project.duration);render();setExportProgress(1,'Complete');
}

async function renderToContext(targetCtx,width,height,time){
  const oldCanvas=canvas,oldCtx=ctx;
  const sx=width/state.project.width, sy=height/state.project.height;
  targetCtx.fillStyle=state.project.settings.background||'#090c12';targetCtx.fillRect(0,0,width,height);
  for(const track of [...state.project.tracks].reverse()){
    if(track.muted || (state.project.tracks.some(t=>t.solo)&&!track.solo))continue;
    const clip=track.clips.find(c=>time>=c.start&&time<c.start+c.duration);if(!clip)continue;
    if(clip.type==='text'){
      drawTextOnContext(targetCtx,clip,time,sx,sy);continue;
    }
    const meta=getAssetMeta(clip.assetId);if(!meta)continue;
    if(clip.type==='audio')continue;
    const kind=clip.type==='image'?'image':'video';
    const el=ensureMedia(clip.assetId,kind);if(!el)continue;
    const source=(time-clip.start)*clip.speed+clip.sourceStart;if(kind==='video')await seekMedia(el,source);
    const transform=fitTransform(clip,meta);transform.x=evalKeyframes(clip,'x',time,transform.x);transform.y=evalKeyframes(clip,'y',time,transform.y);transform.scale*=evalKeyframes(clip,'scale',time,1);transform.rotation=evalKeyframes(clip,'rotation',time,transform.rotation);transform.scale*=1+(clip.effects?.zoom||0)*easeInOut(clamp((time-clip.start)/Math.max(clip.duration,.001),0,1));
    const needsLayer=!!clip.mask || !!clip.lut || (clip.effects?.keyStrength||0)>0.001;
    if(needsLayer){
      clipLayerCanvas.width=state.project.width;clipLayerCanvas.height=state.project.height;clipLayerCtx.setTransform(1,0,0,1,0,0);clipLayerCtx.clearRect(0,0,state.project.width,state.project.height);
      clipLayerCtx.save();clipLayerCtx.globalAlpha=clamp(evalKeyframes(clip,'opacity',time,clip.opacity),0,1);clipLayerCtx.globalCompositeOperation=clip.blend||'source-over';clipLayerCtx.filter=buildFilter(clip,time-clip.start);clipLayerCtx.translate(transform.x,transform.y);clipLayerCtx.rotate(transform.rotation*Math.PI/180);clipLayerCtx.scale(transform.scale,transform.scale);clipLayerCtx.drawImage(el,-meta.width/2,-meta.height/2,meta.width,meta.height);clipLayerCtx.restore();
      const previousTime=state.currentTime;state.currentTime=time;applyPixelEffects(clip,clipLayerCtx,clipLayerCanvas);state.currentTime=previousTime;
      targetCtx.save();targetCtx.globalCompositeOperation=clip.blend||'source-over';targetCtx.drawImage(clipLayerCanvas,0,0,width,height);targetCtx.restore();
    }else{
      targetCtx.save();targetCtx.globalAlpha=clamp(evalKeyframes(clip,'opacity',time,clip.opacity),0,1);targetCtx.globalCompositeOperation=clip.blend||'source-over';targetCtx.filter=buildFilter(clip,time-clip.start);targetCtx.translate(transform.x*sx,transform.y*sy);targetCtx.rotate(transform.rotation*Math.PI/180);targetCtx.scale(transform.scale*sx,transform.scale*sy);targetCtx.drawImage(el,-meta.width/2,-meta.height/2,meta.width,meta.height);targetCtx.restore();
    }
  }
}

function drawTextOnContext(c,clip,time,sx,sy){const tx=evalKeyframes(clip,'x',time,clip.transform.x)*sx,ty=evalKeyframes(clip,'y',time,clip.transform.y)*sy,sc=evalKeyframes(clip,'scale',time,clip.transform.scale)*sx;c.save();c.translate(tx,ty);c.scale(sc,sc);c.globalAlpha=evalKeyframes(clip,'opacity',time,clip.opacity);c.font=`${clip.text.weight} ${clip.text.size}px system-ui,sans-serif`;c.textAlign='center';c.textBaseline='middle';const lines=String(clip.text.content||'').split('\n');const lh=clip.text.size*1.14;lines.forEach((line,i)=>{const y=(i-(lines.length-1)/2)*lh;if(clip.text.strokeWidth){c.lineWidth=clip.text.strokeWidth;c.strokeStyle=clip.text.stroke;c.strokeText(line,0,y);}c.fillStyle=clip.text.color;c.fillText(line,0,y);});c.restore();}
function preloadExportMedia(){return Promise.all([...state.assetFiles.keys()].map(id=>{const meta=state.assetMeta.get(id);if(!meta||meta.kind!=='video')return Promise.resolve();const el=ensureMedia(id,'video');return new Promise(r=>{if(el.readyState>=2)return r();el.addEventListener('canplay',r,{once:true});el.addEventListener('error',r,{once:true});});}));}
function setExportProgress(v,label){$('exportProgressBar').style.width=`${clamp(v,0,1)*100}%`;$('exportProgressText').textContent=label;}
function safeName(n){return String(n||'Axiom Editor').replace(/[^a-z0-9-_]+/gi,'_').replace(/^_+|_+$/g,'')||'Axiom_Editor';}
function easeInOut(x){return x<.5?2*x*x:1-Math.pow(-2*x+2,2)/2;}

async function decodeAudioAsset(assetId,audioCtx){
  if(state.runtimeAudioBuffers.has(assetId))return state.runtimeAudioBuffers.get(assetId);
  const file=state.assetFiles.get(assetId);if(!file)return null;
  try{const arr=await file.arrayBuffer();const buffer=await audioCtx.decodeAudioData(arr.slice(0));state.runtimeAudioBuffers.set(assetId,buffer);return buffer;}
  catch(err){console.warn('Audio decode failed for',assetId,err);state.runtimeAudioBuffers.set(assetId,null);return null;}
}
function overlap(a0,a1,b0,b1){return a0<b1&&a1>b0;}
function addReverbNode(audioCtx){const con=audioCtx.createConvolver();const sr=audioCtx.sampleRate,len=Math.floor(sr*1.4),impulse=audioCtx.createBuffer(2,len,sr);for(let ch=0;ch<2;ch++){const data=impulse.getChannelData(ch);for(let i=0;i<len;i++){const decay=Math.pow(1-i/len,2.4);data[i]=(Math.random()*2-1)*decay;}}con.buffer=impulse;return con;}
function connectAudioChain(source,destination,clip,audioCtx){const rack=state.project.settings.rack||{};const low=audioCtx.createBiquadFilter();low.type='lowshelf';low.frequency.value=120;low.gain.value=Number(rack.low||0);const mid=audioCtx.createBiquadFilter();mid.type='peaking';mid.frequency.value=1400;mid.Q.value=.7;mid.gain.value=Number(rack.mid||0);const high=audioCtx.createBiquadFilter();high.type='highshelf';high.frequency.value=6500;high.gain.value=Number(rack.high||0);const comp=audioCtx.createDynamicsCompressor();const amount=clamp(Number(rack.comp||0),0,1);comp.threshold.value=lerp(-24,-6,amount);comp.knee.value=14;comp.ratio.value=lerp(1,8,amount);comp.attack.value=.004;comp.release.value=.12;const gain=audioCtx.createGain();gain.gain.value=clamp(Number(clip.volume??1),0,4);const pan=audioCtx.createStereoPanner?audioCtx.createStereoPanner():null;if(pan)pan.pan.value=clamp(Number(clip.pan??0),-1,1);let output=gain;if(pan)output= gain.connect(pan);source.connect(low).connect(mid).connect(high).connect(comp).connect(gain);output.connect(destination);if(Number(rack.reverb||0)>0){const wet=audioCtx.createGain();wet.gain.value=clamp(Number(rack.reverb),0,1);const rev=addReverbNode(audioCtx);gain.connect(rev).connect(wet).connect(destination);}return{gain,comp};}
function clipDuckFactor(clip,time,duration){const rack=state.project.settings.rack||{};if(!rack.duck||getTrackById(clip.trackId)?.type!=='audio')return 1;const trackName=(getTrackById(clip.trackId)?.name||'').toLowerCase();if(/dialog|voice|speech|vo/.test(trackName))return 1;const dialogueTracks=state.project.tracks.filter(t=>t.type==='audio'&&/dialog|voice|speech|vo/.test(t.name.toLowerCase()));const dialogueActive=dialogueTracks.some(t=>t.clips.some(other=>overlap(other.start,other.start+other.duration,time,time+duration)));return dialogueActive?.35:1;}
async function startAudioMix(audioCtx,destination,rangeStart,rangeEnd,renderForExport=false){const sources=[];const startWhen=audioCtx.currentTime+.05;for(const track of state.project.tracks){if((track.type!=='audio'&&track.type!=='video')||track.muted||(state.project.tracks.some(t=>t.solo)&&!track.solo))continue;for(const clip of track.clips){if(!overlap(clip.start,clip.start+clip.duration,rangeStart,rangeEnd))continue;const buf=await decodeAudioAsset(clip.assetId,audioCtx);if(!buf)continue;const intersectionStart=Math.max(rangeStart,clip.start),intersectionEnd=Math.min(rangeEnd,clip.start+clip.duration),clipOffset=intersectionStart-clip.start,sourceOffset=clamp(clip.sourceStart+clipOffset*clip.speed,0,Math.max(0,buf.duration-.001)),available=Math.max(.001,Math.min(intersectionEnd-intersectionStart,(buf.duration-sourceOffset)/clip.speed));const src=audioCtx.createBufferSource();src.buffer=buf;src.playbackRate.value=clip.speed||1;const chain=connectAudioChain(src,destination,clip,audioCtx);chain.gain.gain.value*=clipDuckFactor(clip,intersectionStart,available);const when=startWhen+(intersectionStart-rangeStart);try{src.start(when,sourceOffset,available);sources.push(src);}catch(err){console.warn('Audio source schedule failed',err);}}}if(renderForExport)return{sources,startWhen};state.previewAudioSources=sources;return{sources,startWhen};}
async function startPreviewAudio(time){stopPreviewAudio();const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)return;if(!state.audioContext)state.audioContext=new AudioCtx();await state.audioContext.resume();const generation=++state.previewAudioGeneration;const mix=await startAudioMix(state.audioContext,state.audioContext.destination,time,state.project.duration,false);if(generation!==state.previewAudioGeneration)mix.sources.forEach(s=>{try{s.stop();}catch{}});}
function stopPreviewAudio(){state.previewAudioGeneration++;for(const src of state.previewAudioSources){try{src.stop();}catch{}}state.previewAudioSources=[];}

async function exportProjectJSON(){
  const payload={project:state.project,version:1,assetRefs:[...state.assetMeta.values()].map(a=>({id:a.id,name:a.name,type:a.type,size:a.size}))};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});downloadBlob(blob,`${safeName(state.project.name)}.vf.json`);
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}

function toast(message, type='') { const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('toastStack').append(el);setTimeout(()=>el.remove(),3200); }

function attachEvents(){
  $('importBtn').onclick=()=>$('assetInput').click();
  $('assetInput').addEventListener('change',e=>{importFiles([...e.target.files]);e.target.value='';});
  $('newProjectBtn').onclick=()=>{$('newProjectDialog').showModal();};
  $('createProjectCancel').onclick=()=>$('newProjectDialog').close();
  $('createProjectConfirm').onclick=async()=>{await createNewProject();};
  $('openProjectBtn').onclick=async()=>{hideDashboard();const projects=await idbGetAll(STORE_PROJECTS);if(!projects.length){toast('No saved projects yet.','error');return;}const choice=prompt(`Saved projects:\n${projects.map((p,i)=>`${i+1}. ${p.name}`).join('\n')}\n\nEnter number:`);const index=Number(choice)-1;if(projects[index]){await loadProject(projects[index]);toast(`Opened ${projects[index].name}.`,'good');}};
  $('saveProjectBtn').onclick=()=>saveProject();$('undoBtn').onclick=undo;$('redoBtn').onclick=redo;$('deleteBtn').onclick=removeSelectedClip;
  $('playBtn').onclick=()=>state.playing?pause():play();$('stopBtn').onclick=stop;$('prevFrameBtn').onclick=()=>setCurrentTime(state.currentTime-1/state.project.fps);$('nextFrameBtn').onclick=()=>setCurrentTime(state.currentTime+1/state.project.fps);
  $('loopBtn').onclick=()=>{state.loopPlayback=!state.loopPlayback;$('loopBtn').classList.toggle('active',state.loopPlayback);};
  $('installBtn').onclick=()=>installPWA();$('exportBtn').onclick=()=>{$('exportDialog').showModal();};$('exportCancelBtn').onclick=()=>{$('exportDialog').close();};$('exportStartBtn').onclick=()=>exportTimeline();
  $('gridBtn').onclick=()=>{$('gridBtn').classList.toggle('active');render();};$('fullscreenBtn').onclick=()=>toggleFullscreen();
  $('zoomSelect').onchange=e=>{const val=e.target.value;$('previewCanvas').style.width=val==='fit'?'':`${Number(val)*100}%`;render();};
  $('snappingBtn').onclick=()=>{state.snap=!state.snap;$('snappingBtn').classList.toggle('active',state.snap);};$('selectToolBtn').onclick=()=>setTool('select');$('razorToolBtn').onclick=()=>setTool('razor');
  $('zoomOutBtn').onclick=()=>setTimelineZoom(state.timelineZoom-10);$('zoomInBtn').onclick=()=>setTimelineZoom(state.timelineZoom+10);$('setInBtn').onclick=()=>{state.inPoint=state.currentTime;renderTimeline();};$('setOutBtn').onclick=()=>{state.outPoint=state.currentTime;renderTimeline();};$('clearRangeBtn').onclick=()=>{state.inPoint=null;state.outPoint=null;renderTimeline();};
  $('addVideoTrackBtn').onclick=()=>addTrack('video');$('addAudioTrackBtn').onclick=()=>addTrack('audio');$('addTextTrackBtn').onclick=()=>addTrack('text');$('addTextClipBtn').onclick=addTextClip;
  $('mediaSearch').addEventListener('input',e=>{state.mediaSearch=e.target.value;renderAssets();});
  $$('.view-toggle-btn').forEach(btn=>btn.addEventListener('click',()=>{$$('.view-toggle-btn').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.assetView=btn.dataset.view||'grid';renderAssets();}));
  $$('.bin-tab').forEach((btn,i)=>btn.addEventListener('click',()=>{$$('.bin-tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.mediaFilter=['all','video','audio','stills'][i]||'all';renderAssets();}));
  $$('.preset-btn').forEach(btn=>btn.addEventListener('click',()=>{const [w,h,fps]=btn.dataset.preset.split('x').map(Number);$('newProjectWidth').value=w;$('newProjectHeight').value=h;$('newProjectFps').value=fps;}));
  configureInput('propStart',(v)=>applyProp('start',v));configureInput('propDuration',(v)=>applyProp('duration',v));configureInput('propSourceStart',(v)=>applyProp('sourceStart',v));configureInput('propSpeed',(v)=>applyProp('speed',v));configureInput('propX',(v)=>applyProp('x',v));configureInput('propY',(v)=>applyProp('y',v));configureInput('propScale',(v)=>applyProp('scale',v));configureInput('propRotation',(v)=>applyProp('rotation',v));
  $('propOpacity').oninput=e=>{const c=getSelectedClip();if(!c)return;c.opacity=Number(e.target.value);$('propOpacityOut').value=`${Math.round(c.opacity*100)}%`;render();saveProjectSoon();};
  $('propVolume').oninput=e=>{const c=getSelectedClip();if(c?.type!=='audio')return;c.volume=Number(e.target.value);$('propVolumeOut').value=`${Math.round(c.volume*100)}%`;render();saveProjectSoon();};
  $('propPan').oninput=e=>{const c=getSelectedClip();if(c?.type!=='audio')return;c.pan=Number(e.target.value);$('propPanOut').value=c.pan===0?'Center':`${Math.round(c.pan*100)}% ${c.pan<0?'L':'R'}`;render();saveProjectSoon();};
  const fxMap={fxBrightness:'brightness',fxContrast:'contrast',fxSaturation:'saturation',fxHue:'hue',fxBlur:'blur',fxKeyStrength:'keyStrength'};for(const [id,prop] of Object.entries(fxMap))$(id).oninput=e=>{const c=getSelectedClip();if(!c)return;c.effects[prop]=Number(e.target.value);render();saveProjectSoon();};
  $('fxKeyColor').oninput=e=>{const c=getSelectedClip();if(!c)return;c.effects.keyColor=e.target.value;render();saveProjectSoon();};$('resetColorBtn').onclick=()=>{const c=getSelectedClip();if(!c)return;pushUndo();Object.assign(c.effects,{brightness:0,contrast:0,saturation:0,hue:0,blur:0});updateInspector();render();saveProjectSoon();};
  $('loadLutBtn').onclick=()=>$('lutInput').click();$('lutInput').addEventListener('change',async e=>{const file=e.target.files[0];const c=getSelectedClip();if(!file||!c)return;try{const lut=parseCube(await file.text(),file.name);pushUndo();c.lut=lut;updateInspector();render();toast(`Loaded ${file.name}.`,'good');}catch(err){toast(err.message,'error');}});$('clearLutBtn').onclick=()=>{const c=getSelectedClip();if(!c)return;pushUndo();c.lut=null;updateInspector();render();};
  const textHandlers={textContent:['content',e=>e.target.value],textSize:['size',e=>Number(e.target.value)],textWeight:['weight',e=>Number(e.target.value)],textColor:['color',e=>e.target.value],textStroke:['stroke',e=>e.target.value],textTracking:['tracking',e=>Number(e.target.value)],textStrokeWidth:['strokeWidth',e=>Number(e.target.value)]};for(const [id,[prop,conv]] of Object.entries(textHandlers))$(id).addEventListener('input',e=>{const c=getSelectedClip();if(!c?.text)return;c.text[prop]=conv(e);render();saveProjectSoon();});
  $$('.key-btn').forEach(btn=>btn.onclick=()=>{const c=getSelectedClip();if(!c)return;const key=btn.dataset.key;if(key==='opacity'){setKeyframe(c,'opacity');btn.classList.add('active');}else{setKeyframe(c,'x');setKeyframe(c,'y');setKeyframe(c,'scale');setKeyframe(c,'rotation');btn.classList.add('active');}render();saveProjectSoon();});
  $('projectNameInput').oninput=e=>{state.project.name=e.target.value||'Untitled';updateUI();saveProjectSoon();};$('applyProjectBtn').onclick=applyProjectSettings;
  $('newProjectForm').addEventListener('submit',e=>e.preventDefault());$('exportForm').addEventListener('submit',e=>e.preventDefault());
  $$('.effect-card').forEach(card=>card.addEventListener('dblclick',()=>splitEffect(card.dataset.effect)));$$('.panel-mode-tab').forEach(tab=>tab.onclick=()=>switchLeftPanel(tab.dataset.panel));$$('.inspector-panel .tab').forEach(tab=>tab.onclick=()=>switchInspector(tab.dataset.inspector));
  timelineCanvas.addEventListener('pointerdown',onTimelinePointerDown);timelineCanvas.addEventListener('pointermove',onTimelinePointerMove);timelineCanvas.addEventListener('pointerup',onTimelinePointerUp);timelineCanvas.addEventListener('pointercancel',onTimelinePointerUp);timelineCanvas.addEventListener('contextmenu',e=>e.preventDefault());
  $('settingsBtn').onclick=()=>openSettings();
  $$('.menu-item').forEach(btn=>{const label=btn.textContent.trim().toLowerCase();if(label==='window')btn.onclick=()=>openSettings('workspace');if(label==='help')btn.onclick=()=>openSettings('keybinds');});
  $('settingsCloseBtn').onclick=()=>$('settingsDialog').close();
  $('settingsDoneBtn').onclick=()=>$('settingsDialog').close();
  $$('.settings-nav-btn').forEach(btn=>btn.onclick=()=>switchSettingsSection(btn.dataset.settingsSection));
  $('resetKeybindsBtn').onclick=resetKeybinds;
  $('settingAutosave').onchange=e=>saveEditorSetting('autosave',e.target.checked);
  $('settingAutosaveInterval').onchange=e=>saveEditorSetting('autosaveInterval',Number(e.target.value));
  $('settingConfirmDelete').onchange=e=>saveEditorSetting('confirmDelete',e.target.checked);
  $('settingShowScopes').onchange=e=>saveEditorSetting('showScopes',e.target.checked);
  $('settingReduceMotion').onchange=e=>saveEditorSetting('reduceMotion',e.target.checked);
  $('settingTimelineZoom').onchange=e=>{saveEditorSetting('timelineZoom',Number(e.target.value));setTimelineZoom(Number(e.target.value));};
  $('settingTrackHeight').onchange=e=>saveEditorSetting('trackHeight',Number(e.target.value));
  $('settingTimelineDock').onchange=e=>saveEditorSetting('timelineDock',e.target.value);
  $('settingScopesPosition').onchange=e=>saveEditorSetting('scopesPosition',e.target.value);
  $('settingSnap').onchange=e=>saveEditorSetting('snap',e.target.checked);
  $('settingFollowPlayhead').onchange=e=>saveEditorSetting('followPlayhead',e.target.checked);
  $('settingShiftPan').onchange=e=>saveEditorSetting('shiftPan',e.target.checked);
  $('settingLoop').onchange=e=>saveEditorSetting('loopPlayback',e.target.checked);
  $('settingFrameStep').onchange=e=>saveEditorSetting('frameStep',Number(e.target.value));
  $('settingAccent').oninput=e=>saveEditorSetting('accent',e.target.value);
  $('resetWorkspaceBtn').onclick=()=>resetWorkspaceLayout();
  $('arrangePanelsBtn').onclick=()=>setPanelArrangeMode(!state.panelArrangeMode);
  $('restorePanelLayoutBtn').onclick=()=>resetPanelLayout();
  $('showAllPanelsBtn').onclick=()=>{setPanelArrangeMode(false);for(const id of Object.keys(state.editorSettings.panelVisibility)) state.editorSettings.panelVisibility[id]=true; state.editorSettings.showScopes=true; applyEditorSettingsToUI(); renderWorkspacePanelList(); saveSettings(); renderTimeline();};
  $('snappingBtn').onclick=()=>{state.snap=!state.snap;state.editorSettings.snap=state.snap;$('snappingBtn').classList.toggle('active',state.snap);saveSettings();};
  $('loopBtn').onclick=()=>{state.loopPlayback=!state.loopPlayback;state.editorSettings.loopPlayback=state.loopPlayback;$('loopBtn').classList.toggle('active',state.loopPlayback);saveSettings();};
  $('aiCutoutBtn').onclick=()=>openAICutout(getSelectedClip());
  $('aiCutoutCloseBtn').onclick=()=>{$('aiCutoutDialog').close();};
  $('aiPickObjectBtn').onclick=()=>{state.aiCutout.picking=true;$('aiCutoutPickBadge').classList.remove('hidden');$('aiSampleStatus').textContent='Click the object in the preview.';};
  $('aiCutoutCanvas').addEventListener('click',e=>{if(!state.aiCutout.picking)return;const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;const px=Math.round(x*(e.currentTarget.width-1)),py=Math.round(y*(e.currentTarget.height-1));const data=e.currentTarget.getContext('2d').getImageData(px,py,1,1).data;state.aiCutout.sampled=[data[0],data[1],data[2]];state.aiCutout.sourcePoint={x,y};state.aiCutout.picking=false;$('aiCutoutPickBadge').classList.add('hidden');$('aiSampleStatus').textContent=`Sampled RGB ${data[0]}, ${data[1]}, ${data[2]}`;renderAICutoutFrame();});
  for(const id of ['aiCutoutRadius','aiCutoutTolerance','aiCutoutFeather','aiCutoutSpeed','aiCutoutTracking'])$(id).oninput=e=>{const out=e.target.nextElementSibling;if(!out)return;out.textContent=id==='aiCutoutSpeed'?`${e.target.value} px/s`:id==='aiCutoutFeather'?`${e.target.value}px`:`${e.target.value}%`;};
  $('aiApplyCutoutBtn').onclick=createObjectCutout;$('aiCreateBehindTextBtn').onclick=createTextBehindSetup;
  $('dashboardBtn').onclick=()=>showDashboard();
  $('dashboardNewBtn').onclick=()=>{$('newProjectDialog').showModal();};
  $('dashboardEmptyNewBtn').onclick=()=>{$('newProjectDialog').showModal();};
  $('dashboardImportBtn').onclick=()=>$('dashboardImportInput').click();
  $('dashboardImportInput').addEventListener('change',async e=>{await importFiles([...e.target.files]);e.target.value='';showDashboard();});
  $('dashboardSearch').addEventListener('input',e=>{state.dashboardSearch=e.target.value;renderDashboard();});
  $$('.dashboard-filter-btn').forEach(b=>b.addEventListener('click',()=>{$$('.dashboard-filter-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.dashboardFilter=b.dataset.dashboardFilter;renderDashboard();}));
  $('dashboardSettingsBtn').onclick=()=>openSettings('workspace');
  $('closeMediaPanelBtn').onclick=()=>setPanelVisible('media',false);
  $('closeViewerPanelBtn').onclick=()=>setPanelVisible('preview',false);
  $('closeScopesPanelBtn').onclick=()=>setPanelVisible('scopes',false);
  $('closeInspectorPanelBtn').onclick=()=>setPanelVisible('inspector',false);
  $('closeTimelinePanelBtn').onclick=()=>setPanelVisible('timeline',false);
  setupTimelineGestures();setupWorkspaceResizers();setupPanelDrag();setupEditorPanelDrag();setupContextMenus();
  document.addEventListener('keydown',globalKeydown);setupDropZone();
}

async function createNewProject(){
  pushUndo();
  await loadProject(makeProject({name:$('newProjectName').value,width:Number($('newProjectWidth').value),height:Number($('newProjectHeight').value),fps:Number($('newProjectFps').value),duration:Number($('newProjectDuration').value)}));
  await saveProject(true); $('newProjectDialog').close(); hideDashboard(); toast('New video created.','good');
}
function applyProjectSettings(){
  pushUndo();state.project.name=$('projectNameInput').value||'Untitled';state.project.width=clamp(Number($('projectWidth').value)||1920,64,8192);state.project.height=clamp(Number($('projectHeight').value)||1080,64,8192);state.project.fps=clamp(Number($('projectFps').value)||30,1,120);state.project.pixelRatio=clamp(Number($('projectPixelRatio').value)||1,.25,2);canvas.width=state.project.width;canvas.height=state.project.height;ensureProjectDuration();updateUI();render();saveProjectSoon();}
function setTimelineZoom(v, anchorClientX = null) {
  const scroller = $('timelineScroller');
  let anchorTime = null;
  if (anchorClientX != null) {
    const rect = timelineCanvas.getBoundingClientRect();
    anchorTime = xToTime(anchorClientX - rect.left);
  }
  state.timelineZoom = clamp(v, 25, 500);
  state.editorSettings.timelineZoom = state.timelineZoom;
  $('timelineZoomLabel').textContent = `${state.timelineZoom}%`;
  renderTimeline();
  if (anchorClientX != null && Number.isFinite(anchorTime)) {
    requestAnimationFrame(() => {
      const rect = timelineCanvas.getBoundingClientRect();
      const newClientX = rect.left + timeToX(anchorTime);
      scroller.scrollLeft += newClientX - anchorClientX;
    });
  }
  saveSettings();
}
function setTool(tool){state.tool=tool;$('selectToolBtn').classList.toggle('active',tool==='select');$('razorToolBtn').classList.toggle('active',tool==='razor');}
function switchLeftPanel(panel){$$('.panel-mode-tab').forEach(x=>x.classList.toggle('active',x.dataset.panel===panel));['media','effects','audio'].forEach(p=>$(p+'Panel').classList.toggle('hidden',p!==panel));}
function switchInspector(panel){$$('.inspector-panel .tab').forEach(x=>x.classList.toggle('active',x.dataset.inspector===panel));$('clipInspector').classList.toggle('hidden',panel!=='clip');$('projectInspector').classList.toggle('hidden',panel!=='project');}

function bindingLabel(id) { return state.editorSettings.keybinds?.[id] || DEFAULT_KEYBINDS[id] || 'Unassigned'; }
function normalizeBindingKey(key) {
  if (key === ' ') return 'Space';
  const map = { Escape:'Esc', Enter:'Enter', Backspace:'Backspace', Delete:'Delete', Tab:'Tab', ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight', ArrowUp:'ArrowUp', ArrowDown:'ArrowDown', PageUp:'PageUp', PageDown:'PageDown', Home:'Home', End:'End' };
  return map[key] || (key.length === 1 ? key.toUpperCase() : key);
}
function eventToBinding(e) {
  if (['Control','Shift','Alt','Meta'].includes(e.key)) return null;
  const parts=[];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(normalizeBindingKey(e.key));
  return parts.join('+');
}
function bindingMatches(e, binding) {
  if (!binding) return false;
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const wantsCtrl = parts.includes('Ctrl');
  const wantsAlt = parts.includes('Alt');
  const wantsShift = parts.includes('Shift');
  const wantsMeta = parts.includes('Meta');
  const actualKey = normalizeBindingKey(e.key);
  const ctrl = e.ctrlKey || e.metaKey;
  if (key.toLowerCase() !== actualKey.toLowerCase()) return false;
  if (wantsCtrl !== ctrl) return false;
  if (wantsAlt !== !!e.altKey) return false;
  if (wantsShift !== !!e.shiftKey) return false;
  if (wantsMeta && !e.metaKey) return false;
  return true;
}
function focusTimeline() { $('timelineScroller')?.focus(); }
function triggerKeybindAction(id) {
  switch (id) {
    case 'save': return saveProject();
    case 'undo': return undo();
    case 'redo': return redo();
    case 'play': return state.playing ? pause() : play();
    case 'stop': return stop();
    case 'framePrev': return setCurrentTime(state.currentTime - state.editorSettings.frameStep / state.project.fps);
    case 'frameNext': return setCurrentTime(state.currentTime + state.editorSettings.frameStep / state.project.fps);
    case 'selectTool': return setTool('select');
    case 'razorTool': return setTool('razor');
    case 'cutClip': return cutSelectedClipAtPlayhead();
    case 'deleteClip': return removeSelectedClip();
    case 'markIn': return $('setInBtn').click();
    case 'markOut': return $('setOutBtn').click();
    case 'clearRange': return $('clearRangeBtn').click();
    case 'zoomIn': return setTimelineZoom(state.timelineZoom + 10);
    case 'zoomOut': return setTimelineZoom(state.timelineZoom - 10);
    case 'export': return $('exportBtn').click();
    case 'settings': return openSettings();
    case 'fullscreen': return toggleFullscreen();
    case 'focusTimeline': return focusTimeline();
  }
}
function globalKeydown(e){
  if (state.keybindCapture) return;
  if ((e.target instanceof HTMLElement) && e.target.closest('#settingsDialog')) return;
  if ((e.target instanceof HTMLElement) && e.target.matches('input,textarea,select,[contenteditable="true"]')) return;
  for (const [id] of KEYBIND_META) {
    if (bindingMatches(e, bindingLabel(id))) { e.preventDefault(); triggerKeybindAction(id); return; }
  }
}

function setupTimelineGestures() {
  const scroller = $('timelineScroller');
  const wheel = e => {
    if (!e.target.closest('#timelinePanel')) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      setTimelineZoom(state.timelineZoom + (e.deltaY < 0 ? 6 : -6), e.clientX);
      return;
    }
    if (state.editorSettings.shiftPan && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      scroller.scrollLeft += e.deltaY || e.deltaX;
    }
  };
  document.addEventListener('wheel', wheel, { capture:true, passive:false });
  scroller.tabIndex=0;
}

function setupWorkspaceResizers() {
  const handles=[['leftResizeHandle','left'],['rightResizeHandle','right'],['timelineResizeHandle','timeline']];
  for(const [id,type] of handles){
    $(id).addEventListener('pointerdown',e=>{
      e.preventDefault();
      const cs=getComputedStyle(document.documentElement);
      state.resizeDrag={type,startX:e.clientX,startY:e.clientY,startLeft:parseFloat(cs.getPropertyValue('--left-w'))||state.editorSettings.leftWidth,startRight:parseFloat(cs.getPropertyValue('--right-w'))||state.editorSettings.rightWidth,startTimeline:parseFloat(cs.getPropertyValue('--timeline-h'))||state.editorSettings.timelineHeight};
      $(id).setPointerCapture?.(e.pointerId);
      document.body.classList.add('resizing-ui');document.body.classList.toggle('resizing-timeline',type==='timeline');
    });
  }
  document.addEventListener('pointermove',e=>{
    const d=state.resizeDrag;if(!d)return;
    if(d.type==='left'){
      state.editorSettings.leftWidth=clamp(d.startLeft+e.clientX-d.startX,220,Math.min(520,window.innerWidth*.42));
      document.documentElement.style.setProperty('--left-w',`${state.editorSettings.leftWidth}px`);
    }else if(d.type==='right'){
      state.editorSettings.rightWidth=clamp(d.startRight-(e.clientX-d.startX),240,Math.min(520,window.innerWidth*.42));
      document.documentElement.style.setProperty('--right-w',`${state.editorSettings.rightWidth}px`);
    }else{
      state.editorSettings.timelineHeight=clamp(d.startTimeline-(e.clientY-d.startY),220,Math.max(300,window.innerHeight*.68));
      document.documentElement.style.setProperty('--timeline-h',`${state.editorSettings.timelineHeight}px`);
    }
    renderTimeline();
  });
  document.addEventListener('pointerup',()=>{
    if(!state.resizeDrag)return;
    state.resizeDrag=null;document.body.classList.remove('resizing-ui','resizing-timeline');saveSettings();renderTimeline();
  });
  $('leftResizeHandle').ondblclick=()=>{state.editorSettings.leftWidth=310;applyEditorSettingsToUI();saveSettings();renderTimeline();};
  $('rightResizeHandle').ondblclick=()=>{state.editorSettings.rightWidth=320;applyEditorSettingsToUI();saveSettings();renderTimeline();};
  $('timelineResizeHandle').ondblclick=()=>{state.editorSettings.timelineHeight=320;applyEditorSettingsToUI();saveSettings();renderTimeline();};
}

function openSettings(section='general') { populateSettingsUI(); switchSettingsSection(section); const d=$('settingsDialog'); if(!d.open)d.showModal(); }
function switchSettingsSection(section){$$('.settings-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.settingsSection===section));$$('.settings-section').forEach(p=>p.classList.toggle('active',p.dataset.settingsPanel===section));}
function populateSettingsUI(){
  const s=state.editorSettings;
  $('settingAutosave').checked=s.autosave!==false;$('settingAutosaveInterval').value=String(s.autosaveInterval||3);$('settingConfirmDelete').checked=!!s.confirmDelete;$('settingShowScopes').checked=!!s.showScopes;$('settingReduceMotion').checked=!!s.reduceMotion;
  $('settingTimelineZoom').value=String(s.timelineZoom||100);$('settingTimelineDock').value=s.timelineDock||'bottom';$('settingScopesPosition').value=s.scopesPosition||'bottom';$('settingTrackHeight').value=String(s.trackHeight||60);$('settingSnap').checked=s.snap!==false;$('settingFollowPlayhead').checked=!!s.followPlayhead;$('settingShiftPan').checked=s.shiftPan!==false;
  $('settingLoop').checked=!!s.loopPlayback;$('settingFrameStep').value=String(s.frameStep||1);$('settingAccent').value=s.accent||DEFAULT_EDITOR_SETTINGS.accent;renderKeybindList();renderWorkspacePanelList();
}
function saveEditorSetting(prop,value){state.editorSettings[prop]=value;applyEditorSettingsToUI();saveSettings();if(prop==='trackHeight')renderTimeline();}
function renderKeybindList(){
  const list=$('keybindList');if(!list)return;list.innerHTML='';
  for(const [id,label] of KEYBIND_META){const row=document.createElement('div');row.className='keybind-row';const name=document.createElement('span');name.textContent=label;const btn=document.createElement('button');btn.className='keybind-button';btn.textContent=bindingLabel(id);btn.onclick=()=>captureKeybind(id,btn);row.append(name,btn);list.append(row);}
}
function captureKeybind(id,button){
  state.keybindCapture=id;$('keybindStatus').textContent=`Press a key for “${KEYBIND_META.find(x=>x[0]===id)?.[1]||id}”… Escape cancels.`;button.classList.add('capturing');
  const finish=e=>{
    if(e.key==='Escape'){e.preventDefault();cleanup();return;}
    const binding=eventToBinding(e);if(!binding)return;e.preventDefault();e.stopPropagation();
    const conflict=KEYBIND_META.find(([other])=>other!==id&&String(bindingLabel(other)).toLowerCase()===binding.toLowerCase());
    if(conflict){$('keybindStatus').textContent=`${binding} is already assigned to ${conflict[1]}.`;return;}
    state.editorSettings.keybinds[id]=binding;saveSettings();renderKeybindList();$('keybindStatus').textContent=`${KEYBIND_META.find(x=>x[0]===id)?.[1]||id} is now ${binding}.`;cleanup(false);
  };
  const cleanup=resetStatus=>{document.removeEventListener('keydown',finish,true);state.keybindCapture=null;button.classList.remove('capturing');if(resetStatus!==false)$('keybindStatus').textContent='Click a binding, then press the new shortcut.';};
  document.addEventListener('keydown',finish,true);
}
function resetKeybinds(){state.editorSettings.keybinds={...DEFAULT_KEYBINDS};renderKeybindList();$('keybindStatus').textContent='Default shortcuts restored.';saveSettings();}

function hideContextMenu(){const m=$('contextMenu');if(!m)return;m.classList.add('hidden');m.setAttribute('aria-hidden','true');state.contextTarget=null;}
function contextAction(label,fn,opts={}){return {label,fn,divider:!!opts.divider,disabled:!!opts.disabled,icon:opts.icon||''};}
function openContextMenu(e){
  e.preventDefault(); e.stopPropagation();
  const menu=$('contextMenu'),items=$('contextMenuItems'); if(!menu||!items)return;
  hideContextMenu();
  const target=e.target instanceof Element?e.target:null;
  const editable=target?.matches?.('input,textarea,[contenteditable=\"true\"]');
  if(editable){
    const valueTarget=target;
    state.contextTarget={editable:valueTarget};
    $('contextMenuTitle').textContent='Text';items.innerHTML='';
    const editActions=[
      contextAction('Undo',()=>document.execCommand('undo')),
      contextAction('Cut',()=>document.execCommand('cut')),
      contextAction('Copy',()=>document.execCommand('copy')),
      contextAction('Paste',async()=>{try{const txt=await navigator.clipboard.readText();document.execCommand('insertText',false,txt);}catch{toast('Clipboard access was blocked by the browser.','error');}}),
      contextAction('Select all',()=>{if(typeof valueTarget.select==='function')valueTarget.select();else{const r=document.createRange();r.selectNodeContents(valueTarget);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);}})
    ];
    editActions.forEach(a=>{const b=document.createElement('button');b.className='context-item';b.innerHTML=`<span>${a.icon||''}</span><b>${a.label}</b>`;b.onclick=()=>{hideContextMenu();a.fn();};items.append(b);});
    menu.classList.remove('hidden');menu.setAttribute('aria-hidden','false');const mw=menu.offsetWidth,mh=menu.offsetHeight;menu.style.left=`${clamp(e.clientX,6,window.innerWidth-mw-6)}px`;menu.style.top=`${clamp(e.clientY,6,window.innerHeight-mh-6)}px`;return;
  }
  let clipEl=target?.closest?.('.timeline-clip-hit');
  let asset=target?.closest?.('.asset-card');
  let track=target?.closest?.('.track-header');
  let timelineClip=null;
  if(target?.closest?.('#timelineCanvas')){const p=timelinePointer(e);const tk=trackAtY(p.y);const tm=snapTime(xToTime(p.x));timelineClip=tk?.clips.find(c=>tm>=c.start&&tm<=c.start+c.duration)||null;clipEl=timelineClip?{dataset:{clipId:timelineClip.id}}:null;track=null;}
  const panel=target?.closest?.('#projectPanel,#centerStage,.inspector-panel,#scopesPanel,#timelinePanel');
  state.contextTarget={clipId:clipEl?.dataset?.clipId||state.selectedClipId,assetId:asset?.dataset?.assetId||state.selectedAssetId,trackId:track?.dataset?.trackId,panelId:panelIdFromElement(panel)};
  let title='Axiom Editor'; let actions=[];
  if(clipEl||state.contextTarget.clipId){
    const c=getClipById(state.contextTarget.clipId);
    if(c){title=c.name||'Clip';actions=[contextAction('Cut at playhead',cutSelectedClipAtPlayhead,{icon:'✂'}),contextAction('Copy',()=>copySelectedClip()),contextAction('Cut',()=>cutSelectionToClipboard()),contextAction('Duplicate',()=>duplicateSelectedClip()),contextAction('Delete',()=>removeSelectedClip()),{divider:true},contextAction('AI Object Cutout…',()=>openAICutout(c),{disabled:c.type==='audio'}),contextAction('Add text at playhead',addTextClip)];}
  }else if(asset){
    const meta=state.assetMeta.get(state.contextTarget.assetId); title=meta?.name||'Media'; actions=[contextAction('Add to timeline',()=>insertAssetIntoTimeline(state.contextTarget.assetId)),contextAction('Rename',()=>renameAsset(state.contextTarget.assetId)),contextAction('Delete from project',()=>removeAssetFromProject(state.contextTarget.assetId))];
  }else if(track){
    const t=getTrackById(state.contextTarget.trackId);title=t?.name||'Track';actions=[contextAction('Rename track',()=>{const name=prompt('Rename track',t?.name||'Track');if(name?.trim()){pushUndo();t.name=name.trim();renderTrackHeaders();saveProjectSoon();}}),contextAction('Add video track above',()=>addTrack('video')),contextAction('Add text track above',()=>addTrack('text')),contextAction('Add audio track above',()=>addTrack('audio')),{divider:true},contextAction(t?.muted?'Unmute':'Mute',()=>toggleTrackFlag(t,'muted')),contextAction(t?.locked?'Unlock':'Lock',()=>toggleTrackFlag(t,'locked')),contextAction('Delete track',()=>deleteTrack(t.id))];
  }else if(panel){title=panelLabel(state.contextTarget.panelId);actions=[contextAction('Hide panel',()=>setPanelVisible(state.contextTarget.panelId,false)),contextAction('Arrange panels',()=>setPanelArrangeMode(true)),contextAction(state.contextTarget.panelId==='timeline'?(state.editorSettings.timelineDock==='top'?'Move timeline to bottom':'Move timeline to top'):state.contextTarget.panelId==='scopes'?(state.editorSettings.scopesPosition==='top'?'Move scopes below preview':'Move scopes above preview'):'Reset workspace',()=>{if(state.contextTarget.panelId==='timeline'){state.editorSettings.timelineDock=state.editorSettings.timelineDock==='top'?'bottom':'top';}else if(state.contextTarget.panelId==='scopes'){state.editorSettings.scopesPosition=state.editorSettings.scopesPosition==='top'?'bottom':'top';}else{resetWorkspaceLayout();return;}applyEditorSettingsToUI();saveSettings();})];
  }else {
    title='Timeline'; actions=[contextAction('Add video track',()=>addTrack('video')),contextAction('Add text track',()=>addTrack('text')),contextAction('Add audio track',()=>addTrack('audio')),contextAction('Add title',addTextClip),contextAction('Paste clip',pasteClipboard,{disabled:!state.clipboardClip})];
  }
  $('contextMenuTitle').textContent=title;items.innerHTML='';
  for(const a of actions){ if(a.divider){const hr=document.createElement('div');hr.className='context-divider';items.append(hr);continue;} const b=document.createElement('button');b.className='context-item';b.disabled=!!a.disabled;b.innerHTML=`<span>${a.icon||''}</span><b>${a.label}</b>`;b.onclick=()=>{hideContextMenu();try{a.fn();}catch(err){console.error(err);toast(err.message,'error');}};items.append(b);}
  menu.classList.remove('hidden');menu.setAttribute('aria-hidden','false');
  const mw=menu.offsetWidth,mh=menu.offsetHeight;menu.style.left=`${clamp(e.clientX,6,window.innerWidth-mw-6)}px`;menu.style.top=`${clamp(e.clientY,6,window.innerHeight-mh-6)}px`;
}
function copySelectedClip(){const c=getSelectedClip();if(!c)return;state.clipboardClip=structuredClone(c);toast('Clip copied.','good');}
function cutSelectionToClipboard(){const c=getSelectedClip();if(!c)return;copySelectedClip();removeSelectedClip();}
function pasteClipboard(){if(!state.clipboardClip||!state.project)return;const source=structuredClone(state.clipboardClip);const track=getTrackById(source.trackId)||state.project.tracks.find(t=>t.type===source.type&& !t.locked)||state.project.tracks[0];if(!track)return;source.id=uid('clip');source.trackId=track.id;source.start=snapTime(state.currentTime);track.clips.push(source);state.selectedClipId=source.id;ensureProjectDuration();updateUI();render();saveProjectSoon();}
function duplicateSelectedClip(){copySelectedClip();pasteClipboard();}
function toggleTrackFlag(track,prop){if(!track)return;pushUndo();track[prop]=!track[prop];updateUI();render();saveProjectSoon();}
function renameAsset(id){const meta=state.assetMeta.get(id);if(!meta)return;const name=prompt('Rename media',meta.name);if(!name?.trim())return;meta.name=name.trim();state.assetMeta.set(id,meta);idbPut(STORE_ASSETS,structuredClone(meta)).catch(()=>{});renderAssets();}
function removeAssetFromProject(id){if(!id)return;state.assetMeta.delete(id);state.assetFiles.delete(id);const url=state.assetUrls.get(id);if(url)URL.revokeObjectURL(url);state.assetUrls.delete(id);for(const t of state.project.tracks)t.clips=t.clips.filter(c=>c.assetId!==id);state.selectedAssetId=null;state.selectedClipId=null;updateUI();render();saveProjectSoon();}
function renderAICutoutFrame(){const c=getSelectedClip();const canvas=$('aiCutoutCanvas');if(!c||!canvas)return;const m=getAssetMeta(c.assetId);if(!m||c.type==='audio')return;const src=ensureMedia(c.assetId,c.type==='image'?'image':'video');if(!src)return;const ct=canvas.getContext('2d');canvas.width=960;canvas.height=Math.max(1,Math.round(960*(state.project.height/state.project.width)));ct.clearRect(0,0,canvas.width,canvas.height);if(src.tagName==='VIDEO')src.currentTime=getClipLocalTime(c);ct.drawImage(src,0,0,canvas.width,canvas.height);if(state.aiCutout.sourcePoint){const p=state.aiCutout.sourcePoint;ct.strokeStyle='#d9ff5f';ct.lineWidth=4;ct.beginPath();ct.arc(p.x*canvas.width,p.y*canvas.height,10,0,Math.PI*2);ct.stroke();}}
function openAICutout(clip){if(!clip||clip.type==='audio'||!clip.assetId){toast('Select a video or image clip for object cutout.','error');return;}state.selectedClipId=clip.id;state.aiCutout={sampled:null,picking:false,clipId:clip.id,sourcePoint:null};renderAICutoutFrame();$('aiSampleStatus').textContent='No object sampled.';$('aiCutoutDialog').showModal();}
function createObjectCutout(){const c=getSelectedClip();const a=state.aiCutout;if(!c||!a.sampled||!a.sourcePoint)return toast('Pick an object first.','error');pushUndo();const radius=Number($('aiCutoutRadius').value)/100*Math.min(state.project.width,state.project.height);const dir=$('aiCutoutDirection').value;const speed=Number($('aiCutoutSpeed').value);const tracking=Number($('aiCutoutTracking').value)/100;c.mask={enabled:true,mode:'color',color:a.sampled,tolerance:Number($('aiCutoutTolerance').value)/100,feather:Number($('aiCutoutFeather').value),radius,center:{x:a.sourcePoint.x*state.project.width,y:a.sourcePoint.y*state.project.height},direction:dir,speed,tracking};$('aiCutoutDialog').close();updateInspector();render();saveProjectSoon();toast('Local object cutout created.','good');}
function createTextBehindSetup(){
  const c=getSelectedClip();
  if(!c||!state.aiCutout.sampled)return toast('Pick an object first.','error');
  createObjectCutout();
  const originalTrack=getTrackById(c.trackId);
  if(!originalTrack)return;
  pushUndo();
  const foregroundTrack=defaultTrack('video',state.project.tracks.filter(x=>x.type==='video').length+1);foregroundTrack.name='Foreground';
  const foreground=structuredClone(c);foreground.id=uid('clip');foreground.name=`${c.name} — foreground`;foreground.trackId=foregroundTrack.id;foregroundTrack.clips=[foreground];
  const textTrack=state.project.tracks.find(t=>t.type==='text'&&!t.locked)||defaultTrack('text',state.project.tracks.filter(x=>x.type==='text').length+1);textTrack.name=textTrack.name||'T1';
  const title={id:uid('clip'),assetId:null,trackId:textTrack.id,type:'text',name:'Behind Object Title',start:c.start,duration:c.duration,sourceStart:0,sourceDuration:c.duration,speed:1,transform:{x:state.project.width/2,y:state.project.height/2,scale:1,rotation:0},opacity:1,volume:0,blend:'source-over',effects:{brightness:0,contrast:0,saturation:0,hue:0,blur:0,grayscale:0,sepia:0,keyStrength:0,keyColor:'#00ff00',vignette:0,zoom:0,glitch:0,lift:0,gamma:1,gain:1},keyframes:{opacity:[],x:[],y:[],scale:[],rotation:[],volume:[]},text:{content:'Your title',size:92,weight:800,color:'#ffffff',stroke:'#000000',strokeWidth:6,tracking:0},lut:null};
  if(!textTrack.clips.includes(title))textTrack.clips.push(title);
  const withoutText=state.project.tracks.filter(t=>t.id!==foregroundTrack.id&&t.id!==textTrack.id);
  const baseIndex=Math.max(0,withoutText.indexOf(originalTrack));
  withoutText.splice(baseIndex,0,foregroundTrack);withoutText.splice(baseIndex+1,0,textTrack);state.project.tracks=withoutText;
  state.selectedClipId=title.id;ensureProjectDuration();updateUI();render();saveProjectSoon();$('aiCutoutDialog').close();toast('Text-behind setup created. Edit the new title in the Inspector.','good');
}

function setupContextMenus(){document.addEventListener('contextmenu',openContextMenu);document.addEventListener('pointerdown',e=>{if(!e.target.closest('#contextMenu'))hideContextMenu();});document.addEventListener('keydown',e=>{if(e.key==='Escape')hideContextMenu();});}

function setupDropZone(){
  const overlay=$('dropOverlay');let depth=0;
  document.addEventListener('dragenter',e=>{if([...e.dataTransfer.types].includes('Files')){depth++;overlay.classList.remove('hidden');}});
  document.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)overlay.classList.add('hidden');});
  document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
  document.addEventListener('drop',e=>{if(!e.dataTransfer.files?.length)return;e.preventDefault();depth=0;overlay.classList.add('hidden');importFiles([...e.dataTransfer.files]);});
}
function toggleFullscreen(){const viewer=$('viewer');if(!document.fullscreenElement)viewer.requestFullscreen?.();else document.exitFullscreen?.();}

async function detectCapabilities(){
  state.gpu.webgpu=!!navigator.gpu;
  const probe=document.createElement('canvas');state.gpu.webgl2=!!probe.getContext('webgl2');
  if(window.VideoDecoder && window.VideoEncoder){$('decoderStatus').textContent='WebCodecs';$('exportStatus').textContent='WebCodecs available';}
  else $('decoderStatus').textContent='Media Element';
  if(state.gpu.webgpu) $('gpuStatus').textContent='WebGPU ready';
  try{await openDatabase();$('storageStatus').textContent=navigator.storage?.getDirectory?'IndexedDB + OPFS':'IndexedDB';}catch{ $('storageStatus').textContent='Browser storage unavailable'; }
}

async function initPWA(){
  if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js');$('offlineBadge').textContent='PWA cached';}catch(err){console.warn('SW registration failed',err);}}
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.pwaDeferredPrompt=e;$('installBtn').classList.remove('hidden');});
}
async function installPWA(){if(!state.pwaDeferredPrompt)return;state.pwaDeferredPrompt.prompt();await state.pwaDeferredPrompt.userChoice.catch(()=>{});state.pwaDeferredPrompt=null;$('installBtn').classList.add('hidden');}


function normalizePanelOrder(order){ const valid=['media','preview','inspector']; const out=[]; for(const x of order||[]) if(valid.includes(x)&&!out.includes(x)) out.push(x); for(const x of valid) if(!out.includes(x)) out.push(x); return out; }
function applyPanelLayout(){
  const s=state.editorSettings, order=normalizePanelOrder(s.panelOrder), map={media:$('projectPanel'),preview:$('centerStage'),inspector:document.querySelector('.inspector-panel')};
  for(const id of Object.keys(map)){const el=map[id];if(el)el.classList.toggle('panel-hidden-by-user',s.panelVisibility?.[id]===false);}
  const visible=order.filter(id=>s.panelVisibility?.[id]!==false), positions=[1,3,5];
  for(const id of order){const el=map[id];if(el)el.style.gridColumn='';}
  visible.forEach((id,i)=>{const el=map[id];if(el)el.style.gridColumn=String(positions[i]);});
  const ws=document.querySelector('.workspace');
  ws.style.gridTemplateColumns=visible.length===3 ? 'var(--left-w) 5px minmax(520px,1fr) 5px var(--right-w)' : visible.length===2 ? 'minmax(220px,1fr) 5px minmax(480px,2fr) 5px minmax(220px,1fr)' : visible.length===1 ? 'minmax(0,1fr) 0 minmax(0,1fr) 0 minmax(0,1fr)' : '1fr 0 1fr 0 1fr';
  $('leftResizeHandle')?.classList.toggle('hidden',visible.length<2); $('rightResizeHandle')?.classList.toggle('hidden',visible.length<3);
  $('timelinePanel')?.classList.toggle('panel-hidden-by-user',s.panelVisibility?.timeline===false);
  $('scopesPanel')?.classList.toggle('hidden',s.panelVisibility?.scopes===false || !s.showScopes); $('scopesPanel')?.closest('.center-stage')?.classList.toggle('scopes-hidden',s.panelVisibility?.scopes===false || !s.showScopes);
  if ($('timelinePanel')?.classList.contains('panel-hidden-by-user')) document.documentElement.style.setProperty('--timeline-h','0px'); else document.documentElement.style.setProperty('--timeline-h',`${clamp(Number(s.timelineHeight)||320,220,Math.max(300,window.innerHeight*.68))}px`);
}
function resetWorkspaceLayout(){state.editorSettings.leftWidth=310;state.editorSettings.rightWidth=320;state.editorSettings.timelineHeight=320;state.editorSettings.timelineDock='bottom';state.editorSettings.scopesPosition='bottom';resetPanelLayout(false);applyEditorSettingsToUI();renderTimeline();saveSettings();toast('Workspace layout reset.','good');}
function resetPanelLayout(notify=true){state.editorSettings.panelVisibility={media:true,preview:true,scopes:false,inspector:true,timeline:true};state.editorSettings.panelOrder=['media','preview','inspector'];state.editorSettings.showScopes=false;applyEditorSettingsToUI();renderWorkspacePanelList();renderTimeline();saveSettings();if(notify)toast('Default panel layout restored.','good');}
function setPanelVisible(id,visible){state.editorSettings.panelVisibility[id]=!!visible;if(id==='scopes')state.editorSettings.showScopes=!!visible;applyEditorSettingsToUI();renderWorkspacePanelList();renderTimeline();saveSettings();}
function panelLabel(id){return({media:'Media',preview:'Preview',scopes:'Scopes',inspector:'Inspector',timeline:'Timeline'})[id]||id;}
function renderWorkspacePanelList(){const list=$('workspacePanelList');if(!list)return;list.innerHTML='';const order=[...normalizePanelOrder(state.editorSettings.panelOrder),'scopes','timeline'];const seen=new Set();for(const id of order){if(seen.has(id))continue;seen.add(id);const row=document.createElement('div');row.className='workspace-panel-row';row.draggable=true;row.dataset.panelId=id;const grip=document.createElement('span');grip.className='workspace-drag-grip';grip.textContent='⋮⋮';const copy=document.createElement('div');copy.className='workspace-panel-copy';copy.innerHTML=`<b>${panelLabel(id)}</b><small>${id==='scopes'?'Histogram, waveform and vectorscope':id==='timeline'?'Main editing timeline':'Main editor panel'}</small>`;const toggle=document.createElement('button');toggle.className='workspace-toggle';toggle.textContent=state.editorSettings.panelVisibility?.[id]===false?'Hidden':'Visible';toggle.classList.toggle('active',state.editorSettings.panelVisibility?.[id]!==false);toggle.onclick=()=>setPanelVisible(id,state.editorSettings.panelVisibility?.[id]===false);row.append(grip,copy,toggle);list.append(row);}}
function setupPanelDrag(){const list=$('workspacePanelList');if(!list)return;list.addEventListener('dragstart',e=>{if(!state.panelArrangeMode)return;e.preventDefault();});}
function setPanelArrangeMode(enabled){
  state.panelArrangeMode=!!enabled;
  document.body.classList.toggle('panel-arrange-mode',state.panelArrangeMode);
  $('arrangePanelsBtn').textContent=state.panelArrangeMode?'Finish arranging':'Arrange panels';
  $('arrangeModeStatus').classList.toggle('hidden',!state.panelArrangeMode);
  document.querySelectorAll('.dockable-panel,.project-panel,.inspector-panel,.timeline-panel').forEach(panel=>{
    panel.draggable=state.panelArrangeMode;
    panel.classList.toggle('panel-arrange-target',state.panelArrangeMode);
  });
  if(!state.panelArrangeMode) saveSettings();
}
function panelIdFromElement(el){ if(!el)return null; if(el.id==='projectPanel')return'media'; if(el.id==='centerStage')return'preview'; if(el.classList.contains('inspector-panel'))return'inspector'; if(el.id==='scopesPanel')return'scopes'; if(el.id==='timelinePanel')return'timeline'; return el.closest('[data-panel-id]')?.dataset.panelId||null; }
function swapPanelOrder(a,b){
  if(!a||!b||a===b)return;
  const arr=normalizePanelOrder(state.editorSettings.panelOrder);
  if(!arr.includes(a)||!arr.includes(b))return;
  const ia=arr.indexOf(a),ib=arr.indexOf(b);[arr[ia],arr[ib]]=[arr[ib],arr[ia]];state.editorSettings.panelOrder=arr;applyPanelLayout();renderWorkspacePanelList();saveSettings();
}
function setupEditorPanelDrag(){
  const panels=()=>document.querySelectorAll('.dockable-panel,.project-panel,.inspector-panel,.timeline-panel');
  const wire=()=>panels().forEach(panel=>{
    if(panel.dataset.dragWired)return; panel.dataset.dragWired='1';
    panel.addEventListener('dragstart',e=>{if(!state.panelArrangeMode || !e.target.closest('.panel-header,.viewer-topline,.scope-panel-toolbar,.inspector-top,.timeline-titlebar')){e.preventDefault();return;}state.panelDragId=panelIdFromElement(panel);panel.classList.add('dragging-panel');e.dataTransfer.effectAllowed='move';});
    panel.addEventListener('dragover',e=>{if(!state.panelArrangeMode||!state.panelDragId)return;const target=panelIdFromElement(panel);if(target&&target!==state.panelDragId){e.preventDefault();panel.classList.add('drop-panel-target');}});
    panel.addEventListener('dragleave',()=>panel.classList.remove('drop-panel-target'));
    panel.addEventListener('drop',e=>{if(!state.panelArrangeMode||!state.panelDragId)return;e.preventDefault();const target=panelIdFromElement(panel);panel.classList.remove('drop-panel-target');if(target&&target!==state.panelDragId){if(state.panelDragId==='timeline'){state.editorSettings.timelineDock='top';applyEditorSettingsToUI();saveSettings();}else if(target==='timeline'){state.editorSettings.timelineDock='bottom';applyEditorSettingsToUI();saveSettings();}else if((state.panelDragId==='scopes'&&target==='preview')||(state.panelDragId==='preview'&&target==='scopes')){state.editorSettings.scopesPosition=state.editorSettings.scopesPosition==='top'?'bottom':'top';applyEditorSettingsToUI();saveSettings();}else swapPanelOrder(state.panelDragId,target);}});
    panel.addEventListener('dragend',()=>{panel.classList.remove('dragging-panel');document.querySelectorAll('.drop-panel-target').forEach(x=>x.classList.remove('drop-panel-target'));state.panelDragId=null;});
  });
  wire();
}

function showDashboard(){state.dashboardMode=true;$('app').classList.add('dashboard-active');$('dashboard').classList.remove('hidden');renderDashboard();}
function hideDashboard(){state.dashboardMode=false;$('app').classList.remove('dashboard-active');$('dashboard').classList.add('hidden');applyEditorSettingsToUI();render();renderTimeline();}
async function openProjectFromDashboard(id){const p=await idbGet(STORE_PROJECTS,id).catch(()=>null);if(!p)return;hideDashboard();await loadProject(p);toast(`Opened ${p.name}.`,'good');}
function formatRelativeDate(ts){const d=Date.now()-ts;if(d<60000)return'Just now';if(d<3600000)return`${Math.floor(d/60000)}m ago`;if(d<86400000)return`${Math.floor(d/3600000)}h ago`;if(d<604800000)return`${Math.floor(d/86400000)}d ago`;return new Date(ts).toLocaleDateString();}
function renderDashboard(){const grid=$('dashboardGrid');if(!grid||!state.db)return;idbGetAll(STORE_PROJECTS).then(projects=>{const query=String(state.dashboardSearch||'').trim().toLowerCase();const sorted=projects.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));const filtered=sorted.filter(p=>!query||String(p.name||'').toLowerCase().includes(query));const shown=state.dashboardFilter==='recent'?filtered.slice(0,12):filtered;$('dashboardEmpty').classList.toggle('hidden',shown.length>0);grid.innerHTML='';for(const p of shown){const card=document.createElement('button');card.className='dashboard-card';card.onclick=()=>openProjectFromDashboard(p.id);const thumb=document.createElement('div');thumb.className='dashboard-card-thumb';if(p.thumbnail){const img=document.createElement('img');img.src=p.thumbnail;img.alt='';thumb.append(img);}else thumb.innerHTML='<span>AX</span>';const body=document.createElement('div');body.className='dashboard-card-body';const name=document.createElement('strong');name.textContent=p.name||'Untitled';const meta=document.createElement('span');meta.textContent=`${p.width}×${p.height} · ${p.fps} fps`;const updated=document.createElement('small');updated.textContent=formatRelativeDate(p.updatedAt||p.createdAt);body.append(name,meta,updated);card.append(thumb,body);grid.append(card);}$('dashboardStorage').textContent=navigator.storage?.getDirectory?'IndexedDB + OPFS':'IndexedDB';});}

async function boot(){
  await detectCapabilities();
  attachEvents();
  await restoreLastProject();
  applyEditorSettingsToUI();
  await restoreAssetsForProject();
  updateRackUI();
  initPWA();
  render();
  window.addEventListener('resize',()=>renderTimeline());
  renderDashboard();
  showDashboard();
  toast('Axiom Editor is running locally.','good');
}

function updateRackUI(){const r=state.project.settings.rack;$('rackLow').value=r.low;$('rackMid').value=r.mid;$('rackHigh').value=r.high;$('rackComp').value=r.comp;$('rackReverb').value=r.reverb;$('rackDuck').checked=r.duck;for(const id of ['rackLow','rackMid','rackHigh','rackComp','rackReverb'])$(id).addEventListener('input',e=>{const map={rackLow:'low',rackMid:'mid',rackHigh:'high',rackComp:'comp',rackReverb:'reverb'};state.project.settings.rack[map[id]]=Number(e.target.value);saveProjectSoon();});$('rackDuck').addEventListener('change',e=>{state.project.settings.rack.duck=e.target.checked;saveProjectSoon();});}

boot().catch(err=>{console.error(err);toast(`Axiom Editor startup error: ${err.message}`,'error');});
