(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = (prefix = 'id') => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`}`;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const humanBytes = bytes => {
    if (!Number.isFinite(bytes)) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const formatDuration = seconds => {
    seconds = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}`;
  };
  const timecode = seconds => {
    const fps = state.project.fps || 30;
    const frames = Math.floor(Math.max(0, seconds) * fps + 0.00001);
    const hh = Math.floor(frames / (fps * 3600));
    const mm = Math.floor(frames / (fps * 60)) % 60;
    const ss = Math.floor(frames / fps) % 60;
    const ff = frames % fps;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
  };
  const defaultTracks = () => [
    { id: uid('track'), name: 'V2', kind: 'video', muted: false, locked: false },
    { id: uid('track'), name: 'V1', kind: 'video', muted: false, locked: false },
    { id: uid('track'), name: 'A1', kind: 'audio', muted: false, locked: false },
    { id: uid('track'), name: 'A2', kind: 'audio', muted: false, locked: false }
  ];
  const makeProject = () => ({
    id: uid('project'), name: 'Untitled Project', sequenceName: 'Sequence 01', width: 1920, height: 1080, fps: 30,
    playhead: 0, magnetic: true, tracks: defaultTracks(), clips: [], markers: [], assetIds: [], createdAt: Date.now(), modifiedAt: Date.now(),
    background: '#08090a', colorNodes: [{ id: uid('node'), type: 'Input' }, { id: uid('node'), type: 'Primary' }, { id: uid('node'), type: 'Output' }]
  });

  const state = {
    project: makeProject(), assets: [], selectedAssetId: null, selectedClipId: null, selectedTrackId: null,
    activeInspectorTab: 'properties', activeTool: 'select', zoom: 76, playing: false, playOrigin: 0, playStartedAt: 0,
    previewObjectUrl: null, assetUrls: new Map(), audioPreviewPlayers: new Map(), undo: [], redo: [], savedSignature: '', saveTimer: null, isDirty: false,
    isListView: false, drag: null, contextTarget: null, aiInstalled: false, settings: { magnetic: true, autoSave: true, autoSaveSeconds: 5, workspace: 'editing', keymap: 'axiom', safeArea: false, cacheLimitGB: 20, aiPromptSeen: false, showWaveforms: true },
    keymap: { playPause: 'Space', save: 'Ctrl+s', undo: 'Ctrl+z', redo: 'Ctrl+Shift+z', split: 'c', select: 'v', addMarker: 'm', export: 'Ctrl+e', delete: 'Delete' },
    exportAbort: false, exporting: false, scopeTimer: null, activePanel: null
  };

  function notify(message, type = 'info', timeout = 3000) {
    const stack = $('#toastStack');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    stack.append(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    window.setTimeout(() => { toast.classList.remove('visible'); window.setTimeout(() => toast.remove(), 220); }, timeout);
  }

  function openModal(id) {
    closeDropdown();
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.hidden = false;
    const focusable = modal.querySelector('button, input, select, textarea');
    if (focusable) window.setTimeout(() => focusable.focus(), 25);
  }
  function closeModal(id) { const modal = document.getElementById(id); if (modal) modal.hidden = true; }
  function closeAllModals() { $$('.modal-backdrop').forEach(modal => { modal.hidden = true; }); }

  const menus = {
    fileMenu: [['New project', 'newProject'], ['Open project…', 'openProject'], ['Save project', 'save'], ['Export project JSON', 'downloadProject'], ['separator'], ['Export sequence…', 'export'], ['separator'], ['Settings', 'settings']],
    editMenu: [['Undo', 'undo', 'Ctrl+Z'], ['Redo', 'redo', 'Ctrl+Shift+Z'], ['separator'], ['Cut selected clip', 'split', 'C'], ['Duplicate selected clip', 'duplicate', 'Ctrl+D'], ['Delete selected clip', 'delete', 'Delete']],
    viewMenu: [['Workspace: Editing', 'workspaceEditing'], ['Workspace: Media ingest', 'workspaceIngest'], ['Workspace: Color', 'workspaceColor'], ['Workspace: Audio', 'workspaceAudio'], ['separator'], ['Toggle layout editing', 'layoutEdit'], ['Fullscreen viewer', 'fullscreen'], ['Show safe guides', 'safeArea']],
    clipMenu: [['Add title clip', 'addTitle'], ['Add adjustment clip', 'addAdjustment'], ['Split at playhead', 'split'], ['Duplicate selected clip', 'duplicate'], ['Delete selected clip', 'delete'], ['separator'], ['Detect scene cuts', 'sceneCuts']],
    sequenceMenu: [['Sequence settings…', 'sequenceSettings'], ['Add video track', 'addVideoTrack'], ['Add audio track', 'addAudioTrack'], ['Add marker', 'addMarker'], ['Toggle magnetic timeline', 'magnetic']],
    aiMenu: [['Optional AI setup…', 'aiSetup'], ['Transcribe selected media', 'transcribe'], ['Detect scene cuts', 'sceneCuts'], ['separator'], ['AI model settings', 'aiSettings']]
  };

  function showMenu(menuId, button) {
    const popup = $('#dropdownMenu');
    const wasOpen = !popup.hidden && popup.dataset.menu === menuId;
    closeDropdown();
    if (wasOpen) return;
    const entries = menus[menuId] || [];
    popup.innerHTML = entries.map(entry => entry[0] === 'separator' ? '<div class="dropdown-divider"></div>' : `<button type="button" data-action="${esc(entry[1])}"><span>${esc(entry[0])}</span>${entry[2] ? `<span>${esc(entry[2])}</span>` : ''}</button>`).join('');
    const bounds = button.getBoundingClientRect();
    popup.style.left = `${clamp(bounds.left, 8, window.innerWidth - 235)}px`;
    popup.style.top = `${clamp(bounds.bottom + 4, 8, window.innerHeight - 330)}px`;
    popup.dataset.menu = menuId;
    popup.hidden = false;
  }
  function closeDropdown() { const popup = $('#dropdownMenu'); if (popup) { popup.hidden = true; popup.innerHTML = ''; delete popup.dataset.menu; } }

  function assetById(id) { return state.assets.find(asset => asset.id === id) || null; }
  function clipById(id = state.selectedClipId) { return state.project.clips.find(clip => clip.id === id) || null; }
  function trackById(id) { return state.project.tracks.find(track => track.id === id) || null; }
  function clipEnd(clip) { return clip.start + clip.duration; }
  function sequenceDuration() { return Math.max(0.1, ...state.project.clips.map(clipEnd), 0); }
  function timelineExtent() { return Math.max(10, sequenceDuration(), state.project.playhead || 0, ...state.project.markers.map(marker => marker.time || 0), 0); }
  function selectedClips() { return state.project.clips.filter(clip => clip.id === state.selectedClipId); }
  function markDirty() {
    state.isDirty = true;
    $('#saveDot').classList.add('unsaved');
    $('#saveStatus').textContent = 'Unsaved changes';
    if (state.saveTimer) clearTimeout(state.saveTimer);
    if (state.settings.autoSave) state.saveTimer = setTimeout(() => saveProject(false), Math.max(2, Number(state.settings.autoSaveSeconds) || 5) * 1000);
  }

  function serializeProject() {
    const project = JSON.parse(JSON.stringify(state.project));
    project.name = $('#projectName').value.trim() || 'Untitled Project';
    project.assetIds = state.project.assetIds.slice();
    project.modifiedAt = Date.now();
    return project;
  }
  async function saveProject(showToast = true) {
    try {
      state.project.name = $('#projectName').value.trim() || 'Untitled Project';
      const project = serializeProject();
      await AxiomStorage.saveProject(project);
      state.project.modifiedAt = project.modifiedAt;
      state.savedSignature = JSON.stringify(project);
      state.isDirty = false;
      $('#saveDot').classList.remove('unsaved');
      $('#saveStatus').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      $('#appStatus').textContent = 'Project saved locally';
      if (showToast) notify('Project saved to this browser.', 'success');
      return true;
    } catch (error) {
      $('#saveStatus').textContent = 'Local save unavailable';
      if (showToast) notify(`Could not save project: ${error.message}`, 'error', 5000);
      return false;
    }
  }
  function rememberHistory(label = 'Edit') {
    const snapshot = JSON.stringify(state.project);
    if (state.undo.length && state.undo[state.undo.length - 1].snapshot === snapshot) return;
    state.undo.push({ label, snapshot });
    if (state.undo.length > 80) state.undo.shift();
    state.redo.length = 0;
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('#undoButton').disabled = !state.undo.length;
    $('#redoButton').disabled = !state.redo.length;
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push({ label: 'Redo', snapshot: JSON.stringify(state.project) });
    const item = state.undo.pop();
    state.project = JSON.parse(item.snapshot);
    state.project.playhead = clamp(state.project.playhead || 0, 0, timelineExtent());
    renderEverything(); markDirty(); updateUndoButtons();
    notify(`Undid ${item.label.toLowerCase()}.`);
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push({ label: 'Undo', snapshot: JSON.stringify(state.project) });
    const item = state.redo.pop();
    state.project = JSON.parse(item.snapshot);
    renderEverything(); markDirty(); updateUndoButtons();
    notify('Edit restored.');
  }

  function fileKind(file) {
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('image/')) return 'image';
    const name = file.name.toLowerCase();
    if (/\.(mp4|mov|webm|mkv|m4v|avi|ogv)$/.test(name)) return 'video';
    if (/\.(wav|mp3|m4a|aac|flac|ogg|opus)$/.test(name)) return 'audio';
    if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name)) return 'image';
    return null;
  }
  function loadMediaMetadata(file, kind) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file); let settled = false; let timer;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(result); };
      if (kind === 'image') {
        const image = new Image();
        image.onload = () => finish({ duration: 5, width: image.naturalWidth || 0, height: image.naturalHeight || 0, hasVideo: false });
        image.onerror = () => finish({ duration: 5, width: 0, height: 0, hasVideo: false });
        image.src = url;
      } else {
        const media = document.createElement(kind === 'audio' ? 'audio' : 'video');
        media.preload = 'metadata';
        media.onloadedmetadata = () => finish({ duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 10, width: media.videoWidth || 0, height: media.videoHeight || 0, hasVideo: kind === 'video' });
        media.onerror = () => finish({ duration: 10, width: 0, height: 0, hasVideo: kind === 'video' });
        media.src = url;
      }
      timer = setTimeout(() => finish({ duration: 10, width: 0, height: 0, hasVideo: kind === 'video' }), 8000);
    });
  }

  async function importFiles(fileList, handles = []) {
    const files = [...fileList];
    const candidates = files.map((file, index) => ({ file, kind: fileKind(file), handle: handles[index] || null })).filter(item => item.kind);
    if (!candidates.length) { notify('No supported video, audio, or image files were found.', 'error'); return; }
    $('#appStatus').textContent = `Importing ${candidates.length} asset${candidates.length === 1 ? '' : 's'}…`;
    let imported = 0;
    for (const item of candidates) {
      try {
        const meta = await loadMediaMetadata(item.file, item.kind);
        const record = {
          id: uid('asset'), name: item.file.name, type: item.kind, mimeType: item.file.type || '', size: item.file.size,
          duration: meta.duration, width: meta.width, height: meta.height, lastModified: item.file.lastModified || Date.now(),
          addedAt: Date.now(), storage: item.handle ? 'linked' : 'local', sourceName: item.file.name
        };
        const saved = await AxiomStorage.saveAsset(record, item.file, item.handle);
        state.assets.push({ ...saved, storage: item.handle ? 'linked' : (saved.storage || 'local') });
        state.project.assetIds.push(record.id);
        imported++;
      } catch (error) {
        notify(`Couldn't import ${item.file.name}: ${error.message}`, 'error', 4500);
      }
    }
    state.selectedAssetId = state.assets.length ? state.assets[state.assets.length - 1].id : null;
    renderMediaBin();
    $('#appStatus').textContent = `${imported} asset${imported === 1 ? '' : 's'} imported locally`;
    if (imported) {
      markDirty();
      await AxiomStorage.logActivity({ action: 'import', count: imported });
      notify(`Imported ${imported} item${imported === 1 ? '' : 's'} into the local media bin.`, 'success');
    }
  }

  function assetIcon(asset) { return asset.type === 'video' ? '▣' : asset.type === 'audio' ? '♫' : '▧'; }
  function renderMediaBin() {
    const list = $('#mediaList');
    const query = $('#mediaSearch').value.toLowerCase().trim();
    const visible = state.assets.filter(asset => asset.name.toLowerCase().includes(query));
    list.classList.toggle('list-view', state.isListView);
    $('#assetCount').textContent = `${state.assets.length} asset${state.assets.length === 1 ? '' : 's'}`;
    $('#binStorageLabel').textContent = state.assets.some(asset => asset.storage === 'linked') ? 'LOCAL LINKS' : 'LOCAL WORKSPACE';
    if (!visible.length) {
      list.innerHTML = query ? '<div class="empty-state"><strong>No matching media</strong><p>Try a different search term.</p></div>' : '<div class="empty-state media-empty"><div class="empty-icon">＋</div><strong>Start with your footage</strong><p>Import video, audio, or images. Your media stays on this device.</p><button class="primary-button" id="emptyImportButton">Import media</button><span class="drop-hint">or drag files into this panel</span></div>';
      const emptyButton = $('#emptyImportButton'); if (emptyButton) emptyButton.addEventListener('click', () => $('#mediaFileInput').click());
      return;
    }
    list.innerHTML = visible.map(asset => `<article class="media-card ${asset.id === state.selectedAssetId ? 'selected' : ''}" draggable="true" data-asset-id="${esc(asset.id)}" tabindex="0" title="${esc(asset.name)}">
      <div class="media-thumb"><span class="media-type-icon">${assetIcon(asset)}</span><span class="media-badge">${asset.type.toUpperCase()}</span>${asset.type !== 'image' ? `<span class="media-duration">${formatDuration(asset.duration)}</span>` : ''}</div>
      <div class="media-card-info"><div class="media-card-name">${esc(asset.name)}</div><div class="media-card-meta">${asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}${humanBytes(asset.size)}${asset.storage === 'linked' ? ' · LINK' : ''}</div></div>
      <div class="media-card-actions"><button data-asset-action="add">Add to timeline</button><button data-asset-action="rename" title="Rename label">···</button></div></article>`).join('');
    for (const card of $$('.media-card', list)) {
      card.addEventListener('click', event => {
        if (event.target.closest('[data-asset-action]')) return;
        state.selectedAssetId = card.dataset.assetId; renderMediaBin();
      });
      card.addEventListener('dblclick', () => addAssetToTimeline(card.dataset.assetId));
      card.addEventListener('keydown', event => { if (event.key === 'Enter') addAssetToTimeline(card.dataset.assetId); });
      card.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-axiom-asset', card.dataset.assetId); event.dataTransfer.effectAllowed = 'copy'; });
    }
    $$('[data-asset-action]', list).forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      const card = button.closest('[data-asset-id]');
      const asset = assetById(card.dataset.assetId);
      if (button.dataset.assetAction === 'add') { addAssetToTimeline(asset.id); return; }
      const nextName = prompt('Rename this media label:', asset.name);
      if (!nextName || !nextName.trim() || nextName.trim() === asset.name) return;
      try {
        const saved = await AxiomStorage.updateAssetMetadata(asset.id, { name: nextName.trim() });
        Object.assign(asset, saved);
        renderMediaBin(); markDirty();
        notify('Media label saved locally.', 'success');
      } catch (error) { notify(`Couldn't save media label: ${error.message}`, 'error'); }
    }));
  }

  function clipDefaultProperties(type) {
    return { positionX: 0, positionY: 0, scale: 100, rotation: 0, opacity: 100, volume: 100, brightness: 100, contrast: 100, saturation: 100, hue: 0, fontSize: 84, fontFamily: 'Arial, sans-serif', color: '#ffffff', backgroundColor: '#00000000', text: 'Your title', align: 'center', bold: true, italic: false, effect: 'none', effectAmount: 0, keyframes: {}, sourceIn: 0, reverse: false, ...((type === 'audio') ? { opacity: 100 } : {}) };
  }
  function trackForAsset(asset) {
    if (asset.type === 'audio') return state.project.tracks.find(track => track.kind === 'audio' && !track.locked) || addTrack('audio', false);
    return state.project.tracks.find(track => track.kind === 'video' && !track.locked) || addTrack('video', false);
  }
  function addAssetToTimeline(assetId, forcedStart = null, trackId = null) {
    const asset = assetById(assetId);
    if (!asset) return;
    rememberHistory('Add clip');
    const track = trackId ? trackById(trackId) : trackForAsset(asset);
    if (!track) return;
    let start = forcedStart == null ? state.project.playhead : forcedStart;
    const duration = Math.max(0.1, asset.type === 'image' ? 5 : Number(asset.duration) || 10);
    if (state.project.magnetic && forcedStart == null) {
      const earlier = state.project.clips.filter(clip => clip.trackId === track.id).map(clipEnd);
      start = Math.max(start, ...earlier, 0);
    }
    const clip = { id: uid('clip'), assetId, name: asset.name, type: asset.type, trackId: track.id, start: Math.max(0, start), duration, ...clipDefaultProperties(asset.type) };
    state.project.clips.push(clip);
    state.selectedClipId = clip.id;
    state.selectedAssetId = assetId;
    state.project.playhead = clip.start;
    sortClips(); renderEverything(); markDirty(); refreshPreview(true);
    notify(`Added ${asset.name} to ${track.name}.`, 'success');
  }
  function addTitleClip() {
    rememberHistory('Add title');
    const start = state.project.playhead;
    const duration = 4;
    let track = state.project.tracks.find(item => item.kind === 'video' && !item.locked && !state.project.clips.some(clip => clip.trackId === item.id && clip.start < start + duration && clipEnd(clip) > start));
    if (!track) track = addTrack('video', false);
    const clip = { id: uid('clip'), name: 'Title', type: 'text', trackId: track.id, start, duration, ...clipDefaultProperties('text'), text: 'Your title', fontSize: 84 };
    state.project.clips.push(clip); state.selectedClipId = clip.id;
    sortClips(); renderEverything(); markDirty(); refreshPreview(true); notify('Title clip added at the playhead. Edit its text in the Inspector.');
  }
  function addAdjustmentClip() {
    rememberHistory('Add adjustment layer');
    const start = state.project.playhead;
    const duration = 5;
    const affectedTrackIndexes = state.project.clips
      .filter(clip => ['video', 'image'].includes(clip.type) && clip.start < start + duration && clipEnd(clip) > start)
      .map(clip => state.project.tracks.findIndex(track => track.id === clip.trackId)).filter(index => index >= 0);
    const topAffectedIndex = affectedTrackIndexes.length ? Math.min(...affectedTrackIndexes) : null;
    const isFree = track => !state.project.clips.some(clip => clip.trackId === track.id && clip.start < start + duration && clipEnd(clip) > start);
    let track = state.project.tracks.find((item, index) => item.kind === 'video' && !item.locked && isFree(item) && (topAffectedIndex === null || index < topAffectedIndex));
    if (!track) track = addTrack('video', false);
    const clip = { id: uid('clip'), name: 'Adjustment layer', type: 'adjustment', trackId: track.id, start, duration, ...clipDefaultProperties('adjustment') };
    state.project.clips.push(clip); state.selectedClipId = clip.id; sortClips(); renderEverything(); markDirty(); notify('Adjustment layer added above the active video tracks. Its grade and effects apply to clips below it.');
  }
  function sortClips() { state.project.clips.sort((a, b) => a.start - b.start || state.project.tracks.findIndex(track => track.id === a.trackId) - state.project.tracks.findIndex(track => track.id === b.trackId)); }
  function addTrack(kind, redraw = true) {
    if (redraw) rememberHistory('Add track');
    const sameKind = state.project.tracks.filter(track => track.kind === kind);
    const labelPrefix = kind === 'video' ? 'V' : 'A';
    const nextNumber = sameKind.reduce((max, track) => Math.max(max, Number(track.name.slice(1)) || 0), 0) + 1;
    const track = { id: uid('track'), name: `${labelPrefix}${nextNumber}`, kind, muted: false, locked: false };
    if (kind === 'video') state.project.tracks.unshift(track);
    else state.project.tracks.push(track);
    state.selectedTrackId = track.id;
    if (redraw) { renderTimeline(); markDirty(); }
    return track;
  }
  function deleteSelectedClip() {
    const clip = clipById();
    if (!clip) return;
    rememberHistory('Delete clip');
    state.project.clips = state.project.clips.filter(item => item.id !== clip.id);
    state.selectedClipId = null; renderEverything(); markDirty(); refreshPreview(true); notify('Clip removed from the timeline.');
  }
  function duplicateSelectedClip() {
    const clip = clipById(); if (!clip) return;
    rememberHistory('Duplicate clip');
    const duplicate = { ...JSON.parse(JSON.stringify(clip)), id: uid('clip'), name: `${clip.name} copy`, start: clipEnd(clip) };
    state.project.clips.push(duplicate); state.selectedClipId = duplicate.id; sortClips(); renderEverything(); markDirty();
  }
  function splitAtPlayhead() {
    const candidates = state.project.clips.filter(clip => state.project.playhead > clip.start + 1 / state.project.fps / 2 && state.project.playhead < clipEnd(clip) - 1 / state.project.fps / 2 && (!state.selectedClipId || clip.id === state.selectedClipId));
    if (!candidates.length) { notify('Move the playhead inside a clip to split it.'); return; }
    rememberHistory('Split clip');
    const clip = candidates[0], split = state.project.playhead - clip.start;
    const next = { ...JSON.parse(JSON.stringify(clip)), id: uid('clip'), start: state.project.playhead, duration: clip.duration - split, sourceIn: (clip.sourceIn || 0) + split, name: clip.name };
    clip.duration = split;
    state.project.clips.push(next); state.selectedClipId = next.id; sortClips(); renderEverything(); markDirty(); refreshPreview(true); notify('Clip split at the playhead.');
  }
  function addMarker() {
    rememberHistory('Add marker');
    state.project.markers.push({ id: uid('marker'), time: state.project.playhead, label: `Marker ${state.project.markers.length + 1}`, color: '#d8ff6a' });
    renderTimeline(); markDirty(); notify(`Marker added at ${timecode(state.project.playhead)}.`);
  }

  function renderTimeline() {
    const duration = timelineExtent();
    const pps = state.zoom;
    const width = Math.max(900, duration * pps + 160);
    $('#zoomLabel').textContent = `${pps} px/s`;
    $('#timelineZoom').value = pps;
    $('#rulerContent').style.width = `${width}px`;
    $('#rulerContent').style.setProperty('--pps', `${pps}px`);
    $('#rulerContent').innerHTML = '';
    const step = pps >= 100 ? 1 : pps >= 55 ? 2 : pps >= 28 ? 5 : 10;
    for (let time = 0; time <= duration + step; time += step) {
      const tick = document.createElement('span'); tick.className = 'ruler-tick'; tick.style.left = `${time * pps}px`; tick.textContent = formatDuration(time); $('#rulerContent').append(tick);
    }
    const lanes = $('#timelineLanes'); lanes.innerHTML = ''; lanes.style.width = `${width + 82}px`;
    for (const track of state.project.tracks) {
      const lane = document.createElement('div'); lane.className = 'track-lane'; lane.dataset.trackId = track.id; lane.style.width = `${width + 82}px`;
      lane.innerHTML = `<div class="track-label"><strong>${esc(track.name)}</strong><span>${track.kind === 'video' ? 'VID' : 'AUD'}</span><div class="track-label-actions"><button data-track-action="mute" class="${track.muted ? 'active' : ''}" title="${track.kind === 'audio' ? 'Mute' : 'Hide'} track">${track.kind === 'audio' ? 'M' : '◉'}</button><button data-track-action="lock" class="${track.locked ? 'active' : ''}" title="Lock track">${track.locked ? '▣' : '▢'}</button></div></div><div class="track-content" style="width:${width}px"></div>`;
      const content = $('.track-content', lane);
      state.project.clips.filter(clip => clip.trackId === track.id).forEach(clip => {
        const item = document.createElement('div');
        item.className = `timeline-clip ${clip.type} ${clip.id === state.selectedClipId ? 'selected' : ''}`;
        item.dataset.clipId = clip.id;
        item.style.left = `${clip.start * pps}px`;
        item.style.width = `${Math.max(7, clip.duration * pps)}px`;
        item.title = `${clip.name} · ${formatDuration(clip.duration)}`;
        let waveform = '';
        if (clip.type === 'audio') waveform = '<canvas class="clip-waveform" width="500" height="40"></canvas>';
        item.innerHTML = `<div class="clip-filmstrip"></div>${waveform}<span class="clip-label">${esc(clip.name)}</span><span class="clip-handle left" data-edge="left"></span><span class="clip-handle right" data-edge="right"></span>`;
        item.addEventListener('pointerdown', event => beginClipDrag(event, clip, track, item));
        item.addEventListener('click', event => { event.stopPropagation(); if (!state.drag?.moved) selectClip(clip.id); });
        item.addEventListener('contextmenu', event => { event.preventDefault(); selectClip(clip.id); openClipContextMenu(event.clientX, event.clientY, clip); });
        content.append(item);
      });
      lane.addEventListener('click', event => {
        if (event.target.closest('.track-label-actions') || event.target.closest('.timeline-clip')) return;
        const bounds = content.getBoundingClientRect();
        setPlayhead(Math.max(0, (event.clientX - bounds.left) / pps));
      });
      $$('.track-label-actions button', lane).forEach(button => button.addEventListener('click', event => {
        event.stopPropagation(); const action = button.dataset.trackAction; rememberHistory(action === 'mute' ? 'Toggle track mute' : 'Toggle track lock');
        if (action === 'mute') track.muted = !track.muted;
        else track.locked = !track.locked;
        renderTimeline(); markDirty();
      }));
      lane.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-axiom-asset')) { event.preventDefault(); lane.classList.add('drop-target'); } });
      lane.addEventListener('dragleave', () => lane.classList.remove('drop-target'));
      lane.addEventListener('drop', event => {
        lane.classList.remove('drop-target');
        const assetId = event.dataTransfer.getData('application/x-axiom-asset');
        if (!assetId) return; event.preventDefault();
        const bounds = content.getBoundingClientRect(); addAssetToTimeline(assetId, Math.max(0, (event.clientX - bounds.left) / pps), track.id);
      });
      lanes.append(lane);
    }
    $('#playheadLine').style.left = `${82 + state.project.playhead * pps}px`;
    $('#playheadLine').style.height = `${28 + state.project.tracks.length * 53}px`;
    $('#playheadLine').style.top = '0';
    $('#playheadTime').textContent = timecode(state.project.playhead);
    $('#durationTime').textContent = timecode(sequenceDuration());
    $('#sequenceLabel').textContent = state.project.sequenceName.toUpperCase();
    $('#timelineFooterRight').textContent = `${state.project.tracks.length} TRACKS · ${state.project.clips.length} CLIPS`;
    $('#selectedClipLabel').textContent = clipById() ? clipById().name : 'No clip selected';
    $('#timelineStatus').textContent = state.settings.magnetic ? 'Magnetic timeline' : 'Free placement';
    state.project.markers.forEach(marker => {
      const tag = document.createElement('button'); tag.className = 'timeline-marker'; tag.title = marker.label; tag.style.left = `${marker.time * pps}px`; tag.textContent = '◆'; tag.addEventListener('click', event => { event.stopPropagation(); setPlayhead(marker.time); }); $('#rulerContent').append(tag);
    });
    $$('.clip-waveform', lanes).forEach(canvas => {
      const context = canvas.getContext('2d'); if (!context) return;
      context.strokeStyle = '#8cdae8'; context.lineWidth = 1;
      context.beginPath(); context.moveTo(0, canvas.height / 2); context.lineTo(canvas.width, canvas.height / 2); context.stroke();
    });
  }

  function beginClipDrag(event, clip, track, element) {
    if (event.button !== 0 || track.locked || event.target.closest('.track-label-actions')) return;
    event.preventDefault(); event.stopPropagation(); selectClip(clip.id, false);
    const edge = event.target.dataset.edge || null;
    state.drag = { clipId: clip.id, trackId: track.id, startX: event.clientX, startY: event.clientY, originalStart: clip.start, originalDuration: clip.duration, originalSourceIn: clip.sourceIn || 0, originalTrackId: clip.trackId, edge, moved: false, element, mode: edge ? (state.activeTool === 'roll' ? 'roll' : 'trim') : state.activeTool, snapshot: JSON.stringify(state.project), originalClips: state.project.clips.map(item => ({ id: item.id, start: item.start, duration: item.duration, sourceIn: item.sourceIn || 0, trackId: item.trackId })) };
    if (!edge && state.activeTool === 'cut') { setPlayhead(clip.start + (event.clientX - element.getBoundingClientRect().left) / state.zoom); splitAtPlayhead(); state.drag = null; return; }
    element.setPointerCapture?.(event.pointerId);
    document.addEventListener('pointermove', onClipDragMove);
    document.addEventListener('pointerup', onClipDragEnd, { once: true });
  }
  function onClipDragMove(event) {
    const drag = state.drag; if (!drag) return;
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (!drag.moved) return;
    const clip = clipById(drag.clipId); if (!clip) return;
    const delta = dx / state.zoom;
    if (drag.mode === 'trim' || drag.mode === 'roll') {
      if (drag.edge === 'left') {
        const nextStart = Math.max(0, drag.originalStart + delta);
        const shift = nextStart - drag.originalStart;
        clip.start = nextStart; clip.duration = Math.max(1 / state.project.fps, drag.originalDuration - shift); clip.sourceIn = Math.max(0, drag.originalSourceIn + shift);
        if (drag.mode === 'roll') {
          const previous = drag.originalClips.filter(item => item.id !== clip.id && item.trackId === drag.originalTrackId && Math.abs(item.start + item.duration - drag.originalStart) < 0.06).sort((a, b) => b.start - a.start)[0];
          const previousClip = previous && state.project.clips.find(item => item.id === previous.id);
          if (previousClip) previousClip.duration = Math.max(1 / state.project.fps, previous.duration + shift);
        }
      } else {
        clip.duration = Math.max(1 / state.project.fps, drag.originalDuration + delta);
        if (drag.mode === 'roll') {
          const originalEnd = drag.originalStart + drag.originalDuration;
          const next = drag.originalClips.filter(item => item.id !== clip.id && item.trackId === drag.originalTrackId && Math.abs(item.start - originalEnd) < 0.06).sort((a, b) => a.start - b.start)[0];
          const nextClip = next && state.project.clips.find(item => item.id === next.id);
          if (nextClip) { nextClip.start = Math.max(0, next.start + delta); nextClip.duration = Math.max(1 / state.project.fps, next.duration - delta); }
        }
      }
    } else if (drag.mode === 'slip') {
      const asset = assetById(clip.assetId); clip.sourceIn = clamp(drag.originalSourceIn + delta, 0, Math.max(0, (asset?.duration || clip.duration) - clip.duration));
    } else {
      clip.start = Math.max(0, drag.originalStart + delta);
      if (drag.mode === 'slide') {
        for (const original of drag.originalClips) {
          if (original.id === clip.id || original.trackId !== drag.originalTrackId) continue;
          const peer = state.project.clips.find(item => item.id === original.id); if (!peer) continue;
          if (Math.abs(original.start + original.duration - drag.originalStart) < 0.06) peer.duration = Math.max(1 / state.project.fps, original.duration + delta);
          else if (Math.abs(original.start - (drag.originalStart + drag.originalDuration)) < 0.06) { peer.start = Math.max(0, original.start + delta); peer.duration = Math.max(1 / state.project.fps, original.duration - delta); }
        }
      }
      if (drag.mode === 'ripple') {
        for (const original of drag.originalClips) {
          if (original.id === clip.id || original.trackId !== drag.originalTrackId || original.start < drag.originalStart + drag.originalDuration - 0.001) continue;
          const peer = state.project.clips.find(item => item.id === original.id);
          if (peer) peer.start = Math.max(0, original.start + delta);
        }
      }
      const bounds = $('#timelineScroll').getBoundingClientRect();
      const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest('.track-lane');
      if (hovered) {
        const targetTrack = trackById(hovered.dataset.trackId);
        if (targetTrack && targetTrack.kind === (clip.type === 'audio' ? 'audio' : 'video') && !targetTrack.locked) clip.trackId = targetTrack.id;
      }
      if (state.settings.magnetic && drag.mode !== 'slide') {
        const peers = state.project.clips.filter(other => other.id !== clip.id && other.trackId === clip.trackId);
        let best = clip.start; let distance = 0.12;
        for (const peer of peers) {
          for (const point of [peer.start, clipEnd(peer)]) {
            const endDist = Math.abs(clip.start - point); const startDist = Math.abs(clipEnd(clip) - point);
            if (endDist < distance) { distance = endDist; best = point; }
            if (startDist < distance) { distance = startDist; best = point - clip.duration; }
          }
        }
        clip.start = Math.max(0, best);
      }
    }
    drag.element.style.left = `${clip.start * state.zoom}px`;
    drag.element.style.width = `${Math.max(7, clip.duration * state.zoom)}px`;
    $('.clip-label', drag.element).textContent = clip.name;
    $('#timelineStatus').textContent = `${timecode(clip.start)} · ${formatDuration(clip.duration)}`;
    $('#playheadLine').style.left = `${82 + state.project.playhead * state.zoom}px`;
  }
  function onClipDragEnd() {
    document.removeEventListener('pointermove', onClipDragMove);
    const drag = state.drag; state.drag = null;
    if (!drag) return;
    if (drag.moved) {
      state.undo.push({ label: 'Move or trim clip', snapshot: drag.snapshot });
      if (state.undo.length > 80) state.undo.shift();
      state.redo.length = 0; updateUndoButtons();
      const clip = clipById(drag.clipId);
      if (clip && state.settings.magnetic && drag.mode === 'trim') {
        const peers = state.project.clips.filter(other => other.id !== clip.id && other.trackId === clip.trackId);
        for (const peer of peers) if (Math.abs(clipEnd(clip) - peer.start) < 0.04) clip.duration = Math.max(1 / state.project.fps, peer.start - clip.start);
      }
      sortClips(); renderTimeline(); renderInspector(); markDirty(); refreshPreview(true);
    }
  }

  function openClipContextMenu(x, y, clip) {
    const popup = $('#dropdownMenu');
    const entries = [['Split at playhead', 'split'], ['Duplicate clip', 'duplicate'], ['Delete clip', 'delete'], ['Add title above', 'addTitle']];
    popup.innerHTML = entries.map(entry => `<button type="button" data-action="${entry[1]}">${esc(entry[0])}</button>`).join('');
    popup.style.left = `${clamp(x, 8, window.innerWidth - 230)}px`;
    popup.style.top = `${clamp(y, 8, window.innerHeight - 180)}px`;
    popup.hidden = false; popup.dataset.menu = 'context'; state.contextTarget = clip.id;
  }

  function selectClip(id, redraw = true) {
    state.selectedClipId = id;
    const clip = clipById(id);
    if (clip) { state.selectedTrackId = clip.trackId; state.project.playhead = clamp(state.project.playhead, clip.start, clipEnd(clip)); }
    $('#selectedClipLabel').textContent = clip ? clip.name : 'No clip selected';
    if (redraw) { renderTimeline(); renderInspector(); refreshPreview(true); }
  }

  function animatedValue(clip, property, baseValue, timelineTime) {
    const points = (clip.keyframes && clip.keyframes[property] || []).slice().sort((a, b) => a.time - b.time);
    if (!points.length) return baseValue;
    const localTime = clamp(timelineTime - clip.start, 0, clip.duration);
    if (localTime <= points[0].time) return points[0].value;
    if (localTime >= points[points.length - 1].time) return points[points.length - 1].value;
    for (let index = 0; index < points.length - 1; index++) {
      const left = points[index], right = points[index + 1];
      if (localTime < left.time || localTime > right.time) continue;
      const span = Math.max(0.000001, right.time - left.time);
      let amount = (localTime - left.time) / span;
      if ((left.interpolation || 'smooth') === 'smooth') amount = amount * amount * (3 - 2 * amount);
      return Number(left.value) + (Number(right.value) - Number(left.value)) * amount;
    }
    return baseValue;
  }

  function findVisualAt(time) {
    const rankedTracks = state.project.tracks.filter(track => track.kind === 'video' && !track.muted);
    for (const track of rankedTracks) {
      const clip = state.project.clips.find(item => item.trackId === track.id && (item.type === 'video' || item.type === 'image') && item.start <= time && clipEnd(item) > time);
      if (clip) return clip;
    }
    return null;
  }
  function findAudioAt(time) { return state.project.clips.filter(clip => clip.type === 'audio' && clip.start <= time && clipEnd(clip) > time && !trackById(clip.trackId)?.muted); }
  function clearPreview() {
    $('#previewVideo').pause(); $('#previewVideo').removeAttribute('src'); $('#previewVideo').load();
    $('#previewImage').removeAttribute('src'); $('#previewImage').hidden = true;
    $('#titleOverlay').hidden = true; $('#viewerEmpty').hidden = false;
  }
  async function getObjectUrl(assetId, askPermission = false) {
    if (state.assetUrls.has(assetId)) return state.assetUrls.get(assetId);
    const file = await AxiomStorage.getAssetFile(assetId, askPermission);
    const url = URL.createObjectURL(file); state.assetUrls.set(assetId, url); return url;
  }
  async function refreshPreview(seek = false) {
    const time = state.project.playhead;
    const visual = findVisualAt(time);
    const video = $('#previewVideo'), image = $('#previewImage'), overlay = $('#titleOverlay');
    if (!visual || visual.type === 'adjustment') {
      video.pause(); video.hidden = true; video.removeAttribute('src'); video.load();
      image.hidden = true; image.removeAttribute('src');
      $('#viewerEmpty').hidden = Boolean(visual);
    } else {
      $('#viewerEmpty').hidden = true;
      try {
        const url = await getObjectUrl(visual.assetId);
        if (visual.type === 'image') {
          video.hidden = true; video.pause(); video.removeAttribute('src');
          image.hidden = false;
          if (image.src !== url) image.src = url;
        } else {
          image.hidden = true; image.removeAttribute('src'); video.hidden = false;
          const sourceChanged = video.src !== url;
          if (sourceChanged) { video.src = url; video.load(); }
          const relative = (visual.sourceIn || 0) + (time - visual.start);
          if (seek || sourceChanged || Math.abs(video.currentTime - relative) > 0.35) {
            try { if (video.readyState >= 1) video.currentTime = clamp(relative, 0, Math.max(0, (assetById(visual.assetId)?.duration || video.duration || relative) - 0.02)); } catch (_) { /* Metadata may not be ready yet. */ }
          }
          if (!state.playing) video.pause();
          else if (video.paused) video.play().catch(() => {});
        }
      } catch (error) {
        $('#viewerEmpty').hidden = false;
        $('#viewerEmpty strong').textContent = 'Media needs relinking';
        $('#viewerEmpty p').textContent = error.message;
      }
    }
    const titleClips = state.project.clips.filter(clip => clip.type === 'text' && clip.start <= time && clipEnd(clip) > time);
    const title = titleClips[titleClips.length - 1];
    if (title) {
      if (!visual) $('#viewerEmpty').hidden = true;
      overlay.hidden = false; overlay.textContent = title.text || ' '; overlay.style.color = title.color || '#ffffff';
      overlay.style.fontFamily = title.fontFamily || 'Arial, sans-serif';
      overlay.style.fontWeight = title.bold ? '700' : '400'; overlay.style.fontStyle = title.italic ? 'italic' : 'normal';
      overlay.style.textAlign = title.align || 'center';
      overlay.style.justifyContent = title.align === 'left' ? 'flex-start' : title.align === 'right' ? 'flex-end' : 'center';
      const titleX = animatedValue(title, 'positionX', title.positionX || 0, time);
      const titleY = animatedValue(title, 'positionY', title.positionY || 0, time);
      const titleRotation = animatedValue(title, 'rotation', title.rotation || 0, time);
      const titleScale = animatedValue(title, 'scale', title.scale ?? 100, time);
      overlay.style.transform = `translate(${titleX}%, ${titleY}%) rotate(${titleRotation}deg) scale(${titleScale / 100})`;
      overlay.style.opacity = animatedValue(title, 'opacity', title.opacity ?? 100, time) / 100;
      const stageWidth = $('#previewStage').clientWidth || 600;
      overlay.style.fontSize = `${clamp((title.fontSize || 84) / state.project.width * stageWidth, 10, 150)}px`;
      overlay.style.textShadow = title.effect === 'shadow' ? '0 3px 9px #000' : '0 2px 8px #000a';
      overlay.style.background = title.backgroundColor && title.backgroundColor !== '#00000000' ? title.backgroundColor : 'transparent';
    } else { overlay.hidden = true; if (!visual) { $('#viewerEmpty').hidden = false; const heading = $('#viewerEmpty strong'); const detail = $('#viewerEmpty p'); if (heading) heading.textContent = 'Nothing on the timeline yet'; if (detail) detail.textContent = 'Drag a media item to the timeline or add a title.'; } }
    applyGradeToViewer(findVisualAt(time));
    $('#viewerFrameLabel').textContent = `FRAME ${String(Math.floor(time * state.project.fps)).padStart(6, '0')}`;
    $('#viewerResolution').textContent = `${state.project.width} × ${state.project.height}`;
    $('#playheadTime').textContent = timecode(time);
    $('#durationTime').textContent = timecode(sequenceDuration());
    renderScopes();
  }
  function filterForClip(clip, time) {
    const amount = clamp((clip.effectAmount || 0) / 100, 0, 1);
    let effectFilter = '';
    if (clip.effect === 'mono') effectFilter = ' grayscale(1)';
    else if (clip.effect === 'warm') effectFilter = ` sepia(${amount * 0.65})`;
    else if (clip.effect === 'cinema') effectFilter = ` contrast(${1 + amount * 0.25}) saturate(${1 + amount * 0.15})`;
    else if (clip.effect === 'blur') effectFilter = ` blur(${amount * 5}px)`;
    return `brightness(${animatedValue(clip, 'brightness', clip.brightness ?? 100, time) / 100}) contrast(${animatedValue(clip, 'contrast', clip.contrast ?? 100, time) / 100}) saturate(${animatedValue(clip, 'saturation', clip.saturation ?? 100, time) / 100}) hue-rotate(${animatedValue(clip, 'hue', clip.hue || 0, time)}deg)${effectFilter}`;
  }
  function adjustmentLayersForClip(clip, time) {
    const targetIndex = state.project.tracks.findIndex(track => track.id === clip.trackId);
    if (targetIndex < 0) return [];
    return state.project.clips.filter(layer => {
      if (layer.type !== 'adjustment' || layer.start > time || clipEnd(layer) <= time) return false;
      const layerTrack = trackById(layer.trackId);
      const layerIndex = state.project.tracks.findIndex(track => track.id === layer.trackId);
      return layerTrack && !layerTrack.muted && layerIndex >= 0 && layerIndex < targetIndex;
    }).sort((a, b) => state.project.tracks.findIndex(track => track.id === a.trackId) - state.project.tracks.findIndex(track => track.id === b.trackId));
  }
  function applyGradeToViewer(clip) {
    const video = $('#previewVideo'), image = $('#previewImage');
    const target = !video.hidden && video.getAttribute('src') ? video : !image.hidden ? image : null;
    if (!target) return;
    const c = clip || {};
    const time = state.project.playhead;
    const layers = [c, ...adjustmentLayersForClip(c, time)];
    target.style.filter = layers.map(layer => filterForClip(layer, time)).join(' ');
    const x = animatedValue(c, 'positionX', c.positionX || 0, time);
    const y = animatedValue(c, 'positionY', c.positionY || 0, time);
    const scale = animatedValue(c, 'scale', c.scale ?? 100, time);
    const rotation = animatedValue(c, 'rotation', c.rotation || 0, time);
    target.style.opacity = animatedValue(c, 'opacity', c.opacity ?? 100, time) / 100;
    target.style.transform = `translate(${x}%, ${y}%) rotate(${rotation}deg) scale(${scale / 100})`;
  }
  function setPlayhead(time) {
    state.project.playhead = clamp(time, 0, timelineExtent());
    $('#playheadLine').style.left = `${82 + state.project.playhead * state.zoom}px`;
    $('#playheadTime').textContent = timecode(state.project.playhead);
    refreshPreview(true);
  }
  function startPlayback() {
    if (state.playing) return;
    state.playing = true; state.playOrigin = state.project.playhead; state.playStartedAt = performance.now();
    $('#playButton').textContent = 'Ⅱ'; $('#playButton').title = 'Pause';
    const video = $('#previewVideo'); if (video.src && !video.hidden) video.play().catch(() => {});
    syncPreviewAudio(state.project.playhead);
    tickPlayback();
  }
  function stopPlayback() {
    state.playing = false; $('#playButton').textContent = '▶'; $('#playButton').title = 'Play / Pause (Space)';
    $('#previewVideo').pause(); stopAudioPlayers();
  }
  function tickPlayback() {
    if (!state.playing) return;
    const time = state.playOrigin + (performance.now() - state.playStartedAt) / 1000;
    if (time >= sequenceDuration()) { setPlayhead(sequenceDuration()); stopPlayback(); return; }
    state.project.playhead = time;
    $('#playheadLine').style.left = `${82 + time * state.zoom}px`;
    $('#playheadTime').textContent = timecode(time);
    if (Math.floor(time * state.project.fps) !== Math.floor((time - 0.025) * state.project.fps)) refreshPreview(false);
    syncPreviewAudio(time);
    requestAnimationFrame(tickPlayback);
  }
  async function syncPreviewAudio(time) {
    if (!state.playing) return;
    const active = findAudioAt(time).filter(clip => !clip.muted);
    const wanted = new Set(active.map(clip => clip.id));
    for (const [id, player] of state.audioPreviewPlayers) {
      if (!wanted.has(id)) { player.audio.pause(); player.audio.remove(); state.audioPreviewPlayers.delete(id); }
    }
    for (const clip of active) {
      let player = state.audioPreviewPlayers.get(clip.id);
      if (!player) {
        const audio = document.createElement('audio'); audio.dataset.axiomPreview = 'true'; audio.preload = 'auto'; audio.volume = clamp((clip.volume ?? 100) / 100, 0, 1);
        player = { audio, loading: true, ready: null }; state.audioPreviewPlayers.set(clip.id, player);
        player.ready = (async () => { audio.src = await getObjectUrl(clip.assetId, true); await waitMedia(audio, 'loadedmetadata', 8000).catch(() => {}); player.loading = false; })();
      }
      if (player.loading) continue;
      const expected = Math.max(0, (clip.sourceIn || 0) + time - clip.start);
      if (Math.abs(player.audio.currentTime - expected) > 0.6) {
        try { player.audio.currentTime = expected; } catch (_) { /* Metadata may still be settling. */ }
      }
      player.audio.volume = clamp((clip.volume ?? 100) / 100, 0, 1);
      if (player.audio.paused) player.audio.play().catch(() => {});
    }
  }
  function stopAudioPlayers() {
    for (const player of state.audioPreviewPlayers.values()) { player.audio.pause(); player.audio.remove(); }
    state.audioPreviewPlayers.clear();
    document.querySelectorAll('audio[data-axiom-preview]').forEach(audio => { audio.pause(); audio.remove(); });
  }

  function field(label, key, value, options = {}) {
    const type = options.type || 'number';
    if (type === 'select') return `<label class="form-field"><span>${esc(label)}</span><select data-prop="${esc(key)}">${options.options.map(option => `<option value="${esc(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label>`;
    if (type === 'textarea') return `<label class="form-field"><span>${esc(label)}</span><textarea data-prop="${esc(key)}" rows="3">${esc(value)}</textarea></label>`;
    if (type === 'checkbox') return `<label class="check-field"><input type="checkbox" data-prop="${esc(key)}" ${value ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    if (type === 'color') return `<label class="form-field"><span>${esc(label)}</span><input type="color" data-prop="${esc(key)}" value="${esc(value || '#ffffff')}"></label>`;
    if (type === 'range') return `<label class="range-field"><span>${esc(label)} <b data-range-value="${esc(key)}">${esc(value)}</b></span><input type="range" data-prop="${esc(key)}" min="${options.min ?? 0}" max="${options.max ?? 200}" step="${options.step ?? 1}" value="${esc(value)}"></label>`;
    return `<label class="form-field"><span>${esc(label)}</span><input type="${type}" data-prop="${esc(key)}" value="${esc(value)}" ${options.min != null ? `min="${options.min}"` : ''} ${options.max != null ? `max="${options.max}"` : ''} ${options.step != null ? `step="${options.step}"` : ''}></label>`;
  }
  function inspectorSection(title, body, hint = '') { return `<section class="inspector-section"><div class="section-head"><strong>${esc(title)}</strong>${hint ? `<span>${esc(hint)}</span>` : ''}</div>${body}</section>`; }
  function renderInspector() {
    const container = $('#inspectorContent');
    $$('.inspector-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.inspectorTab === state.activeInspectorTab));
    const clip = clipById();
    const asset = clip?.assetId ? assetById(clip.assetId) : null;
    if (state.activeInspectorTab === 'scopes') { container.innerHTML = `<div class="inspector-section"><div class="section-head"><strong>Signal analysis</strong><span>LIVE</span></div><canvas class="scope-canvas" id="waveformScope" width="500" height="150"></canvas><p class="muted-copy">Preview-derived luma trace. For accurate broadcast measurement, use a calibrated reference monitor and a dedicated scopes implementation.</p></div><div class="scope-grid"><canvas class="scope-canvas" id="histogramScope" width="500" height="120"></canvas><canvas class="scope-canvas" id="rgbScope" width="500" height="120"></canvas></div>`; renderScopes(); return; }
    if (!clip) {
      container.innerHTML = `<div class="empty-inspector"><div class="property-glyph">◇</div><strong>Select a clip</strong><p>Clip transforms, timing, effects, color and audio controls will appear here.</p></div>${inspectorSection('Sequence', `${field('Sequence', 'sequenceName', state.project.sequenceName, { type: 'text' })}${field('Frame rate', 'fps', state.project.fps, { min: 1, max: 120, step: 1 })}${field('Canvas width', 'width', state.project.width, { min: 320, max: 7680, step: 1 })}${field('Canvas height', 'height', state.project.height, { min: 240, max: 4320, step: 1 })}`)}`;
      bindProjectFields(container); return;
    }
    const tab = state.activeInspectorTab;
    if (tab === 'properties') {
      let body = `${field('Clip name', 'name', clip.name, { type: 'text' })}${field('Start (seconds)', 'start', clip.start, { min: 0, max: 99999, step: 0.01 })}${field('Duration (seconds)', 'duration', clip.duration, { min: 0.033, max: 99999, step: 0.01 })}${field('Track', 'trackId', clip.trackId, { type: 'select', options: state.project.tracks.filter(track => track.kind === (clip.type === 'audio' ? 'audio' : 'video')).map(track => ({ value: track.id, label: track.name })) })}`;
      if (clip.type === 'text') body += `${field('Title text', 'text', clip.text, { type: 'textarea' })}${field('Font size', 'fontSize', clip.fontSize, { min: 8, max: 300, step: 1 })}${field('Font family', 'fontFamily', clip.fontFamily, { type: 'select', options: [{ value: 'Arial, sans-serif', label: 'Arial' }, { value: 'Georgia, serif', label: 'Georgia' }, { value: 'Impact, sans-serif', label: 'Impact' }, { value: 'monospace', label: 'Monospace' }] })}${field('Text color', 'color', clip.color, { type: 'color' })}${field('Alignment', 'align', clip.align || 'center', { type: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }] })}${field('Bold', 'bold', clip.bold, { type: 'checkbox' })}${field('Italic', 'italic', clip.italic, { type: 'checkbox' })}`;
      body += `${field('Position X', 'positionX', clip.positionX, { min: -100, max: 100, step: 1 })}${field('Position Y', 'positionY', clip.positionY, { min: -100, max: 100, step: 1 })}${field('Scale', 'scale', clip.scale, { type: 'range', min: 10, max: 300 })}${field('Rotation', 'rotation', clip.rotation, { min: -360, max: 360, step: 1 })}${field('Opacity', 'opacity', clip.opacity, { type: 'range', min: 0, max: 100 })}`;
      container.innerHTML = inspectorSection('Clip properties', body, clip.type.toUpperCase()) + inspectorSection('Animation', `<p class="muted-copy">Set the playhead, then press <b>Add keyframe</b> to keyframe position, scale, rotation, opacity and audio gain. Values use smooth interpolation between stored points.</p><div class="inspector-actions"><button class="secondary-button" id="addKeyframeButton">◆ Add keyframe</button><button class="secondary-button" id="clearKeyframesButton">Clear keyframes</button></div><div class="keyframe-list">${Object.entries(clip.keyframes || {}).map(([prop, points]) => (points || []).map(point => `<div class="keyframe-row"><span>${esc(prop)} · ${timecode(point.time)}</span><span>${esc(point.value)}</span></div>`).join('')).join('') || '<p class="muted-copy">No keyframes on this clip.</p>'}</div>`);
      bindClipFields(container, clip);
      $('#addKeyframeButton')?.addEventListener('click', () => addKeyframe(clip));
      $('#clearKeyframesButton')?.addEventListener('click', () => { rememberHistory('Clear keyframes'); clip.keyframes = {}; renderInspector(); markDirty(); });
    } else if (tab === 'effects') {
      container.innerHTML = inspectorSection('Effect library', `<div class="effect-tile-grid"><button class="effect-tile" data-effect="none">Reset look<small>Remove preview effect</small></button><button class="effect-tile" data-effect="cinema">Cinema contrast<small>Contrast + saturation</small></button><button class="effect-tile" data-effect="mono">Monochrome<small>Black and white</small></button><button class="effect-tile" data-effect="warm">Warm film<small>Color temperature look</small></button><button class="effect-tile" data-effect="blur">Soft focus<small>Preview Gaussian blur</small></button><button class="effect-tile" data-effect="shadow">Title shadow<small>Text only</small></button></div>`) + inspectorSection('Effect controls', `${field('Effect amount', 'effectAmount', clip.effectAmount || 0, { type: 'range', min: 0, max: 100 })}${field('Effect', 'effect', clip.effect || 'none', { type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'cinema', label: 'Cinema contrast' }, { value: 'mono', label: 'Monochrome' }, { value: 'warm', label: 'Warm film' }, { value: 'blur', label: 'Soft focus' }, { value: 'shadow', label: 'Text shadow' }] })}`);
      bindClipFields(container, clip);
      $$('[data-effect]', container).forEach(button => button.addEventListener('click', () => { rememberHistory('Apply effect'); clip.effect = button.dataset.effect; clip.effectAmount = 65; renderInspector(); refreshPreview(true); markDirty(); }));
    } else if (tab === 'color') {
      container.innerHTML = inspectorSection('Primary correction', `<p class="muted-copy">Realtime preview controls. This browser build applies a CSS preview grade; it is not a 32-bit ACES mastering pipeline.</p>${field('Brightness', 'brightness', clip.brightness ?? 100, { type: 'range', min: 0, max: 200 })}${field('Contrast', 'contrast', clip.contrast ?? 100, { type: 'range', min: 0, max: 200 })}${field('Saturation', 'saturation', clip.saturation ?? 100, { type: 'range', min: 0, max: 200 })}${field('Hue rotate', 'hue', clip.hue || 0, { type: 'range', min: -180, max: 180 })}`) + inspectorSection('Grade nodes', `<div class="node-chain">${(state.project.colorNodes || []).map((node, index) => `${index ? '<span class="node-arrow">→</span>' : ''}<button class="color-node" data-node-id="${esc(node.id)}">${esc(node.type)}</button>`).join('')}</div><div class="inspector-actions"><button class="secondary-button" id="addGradeNodeButton">＋ Serial node</button><button class="secondary-button" id="resetGradeButton">Reset values</button></div><p class="muted-copy">Node labels and routing are saved with the project. Advanced parallel blending, ACES transforms and GPU scopes are not provided by this lightweight grade panel.</p>`);
      bindClipFields(container, clip);
      $$('[data-node-id]', container).forEach(button => button.addEventListener('click', () => { const node = state.project.colorNodes.find(item => item.id === button.dataset.nodeId); if (!node) return; const name = prompt('Rename grade node:', node.type); if (name && name.trim()) { rememberHistory('Rename grade node'); node.type = name.trim().slice(0, 24); renderInspector(); markDirty(); } }));
      $('#addGradeNodeButton')?.addEventListener('click', () => { rememberHistory('Add grade node'); state.project.colorNodes.splice(Math.max(0, state.project.colorNodes.length - 1), 0, { id: uid('node'), type: 'Serial' }); renderInspector(); markDirty(); });
      $('#resetGradeButton')?.addEventListener('click', () => { rememberHistory('Reset grade'); Object.assign(clip, { brightness: 100, contrast: 100, saturation: 100, hue: 0 }); renderInspector(); refreshPreview(true); markDirty(); });
    } else if (tab === 'audio') {
      container.innerHTML = inspectorSection('Audio controls', `${field('Clip gain', 'volume', clip.volume ?? 100, { type: 'range', min: 0, max: 200 })}${field('Mute clip', 'muted', clip.muted || false, { type: 'checkbox' })}<p class="muted-copy">Web Audio routing and clip gain apply in the preview/export path where supported. Bus routing, LUFS compliance metering and AI stem separation are not active in this build.</p>`) + inspectorSection('Track', `<p class="muted-copy">Track: ${esc(trackById(clip.trackId)?.name || 'Missing track')}</p><button class="secondary-button" id="muteTrackButton">${trackById(clip.trackId)?.muted ? 'Unmute track' : 'Mute track'}</button>`);
      bindClipFields(container, clip);
      $('#muteTrackButton')?.addEventListener('click', () => { const track = trackById(clip.trackId); if (track) { rememberHistory('Toggle track mute'); track.muted = !track.muted; renderTimeline(); renderInspector(); markDirty(); } });
    }
    $$('.range-field input', container).forEach(input => input.addEventListener('input', () => { const display = $(`[data-range-value="${input.dataset.prop}"]`, container); if (display) display.textContent = input.value; }));
    renderScopes();
  }

  function bindClipFields(container, clip) {
    $$('[data-prop]', container).forEach(input => {
      const update = () => {
        const key = input.dataset.prop;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number' || input.type === 'range') value = Number(value);
        if (key === 'start' || key === 'duration') value = Math.max(key === 'start' ? 0 : 1 / state.project.fps, value);
        if (key === 'trackId') { const track = trackById(value); if (!track || track.kind !== (clip.type === 'audio' ? 'audio' : 'video')) return; }
        clip[key] = value;
        if (key === 'start' || key === 'duration') sortClips();
        if (key === 'name') { const timelineClip = $(`[data-clip-id="${clip.id}"]`); if (timelineClip) $('.clip-label', timelineClip).textContent = clip.name; }
        renderTimeline(); refreshPreview(false); markDirty();
      };
      if (input.type === 'range') {
        input.addEventListener('pointerdown', () => rememberHistory(`Change ${input.dataset.prop}`));
        input.addEventListener('keydown', () => rememberHistory(`Change ${input.dataset.prop}`));
        input.addEventListener('input', update);
        input.addEventListener('change', markDirty);
      } else { input.addEventListener('change', () => { rememberHistory(`Change ${input.dataset.prop}`); update(); }); }

    });
  }
  function bindProjectFields(container) {
    $$('[data-prop]', container).forEach(input => input.addEventListener('change', () => {
      const key = input.dataset.prop; let value = input.value;
      if (['fps', 'width', 'height'].includes(key)) value = Number(value);
      rememberHistory(`Change ${key}`);
      if (key === 'sequenceName') state.project.sequenceName = value;
      else state.project[key] = value;
      renderEverything(); markDirty();
    }));
  }
  function addKeyframe(clip) {
    rememberHistory('Add keyframe');
    for (const property of ['positionX', 'positionY', 'scale', 'rotation', 'opacity', 'volume']) {
      if (clip[property] == null) continue;
      const points = clip.keyframes[property] || (clip.keyframes[property] = []);
      const localTime = clamp(state.project.playhead - clip.start, 0, clip.duration);
      const existing = points.findIndex(point => Math.abs(point.time - localTime) < 0.0001);
      const point = { time: localTime, value: clip[property], interpolation: 'smooth' };
      if (existing >= 0) points[existing] = point; else points.push(point);
      points.sort((a, b) => a.time - b.time);
    }
    renderInspector(); markDirty(); notify('Keyframes added at the current playhead.');
  }
  function renderScopes() {
    const canvases = $$('.scope-canvas');
    if (!canvases.length) return;
    const sample = document.createElement('canvas'); sample.width = 160; sample.height = 90;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    const video = $('#previewVideo'), image = $('#previewImage');
    const source = !video.hidden && video.readyState >= 2 ? video : !image.hidden && image.complete ? image : null;
    let pixels = null;
    if (source && sampleContext) {
      try { sampleContext.drawImage(source, 0, 0, sample.width, sample.height); pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data; }
      catch (_) { pixels = null; }
    }

    for (const canvas of canvases) {
      const ctx = canvas.getContext('2d'); if (!ctx) continue;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#090a0b'; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#25292c'; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, height * i / 4); ctx.lineTo(width, height * i / 4); ctx.stroke(); }
      for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(width * i / 8, 0); ctx.lineTo(width * i / 8, height); ctx.stroke(); }
      if (!pixels) {
        ctx.fillStyle = '#656a74'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Waiting for a decoded preview frame', width / 2, height / 2);
        continue;
      }
      if (canvas.id === 'histogramScope') {
        const bins = Array.from({ length: 256 }, () => 0); let peak = 1;
        for (let i = 0; i < pixels.length; i += 4) {
          const luma = Math.round((pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722)); bins[luma]++;
        }
        peak = Math.max(1, ...bins);
        ctx.fillStyle = '#a7c77d';
        bins.forEach((count, index) => { const bar = count / peak * (height - 8); ctx.fillRect(index / 256 * width, height - bar, Math.max(1, width / 256), bar); });
      } else if (canvas.id === 'rgbScope') {
        const channelColors = ['#e27b7b', '#8fd19a', '#7f9ee9'];
        channelColors.forEach((color, channel) => {
          const counts = Array.from({ length: width }, () => new Float32Array(height));
          for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
            const sourceIndex = (y * sample.width + x) * 4;
            const value = pixels[sourceIndex + channel]; const px = Math.floor(x / sample.width * width); const py = height - 1 - Math.round(value / 255 * (height - 1));
            counts[px][py] += 1;
          }
          ctx.fillStyle = color; ctx.globalAlpha = .25;
          for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) if (counts[x][y]) ctx.fillRect(x, y, 1, 1);
        });
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#d8ff6a'; ctx.globalAlpha = .09;
        for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
          const index = (y * sample.width + x) * 4;
          const luma = (pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722) / 255;
          const scopeX = Math.floor(x / sample.width * width);
          const scopeY = height - 1 - Math.round(luma * (height - 1));
          ctx.fillRect(scopeX, scopeY, Math.max(1, width / sample.width), 1);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function renderEverything() {
    $('#projectName').value = state.project.name || 'Untitled Project';
    $('#projectMeta').textContent = `${state.project.width}×${state.project.height} · ${state.project.fps} FPS`;
    $('#viewerResolution').textContent = `${state.project.width} × ${state.project.height}`;
    $('#magneticButton').classList.toggle('active', state.settings.magnetic);
    $('#magneticButton').textContent = state.settings.magnetic ? '◈ Magnetic' : '◇ Free';
    renderMediaBin(); renderTimeline(); renderInspector(); refreshPreview(true); updateUndoButtons();
  }

  async function loadInitialState() {
    try {
      const [assets, prefs, projects] = await Promise.all([
        AxiomStorage.listAssets(),
        Promise.all(['aiPromptSeen', 'aiInstalled', 'settings', 'keymap', 'keymapPreset'].map(key => AxiomStorage.getPreference(key))),
        AxiomStorage.listProjects()
      ]);
      state.assets = assets;
      const [promptSeen, aiInstalled, settings, keymap, preset] = prefs;
      state.settings = { ...state.settings, ...(settings || {}) };
      state.settings.aiPromptSeen = !!promptSeen;
      state.aiInstalled = !!aiInstalled;
      if (keymap) state.keymap = { ...state.keymap, ...keymap };
      if (preset) state.settings.keymap = preset;
      if (projects.length) {
        projects.sort((a, b) => (b.modifiedAt || b.savedAt || 0) - (a.modifiedAt || a.savedAt || 0));
        const recent = projects[0];
        state.project = { ...makeProject(), ...recent };
        $('#projectName').value = state.project.name;
      }
      if (!state.project.assetIds.length) state.project.assetIds = state.assets.map(asset => asset.id);
      state.settings.magnetic = state.project.magnetic ?? state.settings.magnetic;
    } catch (error) {
      console.warn('Axiom local storage initialization:', error);
      notify(`Local database notice: ${error.message}`, 'error', 5000);
    }
    renderEverything();
    const persist = await AxiomStorage.requestPersistentStorage().catch(() => false);
    $('#localStorageStatus').textContent = persist ? 'PERSISTENT LOCAL STORAGE' : 'LOCAL-FIRST WORKSPACE';
    if (!state.settings.aiPromptSeen) openModal('aiModal');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(error => console.info('Offline worker unavailable:', error.message));
  }

  async function openStorageDetails() {
    const estimate = await AxiomStorage.storageEstimate();
    const assetsSize = state.assets.reduce((sum, asset) => sum + (asset.size || 0), 0);
    $('#storageDetailsContent').innerHTML = `<div class="storage-stat-grid"><div><span>Media assets</span><strong>${state.assets.length}</strong></div><div><span>Source file size</span><strong>${humanBytes(assetsSize)}</strong></div><div><span>Origin storage use</span><strong>${humanBytes(estimate.usage)}</strong></div><div><span>Estimated quota</span><strong>${humanBytes(estimate.quota)}</strong></div></div><p class="muted-copy">Original imports are stored locally in OPFS where available, with IndexedDB fallback. Browser storage can still be removed by clearing site data. Export important project JSON backups regularly.</p><button class="secondary-button" id="persistStorageButton">Request persistent storage</button><button class="secondary-button" id="openSettingsStorageButton">Open storage settings</button>`;
    $('#persistStorageButton').addEventListener('click', async () => notify(await AxiomStorage.requestPersistentStorage() ? 'Persistent storage granted by browser.' : 'Browser did not grant persistent storage.'));
    $('#openSettingsStorageButton').addEventListener('click', () => { closeModal('storageModal'); openSettings('storage'); });
    openModal('storageModal');
  }

  function projectToFile() {
    const payload = { format: 'axiom-editor-project', version: 1, exportedAt: new Date().toISOString(), project: serializeProject() };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${safeFilename(state.project.name)}.axiom.json`);
    notify('Project JSON exported. Media files are not embedded.', 'success');
  }
  function safeFilename(name) { return (name || 'axiom-project').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 90) || 'axiom-project'; }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importProjectFile(file) {
    try {
      const raw = JSON.parse(await file.text());
      const incoming = raw.project || raw;
      if (!incoming || !Array.isArray(incoming.tracks) || !Array.isArray(incoming.clips)) throw new Error('This file does not look like an Axiom project.');
      rememberHistory('Open project');
      const knownAssets = new Set(state.assets.map(asset => asset.id));
      const missing = incoming.clips.filter(clip => clip.assetId && !knownAssets.has(clip.assetId));
      state.project = { ...makeProject(), ...incoming, id: uid('project'), playhead: 0 };
      if (missing.length) notify(`${missing.length} clip(s) reference source media not in this browser. Re-import the original files and relink them manually.`, 'error', 6000);
      $('#projectName').value = state.project.name;
      renderEverything(); markDirty(); await saveProject(false); closeModal('projectModal');
    } catch (error) { notify(`Couldn't open project: ${error.message}`, 'error', 5000); }
  }
  function newProject() {
    if (state.project.clips.length && !confirm('Create a new project? Save the current project first if you need it later.')) return;
    state.project = makeProject(); state.selectedClipId = null; state.undo.length = 0; state.redo.length = 0;
    $('#projectName').value = state.project.name; renderEverything(); markDirty(); closeModal('projectModal');
  }

  function setWorkspacePreset(preset) {
    const workspace = $('#workspace'); workspace.classList.remove('layout-editing');
    if (preset === 'ingest') { workspace.style.setProperty('--media-width', '350px'); workspace.style.setProperty('--inspector-width', '250px'); workspace.style.setProperty('--timeline-height', '240px'); }
    else if (preset === 'color') { workspace.style.setProperty('--media-width', '220px'); workspace.style.setProperty('--inspector-width', '340px'); workspace.style.setProperty('--timeline-height', '300px'); state.activeInspectorTab = 'color'; }
    else if (preset === 'audio') { workspace.style.setProperty('--media-width', '220px'); workspace.style.setProperty('--inspector-width', '340px'); state.activeInspectorTab = 'audio'; }
    else { workspace.style.setProperty('--media-width', '270px'); workspace.style.setProperty('--inspector-width', '305px'); workspace.style.setProperty('--timeline-height', '290px'); }
    state.settings.workspace = preset; renderInspector(); AxiomStorage.savePreference('settings', state.settings).catch(() => {}); notify(`${preset[0].toUpperCase()}${preset.slice(1)} workspace applied.`);
  }
  function toggleLayoutEdit() {
    const workspace = $('#workspace'); workspace.classList.toggle('layout-editing');
    if (workspace.classList.contains('layout-editing')) {
      $$('.panel-heading', workspace).forEach(heading => {
        const panel = heading.closest('.panel'); heading.draggable = true;
        heading.ondragstart = event => { event.dataTransfer.setData('text/axiom-panel', panel.dataset.panel); event.dataTransfer.effectAllowed = 'move'; panel.classList.add('panel-dragging'); };
        heading.ondragend = () => $$('.panel').forEach(item => item.classList.remove('panel-dragging', 'panel-drop-target'));
        panel.ondragover = event => { if (event.dataTransfer.types.includes('text/axiom-panel')) { event.preventDefault(); panel.classList.add('panel-drop-target'); } };
        panel.ondragleave = () => panel.classList.remove('panel-drop-target');
        panel.ondrop = event => {
          event.preventDefault(); const sourceId = event.dataTransfer.getData('text/axiom-panel'); const source = $(`[data-panel="${sourceId}"]`); if (!source || source === panel) return;
          const box = panel.getBoundingClientRect(); const before = event.clientX < box.left + box.width / 2;
          panel.parentNode.insertBefore(source, before ? panel : panel.nextSibling); assignWorkspacePositions(); saveCustomWorkspace();
        };
      });
      notify('Workspace edit mode: drag panel headings to rearrange and resize panels.');
    } else {
      $$('.panel-heading', workspace).forEach(heading => { heading.draggable = false; heading.ondragstart = null; });
      $$('.panel', workspace).forEach(panel => { panel.ondragover = null; panel.ondrop = null; panel.ondragleave = null; });
      saveCustomWorkspace();
    }
  }
  function assignWorkspacePositions() {
    let slot = 0;
    for (const panel of $$('.panel[data-panel]', $('#workspace'))) {
      if (panel.dataset.panel === 'timeline') { panel.style.gridColumn = '1 / 4'; panel.style.gridRow = '2'; continue; }
      if (panel.hidden) continue;
      slot++; panel.style.gridColumn = String(Math.min(slot, 3)); panel.style.gridRow = '1';
    }
  }
  function saveCustomWorkspace() {
    assignWorkspacePositions();
    const order = $$('.panel[data-panel]').map(panel => panel.dataset.panel);
    AxiomStorage.savePreference('panelOrder', order).catch(() => {});
  }

  function openSettings(tab = 'general') {
    $$('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === tab));
    renderSettingsContent(tab); openModal('settingsModal');
  }
  function renderSettingsContent(tab = 'general') {
    state.settingsTab = tab;
    const container = $('#settingsContent');
    if (tab === 'general') {
      container.innerHTML = `<div class="settings-row"><div><strong>Automatic project recovery</strong><p>Save changes to this browser on a short interval.</p></div><label class="switch"><input id="autoSaveSetting" type="checkbox" ${state.settings.autoSave ? 'checked' : ''}><span></span></label></div><div class="settings-row"><div><strong>Auto-save interval</strong><p>Seconds between saves when edits stop.</p></div><select id="autoSaveSecondsSetting"><option value="2" ${state.settings.autoSaveSeconds == 2 ? 'selected' : ''}>2 seconds</option><option value="5" ${state.settings.autoSaveSeconds == 5 ? 'selected' : ''}>5 seconds</option><option value="10" ${state.settings.autoSaveSeconds == 10 ? 'selected' : ''}>10 seconds</option><option value="30" ${state.settings.autoSaveSeconds == 30 ? 'selected' : ''}>30 seconds</option></select></div><div class="settings-row"><div><strong>Default timeline behavior</strong><p>Automatically snap clips to nearby edits.</p></div><label class="switch"><input id="magneticSetting" type="checkbox" ${state.settings.magnetic ? 'checked' : ''}><span></span></label></div><div class="settings-row"><div><strong>Keyboard preset</strong><p>Choose a familiar editing keymap baseline.</p></div><select id="keymapPresetSetting"><option value="axiom">Axiom</option><option value="premiere">Premiere Pro style</option><option value="resolve">DaVinci Resolve style</option><option value="finalcut">Final Cut Pro style</option></select></div><div class="settings-row"><div><strong>Rearrange panels</strong><p>Drag panels by their headings and resize where supported.</p></div><button id="layoutEditSetting" class="secondary-button">Toggle layout edit</button></div>`;
      $('#keymapPresetSetting').value = state.settings.keymap || 'axiom';
      $('#keymapPresetSetting').addEventListener('change', () => { state.settings.keymap = $('#keymapPresetSetting').value; applyKeymapPreset(state.settings.keymap); });
      $('#layoutEditSetting').addEventListener('click', toggleLayoutEdit);
    } else if (tab === 'shortcuts') {
      const shortcutLabels = { playPause: 'Play / pause', save: 'Save project', undo: 'Undo', redo: 'Redo', split: 'Razor / split', select: 'Selection tool', addMarker: 'Add marker', export: 'Export sequence', delete: 'Delete selected clip' };
      container.innerHTML = `<p class="muted-copy">Click a binding and press the new key combination. Modifier names are shown as Ctrl, Alt and Shift.</p><div class="shortcut-list">${Object.entries(shortcutLabels).map(([key, label]) => `<div class="shortcut-row"><span>${label}</span><button data-shortcut="${key}" class="shortcut-binding">${esc(state.keymap[key] || 'Unassigned')}</button></div>`).join('')}</div><div class="inspector-actions"><button id="resetShortcutsButton" class="secondary-button">Reset current preset</button></div>`;
      $$('[data-shortcut]', container).forEach(button => button.addEventListener('click', () => {
        button.textContent = 'Press keys…'; button.classList.add('listening');
        const listen = event => {
          event.preventDefault(); event.stopPropagation();
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
          state.keymap[button.dataset.shortcut] = canonicalKey(event); button.textContent = state.keymap[button.dataset.shortcut]; button.classList.remove('listening'); document.removeEventListener('keydown', listen, true); AxiomStorage.savePreference('keymap', state.keymap).catch(() => {}); notify('Shortcut updated.');
        };
        document.addEventListener('keydown', listen, true);
      }));
      $('#resetShortcutsButton').addEventListener('click', () => { applyKeymapPreset(state.settings.keymap || 'axiom'); renderSettingsContent('shortcuts'); });
    } else if (tab === 'ai') {
      container.innerHTML = `<div class="settings-row"><div><strong>Local speech transcription</strong><p>Whisper Tiny English model. Setup downloads the runtime and model; it runs locally after setup, depending on browser cache and device memory.</p></div><span class="feature-chip ${state.aiInstalled ? 'ready-chip' : ''}">${state.aiInstalled ? 'INSTALLED' : 'NOT INSTALLED'}</span></div><div class="settings-row"><div><strong>Optional model setup</strong><p>Choose the local model now. Setup requires internet; your source media is processed in the browser.</p></div><button id="settingsInstallAIButton" class="primary-button">${state.aiInstalled ? 'Check model' : 'Install model'}</button></div><div class="settings-row"><div><strong>Clear optional AI downloads</strong><p>Remove Axiom's opt-in cache of runtime and model responses. The next transcription will need an internet connection again.</p></div><button id="clearAICacheButton" class="secondary-button">Clear AI cache</button></div><div class="settings-row"><div><strong>Scene-cut detection</strong><p>Frame-difference analysis runs locally without downloading an AI model.</p></div><button id="settingsSceneCutButton" class="secondary-button">Analyze timeline</button></div><div class="settings-row"><div><strong>AI data policy</strong><p>AI features remain off until explicitly enabled. Model downloads are the only feature setup network request described here.</p></div></div>`;
      $('#settingsInstallAIButton').addEventListener('click', () => { closeModal('settingsModal'); $('#installWhisperCheckbox').checked = true; openModal('aiModal'); });
      $('#clearAICacheButton').addEventListener('click', async () => {
        try {
          const registration = await navigator.serviceWorker?.ready; const worker = registration?.active || navigator.serviceWorker?.controller;
          if (worker) await new Promise(resolve => { const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 2500); channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(!!event.data?.ok); }; worker.postMessage({ type: 'CLEAR_AI_CACHE' }, [channel.port2]); });
          state.aiInstalled = false; window.AxiomTranscriber = null; await AxiomStorage.savePreference('aiInstalled', false); renderSettingsContent('ai'); notify('Axiom AI cache cleared. The model is no longer marked installed.', 'success');
        } catch (error) { notify(`Couldn't clear AI cache: ${error.message}`, 'error'); }
      });
      $('#settingsSceneCutButton').addEventListener('click', () => { closeModal('settingsModal'); detectSceneCuts(); });
    } else if (tab === 'storage') {
      container.innerHTML = `<div class="settings-row"><div><strong>Local storage architecture</strong><p>Media is stored in OPFS where supported, with IndexedDB fallback. Project metadata and recovery snapshots use IndexedDB.</p></div><button id="storageRefreshSetting" class="secondary-button">Inspect</button></div><div class="settings-row"><div><strong>Generated cache limit</strong><p>Target cap for future proxy/waveform/render caches. Does not change original media storage.</p></div><select id="cacheLimitSetting"><option value="5">5 GB</option><option value="10">10 GB</option><option value="20">20 GB</option><option value="50">50 GB</option><option value="100">100 GB</option></select></div><div class="settings-row"><div><strong>Clear generated cache</strong><p>Deletes Axiom's generated cache directory only. Original media and project files are retained.</p></div><button id="purgeCacheSetting" class="secondary-button">Clear cache</button></div>`;
      $('#cacheLimitSetting').value = state.settings.cacheLimitGB || 20;
      $('#storageRefreshSetting').addEventListener('click', () => { closeModal('settingsModal'); openStorageDetails(); });
      $('#purgeCacheSetting').addEventListener('click', async () => { const result = await AxiomStorage.clearGeneratedCache(); notify(result.message, result.cleared ? 'success' : 'error'); });
      $('#cacheLimitSetting').addEventListener('change', () => { state.settings.cacheLimitGB = Number($('#cacheLimitSetting').value); });
    } else {
      container.innerHTML = `<div class="capability-list"><div><strong>WebGPU</strong><span id="webgpuState">Checking…</span></div><div><strong>WebCodecs</strong><span id="webcodecsState">Checking…</span></div><div><strong>OPFS</strong><span id="opfsState">Checking…</span></div><div><strong>File System Access</strong><span id="fileSystemState">Checking…</span></div><div><strong>WebNN</strong><span id="webnnState">Checking…</span></div><div><strong>MediaRecorder</strong><span id="mediaRecorderState">Checking…</span></div></div><p class="muted-copy">Support depends on the browser, OS, GPU drivers and codecs installed by the browser. Capability checks do not guarantee a specific hardware codec or available memory.</p><button class="secondary-button" id="runDiagnosticsButton">Run diagnostics</button>`;
      $('#runDiagnosticsButton').addEventListener('click', renderDiagnostics); renderDiagnostics();
    }
  }
  function canonicalKey(event) {
    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey && !['Shift'].includes(event.key)) parts.push('Shift');
    let key = event.key;
    if (key === ' ') key = 'Space'; else if (key.length === 1) key = key.toLowerCase();
    parts.push(key); return parts.join('+');
  }
  function applyKeymapPreset(preset) {
    const presets = {
      axiom: { playPause: 'Space', save: 'Ctrl+s', undo: 'Ctrl+z', redo: 'Ctrl+Shift+z', split: 'c', select: 'v', addMarker: 'm', export: 'Ctrl+e', delete: 'Delete' },
      premiere: { playPause: 'Space', save: 'Ctrl+s', undo: 'Ctrl+z', redo: 'Ctrl+Shift+z', split: 'c', select: 'v', addMarker: 'm', export: 'Ctrl+m', delete: 'Delete' },
      resolve: { playPause: 'Space', save: 'Ctrl+s', undo: 'Ctrl+z', redo: 'Ctrl+Shift+z', split: 'b', select: 'a', addMarker: 'm', export: 'Ctrl+e', delete: 'Backspace' },
      finalcut: { playPause: 'Space', save: 'Ctrl+s', undo: 'Ctrl+z', redo: 'Ctrl+Shift+z', split: 'b', select: 'a', addMarker: 'm', export: 'Ctrl+e', delete: 'Delete' }
    };
    state.keymap = { ...(presets[preset] || presets.axiom) };
    AxiomStorage.savePreference('keymap', state.keymap).catch(() => {});
    AxiomStorage.savePreference('keymapPreset', preset).catch(() => {});
  }
  async function renderDiagnostics() {
    const results = {
      webgpuState: !!navigator.gpu,
      webcodecsState: typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined',
      opfsState: !!navigator.storage?.getDirectory,
      fileSystemState: !!window.showOpenFilePicker || !!window.showDirectoryPicker,
      webnnState: !!navigator.ml,
      mediaRecorderState: typeof MediaRecorder !== 'undefined'
    };
    for (const [id, works] of Object.entries(results)) { const target = $(`#${id}`); if (target) { target.textContent = works ? 'Available' : 'Not available'; target.classList.toggle('capability-good', works); } }
    if (navigator.gpu) {
      try { const adapter = await navigator.gpu.requestAdapter(); $('#webgpuState').textContent = adapter ? `Available · ${adapter.info?.description || 'GPU adapter'}` : 'No adapter found'; } catch (_) { /* The support flag is adequate. */ }
    }
  }
  function addAiProgress(message, percent) {
    $('#aiProgress').hidden = false; $('#aiProgressText').textContent = message; $('#aiProgressBar').style.width = `${percent}%`;
  }
  async function enableAiOfflineCache() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active || navigator.serviceWorker.controller;
      if (!worker) return false;
      return await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 2500);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(!!event.data?.ok); };
        worker.postMessage({ type: 'ENABLE_AI_CACHE' }, [channel.port2]);
      });
    } catch (_) { return false; }
  }
  async function createTranscriber(onProgress = () => {}) {
    const moduleUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';
    const transformers = await import(moduleUrl);
    return transformers.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: event => {
        if (event.status === 'progress' && event.total) onProgress(`Downloading ${event.file || 'model data'}…`, clamp(event.loaded / event.total * 100, 1, 99));
        else if (event.status === 'done') onProgress('Caching model data…', 99);
      }
    });
  }
  async function getTranscriber() {
    if (window.AxiomTranscriber) return window.AxiomTranscriber;
    if (!state.aiInstalled) return null;
    notify('Loading your previously installed local transcription model…');
    try {
      window.AxiomTranscriber = await createTranscriber((message, percent) => {
        $('#appStatus').textContent = `${message} ${Math.round(percent)}%`;
      });
      return window.AxiomTranscriber;
    } catch (error) {
      throw new Error(`The saved model could not be loaded. Connect to the internet once to repair its cache. ${error.message}`);
    }
  }

  async function installAI() {
    if (!$('#installWhisperCheckbox').checked) {
      state.settings.aiPromptSeen = true; await AxiomStorage.savePreference('aiPromptSeen', true); closeModal('aiModal'); notify('Continuing without optional AI.'); return;
    }
    const button = $('#installAIButton'); button.disabled = true; $('#aiNotNowButton').disabled = true; $('#aiOfflineButton').disabled = true;
    try {
      if (!navigator.onLine) throw new Error('Connect to the internet to download the selected model.');
      addAiProgress('Preparing the optional offline cache…', 5);
      await enableAiOfflineCache();
      addAiProgress('Downloading the Whisper Tiny model. This can be a large download…', 15);
      // The network requests below only happen after the user explicitly selected Install.
      const transcriber = await createTranscriber((message, percent) => addAiProgress(message, 15 + percent * .82));
      window.AxiomTranscriber = transcriber;
      state.aiInstalled = true; state.settings.aiPromptSeen = true;
      await Promise.all([AxiomStorage.savePreference('aiInstalled', true), AxiomStorage.savePreference('aiPromptSeen', true)]);
      $('#whisperInstallState').textContent = 'INSTALLED · LOCAL INFERENCE';
      addAiProgress('Model is ready for local transcription.', 100); notify('Local transcription model installed.', 'success');
      window.setTimeout(() => { closeModal('aiModal'); $('#aiProgress').hidden = true; }, 1200);
    } catch (error) {
      addAiProgress(`Setup failed: ${error.message}`, 0); notify(`AI setup failed: ${error.message}`, 'error', 6000);
    } finally { button.disabled = false; $('#aiNotNowButton').disabled = false; $('#aiOfflineButton').disabled = false; }
  }
  async function transcribeSelectedAsset() {
    const asset = assetById(state.selectedAssetId);
    if (!asset || !['audio', 'video'].includes(asset.type)) { notify('Select an audio or video asset in the media bin first.'); return; }
    if (!state.aiInstalled) { openModal('aiModal'); notify('Local transcription is optional and has not been installed yet.'); return; }
    try {
      const transcriber = await getTranscriber();
      if (!transcriber) { openModal('aiModal'); return; }
      notify('Transcribing locally. Large files can take a while…');
      const file = await AxiomStorage.getAssetFile(asset.id, true);
      const url = URL.createObjectURL(file);
      try {
        const result = await transcriber(url, { chunk_length_s: 20, stride_length_s: 4 });
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (!text) throw new Error('The transcription model returned no text.');
        const sentences = text.match(/[^.!?]+[.!?]?/g)?.map(line => line.trim()).filter(Boolean) || [text];
        const baseStart = state.project.playhead;
        const track = state.project.tracks.find(item => item.kind === 'video' && !item.locked) || addTrack('video', false);
        rememberHistory('Add transcription titles');
        const segmentDuration = Math.max(2, (asset.duration || sentences.length * 2) / sentences.length);
        sentences.forEach((line, index) => state.project.clips.push({ id: uid('clip'), name: `Transcript ${index + 1}`, type: 'text', trackId: track.id, start: baseStart + index * segmentDuration, duration: Math.min(segmentDuration, Math.max(0.5, (asset.duration || sentences.length * segmentDuration) - index * segmentDuration)), ...clipDefaultProperties('text'), text: line, fontSize: 48, positionY: 34 }));
        sortClips(); renderEverything(); markDirty(); notify(`Added ${sentences.length} transcription title(s) to the timeline.`, 'success', 5000);
      } finally { URL.revokeObjectURL(url); }
    } catch (error) { notify(`Transcription failed: ${error.message}`, 'error', 6000); }
  }
  async function detectSceneCuts() {
    const clip = clipById();
    let asset = clip?.assetId ? assetById(clip.assetId) : assetById(state.selectedAssetId);
    if (!asset || asset.type !== 'video') { notify('Select a video clip or video asset first.'); return; }
    let url;
    try {
      const file = await AxiomStorage.getAssetFile(asset.id, true); url = URL.createObjectURL(file);
      const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.src = url;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('This video format cannot be decoded by the browser.')); });
      const duration = Math.min(video.duration || 0, 600); if (duration <= 0) throw new Error('No video duration was detected.');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36; const context = canvas.getContext('2d', { willReadFrequently: true });
      const sampleCount = Math.min(240, Math.max(12, Math.floor(duration * 2))); let previous = null; const detected = [];
      for (let index = 0; index < sampleCount; index++) {
        const time = duration * index / sampleCount;
        if (Math.abs(video.currentTime - time) > 0.001 || video.readyState < 2) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out while sampling a frame.')); }, 5000);
            const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); };
            const done = () => { cleanup(); resolve(); }; const fail = () => { cleanup(); reject(new Error('Could not decode a sampled video frame.')); };
            video.addEventListener('seeked', done); video.addEventListener('loadeddata', done); video.addEventListener('error', fail);
            if (Math.abs(video.currentTime - time) > 0.001) video.currentTime = time;
          });
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (previous) {
          let difference = 0;
          for (let pixel = 0; pixel < data.length; pixel += 16) difference += Math.abs(data[pixel] - previous[pixel]) + Math.abs(data[pixel + 1] - previous[pixel + 1]) + Math.abs(data[pixel + 2] - previous[pixel + 2]);
          const mean = difference / (data.length / 16 * 3);
          if (mean > 42 && time > .5) detected.push(time);
        }
        previous = new Uint8ClampedArray(data);
        if (index % 6 === 0) { $('#appStatus').textContent = `Analyzing scene changes · ${Math.round(index / sampleCount * 100)}%`; }
      }
      const filtered = []; for (const time of detected) if (!filtered.length || time - filtered[filtered.length - 1] >= 1.25) filtered.push(time);
      rememberHistory('Add scene markers');
      filtered.forEach((time, index) => state.project.markers.push({ id: uid('marker'), time: (clip?.start || 0) + time, label: `Scene cut ${index + 1}`, color: '#d8ff6a' }));
      renderTimeline(); markDirty(); $('#appStatus').textContent = `${filtered.length} likely scene cut(s) detected`;
      notify(`Scene analysis found ${filtered.length} likely cut(s). Review markers before editing.`, 'success', 5000);
    } catch (error) { notify(`Scene analysis failed: ${error.message}`, 'error', 6000); }
    finally { if (url) URL.revokeObjectURL(url); }
  }

  function waitMedia(media, eventName, timeout = 10000) {
    if ((eventName === 'loadedmetadata' && media.readyState >= 1) || (eventName === 'loadeddata' && media.readyState >= 2)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => cleanup(new Error('Timed out waiting for media to decode.')), timeout);
      const done = () => cleanup(); const fail = () => cleanup(new Error('A source clip could not be decoded.'));
      function cleanup(error) { clearTimeout(timer); media.removeEventListener(eventName, done); media.removeEventListener('error', fail); error ? reject(error) : resolve(); }
      media.addEventListener(eventName, done, { once: true }); media.addEventListener('error', fail, { once: true });
    });
  }
  async function exportSequence() {
    const canvas = document.createElement('canvas');
    const size = $('#exportSize').value;
    const [width, height] = size === 'sequence' ? [state.project.width, state.project.height] : size.split('x').map(Number);
    canvas.width = clamp(width, 320, 3840); canvas.height = clamp(height, 240, 3840);
    const fpsChoice = $('#exportFps').value; const fps = fpsChoice === 'sequence' ? state.project.fps : Number(fpsChoice);
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') { notify('This browser does not provide canvas recording. Try a current desktop Chromium-based browser.', 'error', 6000); return; }
    let mime = 'video/webm;codecs=vp9';
    const choice = $('#exportFormat').value;
    const choices = choice === 'h264' ? ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'] : choice === 'vp8' ? ['video/webm;codecs=vp8', 'video/webm'] : choice === 'vp9' ? ['video/webm;codecs=vp9', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    mime = choices.find(type => MediaRecorder.isTypeSupported(type)) || '';
    if (!mime) { notify('No supported MediaRecorder video format was detected.', 'error', 5000); return; }
    $('#exportProgressWrap').hidden = false; $('#exportProgressBar').style.width = '0%'; $('#exportProgressPercent').textContent = '0%';
    $('#startExportButton').disabled = true; $('#startExportButton').textContent = 'Rendering…'; $('#cancelExportButton').textContent = 'Cancel render'; $('#cancelExportButton').disabled = false;
    for (const id of ['exportFileName', 'exportFormat', 'exportSize', 'exportFps']) $(`#${id}`).disabled = true;
    state.exportAbort = false; state.exporting = true; stopPlayback();
    const context = canvas.getContext('2d', { alpha: false }); const total = sequenceDuration();
    const videoCache = new Map(); const imageCache = new Map(); const audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
    let audioDestination = null;
    if (audioContext) audioDestination = audioContext.createMediaStreamDestination();
    const stream = canvas.captureStream(fps);
    if (audioDestination) audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    let recorder = null;
    let recording = null;
    const chunks = [];
    const titleClips = state.project.clips.filter(clip => clip.type === 'text');
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recording = new Promise((resolve, reject) => { recorder.onstop = () => resolve(); recorder.onerror = event => reject(event.error || new Error('The browser recorder failed.')); });
      for (const clip of state.project.clips) {
        if (clip.type === 'video' && !videoCache.has(clip.assetId)) {
          const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = await getObjectUrl(clip.assetId, true);
          await waitMedia(video, 'loadedmetadata'); videoCache.set(clip.assetId, video);
        } else if (clip.type === 'image' && !imageCache.has(clip.assetId)) {
          const image = new Image(); image.src = await getObjectUrl(clip.assetId, true); await image.decode(); imageCache.set(clip.assetId, image);
        }
      }
      const audioPlayers = [];
      if (audioContext && audioDestination) {
        for (const clip of state.project.clips.filter(item => item.type === 'audio' && !trackById(item.trackId)?.muted)) {
          const audio = document.createElement('audio'); audio.src = await getObjectUrl(clip.assetId, true); audio.preload = 'auto'; audio.volume = 1;
          await waitMedia(audio, 'loadedmetadata').catch(() => {});
          const source = audioContext.createMediaElementSource(audio); const gain = audioContext.createGain(); gain.gain.value = clamp((clip.volume ?? 100) / 100, 0, 2); source.connect(gain).connect(audioDestination);
          audioPlayers.push({ audio, clip, gain });
        }
      }
      const syncAudioAt = async time => {
        if (!audioContext) return;
        for (const { audio, clip, gain } of audioPlayers) {
          const active = time >= clip.start && time < clipEnd(clip) && !clip.muted;
          if (!active) { if (!audio.paused) audio.pause(); continue; }
          const expected = Math.max(0, (clip.sourceIn || 0) + time - clip.start);
          if (audio.paused || Math.abs(audio.currentTime - expected) > 0.35) {
            try { audio.currentTime = expected; } catch (_) { /* Some containers reject an early seek. */ }
          }
          gain.gain.value = clamp(animatedValue(clip, 'volume', clip.volume ?? 100, time) / 100, 0, 2);
          if (audio.paused) audio.play().catch(() => {});
        }
      };
      const drawAt = async time => {
        await syncAudioAt(time);
        context.fillStyle = state.project.background || '#08090a'; context.fillRect(0, 0, canvas.width, canvas.height);
        // Later-listed video tracks are rendered first, so V2 can sit above V1.
        const visual = state.project.tracks.filter(track => track.kind === 'video' && !track.muted).slice().reverse();
        for (const track of visual) {
          const clip = state.project.clips.find(item => item.trackId === track.id && (item.type === 'video' || item.type === 'image') && item.start <= time && clipEnd(item) > time);
          if (!clip) continue;
          const source = clip.type === 'video' ? videoCache.get(clip.assetId) : imageCache.get(clip.assetId);
          if (!source) continue;
          if (clip.type === 'video') { const mediaTime = clamp((clip.sourceIn || 0) + time - clip.start, 0, Math.max(0, source.duration - .03)); if (Math.abs(source.currentTime - mediaTime) > .03) { source.currentTime = mediaTime; await waitMedia(source, 'seeked', 3000).catch(() => {}); } }
          context.save(); context.globalAlpha = animatedValue(clip, 'opacity', clip.opacity ?? 100, time) / 100;
          context.translate(canvas.width * (.5 + animatedValue(clip, 'positionX', clip.positionX || 0, time) / 100), canvas.height * (.5 + animatedValue(clip, 'positionY', clip.positionY || 0, time) / 100)); context.rotate(animatedValue(clip, 'rotation', clip.rotation || 0, time) * Math.PI / 180); const scale = animatedValue(clip, 'scale', clip.scale ?? 100, time) / 100;
          const sourceWidth = source.videoWidth || source.naturalWidth || canvas.width; const sourceHeight = source.videoHeight || source.naturalHeight || canvas.height; const fit = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight) * scale;
          context.filter = [clip, ...adjustmentLayersForClip(clip, time)].map(layer => filterForClip(layer, time)).join(' ');
          context.drawImage(source, -sourceWidth * fit / 2, -sourceHeight * fit / 2, sourceWidth * fit, sourceHeight * fit); context.restore();
        }
        for (const clip of titleClips) if (clip.start <= time && clipEnd(clip) > time) {
          context.save(); context.filter = [clip, ...adjustmentLayersForClip(clip, time)].map(layer => filterForClip(layer, time)).join(' '); context.globalAlpha = animatedValue(clip, 'opacity', clip.opacity ?? 100, time) / 100; context.translate(canvas.width * (.5 + animatedValue(clip, 'positionX', clip.positionX || 0, time) / 100), canvas.height * (.5 + animatedValue(clip, 'positionY', clip.positionY || 0, time) / 100)); context.rotate(animatedValue(clip, 'rotation', clip.rotation || 0, time) * Math.PI / 180); context.fillStyle = clip.color || '#fff'; context.textAlign = clip.align || 'center'; context.textBaseline = 'middle'; context.font = `${clip.italic ? 'italic ' : ''}${clip.bold ? '700' : '400'} ${Math.max(8, (clip.fontSize || 72) * canvas.width / state.project.width)}px ${clip.fontFamily || 'Arial'}`; context.shadowColor = '#000a'; context.shadowBlur = clip.effect === 'shadow' ? 14 : 5;
          const maxWidth = canvas.width * .86; const words = String(clip.text || '').split(/\s+/); const lines = []; let line = '';
          for (const word of words) { const candidate = line ? `${line} ${word}` : word; if (context.measureText(candidate).width > maxWidth && line) { lines.push(line); line = word; } else line = candidate; } if (line) lines.push(line);
          const lineHeight = (clip.fontSize || 72) * canvas.width / state.project.width * 1.15; lines.forEach((text, index) => context.fillText(text, 0, (index - (lines.length - 1) / 2) * lineHeight, maxWidth)); context.restore();
        }
        state.project.playhead = time; $('#exportProgressBar').style.width = `${time / total * 100}%`; $('#exportProgressPercent').textContent = `${Math.round(time / total * 100)}%`; $('#exportProgressText').textContent = `Rendering ${timecode(time)} / ${timecode(total)}`;
      };
      if (audioContext && audioPlayers.length) await audioContext.resume();
      recorder.start(250);
      const startAt = performance.now(); const frameCount = Math.ceil(total * fps);
      for (let frame = 0; frame < frameCount; frame++) {
        if (state.exportAbort) break;
        const time = frame / fps;
        await drawAt(time);
        const target = startAt + (frame + 1) / fps * 1000;
        const delay = target - performance.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 100)));
      }
      recorder.stop(); await recording;
      audioPlayers.forEach(({ audio }) => { audio.pause(); audio.src = ''; });
      stream.getTracks().forEach(track => track.stop()); if (audioContext) await audioContext.close();
      const blob = new Blob(chunks, { type: mime });
      if (blob.size && !state.exportAbort) { const ext = mime.includes('mp4') ? 'mp4' : 'webm'; downloadBlob(blob, `${safeFilename($('#exportFileName').value)}.${ext}`); notify(`Local render complete · ${humanBytes(blob.size)}.`, 'success', 5000); }
      else if (!state.exportAbort) throw new Error('The browser produced an empty export.');
      $('#exportProgressText').textContent = state.exportAbort ? 'Render cancelled.' : 'Render complete.';
      $('#exportProgressBar').style.width = state.exportAbort ? '0%' : '100%'; $('#exportProgressPercent').textContent = state.exportAbort ? 'Cancelled' : '100%';
    } catch (error) {
      console.error('Export:', error);
      $('#exportProgressText').textContent = `Render failed: ${error.message}`;
      notify(`Export failed: ${error.message}`, 'error', 6000);
    } finally {
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) { /* A failed recorder may already be stopping. */ } }
      stream.getTracks().forEach(track => track.stop());
      if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => {});
      state.exporting = false;
      $('#startExportButton').disabled = false;
      $('#startExportButton').innerHTML = 'Render again <span>↗</span>';
      $('#cancelExportButton').disabled = false;
      $('#cancelExportButton').textContent = 'Done';
      for (const id of ['exportFileName', 'exportFormat', 'exportSize', 'exportFps']) $(`#${id}`).disabled = false;
    }
  }

  function movePanel(panelName, direction) {
    const workspace = $('#workspace'); const panels = $$('.panel[data-panel]', workspace).filter(panel => panel.dataset.panel !== 'timeline');
    const currentIndex = panels.findIndex(panel => panel.dataset.panel === panelName); const targetIndex = clamp(currentIndex + direction, 0, panels.length - 1);
    if (currentIndex < 0 || targetIndex === currentIndex) return;
    const source = panels[currentIndex], target = panels[targetIndex];
    workspace.insertBefore(source, direction < 0 ? target : target.nextSibling); assignWorkspacePositions(); saveCustomWorkspace();
  }
  function hidePanel(panelName) {
    const panel = $(`[data-panel="${panelName}"]`); if (!panel || panelName === 'timeline') { notify('The timeline cannot be hidden.'); return; }
    panel.hidden = true; assignWorkspacePositions(); saveCustomWorkspace(); notify(`${panelName} panel hidden. Use any panel menu → Show all panels to restore it.`);
  }

  function openExportDialog() {
    if (state.exporting) return;
    $('#exportFileName').value = safeFilename(state.project.name);
    $('#exportProgressWrap').hidden = true;
    $('#exportProgressBar').style.width = '0%';
    $('#exportProgressPercent').textContent = '0%';
    $('#exportProgressText').textContent = 'Starting render…';
    $('#startExportButton').disabled = false;
    $('#startExportButton').innerHTML = 'Start local render <span>↗</span>';
    $('#cancelExportButton').disabled = false;
    $('#cancelExportButton').textContent = 'Cancel';
    openModal('exportModal');
  }

  function applyAction(action) {
    closeDropdown();
    switch (action) {
      case 'newProject': openModal('projectModal'); break;
      case 'openProject': $('#projectFileInput').click(); break;
      case 'save': saveProject(true); break;
      case 'downloadProject': projectToFile(); break;
      case 'export': openExportDialog(); break;
      case 'settings': openSettings(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'split': splitAtPlayhead(); break;
      case 'duplicate': duplicateSelectedClip(); break;
      case 'delete': deleteSelectedClip(); break;
      case 'addTitle': addTitleClip(); break;
      case 'addAdjustment': addAdjustmentClip(); break;
      case 'sceneCuts': detectSceneCuts(); break;
      case 'sequenceSettings': $('#sequenceNameInput').value = state.project.sequenceName; $('#sequenceFpsInput').value = state.project.fps; $('#sequenceWidthInput').value = state.project.width; $('#sequenceHeightInput').value = state.project.height; openModal('timelineSettingsModal'); break;
      case 'addVideoTrack': addTrack('video'); break;
      case 'addAudioTrack': addTrack('audio'); break;
      case 'addMarker': addMarker(); break;
      case 'magnetic': rememberHistory('Toggle magnetic timeline'); state.settings.magnetic = !state.settings.magnetic; state.project.magnetic = state.settings.magnetic; renderTimeline(); $('#magneticButton').classList.toggle('active', state.settings.magnetic); markDirty(); break;
      case 'fullscreen': $('#previewStage').requestFullscreen?.(); break;
      case 'safeArea': state.settings.safeArea = !state.settings.safeArea; $('#safeArea').hidden = !state.settings.safeArea; $('#safeAreaButton').classList.toggle('active', state.settings.safeArea); break;
      case 'layoutEdit': toggleLayoutEdit(); break;
      case 'workspaceEditing': setWorkspacePreset('editing'); break;
      case 'workspaceIngest': setWorkspacePreset('ingest'); break;
      case 'workspaceColor': setWorkspacePreset('color'); break;
      case 'workspaceAudio': setWorkspacePreset('audio'); break;
      case 'aiSetup': openModal('aiModal'); break;
      case 'aiSettings': openSettings('ai'); break;
      case 'transcribe': transcribeSelectedAsset(); break;
      case 'panelMoveLeft': movePanel(state.contextTarget, -1); break;
      case 'panelMoveRight': movePanel(state.contextTarget, 1); break;
      case 'hidePanel': hidePanel(state.contextTarget); break;
      case 'showAllPanels': $$('.panel').forEach(panel => { panel.hidden = false; }); assignWorkspacePositions(); break;
      case 'resetWorkspace': setWorkspacePreset('editing'); $$('.panel').forEach(panel => { panel.hidden = false; }); assignWorkspacePositions(); break;
    }
  }

  function wireEvents() {
    $$('[data-menu]').forEach(button => button.addEventListener('click', () => showMenu(button.dataset.menu, button)));
    $$('[data-panel-menu]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation(); const panel = button.dataset.panelMenu; state.contextTarget = panel;
      const popup = $('#dropdownMenu'); const bounds = button.getBoundingClientRect();
      popup.innerHTML = `<button data-action="panelMoveLeft">Move one slot left</button><button data-action="panelMoveRight">Move one slot right</button><div class="dropdown-divider"></div><button data-action="hidePanel">Hide panel</button><button data-action="showAllPanels">Show all panels</button><button data-action="resetWorkspace">Reset workspace</button>`;
      popup.style.left = `${clamp(bounds.left, 8, window.innerWidth - 235)}px`; popup.style.top = `${clamp(bounds.bottom + 4, 8, window.innerHeight - 220)}px`; popup.dataset.menu = 'panel'; popup.hidden = false;
    }));
    document.addEventListener('click', event => { if (!event.target.closest('#dropdownMenu') && !event.target.closest('[data-menu]') && !event.target.closest('[data-panel-menu]')) closeDropdown(); });
    $('#dropdownMenu').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) applyAction(button.dataset.action); });
    $('#importMediaButton').addEventListener('click', () => $('#mediaFileInput').click());
    $('#emptyImportButton')?.addEventListener('click', () => $('#mediaFileInput').click());
    $('#viewerImportButton').addEventListener('click', () => $('#mediaFileInput').click());
    $('#mediaFileInput').addEventListener('change', async event => { await importFiles(event.target.files); event.target.value = ''; });
    $('#folderFileInput').addEventListener('change', async event => { await importFiles(event.target.files); event.target.value = ''; });
    $('#linkFolderButton').addEventListener('click', async () => {
      if (window.showDirectoryPicker) {
        try {
          const directory = await window.showDirectoryPicker({ mode: 'read' }); const files = [], handles = [];
          async function walk(handle) { for await (const [name, entry] of handle.entries()) { if (entry.kind === 'directory') await walk(entry); else { const file = await entry.getFile(); if (fileKind(file)) { files.push(file); handles.push(entry); } } } }
          await walk(directory); await importFiles(files, handles);
        } catch (error) { if (error.name !== 'AbortError') notify(`Folder link failed: ${error.message}`, 'error'); }
      } else { notify('This browser does not support direct folder handles. A folder picker fallback will copy selected media into local storage.'); $('#folderFileInput').click(); }
    });
    $('#mediaList').addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); $('#mediaPanel').classList.add('drop-target'); } });
    $('#mediaList').addEventListener('dragleave', () => $('#mediaPanel').classList.remove('drop-target'));
    $('#mediaList').addEventListener('drop', async event => { $('#mediaPanel').classList.remove('drop-target'); if (event.dataTransfer.files.length) { event.preventDefault(); await importFiles(event.dataTransfer.files); } });
    $('#mediaSearch').addEventListener('input', renderMediaBin);
    $('#mediaViewButton').addEventListener('click', () => { state.isListView = !state.isListView; renderMediaBin(); });
    $('#undoButton').addEventListener('click', undo); $('#redoButton').addEventListener('click', redo);
    $('#saveProjectButton').addEventListener('click', () => saveProject(true));
    $('#projectName').addEventListener('change', () => { state.project.name = $('#projectName').value.trim() || 'Untitled Project'; markDirty(); });
    $('#brandHome').addEventListener('click', () => openModal('projectModal'));
    $('#exportButton').addEventListener('click', openExportDialog);
    $('#startExportButton').addEventListener('click', exportSequence);
    $('#cancelExportButton').addEventListener('click', () => {
      if (state.exporting) {
        state.exportAbort = true;
        $('#cancelExportButton').disabled = true;
        $('#cancelExportButton').textContent = 'Cancelling…';
      } else closeModal('exportModal');
    });
    $('#fullscreenButton').addEventListener('click', () => $('#previewStage').requestFullscreen?.());
    $('#playButton').addEventListener('click', () => state.playing ? stopPlayback() : startPlayback());
    $('#jumpStartButton').addEventListener('click', () => { stopPlayback(); setPlayhead(0); });
    $('#jumpEndButton').addEventListener('click', () => { stopPlayback(); setPlayhead(sequenceDuration()); });
    $('#stepBackButton').addEventListener('click', () => { stopPlayback(); setPlayhead(state.project.playhead - 1 / state.project.fps); });
    $('#stepForwardButton').addEventListener('click', () => { stopPlayback(); setPlayhead(state.project.playhead + 1 / state.project.fps); });
    $('#safeAreaButton').addEventListener('click', () => applyAction('safeArea'));
    $('#viewerFitButton').addEventListener('click', () => { $('#previewStage').style.maxWidth = $('#previewStage').style.maxWidth ? '' : '100%'; });
    $('#addTitleButton').addEventListener('click', addTitleClip);
    $('#addAdjustmentButton').addEventListener('click', addAdjustmentClip);
    $('#addVideoTrackButton').addEventListener('click', () => addTrack('video'));
    $('#addAudioTrackButton').addEventListener('click', () => addTrack('audio'));
    $('#magneticButton').addEventListener('click', () => applyAction('magnetic'));
    $('#markerButton').addEventListener('click', addMarker);
    $('#timelineSettingsButton').addEventListener('click', () => applyAction('sequenceSettings'));
    $('#timelineZoom').addEventListener('input', event => { state.zoom = Number(event.target.value); renderTimeline(); });
    $('#zoomOutButton').addEventListener('click', () => { state.zoom = clamp(state.zoom - 10, 24, 180); renderTimeline(); });
    $('#zoomInButton').addEventListener('click', () => { state.zoom = clamp(state.zoom + 10, 24, 180); renderTimeline(); });
    $$('.tool-button').forEach(button => button.addEventListener('click', () => { state.activeTool = button.dataset.tool; $$('.tool-button').forEach(item => item.classList.toggle('active', item === button)); $('#timelineStatus').textContent = `${button.querySelector('span')?.textContent || state.activeTool} tool active`; }));
    $$('.inspector-tab').forEach(button => button.addEventListener('click', () => { state.activeInspectorTab = button.dataset.inspectorTab; renderInspector(); }));
    $('#settingsButton').addEventListener('click', () => openSettings());
    $('#storageDetailsButton').addEventListener('click', openStorageDetails);
    $('#purgeCacheButton').addEventListener('click', async () => { const result = await AxiomStorage.clearGeneratedCache(); notify(result.message, result.cleared ? 'success' : 'error'); });
    $('#aiNotNowButton').addEventListener('click', async () => { state.settings.aiPromptSeen = true; await AxiomStorage.savePreference('aiPromptSeen', true); closeModal('aiModal'); });
    $('#aiOfflineButton').addEventListener('click', async () => { state.settings.aiPromptSeen = true; await AxiomStorage.savePreference('aiPromptSeen', true); closeModal('aiModal'); notify('Axiom will run without the optional AI model.'); });
    $('#installAIButton').addEventListener('click', installAI);
    $('#downloadProjectButton').addEventListener('click', projectToFile);
    $('#openProjectButton').addEventListener('click', () => $('#projectFileInput').click());
    $('#projectFileInput').addEventListener('change', async event => { const file = event.target.files[0]; if (file) await importProjectFile(file); event.target.value = ''; });
    $('#newProjectButton').addEventListener('click', newProject);
    $('#applySequenceSettingsButton').addEventListener('click', () => {
      rememberHistory('Sequence settings'); state.project.sequenceName = $('#sequenceNameInput').value.trim() || 'Sequence 01'; state.project.fps = Number($('#sequenceFpsInput').value); state.project.width = Number($('#sequenceWidthInput').value); state.project.height = Number($('#sequenceHeightInput').value); closeModal('timelineSettingsModal'); renderEverything(); markDirty();
    });
    $('#saveSettingsButton').addEventListener('click', async () => {
      state.settings.autoSave = $('#autoSaveSetting')?.checked ?? state.settings.autoSave;
      state.settings.autoSaveSeconds = Number($('#autoSaveSecondsSetting')?.value || state.settings.autoSaveSeconds);
      state.settings.magnetic = $('#magneticSetting')?.checked ?? state.settings.magnetic;
      state.project.magnetic = state.settings.magnetic;
      state.settings.cacheLimitGB = Number($('#cacheLimitSetting')?.value || state.settings.cacheLimitGB);
      state.settings.keymap = $('#keymapPresetSetting')?.value || state.settings.keymap;
      await Promise.all([AxiomStorage.savePreference('settings', state.settings), AxiomStorage.savePreference('keymap', state.keymap)]);
      $('#magneticButton').classList.toggle('active', state.settings.magnetic); closeModal('settingsModal'); markDirty(); notify('Settings saved locally.', 'success');
    });
    $$('.settings-tab').forEach(button => button.addEventListener('click', () => { $$('.settings-tab').forEach(tab => tab.classList.toggle('active', tab === button)); renderSettingsContent(button.dataset.settingsTab); }));
    $$('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
    $$('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => {
      if (event.target !== backdrop || backdrop.id === 'aiModal') return;
      if (backdrop.id === 'exportModal' && state.exporting) { state.exportAbort = true; $('#cancelExportButton').disabled = true; $('#cancelExportButton').textContent = 'Cancelling…'; return; }
      closeModal(backdrop.id);
    }));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { closeDropdown(); if (document.fullscreenElement) document.exitFullscreen?.(); return; }
      const target = event.target; const editing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && target.type !== 'range';
      if (editing) return;
      const key = canonicalKey(event);
      const actions = Object.entries(state.keymap).find(([, binding]) => String(binding).toLowerCase() === key.toLowerCase())?.[0];
      if (actions) { event.preventDefault(); const map = { playPause: () => state.playing ? stopPlayback() : startPlayback(), save: () => saveProject(true), undo, redo, split: splitAtPlayhead, select: () => { state.activeTool = 'select'; $$('.tool-button').forEach(button => button.classList.toggle('active', button.dataset.tool === 'select')); }, addMarker, export: () => applyAction('export'), delete: deleteSelectedClip }; map[actions]?.(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelectedClip(); }
      else if (event.key === 'ArrowLeft') { stopPlayback(); setPlayhead(state.project.playhead - 1 / state.project.fps); }
      else if (event.key === 'ArrowRight') { stopPlayback(); setPlayhead(state.project.playhead + 1 / state.project.fps); }
    });
    window.addEventListener('beforeunload', event => { if (state.isDirty || state.exporting) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('resize', () => refreshPreview(false));
  }

  async function boot() {
    wireEvents();
    try {
      const panelOrder = await AxiomStorage.getPreference('panelOrder', null);
      if (Array.isArray(panelOrder)) {
        const workspace = $('#workspace'); panelOrder.forEach(name => { const panel = $(`[data-panel="${name}"]`, workspace); if (panel) workspace.append(panel); }); assignWorkspacePositions();
      }
    } catch (_) { /* Local database initialization handles the more useful failure notice. */ }
    await loadInitialState();
    $('#timelineScroll').addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('application/x-axiom-asset')) event.preventDefault(); });
    $('#timelineScroll').addEventListener('scroll', () => { $('#playheadLine').style.left = `${82 + state.project.playhead * state.zoom}px`; });
    if (!('showDirectoryPicker' in window)) $('#linkFolderButton').title = 'Import a folder (linked handles unavailable in this browser)';
    setInterval(() => { if (state.playing) return; renderScopes(); }, 1200);
  }

  boot().catch(error => { console.error(error); notify(`Axiom failed to initialize: ${error.message}`, 'error', 8000); });
})();
