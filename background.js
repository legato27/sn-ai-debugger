// Opens the side panel from the toolbar icon, the right-click menu on ServiceNow pages and the
// "trace this page" shortcut. The panel does the work: this worker only opens it and leaves the
// request in session storage (in memory, cleared when the browser closes).
const SN_PAGES = ['https://*.service-now.com/*', 'https://*.servicenowservices.com/*'];

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'snai-page', title: 'Trace this page with AI Debugger', contexts: ['page', 'frame'], documentUrlPatterns: SN_PAGES });
    chrome.contextMenus.create({ id: 'snai-selection', title: 'Trace "%s" with AI Debugger', contexts: ['selection'], documentUrlPatterns: SN_PAGES });
    chrome.contextMenus.create({ id: 'snai-link', title: 'Trace the linked record with AI Debugger', contexts: ['link'], documentUrlPatterns: SN_PAGES, targetUrlPatterns: SN_PAGES });
  });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup?.addListener(setup);

function openAndTrace(tab, request) {
  if (!tab?.windowId) return;
  // sidePanel.open only works inside the user gesture, so it runs before anything is awaited.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({ pendingTrace: { ...request, windowId: tab.windowId, at: Date.now() } }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'snai-selection') openAndTrace(tab, { text: String(info.selectionText || '').trim().slice(0, 500) });
  else if (info.menuItemId === 'snai-link') openAndTrace(tab, { text: info.linkUrl });
  else if (info.menuItemId === 'snai-page') openAndTrace(tab, { frameUrl: info.frameUrl, pageUrl: info.pageUrl || tab?.url });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'trace-page') openAndTrace(tab, { pageUrl: tab?.url });
});
