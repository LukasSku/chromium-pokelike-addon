// ═══════════════════════════════════════════════════════════════════
// Pokelike Shiny Hunter – Popup Logic
// ═══════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// DOM refs
const inputEl        = $('#pokemon-input');
const btnAdd         = $('#btn-add');
const listEl         = $('#pokemon-list');
const emptyState     = $('#empty-state');
const targetCount    = $('#target-count');
const statusCard     = $('#status-card');
const statusDot      = $('#status-dot');
const statusText     = $('#status-text');
const runCountEl     = $('#run-count');
const foundStat      = $('#found-stat');
const foundNameEl    = $('#found-name');
const btnStart       = $('#btn-start');
const btnResetCount  = $('#btn-reset-counter');
const connBanner     = $('#connection-banner');
const connIcon       = $('#connection-icon');
const connText       = $('#connection-text');

// ─── State ───
let targetPokemon = [];
let isRunning = false;
let isConnected = false;

// ─── Connection Check ───
function setConnected(alive) {
  if (alive !== isConnected) {
    isConnected = alive;
    if (isConnected) {
      connBanner.className = 'connection-banner connection-banner--connected';
      connIcon.textContent = '✓';
      connText.textContent = 'Verbunden mit pokelike.xyz';
    } else {
      connBanner.className = 'connection-banner connection-banner--disconnected';
      connIcon.textContent = '⚠️';
      connText.textContent = 'Nicht verbunden – pokelike.xyz öffnen & Seite neu laden';
    }
    updateStartButton();
  }
}

function checkConnection() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.includes('pokelike.xyz')) {
      setConnected(false);
      return;
    }

    chrome.tabs.sendMessage(activeTab.id, { type: 'PING' }, (response) => {
      if (chrome.runtime.lastError || !response || response.type !== 'PONG') {
        setConnected(false);
      } else {
        setConnected(true);
      }
    });
  });
}

// Check connection immediately and every 1.5 seconds
checkConnection();
setInterval(checkConnection, 1500);

// ─── Init ───
chrome.storage.local.get(['targetPokemon', 'isRunning', 'runCount', 'status', 'foundPokemon'], (data) => {
  targetPokemon = data.targetPokemon || [];
  isRunning = data.isRunning || false;

  renderList();
  updateStatus(data.status || 'idle', data.runCount || 0, data.foundPokemon);
  updateStartButton();
});

// ─── Storage change listener (live updates from content script) ───
chrome.storage.onChanged.addListener((changes) => {
  if (changes.runCount || changes.status || changes.foundPokemon || changes.isRunning) {
    chrome.storage.local.get(['runCount', 'status', 'foundPokemon', 'isRunning'], (data) => {
      isRunning = data.isRunning || false;
      updateStatus(data.status || 'idle', data.runCount || 0, data.foundPokemon);
      updateStartButton();
    });
  }
  if (changes.targetPokemon) {
    targetPokemon = changes.targetPokemon.newValue || [];
    renderList();
  }
});

// ─── Add Pokémon ───
function addPokemon() {
  const name = inputEl.value.trim();
  if (!name) return;

  // Prevent duplicates (case-insensitive)
  if (targetPokemon.some(p => p.toLowerCase() === name.toLowerCase())) {
    inputEl.classList.add('shake');
    setTimeout(() => inputEl.classList.remove('shake'), 400);
    return;
  }

  targetPokemon.push(name);
  chrome.storage.local.set({ targetPokemon });
  inputEl.value = '';
  inputEl.focus();
  renderList();
}

btnAdd.addEventListener('click', addPokemon);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPokemon();
});

// ─── Remove Pokémon ───
function removePokemon(index) {
  targetPokemon.splice(index, 1);
  chrome.storage.local.set({ targetPokemon });
  renderList();
}

// ─── Render List ───
function renderList() {
  // Clear existing items (keep empty state)
  listEl.querySelectorAll('.pokemon-item').forEach(el => el.remove());

  targetCount.textContent = targetPokemon.length;

  if (targetPokemon.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  targetPokemon.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'pokemon-item';
    item.innerHTML = `
      <span class="pokemon-item-name">${escapeHtml(name)}</span>
      <button class="btn-remove" title="Entfernen" data-index="${i}">×</button>
    `;
    item.querySelector('.btn-remove').addEventListener('click', () => removePokemon(i));
    listEl.appendChild(item);
  });
}

// ─── Update Status Display ───
function updateStatus(status, runs, foundName) {
  runCountEl.textContent = runs;

  // Remove all status classes
  statusCard.classList.remove('status--searching', 'status--found', 'status--error');
  statusDot.classList.remove('dot--idle', 'dot--searching', 'dot--found', 'dot--error');

  switch (status) {
    case 'searching':
      statusCard.classList.add('status--searching');
      statusDot.classList.add('dot--searching');
      statusText.textContent = 'Suche läuft...';
      foundStat.style.display = 'none';
      break;

    case 'found':
      statusCard.classList.add('status--found');
      statusDot.classList.add('dot--found');
      statusText.textContent = '🌟 Shiny gefunden!';
      if (foundName) {
        foundStat.style.display = 'flex';
        foundNameEl.textContent = foundName;
      }
      break;

    case 'error':
      statusDot.classList.add('dot--error');
      statusText.textContent = 'Fehler aufgetreten';
      foundStat.style.display = 'none';
      break;

    default: // idle
      statusDot.classList.add('dot--idle');
      statusText.textContent = 'Bereit';
      foundStat.style.display = 'none';
      break;
  }
}

// ─── Update Start/Stop Button ───
function updateStartButton() {
  if (isRunning) {
    btnStart.innerHTML = '<span class="btn-icon">■</span><span class="btn-label">Suche stoppen</span>';
    btnStart.classList.add('btn--running');
    btnStart.disabled = false;
    btnStart.title = '';
  } else {
    btnStart.innerHTML = '<span class="btn-icon">▶</span><span class="btn-label">Suche starten</span>';
    btnStart.classList.remove('btn--running');

    // Disable start if no pokemon targets or not connected
    if (!isConnected) {
      btnStart.disabled = true;
      btnStart.title = 'Nicht verbunden – pokelike.xyz öffnen & Seite neu laden';
    } else if (targetPokemon.length === 0) {
      btnStart.disabled = true;
      btnStart.title = 'Zuerst Pokémon-Namen hinzufügen';
    } else {
      btnStart.disabled = false;
      btnStart.title = '';
    }
  }
}

// ─── Start / Stop Toggle ───
btnStart.addEventListener('click', () => {
  chrome.storage.local.get(['status'], (data) => {
    isRunning = !isRunning;

    const updates = { isRunning };
    if (isRunning) {
      updates.status = 'searching';
      updates.foundPokemon = null;
      if (data.status === 'found') {
        updates.runCount = 0;
      }
    } else {
      updates.status = 'idle';
    }

    chrome.storage.local.set(updates);
    updateStartButton();
  });
});

// ─── Reset Counter ───
btnResetCount.addEventListener('click', () => {
  chrome.storage.local.set({ runCount: 0, foundPokemon: null, status: isRunning ? 'searching' : 'idle' });
  runCountEl.textContent = '0';
  foundStat.style.display = 'none';
});

// ─── Utility ───
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
