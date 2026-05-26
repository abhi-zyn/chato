// Auto-update: checks for new version every 60 seconds, prompts user to refresh
(function () {
  let currentVersion = null;
  let updateBanner = null;
  let pollInterval = null;
  let permissionGranted = false;

  // Ask permission on first run (stored in localStorage)
  function askPermission() {
    const stored = localStorage.getItem('autoUpdate.permission');
    if (stored === 'granted') {
      permissionGranted = true;
      return true;
    }
    if (stored === 'denied') {
      return false;
    }
    // First time — show permission prompt after 5s delay (let app load)
    setTimeout(showPermissionPrompt, 5000);
    return false;
  }

  function showPermissionPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'update-permission-prompt';
    prompt.innerHTML = `
      <div class="upp-card">
        <div class="upp-icon">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <polyline points="21 3 21 8 16 8"/>
          </svg>
        </div>
        <div class="upp-text">
          <h3>Stay up to date?</h3>
          <p>Get notified when new features and fixes are available.</p>
        </div>
        <div class="upp-actions">
          <button class="upp-btn upp-deny" type="button">Not now</button>
          <button class="upp-btn upp-allow" type="button">Allow</button>
        </div>
      </div>
    `;
    document.body.appendChild(prompt);
    setTimeout(() => prompt.classList.add('show'), 50);

    prompt.querySelector('.upp-allow').onclick = () => {
      localStorage.setItem('autoUpdate.permission', 'granted');
      permissionGranted = true;
      startPolling();
      dismissPrompt(prompt);
    };
    prompt.querySelector('.upp-deny').onclick = () => {
      localStorage.setItem('autoUpdate.permission', 'denied');
      dismissPrompt(prompt);
    };
  }

  function dismissPrompt(el) {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }

  async function checkVersion() {
    try {
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!currentVersion) {
        currentVersion = data.version;
        return;
      }
      if (data.version !== currentVersion) {
        showUpdateBanner(data.version);
      }
    } catch (e) {
      // Network issue — silently retry on next interval
    }
  }

  function showUpdateBanner(newVersion) {
    if (updateBanner) return; // Already showing
    updateBanner = document.createElement('div');
    updateBanner.className = 'update-banner';
    updateBanner.innerHTML = `
      <div class="ub-content">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
          <polyline points="21 3 21 8 16 8"/>
        </svg>
        <span>New version available</span>
      </div>
      <div class="ub-actions">
        <button class="ub-btn ub-later" type="button">Later</button>
        <button class="ub-btn ub-refresh" type="button">Refresh</button>
      </div>
    `;
    document.body.appendChild(updateBanner);
    setTimeout(() => updateBanner.classList.add('show'), 50);

    updateBanner.querySelector('.ub-refresh').onclick = async () => {
      // Force service worker update and clear old caches
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      window.location.reload();
    };
    updateBanner.querySelector('.ub-later').onclick = () => {
      updateBanner.classList.remove('show');
      setTimeout(() => {
        updateBanner.remove();
        updateBanner = null;
      }, 300);
      // Re-prompt in 30 minutes
      setTimeout(() => checkVersion(), 30 * 60 * 1000);
    };
  }

  function startPolling() {
    if (pollInterval) return;
    checkVersion(); // Immediate check to set baseline
    pollInterval = setInterval(checkVersion, 60 * 1000); // Every 60s
  }

  // Init
  function init() {
    // Force SW update check on every load (critical for installed PWAs)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) reg.update();
      });
    }
    if (askPermission()) {
      startPolling();
    } else {
      // Even without permission, capture baseline so future opt-in works
      checkVersion();
    }
  }

  // Wait for DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
