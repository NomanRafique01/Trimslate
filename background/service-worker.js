// background/service-worker.js

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Run file conversion libraries off the main thread'
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ENSURE_OFFSCREEN') {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async
  }
});