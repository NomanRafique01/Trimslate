// content/content.js

const SITE_CONFIGS = {
  'claude.ai': {
    inputSelector: 'div[contenteditable="true"]',
    barAnchorSelector: 'div[contenteditable="true"]',
  }
};

const config = SITE_CONFIGS['claude.ai'];
let bar = null;

// ── Mini bar ─────────────────────────────────────────────────────────────────
function createBar() {
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'trimslate-bar';
  bar.innerHTML = `
    <svg class="ts-icon ts-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    <span class="ts-text">Converting...</span>
    <span class="ts-sub"></span>
  `;
  anchorBar();
}

function anchorBar() {
  const anchor = document.querySelector(config.barAnchorSelector);
  if (!anchor || !bar) return;
  if (bar.parentElement !== document.body) document.body.appendChild(bar);
  positionBar(anchor);
}

function positionBar(anchor) {
  if (!bar) return;
  const rect = anchor.getBoundingClientRect();
  bar.style.left = `${rect.left}px`;
  bar.style.width = `${rect.width}px`;
  bar.style.top = `${rect.top - bar.offsetHeight - 8}px`; // sits 8px above the input, never inside it
}

window.addEventListener('resize', () => {
  const anchor = bar && document.querySelector(config.barAnchorSelector);
  if (anchor) positionBar(anchor);
});
window.addEventListener('scroll', () => {
  const anchor = bar && document.querySelector(config.barAnchorSelector);
  if (anchor) positionBar(anchor);
}, true);

function setBarConverting(name) {
  if (!bar) createBar();
  bar.querySelector('.ts-text').textContent = name;
  bar.querySelector('.ts-sub').textContent = 'converting...';
}

function setBarSuccess(name, stats) {
  if (!bar) return;
  bar.innerHTML = `
    <svg class="ts-icon ts-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    <span class="ts-text">${name}</span>
    <span class="ts-sub">${stats}</span>
  `;
  setTimeout(() => {
    bar.classList.add('fade-out');
    setTimeout(() => { bar?.remove(); bar = null; }, 300);
  }, 1500);
}

function setBarNative(name, reason) {
  if (!bar) createBar();
  bar.innerHTML = `
    <svg class="ts-icon ts-native" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
    <span class="ts-text">${name}</span>
    <span class="ts-sub">complex PDF — sending file to Claude directly${reason ? ' (' + reason + ')' : ''}</span>
  `;
  setTimeout(() => {
    bar.classList.add('fade-out');
    setTimeout(() => { bar?.remove(); bar = null; }, 300);
  }, 2500);
}

function setBarError(msg) {
  if (!bar) createBar();
  bar.innerHTML = `
    <svg class="ts-icon ts-warn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span class="ts-text">${msg}</span>
    <span class="ts-sub"></span>
  `;
  setTimeout(() => { bar?.remove(); bar = null; }, 3000);
}

// ── Inject text into claude.ai input ─────────────────────────────────────────
function injectTextIntoInput(text) {
  const input = document.querySelector(config.inputSelector);
  if (!input) return;
  input.focus();
  document.execCommand('insertText', false, text);
}

// ── File interception ─────────────────────────────────────────────────────────
const SUPPORTED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain', 'text/markdown', 'text/html', 'text/xml',
  'application/json', 'application/xml'
]);
const SUPPORTED_EXT = /\.(pdf|docx|xlsx|csv|txt|md|json|html|htm|xml|pptx)$/i;
const PASSTHROUGH   = /\.(txt|md|json|csv)$/i;

function isSupported(file) {
  return SUPPORTED.has(file.type) || SUPPORTED_EXT.test(file.name);
}

// Files above this size freeze the tab (chunking + pdf.js parsing runs on main thread) —
// skip conversion entirely and let claude.ai handle the raw upload instead.
const MAX_CONVERT_SIZE = 30 * 1024 * 1024; // 30MB

function isTooHeavy(file) {
  return file.size > MAX_CONVERT_SIZE;
}

function shouldIntercept(file) {
  if (!isSupported(file)) return false;
  if (PASSTHROUGH.test(file.name)) return false;
  if (isTooHeavy(file)) return false;
  return true;
}

// 8MB raw per chunk -> ~32MB once JSON-encoded as Array.from(), safely under the 64MiB sendMessage cap
const CHUNK_BYTES = 8 * 1024 * 1024;

async function handleFile(file, originalEvent) {
  if (!isSupported(file)) return false;
  if (PASSTHROUGH.test(file.name)) return false;

  setBarConverting(file.name);

  await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });

  const fileData = await readAsArray(file);
  const bytes = new Uint8Array(fileData);
  const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));

  const port = chrome.runtime.connect({ name: 'offscreen-convert' });

  port.onMessage.addListener(response => {
    if (response.error) { setBarError(response.error); port.disconnect(); return; }
    if (response.text !== undefined) {
      const quality = response.stats?.quality;
      if (quality && quality.reliable === false) {
        // Extraction is unreliable (scanned PDF, scrambled math layout, watermark, etc.)
        // — don't inject noise into the chat, hand Claude the actual file instead.
        setBarNative(file.name, quality.reason);
        passThroughNative(originalEvent, file);
      } else {
        const txtName = file.name.replace(/\.[^.]+$/, '.txt');
        setBarSuccess(txtName, formatStats(response.text));
        injectTextIntoInput(response.text);
      }
      port.disconnect();
    }
  });

  port.postMessage({ type: 'START', fileName: file.name, fileType: file.type, totalChunks });
  for (let i = 0; i < totalChunks; i++) {
    const chunk = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    port.postMessage({ type: 'CHUNK', index: i, data: Array.from(chunk) });
  }
  port.postMessage({ type: 'END' });

  return true; // handled
}

// Give the original file back to claude.ai's own upload handling, unmodified,
// so Claude can read it natively (vision/PDF understanding) instead of us
// injecting scrambled plain text. Marks the file so our own listeners ignore
// it on the way back through.
function passThroughNative(originalEvent, file) {
  file.__trimslateBypass = true;
  if (!originalEvent) return; // nothing to redispatch onto, safest to just stop here

  const dt = new DataTransfer();
  dt.items.add(file);

  if (originalEvent.type === 'change') {
    const input = originalEvent.target;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (originalEvent.type === 'drop') {
    const target = originalEvent.target;
    const dropEvt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(dropEvt);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.addEventListener('change', e => {
  const input = e.target;
  if (input.type !== 'file' || !input.files?.length) return;
  const file = input.files[0];
  if (file.__trimslateBypass) return; // our own redispatch on the way to claude.ai natively — let it through
  if (!shouldIntercept(file)) return;

  e.stopPropagation();
  e.preventDefault();
  input.value = ''; // clear so claude.ai gets nothing (we may hand the file back later via passThroughNative)
  handleFile(file, e);
}, true);

document.addEventListener('drop', async e => {
  if (!e.dataTransfer?.files?.length) return;
  const file = e.dataTransfer.files[0];
  if (file.__trimslateBypass) return; // our own redispatch — let claude.ai's own handler take it
  if (!shouldIntercept(file)) return;

  e.stopPropagation();
  e.preventDefault();
  await handleFile(file, e);
}, true);

// ── MutationObserver ─────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  if (!bar) return;
  if (!document.contains(bar)) { anchorBar(); return; }
  const anchor = document.querySelector(config.barAnchorSelector);
  if (anchor) positionBar(anchor);
});
observer.observe(document.body, { childList: true, subtree: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function readAsArray(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

function formatStats(text) {
  const tokens = Math.round(text.length / 4);
  return `~${tokens.toLocaleString()} tokens`;
}

function getCache(k) { return null; }
function setCache(k, v) {}