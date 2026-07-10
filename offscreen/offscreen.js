// offscreen/offscreen.js

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'offscreen-convert') return;

  let meta   = null;
  let chunks = null;

  port.onMessage.addListener(msg => {
    if (msg.type === 'START') {
      meta   = { fileName: msg.fileName, fileType: msg.fileType,
                 pageFrom: msg.pageFrom, pageTo: msg.pageTo };
      chunks = new Array(msg.totalChunks);

    } else if (msg.type === 'CHUNK') {
      chunks[msg.index] = msg.data;

    } else if (msg.type === 'END') {
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const bytes    = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.length; }

      convertFile(bytes, meta.fileType, meta.fileName, meta.pageFrom, meta.pageTo)
        .then(result => port.postMessage({ text: result.text, stats: result.stats }))
        .catch(err   => port.postMessage({ error: err.message }));
    }
  });
});

// ── Router ────────────────────────────────────────────────────────────────────
async function convertFile(fileData, fileType, fileName, pageFrom, pageTo) {
  const buffer = new Uint8Array(fileData).buffer;

  if (fileType === 'application/pdf' || fileName.endsWith('.pdf'))
    return extractPDF(buffer, pageFrom, pageTo);

  if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || fileName.endsWith('.docx'))
    return extractDOCX(buffer);

  if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || fileName.endsWith('.xlsx'))
    return extractXLSX(buffer);

  if (fileName.endsWith('.pptx'))
    return extractPPTX(buffer);

  if (fileType === 'text/csv' || fileName.endsWith('.csv')) {
    const text = new TextDecoder().decode(buffer);
    return { text, stats: tokenStats(text, 0) };
  }

  if (['text/plain','text/markdown','application/json','text/html','text/xml','application/xml']
        .includes(fileType)
      || /\.(txt|md|json|html|htm|xml)$/.test(fileName)) {
    const raw = new TextDecoder().decode(buffer);
    const text = (fileType === 'text/html' || /\.html?$/.test(fileName))
      ? stripTags(raw) : raw;
    return { text, stats: tokenStats(text, 0) };
  }

  throw new Error('Unsupported format');
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function extractPDF(buffer, pageFrom, pageTo) {
  const pdf   = await pdfjsLib.getDocument({ data: buffer }).promise;
  const total = pdf.numPages;
  const start = Math.max(1, pageFrom || 1);
  const end   = Math.min(total, pageTo  || total);

  const pages = await Promise.all(
    Array.from({ length: end - start + 1 }, (_, i) => extractPage(pdf, start + i))
  );

  const raw    = pages.join('\n\n');
  const text   = stripHeadersFooters(raw, pages);
  const stripped = raw.length - text.length;
  return { text, stats: tokenStats(text, stripped) };
}

async function extractPage(pdf, num) {
  const page    = await pdf.getPage(num);
  const content = await page.getTextContent();
  return content.items.map(i => i.str).join(' ').trim();
}

// ── Header/footer stripping ───────────────────────────────────────────────────
function stripHeadersFooters(full, pages) {
  if (pages.length < 3) return full;
  const firstLines = pages.map(p => p.split('\n')[0]?.trim()).filter(Boolean);
  const lastLines  = pages.map(p => p.split('\n').at(-1)?.trim()).filter(Boolean);

  const repeatedHeader = findRepeated(firstLines, pages.length);
  const repeatedFooter = findRepeated(lastLines,  pages.length);

  let result = full;
  if (repeatedHeader) result = result.split(repeatedHeader).join('');
  if (repeatedFooter) result = result.split(repeatedFooter).join('');
  return result.trim();
}

function findRepeated(lines, total) {
  const counts = {};
  for (const l of lines) counts[l] = (counts[l] || 0) + 1;
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top && top[1] >= total * 0.6 ? top[0] : null;
}

// ── DOCX ──────────────────────────────────────────────────────────────────────
async function extractDOCX(buffer) {
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  const text   = result.value;
  return { text, stats: tokenStats(text, 0) };
}

// ── XLSX ──────────────────────────────────────────────────────────────────────
function extractXLSX(buffer) {
  const wb   = XLSX.read(buffer, { type: 'array' });
  const text = wb.SheetNames
    .map(name => `[${name}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]))
    .join('\n\n');
  return { text, stats: tokenStats(text, 0) };
}

// ── PPTX ──────────────────────────────────────────────────────────────────────
// Uses XLSX (SheetJS) which bundles its own ZIP reader — no JSZip needed.
async function extractPPTX(buffer) {
  let zip;
  try {
    zip = XLSX.CFB.read(new Uint8Array(buffer), { type: 'array' });
  } catch (e) {
    // CFB read failed — fall back to raw XML scan
    return extractPPTXFallback(buffer);
  }

  // SheetJS CFB stores paths like 'ppt/slides/slide1.xml'
  const slideEntries = zip.FileIndex
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/slide(\d+)/i)?.[1] || 0);
      const nb = parseInt(b.name.match(/slide(\d+)/i)?.[1] || 0);
      return na - nb;
    });

  if (!slideEntries.length) return extractPPTXFallback(buffer);

  const texts = slideEntries.map((entry, i) => {
    const xml     = new TextDecoder().decode(new Uint8Array(entry.content));
    const matches = [...xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g)].map(m =>
      m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    );
    return `[Slide ${i + 1}]\n${matches.join(' ')}`;
  });

  const text = texts.join('\n\n');
  return { text, stats: tokenStats(text, 0) };
}

// Fallback: treat buffer as text and regex-scan for <a:t> tags across the whole blob
function extractPPTXFallback(buffer) {
  const raw     = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer));
  const matches = [...raw.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g)].map(m => m[1]);
  const text    = matches.join(' ');
  return { text, stats: tokenStats(text, 0) };
}

// ── HTML tag stripper ─────────────────────────────────────────────────────────
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Stats helper ──────────────────────────────────────────────────────────────
function tokenStats(text, strippedChars) {
  return {
    chars:    text.length,
    stripped: strippedChars,
    tokens:   Math.round(text.length / 4),
  };
}