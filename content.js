// ═══════════════════════════════════════════════════════════════════
// Pokelike Shiny Hunter – Content Script
// Runs in ISOLATED world on pokelike.xyz
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────
  // 1. Inject page-context helper (runs in MAIN world)
  //    Needed to override window.confirm and call game functions
  // ─────────────────────────────────────────────────────────
  const pageScript = document.createElement('script');
  pageScript.textContent = `
    (function() {
      const _origConfirm = window.confirm;
      let _autoConfirm = false;

      // Listen for commands from the content script
      window.addEventListener('message', function(e) {
        if (e.source !== window) return;
        if (!e.data || e.data.channel !== 'POKELIKE_SHINY_HUNTER') return;

        switch (e.data.action) {
          case 'enableAutoConfirm':
            _autoConfirm = true;
            break;
          case 'disableAutoConfirm':
            _autoConfirm = false;
            break;
          case 'triggerReset':
            _autoConfirm = true;
            try {
              if (typeof confirmResetRun === 'function') {
                confirmResetRun();
              }
            } catch(err) {
              console.warn('[ShinyHunter] confirmResetRun error:', err);
            }
            // Keep autoConfirm on for a bit in case the confirm is async
            setTimeout(function() { _autoConfirm = false; }, 3000);
            break;
        }
      });

      // Override confirm to auto-accept when hunting
      window.confirm = function() {
        if (_autoConfirm) return true;
        return _origConfirm.apply(this, arguments);
      };
    })();
  `;
  (document.head || document.documentElement).appendChild(pageScript);
  pageScript.remove(); // Clean up the script tag

  // ─────────────────────────────────────────────────────────
  // 2. State
  // ─────────────────────────────────────────────────────────
  let isRunning = false;
  let targetPokemon = [];
  let runCount = 0;
  let loopActive = false;

  // ─────────────────────────────────────────────────────────
  // 3. Helpers
  // ─────────────────────────────────────────────────────────
  const log = (...args) => console.log('%c[ShinyHunter]', 'color: #ffd700; font-weight: bold;', ...args);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Check if a game screen is currently active (screens use .active class) */
  function isScreenActive(screenId) {
    const el = document.getElementById(screenId);
    return el && el.classList.contains('active');
  }

  /** Get the leftmost map node from all clickable map nodes */
  function getLeftmostMapNode() {
    const nodes = Array.from(document.querySelectorAll('g.map-node.map-node--clickable'));
    if (nodes.length === 0) return null;

    nodes.sort((a, b) => {
      const getX = (el) => {
        // 1. Try to read CSS variable --node-tx
        const tx = el.style.getPropertyValue('--node-tx');
        if (tx) {
          const val = parseFloat(tx);
          if (!isNaN(val)) return val;
        }
        // 2. Try to parse transform translate attribute
        const transform = el.getAttribute('transform');
        if (transform) {
          const match = transform.match(/translate\(([^,\s]+)/);
          if (match) {
            const val = parseFloat(match[1]);
            if (!isNaN(val)) return val;
          }
        }
        // 3. Fallback to bounding rect
        return el.getBoundingClientRect().left;
      };
      return getX(a) - getX(b);
    });

    return nodes[0];
  }

  /** Wait for a specific screen to become active */
  function waitForScreen(screenId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (isScreenActive(screenId)) return resolve();

      let resolved = false;
      const observer = new MutationObserver(() => {
        if (!resolved && isScreenActive(screenId)) {
          resolved = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          reject(new Error(`Timeout waiting for #${screenId}`));
        }
      }, timeout);
    });
  }

  /** Wait for any of the given screens to become active */
  function waitForAnyScreen(screenIds, timeout = 30000) {
    return new Promise((resolve, reject) => {
      // Check immediately
      for (const id of screenIds) {
        if (isScreenActive(id)) return resolve(id);
      }

      let resolved = false;
      const observer = new MutationObserver(() => {
        if (resolved) return;
        for (const id of screenIds) {
          if (isScreenActive(id)) {
            resolved = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve(id);
            return;
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          reject(new Error(`Timeout waiting for any screen: ${screenIds.join(', ')}`));
        }
      }, timeout);
    });
  }

  /** Wait until .poke-name elements appear on the page */
  function waitForPokeNames(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelectorAll('.poke-name');
      if (existing.length > 0) return resolve(existing);

      let resolved = false;
      const observer = new MutationObserver(() => {
        if (resolved) return;
        const names = document.querySelectorAll('.poke-name');
        if (names.length > 0) {
          resolved = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(names);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          // Resolve with whatever we have (could be empty)
          resolve(document.querySelectorAll('.poke-name'));
        }
      }, timeout);
    });
  }

  // ─────────────────────────────────────────────────────────
  // 4. Shiny detection
  // ─────────────────────────────────────────────────────────

  /**
   * Check Pokémon in the CATCH SCREEN for a shiny match.
   * Only searches within #catch-choices to avoid false positives
   * from team bars, pokedex, or other UI elements.
   *
   * For each poke-card, checks if THAT card has BOTH:
   *   - A .shiny-badge element ("★ Shiny")
   *   - A .poke-name matching a name from the target list
   *
   * Returns { name, target } if found, null otherwise.
   */
  function checkForShinyMatch() {
    // Only search within the catch-choices area
    const catchChoices = document.getElementById('catch-choices');
    if (!catchChoices) {
      log('No #catch-choices found on page');
      return null;
    }

    // Check each individual Pokémon card
    const cards = catchChoices.querySelectorAll('.poke-choice-wrap, .poke-card');
    log(`Checking ${cards.length} Pokémon card(s) for shiny match...`);

    for (const card of cards) {
      // Does THIS card have a shiny badge?
      const shinyBadge = card.querySelector('.shiny-badge');
      if (!shinyBadge) continue; // Not shiny → skip

      // Get the Pokémon name from THIS card
      const nameEl = card.querySelector('.poke-name');
      if (!nameEl) continue;

      const pokeName = nameEl.textContent.trim();
      log(`  ★ Shiny card found: "${pokeName}"`);

      // Check against target list (case-insensitive)
      for (const target of targetPokemon) {
        if (target.toLowerCase() === pokeName.toLowerCase()) {
          return { name: pokeName, target };
        }
      }

      log(`  → "${pokeName}" is shiny but not in target list, skipping`);
    }

    log('  No matching shiny target found in catch choices');
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // 5. Click handler for any confirm modal buttons
  //    Handles custom modals (not just native confirm())
  // ─────────────────────────────────────────────────────────
  function clickConfirmModalButton() {
    // Common selectors for confirmation buttons in game modals
    const selectors = [
      '.swal2-confirm',                    // SweetAlert2
      '.modal-confirm',
      '.btn-confirm',
      'button[data-action="confirm"]',
      '.popup-btn-confirm',
      '.dialog-confirm',
      // Generic: look for buttons with "Yes", "OK", "Reset" text
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        log(`  Clicking modal confirm button: ${sel}`);
        btn.click();
        return true;
      }
    }

    // Fallback: look for visible buttons containing certain text
    const allBtns = document.querySelectorAll('button, .btn, [role="button"]');
    for (const btn of allBtns) {
      if (btn.offsetParent === null) continue; // Not visible
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'yes' || text === 'ok' || text === 'confirm' ||
          text === 'ja' || text === 'reset' || text === 'bestätigen') {
        // Make sure it's in a modal/overlay context (not the main game UI)
        const parent = btn.closest('[class*="modal"], [class*="popup"], [class*="dialog"], [class*="overlay"], [class*="swal"]');
        if (parent) {
          log(`  Clicking fallback confirm button: "${text}"`);
          btn.click();
          return true;
        }
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────
  // 6. Reset helper – handles the full reset flow
  // ─────────────────────────────────────────────────────────
  async function triggerReset() {
    // Method 1: Call confirmResetRun() via injected page script
    window.postMessage({
      channel: 'POKELIKE_SHINY_HUNTER',
      action: 'triggerReset'
    }, '*');

    // Method 2: Also click the reset button directly via DOM as fallback
    const resetButtons = document.querySelectorAll(
      'button[onclick="confirmResetRun()"], [data-menu="reset"]'
    );
    for (const btn of resetButtons) {
      if (btn.offsetParent !== null || btn.closest('.map-menu-icons')) {
        btn.click();
        break;
      }
    }

    // Try to click modal confirm buttons immediately
    await delay(100);
    clickConfirmModalButton();

    // Secondary check for modals that take a moment to animate
    await delay(250);
    clickConfirmModalButton();
  }

  // ─────────────────────────────────────────────────────────
  // 6. Money Farm automation loop
  // ─────────────────────────────────────────────────────────
  let moneyFarmActive = false;
  let moneyFarmStarter = 'Rayquaza';
  let firstPassiveSelected = false;
  let moneyFarmRuns = 0;
  let moneyFarmLoopActive = false;

  /** Select the best clickable map node for Money Farm */
  function getBestMoneyFarmMapNode() {
    const nodes = Array.from(document.querySelectorAll('g.map-node.map-node--clickable'));
    if (nodes.length === 0) return null;

    // Trainer-Keywords (höchste Priorität - Tier 1)
    const trainerKeywords = [
      'fisherman',
      'fisher',
      'firebreather',
      'fire-spitter',
      'grunt',
      'team-rocket',
      'old-guy',
      'gentleman',
      'scientist',
      'ace-trainer',
      'ace',
      'hiker',
      'officer',
      'policeman',
      'bug-catcher'
    ];

    // Grass-Keywords (mittlere Priorität - Tier 2)
    const grassKeywords = ['grass'];

    // Helper to get coordinates
    const getCoords = (el) => {
      let x = 0, y = 0;
      const tx = el.style.getPropertyValue('--node-tx');
      const ty = el.style.getPropertyValue('--node-ty');
      if (tx && ty) {
        x = parseFloat(tx);
        y = parseFloat(ty);
      }
      if (isNaN(x) || isNaN(y)) {
        const transform = el.getAttribute('transform');
        if (transform) {
          const match = transform.match(/translate\(([^,\s]+)[,\s]+([^)]+)\)/);
          if (match) {
            x = parseFloat(match[1]);
            y = parseFloat(match[2]);
          }
        }
      }
      if (isNaN(x) || isNaN(y)) {
        const rect = el.getBoundingClientRect();
        x = rect.left;
        y = rect.top;
      }
      return { x, y };
    };

    // Helper to get priority tier
    const getPriorityTier = (el) => {
      const img = el.querySelector('image');
      if (!img) return 3; // Tier 3: Normal
      const href = img.getAttribute('href') || img.getAttribute('xlink:href') || '';
      const hrefLower = href.toLowerCase();
      
      if (trainerKeywords.some(keyword => hrefLower.includes(keyword))) {
        return 1; // Tier 1: Trainer
      }
      if (grassKeywords.some(keyword => hrefLower.includes(keyword))) {
        return 2; // Tier 2: Grass
      }
      return 3; // Tier 3: Normal
    };

    // Split nodes into priority tiers
    const trainerNodes = nodes.filter(n => getPriorityTier(n) === 1);
    const grassNodes = nodes.filter(n => getPriorityTier(n) === 2);

    let selectedList;
    if (trainerNodes.length > 0) {
      selectedList = trainerNodes;
      log(`🔍 Money Farm map choice: choosing from ${trainerNodes.length} trainer node(s) (Tier 1)`);
    } else if (grassNodes.length > 0) {
      selectedList = grassNodes;
      log(`🔍 Money Farm map choice: choosing from ${grassNodes.length} grass node(s) (Tier 2)`);
    } else {
      selectedList = nodes;
      log(`🔍 Money Farm map choice: choosing from all ${nodes.length} clickable node(s) (Tier 3)`);
    }

    // Sort by Y coordinate descending (furthest down), then X coordinate ascending (leftmost)
    selectedList.sort((a, b) => {
      const coordsA = getCoords(a);
      const coordsB = getCoords(b);
      
      if (Math.abs(coordsA.y - coordsB.y) > 5) {
        return coordsB.y - coordsA.y; // Descending order (highest Y first, i.e., further down)
      }
      return coordsA.x - coordsB.x; // Ascending order (leftmost first)
    });

    return selectedList[0];
  }

  async function runMoneyFarmLoop() {
    if (moneyFarmLoopActive) return;
    moneyFarmLoopActive = true;
    log('💰 Money Farm loop started');
    log(`  Starter: ${moneyFarmStarter}`);
    
    try {
      while (moneyFarmActive) {
        // ── Starter Screen ──
        if (isScreenActive('starter-screen')) {
          log('🔍 Starter screen active, selecting starter...');
          if (firstPassiveSelected) {
            firstPassiveSelected = false;
            moneyFarmRuns++;
            chrome.storage.local.set({ moneyFarmRuns });
            log(`🔄 New run started, reset firstPassiveSelected to false. Increment runs to ${moneyFarmRuns}`);
          }
          
          await delay(200); // brief wait for render
          
          const dexCards = Array.from(document.querySelectorAll('#starter-choices .dex-card'));
          let targetCard = null;
          for (const card of dexCards) {
            const nameEl = card.querySelector('.dex-name');
            if (nameEl && nameEl.textContent.trim().toLowerCase() === moneyFarmStarter.toLowerCase()) {
              targetCard = card;
              break;
            }
          }
          
          if (targetCard) {
            log(`👉 Clicking starter card: ${moneyFarmStarter}`);
            targetCard.click();
            await delay(1000);
          } else {
            log(`⚠️ Starter "${moneyFarmStarter}" not found in list`);
            await delay(1000);
          }
        }
        
        // ── Passive Screen ──
        else if (isScreenActive('passive-screen')) {
          if (!firstPassiveSelected) {
            log('🔍 First passive screen active, selecting Power Bracer...');
            await delay(200);
            
            const itemCards = Array.from(document.querySelectorAll('#passive-choices .item-card'));
            let targetItem = null;
            for (const card of itemCards) {
              const nameEl = card.querySelector('.item-name');
              if (nameEl && nameEl.textContent.trim().toLowerCase() === 'power bracer') {
                targetItem = card;
                break;
              }
            }
            
            if (targetItem) {
              log('👉 Clicking Power Bracer');
              targetItem.click();
              firstPassiveSelected = true;
              await delay(1000);
            } else {
              log('⚠️ Power Bracer not found on screen, skipping passive choice...');
              const skipBtn = document.querySelector('#passive-screen .choice-skip-btn');
              if (skipBtn) {
                log('👉 Clicking Skip button');
                skipBtn.click();
                firstPassiveSelected = true;
                await delay(1000);
              } else {
                await delay(1000);
              }
            }
          } else {
            log('🔍 Subsequent passive screen active, skipping passive selection...');
            await delay(200);
            const skipBtn = document.querySelector('#passive-screen .choice-skip-btn');
            if (skipBtn) {
              log('👉 Clicking Skip button');
              skipBtn.click();
              await delay(1000);
            } else {
              await delay(500);
            }
          }
        }

        // ── Game Over Screen (Play Again) ──
        else if (isScreenActive('gameover-screen')) {
          log('🔍 Game Over screen active, clicking Play Again...');
          await delay(200);
          const playAgainBtn = document.getElementById('btn-retry');
          if (playAgainBtn && playAgainBtn.offsetParent !== null) {
            log('👉 Clicking Play Again button');
            playAgainBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }

        // ── Battle Screen (Defeat Continue) ──
        else if (isScreenActive('battle-screen')) {
          const continueBtn = document.getElementById('btn-continue-battle');
          if (continueBtn && continueBtn.offsetParent !== null) {
            log('🔍 Defeat detected! Clicking Continue Battle button...');
            continueBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }

        // ── Move Tutor Screen ──
        else if (document.getElementById('btn-skip-tutor') && document.getElementById('btn-skip-tutor').offsetParent !== null) {
          log('🔍 Move Tutor screen active or skip tutor button visible...');
          await delay(200);
          const skipBtn = document.getElementById('btn-skip-tutor');
          if (skipBtn && skipBtn.offsetParent !== null) {
            log('👉 Clicking Skip Tutor button');
            skipBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }

        // ── Shiny Screen ──
        else if (isScreenActive('shiny-screen') || (document.getElementById('btn-skip-shiny') && document.getElementById('btn-skip-shiny').offsetParent !== null)) {
          log('🔍 Shiny screen active or skip shiny button visible...');
          await delay(200);
          const skipBtn = document.getElementById('btn-skip-shiny');
          if (skipBtn && skipBtn.offsetParent !== null) {
            log('👉 Clicking Skip Shiny button');
            skipBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }

        // ── Item / Event Screen ──
        else if (isScreenActive('item-screen') || (document.getElementById('btn-skip-item') && document.getElementById('btn-skip-item').offsetParent !== null)) {
          log('🔍 Item/Event screen active or skip button visible...');
          await delay(200);
          const skipBtn = document.getElementById('btn-skip-item');
          if (skipBtn && skipBtn.offsetParent !== null) {
            log('👉 Clicking Skip button');
            skipBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }

        // ── Catch Screen (Wild Pokemon) ──
        else if (isScreenActive('catch-screen') || (document.getElementById('btn-skip-catch') && document.getElementById('btn-skip-catch').offsetParent !== null)) {
          log('🔍 Catch screen active or skip catch button visible...');
          await delay(200);
          const skipBtn = document.getElementById('btn-skip-catch');
          if (skipBtn && skipBtn.offsetParent !== null) {
            log('👉 Clicking Skip (flee) button');
            skipBtn.click();
            await delay(1000);
          } else {
            await delay(500);
          }
        }
        
        // ── Map Screen ──
        else if (isScreenActive('map-screen')) {
          log('🔍 Map screen active, selecting best node...');
          await delay(200); // brief wait for render
          
          const mapNode = getBestMoneyFarmMapNode();
          if (mapNode) {
            log('🗺️ Clicking best map node...');
            const clickRect = mapNode.querySelector('rect[fill="transparent"]');
            const clickTarget = clickRect || mapNode;

            const eventOpts = { bubbles: true, cancelable: true, view: window };
            clickTarget.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
            clickTarget.dispatchEvent(new PointerEvent('pointerup', eventOpts));
            clickTarget.dispatchEvent(new MouseEvent('click', eventOpts));

            if (typeof clickTarget.click === 'function') {
              clickTarget.click();
            }
            await delay(1000);
          } else {
            log('⚠️ No clickable map node found');
            await delay(500);
          }
        }
        
        else {
          await delay(300);
        }
      }
    } catch (err) {
      log('💥 Money Farm loop error:', err);
    }
    
    moneyFarmLoopActive = false;
    log('⏹️ Money Farm loop ended');
  }

  // ─────────────────────────────────────────────────────────
  // 7. Main automation loop (Shiny Hunter)
  // ─────────────────────────────────────────────────────────
  async function runLoop() {
    if (loopActive) return;
    loopActive = true;
    log('🚀 Automation loop started');
    log(`  Targets: [${targetPokemon.join(', ')}]`);

    try {
      while (isRunning) {
        // ── Step 1: Wait for map screen ──
        log('⏳ Waiting for map screen...');
        updateBadge('searching');

        try {
          await waitForScreen('map-screen', 60000);
        } catch (e) {
          log('⚠️ Map screen timeout, retrying...');
          await delay(500);
          continue;
        }

        // Brief wait for map nodes to render
        await delay(150);

        if (!isRunning) break;

        // ── Step 2: Click leftmost clickable map node ──
        const mapNode = getLeftmostMapNode();
        if (!mapNode) {
          log('⚠️ No clickable map node found, waiting...');
          await delay(500);
          continue;
        }

        log('🗺️ Clicking leftmost map node...');
        // SVG elements need special click handling
        // First try the transparent rect overlay, then the g element itself
        const clickRect = mapNode.querySelector('rect[fill="transparent"]');
        const clickTarget = clickRect || mapNode;

        // Dispatch both pointer and mouse events for maximum compatibility
        const eventOpts = { bubbles: true, cancelable: true, view: window };
        clickTarget.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
        clickTarget.dispatchEvent(new PointerEvent('pointerup', eventOpts));
        clickTarget.dispatchEvent(new MouseEvent('click', eventOpts));

        // Also try .click() directly as a fallback
        if (typeof clickTarget.click === 'function') {
          clickTarget.click();
        }

        // ── Step 3: Wait for an encounter/catch screen ──
        log('⏳ Waiting for encounter...');
        let activeScreen;
        try {
          activeScreen = await waitForAnyScreen([
            'catch-screen',
            'battle-screen',
            'item-screen',
            'trade-screen',
            'shiny-screen',
            'stat-buff-screen'
          ], 30000);
        } catch (e) {
          log('⚠️ No encounter screen appeared, resetting...');
          await triggerReset();
          runCount++;
          chrome.storage.local.set({ runCount, status: 'searching' });
          updateBadge('searching');
          continue;
        }

        log(`📺 Active screen: #${activeScreen}`);

        // ── Step 4: Only check for shiny on catch-screen ──
        if (activeScreen === 'catch-screen') {
          // Wait for Pokémon cards to render
          await waitForPokeNames(1500);
          await delay(100);

          if (!isRunning) break;

          const match = checkForShinyMatch();

          if (match) {
            // ★ SHINY FOUND! ★
            log(`🌟🌟🌟 SHINY TARGET FOUND: ${match.name} 🌟🌟🌟`);
            isRunning = false;

            chrome.storage.local.set({
              isRunning: false,
              status: 'found',
              foundPokemon: match.name,
              runCount
            });

            try {
              chrome.runtime.sendMessage({
                type: 'SHINY_FOUND',
                pokemon: match.name,
                runs: runCount
              });
            } catch (e) { /* background might not be active */ }

            break;
          }
        } else {
          // Non-catch screen – skip immediately
          await delay(100);
        }

        if (!isRunning) break;

        // ── Step 5: No match → Reset ──
        runCount++;
        chrome.storage.local.set({ runCount, status: 'searching' });
        updateBadge('searching');

        await triggerReset();
      }
    } catch (err) {
      log('💥 Loop error:', err);
      chrome.storage.local.set({
        status: 'error',
        errorMessage: err.message
      });
    }

    loopActive = false;
    log('⏹️ Automation loop ended');
  }

  // ─────────────────────────────────────────────────────────
  // 7. Badge update helper
  // ─────────────────────────────────────────────────────────
  function updateBadge(status) {
    try {
      chrome.runtime.sendMessage({
        type: 'UPDATE_BADGE',
        status,
        runs: runCount
      });
    } catch (e) { /* ignore */ }
  }

  // ─────────────────────────────────────────────────────────
  // 8. Chrome storage sync & initialization
  // ─────────────────────────────────────────────────────────

  // Signal to the popup that the content script is alive
  function sendHeartbeat() {
    chrome.storage.local.set({ contentScriptReady: true, contentScriptTimestamp: Date.now() });
  }

  chrome.storage.local.get(['isRunning', 'targetPokemon', 'runCount', 'moneyFarmActive', 'moneyFarmStarter', 'moneyFarmRuns'], (data) => {
    targetPokemon = data.targetPokemon || [];
    runCount = data.runCount || 0;
    isRunning = data.isRunning || false;
    
    moneyFarmActive = data.moneyFarmActive || false;
    moneyFarmStarter = data.moneyFarmStarter || 'Rayquaza';
    moneyFarmRuns = data.moneyFarmRuns || 0;

    log('Initialized', { isRunning, targetPokemon, runCount, moneyFarmActive, moneyFarmStarter, moneyFarmRuns });
    sendHeartbeat();

    if (isRunning && targetPokemon.length > 0) {
      runLoop();
    }

    if (moneyFarmActive) {
      runMoneyFarmLoop();
    }
  });

  // Send heartbeat every 5 seconds so popup knows we're alive
  setInterval(sendHeartbeat, 5000);

  // Listen for requests from background or popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ type: 'PONG', status: isRunning ? 'running' : 'idle', loopActive });
    } else if (msg.type === 'TOGGLE_WIDGET') {
      chrome.storage.local.get(['widgetMinimized'], (data) => {
        chrome.storage.local.set({ widgetMinimized: !data.widgetMinimized });
      });
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.targetPokemon) {
      targetPokemon = changes.targetPokemon.newValue || [];
      log('Target list updated:', targetPokemon);
    }

    if (changes.isRunning) {
      const wasRunning = isRunning;
      isRunning = changes.isRunning.newValue;

      if (isRunning && !wasRunning && !loopActive) {
        log('▶ Starting Shiny Hunter loop');
        runLoop();
      } else if (!isRunning && wasRunning) {
        log('⏹ Stopped Shiny Hunter loop');
        updateBadge('idle');
      }
    }

    if (changes.moneyFarmActive) {
      const wasActive = moneyFarmActive;
      moneyFarmActive = changes.moneyFarmActive.newValue;

      if (moneyFarmActive && !wasActive && !moneyFarmLoopActive) {
        log('▶ Starting Money Farm loop');
        runMoneyFarmLoop();
      } else if (!moneyFarmActive && wasActive) {
        log('⏹ Stopped Money Farm loop');
      }
    }

    if (changes.moneyFarmStarter) {
      moneyFarmStarter = changes.moneyFarmStarter.newValue || 'Rayquaza';
      log('Money Farm starter updated:', moneyFarmStarter);
    }

    if (changes.moneyFarmRuns) {
      moneyFarmRuns = changes.moneyFarmRuns.newValue || 0;
      log('Money Farm runs updated:', moneyFarmRuns);
    }
  });

  // ─────────────────────────────────────────────────────────
  // 9. Floating In-Page Widget (Shadow DOM)
  // ─────────────────────────────────────────────────────────
  function initWidget() {
    if (document.getElementById('pokelike-shiny-hunter-widget')) return;

    const container = document.createElement('div');
    container.id = 'pokelike-shiny-hunter-widget';
    container.style.position = 'fixed';
    container.style.zIndex = '2147483647';

    const shadow = container.attachShadow({ mode: 'open' });

    // Stylings
    const style = document.createElement('style');
    style.textContent = `
      :host {
        --bg-panel: rgba(20, 20, 30, 0.92);
        --border-color: rgba(255, 255, 255, 0.1);
        --text-main: #f1f2f6;
        --text-muted: #a4b0be;
        --accent-primary: #70a1ff;
        --accent-success: #2ed573;
        --accent-danger: #ff4757;
        --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .container {
        font-family: var(--font-family);
        color: var(--text-main);
        user-select: none;
      }
      .panel {
        background: var(--bg-panel);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
        width: 250px;
        transition: opacity 0.2s ease, transform 0.2s ease;
        display: flex;
        flex-direction: column;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-color);
        background: rgba(255, 255, 255, 0.03);
        cursor: move;
      }
      .header-title {
        font-weight: bold;
        font-size: 13px;
        color: #fffa65;
        letter-spacing: 0.5px;
        text-shadow: 0 0 4px rgba(255, 250, 101, 0.4);
        pointer-events: none;
      }
      .minimize-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .minimize-btn:hover {
        color: var(--text-main);
      }
      .tabs-nav {
        display: flex;
        border-bottom: 1px solid var(--border-color);
        background: rgba(0, 0, 0, 0.15);
      }
      .tab-btn {
        flex: 1;
        background: none;
        border: none;
        padding: 8px;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.2s ease;
        letter-spacing: 0.5px;
      }
      .tab-btn:hover {
        color: var(--text-main);
        background: rgba(255, 255, 255, 0.02);
      }
      .tab-btn.active {
        color: #fffa65;
        border-bottom: 2px solid #fffa65;
        background: rgba(255, 255, 255, 0.04);
      }
      .body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .status-box {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
      }
      .status-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #a4b0be;
        transition: background 0.3s ease;
      }
      .status-dot.idle { background: #a4b0be; }
      .status-dot.searching { background: #2ed573; animation: pulse 1.5s infinite; }
      .status-dot.found { background: #ffa502; box-shadow: 0 0 8px #ffa502; }
      .status-dot.error { background: #ff4757; }
      @keyframes pulse {
        0% { transform: scale(0.95); opacity: 0.5; }
        50% { transform: scale(1.1); opacity: 1; }
        100% { transform: scale(0.95); opacity: 0.5; }
      }
      .runs-row {
        color: var(--text-muted);
      }
      .runs-row strong {
        color: var(--text-main);
      }
      .targets-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .section-title {
        font-size: 10px;
        text-transform: uppercase;
        color: var(--text-muted);
        letter-spacing: 0.5px;
      }
      .target-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        max-height: 80px;
        overflow-y: auto;
        padding-right: 2px;
      }
      .target-tags::-webkit-scrollbar {
        width: 4px;
      }
      .target-tags::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
      }
      .target-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(112, 161, 255, 0.15);
        border: 1px solid rgba(112, 161, 255, 0.3);
        color: #70a1ff;
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
      }
      .target-tag .remove-tag {
        cursor: pointer;
        color: var(--text-muted);
        font-weight: bold;
        margin-left: 2px;
      }
      .target-tag .remove-tag:hover {
        color: var(--accent-danger);
      }
      .no-targets {
        font-size: 11px;
        color: var(--text-muted);
        font-style: italic;
      }
      .add-section {
        display: flex;
        gap: 6px;
      }
      .add-section input {
        flex: 1;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 6px 8px;
        color: var(--text-main);
        font-size: 12px;
        outline: none;
      }
      .add-section input:focus {
        border-color: var(--accent-primary);
      }
      .add-section button {
        background: var(--accent-primary);
        border: none;
        color: white;
        border-radius: 6px;
        width: 28px;
        height: 28px;
        cursor: pointer;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        line-height: 1;
      }
      .add-section button:hover {
        filter: brightness(1.1);
      }
      .action-btn {
        width: 100%;
        border: none;
        border-radius: 8px;
        padding: 8px;
        font-weight: bold;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        color: white;
        transition: background 0.2s ease;
      }
      .action-btn.start {
        background: var(--accent-success);
      }
      .action-btn.start:hover {
        background: #25be65;
      }
      .action-btn.stop {
        background: var(--accent-danger);
      }
      .action-btn.stop:hover {
        background: #ff3344;
      }
      .collapsed-btn {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: var(--bg-panel);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--border-color);
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: move;
        font-size: 18px;
        color: #fffa65;
        position: relative;
      }
      .collapsed-btn:hover {
        filter: brightness(1.15);
      }
      .badge-dot {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #a4b0be;
        border: 1.5px solid var(--bg-panel);
        pointer-events: none;
      }
      .badge-dot.searching { background: #2ed573; }
      .badge-dot.found { background: #ffa502; box-shadow: 0 0 4px #ffa502; }
      .badge-dot.error { background: #ff4757; }
    `;
    shadow.appendChild(style);

    // HTML Structure
    const htmlContainer = document.createElement('div');
    htmlContainer.className = 'container';
    htmlContainer.innerHTML = `
      <div class="panel" id="widget-panel" style="display: none;">
        <div class="header">
          <div class="header-title">★ POKELIKE HELPER</div>
          <button class="minimize-btn" id="widget-minimize-btn" title="Minimieren">✕</button>
        </div>
        
        <div class="tabs-nav">
          <button class="tab-btn active" id="tab-shiny-btn">Shiny Hunt</button>
          <button class="tab-btn" id="tab-money-btn">Money Farm</button>
        </div>
        
        <!-- Shiny Hunt Tab content -->
        <div class="body" id="tab-content-shiny">
          <div class="status-box">
            <div class="status-row">
              <span class="status-dot idle" id="widget-status-dot"></span>
              <span id="widget-status-text">Bereit</span>
            </div>
            <div class="runs-row">
              <span>Runs:</span>
              <strong id="widget-runs-count">0</strong>
            </div>
          </div>
          
          <div class="targets-section">
            <div class="section-title">Ziele:</div>
            <div class="target-tags" id="widget-target-tags"></div>
          </div>
          
          <div class="add-section">
            <input type="text" id="widget-input" placeholder="Pokémon hinzufügen" autocomplete="off" spellcheck="false">
            <button id="widget-add-btn">+</button>
          </div>
          
          <button class="action-btn start" id="widget-action-btn">▶ Suche starten</button>
        </div>

        <!-- Money Farm Tab content -->
        <div class="body" id="tab-content-money" style="display: none;">
          <div class="status-box">
            <div class="status-row">
              <span class="status-dot idle" id="widget-money-status-dot"></span>
              <span id="widget-money-status-text">Bereit</span>
            </div>
            <div class="runs-row">
              <span>Runs:</span>
              <strong id="widget-money-runs-count">0</strong>
            </div>
          </div>
          
          <div class="targets-section">
            <div class="section-title">Starter Pokémon:</div>
            <div class="add-section">
              <input type="text" id="widget-money-starter-input" placeholder="z.B. Rayquaza" autocomplete="off" spellcheck="false">
            </div>
          </div>
          
          <button class="action-btn start" id="widget-money-action-btn">▶ Farm starten</button>
        </div>
      </div>

      <div class="collapsed-btn" id="widget-collapsed-btn" style="display: none;" title="Helper öffnen">
        ★
        <span class="badge-dot" id="widget-badge-dot"></span>
      </div>
    `;
    shadow.appendChild(htmlContainer);
    document.body.appendChild(container);

    // DOM Elements inside Shadow
    const widgetPanel = shadow.getElementById('widget-panel');
    const collapsedBtn = shadow.getElementById('widget-collapsed-btn');
    const minimizeBtn = shadow.getElementById('widget-minimize-btn');
    const actionBtn = shadow.getElementById('widget-action-btn');
    const addBtn = shadow.getElementById('widget-add-btn');
    const inputField = shadow.getElementById('widget-input');
    const targetsContainer = shadow.getElementById('widget-target-tags');
    const statusDotEl = shadow.getElementById('widget-status-dot');
    const statusTextEl = shadow.getElementById('widget-status-text');
    const runsCountEl = shadow.getElementById('widget-runs-count');
    const badgeDotEl = shadow.getElementById('widget-badge-dot');

    // Tab Navigation DOM Elements
    const tabShinyBtn = shadow.getElementById('tab-shiny-btn');
    const tabMoneyBtn = shadow.getElementById('tab-money-btn');
    const tabContentShiny = shadow.getElementById('tab-content-shiny');
    const tabContentMoney = shadow.getElementById('tab-content-money');

    // Money Farm DOM Elements
    const moneyActionBtn = shadow.getElementById('widget-money-action-btn');
    const moneyStarterInput = shadow.getElementById('widget-money-starter-input');
    const moneyStatusDotEl = shadow.getElementById('widget-money-status-dot');
    const moneyStatusTextEl = shadow.getElementById('widget-money-status-text');
    const moneyRunsCountEl = shadow.getElementById('widget-money-runs-count');

    // Tab switching logic
    const switchTab = (tabName) => {
      if (tabName === 'shiny') {
        tabShinyBtn.classList.add('active');
        tabMoneyBtn.classList.remove('active');
        tabContentShiny.style.display = 'flex';
        tabContentMoney.style.display = 'none';
      } else {
        tabShinyBtn.classList.remove('active');
        tabMoneyBtn.classList.add('active');
        tabContentShiny.style.display = 'none';
        tabContentMoney.style.display = 'flex';
      }
    };

    tabShinyBtn.addEventListener('click', () => {
      switchTab('shiny');
      chrome.storage.local.set({ activeTab: 'shiny' });
    });

    tabMoneyBtn.addEventListener('click', () => {
      switchTab('money');
      chrome.storage.local.set({ activeTab: 'money' });
    });

    // Money Farm input listener
    moneyStarterInput.addEventListener('input', () => {
      chrome.storage.local.set({ moneyFarmStarter: moneyStarterInput.value.trim() });
    });

    // Money Farm Toggle button
    moneyActionBtn.addEventListener('click', () => {
      chrome.storage.local.get(['moneyFarmActive'], (res) => {
        const nextActive = !res.moneyFarmActive;
        const updates = { moneyFarmActive: nextActive };
        if (nextActive) {
          updates.isRunning = false; // Stop Shiny Hunter if running
        }
        chrome.storage.local.set(updates);
      });
    });

    // ─── Drag and Drop Mechanics ───
    let dragStartX = 0;
    let dragStartY = 0;
    let isDragging = false;
    let initialContainerX = 0;
    let initialContainerY = 0;
    let hasMovedSignificant = false;

    const constrainPosition = (x, y, w, h) => {
      const maxX = window.innerWidth - w - 10;
      const maxY = window.innerHeight - h - 10;
      return {
        x: Math.max(10, Math.min(x, maxX)),
        y: Math.max(10, Math.min(y, maxY))
      };
    };

    const startDrag = (e) => {
      if (e.button !== 0) return; // Only left mouse button

      const tagName = e.target.tagName.toLowerCase();
      if (tagName === 'button' || tagName === 'input' || e.target.classList.contains('remove-tag') || e.target.classList.contains('tab-btn')) {
        return;
      }

      isDragging = true;
      hasMovedSignificant = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = container.getBoundingClientRect();
      initialContainerX = rect.left;
      initialContainerY = rect.top;

      document.addEventListener('mousemove', dragMove);
      document.addEventListener('mouseup', dragEnd);
      e.preventDefault();
    };

    const dragMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        hasMovedSignificant = true;
      }

      const newX = initialContainerX + dx;
      const newY = initialContainerY + dy;

      const rect = container.getBoundingClientRect();
      const constrained = constrainPosition(newX, newY, rect.width, rect.height);

      container.style.left = constrained.x + 'px';
      container.style.top = constrained.y + 'px';
      container.style.right = 'auto';
    };

    const dragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;

      document.removeEventListener('mousemove', dragMove);
      document.removeEventListener('mouseup', dragEnd);

      const rect = container.getBoundingClientRect();
      chrome.storage.local.set({
        widgetPosition: { x: rect.left, y: rect.top }
      });
    };

    // Bind dragging to headers
    const widgetHeader = shadow.querySelector('.header');
    widgetHeader.addEventListener('mousedown', startDrag);
    collapsedBtn.addEventListener('mousedown', startDrag);

    // Toggle minimize
    minimizeBtn.addEventListener('click', () => {
      chrome.storage.local.set({ widgetMinimized: true });
    });

    collapsedBtn.addEventListener('click', (e) => {
      if (hasMovedSignificant) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      chrome.storage.local.set({ widgetMinimized: false });
    });

    // Add target pokemon
    const addTarget = () => {
      const name = inputField.value.trim();
      if (!name) return;

      chrome.storage.local.get(['targetPokemon'], (res) => {
        const list = res.targetPokemon || [];
        if (!list.some(p => p.toLowerCase() === name.toLowerCase())) {
          list.push(name);
          chrome.storage.local.set({ targetPokemon: list }, () => {
            inputField.value = '';
          });
        }
      });
    };

    addBtn.addEventListener('click', addTarget);
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTarget();
    });

    // Toggle running state
    actionBtn.addEventListener('click', () => {
      chrome.storage.local.get(['isRunning', 'status'], (res) => {
        const nextRunning = !res.isRunning;
        const updates = { isRunning: nextRunning };
        if (nextRunning) {
          updates.status = 'searching';
          updates.foundPokemon = null;
          updates.moneyFarmActive = false; // Stop Money Farm if running
          if (res.status === 'found') {
            updates.runCount = 0;
          }
        } else {
          updates.status = 'idle';
        }
        chrome.storage.local.set(updates);
      });
    });

    // Render tags list
    function renderWidgetTargets(list) {
      targetsContainer.innerHTML = '';
      if (!list || list.length === 0) {
        targetsContainer.innerHTML = '<span class="no-targets">Keine Pokémon</span>';
        return;
      }
      list.forEach((name, idx) => {
        const tag = document.createElement('div');
        tag.className = 'target-tag';
        tag.innerHTML = `
          <span>${name}</span>
          <span class="remove-tag" data-index="${idx}">×</span>
        `;
        tag.querySelector('.remove-tag').addEventListener('click', () => {
          chrome.storage.local.get(['targetPokemon'], (res) => {
            const currentList = res.targetPokemon || [];
            currentList.splice(idx, 1);
            chrome.storage.local.set({ targetPokemon: currentList });
          });
        });
        targetsContainer.appendChild(tag);
      });
    }

    // Update Widget DOM elements and position
    function updateWidgetUI(status, runs, isRunningVal, list, foundPoke, minimized, pos, moneyFarmActiveVal, moneyFarmStarterVal, moneyFarmRunsVal) {
      if (minimized) {
        widgetPanel.style.display = 'none';
        collapsedBtn.style.display = 'flex';
      } else {
        widgetPanel.style.display = 'flex';
        collapsedBtn.style.display = 'none';
      }

      renderWidgetTargets(list);
      runsCountEl.textContent = runs || 0;
      moneyRunsCountEl.textContent = moneyFarmRunsVal || 0;

      // Position container based on state and storage
      const w = minimized ? 42 : 250;
      const h = minimized ? 42 : 280;
      let x, y;
      if (pos) {
        x = pos.x;
        y = pos.y;
      } else {
        y = 15;
        x = window.innerWidth - w - 15;
      }

      const constrained = constrainPosition(x, y, w, h);
      container.style.top = constrained.y + 'px';
      container.style.left = constrained.x + 'px';
      container.style.right = 'auto';

      // Status updates for Shiny Hunt
      statusDotEl.className = 'status-dot';
      badgeDotEl.className = 'badge-dot';

      if (isRunningVal) {
        statusDotEl.classList.add('searching');
        badgeDotEl.classList.add('searching');
        statusTextEl.textContent = 'Suche läuft...';
        actionBtn.className = 'action-btn stop';
        actionBtn.innerHTML = '■ Suche stoppen';
      } else if (status === 'found') {
        statusDotEl.classList.add('found');
        badgeDotEl.classList.add('found');
        statusTextEl.textContent = `🌟 Shiny: ${foundPoke || ''}`;
        actionBtn.className = 'action-btn start';
        actionBtn.innerHTML = '▶ Suche starten';
      } else if (status === 'error') {
        statusDotEl.classList.add('error');
        badgeDotEl.classList.add('error');
        statusTextEl.textContent = 'Fehler!';
        actionBtn.className = 'action-btn start';
        actionBtn.innerHTML = '▶ Suche starten';
      } else {
        statusDotEl.classList.add('idle');
        badgeDotEl.classList.add('idle');
        statusTextEl.textContent = 'Bereit';
        actionBtn.className = 'action-btn start';
        actionBtn.innerHTML = '▶ Suche starten';
      }

      // Status updates for Money Farm
      moneyStatusDotEl.className = 'status-dot';
      if (moneyFarmActiveVal) {
        moneyStatusDotEl.classList.add('searching');
        badgeDotEl.className = 'badge-dot searching';
        moneyStatusTextEl.textContent = 'Farming...';
        moneyActionBtn.className = 'action-btn stop';
        moneyActionBtn.innerHTML = '■ Farm stoppen';
      } else {
        moneyStatusDotEl.classList.add('idle');
        moneyStatusTextEl.textContent = 'Bereit';
        moneyActionBtn.className = 'action-btn start';
        moneyActionBtn.innerHTML = '▶ Farm starten';
      }

      // Disable Shiny Hunt action button if targets are empty and not currently running
      if (!isRunningVal && (!list || list.length === 0)) {
        actionBtn.disabled = true;
        actionBtn.title = 'Füge zuerst Ziele hinzu';
        actionBtn.style.opacity = '0.5';
        actionBtn.style.cursor = 'not-allowed';
      } else {
        actionBtn.disabled = false;
        actionBtn.title = '';
        actionBtn.style.opacity = '1';
        actionBtn.style.cursor = 'pointer';
      }

      // Disable Money Farm action button if starter is empty
      if (!moneyFarmActiveVal && !moneyFarmStarterVal) {
        moneyActionBtn.disabled = true;
        moneyActionBtn.title = 'Füge zuerst einen Starter hinzu';
        moneyActionBtn.style.opacity = '0.5';
        moneyActionBtn.style.cursor = 'not-allowed';
      } else {
        moneyActionBtn.disabled = false;
        moneyActionBtn.title = '';
        moneyActionBtn.style.opacity = '1';
        moneyActionBtn.style.cursor = 'pointer';
      }
    }

    // Sync widget initially and on storage changes
    function syncWidget() {
      chrome.storage.local.get([
        'status', 'runCount', 'isRunning', 'targetPokemon', 'foundPokemon', 
        'widgetMinimized', 'widgetPosition', 'activeTab',
        'moneyFarmActive', 'moneyFarmStarter', 'moneyFarmRuns'
      ], (data) => {
        // Sync active tab
        switchTab(data.activeTab || 'shiny');

        // Sync input field for Money Farm starter (only if not focused)
        if (shadow.activeElement !== moneyStarterInput) {
          moneyStarterInput.value = data.moneyFarmStarter || 'Rayquaza';
        }

        updateWidgetUI(
          data.status || 'idle',
          data.runCount || 0,
          data.isRunning || false,
          data.targetPokemon || [],
          data.foundPokemon,
          data.widgetMinimized || false,
          data.widgetPosition,
          data.moneyFarmActive || false,
          data.moneyFarmStarter || 'Rayquaza',
          data.moneyFarmRuns || 0
        );
      });
    }

    syncWidget();
    chrome.storage.onChanged.addListener(syncWidget);
  }

  // Initialize the widget once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }

  log('✅ Content script loaded on', window.location.href);
})();
