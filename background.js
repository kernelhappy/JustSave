import { jpegToPdf } from './pdf.js';

// Scroll through once so lazy-loaded images/content render, then return to the top.
// ponytail: capped at 100 screens so infinite-scroll pages terminate.
const SCROLL_THROUGH = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && scrollY + innerHeight < document.documentElement.scrollHeight; i++) {
    scrollBy(0, innerHeight);
    await wait(150);
  }
  scrollTo(0, 0);
  await wait(300);
})()`;

chrome.action.onClicked.addListener(async (tab) => {
  const target = { tabId: tab.id };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  chrome.action.setBadgeText({ tabId: tab.id, text: '...' });
  try {
    await chrome.debugger.attach(target, '1.3');
    try {
      await send('Runtime.evaluate', { expression: SCROLL_THROUGH, awaitPromise: true });
      const { cssContentSize: { width, height } } = await send('Page.getLayoutMetrics');
      const shot = format => send('Page.captureScreenshot', {
        format, quality: format === 'jpeg' ? 95 : undefined,
        captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const png = await shot('png');
      const jpg = await shot('jpeg');

      const name = (tab.title || '').replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').slice(0, 100).replace(/[. ]+$/, '').trim() || 'page';
      await chrome.downloads.download({ url: 'data:image/png;base64,' + png.data, filename: name + '.png' });
      await chrome.downloads.download({ url: 'data:application/pdf;base64,' + jpegToPdf(jpg.data, width, height), filename: name + '.pdf' });
    } finally {
      await chrome.debugger.detach(target);
    }
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  } catch (e) {
    console.error(e);
    chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
  }
});
