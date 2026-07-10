// popup/popup.js

const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const convertingRow = document.getElementById('converting-row');
const convertingName= document.getElementById('converting-name');
const doneRow       = document.getElementById('done-row');
const doneName      = document.getElementById('done-name');
const pageRange     = document.getElementById('page-range');
const statsRow      = document.getElementById('stats-row');
const downloadBtn   = document.getElementById('download-btn');
const pageFrom      = document.getElementById('page-from');
const pageTo        = document.getElementById('page-to');

let lastResult = null; // { text, fileName }

// ── Drop zone wiring ──────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.querySelector('.link').addEventListener('click', e => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

// Re-convert when page range changes
pageFrom.addEventListener('change', () => lastResult && reConvert());
pageTo.addEventListener('change',   () => lastResult && reConvert());

// ── File handler ──────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file || file.type !== 'application/pdf') return;

  dropZone.classList.add('hidden');
  doneRow.classList.add('hidden');
  pageRange.classList.add('hidden');
  statsRow.classList.add('hidden');
  downloadBtn.classList.add('hidden');

  convertingName.textContent = file.name;
  convertingRow.classList.remove('hidden');

  lastResult = { file, fileName: file.name };

  await convertAndShow(file, null, null);
}

async function reConvert() {
  if (!lastResult?.file) return;
  const from = parseInt(pageFrom.value) || 1;
  const to   = parseInt(pageTo.value)   || null;
  convertingName.textContent = lastResult.fileName;
  convertingRow.classList.remove('hidden');
  doneRow.classList.add('hidden');
  statsRow.classList.add('hidden');
  downloadBtn.classList.add('hidden');
  await convertAndShow(lastResult.file, from, to);
}

async function convertAndShow(file, pageFromVal, pageToVal) {
  try {
    const result = await sendToOffscreen(file, pageFromVal, pageToVal);

    lastResult.text = result.text;
    const txtName   = file.name.replace(/\.[^.]+$/, '.txt');
    lastResult.txtName = txtName;

    convertingRow.classList.add('hidden');

    doneName.textContent = txtName;
    doneRow.classList.remove('hidden');

    // Stats
    const { chars, stripped, tokens } = result.stats;
    document.getElementById('stat-chars').textContent =
      `~${chars.toLocaleString()} chars extracted`;
    document.getElementById('stat-stripped').textContent =
      stripped > 0
        ? `~${stripped.toLocaleString()} chars stripped (headers/footers)`
        : 'No repeated headers/footers found';
    document.getElementById('stat-tokens').textContent =
      `~${tokens.toLocaleString()} tokens estimated`;

    statsRow.classList.remove('hidden');

    // Show page range only for PDFs after first conversion
    if (file.type === 'application/pdf') {
      pageRange.classList.remove('hidden');
    }

    downloadBtn.classList.remove('hidden');

  } catch (err) {
    convertingRow.classList.add('hidden');
    showError(err.message || 'Conversion failed');
  }
}

// ── Offscreen bridge ──────────────────────────────────────────────────────────
async function sendToOffscreen(file, pageFromVal, pageToVal) {
  // Ensure offscreen document exists
  await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });

  const CHUNK_BYTES = 8 * 1024 * 1024;
  const fileData    = await readAsArrayBuffer(file);
  const bytes       = new Uint8Array(fileData);
  const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));

  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'offscreen-convert' });

    port.onMessage.addListener(response => {
      port.disconnect();
      if (response.error) reject(new Error(response.error));
      else resolve({ text: response.text, stats: response.stats });
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      }
    });

    port.postMessage({
      type: 'START',
      fileName:    file.name,
      fileType:    file.type,
      totalChunks,
      pageFrom:    pageFromVal || null,
      pageTo:      pageToVal   || null,
    });

    for (let i = 0; i < totalChunks; i++) {
      const chunk = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      port.postMessage({ type: 'CHUNK', index: i, data: Array.from(chunk) });
    }

    port.postMessage({ type: 'END' });
  });
}

// ── Download ──────────────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  if (!lastResult?.text) return;
  const blob = new Blob([lastResult.text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = lastResult.txtName || 'output.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Error state ───────────────────────────────────────────────────────────────
function showError(msg) {
  dropZone.classList.remove('hidden');
  // Briefly flash the drop zone border red
  dropZone.style.borderColor = '#c0392b';
  const label = dropZone.querySelector('.drop-label');
  const orig  = label.textContent;
  label.textContent = `Error: ${msg}`;
  setTimeout(() => {
    dropZone.style.borderColor = '';
    label.innerHTML = 'Drop a PDF or <span class="link">choose file</span>';
    dropZone.querySelector('.link').addEventListener('click', e => {
      e.stopPropagation(); fileInput.click();
    });
  }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}