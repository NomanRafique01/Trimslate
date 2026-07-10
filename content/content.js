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

async function handleFile(file) {
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
      const txtName = file.name.replace(/\.[^.]+$/, '.txt');
      setBarSuccess(txtName, formatStats(response.text));
      injectTextIntoInput(response.text);
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

// ── Event listeners ───────────────────────────────────────────────────────────
document.addEventListener('change', e => {
  const input = e.target;
  if (input.type !== 'file' || !input.files?.length) return;
  const file = input.files[0];
  if (!shouldIntercept(file)) return;

  e.stopPropagation();
  e.preventDefault();
  input.value = ''; // clear so claude.ai gets nothing
  handleFile(file, () => {}); // convert and inject text
}, true);

document.addEventListener('drop', async e => {
  if (!e.dataTransfer?.files?.length) return;
  const file = e.dataTransfer.files[0];
  if (!shouldIntercept(file)) return;

  e.stopPropagation();
  e.preventDefault();
  await handleFile(file);
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