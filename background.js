// ═══════════════════════════════════════════════════════════════════
// Pokelike Shiny Hunter – Background Service Worker
// ═══════════════════════════════════════════════════════════════════
// ─── Listen for extension icon click to toggle in-page widget ───
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id && tab.url && (tab.url.includes('pokelike.xyz') || tab.url.includes('www.pokelike.xyz'))) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_WIDGET' });
  }
});

// ─── Listen for messages from content script ───
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'SHINY_FOUND') {
    // Update badge to show shiny was found
    chrome.action.setBadgeText({ text: '★' });
    chrome.action.setBadgeBackgroundColor({ color: '#ffd700' });

    // Show notification if available
    if (chrome.notifications) {
      chrome.notifications.create('shiny-found', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '🌟 Shiny gefunden!',
        message: `${msg.pokemon} wurde nach ${msg.runs} Runs als Shiny gefunden!`,
        priority: 2
      });
    }
  }

  if (msg.type === 'UPDATE_BADGE') {
    if (msg.status === 'searching') {
      chrome.action.setBadgeText({ text: `${msg.runs || 0}` });
      chrome.action.setBadgeBackgroundColor({ color: '#e63946' });
    } else if (msg.status === 'idle') {
      chrome.action.setBadgeText({ text: '' });
    } else if (msg.status === 'found') {
      chrome.action.setBadgeText({ text: '★' });
      chrome.action.setBadgeBackgroundColor({ color: '#ffd700' });
    }
  }
});

// ─── Clear badge on install/update ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  chrome.storage.local.set({
    isRunning: false,
    status: 'idle',
    runCount: 0,
    targetPokemon: [],
    foundPokemon: null
  });
});
