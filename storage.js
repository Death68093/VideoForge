(function () {
  const DB_NAME = 'axiom-editor-local';
  const DB_VERSION = 1;
  let databasePromise;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not provide IndexedDB, which Axiom needs for project recovery.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the local database.'));
    });
    return databasePromise;
  }

  async function runStore(storeName, mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try { result = operation(store); }
      catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result && typeof result.result !== 'undefined' ? result.result : result);
      transaction.onerror = () => reject(transaction.error || new Error('Local storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction was cancelled.'));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Database request failed.'));
    });
  }

  async function opfsDirectory(name, create = true) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create });
  }

  async function saveLocalFile(assetId, file) {
    try {
      const directory = await opfsDirectory('axiom-media');
      if (!directory) return { storage: 'indexeddb', blob: file };
      const handle = await directory.getFileHandle(`${assetId}.media`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return { storage: 'opfs', path: `${assetId}.media` };
    } catch (error) {
      // The IndexedDB fallback is intentionally retained for browsers with limited OPFS support.
      return { storage: 'indexeddb', blob: file, storageError: error.message };
    }
  }

  async function getOpfsFile(path) {
    const directory = await opfsDirectory('axiom-media', false);
    if (!directory) throw new Error('The local media folder is no longer available.');
    const handle = await directory.getFileHandle(path, { create: false });
    return handle.getFile();
  }

  async function saveAsset(asset, file, sourceHandle) {
    let storageInfo = { storage: 'indexeddb', blob: file };
    if (sourceHandle && typeof sourceHandle.getFile === 'function') {
      storageInfo = { storage: 'linked', handle: sourceHandle };
    } else {
      storageInfo = await saveLocalFile(asset.id, file);
    }
    const record = { ...asset, ...storageInfo, savedAt: Date.now() };
    await runStore('assets', 'readwrite', store => store.put(record));
    return stripMediaPayload(record);
  }

  function stripMediaPayload(record) {
    const { blob, handle, ...metadata } = record;
    return { ...metadata, hasHandle: !!handle, hasBlob: !!blob };
  }

  async function getAssetRecord(id) {
    return runStore('assets', 'readonly', store => requestValue(store.get(id)));
  }

  async function listAssets() {
    const db = await openDatabase();
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction('assets', 'readonly').objectStore('assets').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Could not list media assets.'));
    });
    return records.map(stripMediaPayload);
  }

  async function getAssetFile(assetOrId, requestPermission = false) {
    const record = typeof assetOrId === 'string' ? await getAssetRecord(assetOrId) : await getAssetRecord(assetOrId.id);
    if (!record) throw new Error('This media item is missing from local storage. Re-import or relink it.');

    if (record.storage === 'linked' && record.handle) {
      try {
        if (typeof record.handle.queryPermission === 'function') {
          let permission = await record.handle.queryPermission({ mode: 'read' });
          if (permission !== 'granted' && requestPermission && typeof record.handle.requestPermission === 'function') {
            permission = await record.handle.requestPermission({ mode: 'read' });
          }
          if (permission !== 'granted') throw new Error('Axiom needs permission to read this linked file. Relink it from the media bin.');
        }
        return await record.handle.getFile();
      } catch (error) {
        if (error && error.name === 'NotAllowedError') throw new Error('Permission to read this linked file was denied. Relink it from the media bin.');
        throw error;
      }
    }

    if (record.storage === 'opfs' && record.path) return getOpfsFile(record.path);
    if (record.blob instanceof Blob) return record.blob;
    throw new Error('The source media file could not be read. Re-import it to restore access.');
  }

  async function updateAssetMetadata(id, changes) {
    const record = await getAssetRecord(id);
    if (!record) throw new Error('The media asset no longer exists in local storage.');
    const next = { ...record, name: String(changes.name ?? record.name).trim() || record.name, updatedAt: Date.now() };
    await runStore('assets', 'readwrite', store => store.put(next));
    return stripMediaPayload(next);
  }

  async function deleteAsset(id) {
    const record = await getAssetRecord(id);
    await runStore('assets', 'readwrite', store => store.delete(id));
    if (record && record.storage === 'opfs' && record.path) {
      try {
        const directory = await opfsDirectory('axiom-media', false);
        if (directory) await directory.removeEntry(record.path);
      } catch (_) { /* A missing media file should not prevent metadata cleanup. */ }
    }
  }

  async function saveProject(project) {
    const snapshot = JSON.parse(JSON.stringify(project));
    snapshot.savedAt = Date.now();
    await runStore('projects', 'readwrite', store => store.put(snapshot));
    return snapshot.savedAt;
  }

  async function getProject(id) {
    return runStore('projects', 'readonly', store => requestValue(store.get(id)));
  }

  async function listProjects() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('projects', 'readonly').objectStore('projects').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Could not list saved projects.'));
    });
  }

  async function savePreference(key, value) {
    await runStore('preferences', 'readwrite', store => store.put({ key, value }));
  }

  async function getPreference(key, fallback = null) {
    const record = await runStore('preferences', 'readonly', store => requestValue(store.get(key)));
    return record ? record.value : fallback;
  }

  async function logActivity(entry) {
    try {
      await runStore('activity', 'readwrite', store => store.add({ ...entry, timestamp: Date.now() }));
      const db = await openDatabase();
      const entries = await new Promise((resolve, reject) => {
        const request = db.transaction('activity', 'readonly').objectStore('activity').getAllKeys();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      if (entries.length > 250) {
        await runStore('activity', 'readwrite', store => entries.slice(0, entries.length - 250).forEach(key => store.delete(key)));
      }
    } catch (_) { /* Activity logging is best-effort and never blocks an edit. */ }
  }

  async function clearGeneratedCache() {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      return { cleared: false, message: 'OPFS is not available in this browser.' };
    }
    try {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('axiom-cache', { recursive: true });
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
      return { cleared: true, message: 'Generated cache cleared. Original media and project files were left untouched.' };
    } catch (error) {
      return { cleared: false, message: error.message || 'Could not clear the generated cache.' };
    }
  }

  async function storageEstimate() {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      try { return await navigator.storage.estimate(); } catch (_) { /* Fall back to unknown values. */ }
    }
    return { usage: null, quota: null };
  }

  async function requestPersistentStorage() {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      try { return await navigator.storage.persist(); } catch (_) { return false; }
    }
    return false;
  }

  window.AxiomStorage = {
    openDatabase,
    saveAsset,
    getAssetRecord,
    getAssetFile,
    listAssets,
    deleteAsset,
    updateAssetMetadata,
    saveProject,
    getProject,
    listProjects,
    savePreference,
    getPreference,
    logActivity,
    clearGeneratedCache,
    storageEstimate,
    requestPersistentStorage,
    stripMediaPayload
  };
})();
