const DB_NAME = "book-gallery-v1";
const STORE = "photos";
const META_STORE = "meta";
/** Row id in `meta` store — mirrors LS_HIDDEN_STATIC so removals survive flaky localStorage. */
const HIDDEN_META_ID = "hidden-static-paths";
const DB_VERSION = 2;
const LS_CAPTION_PREFIX = "book-gallery-caption:";
const LS_CATEGORY_BY_ITEM = "book-gallery-category-by-item";
const LS_HIDDEN_STATIC = "book-gallery-hidden-static";
const CATEGORY_DATALIST_ID = "gallery-category-datalist";
/** Order of gallery card keys (`s:…`, `u:<uuid>` synced uploads, `i:<n>` local-only); localStorage only — cloud uses canonical order. */
const LS_ITEM_ORDER = "book-gallery-item-order";
/** Per static `images/…` path: last local edit or last merged remote `updated_at` (ms), for LWW merge. */
const LS_STATIC_LWW_MS = "book-gallery-static-lww-ms";

const staticImages = Array.isArray(window.BOOK_GALLERY_STATIC_IMAGES)
  ? window.BOOK_GALLERY_STATIC_IMAGES
  : [];

/**
 * UUID for cropped-upload `remoteId`. Prefer `crypto.randomUUID`; fall back to `getRandomValues`
 * so crops still sync on older browsers that lack `randomUUID`.
 */
function randomUuidForUpload() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    return "";
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Static card thumbs use Netlify Image CDN on deployed hosts: smaller dimensions plus AVIF/WebP
 * via content negotiation. Full-resolution `path` is still used in the lightbox. Local file or
 * localhost dev keeps raw `images/…` URLs (use `netlify dev` to exercise CDN locally).
 * @see https://docs.netlify.com/image-cdn/overview/
 */
function shouldUseNetlifyImageCdn() {
  if (typeof location === "undefined") return false;
  if (location.protocol === "file:") return false;
  const h = location.hostname;
  return h !== "localhost" && h !== "127.0.0.1";
}

function absoluteSitePath(assetPath) {
  return assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
}

/** @returns {{ src: string, srcset?: string, sizes?: string }} */
function thumbnailSourcesForStaticPath(assetPath) {
  if (!shouldUseNetlifyImageCdn()) {
    return { src: assetPath };
  }
  const abs = absoluteSitePath(assetPath);
  const enc = encodeURIComponent(abs);
  const base = `/.netlify/images?url=${enc}&q=78`;
  return {
    src: `${base}&w=720`,
    srcset: `${base}&w=400 400w, ${base}&w=720 720w, ${base}&w=1080 1080w`,
    sizes: "(max-width: 540px) 100vw, (max-width: 900px) 45vw, 320px",
  };
}

const gallery = document.getElementById("gallery");
const emptyState = document.getElementById("empty-state");
const toolbar = document.getElementById("toolbar");
const filterChips = document.getElementById("filter-chips");
const filterEmpty = document.getElementById("filter-empty");
const lightbox = document.getElementById("lightbox");
const lightboxStage = document.getElementById("lightbox-stage");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = lightbox.querySelector(".lightbox-close");

/** Set when opening the lightbox; used to place “save crop” uploads after the source card. */
let lightboxSourceItemKey = null;

let lbScale = 1;
let lbTx = 0;
let lbTy = 0;
const LB_MIN = 1;
const LB_MAX = 6;
const LB_STEP = 1.25;

let lbLastX = 0;
let lbLastY = 0;
/** Pointer is down on the lightbox stage while zoomed (tracking tap vs pan). */
let lbGestureActive = false;
/** True only after movement exceeds slop — then we pan and use pointer capture. */
let lbPanning = false;
let lbPanDownX = 0;
let lbPanDownY = 0;

function syncLightboxZoomButtons() {
  const zIn = document.getElementById("lightbox-zoom-in");
  const zOut = document.getElementById("lightbox-zoom-out");
  const zReset = document.getElementById("lightbox-zoom-reset");
  const cropBtn = document.getElementById("lightbox-save-crop");
  if (!zIn || !zOut || !zReset) return;
  zOut.disabled = lbScale <= 1.001;
  zIn.disabled = lbScale >= LB_MAX - 0.02;
  const atDefault =
    lbScale <= 1.001 && Math.abs(lbTx) < 1 && Math.abs(lbTy) < 1;
  zReset.disabled = atDefault;
  if (cropBtn) {
    const canCrop =
      !lightbox.hidden &&
      lightboxImg.naturalWidth > 0 &&
      lightboxImg.naturalHeight > 0 &&
      lbScale > 1.001;
    cropBtn.disabled = !canCrop;
  }
}

function resetLightboxZoom() {
  lbScale = 1;
  lbTx = 0;
  lbTy = 0;
  lbGestureActive = false;
  lbPanning = false;
  if (lightboxStage) {
    lightboxStage.classList.remove("is-zoomed", "is-dragging");
  }
  lightboxImg.style.transform = "";
  syncLightboxZoomButtons();
}

function applyLightboxZoom() {
  if (lbScale <= 1) {
    lbScale = 1;
    lbTx = 0;
    lbTy = 0;
    lightboxImg.style.transform = "";
    lightboxStage?.classList.remove("is-zoomed", "is-dragging");
    syncLightboxZoomButtons();
    return;
  }
  lightboxImg.style.transform = `translate(${lbTx}px, ${lbTy}px) scale(${lbScale})`;
  lightboxStage?.classList.add("is-zoomed");
  syncLightboxZoomButtons();
}

function lightboxZoomIn() {
  lbScale = Math.min(LB_MAX, lbScale * LB_STEP);
  applyLightboxZoom();
}

function lightboxZoomOut() {
  lbScale = Math.max(LB_MIN, lbScale / LB_STEP);
  if (lbScale <= 1.001) {
    lbScale = 1;
    lbTx = 0;
    lbTy = 0;
  }
  applyLightboxZoom();
}

if (lightboxStage) {
  lightboxStage.addEventListener("pointerdown", (e) => {
    if (lightbox.hidden || lbScale <= 1) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    lbGestureActive = true;
    lbPanning = false;
    lbPanDownX = e.clientX;
    lbPanDownY = e.clientY;
    lbLastX = e.clientX;
    lbLastY = e.clientY;
  });

  lightboxStage.addEventListener("pointermove", (e) => {
    if (!lbGestureActive || lbScale <= 1) return;
    if (!lbPanning) {
      if (
        Math.hypot(e.clientX - lbPanDownX, e.clientY - lbPanDownY) > 6
      ) {
        lbPanning = true;
        try {
          lightboxStage.setPointerCapture(e.pointerId);
        } catch (_) {
          /* noop */
        }
        lightboxStage.classList.add("is-dragging");
        lbLastX = e.clientX;
        lbLastY = e.clientY;
      }
      return;
    }
    lbTx += e.clientX - lbLastX;
    lbTy += e.clientY - lbLastY;
    lbLastX = e.clientX;
    lbLastY = e.clientY;
    lightboxImg.style.transform = `translate(${lbTx}px, ${lbTy}px) scale(${lbScale})`;
    syncLightboxZoomButtons();
  });

  lightboxStage.addEventListener("pointerup", (e) => {
    if (!lbGestureActive) return;
    lbGestureActive = false;
    if (lbPanning) {
      lbPanning = false;
      try {
        lightboxStage.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* noop */
      }
      lightboxStage.classList.remove("is-dragging");
    }
  });

  lightboxStage.addEventListener("pointercancel", () => {
    lbGestureActive = false;
    lbPanning = false;
    lightboxStage.classList.remove("is-dragging");
  });
}

document.getElementById("lightbox-zoom-in")?.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxZoomIn();
});
document.getElementById("lightbox-zoom-out")?.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxZoomOut();
});
document.getElementById("lightbox-zoom-reset")?.addEventListener("click", (e) => {
  e.stopPropagation();
  resetLightboxZoom();
});

document.getElementById("lightbox-save-crop")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const btn = document.getElementById("lightbox-save-crop");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  /** Copy now — closing the lightbox (e.g. Escape) clears `lightboxSourceItemKey` mid-save. */
  const afterKey = lightboxSourceItemKey;
  try {
    const blob = await cropVisibleLightboxToBlob();
    if (!blob) {
      alert(
        "Could not create a crop. Zoom in first so part of the photo is visible in the frame. If you opened this page as a file on disk, use a local server (or Netlify) instead so the browser can read the image safely."
      );
      return;
    }
    try {
      const configured = !!window.LibrarySync?.isConfigured?.();
      const uuid = configured ? randomUuidForUpload() : "";
      const remoteId = uuid || null;
      if (configured && !remoteId) {
        alert(
          "Could not create a sync id in this browser; the crop is saved only here. Use an up-to-date browser over HTTPS (or try Chrome/Firefox)."
        );
      }
      const sourceMeta = await sourceMetaForLightboxKey(afterKey);
      const ts =
        remoteId && configured ? new Date().toISOString() : undefined;
      const newId = await addPhotoFromBlob(blob, "", {
        ...sourceMeta,
        ...(remoteId ? { remoteId, remoteUpdatedAt: ts } : {}),
      });
      if (!configured) {
        await insertGalleryOrderAfterSource(afterKey, itemKeyIdb(newId));
      }
      if (remoteId) {
        try {
          await syncNewLocalUploadToCloud(newId, remoteId);
        } catch (syncErr) {
          console.error(syncErr);
          alert(
            `The crop was saved on this device but did not fully upload to the shared library, so others may not see it yet.\n\n${
              syncErr instanceof Error ? syncErr.message : String(syncErr)
            }\n\nCheck the Supabase Storage bucket, row limits, and browser network; then try saving again or re-crop.`
          );
        }
      }
    } catch (idbErr) {
      console.error(idbErr);
      alert(
        "Could not store the photo in this browser (storage may be full or blocked). Check site settings or try another browser."
      );
      return;
    }
    closeLightbox();
    await refresh();
  } catch (err) {
    console.error(err);
    const isSecurity =
      err instanceof DOMException && err.name === "SecurityError";
    alert(
      isSecurity
        ? "The browser blocked exporting this image (cross-origin restriction). Host the gallery and images on the same site, or use photos you added via Upload."
        : `Could not save the crop: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    syncLightboxZoomButtons();
  }
});

lightboxImg.addEventListener("load", () => {
  if (!lightbox.hidden) resetLightboxZoom();
});

lightboxImg.addEventListener("click", (e) => {
  if (lightbox.hidden) return;
  if (lbScale >= LB_MAX - 0.02) return;
  e.stopPropagation();
  lightboxZoomIn();
});

/** @type {{ type: 'all' } | { type: 'uncategorized' } | { type: 'category', name: string }} */
let activeFilter = { type: "all" };

/** Snapshot of gallery items for filtering (same order as cards in DOM). */
let lastItems = [];

/** Multi-book visitor inquiry: card keys `s:…`, `u:…`, `i:…` and payload rows for Supabase. */
const inquirySelectedKeys = new Set();
/** @type {Map<string, { item_key: string, display_index: number, kind: string, label: string, image_path: string | null, upload_id: string | null }>} */
const inquirySnapshots = new Map();

/** Debounce timers for Supabase upserts (one per `images/…` path). */
const syncStaticTimers = Object.create(null);
let librarySyncSubscribed = false;
let lastLibrarySyncError = null;

function staticPathFromItemKey(key) {
  return key.startsWith("s:") ? key.slice(2) : null;
}

function shouldCloudSyncPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith("images/") &&
    staticImages.includes(path)
  );
}

function loadStaticLwwMap() {
  try {
    const raw = localStorage.getItem(LS_STATIC_LWW_MS);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function saveStaticLwwMap(obj) {
  try {
    localStorage.setItem(LS_STATIC_LWW_MS, JSON.stringify(obj));
  } catch (e) {
    console.warn("book-gallery: static LWW map", e);
  }
}

function getStaticLwwMs(path) {
  const m = loadStaticLwwMap();
  const v = m[path];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Call when the user edits notes or categories on a manifest photo so pulls don’t overwrite before push. */
function bumpStaticLocalLww(path) {
  if (!shouldCloudSyncPath(path)) return;
  const m = loadStaticLwwMap();
  const prev = typeof m[path] === "number" ? m[path] : 0;
  const t = Date.now();
  m[path] = Math.max(t, prev + 1);
  saveStaticLwwMap(m);
}

function recordMergedStaticLww(path, remoteMs) {
  if (!shouldCloudSyncPath(path) || !Number.isFinite(remoteMs)) return;
  const m = loadStaticLwwMap();
  const prev = typeof m[path] === "number" ? m[path] : 0;
  m[path] = Math.max(prev, remoteMs);
  saveStaticLwwMap(m);
}

function queueCloudSyncForStaticPath(path) {
  if (
    typeof window.LibrarySync?.isConfigured !== "function" ||
    !window.LibrarySync.isConfigured() ||
    !shouldCloudSyncPath(path)
  ) {
    return;
  }
  clearTimeout(syncStaticTimers[path]);
  syncStaticTimers[path] = setTimeout(() => {
    delete syncStaticTimers[path];
    const key = itemKeyStatic(path);
    const cat = getCategoryForKey(key);
    const notes = getStaticCaption(path);
    window.LibrarySync.push(path, cat, notes);
  }, 550);
}

function mergeRemoteLibraryRows(rows) {
  if (!rows?.length) return;
  const m = loadCategoryMap();
  for (const row of rows) {
    const path = row.image_path;
    if (!path || typeof path !== "string") continue;
    if (!shouldCloudSyncPath(path)) continue;
    const key = itemKeyStatic(path);
    const remoteMs =
      row.updated_at != null && row.updated_at !== ""
        ? new Date(String(row.updated_at)).getTime()
        : NaN;
    if (
      Number.isFinite(remoteMs) &&
      remoteMs <= getStaticLwwMs(path)
    ) {
      continue;
    }
    const cat = row.category != null ? String(row.category).trim() : "";
    if (cat) m[key] = cat;
    else delete m[key];
    setStaticCaption(
      path,
      row.notes != null ? String(row.notes) : "",
      { skipRemote: true }
    );
    if (Number.isFinite(remoteMs)) {
      recordMergedStaticLww(path, remoteMs);
    }
  }
  saveCategoryMap(m);
}

function updateSyncHint() {
  const el = document.getElementById("sync-hint");
  if (!el) return;
  if (!window.LibrarySync?.isConfigured?.()) {
    const onDeployedHttps =
      typeof location !== "undefined" &&
      location.protocol === "https:" &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1";
    if (onDeployedHttps) {
      el.textContent =
        "Shared library isn’t connected on this device (missing Supabase URL/key in this build, or the script was cached). This phone won’t load others’ edits until that works—try a hard refresh or your site’s latest deploy.";
      el.hidden = false;
      el.classList.add("sync-hint-warn");
    } else {
      el.textContent = "";
      el.hidden = true;
      el.classList.remove("sync-hint-warn");
    }
    return;
  }
  el.hidden = false;
  if (lastLibrarySyncError) {
    const msg =
      lastLibrarySyncError instanceof Error
        ? lastLibrarySyncError.message
        : String(lastLibrarySyncError);
    el.textContent = `Could not load the shared library. ${msg.slice(0, 200)}${
      msg.length > 200 ? "…" : ""
    } Try Wi‑Fi, disable content blockers for this site, hard refresh, then check Supabase + SQL.`;
    el.classList.add("sync-hint-warn");
  } else {
    el.textContent = "";
    el.hidden = true;
    el.classList.remove("sync-hint-warn");
  }
}

/** Retries help flaky mobile / captive-portal networks. */
async function pullLibraryFromCloud() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const remoteRows = await window.LibrarySync.pull();
      mergeRemoteLibraryRows(remoteRows);
      const uploadRows = await window.LibrarySync.pullUploads();
      await mergeRemoteUploadRows(uploadRows);
      return true;
    } catch (e) {
      lastErr = e;
      console.warn("book-gallery: cloud pull attempt failed", attempt, e);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 450 * attempt));
      }
    }
  }
  if (lastErr) lastLibrarySyncError = lastErr;
  return false;
}

function itemKeyStatic(path) {
  return `s:${path}`;
}

function itemKeyIdb(id) {
  return `i:${id}`;
}

/** Stable card key for IndexedDB rows: synced uploads use Supabase id so order matches every device. */
function itemKeyForIdbRow(row) {
  if (row?.remoteId) return `u:${row.remoteId}`;
  return itemKeyIdb(row.id);
}

/** Sort uploads for canonical order (ISO `remoteUpdatedAt`, then uuid, then local id). */
function idbOrderKey(row) {
  const t =
    typeof row.remoteUpdatedAt === "string" && row.remoteUpdatedAt.trim()
      ? row.remoteUpdatedAt.trim()
      : "";
  if (t) return t;
  if (row.remoteId) return String(row.remoteId);
  return `local:${String(row.id).padStart(9, "0")}`;
}

/**
 * @param {{ source_static_path?: string | null, source_upload_id?: string | null }} row
 */
function afterKeyFromUploadRowFields(row) {
  const sp = row.source_static_path;
  if (sp != null && String(sp).trim()) {
    return itemKeyStatic(String(sp).trim());
  }
  const su = row.source_upload_id;
  if (su != null && String(su).trim()) {
    return `u:${String(su).trim()}`;
  }
  return null;
}

function buildCanonicalOrderedKeys(idbRows) {
  const sortedStatic = visibleSortedStaticPaths();
  const list = sortedStatic.map(itemKeyStatic);
  const setList = new Set(list);
  const uploads = idbRows.slice();

  function cmpUploads(a, b) {
    const c = idbOrderKey(a).localeCompare(idbOrderKey(b));
    if (c !== 0) return c;
    const ar = a.remoteId ? String(a.remoteId) : String(a.id);
    const br = b.remoteId ? String(b.remoteId) : String(b.id);
    return ar.localeCompare(br);
  }

  const keyToRow = new Map();
  for (const r of uploads) keyToRow.set(itemKeyForIdbRow(r), r);

  /** If the source manifest image is hidden here, anchor to the nearest earlier visible static (same manifest order everywhere). */
  function anchorStaticKeyForSourcePath(sourcePath) {
    const hidden = loadHiddenStatic();
    const fullOrder = [...staticImages].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    const i = fullOrder.indexOf(sourcePath);
    if (i < 0) return null;
    for (let j = i; j >= 0; j--) {
      const p = fullOrder[j];
      if (hidden.has(p)) continue;
      const k = itemKeyStatic(p);
      if (setList.has(k)) return k;
    }
    return null;
  }

  /** Immediate parent key that already exists in `list`, or null. */
  function parentKeyInList(row) {
    const sp = row.source_static_path;
    if (sp != null && String(sp).trim()) {
      const path = String(sp).trim();
      const direct = itemKeyStatic(path);
      if (setList.has(direct)) return direct;
      return anchorStaticKeyForSourcePath(path);
    }
    const su = row.source_upload_id;
    if (su != null && String(su).trim()) {
      const k = `u:${String(su).trim()}`;
      return setList.has(k) ? k : null;
    }
    return null;
  }

  const pending = new Set(uploads);

  function appendStuckUploads() {
    const rest = [...pending].sort(cmpUploads);
    for (const r of rest) {
      const k = itemKeyForIdbRow(r);
      if (!setList.has(k)) {
        list.push(k);
        setList.add(k);
      }
      pending.delete(r);
    }
  }

  const maxPasses = Math.max(96, uploads.length * 6);
  let passes = 0;
  while (pending.size && passes < maxPasses) {
    passes += 1;
    const ready = [...pending].filter((r) => parentKeyInList(r) != null);
    if (!ready.length) {
      appendStuckUploads();
      break;
    }
    ready.sort(cmpUploads);
    const next = ready[0];
    const pk = parentKeyInList(next);
    const self = itemKeyForIdbRow(next);
    if (pk == null || setList.has(self)) {
      pending.delete(next);
      continue;
    }
    let idx = list.lastIndexOf(pk) + 1;
    while (idx < list.length) {
      const peer = keyToRow.get(list[idx]);
      if (!peer) break;
      if (parentKeyInList(peer) !== pk) break;
      if (cmpUploads(peer, next) <= 0) idx++;
      else break;
    }
    list.splice(idx, 0, self);
    setList.add(self);
    pending.delete(next);
  }
  if (pending.size) appendStuckUploads();

  return list;
}

/** Copy category + inquiry keys from `i:<id>` to `u:<uuid>` after sync. */
function migrateStableItemKeys(idbRows) {
  if (!window.LibrarySync?.isConfigured?.()) return;
  const m = loadCategoryMap();
  let catChanged = false;
  for (const row of idbRows) {
    if (!row.remoteId) continue;
    const oldK = itemKeyIdb(row.id);
    const newK = itemKeyForIdbRow(row);
    if (oldK === newK) continue;
    if (m[oldK] != null && m[newK] == null) {
      m[newK] = m[oldK];
      delete m[oldK];
      catChanged = true;
    } else if (m[oldK] != null && m[newK] != null) {
      delete m[oldK];
      catChanged = true;
    }
  }
  if (catChanged) saveCategoryMap(m);

  const saved = loadItemOrder();
  if (saved?.length) {
    const byOld = new Map(idbRows.map((r) => [itemKeyIdb(r.id), r]));
    let ordChanged = false;
    const repl = saved.map((k) => {
      if (k.startsWith("u:")) return k;
      const row = byOld.get(k);
      if (row?.remoteId) {
        ordChanged = true;
        return itemKeyForIdbRow(row);
      }
      return k;
    });
    if (ordChanged) saveItemOrder(repl);
  }

  const byOld = new Map(idbRows.map((r) => [itemKeyIdb(r.id), r]));
  for (const key of [...inquirySelectedKeys]) {
    if (!key.startsWith("i:")) continue;
    const row = byOld.get(key);
    if (!row?.remoteId) continue;
    const nk = itemKeyForIdbRow(row);
    inquirySelectedKeys.delete(key);
    inquirySelectedKeys.add(nk);
    const snap = inquirySnapshots.get(key);
    if (snap) {
      inquirySnapshots.delete(key);
      snap.item_key = nk;
      inquirySnapshots.set(nk, snap);
    }
  }
}

function loadCategoryMap() {
  try {
    const raw = localStorage.getItem(LS_CATEGORY_BY_ITEM);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function saveCategoryMap(map) {
  localStorage.setItem(LS_CATEGORY_BY_ITEM, JSON.stringify(map));
}

function getCategoryForKey(key) {
  const m = loadCategoryMap();
  const v = m[key];
  return typeof v === "string" ? v.trim() : "";
}

function dedupeCategoryNames(names) {
  const seen = new Set();
  const out = [];
  for (const x of names) {
    const t = String(x).trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(t);
  }
  return out;
}

/** @param {string} raw — legacy plain string or JSON array string */
function parseCategoriesFromStorage(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) {
        return dedupeCategoryNames(p.map((x) => String(x)));
      }
    } catch {
      /* single string */
    }
  }
  return [s];
}

/** @param {string[]} names */
function serializeCategoriesToStorage(names) {
  const cleaned = dedupeCategoryNames(names);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  return JSON.stringify(cleaned);
}

function getCategoryListForKey(key) {
  return parseCategoriesFromStorage(getCategoryForKey(key));
}

function setCategoriesForKey(key, names, opts = {}) {
  const m = loadCategoryMap();
  const storage = serializeCategoriesToStorage(names || []);
  if (!storage) delete m[key];
  else m[key] = storage;
  saveCategoryMap(m);
  if (!opts.skipRemote) {
    const path = staticPathFromItemKey(key);
    if (path && shouldCloudSyncPath(path)) bumpStaticLocalLww(path);
    if (path) queueCloudSyncForStaticPath(path);
  }
}

function setCategoryForKey(key, categoryName, opts = {}) {
  const c = (categoryName || "").trim();
  setCategoriesForKey(key, c ? [c] : [], opts);
}

function allCategoryNamesFromAssignments() {
  const m = loadCategoryMap();
  const names = new Set();
  for (const v of Object.values(m)) {
    if (typeof v !== "string" || !v.trim()) continue;
    for (const c of parseCategoriesFromStorage(v.trim())) names.add(c);
  }
  return [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

/** @returns {string[]} */
function categoryListForItem(item) {
  let raw = "";
  if (item.kind === "idb") {
    const rc = item.row.category;
    if (typeof rc === "string" && rc.trim()) raw = rc.trim();
  }
  if (!raw) raw = getCategoryForKey(item.key);
  return parseCategoriesFromStorage(raw);
}

function syncCategoryDatalist() {
  const dl = document.getElementById(CATEGORY_DATALIST_ID);
  if (!dl) return;
  const names = new Set(allCategoryNamesFromAssignments());
  for (const it of lastItems) {
    for (const c of categoryListForItem(it)) names.add(c);
  }
  const sorted = [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  dl.replaceChildren();
  for (const name of sorted) {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  }
}

function staticCaptionKey(path) {
  return LS_CAPTION_PREFIX + path;
}

function getStaticCaption(path) {
  return localStorage.getItem(staticCaptionKey(path)) ?? "";
}

function setStaticCaption(path, value, opts = {}) {
  localStorage.setItem(staticCaptionKey(path), value);
  if (!opts.skipRemote) {
    if (shouldCloudSyncPath(path)) bumpStaticLocalLww(path);
    queueCloudSyncForStaticPath(path);
  }
}

function parseHiddenStaticFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_HIDDEN_STATIC);
    const a = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

/** Live Set; same reference returned from `loadHiddenStatic()` so callers can mutate then save. */
let hiddenStaticMerged = parseHiddenStaticFromLocalStorage();

function loadHiddenStatic() {
  return hiddenStaticMerged;
}

function saveHiddenStatic(set) {
  hiddenStaticMerged = set instanceof Set ? set : new Set(set);
  try {
    localStorage.setItem(
      LS_HIDDEN_STATIC,
      JSON.stringify([...hiddenStaticMerged])
    );
  } catch (e) {
    console.warn("book-gallery: could not save hidden list to localStorage", e);
  }
  mirrorHiddenStaticToIdb(hiddenStaticMerged).catch((e) =>
    console.warn("book-gallery: could not mirror hidden list to IndexedDB", e)
  );
}

async function mirrorHiddenStaticToIdb(set) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({
      id: HIDDEN_META_ID,
      paths: [...set],
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

async function readHiddenStaticFromIdb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get(HIDDEN_META_ID);
    req.onsuccess = () => {
      const row = req.result;
      if (!row || !Array.isArray(row.paths)) resolve(new Set());
      else
        resolve(
          new Set(row.paths.filter((p) => typeof p === "string" && p.trim()))
        );
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * After refresh, merge IndexedDB mirror into memory + heal localStorage if LS was cleared.
 */
async function mergeHiddenStaticFromIdb() {
  let fromIdb;
  try {
    fromIdb = await readHiddenStaticFromIdb();
  } catch (e) {
    console.warn("book-gallery: read hidden mirror", e);
    return;
  }
  let changed = false;
  for (const p of fromIdb) {
    if (!hiddenStaticMerged.has(p)) {
      hiddenStaticMerged.add(p);
      changed = true;
    }
  }
  if (fromIdb.size === 0 && hiddenStaticMerged.size > 0) {
    await mirrorHiddenStaticToIdb(hiddenStaticMerged);
    return;
  }
  if (changed) {
    try {
      localStorage.setItem(
        LS_HIDDEN_STATIC,
        JSON.stringify([...hiddenStaticMerged])
      );
    } catch (e) {
      console.warn("book-gallery: heal hidden localStorage", e);
    }
  }
}

function isStaticHidden(path) {
  return loadHiddenStatic().has(path);
}

function hideStaticPath(path) {
  const s = loadHiddenStatic();
  s.add(path);
  saveHiddenStatic(s);
  const key = itemKeyStatic(path);
  const m = loadCategoryMap();
  delete m[key];
  saveCategoryMap(m);
  localStorage.removeItem(staticCaptionKey(path));
  queuePushHiddenPrefsToCloud();
}

function unhideAllStatic() {
  hiddenStaticMerged = new Set();
  localStorage.removeItem(LS_HIDDEN_STATIC);
  mirrorHiddenStaticToIdb(hiddenStaticMerged).catch((e) =>
    console.warn("book-gallery: clear hidden mirror", e)
  );
}

/** Apply server hidden list so “Remove” counts match on phone and desktop. */
function applyRemoteHiddenPaths(paths) {
  const next = new Set(paths.filter((p) => shouldCloudSyncPath(p)));
  const prev = new Set([...hiddenStaticMerged]);
  for (const p of next) {
    if (!prev.has(p)) {
      const key = itemKeyStatic(p);
      const m = loadCategoryMap();
      delete m[key];
      saveCategoryMap(m);
      localStorage.removeItem(staticCaptionKey(p));
    }
  }
  saveHiddenStatic(next);
}

async function pullAndMergeGalleryPrefsFromCloud() {
  const data = await window.LibrarySync.pullGalleryPrefs();
  if (data == null) {
    await seedHiddenPrefsToCloudIfNoRow();
    return;
  }
  const paths = Array.isArray(data.hidden_static_paths)
    ? data.hidden_static_paths
    : [];
  const local = [...loadHiddenStatic()].filter(shouldCloudSyncPath);
  // SQL bootstrap row is often `{}` — don’t treat that as “user restored everything”
  // while this browser still has local removals; seed from local instead.
  if (paths.length === 0 && local.length > 0) {
    await seedHiddenPrefsToCloudIfNoRow();
    return;
  }
  applyRemoteHiddenPaths(paths);
}

/** First device after migration: upload local hidden list so others can pull it. */
async function seedHiddenPrefsToCloudIfNoRow() {
  const local = [...loadHiddenStatic()].filter(shouldCloudSyncPath);
  if (local.length === 0) return;
  const r = await window.LibrarySync.pushGalleryPrefs(local);
  if (r?.error) throw r.error;
}

let hiddenPrefsSyncTimer = null;

function queuePushHiddenPrefsToCloud() {
  if (
    !window.LibrarySync?.pushGalleryPrefs ||
    !window.LibrarySync.isConfigured() ||
    !window.LibrarySync.hasClient()
  ) {
    return;
  }
  clearTimeout(hiddenPrefsSyncTimer);
  hiddenPrefsSyncTimer = setTimeout(() => {
    hiddenPrefsSyncTimer = null;
    const paths = [...loadHiddenStatic()].filter(shouldCloudSyncPath);
    window.LibrarySync.pushGalleryPrefs(paths).catch((e) =>
      console.warn("book-gallery: push gallery prefs", e)
    );
  }, 550);
}

async function flushHiddenPrefsToCloud() {
  if (
    !window.LibrarySync?.pushGalleryPrefs ||
    !window.LibrarySync.isConfigured() ||
    !window.LibrarySync.hasClient()
  ) {
    return;
  }
  clearTimeout(hiddenPrefsSyncTimer);
  hiddenPrefsSyncTimer = null;
  const paths = [...loadHiddenStatic()].filter(shouldCloudSyncPath);
  const r = await window.LibrarySync.pushGalleryPrefs(paths);
  if (r?.error) console.warn("book-gallery: flush gallery prefs", r.error);
}

function visibleSortedStaticPaths() {
  const hidden = loadHiddenStatic();
  return [...staticImages]
    .filter((p) => !hidden.has(p))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function loadItemOrder() {
  try {
    const raw = localStorage.getItem(LS_ITEM_ORDER);
    const a = raw ? JSON.parse(raw) : null;
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

function saveItemOrder(keys) {
  localStorage.setItem(LS_ITEM_ORDER, JSON.stringify(keys));
}

/**
 * Preserve saved sequence for keys that still exist; append any new keys in default order.
 * @param {string[]} defaultKeys
 * @param {string[] | null} savedKeys
 */
function mergeOrderKeys(defaultKeys, savedKeys) {
  const present = new Set(defaultKeys);
  const out = [];
  const used = new Set();
  if (savedKeys) {
    for (const k of savedKeys) {
      if (typeof k !== "string" || !present.has(k) || used.has(k)) continue;
      out.push(k);
      used.add(k);
    }
  }
  for (const k of defaultKeys) {
    if (!used.has(k)) {
      out.push(k);
      used.add(k);
    }
  }
  return out;
}

function buildDefaultOrderedKeys(idbRows) {
  const sortedStatic = visibleSortedStaticPaths();
  const sortedIdb = [...idbRows].sort((a, b) => {
    const c = idbOrderKey(a).localeCompare(idbOrderKey(b));
    if (c !== 0) return c;
    return b.id - a.id;
  });
  const keys = [];
  for (const path of sortedStatic) keys.push(itemKeyStatic(path));
  for (const row of sortedIdb) keys.push(itemKeyForIdbRow(row));
  return keys;
}

function buildItemsMap(idbRows) {
  const sortedStatic = visibleSortedStaticPaths();
  /** @type {Map<string, { kind: string, path?: string, row?: object, key: string }>} */
  const map = new Map();
  for (const path of sortedStatic) {
    const key = itemKeyStatic(path);
    map.set(key, { kind: "static", path, key });
  }
  for (const row of idbRows) {
    const key = itemKeyForIdbRow(row);
    map.set(key, { kind: "idb", row, key });
  }
  return map;
}

function fileNameFromPath(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function closeToolbarMenu() {
  const menu = document.getElementById("toolbar-menu");
  const btn = document.getElementById("toolbar-menu-btn");
  menu?.classList.add("hidden");
  btn?.setAttribute("aria-expanded", "false");
}

function toggleToolbarMenu() {
  const menu = document.getElementById("toolbar-menu");
  const btn = document.getElementById("toolbar-menu-btn");
  if (!menu || !btn) return;
  const willOpen = menu.classList.contains("hidden");
  if (willOpen) {
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  } else {
    closeToolbarMenu();
  }
}

function updateToolbarMenuState() {
  const item = document.getElementById("restore-hidden-item");
  if (!item) return;
  const n = loadHiddenStatic().size;
  item.disabled = n === 0;
  item.textContent =
    n > 0 ? `Restore removed photos (${n})` : "No removed photos";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
    };
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function getAllPhotos(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Place a new idb card key immediately after `afterKey` in the persisted gallery order.
 * @param {string | null} afterKey `s:…`, `u:…`, or `i:…`, or null to append
 * @param {string} newKey e.g. `i:42` (offline-only; cloud order is canonical)
 */
async function insertGalleryOrderAfterSource(afterKey, newKey) {
  const rows = await withStore("readonly", getAllPhotos);
  const defaultKeys = buildDefaultOrderedKeys(rows);
  const saved = loadItemOrder();
  let merged = mergeOrderKeys(defaultKeys, saved);
  merged = merged.filter((k) => k !== newKey);
  if (afterKey && merged.includes(afterKey)) {
    const idx = merged.indexOf(afterKey);
    merged.splice(idx + 1, 0, newKey);
  } else {
    merged.push(newKey);
  }
  saveItemOrder(merged);
}

/**
 * Maps lightbox source to Supabase columns so other browsers can run the same
 * insert-after-source ordering after pull.
 */
async function sourceMetaForLightboxKey(itemKey) {
  if (!itemKey || typeof itemKey !== "string") {
    return { source_static_path: null, source_upload_id: null };
  }
  if (itemKey.startsWith("s:")) {
    return { source_static_path: itemKey.slice(2), source_upload_id: null };
  }
  if (itemKey.startsWith("u:")) {
    const rid = itemKey.slice(2).trim();
    if (rid) {
      return { source_static_path: null, source_upload_id: rid };
    }
  }
  if (itemKey.startsWith("i:")) {
    const id = Number(itemKey.slice(2));
    if (!Number.isFinite(id)) {
      return { source_static_path: null, source_upload_id: null };
    }
    const row = await withStore("readonly", (s) => getPhotoById(s, id));
    if (row?.remoteId) {
      return { source_static_path: null, source_upload_id: row.remoteId };
    }
  }
  return { source_static_path: null, source_upload_id: null };
}

function updateCaption(store, id, caption) {
  return new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) {
        reject(new Error("Not found"));
        return;
      }
      row.caption = caption;
      const putReq = store.put(row);
      putReq.onsuccess = () => {
        syncIdbUploadToCloudIfNeeded(id).catch(console.error);
        resolve();
      };
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function updateIdbUploadFields(store, id, fields, opts = {}) {
  return new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) {
        reject(new Error("Not found"));
        return;
      }
      if ("caption" in fields) row.caption = fields.caption;
      if ("category" in fields) row.category = fields.category;
      if ("remoteUpdatedAt" in fields && fields.remoteUpdatedAt != null) {
        row.remoteUpdatedAt = String(fields.remoteUpdatedAt);
      }
      const putReq = store.put(row);
      putReq.onsuccess = () => {
        if (!opts.skipRemote) {
          syncIdbUploadToCloudIfNeeded(id).catch(console.error);
        }
        resolve();
      };
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function deletePhoto(store, id) {
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {Blob} blob
 * @param {string} [caption]
 * @param {Record<string, unknown>} [extra] e.g. `{ remoteId, category }` for cloud sync
 * @returns {Promise<number>} new row id
 */
function addPhotoFromBlob(blob, caption = "", extra = {}) {
  const row = { blob, caption: caption ?? "", ...extra };
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const st = tx.objectStore(STORE);
        const req = st.add(row);
        let newId;
        req.onsuccess = () => {
          newId = req.result;
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(newId);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      })
  );
}

async function syncNewLocalUploadToCloud(localId, remoteId) {
  if (!window.LibrarySync?.isConfigured?.() || !remoteId) return;
  const row = await withStore("readonly", (s) => getPhotoById(s, localId));
  if (!row?.blob) throw new Error("Cropped photo missing from browser storage");
  const path = `${remoteId}.jpg`;
  const up = await window.LibrarySync.uploadImageBlob(path, row.blob);
  if (up?.error) throw up.error;
  const rec = await window.LibrarySync.upsertUploadRecord({
    id: remoteId,
    caption: row.caption ?? "",
    category: typeof row.category === "string" ? row.category : "",
    storage_path: path,
    source_static_path: row.source_static_path ?? null,
    source_upload_id: row.source_upload_id ?? null,
  });
  if (rec?.error) {
    throw rec.error;
  }
}

async function syncIdbUploadToCloudIfNeeded(localId) {
  if (!window.LibrarySync?.isConfigured?.()) return;
  const row = await withStore("readonly", (s) => getPhotoById(s, localId));
  if (!row?.remoteId) return;
  const path =
    typeof row.storage_path === "string" && row.storage_path
      ? row.storage_path
      : `${row.remoteId}.jpg`;
  const rec = await window.LibrarySync.upsertUploadRecord({
    id: row.remoteId,
    caption: row.caption ?? "",
    category: typeof row.category === "string" ? row.category : "",
    storage_path: path,
    source_static_path: row.source_static_path ?? null,
    source_upload_id: row.source_upload_id ?? null,
  });
  if (rec?.error) console.error("syncIdbUploadToCloudIfNeeded", rec.error);
}

function getPhotoById(store, id) {
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function mergeRemoteUploadRows(remoteList) {
  if (!remoteList?.length || !window.LibrarySync?.isConfigured?.()) return;
  const localRows = await withStore("readonly", getAllPhotos);
  const byRemote = new Map(
    localRows
      .filter((r) => r.remoteId)
      .map((r) => [
        String(r.remoteId),
        {
          id: r.id,
          remoteId: r.remoteId,
          caption: r.caption,
          category: typeof r.category === "string" ? r.category : "",
        },
      ])
  );
  for (const u of remoteList) {
    const rid = u.id;
    if (!rid) continue;
    const existing = byRemote.get(String(rid));
    const cat = u.category != null ? String(u.category).trim() : "";
    const cap = u.caption != null ? String(u.caption) : "";
    if (existing) {
      const fullRow = await withStore("readonly", (s) =>
        getPhotoById(s, existing.id)
      );
      const prevCap = fullRow?.caption ?? "";
      const prevCat =
        typeof fullRow?.category === "string" ? fullRow.category : "";
      const prevTs = fullRow?.remoteUpdatedAt ?? "";
      const remoteTs =
        u.updated_at != null && u.updated_at !== ""
          ? String(u.updated_at)
          : "";
      if (
        prevCap !== cap ||
        prevCat !== cat ||
        (remoteTs && remoteTs !== prevTs)
      ) {
        await withStore("readwrite", (s) =>
          updateIdbUploadFields(
            s,
            existing.id,
            {
              caption: cap,
              category: cat,
              ...(remoteTs ? { remoteUpdatedAt: remoteTs } : {}),
            },
            { skipRemote: true }
          )
        );
      }
    } else {
      const storagePath =
        u.storage_path && typeof u.storage_path === "string"
          ? u.storage_path
          : `${rid}.jpg`;
      const url = window.LibrarySync.getPublicUrlForUpload(storagePath);
      if (!url) continue;
      let blob;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        blob = await res.blob();
      } catch (e) {
        console.warn("mergeRemoteUploadRows fetch", e);
        continue;
      }
      const newId = await addPhotoFromBlob(blob, cap, {
        remoteId: rid,
        category: cat,
        storage_path: storagePath,
        source_static_path: u.source_static_path ?? null,
        source_upload_id: u.source_upload_id ?? null,
        remoteUpdatedAt:
          u.updated_at != null && u.updated_at !== ""
            ? String(u.updated_at)
            : new Date().toISOString(),
      });
      byRemote.set(String(rid), {
        id: newId,
        remoteId: rid,
        caption: cap,
        category: cat,
      });
    }
  }
}

/**
 * Intersect two DOM rects (viewport space).
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null}
 */
function intersectClientRects(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Load pixels in a form that won’t taint the canvas (avoids SecurityError on toBlob).
 * Falls back to using the lightbox <img> if fetch isn’t possible (e.g. some file:// cases).
 * @returns {Promise<{ draw: HTMLImageElement | ImageBitmap, w: number, h: number, close?: () => void }>}
 */
async function getCroppedDrawableSource() {
  const nw0 = lightboxImg.naturalWidth;
  const nh0 = lightboxImg.naturalHeight;
  const srcUrl = lightboxImg.currentSrc || lightboxImg.src;
  if (!nw0 || !nh0 || !srcUrl) {
    return { draw: lightboxImg, w: nw0, h: nh0 };
  }
  try {
    const abs = new URL(srcUrl, document.baseURI).href;
    const res = await fetch(abs, { mode: "cors", credentials: "omit" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      return {
        draw: bitmap,
        w: bitmap.width,
        h: bitmap.height,
        close: () => bitmap.close(),
      };
    }
    return await new Promise((resolve, reject) => {
      const objUrl = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(objUrl);
        resolve({
          draw: im,
          w: im.naturalWidth,
          h: im.naturalHeight,
          close: () => {},
        });
      };
      im.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("Could not decode image"));
      };
      im.src = objUrl;
    });
  } catch (e) {
    console.warn("crop: using <img> fallback (fetch failed)", e);
    return { draw: lightboxImg, w: nw0, h: nh0, close: () => {} };
  }
}

/**
 * Map the visible lightbox stage (viewport) onto full-resolution image pixels and rasterize.
 * @returns {Promise<Blob | null>}
 */
async function cropVisibleLightboxToBlob() {
  const nw0 = lightboxImg.naturalWidth;
  const nh0 = lightboxImg.naturalHeight;
  if (!nw0 || !nh0) return null;

  const stageRect = lightboxStage.getBoundingClientRect();
  const imgRect = lightboxImg.getBoundingClientRect();
  const clip = intersectClientRects(stageRect, imgRect);
  if (!clip || clip.width < 2 || clip.height < 2) return null;

  const u0 = (clip.left - imgRect.left) / imgRect.width;
  const u1 = (clip.right - imgRect.left) / imgRect.width;
  const v0 = (clip.top - imgRect.top) / imgRect.height;
  const v1 = (clip.bottom - imgRect.top) / imgRect.height;

  let source;
  try {
    source = await getCroppedDrawableSource();
  } catch (e) {
    console.error(e);
    return null;
  }

  const nw = source.w;
  const nh = source.h;
  let srcX = u0 * nw;
  let srcY = v0 * nh;
  let srcW = (u1 - u0) * nw;
  let srcH = (v1 - v0) * nh;

  srcX = Math.max(0, Math.min(nw - 1, srcX));
  srcY = Math.max(0, Math.min(nh - 1, srcY));
  srcW = Math.max(1, Math.min(nw - srcX, srcW));
  srcH = Math.max(1, Math.min(nh - srcY, srcH));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW));
  canvas.height = Math.max(1, Math.round(srcH));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    source.close?.();
    return null;
  }
  try {
    ctx.drawImage(
      source.draw,
      srcX,
      srcY,
      srcW,
      srcH,
      0,
      0,
      canvas.width,
      canvas.height
    );
  } catch (e) {
    console.error(e);
    source.close?.();
    return null;
  }
  source.close?.();

  try {
    return await new Promise((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.92
      );
    });
  } catch (e) {
    console.error(e);
    return null;
  }
}

const blobUrlCache = new Map();

function revokeBlobUrl(id) {
  const url = blobUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrlCache.delete(id);
  }
}

function getBlobUrl(id, blob) {
  revokeBlobUrl(id);
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(id, url);
  return url;
}

function buildInquirySelectRow(itemKey, displayIndex, kind, labelText, extra) {
  const row = document.createElement("div");
  row.className = "card-inquiry-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "card-inquiry-cb";
  cb.checked = inquirySelectedKeys.has(itemKey);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) {
      inquirySelectedKeys.add(itemKey);
      inquirySnapshots.set(itemKey, {
        item_key: itemKey,
        display_index: displayIndex,
        kind,
        label: (labelText || "").slice(0, 800),
        image_path: extra.image_path ?? null,
        upload_id: extra.upload_id ?? null,
      });
    } else {
      inquirySelectedKeys.delete(itemKey);
      inquirySnapshots.delete(itemKey);
    }
    syncInquiryStickyBar();
  });
  const lab = document.createElement("label");
  lab.className = "card-inquiry-label";
  lab.appendChild(cb);
  const span = document.createElement("span");
  span.textContent = "Request";
  lab.appendChild(span);
  row.appendChild(lab);
  return row;
}

function syncInquiryStickyBar() {
  const el = document.getElementById("inquiry-sticky");
  if (!el) return;
  const n = inquirySelectedKeys.size;
  const configured = !!window.LibrarySync?.isConfigured?.();
  el.hidden = n === 0 || !configured;
  const c = el.querySelector(".inquiry-sticky-count");
  if (c) c.textContent = String(n);
}

function openInquiryModal() {
  if (inquirySnapshots.size === 0) return;
  const modal = document.getElementById("inquiry-modal");
  const form = document.getElementById("inquiry-form");
  const err = document.getElementById("inquiry-form-error");
  const summary = document.getElementById("inquiry-modal-summary");
  const submitBtn = document.getElementById("inquiry-submit-btn");
  if (!modal || !form || !summary) return;
  err?.classList.add("hidden");
  const configured = !!window.LibrarySync?.isConfigured?.();
  if (submitBtn) submitBtn.disabled = !configured;
  const n = inquirySnapshots.size;
  summary.textContent =
    n === 1 ? "1 image selected." : `${n} images selected.`;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeInquiryModal() {
  const modal = document.getElementById("inquiry-modal");
  if (!modal) return;
  modal.hidden = true;
  const successOpen = (() => {
    const s = document.getElementById("inquiry-success-modal");
    return s && !s.hidden;
  })();
  if (!successOpen) document.body.style.overflow = "";
}

function openInquirySuccessModal() {
  const modal = document.getElementById("inquiry-success-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  document.getElementById("inquiry-success-ok")?.focus();
}

function closeInquirySuccessModal() {
  const modal = document.getElementById("inquiry-success-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function matchesActiveFilter(catList) {
  const list = Array.isArray(catList) ? catList : [];
  if (activeFilter.type === "all") return true;
  if (activeFilter.type === "uncategorized") return list.length === 0;
  if (activeFilter.type === "category") return list.includes(activeFilter.name);
  return true;
}

function filtersEqual(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "category" && b.type === "category") return a.name === b.name;
  return true;
}

function filterIsActive(filter) {
  return filtersEqual(activeFilter, filter);
}

function wireLightbox(thumbWrap, getSrc, getAlt, itemKey) {
  const openLightbox = () => {
    lightboxSourceItemKey = itemKey;
    lightboxImg.src = getSrc();
    lightboxImg.alt = getAlt();
    resetLightboxZoom();
    lightbox.hidden = false;
    applyBodyScrollLock();
    lightboxClose.focus();
  };
  thumbWrap.addEventListener("click", (e) => {
    e.preventDefault();
    openLightbox();
  });
  thumbWrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openLightbox();
    }
  });
}

async function afterCategoryMutation() {
  const rows = await withStore("readonly", getAllPhotos);
  lastItems = buildItems(rows);
  syncCategoryDatalist();
  toolbar.classList.toggle("hidden", lastItems.length === 0);
  if (lastItems.length > 0) {
    renderFilterChips(lastItems);
  } else {
    filterChips.innerHTML = "";
    setToolbarTotalCount(0);
  }
  applyFilterVisibility();
}

function buildCategoryFieldMultiStatic(itemKey) {
  const wrap = document.createElement("div");
  wrap.className = "card-category-wrap";

  const lab = document.createElement("span");
  lab.className = "card-field-label";
  lab.textContent = "Categories";

  const chipsContainer = document.createElement("div");
  chipsContainer.className = "card-category-chips";

  const addRow = document.createElement("div");
  addRow.className = "card-category-add-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "card-category";
  input.setAttribute("list", CATEGORY_DATALIST_ID);
  input.setAttribute("aria-label", "Add a category");
  input.placeholder = "Add category, press Enter or Add";
  input.autocomplete = "off";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "category-add-btn";
  addBtn.textContent = "Add";

  let categories = [...getCategoryListForKey(itemKey)];

  function persist() {
    setCategoriesForKey(itemKey, categories, {});
    afterCategoryMutation().catch(console.error);
  }

  function renderChips() {
    chipsContainer.replaceChildren();
    for (const name of categories) {
      const chipEl = document.createElement("span");
      chipEl.className = "category-chip";
      const label = document.createElement("span");
      label.textContent = name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "category-chip-remove";
      rm.innerHTML = "&times;";
      rm.setAttribute("aria-label", `Remove category ${name}`);
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        categories = categories.filter((c) => c !== name);
        renderChips();
        persist();
      });
      chipEl.appendChild(label);
      chipEl.appendChild(rm);
      chipsContainer.appendChild(chipEl);
    }
  }

  function addFromInput() {
    const v = input.value.trim();
    if (!v) return;
    if (!categories.some((c) => c.toLowerCase() === v.toLowerCase())) {
      categories.push(v);
      renderChips();
      persist();
    }
    input.value = "";
    addBtn.classList.remove("category-add-btn-typing");
  }

  function syncAddBtnTypingHighlight() {
    addBtn.classList.toggle(
      "category-add-btn-typing",
      input.value.trim().length > 0
    );
  }

  input.addEventListener("input", syncAddBtnTypingHighlight);
  input.addEventListener("focus", syncAddBtnTypingHighlight);
  input.addEventListener("blur", () =>
    addBtn.classList.remove("category-add-btn-typing")
  );

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    addFromInput();
  });

  renderChips();
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  wrap.appendChild(lab);
  wrap.appendChild(chipsContainer);
  wrap.appendChild(addRow);
  return wrap;
}

function buildCategoryFieldMultiIdb(row) {
  const key = itemKeyForIdbRow(row);
  const wrap = document.createElement("div");
  wrap.className = "card-category-wrap";

  const lab = document.createElement("span");
  lab.className = "card-field-label";
  lab.textContent = "Categories";

  const chipsContainer = document.createElement("div");
  chipsContainer.className = "card-category-chips";

  const addRow = document.createElement("div");
  addRow.className = "card-category-add-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "card-category";
  input.setAttribute("list", CATEGORY_DATALIST_ID);
  input.setAttribute("aria-label", "Add a category");
  input.placeholder = "Add category, press Enter or Add";
  input.autocomplete = "off";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "category-add-btn";
  addBtn.textContent = "Add";

  const rawInitial =
    (typeof row.category === "string" && row.category.trim()
      ? row.category
      : getCategoryForKey(key)) || "";
  let categories = [...parseCategoriesFromStorage(rawInitial)];

  function persistIdb() {
    const storage = serializeCategoriesToStorage(categories);
    withStore("readwrite", (s) =>
      updateIdbUploadFields(s, row.id, { category: storage })
    )
      .then(() => afterCategoryMutation().catch(console.error))
      .catch(console.error);
  }

  function renderChips() {
    chipsContainer.replaceChildren();
    for (const name of categories) {
      const chipEl = document.createElement("span");
      chipEl.className = "category-chip";
      const label = document.createElement("span");
      label.textContent = name;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "category-chip-remove";
      rm.innerHTML = "&times;";
      rm.setAttribute("aria-label", `Remove category ${name}`);
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        categories = categories.filter((c) => c !== name);
        renderChips();
        persistIdb();
      });
      chipEl.appendChild(label);
      chipEl.appendChild(rm);
      chipsContainer.appendChild(chipEl);
    }
  }

  function addFromInput() {
    const v = input.value.trim();
    if (!v) return;
    if (!categories.some((c) => c.toLowerCase() === v.toLowerCase())) {
      categories.push(v);
      renderChips();
      persistIdb();
    }
    input.value = "";
    addBtn.classList.remove("category-add-btn-typing");
  }

  function syncAddBtnTypingHighlight() {
    addBtn.classList.toggle(
      "category-add-btn-typing",
      input.value.trim().length > 0
    );
  }

  input.addEventListener("input", syncAddBtnTypingHighlight);
  input.addEventListener("focus", syncAddBtnTypingHighlight);
  input.addEventListener("blur", () =>
    addBtn.classList.remove("category-add-btn-typing")
  );

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    addFromInput();
  });

  renderChips();
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  wrap.appendChild(lab);
  wrap.appendChild(chipsContainer);
  wrap.appendChild(addRow);
  return wrap;
}

function setToolbarTotalCount(n) {
  const el = document.getElementById("toolbar-total");
  if (!el) return;
  if (n === 0) {
    el.textContent = "0 photos total";
    return;
  }
  el.textContent = n === 1 ? "1 photo total" : `${n} photos total`;
}

const FILTER_SELECT_UNC = "uncategorized";
const FILTER_SELECT_CAT_PREFIX = "c:";

function renderFilterChips(items) {
  setToolbarTotalCount(items.length);
  filterChips.innerHTML = "";
  const total = items.length;
  const uncCount = items.filter((i) => categoryListForItem(i).length === 0).length;
  const catNames = [
    ...new Set(items.flatMap((i) => categoryListForItem(i))),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  if (
    activeFilter.type === "category" &&
    !catNames.includes(activeFilter.name)
  ) {
    activeFilter = { type: "all" };
  }

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "filter-chip filter-chip-all";
  allBtn.setAttribute("aria-pressed", filterIsActive({ type: "all" }) ? "true" : "false");
  allBtn.textContent = total === 1 ? `All (1)` : `All (${total})`;
  if (filterIsActive({ type: "all" })) allBtn.classList.add("is-active");
  allBtn.addEventListener("click", () => {
    activeFilter = { type: "all" };
    renderFilterChips(lastItems);
    applyFilterVisibility();
  });
  filterChips.appendChild(allBtn);

  const sel = document.createElement("select");
  sel.className = "filter-category-select";
  sel.setAttribute("aria-label", "Narrow by category");

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Categories…";
  sel.appendChild(placeholder);

  const optUnc = document.createElement("option");
  optUnc.value = FILTER_SELECT_UNC;
  optUnc.textContent =
    uncCount === 1
      ? "Uncategorized (1)"
      : `Uncategorized (${uncCount})`;
  sel.appendChild(optUnc);

  for (const name of catNames) {
    const count = items.filter((i) => categoryListForItem(i).includes(name)).length;
    const opt = document.createElement("option");
    opt.value = `${FILTER_SELECT_CAT_PREFIX}${encodeURIComponent(name)}`;
    opt.textContent = `${name} (${count})`;
    sel.appendChild(opt);
  }

  if (activeFilter.type === "all") {
    sel.value = "";
  } else if (activeFilter.type === "uncategorized") {
    sel.value = FILTER_SELECT_UNC;
  } else {
    sel.value = `${FILTER_SELECT_CAT_PREFIX}${encodeURIComponent(activeFilter.name)}`;
  }

  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v === "") {
      activeFilter = { type: "all" };
    } else if (v === FILTER_SELECT_UNC) {
      activeFilter = { type: "uncategorized" };
    } else if (v.startsWith(FILTER_SELECT_CAT_PREFIX)) {
      try {
        const name = decodeURIComponent(v.slice(FILTER_SELECT_CAT_PREFIX.length));
        activeFilter = { type: "category", name };
      } catch {
        activeFilter = { type: "all" };
      }
    }
    renderFilterChips(lastItems);
    applyFilterVisibility();
  });

  filterChips.appendChild(sel);
}

function renderStaticCard(path, displayIndex) {
  const key = itemKeyStatic(path);
  const li = document.createElement("li");
  li.className = "card";
  li.dataset.itemKey = key;
  li.dataset.staticPath = path;

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "card-thumb-wrap";
  thumbWrap.tabIndex = 0;
  thumbWrap.setAttribute("role", "button");
  thumbWrap.setAttribute("aria-label", "Open full size");

  const img = document.createElement("img");
  img.className = "card-thumb";
  const thumb = thumbnailSourcesForStaticPath(path);
  img.src = thumb.src;
  if (thumb.srcset) {
    img.srcset = thumb.srcset;
    img.sizes = thumb.sizes;
  }
  const cap = getStaticCaption(path);
  img.alt = cap.trim() ? cap.trim() : "Book photo";
  img.loading = "lazy";
  img.decoding = "async";

  thumbWrap.appendChild(img);

  const body = document.createElement("div");
  body.className = "card-body";

  const meta = document.createElement("p");
  meta.className = "card-meta";
  const metaStrong = document.createElement("strong");
  metaStrong.textContent = `#${displayIndex}`;
  meta.appendChild(metaStrong);
  body.appendChild(meta);

  if (window.LibrarySync?.isConfigured?.()) {
    body.appendChild(
      buildInquirySelectRow(key, displayIndex, "static", cap.trim() || `Book #${displayIndex}`, {
        image_path: path,
        upload_id: null,
      })
    );
  }

  body.appendChild(buildCategoryFieldMultiStatic(key));

  const ta = document.createElement("textarea");
  ta.className = "card-caption";
  ta.placeholder = "Title, author, notes…";
  ta.value = cap;
  ta.rows = 3;

  let saveTimer;
  const persist = () => setStaticCaption(path, ta.value);
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };

  ta.addEventListener("input", () => {
    img.alt = ta.value.trim() ? ta.value.trim() : "Book photo";
    scheduleSave();
  });
  ta.addEventListener("blur", () => {
    clearTimeout(saveTimer);
    persist();
  });

  body.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-btn";
  remove.textContent = "Remove from gallery";
  remove.addEventListener("click", () => {
    const fn = fileNameFromPath(path);
    if (
      !confirm(
        `Remove “${fn}” from this gallery? The file stays on disk; restore it from the toolbar menu.`
      )
    ) {
      return;
    }
    hideStaticPath(path);
    refresh().catch(console.error);
  });
  actions.appendChild(remove);
  body.appendChild(actions);

  wireLightbox(thumbWrap, () => path, () => img.alt, key);

  li.appendChild(thumbWrap);
  li.appendChild(body);
  gallery.appendChild(li);
}

function renderIdbCard(row, displayIndex) {
  const key = itemKeyForIdbRow(row);
  const li = document.createElement("li");
  li.className = "card";
  li.dataset.itemKey = key;
  li.dataset.id = String(row.id);

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "card-thumb-wrap";
  thumbWrap.tabIndex = 0;
  thumbWrap.setAttribute("role", "button");
  thumbWrap.setAttribute("aria-label", "Open full size");

  const img = document.createElement("img");
  img.className = "card-thumb";
  const url = getBlobUrl(row.id, row.blob);
  img.src = url;
  img.alt = row.caption?.trim() ? row.caption.trim() : "Book photo";

  thumbWrap.appendChild(img);

  const body = document.createElement("div");
  body.className = "card-body";

  const meta = document.createElement("p");
  meta.className = "card-meta";
  const metaStrong = document.createElement("strong");
  metaStrong.textContent = `#${displayIndex}`;
  meta.appendChild(metaStrong);
  body.appendChild(meta);

  if (window.LibrarySync?.isConfigured?.()) {
    body.appendChild(
      buildInquirySelectRow(
        key,
        displayIndex,
        "upload",
        row.caption?.trim() || `Photo #${displayIndex}`,
        {
          image_path: null,
          upload_id: row.remoteId ? String(row.remoteId) : null,
        }
      )
    );
  }

  body.appendChild(buildCategoryFieldMultiIdb(row));

  const ta = document.createElement("textarea");
  ta.className = "card-caption";
  ta.placeholder = "Title, author, notes…";
  ta.value = row.caption ?? "";
  ta.rows = 3;

  let saveTimer;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await withStore("readwrite", (s) => updateCaption(s, row.id, ta.value));
      } catch (e) {
        console.error(e);
      }
    }, 400);
  };

  ta.addEventListener("input", scheduleSave);
  ta.addEventListener("blur", () => {
    clearTimeout(saveTimer);
    withStore("readwrite", (s) => updateCaption(s, row.id, ta.value)).catch(
      console.error
    );
  });

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-btn";
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    if (!confirm("Remove this photo from the gallery?")) return;
    try {
      const remoteId = row.remoteId;
      const storagePath =
        typeof row.storage_path === "string" && row.storage_path
          ? row.storage_path
          : remoteId
            ? `${remoteId}.jpg`
            : null;
      await withStore("readwrite", (s) => deletePhoto(s, row.id));
      revokeBlobUrl(row.id);
      const m = loadCategoryMap();
      delete m[key];
      saveCategoryMap(m);
      if (
        remoteId &&
        storagePath &&
        window.LibrarySync?.isConfigured?.()
      ) {
        await window.LibrarySync.deleteUpload(remoteId, storagePath);
      }
      await refresh();
    } catch (e) {
      console.error(e);
    }
  });

  actions.appendChild(remove);
  body.appendChild(ta);
  body.appendChild(actions);

  wireLightbox(thumbWrap, () => url, () => img.alt, key);

  li.appendChild(thumbWrap);
  li.appendChild(body);
  gallery.appendChild(li);
}

function buildItems(idbRows) {
  migrateStableItemKeys(idbRows);
  const byKey = buildItemsMap(idbRows);
  const orderedKeys = window.LibrarySync?.isConfigured?.()
    ? buildCanonicalOrderedKeys(idbRows)
    : mergeOrderKeys(buildDefaultOrderedKeys(idbRows), loadItemOrder());
  /** @type {{ kind: 'static', path: string, key: string } | { kind: 'idb', row: object, key: string }} */
  const items = [];
  for (const k of orderedKeys) {
    const it = byKey.get(k);
    if (it) items.push(it);
  }
  return items;
}

function applyFilterVisibility() {
  const items = lastItems;
  const total = items.length;
  const filtered = items.filter((it) =>
    matchesActiveFilter(categoryListForItem(it))
  );
  const visibleKeys = new Set(filtered.map((it) => it.key));
  for (const li of gallery.querySelectorAll("li.card")) {
    const k = li.dataset.itemKey;
    if (k) li.hidden = !visibleKeys.has(k);
  }
  filterEmpty.classList.toggle("hidden", !(total > 0 && filtered.length === 0));
}

function renderGallery(idbRows) {
  gallery.innerHTML = "";
  const items = buildItems(idbRows);
  lastItems = items;
  syncCategoryDatalist();

  const total = items.length;
  const manifestCount = staticImages.length;
  const idbCount = idbRows.length;
  const removedCount = loadHiddenStatic().size;
  const allHidden =
    total === 0 &&
    removedCount > 0 &&
    (manifestCount > 0 || idbCount > 0);
  const noFiles = manifestCount === 0 && idbCount === 0;
  const showToolbar =
    total > 0 || removedCount > 0 || manifestCount > 0 || idbCount > 0;

  toolbar.classList.toggle("hidden", !showToolbar);

  const allHiddenEl = document.getElementById("all-hidden-state");
  if (allHiddenEl) {
    allHiddenEl.classList.toggle("hidden", !allHidden);
  }

  if (total > 0) {
    renderFilterChips(items);
  } else {
    filterChips.innerHTML = "";
    setToolbarTotalCount(0);
  }

  let displayIndex = 0;
  for (const it of items) {
    displayIndex += 1;
    if (it.kind === "static") renderStaticCard(it.path, displayIndex);
    else renderIdbCard(it.row, displayIndex);
  }

  applyFilterVisibility();
  emptyState.classList.toggle("hidden", total > 0 || !noFiles || allHidden);
  updateToolbarMenuState();
  syncInquiryStickyBar();
}

async function refresh() {
  if (window.LibrarySync?.isConfigured?.() && window.LibrarySync.hasClient()) {
    try {
      await pullAndMergeGalleryPrefsFromCloud();
    } catch (e) {
      console.warn("book-gallery: gallery prefs sync", e);
      await mergeHiddenStaticFromIdb();
    }
  } else {
    await mergeHiddenStaticFromIdb();
  }
  lastLibrarySyncError = null;
  let libraryPullOk = false;
  if (window.LibrarySync?.isConfigured?.()) {
    if (!window.LibrarySync.hasClient()) {
      lastLibrarySyncError = new Error(
        "Supabase client unavailable (blocked CDN script or offline—check devtools / network)."
      );
    } else {
      libraryPullOk = await pullLibraryFromCloud();
    }
  }
  updateSyncHint();
  const rows = await withStore("readonly", getAllPhotos);
  renderGallery(rows);

  if (
    window.LibrarySync?.isConfigured?.() &&
    window.LibrarySync.hasClient() &&
    libraryPullOk &&
    !librarySyncSubscribed
  ) {
    librarySyncSubscribed = true;
    let debounceRemote;
    window.LibrarySync.subscribe(
      () => {
        clearTimeout(debounceRemote);
        debounceRemote = setTimeout(() => {
          refresh().catch(console.error);
        }, 450);
      },
      (status) => {
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          librarySyncSubscribed = false;
        }
      }
    );
  }
}

let visibilityRefreshTimer = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !window.LibrarySync?.isConfigured?.()) return;
  clearTimeout(visibilityRefreshTimer);
  visibilityRefreshTimer = setTimeout(() => {
    refresh().catch(console.error);
  }, 600);
});

/* iOS often drops Realtime when backgrounded; periodic pull keeps mobile roughly in sync. */
setInterval(() => {
  if (document.hidden) return;
  if (
    !window.LibrarySync?.isConfigured?.() ||
    !window.LibrarySync.hasClient?.()
  ) {
    return;
  }
  refresh().catch(console.error);
}, 120_000);

function applyBodyScrollLock() {
  document.body.style.overflow = lightbox.hidden ? "" : "hidden";
}

function closeLightbox() {
  resetLightboxZoom();
  lightbox.hidden = true;
  lightboxImg.src = "";
  lightboxImg.alt = "";
  lightboxSourceItemKey = null;
  applyBodyScrollLock();
}

lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const succ = document.getElementById("inquiry-success-modal");
    if (succ && !succ.hidden) {
      closeInquirySuccessModal();
      return;
    }
    const inq = document.getElementById("inquiry-modal");
    if (inq && !inq.hidden) {
      closeInquiryModal();
      return;
    }
    if (!lightbox.hidden) closeLightbox();
    else closeToolbarMenu();
  }
});

document.getElementById("toolbar-menu-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleToolbarMenu();
});

document.querySelector(".toolbar-menu-wrap")?.addEventListener("click", (e) => {
  e.stopPropagation();
});

document.addEventListener("click", () => {
  closeToolbarMenu();
});

document
  .getElementById("restore-hidden-item")
  ?.addEventListener("click", async () => {
    const n = loadHiddenStatic().size;
    if (n === 0) return;
    if (
      !confirm(
        `Bring back all ${n} removed photo(s)? They will appear in the grid again.`
      )
    ) {
      return;
    }
    unhideAllStatic();
    closeToolbarMenu();
    await flushHiddenPrefsToCloud();
    refresh().catch(console.error);
  });

function showGalleryInitError(err) {
  console.error("book-gallery: gallery init failed", err);
  const msg = document.getElementById("empty-state");
  if (!msg) return;
  const p = msg.querySelector("p");
  if (p) {
    p.textContent =
      "The gallery could not finish loading (often a browser storage issue or blocked script). Try a hard refresh. If it keeps happening, open the developer console (F12) and check for errors.";
  }
  msg.classList.remove("hidden");
  toolbar?.classList.add("hidden");
  const allHiddenEl = document.getElementById("all-hidden-state");
  allHiddenEl?.classList.add("hidden");
  const filterEmptyEl = document.getElementById("filter-empty");
  filterEmptyEl?.classList.add("hidden");
}

document.getElementById("inquiry-open-form-btn")?.addEventListener("click", openInquiryModal);
document.getElementById("inquiry-clear-btn")?.addEventListener("click", () => {
  inquirySelectedKeys.clear();
  inquirySnapshots.clear();
  syncInquiryStickyBar();
  for (const cb of document.querySelectorAll(".card-inquiry-cb")) {
    cb.checked = false;
  }
});
document.getElementById("inquiry-modal-close")?.addEventListener("click", closeInquiryModal);
document.getElementById("inquiry-modal-backdrop")?.addEventListener("click", closeInquiryModal);
document.getElementById("inquiry-success-ok")?.addEventListener("click", closeInquirySuccessModal);
document.getElementById("inquiry-success-backdrop")?.addEventListener("click", closeInquirySuccessModal);
document.getElementById("inquiry-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  if ((fd.get("website") || "").toString().trim()) {
    closeInquiryModal();
    return;
  }
  const name = (fd.get("requester_name") || "").toString();
  const email = (fd.get("requester_email") || "").toString();
  const message = (fd.get("message") || "").toString();
  const errEl = document.getElementById("inquiry-form-error");
  const submitBtn = document.getElementById("inquiry-submit-btn");
  errEl?.classList.add("hidden");
  const books = [...inquirySnapshots.values()].sort(
    (a, b) => a.display_index - b.display_index
  );
  if (books.length === 0) {
    if (errEl) {
      errEl.textContent = "No books selected.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  if (!window.LibrarySync?.submitBookInquiry) {
    if (errEl) {
      errEl.textContent = "Sending requests is not available.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  if (submitBtn) submitBtn.disabled = true;
  try {
    await window.LibrarySync.submitBookInquiry({ name, email, message, books });
    form.reset();
    inquirySelectedKeys.clear();
    inquirySnapshots.clear();
    syncInquiryStickyBar();
    for (const cb of document.querySelectorAll(".card-inquiry-cb")) {
      cb.checked = false;
    }
    closeInquiryModal();
    if (submitBtn) submitBtn.disabled = false;
    openInquirySuccessModal();
  } catch (er) {
    console.error(er);
    if (errEl) {
      errEl.textContent =
        er instanceof Error
          ? er.message
          : "Could not send. Check your connection or try again later.";
      errEl.classList.remove("hidden");
    }
    if (submitBtn) submitBtn.disabled = false;
  }
});

refresh().catch(showGalleryInitError);
