
(function () {
  'use strict';

  // Global CCCBR method library
  window.RG = window.RG || {};
  window.RG.methods = window.RG.methods || [];
  const RG = window.RG;

  const LOOKAHEAD_MS = 160;
  const DEMO_VISIBLE_AHEAD_MS = 15 * 60 * 1000;          // 15 minutes
  const DEMO_HIDDEN_AHEAD_MS  = 60 * 60 * 1000;          // 60 minutes
  const DEMO_LOW_BPM_THRESHOLD = 12;
  const DEMO_LOW_BPM_AHEAD_MS = 4 * 60 * 60 * 1000;      // 4 hours (only when BPM <= 12)
  const DEMO_MAX_AHEAD_STRIKES = 8000;                   // hard cap on total strikes scheduled ahead
  const DEMO_SCHED_MAX_PER_PASS = 400;                   // per-pass strike scheduling cap to avoid UI jank
  const COUNTDOWN_BEATS = 3;

  let wakeLockSentinel = null;

  let needsRedraw = true;
  let lastTickWasRAF = false;
  let lastKnownDPR = window.devicePixelRatio || 1;

  function markDirty() {
    needsRedraw = true;
  }

  function getMaintenanceIntervalMs() {
    const bpm = Math.max(1, Number(state.bpm) || 1);

    if (state.phase === 'idle' || state.phase === 'paused') return 1100;

    if (bpm <= 12) return 500;
    if (bpm <= 30) return 250;
    if (bpm <= 90) return 100;
    return 60;
  }

  function shouldUseRAFForRender() {
    return ((((state.phase === 'running' || state.phase === 'countdown') && state.bpm > 12)) ||
            (state.micActive && viewMic.checked === true));
  }

  let loopTimer = null;
  let loopRAF = null;
  let inLoopTick = false;

  function kickLoop() {
    if (loopRAF != null) {
      window.cancelAnimationFrame(loopRAF);
      loopRAF = null;
    }
    if (loopTimer != null) {
      window.clearTimeout(loopTimer);
      loopTimer = null;
    }

    const useRAF = shouldUseRAFForRender();
    if (useRAF) {
      lastTickWasRAF = true;
      loopRAF = window.requestAnimationFrame(loop);
    } else {
      lastTickWasRAF = false;
      loopTimer = window.setTimeout(loop, 0);
    }
  }


  // Row-based scoring: each bell has one beat-wide window per row.
  // More accurate hits score higher within the window, miss = 0.

  const TIER12_BY_BIN = [5,6,7,8,9,10,10,9,8,7,6,5];

  // === Analytics (GA4) ===
  const GA_MEASUREMENT_ID = 'G-7TEG531231';
  const GA_ID = GA_MEASUREMENT_ID;
  const SITE_VERSION = 'v018_p07_restore_defaults_buttons';

  function safeJsonParse(txt) { try { return JSON.parse(txt); } catch (_) { return null; } }
  function safeGetLS(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function safeSetLS(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }
  function safeDelLS(key) { try { localStorage.removeItem(key); } catch (_) {} }

  function safeGetBoolLS(key, def) {
    const v = safeGetLS(key);
    if (v == null) return def;
    if (v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
    return def;
  }
  function safeSetBoolLS(key, val) { safeSetLS(key, val ? '1' : '0'); }

  // v07_p02_privacy_footer_policy_friendly_banner
  const LS_CONSENT_AUDIENCE = 'rg_consent_audience_v1';

  const PRIVACY_POLICY_TEXT = `Privacy & Analytics

Ringer Game is a client-only web app.

What Ringer Game does not do
- It does not create user profiles.
- It does not assign persistent user IDs.
- It does not track you across visits.
- It does not record or transmit gameplay actions, scores, or timing data.

Audience measurement (optional)
If you enable Audience measurement, Ringer Game uses Google Analytics 4 to measure overall site usage, such as page or screen views, approximate location at the country or region level, and coarse device or browser information.

This information is used only to understand audience size and general usage trends.

Ringer Game does not send gameplay events, scores, timing metrics, bell-by-bell data, or other run details to Google Analytics.

Local gameplay data
Gameplay statistics and preferences may be stored in your browser (for example, via localStorage) so the game can remember settings and show your performance stats. This data stays on your device.

Your choice
Audience measurement is off by default. You can enable or disable it at any time from the Privacy page. When Audience measurement is turned off, analytics is stopped immediately. A page refresh ensures it is not loaded at all.

CCCBR method library (optional)
From Setup, you can optionally choose to download a method library from CCCBR. If you do, your browser will request data from CCCBR-hosted resources. CCCBR is a third party; their handling of data is governed by their terms. Ringer Game does not claim ownership of CCCBR content. See: https://www.cccbr.org.uk/

Third party
Google Analytics is provided by Google. Their processing of data is governed by Google’s own privacy terms.

Contact: ringergame143@gmail.com`;


  function getAudienceConsent() {
        const v = safeGetLS(LS_CONSENT_AUDIENCE);
        return (v === '1' || v === '0') ? v : '';
      }

  function isAudienceMeasurementEnabled() { return getAudienceConsent() === '1'; }

  function setAudienceConsent(val) {
        const v = (val === '1') ? '1' : '0';
        safeSetLS(LS_CONSENT_AUDIENCE, v);

        // Side effects: GA is strictly opt-in and only ever records screen/page views.
        showConsentBanner(false);
        if (v === '1') {
          gaNeedsRefreshNotice = false;
          try { window[gaDisableFlagKey()] = false; } catch (_) {}
          try { loadGA4IfConsented(); } catch (_) {}
          try { analytics.configure(); } catch (_) {}
          // Ensure the current screen is counted for SPA usage (screen views only).
          try { analytics.track('screen_view', { screen_name: analyticsScreenName(ui.screen) }); } catch (_) {}
        } else {
          // Stop sending hits best-effort, and clear GA cookies if present.
          try { window[gaDisableFlagKey()] = true; } catch (_) {}
          cleanupGACookiesBestEffort();
          if (gaLoadedThisSession) gaNeedsRefreshNotice = true;
        }

        try { syncPrivacyRefreshNoticeUI(); } catch (_) {}

        return v;
      }

  // GA4 dynamic loader (opt-in only)
  let gaInjected = false;
  let gaConfigured = false;
  let gaScriptEl = null;
  // Session-only flags: in-memory (cleared on refresh)
  let gaLoadedThisSession = false;       // becomes true only after the gtag.js script actually loads
  let gaNeedsRefreshNotice = false;      // show opt-out refresh notice until refresh or re-enable

  function gaDisableFlagKey() { return 'ga-disable-' + GA_ID; }

  function applyGADisableFlagFromStoredChoice() {
    const c = getAudienceConsent();
    if (c === '') return;
    try { window[gaDisableFlagKey()] = (c !== '1'); } catch (_) {}
  }

  function loadGA4IfConsented() {
    if (!isAudienceMeasurementEnabled()) return false;

    try { window[gaDisableFlagKey()] = false; } catch (_) {}

    if (!gaInjected) {
      try {
        gaScriptEl = document.createElement('script');
        gaScriptEl.async = true;
        gaScriptEl.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
        gaScriptEl.onload = function () {
          gaLoadedThisSession = true;
          // If the user opted out during a slow load, keep the refresh notice available.
          if (!isAudienceMeasurementEnabled()) gaNeedsRefreshNotice = true;
          try { syncPrivacyRefreshNoticeUI(); } catch (_) {}
        };
        document.head.appendChild(gaScriptEl);
        gaInjected = true;
      } catch (_) {}
    }

    if (!window.dataLayer) window.dataLayer = [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function(){ window.dataLayer.push(arguments); };
    }

    if (!gaConfigured) {
      try { window.gtag('js', new Date()); } catch (_) {}
      try {
        window.gtag('config', GA_ID, {
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
          send_page_view: false,
          cookie_expires: 0,
          cookie_update: false
        });
      } catch (_) {}
      gaConfigured = true;
    }

    return true;
  }

  function deleteCookieEverywhere(name) {
    if (!name) return;
    const expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
    const base = name + '=; expires=' + expires + '; max-age=0; path=/;';
    try { document.cookie = base; } catch (_) {}

    const host = (location && location.hostname) ? String(location.hostname) : '';
    const parts = host.split('.').filter(Boolean);
    const domains = [];
    if (host) {
      domains.push(host);
      domains.push('.' + host);
      if (parts.length >= 3) {
        for (let i = 1; i < parts.length - 1; i++) {
          const d = parts.slice(i).join('.');
          domains.push(d);
          domains.push('.' + d);
        }
      }
    }
    for (const d of domains) {
      try { document.cookie = base + ' domain=' + d + ';'; } catch (_) {}
    }
  }

  function cleanupGACookiesBestEffort() {
    try {
      const raw = document.cookie ? document.cookie.split(';') : [];
      const names = [];
      for (const part of raw) {
        const eq = part.indexOf('=');
        const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
        if (!name) continue;
        if (name === '_ga' || name.indexOf('_ga_') === 0) names.push(name);
      }
      for (const n of Array.from(new Set(names))) deleteCookieEverywhere(n);
    } catch (_) {}
  }



  function analyticsScreenName(screenKey) {
    const s = String(screenKey || '').toLowerCase();
    if (s === 'play') return 'setup';
    if (s === 'sound_intro') return 'sound';
    if (s === 'home' || s === 'view' || s === 'sound' || s === 'sound_intro' || s === 'load' || s === 'library' || s === 'game' || s === 'privacy') return s;
    return 'home';
  }

  function rid(prefix) {
    try {
      if (window.crypto && crypto.getRandomValues) {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        let s = '';
        for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
        return prefix + s;
      }
    } catch (_) {}
    return prefix + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  const analytics = (function () {
    const LS_TOTALS = 'rg_visitor_totals_v1';

    // No stable visitor identifier is used or stored (privacy).
    const sessionId = rid('s_');
    const visitorId = null;

    // Best-effort cleanup for legacy analytics visitor id key (if present).
    try { localStorage.removeItem('rg_visitor_id_v1'); } catch (_) {}

    const defaults = {
      plays_total: 0,
      seconds_total: 0,
      targets_total: 0,
      hits_total: 0,
      misses_total: 0,
      score_total: 0,
      pr_combo_global: 0
    };

    function loadTotals() {
      const raw = safeGetLS(LS_TOTALS);
      const parsed = raw ? safeJsonParse(raw) : null;
      const t = Object.assign({}, defaults, parsed || {});
      for (const k of Object.keys(defaults)) t[k] = Number(t[k] || 0);
      return t;
    }

    let totals = loadTotals();

    function configure() {
      try { loadGA4IfConsented(); } catch (_) {}
    }

    function track(name, params) {
      try {
        if (!isAudienceMeasurementEnabled()) return;
        const ev = String(name || '');
        if (ev !== 'screen_view') return;

        loadGA4IfConsented();
        const sn = (params && params.screen_name != null) ? String(params.screen_name) : '';
        if (!sn) return;

        if (typeof window.gtag === 'function') {
          window.gtag('event', 'screen_view', { screen_name: sn });
        }
      } catch (_) {}
    }

    function setUserProps(_) {
      // Intentionally no-op: gameplay totals/preferences are never sent to analytics.
    }

    function saveTotals() { safeSetLS(LS_TOTALS, JSON.stringify(totals)); }
    function refreshTotals() { totals = loadTotals(); return totals; }

    return { visitorId, sessionId, totals, configure, track, setUserProps, saveTotals, refreshTotals };
  })();

  // === DOM ===
  const main = document.getElementById('main');
  const leftStack = document.getElementById('leftStack');

  const displayPane = document.getElementById('displayPane');
  const spotlightPane = document.getElementById('spotlightPane');
  const micPane = document.getElementById('micPane');
  const notationPane = document.getElementById('notationPane');
  const statsPane = document.getElementById('statsPane');

  const displayCanvas = document.getElementById('displayCanvas');
  const dctx = displayCanvas.getContext('2d');
  const spotlightCanvas = document.getElementById('spotlightCanvas');
  const sctx = spotlightCanvas.getContext('2d');
  const notationCanvas = document.getElementById('notationCanvas');
  const nctx = notationCanvas.getContext('2d');

  const notationPrevBtn = document.getElementById('notationPrevBtn');
  const notationNextBtn = document.getElementById('notationNextBtn');

  const methodSelect = document.getElementById('methodSelect');
  const bellCountSelect = document.getElementById('bellCount');
  const scaleSelect = document.getElementById('scaleSelect');
  const octaveSelect = document.getElementById('octaveSelect');
  const bellVolume = document.getElementById('bellVolume');
  // v014_p05a_bell_timbre_global (Sound → Bells: global bell timbre)
  const bellRingLength = document.getElementById('bellRingLength');
  const bellRingLengthValue = document.getElementById('bellRingLengthValue');
  const bellBrightness = document.getElementById('bellBrightness');
  const bellBrightnessValue = document.getElementById('bellBrightnessValue');
  const bellStrikeHardness = document.getElementById('bellStrikeHardness');
  const bellStrikeHardnessValue = document.getElementById('bellStrikeHardnessValue');

  // v08_p05_sound_per_bell_overrides (Sound menu per-bell editor)
  const bellOverridesResetBtn = document.getElementById('bellOverridesResetBtn');
  const bellOverridesList = document.getElementById('bellOverridesList');
  // v10_p04_sound_quick_bell_row
  const soundQuickBellRow = document.getElementById('soundQuickBellRow');

  // v10_p08_sound_global_chords_splitstrike (Sound menu global chord controls)
  const globalChordOnOffBtn = document.getElementById('globalChordOnOffBtn');
  const globalChordPresetSelect = document.getElementById('globalChordPresetSelect');
  const globalChordSplitSelect = document.getElementById('globalChordSplitSelect');
  const globalChordInversionSelect = document.getElementById('globalChordInversionSelect');
  const globalChordSpreadSelect = document.getElementById('globalChordSpreadSelect');
  const globalChordSplitStepControl = document.getElementById('globalChordSplitStepControl');
  const globalChordSplitMaxControl = document.getElementById('globalChordSplitMaxControl');
  const globalChordStepMs = document.getElementById('globalChordStepMs');
  const globalChordMaxMs = document.getElementById('globalChordMaxMs');

  // v014_p01_global_custom_chords_advanced
  const globalChordCustomIntervalsControl = document.getElementById('globalChordCustomIntervalsControl');
  const globalChordCustomIntervalsInput = document.getElementById('globalChordCustomIntervalsInput');
  const globalChordCustomIntervalsWarn = document.getElementById('globalChordCustomIntervalsWarn');
  const globalChordAdvancedDetails = document.getElementById('globalChordAdvancedDetails');
  const globalChordDetuneCents = document.getElementById('globalChordDetuneCents');
  const globalChordDetuneCentsValue = document.getElementById('globalChordDetuneCentsValue');
  const globalChordLevelModeSelect = document.getElementById('globalChordLevelModeSelect');
  const globalChordLevelGainsControl = document.getElementById('globalChordLevelGainsControl');
  const globalChordLevelGainsInput = document.getElementById('globalChordLevelGainsInput');
  const globalChordSplitOffsetModeSelect = document.getElementById('globalChordSplitOffsetModeSelect');
  const globalChordSplitOffsetsControl = document.getElementById('globalChordSplitOffsetsControl');
  const globalChordSplitOffsetsInput = document.getElementById('globalChordSplitOffsetsInput');

  const bellCustomHzInput = document.getElementById('bellCustomHzInput');
  const bellCustomHzSlider = document.getElementById('bellCustomHzSlider');

  const droneOnOffBtn = document.getElementById('droneOnOffBtn');
  const droneTypeSelect = document.getElementById('droneTypeSelect');
  const droneCustomIntervalsControl = document.getElementById('droneCustomIntervalsControl');
  const droneCustomIntervalsInput = document.getElementById('droneCustomIntervalsInput');
  const droneCustomIntervalsWarn = document.getElementById('droneCustomIntervalsWarn');
  const droneScaleSelect = document.getElementById('droneScaleSelect');
  const droneOctaveSelect = document.getElementById('droneOctaveSelect');
  const droneVolume = document.getElementById('droneVolume');
// v014_p03_master_fx_limiter_reverb: Master / Output controls (Sound → Master FX)
const masterLimiterToggle = document.getElementById('masterLimiterToggle');
const masterLimiterStrength = document.getElementById('masterLimiterStrength');
const masterReverbToggle = document.getElementById('masterReverbToggle');
const masterReverbSize = document.getElementById('masterReverbSize');
const masterReverbMix = document.getElementById('masterReverbMix');
const masterReverbHighCut = document.getElementById('masterReverbHighCut');
const spatialDepthModeSelect = document.getElementById('spatialDepthModeSelect');


  // v014_p02_drone_variant_knobs: Drone variant controls (Sound → Drone)
  const droneNormalizeBtn = document.getElementById('droneNormalizeBtn');
  const droneDensity = document.getElementById('droneDensity');
  const droneDriftCents = document.getElementById('droneDriftCents');
  const droneMotionRate = document.getElementById('droneMotionRate');
  const droneClusterWidth = document.getElementById('droneClusterWidth');
  const droneNoiseTilt = document.getElementById('droneNoiseTilt');
  const droneNoiseQ = document.getElementById('droneNoiseQ');

  const droneVariantMotionControl = document.getElementById('droneVariantMotionControl');
  const droneVariantClusterControl = document.getElementById('droneVariantClusterControl');
  const droneVariantNoiseTiltControl = document.getElementById('droneVariantNoiseTiltControl');
  const droneVariantNoiseQControl = document.getElementById('droneVariantNoiseQControl');

  const droneCustomHzInput = document.getElementById('droneCustomHzInput');
  const droneCustomHzSlider = document.getElementById('droneCustomHzSlider');

  // v10_p05_sound_per_bell_hz_slider_preview: per-bell Hz slider range (prefer reusing drone root Hz slider semantics)
  const PER_BELL_HZ_SLIDER_REF = droneCustomHzSlider || bellCustomHzSlider;
  const PER_BELL_HZ_SLIDER_MIN = Number((PER_BELL_HZ_SLIDER_REF && PER_BELL_HZ_SLIDER_REF.min) || 20);
  const PER_BELL_HZ_SLIDER_MAX = Math.max(Number((PER_BELL_HZ_SLIDER_REF && PER_BELL_HZ_SLIDER_REF.max) || 4000), 5000);
  // Match the per-bell Hz text input precision so slider + input stay in sync.
  const PER_BELL_HZ_SLIDER_STEP = 0.01;

  const liveCountSelect = document.getElementById('liveCount');
  const bellPicker = document.getElementById('bellPicker');
  const keybindPanel = document.getElementById('keybindPanel');
  const keybindResetBtn = document.getElementById('keybindResetBtn');
  const keybindNote = document.getElementById('keybindNote');
  const bpmInput = document.getElementById('bpmInput');

  const bpmSlider = document.getElementById('bpmSlider');
  const bpmTapBtn = document.getElementById('bpmTapBtn');


  // Mic controls (top menu)
  const micToggleBtn = document.getElementById('micToggleBtn');
  const micCalibrateBtn = document.getElementById('micCalibrateBtn');
  const micCalibrateStatus = document.getElementById('micCalibrateStatus');
  const micStatus = document.getElementById('micStatus');
  const micCooldown = document.getElementById('micCooldown');
  const micCooldownVal = document.getElementById('micCooldownVal');


// Mic pane
  const micMeterFill = document.getElementById('micMeterFill');
  const micDbReadout = document.getElementById('micDbReadout');
  const micPaneStatus = document.getElementById('micPaneStatus');

  const fileInput = document.getElementById('fileInput');
  const xmlInput  = document.getElementById('xmlInput');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const demoBtn = document.getElementById('demoBtn');
  const dronePauseBtn = document.getElementById('dronePauseBtn');
  const menuToggle = document.getElementById('menuToggle');
  const rgHamburgerDropdown = document.getElementById('rgHamburgerDropdown');

  // v09_p05_stop_current_run_modal: shown when trying to start Demo from Home/menu while a run is active.
  const rgStopRunModal = document.getElementById('rgStopRunModal');
  const rgStopRunModalClose = document.getElementById('rgStopRunModalClose');
  const rgStopRunModalStop = document.getElementById('rgStopRunModalStop');

  // v09_p04b_hamburger_header_anchor: keep a stable root location for the hamburger (Play/Demo stays unchanged).
  const rgAppRoot = document.getElementById('app');
  const rgHamburgerRootParent = rgAppRoot || (menuToggle ? menuToggle.parentNode : null);

  function rgHamburgerMoveToggleToRoot() {
    if (!menuToggle || !rgHamburgerRootParent) return;
    // Preserve original DOM order (toggle before dropdown) when possible.
    if (rgHamburgerDropdown && rgHamburgerDropdown.parentNode === rgHamburgerRootParent) {
      try { rgHamburgerRootParent.insertBefore(menuToggle, rgHamburgerDropdown); } catch (_) {}
    } else {
      try { rgHamburgerRootParent.insertBefore(menuToggle, rgHamburgerRootParent.firstChild); } catch (_) {}
    }
  }

  function rgHamburgerIsHeaderAnchoredScreen(screenName) {
    const s = String(screenName || '').toLowerCase();
    return (s === 'play' || s === 'view' || s === 'sound' || s === 'sound_intro' || s === 'load' || s === 'library' || s === 'privacy');
  }

  function rgHamburgerResetDropdownInlinePosition() {
    if (!rgHamburgerDropdown) return;
    try {
      rgHamburgerDropdown.style.position = '';
      rgHamburgerDropdown.style.top = '';
      rgHamburgerDropdown.style.right = '';
      rgHamburgerDropdown.style.left = '';
      rgHamburgerDropdown.style.bottom = '';
    } catch (_) {}
  }

  function rgHamburgerPositionDropdownPortal() {
    if (!rgHamburgerDropdown || !menuToggle) return;
    const s = (ui && ui.screen) ? ui.screen : '';
    if (!rgHamburgerIsHeaderAnchoredScreen(s)) return;

    const r = menuToggle.getBoundingClientRect();
    const pad = 10;
    const top = Math.max(0, Math.round(r.bottom + pad));
    const right = Math.max(0, Math.round(window.innerWidth - r.right));

    // Portal positioning: keep dropdown adjacent to the in-panel hamburger without risking overflow clipping.
    try {
      rgHamburgerDropdown.style.position = 'fixed';
      rgHamburgerDropdown.style.top = top + 'px';
      rgHamburgerDropdown.style.right = right + 'px';
      rgHamburgerDropdown.style.left = 'auto';
      rgHamburgerDropdown.style.bottom = 'auto';
    } catch (_) {}
  }

  // Prompt 5: in-game header meta elements
  const gameMetaMethod = document.getElementById('gameMetaMethod');
  const gameMetaSource = document.getElementById('gameMetaSource');
  const gameMetaAttr   = document.getElementById('gameMetaAttr');
  const gameMetaBpm    = document.getElementById('gameMetaBpm');

  // Prompt 5: in-game menu overlay
  const rgMenuOverlay = document.getElementById('rgMenuOverlay');
  const rgMenuPanel   = document.getElementById('rgMenuPanel');
  const rgMenuGoPlay  = document.getElementById('rgMenuGoPlay');
  const rgMenuGoView  = document.getElementById('rgMenuGoView');
  const rgMenuGoSound = document.getElementById('rgMenuGoSound');
  const rgMenuClose   = document.getElementById('rgMenuClose');

  function rgMenuIsOpen() {
    return !!(rgMenuOverlay && !rgMenuOverlay.classList.contains('hidden'));
  }
  function openRgMenuOverlay() {
    if (!rgMenuOverlay) return;
    rgMenuOverlay.classList.remove('hidden');
    rgMenuOverlay.setAttribute('aria-hidden', 'false');
    try { if (rgMenuClose) rgMenuClose.focus({ preventScroll: true }); } catch (_) {}
  }
  function closeRgMenuOverlay() {
    if (!rgMenuOverlay) return;
    rgMenuOverlay.classList.add('hidden');
    rgMenuOverlay.setAttribute('aria-hidden', 'true');
    try { if (menuToggle && ui && ui.screen === 'game') menuToggle.focus({ preventScroll: true }); } catch (_) {}
  }

  // Legacy in-game overlay is kept inert (legacy DOM allowed).
  if (rgMenuOverlay) {
    // Keep overlay permanently hidden/inert (legacy DOM allowed).
    try { rgMenuOverlay.classList.add('hidden'); } catch (_) {}
    try { rgMenuOverlay.setAttribute('aria-hidden', 'true'); } catch (_) {}
  }

  // v09_p04_unified_hamburger_nav: unified hamburger dropdown on all screens.
  function hamburgerIsOpen() {
    return !!(rgHamburgerDropdown && !rgHamburgerDropdown.classList.contains('hidden'));
  }
  function syncHamburgerRunControlLabels() {
    if (!rgHamburgerDropdown) return;
    const pauseItem = rgHamburgerDropdown.querySelector('button[data-ham="pause"]');
    if (!pauseItem) return;

    let phase = '';
    try { phase = (state && state.phase) ? state.phase : ''; } catch (_) { phase = ''; }

    if (phase === 'paused') pauseItem.textContent = 'Resume';
    else if (phase === 'running' || phase === 'countdown') pauseItem.textContent = 'Pause';
    else pauseItem.textContent = 'Pause/Resume';
  }
  function openHamburgerMenu() {
    if (!rgHamburgerDropdown) return;
    if (menuToggle && menuToggle.disabled) return;
    try { syncHamburgerRunControlLabels(); } catch (_) {}
    try { rgHamburgerPositionDropdownPortal(); } catch (_) {}
    rgHamburgerDropdown.classList.remove('hidden');
    rgHamburgerDropdown.setAttribute('aria-hidden', 'false');
    if (menuToggle) {
      menuToggle.classList.add('is-open');
      menuToggle.setAttribute('aria-expanded', 'true');
    }
  }
  function closeHamburgerMenu() {
    if (!rgHamburgerDropdown) return;
    if (rgHamburgerDropdown.classList.contains('hidden')) {
      if (menuToggle) {
        menuToggle.classList.remove('is-open');
        menuToggle.setAttribute('aria-expanded', 'false');
      }
      return;
    }
    rgHamburgerDropdown.classList.add('hidden');
    rgHamburgerDropdown.setAttribute('aria-hidden', 'true');
    if (menuToggle) {
      menuToggle.classList.remove('is-open');
      menuToggle.setAttribute('aria-expanded', 'false');
    }
  }
  function toggleHamburgerMenu() {
    if (hamburgerIsOpen()) closeHamburgerMenu();
    else openHamburgerMenu();
  }

  // v09_p05_stop_current_run_modal
  function closeStopCurrentRunModal() {
    if (!rgStopRunModal) return;
    rgStopRunModal.classList.add('hidden');
    rgStopRunModal.setAttribute('aria-hidden', 'true');
  }

  function showStopCurrentRunModal() {
    if (!rgStopRunModal) {
      alert('Stop the current game first.');
      return;
    }

    // Ensure nav dropdown is not layered over the modal.
    try { closeHamburgerMenu(); } catch (_) {}

    rgStopRunModal.classList.remove('hidden');
    rgStopRunModal.setAttribute('aria-hidden', 'false');

    // Minimal focus help for keyboard users.
    try {
      if (rgStopRunModalStop) rgStopRunModalStop.focus({ preventScroll: true });
      else if (rgStopRunModalClose) rgStopRunModalClose.focus({ preventScroll: true });
    } catch (_) {}
  }

  if (rgStopRunModalClose) {
    rgStopRunModalClose.addEventListener('click', () => closeStopCurrentRunModal());
  }
  if (rgStopRunModalStop) {
    rgStopRunModalStop.addEventListener('click', () => {
      stopPressed('stopped');
      closeStopCurrentRunModal();
    });
  }
  if (rgStopRunModal) {
    rgStopRunModal.addEventListener('click', (e) => {
      // Click the shaded backdrop to dismiss.
      if (e && e.target === rgStopRunModal) closeStopCurrentRunModal();
    });
  }

  function runHamburgerAction(action) {
    const key = String(action || '').toLowerCase();
    if (key === 'home') { setScreen('home'); return; }
    if (key === 'setup') { setScreen('play'); return; }
    if (key === 'view') { setScreen('view'); return; }
    if (key === 'sound') { setScreen('sound'); return; }
    if (key === 'load') { setScreen('load'); return; }
    if (key === 'play') { setScreen('game'); return; }
    if (key === 'start') {
      try {
        const cur = (ui && ui.screen) ? String(ui.screen).toLowerCase() : '';
        if (cur !== 'game') setScreen('game');
        startPressed('play');
      } catch (_) {}
      return;
    }
    if (key === 'pause') { try { togglePause(); } catch (_) {} return; }
    if (key === 'stop') { try { stopPressed('stopped'); } catch (_) {} return; }
    if (key === 'demo') {
      if (state.phase !== 'idle') {
        showStopCurrentRunModal();
        return;
      }
      setScreen('game');
      startDemoFromUi();
      return;
    }
  }

  if (menuToggle) {
    menuToggle.setAttribute('aria-label', 'Menu');
    menuToggle.setAttribute('title', 'Menu');
    menuToggle.addEventListener('click', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      toggleHamburgerMenu();
    });
  }

  if (rgHamburgerDropdown) {
    rgHamburgerDropdown.addEventListener('click', (e) => {
      const btn = (e && e.target && e.target.closest) ? e.target.closest('button[data-ham]') : null;
      if (!btn) return;
      const action = (btn.dataset && btn.dataset.ham) ? btn.dataset.ham : '';
      closeHamburgerMenu();
      runHamburgerAction(action);
    });
  }

  const rgOutsideNavEvent = (typeof window !== 'undefined' && ('PointerEvent' in window)) ? 'pointerdown' : 'mousedown';
  document.addEventListener(rgOutsideNavEvent, (e) => {
    if (!hamburgerIsOpen()) return;
    const t = e && e.target;
    if (t && t.closest && (t.closest('#menuToggle') || t.closest('#rgHamburgerDropdown'))) return;
    closeHamburgerMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (!hamburgerIsOpen()) return;
    if (e && e.key === 'Escape') {
      closeHamburgerMenu();
    }
  });

  const statsDiv = document.getElementById('stats');

  // === Screen scaffolding ===
  const screenHome = document.getElementById('screenHome');
  const screenPlay = document.getElementById('screenPlay');
  const screenView = document.getElementById('screenView');
  const screenSound = document.getElementById('screenSound');
  const screenSoundIntro = document.getElementById('screenSoundIntro');
  const screenLoad = document.getElementById('screenLoad');
  const screenLibrary = document.getElementById('screenLibrary');
  const screenGame = document.getElementById('screenGame');
  const screenPrivacy = document.getElementById('screenPrivacy');

  // v09_p04b_hamburger_header_anchor: hide on Home; anchor into menu header rows on Setup/View/Sound/Privacy.
  function syncHamburgerUIForScreen(nextScreen) {
    if (!menuToggle) return;
    const n = String(nextScreen || '').toLowerCase();

    const show = (n !== 'home');
    menuToggle.classList.toggle('hidden', !show);
    try { menuToggle.disabled = !show; } catch (_) {}
    try { menuToggle.setAttribute('aria-hidden', show ? 'false' : 'true'); } catch (_) {}

    if (!show) {
      // Keep root positioning tidy even while hidden.
      try { rgHamburgerResetDropdownInlinePosition(); } catch (_) {}
      try { rgHamburgerMoveToggleToRoot(); } catch (_) {}
      return;
    }

    if (rgHamburgerIsHeaderAnchoredScreen(n)) {
      const screenEl = (n === 'play') ? screenPlay :
                       (n === 'view') ? screenView :
                       (n === 'sound') ? screenSound :
                       (n === 'sound_intro') ? screenSound :
                       (n === 'load') ? screenLoad :
                       (n === 'library') ? screenLibrary :
                       (n === 'privacy') ? screenPrivacy : null;
      const titleEl = screenEl ? screenEl.querySelector('.pane-title') : null;
      if (titleEl) {
        try { titleEl.appendChild(menuToggle); } catch (_) {}
      } else {
        try { rgHamburgerMoveToggleToRoot(); } catch (_) {}
      }
    } else {
      try { rgHamburgerMoveToggleToRoot(); } catch (_) {}
      // Non-anchored screens use CSS default positioning.
      try { rgHamburgerResetDropdownInlinePosition(); } catch (_) {}
    }
  }

  const ui = {
    screen: 'home',
    notationPage: 0,
    notationFollow: true,
    // v06_p15_notation_single_page_mode
    notationLayout: 'two_page',
    // v06_p12b_notation_tap_to_ring
    notationTapFlash: null,
    notationCursorRow: null,

    // v06_p13_notation_touch_polish
    notationDragActive: false,
    notationDragPointerId: null,
    notationDragLastKey: null,

    // v06_p17_spotlight_tap_drag_to_ring
    spotlightTapFlash: null,
    spotlightDragActive: false,
    spotlightDragPointerId: null,
    spotlightDragLastKey: null,

    // v10_p04_sound_quick_bell_row
    soundQuickRowDragActive: false,
    soundQuickRowDragPointerId: null,
    soundQuickRowDragLastBell: null,
    soundQuickRowActiveEl: null,
    soundQuickRowIgnoreClickUntilMs: 0,

    // v011_p02_sound_test_instrument_row
    soundTestRowDragActive: false,
    soundTestRowDragPointerId: null,
    soundTestRowDragLastBell: null,
    soundTestRowActiveEl: null,
    soundTestRowIgnoreClickUntilMs: 0,

    // v06_p12d_library_browser
    libraryIndex: null,
    librarySelectedIdx: null,
    libraryPreviewBell: 1,
    // v06_p14c_library_details_study_controls
    libraryPreview: null,
    librarySearchTerm: '',

    // v08_p04_demo_profile_defaults: session-only flags (not persisted)
    userTouchedConfig: false,
    hasRunStartedThisSession: false,
    // v015_p04_stats_export_import_and_compare: imported historic stats (UI-only)
    loadedStatsHistory: [],
    // v015_p04_stats_export_import_and_compare: most recent completed run stats snapshot for export preview
    lastRunStatsSnapshot: null,
    // v015_p04_stats_export_import_and_compare: last-loaded settings JSON (session-only, for append-only history)
    loadedCodeRoot: null,
    loadedCodePayload: null,
    loadedCodeFileName: '',
    loadedCodeScoringSignature: null,
    isBooting: true
  };

  // v08_p04_demo_profile_defaults
  function markUserTouchedConfig() {
    if (!ui || ui.isBooting) return;
    if (ui.userTouchedConfig) return;
    ui.userTouchedConfig = true;
  }

  function setScreen(name) {
    try { closeHamburgerMenu(); } catch (_) {}
    const n = String(name || '').toLowerCase();
const nn = (n === 'sound_intro') ? 'sound' : n;
const next = (nn === 'home' || nn === 'play' || nn === 'view' || nn === 'sound' || nn === 'load' || nn === 'library' || nn === 'game' || nn === 'privacy') ? nn : 'home';

    // v10_p05_sound_per_bell_hz_slider_preview: safety stop for any ongoing continuous Hz preview when leaving Sound.
    try {
      if (ui && ui.screen === 'sound' && next !== 'sound') {
        cancelHzSliderPreviewGesture();
        stopHzPreviewTone();
      }
    } catch (_) {}

    const screens = { home: screenHome, play: screenPlay, view: screenView, sound: screenSound, sound_intro: screenSoundIntro, load: screenLoad, library: screenLibrary, game: screenGame, privacy: screenPrivacy };
    for (const k in screens) {
      const el = screens[k];
      if (!el) continue;
      el.classList.toggle('rg-active', k === next);
      el.setAttribute('aria-hidden', k === next ? 'false' : 'true');
    }

    ui.screen = next;

    // v09_p04b_hamburger_header_anchor
    try { syncHamburgerUIForScreen(next); } catch (_) {}

    // v07_p02_privacy_footer_policy_friendly_banner: audience measurement (screen views only)
    try { analytics.track('screen_view', { screen_name: analyticsScreenName(next) }); } catch (_) {}

    if (next === 'privacy') {
      syncAudienceConsentUI();
      syncPrivacyRefreshNoticeUI();
    }

    if (next === 'view') {
      // Ensure View menu selected-state UI is correct when revisiting the screen.
      syncViewMenuSelectedUI();
    }

    if (next === 'library') {
      syncLibraryScreenUI();
    }

    if (next === 'sound') {
      // v011_p02_sound_test_instrument_row: stage-sized test rows update when revisiting Sound.
      try { rebuildSoundTestInstrumentRow(); } catch (_) {}
      try { rebuildSoundQuickBellRow(); } catch (_) {}
    }

    if (next === 'game') {
      markDirty();
      kickLoop();
      syncDronePauseBtnUI();
    }
  }

  // v06_p12c_library_entry: enable/disable Setup entry + keep Library screen filename current
  function syncLibraryEntryUI() {
    const loaded = !!(state && state.libraryLoaded);
    const name = (state && state.libraryFileName) ? String(state.libraryFileName) : '';

    const statusEl = document.getElementById('setupLibraryLoadedStatus');
    if (statusEl) {
      if (loaded) {
        statusEl.textContent = 'Loaded library: ' + (name || 'unknown');
        try { statusEl.title = name || ''; } catch (_) {}
      } else {
        statusEl.textContent = 'No library loaded.';
        try { statusEl.title = ''; } catch (_) {}
      }
    }

    const btn = document.getElementById('setupExploreLibraryBtn');
    if (!btn) return;

    btn.disabled = !loaded;
    btn.classList.toggle('is-disabled', !loaded);
    if (!loaded) {
      btn.title = 'Load a CCCBR library XML/ZIP first';
    } else {
      btn.title = '';
    }

    // v012_p02_setup_library_block_and_library_header_hamburger: hide Explore until a library is loaded.
    const wrap = btn.closest('.control') || btn.parentElement;
    if (wrap) wrap.classList.toggle('hidden', !loaded);
  }

  function syncLibraryScreenUI() {
    const nameEl = document.getElementById('libraryFileName');
    if (nameEl) {
      if (state && state.libraryLoaded && state.libraryFileName) {
        nameEl.textContent = String(state.libraryFileName);
      } else {
        nameEl.textContent = 'none';
      }
    }

    // v06_p12d_library_browser: ensure Library screen renders (if present)
    try { renderLibraryBrowser(); } catch (_) {}
  }

  // === v06_p12d_library_browser ===
  const LIB_STAGE_INFO = {
    4: { word: 'Minimus', bells: 4 },
    5: { word: 'Doubles', bells: 5 },
    6: { word: 'Minor', bells: 6 },
    7: { word: 'Triples', bells: 7 },
    8: { word: 'Major', bells: 8 },
    9: { word: 'Caters', bells: 9 },
    10: { word: 'Royal', bells: 10 },
    11: { word: 'Cinques', bells: 11 },
    12: { word: 'Maximus', bells: 12 },
  };

  function libStageWord(stage) {
    const s = parseInt(stage, 10);
    if (LIB_STAGE_INFO[s] && LIB_STAGE_INFO[s].word) return LIB_STAGE_INFO[s].word;
    return String(stage || '');
  }

  function libStageMeaning(stage) {
    const s = parseInt(stage, 10);
    const w = libStageWord(s) || String(s || '');
    return w + ' = ' + s + ' bells';
  }

  // v06_p14c_library_details_study_controls: incremental preview paging
  const LIB_PREVIEW_PAGE_SIZE = 18;
  const LIB_PREVIEW_MAX_ROWS = 2000;

  // === Bell glyph mapping (UI only) ===
  function bellToGlyph(bellNum) {
    const n = parseInt(bellNum, 10);
    if (n >= 1 && n <= 9) return String(n);
    if (n === 10) return '0';
    if (n === 11) return 'E';
    if (n === 12) return 'T';
    return '?';
  }

  function glyphToBell(ch) {
    if (!ch) return null;
    const c = String(ch).trim();
    if (!c) return null;
    const cc = c.length === 1 ? c : c[0];
    if (cc >= '1' && cc <= '9') return cc.charCodeAt(0) - '0'.charCodeAt(0);
    if (cc === '0') return 10;
    if (cc === 'E' || cc === 'e') return 11;
    if (cc === 'T' || cc === 't') return 12;
    return null;
  }

  function bellToCCCBRChar(b) {
    return bellToGlyph(b);
  }

  function buildLibraryIndex() {
    const methods = (RG && RG.methods) ? RG.methods : [];
    const stageOrder = [4,5,6,7,8,9,10,11,12];
    const stageMap = {};

    for (let i = 0; i < stageOrder.length; i++) {
      const s = stageOrder[i];
      stageMap[s] = {
        stage: s,
        word: libStageWord(s),
        count: 0,
        classMap: {},
        classes: []
      };
    }

    for (let i = 0; i < methods.length; i++) {
      const m = methods[i];
      if (!m) continue;

      let s = parseInt(m.stage, 10);
      if (!isFinite(s)) continue;
      s = clamp(s, 4, 12);
      if (s < 4 || s > 12) continue;

      const st = stageMap[s];
      if (!st) continue;
      st.count += 1;

      let cls = (m.class == null ? '' : String(m.class)).trim();
      if (!cls) cls = '(Unclassified)';

      const cKey = cls;
      if (!st.classMap[cKey]) {
        st.classMap[cKey] = {
          name: cls,
          count: 0,
          methodIdxs: []
        };
      }

      const cg = st.classMap[cKey];
      cg.count += 1;
      cg.methodIdxs.push(i);
    }

    for (let si = 0; si < stageOrder.length; si++) {
      const s = stageOrder[si];
      const st = stageMap[s];
      if (!st) continue;

      const classKeys = Object.keys(st.classMap || {});
      classKeys.sort(function(a, b) { return String(a).localeCompare(String(b)); });

      st.classes = classKeys.map(function(k) {
        const cg = st.classMap[k];
        if (cg && Array.isArray(cg.methodIdxs)) {
          cg.methodIdxs.sort(function(ia, ib) {
            const ta = (methods[ia] && methods[ia].title != null) ? String(methods[ia].title).trim().toUpperCase() : '';
            const tb = (methods[ib] && methods[ib].title != null) ? String(methods[ib].title).trim().toUpperCase() : '';
            if (ta < tb) return -1;
            if (ta > tb) return 1;
            return ia - ib;
          });
        }
        return cg;
      });
    }

    ui.libraryIndex = {
      total: methods.length,
      stageOrder: stageOrder.slice(),
      stageMap: stageMap
    };
  }

  // v06_p14c_library_details_study_controls: Class glossary (CCCBR terms)
  const LIB_CLASS_DEFS = {
    'alliance': 'A hunting method where the hunt bell follows an “alliance” path: regular and symmetric, but not the standard plain/treble-dodging/treble-place patterns.',
    'bob': 'A plain method where the work includes dodging (so it is not limited to simple hunting and making places).',
    'delight': 'A treble-dodging method where some cross-section changes make an internal place and some do not.',
    'hybrid': 'A hunting method whose hunt-bell path does not fit the usual plain, treble-dodging, treble-place, or alliance patterns.',
    'place': 'A plain method where all bells only hunt and make places (no dodging).',
    'surprise': 'A treble-dodging method with an internal place at every cross-section change (between dodging sections).',
    'treblebob': 'A treble-dodging method with no internal places at cross-section changes (pure “treble bob” crossings).',
    'trebleplace': 'A method where the treble (or hunt bell) makes extra places during the lead (a treble-place path).',
    'plain': 'A hunting method with a plain-hunt treble path (no treble dodging).'
  };

  function normalizeLibClassKey(cls) {
    const raw = (cls == null ? '' : String(cls)).trim();
    if (!raw) return '';
    return raw.toLowerCase().replace(/[\s\-_/]+/g, '');
  }

  function libClassDefinition(cls) {
    const k = normalizeLibClassKey(cls);
    if (!k) return 'Definition not available yet.';
    if (LIB_CLASS_DEFS[k]) return LIB_CLASS_DEFS[k];
    // Try stripping common modifiers (e.g. "Little Surprise", "Differential Bob").
    const stripped = k.replace(/^(little|differential|jump)+/, '');
    if (LIB_CLASS_DEFS[stripped]) return LIB_CLASS_DEFS[stripped];
    // Fall back to a suffix match.
    const keys = Object.keys(LIB_CLASS_DEFS);
    for (let i = 0; i < keys.length; i++) {
      const base = keys[i];
      if (base && k.endsWith(base)) return LIB_CLASS_DEFS[base];
    }
    return 'Definition not available yet.';
  }

  function updateLibraryClassGlossary(m, stage) {
    if (!libraryClassGlossary) return;
    const cls = (m && m.class != null ? String(m.class) : '').trim() || '(Unclassified)';
    const def = (cls === '(Unclassified)') ? 'No class descriptor is set for this method in the CCCBR metadata.' : libClassDefinition(cls);

    const out = [];
    out.push('<div class="rg-library-section-title">Class glossary</div>');
    out.push('<div class="rg-library-section-body">');
    out.push('<div><span class="rg-muted">Selected:</span> <b>' + cls.replace(/</g,'&lt;') + '</b></div>');
    out.push('<div class="rg-library-mt6">' + def.replace(/</g,'&lt;') + '</div>');

    // Optional: other class terms present on this stage (collapsible)
    const st = (ui.libraryIndex && ui.libraryIndex.stageMap) ? ui.libraryIndex.stageMap[stage] : null;
    const clsList = (st && Array.isArray(st.classes)) ? st.classes.map(cg => (cg && cg.name ? String(cg.name) : '')).filter(Boolean) : [];
    const unique = [];
    for (let i = 0; i < clsList.length; i++) {
      const name = clsList[i].trim();
      if (!name) continue;
      if (unique.indexOf(name) === -1) unique.push(name);
    }
    if (unique.length) {
      unique.sort((a, b) => String(a).localeCompare(String(b)));
      out.push('<details class="rg-library-mt6">');
      out.push('<summary class="rg-muted">More definitions</summary>');
      out.push('<div class="rg-library-section-body rg-library-mt6">');
      const max = Math.min(unique.length, 18);
      for (let i = 0; i < max; i++) {
        const n = unique[i];
        const d = (n === '(Unclassified)') ? 'No class descriptor set in CCCBR metadata.' : libClassDefinition(n);
        out.push('<div class="rg-library-mt6"><b>' + n.replace(/</g,'&lt;') + ':</b> ' + d.replace(/</g,'&lt;') + '</div>');
      }
      if (unique.length > max) {
        out.push('<div class="rg-library-mt6 rg-muted">(' + (unique.length - max) + ' more…)</div>');
      }
      out.push('</div>');
      out.push('</details>');
    }

    out.push('</div>');
    libraryClassGlossary.innerHTML = out.join('');
  }

  function clearLibrarySelectionUI() {
    ui.librarySelectedIdx = null;
    if (libraryDetailsPanel) libraryDetailsPanel.classList.add('hidden');
    if (libraryDetailsEmpty) libraryDetailsEmpty.classList.remove('hidden');
    if (libraryPlaySelectedBtn) libraryPlaySelectedBtn.disabled = true;
    if (libraryDemoSelectedBtn) libraryDemoSelectedBtn.disabled = true;
    if (librarySelectedTitle) librarySelectedTitle.textContent = '';
    if (librarySelectedMeta) librarySelectedMeta.innerHTML = '';
    if (libraryGlossary) libraryGlossary.innerHTML = '';
    if (libraryClassGlossary) libraryClassGlossary.innerHTML = '';
    if (libraryNotes) libraryNotes.innerHTML = '';
    if (libraryPreview) libraryPreview.innerHTML = '';
    ui.libraryPreview = null;
    if (libraryPreviewPageLabel) libraryPreviewPageLabel.textContent = '';
    if (libraryPreviewLimitNote) libraryPreviewLimitNote.classList.add('hidden');
    if (libraryPreviewPrevBtn) { libraryPreviewPrevBtn.disabled = true; libraryPreviewPrevBtn.classList.add('is-disabled'); }
    if (libraryPreviewNextBtn) { libraryPreviewNextBtn.disabled = true; libraryPreviewNextBtn.classList.add('is-disabled'); }
    try {
      if (libraryBrowseGroups) {
        const prev = libraryBrowseGroups.querySelector('button.rg-lib-method-btn.is-active');
        if (prev) prev.classList.remove('is-active');
      }
    } catch (_) {}
  }

  function selectLibraryMethod(idx) {
    const methods = (RG && RG.methods) ? RG.methods : [];
    const i = parseInt(idx, 10);
    if (!isFinite(i) || i < 0 || i >= methods.length) return;
    const m = methods[i];
    if (!m) return;

    ui.librarySelectedIdx = i;

    // Highlight selection in the browse list (if rendered)
    try {
      if (libraryBrowseGroups) {
        const prev = libraryBrowseGroups.querySelector('button.rg-lib-method-btn.is-active');
        if (prev) prev.classList.remove('is-active');
        const cur = libraryBrowseGroups.querySelector('button.rg-lib-method-btn[data-method-idx="' + i + '"]');
        if (cur) cur.classList.add('is-active');
      }
    } catch (_) {}

    if (libraryDetailsEmpty) libraryDetailsEmpty.classList.add('hidden');
    if (libraryDetailsPanel) libraryDetailsPanel.classList.remove('hidden');
    if (libraryPlaySelectedBtn) libraryPlaySelectedBtn.disabled = false;
    if (libraryDemoSelectedBtn) libraryDemoSelectedBtn.disabled = false;

    const title = (m.title == null ? '' : String(m.title)).trim() || 'Untitled';
    if (librarySelectedTitle) librarySelectedTitle.textContent = title;

    let stage = parseInt(m.stage, 10);
    if (!isFinite(stage)) stage = 0;
    stage = clamp(stage, 4, 12);
    const stageWord = libStageWord(stage);

    const cls = (m.class == null ? '' : String(m.class)).trim();
    const fam = (m.family == null ? '' : String(m.family)).trim();
    const pn = (m.pn == null ? '' : String(m.pn)).trim();
    const lh = (m.lh == null ? '' : String(m.lh)).trim();

    if (librarySelectedMeta) {
      const lines = [];
      lines.push('<div><span class="rg-muted">Stage:</span> ' + stage + ' (' + stageWord + ')</div>');
      lines.push('<div><span class="rg-muted">Class:</span> ' + (cls || '(Unclassified)') + '</div>');
      if (fam) lines.push('<div><span class="rg-muted">Family:</span> ' + fam + '</div>');
      if (lh) lines.push('<div><span class="rg-muted">Lead head:</span> ' + lh + '</div>');
      librarySelectedMeta.innerHTML = lines.join('');
    }

    // Glossary
    if (libraryGlossary) {
      const parsed = (function() {
        const w = stageWord;
        const t = title;
        const lower = t.toLowerCase();
        const wl = (' ' + w).toLowerCase();
        if (w && lower.endsWith(wl)) {
          const name = t.slice(0, t.length - wl.length).trim();
          return { name: name || t, stageWord: w };
        }
        return { name: t, stageWord: w };
      })();

      const gl = [];
      gl.push('<div class="rg-library-section-title">Glossary</div>');
      gl.push('<div class="rg-library-section-body">');
      gl.push('<div><span class="rg-muted">Stage</span> is the bell-count word: <b>' + libStageMeaning(stage) + '</b>.</div>');
      gl.push('<div class="rg-library-mt6"><span class="rg-muted">Class</span> (in CCCBR metadata) is a short category for the method type (e.g., Plain, Treble Bob, Surprise).</div>');
      if (parsed && parsed.name) {
        gl.push('<div class="rg-library-mt6"><span class="rg-muted">Name:</span> ' + (parsed.name || '') + '</div>');
        gl.push('<div><span class="rg-muted">Stage:</span> ' + stageWord + ' (' + stage + ' bells)</div>');
      }
      gl.push('</div>');
      libraryGlossary.innerHTML = gl.join('');
    }

    // Class glossary (short definitions)
    try {
      updateLibraryClassGlossary(m, stage);
    } catch (_) {
      if (libraryClassGlossary) libraryClassGlossary.innerHTML = '';
    }

    // Notes / preview
    if (libraryNotes) {
      const notes = [];
      notes.push('<div class="rg-library-section-title">Notes</div>');
      notes.push('<div class="rg-library-section-body">');
      if (pn) {
        notes.push('<div><span class="rg-muted">Place notation:</span> <span class="rg-library-mono">' + pn.replace(/</g,'&lt;') + '</span></div>');
      } else {
        notes.push('<div><span class="rg-muted">Place notation:</span> (not provided)</div>');
      }
      notes.push('</div>');
      libraryNotes.innerHTML = notes.join('');
    }

    // Line bell selector
    if (libraryLineBellSelect) {
      libraryLineBellSelect.innerHTML = '';
      const noOpt = document.createElement('option');
      noOpt.value = '0';
      noOpt.textContent = 'No line';
      libraryLineBellSelect.appendChild(noOpt);
      for (let b = 1; b <= stage; b++) {
        const opt = document.createElement('option');
        opt.value = String(b);
        opt.textContent = 'Bell ' + bellToCCCBRChar(b);
        libraryLineBellSelect.appendChild(opt);
      }
      const prev = parseInt(ui.libraryPreviewBell, 10);
      if (prev === 0) ui.libraryPreviewBell = 0;
      else if (!isFinite(prev) || prev < 1 || prev > stage) ui.libraryPreviewBell = 1;
      libraryLineBellSelect.value = String(ui.libraryPreviewBell);
    }

    updateLibraryPreview();
  }

  // v06_p14c_library_details_study_controls: incremental two-page preview
  function libPreviewNumbersToRowString(nums) {
    let s = '';
    for (let i = 0; i < nums.length; i++) s += bellToCCCBRChar(nums[i]);
    return s;
  }

  function libPreviewInitCache(methodIdx, m, stage) {
    const pn = (m && m.pn != null ? String(m.pn) : '').trim();
    const rounds = [];
    for (let b = 1; b <= stage; b++) rounds.push(b);

    const cache = {
      methodIdx: methodIdx,
      stage: stage,
      pageSize: LIB_PREVIEW_PAGE_SIZE,
      leftPage: 0,
      rows: [],
      done: false,
      capped: false,
      pn: pn,
      tokens: null,
      leadLenWarn: '',
      tokenIdx: 0,
      curRow: rounds.slice(),
      roundsStr: libPreviewNumbersToRowString(rounds),
      huntUseX: true,
      huntSteps: 0,
      genMode: 'hunt'
    };

    if (pn) {
      try {
        const toks = cccbParsePnTokens(pn);
        if (toks && toks.length) {
          cache.tokens = toks.slice();
          cache.genMode = 'pn';
          let ll = (m && m.lengthOfLead != null) ? parseInt(m.lengthOfLead, 10) : NaN;
          if (isFinite(ll) && ll > 0 && cache.tokens.length !== ll) {
            cache.leadLenWarn = 'Warning: lead length mismatch (lengthOfLead=' + ll + ', PN tokens=' + cache.tokens.length + ').';
          }
        }
      } catch (_) {}
    }

    cache.rows.push(cache.roundsStr);
    return cache;
  }

  function libPreviewGenerateTo(p, needRows) {
    if (!p) return;
    const target = clamp(parseInt(needRows, 10) || 0, 0, LIB_PREVIEW_MAX_ROWS);
    while (p.rows.length < target && !p.done && p.rows.length < LIB_PREVIEW_MAX_ROWS) {
      if (p.genMode === 'pn' && p.tokens && p.tokens.length) {
        const tok = p.tokens[p.tokenIdx];
        p.curRow = cccbApplyPn(p.curRow, p.stage, tok);
        p.tokenIdx = (p.tokenIdx + 1) % p.tokens.length;
        const s = libPreviewNumbersToRowString(p.curRow);
        p.rows.push(s);
        if (p.tokenIdx === 0 && p.rows.length > 1 && s === p.roundsStr) p.done = true;
      } else {
        p.curRow = p.huntUseX ? applyX(p.curRow, p.stage) : applyY(p.curRow, p.stage);
        p.huntUseX = !p.huntUseX;
        p.huntSteps += 1;
        const s = libPreviewNumbersToRowString(p.curRow);
        p.rows.push(s);
        if (p.huntSteps >= p.stage * 2 && p.rows.length > 1 && s === p.roundsStr) p.done = true;
      }
    }

    if ((needRows > LIB_PREVIEW_MAX_ROWS && p.rows.length >= LIB_PREVIEW_MAX_ROWS) || (p.rows.length >= LIB_PREVIEW_MAX_ROWS)) {
      p.capped = true;
    }
  }

  function libPreviewFormatRowHtml(rowStr, hiliteChar) {
    if (!rowStr) return '';
    const safe = rowStr.replace(/</g, '&lt;');
    if (!hiliteChar) return safe;
    const pos = safe.indexOf(hiliteChar);
    if (pos < 0) return safe;
    return safe.slice(0, pos) + '<span class="lineHilite">' + hiliteChar + '</span>' + safe.slice(pos + 1);
  }

  function libPreviewRenderSpread(p) {
    if (!p || !libraryPreview) return;
    const pageSize = p.pageSize;
    const startRow = p.leftPage * pageSize;
    const gap = '    ';

    const hbRaw = parseInt(ui.libraryPreviewBell, 10);
    const hb = (isFinite(hbRaw) && hbRaw > 0) ? clamp(hbRaw, 1, p.stage) : 0;
    const hiliteChar = hb > 0 ? bellToCCCBRChar(hb) : '';

    const maxDigits = String(Math.max(1, Math.min(LIB_PREVIEW_MAX_ROWS, p.rows.length || 1))).length;
    const lines = [];

    for (let i = 0; i < pageSize; i++) {
      const li = startRow + i;
      const ri = startRow + pageSize + i;
      const lnum = (li < p.rows.length) ? String(li + 1).padStart(maxDigits, ' ') : ''.padStart(maxDigits, ' ');
      const rnum = (ri < p.rows.length) ? String(ri + 1).padStart(maxDigits, ' ') : ''.padStart(maxDigits, ' ');
      const lrow = (li < p.rows.length) ? libPreviewFormatRowHtml(p.rows[li], hiliteChar) : '';
      const rrow = (ri < p.rows.length) ? libPreviewFormatRowHtml(p.rows[ri], hiliteChar) : '';
      lines.push(lnum + ' ' + lrow + gap + rnum + ' ' + rrow);
    }

    libraryPreview.innerHTML = lines.join('\n');
    try { libraryPreview.scrollTop = 0; libraryPreview.scrollLeft = 0; } catch (_) {}
  }

  function libPreviewSyncControls(p) {
    if (!p) return;

    let left = Math.max(0, (p.leftPage | 0));
    left = left - (left % 2);
    p.leftPage = left;

    if (libraryPreviewPageLabel) {
      const a = left + 1;
      const b = left + 2;
      libraryPreviewPageLabel.textContent = 'Pages ' + a + '–' + b;
    }

    if (libraryPreviewLimitNote) {
      const showNote = !!p.capped || !!p.leadLenWarn;
      libraryPreviewLimitNote.classList.toggle('hidden', !showNote);
      if (showNote) {
        let msg = '';
        if (p.capped) msg = 'Preview limit reached.';
        if (p.leadLenWarn) msg = (msg ? (msg + ' ') : '') + p.leadLenWarn;
        libraryPreviewLimitNote.textContent = msg || 'Preview limit reached.';
      }
    }

    const canPrev = (left > 0);
    if (libraryPreviewPrevBtn) {
      libraryPreviewPrevBtn.disabled = !canPrev;
      libraryPreviewPrevBtn.classList.toggle('is-disabled', !canPrev);
    }

    let canNext = true;
    const targetLeft = left + 2;
    const targetStartRow = targetLeft * p.pageSize;
    if (p.done || p.capped) {
      canNext = (targetStartRow < p.rows.length);
    }

    if (libraryPreviewNextBtn) {
      libraryPreviewNextBtn.disabled = !canNext;
      libraryPreviewNextBtn.classList.toggle('is-disabled', !canNext);
    }
  }

  function updateLibraryPreview() {
    if (!libraryPreview) return;
    const methods = (RG && RG.methods) ? RG.methods : [];
    const idx = ui.librarySelectedIdx;

    if (idx == null || idx < 0 || idx >= methods.length) {
      libraryPreview.innerHTML = '';
      if (libraryPreviewPageLabel) libraryPreviewPageLabel.textContent = '';
      if (libraryPreviewLimitNote) libraryPreviewLimitNote.classList.add('hidden');
      if (libraryPreviewPrevBtn) { libraryPreviewPrevBtn.disabled = true; libraryPreviewPrevBtn.classList.add('is-disabled'); }
      if (libraryPreviewNextBtn) { libraryPreviewNextBtn.disabled = true; libraryPreviewNextBtn.classList.add('is-disabled'); }
      ui.libraryPreview = null;
      return;
    }

    const m = methods[idx];
    if (!m) {
      libraryPreview.innerHTML = '';
      ui.libraryPreview = null;
      return;
    }

    let stage = parseInt(m.stage, 10);
    if (!isFinite(stage)) stage = 0;
    stage = clamp(stage, 4, 12);

    if (!ui.libraryPreview || ui.libraryPreview.methodIdx !== idx) {
      ui.libraryPreview = libPreviewInitCache(idx, m, stage);
    }

    const p = ui.libraryPreview;
    if (!p) return;
    p.stage = stage;
    if (p.pageSize == null) p.pageSize = LIB_PREVIEW_PAGE_SIZE;
    if (p.leftPage == null || !isFinite(p.leftPage)) p.leftPage = 0;
    p.leftPage = Math.max(0, (p.leftPage | 0));
    p.leftPage = p.leftPage - (p.leftPage % 2);

    const neededForCurrent = Math.min(LIB_PREVIEW_MAX_ROWS, (p.leftPage + 2) * p.pageSize);
    libPreviewGenerateTo(p, neededForCurrent);
    libPreviewRenderSpread(p);
    libPreviewSyncControls(p);
  }

  function applyLibrarySearchFilter() {
    if (!libraryBrowseGroups || !librarySearchInput) return;
    const term = (librarySearchInput.value || '').trim().toLowerCase();
    ui.librarySearchTerm = term;

    const buttons = libraryBrowseGroups.querySelectorAll('button[data-method-idx]');
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const txt = (btn.textContent || '').toLowerCase();
      const ok = !term || (txt.indexOf(term) >= 0);
      btn.classList.toggle('hidden', !ok);
    }
  }

  function buildStageGroup(stage, stageEntry) {
    const details = document.createElement('details');
    details.className = 'rg-lib-stage';
    details.dataset.stage = String(stage);
    const summary = document.createElement('summary');
    const word = stageEntry && stageEntry.word ? String(stageEntry.word) : libStageWord(stage);
    const count = stageEntry && typeof stageEntry.count === 'number' ? stageEntry.count : 0;
    summary.textContent = stage + ' — ' + word + ' (' + count + ')';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'rg-lib-stage-body';
    details.appendChild(body);

    details.addEventListener('toggle', () => {
      if (!details.open) return;
      if (details.dataset.built === '1') {
        applyLibrarySearchFilter();
        return;
      }
      details.dataset.built = '1';
      buildStageClasses(stage, body);
      applyLibrarySearchFilter();
    });

    return details;
  }

  function buildStageClasses(stage, destEl) {
    if (!destEl || !ui.libraryIndex || !ui.libraryIndex.stageMap) return;
    const st = ui.libraryIndex.stageMap[stage];
    if (!st || !st.classes) return;

    destEl.innerHTML = '';
    for (let i = 0; i < st.classes.length; i++) {
      const cg = st.classes[i];
      if (!cg) continue;
      const clsDetails = document.createElement('details');
      clsDetails.className = 'rg-lib-class';
      clsDetails.dataset.stage = String(stage);

      const sum = document.createElement('summary');
      sum.textContent = (cg.name || '(Unclassified)') + ' (' + (cg.count || 0) + ')';
      clsDetails.appendChild(sum);

      const body = document.createElement('div');
      body.className = 'rg-lib-class-body';
      clsDetails.appendChild(body);

      clsDetails.addEventListener('toggle', () => {
        if (!clsDetails.open) return;
        if (clsDetails.dataset.built === '1') {
          applyLibrarySearchFilter();
          return;
        }
        clsDetails.dataset.built = '1';
        buildClassMethodButtons(stage, cg, body);
        applyLibrarySearchFilter();
      });

      destEl.appendChild(clsDetails);
    }
  }

  // v06_p14b_library_alphabetical_chunking: helpers
  const LIB_LARGE_GROUP_THRESHOLD = 200;
  const LIB_CHUNK_SIZE = 50;

  function libTitleKeyFromMethod(m) {
    const t = (m && m.title != null) ? String(m.title) : '';
    const key = t.trim().toUpperCase();
    return key || 'UNTITLED';
  }

  function libLetterBucketFromKey(titleKey) {
    const ch = titleKey && titleKey.length ? titleKey.charAt(0) : '';
    if (ch >= 'A' && ch <= 'Z') return ch;
    return '#';
  }

  function libTruncateLabel(s, max) {
    const t = (s == null ? '' : String(s)).trim();
    const m = Math.max(8, parseInt(max, 10) || 24);
    if (t.length <= m) return t;
    return t.slice(0, Math.max(0, m - 1)).trimEnd() + '…';
  }

  function libBuildMethodButtons(methodIdxs, destEl) {
    if (!destEl) return;
    const methods = (RG && RG.methods) ? RG.methods : [];
    const idxs = Array.isArray(methodIdxs) ? methodIdxs : [];

    const list = document.createElement('div');
    list.className = 'rg-lib-method-list';

    for (let i = 0; i < idxs.length; i++) {
      const mi = idxs[i];
      const m = methods[mi];
      if (!m) continue;
      const title = (m.title == null ? '' : String(m.title)).trim() || 'Untitled';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rg-lib-method-btn';
      btn.textContent = title;
      btn.dataset.methodIdx = String(mi);
      btn.addEventListener('click', () => selectLibraryMethod(mi));
      if (ui.librarySelectedIdx === mi) btn.classList.add('is-active');
      list.appendChild(btn);
    }

    destEl.appendChild(list);
  }

  function libBuildLetterContents(letter, methodIdxs, destEl) {
    if (!destEl) return;
    const methods = (RG && RG.methods) ? RG.methods : [];
    const idxs = Array.isArray(methodIdxs) ? methodIdxs : [];

    destEl.innerHTML = '';
    if (idxs.length <= LIB_CHUNK_SIZE) {
      libBuildMethodButtons(idxs, destEl);
      return;
    }

    for (let start = 0; start < idxs.length; start += LIB_CHUNK_SIZE) {
      const chunkIdxs = idxs.slice(start, start + LIB_CHUNK_SIZE);
      if (!chunkIdxs.length) continue;

      const first = methods[chunkIdxs[0]];
      const last = methods[chunkIdxs[chunkIdxs.length - 1]];
      const firstTitle = (first && first.title != null) ? String(first.title).trim() : '';
      const lastTitle = (last && last.title != null) ? String(last.title).trim() : '';
      const label = letter + ': ' +
        libTruncateLabel(firstTitle || 'Untitled', 26) + ' — ' +
        libTruncateLabel(lastTitle || 'Untitled', 26) +
        ' (' + chunkIdxs.length + ')';

      const d = document.createElement('details');
      d.className = 'lib-chunk';
      d.dataset.chunkStart = String(start);
      const s = document.createElement('summary');
      s.textContent = label;
      d.appendChild(s);

      const body = document.createElement('div');
      body.className = 'lib-chunk-body';
      d.appendChild(body);

      d._rgMethodIdxs = chunkIdxs;
      d.addEventListener('toggle', () => {
        if (!d.open) return;
        if (d.dataset.built === '1') {
          applyLibrarySearchFilter();
          return;
        }
        d.dataset.built = '1';
        body.innerHTML = '';
        libBuildMethodButtons(d._rgMethodIdxs, body);
        applyLibrarySearchFilter();
      });

      destEl.appendChild(d);
    }
  }

  function buildClassMethodButtons(stage, classGroup, destEl) {
    if (!destEl || !classGroup) return;
    const methods = (RG && RG.methods) ? RG.methods : [];
    const idxs = Array.isArray(classGroup.methodIdxs) ? classGroup.methodIdxs : [];

    destEl.innerHTML = '';

    // Small group: render a flat list as before (built lazily on open).
    if (idxs.length <= LIB_LARGE_GROUP_THRESHOLD) {
      libBuildMethodButtons(idxs, destEl);
      return;
    }

    // Large group: A–Z + chunking (built lazily at each nested level).
    const buckets = {};
    for (let i = 0; i < idxs.length; i++) {
      const mi = idxs[i];
      const m = methods[mi];
      if (!m) continue;
      const key = libTitleKeyFromMethod(m);
      const letter = libLetterBucketFromKey(key);
      if (!buckets[letter]) buckets[letter] = [];
      buckets[letter].push(mi);
    }

    const order = [];
    for (let c = 65; c <= 90; c++) order.push(String.fromCharCode(c));
    order.push('#');

    for (let oi = 0; oi < order.length; oi++) {
      const letter = order[oi];
      const arr = buckets[letter];
      if (!arr || !arr.length) continue;

      const d = document.createElement('details');
      d.className = 'lib-letter';
      d.dataset.letter = letter;

      const s = document.createElement('summary');
      s.textContent = letter + ' (' + arr.length + ')';
      d.appendChild(s);

      const body = document.createElement('div');
      body.className = 'lib-letter-body';
      d.appendChild(body);

      d._rgMethodIdxs = arr;
      d.addEventListener('toggle', () => {
        if (!d.open) return;
        if (d.dataset.built === '1') {
          applyLibrarySearchFilter();
          return;
        }
        d.dataset.built = '1';
        libBuildLetterContents(letter, d._rgMethodIdxs, body);
        applyLibrarySearchFilter();
      });

      destEl.appendChild(d);
    }
  }

  function renderLibraryBrowser() {
    if (!libraryBrowseGroups || !libraryLayout || !libraryNotLoadedNotice) return;

    const hasLib = !!(state && state.libraryLoaded && RG && RG.methods && RG.methods.length);
    libraryNotLoadedNotice.classList.toggle('hidden', hasLib);
    libraryLayout.classList.toggle('hidden', !hasLib);
    if (libraryJumpRow) libraryJumpRow.classList.toggle('hidden', !hasLib);

    if (libraryGoSetupBtn) {
      libraryGoSetupBtn.disabled = (ui.screen !== 'library');
    }

    if (!hasLib) {
      clearLibrarySelectionUI();
      try { libraryBrowseGroups.innerHTML = ''; } catch (_) {}
      return;
    }

    // Index rebuild if needed
    if (!ui.libraryIndex || ui.libraryIndex.total !== RG.methods.length) {
      buildLibraryIndex();
    }

    const builtFor = libraryBrowseGroups.dataset && libraryBrowseGroups.dataset.builtFor ? String(libraryBrowseGroups.dataset.builtFor) : '';
    const nowFor = String(RG.methods.length);
    if (builtFor !== nowFor) {
      libraryBrowseGroups.innerHTML = '';
      if (librarySearchInput) {
        try { librarySearchInput.value = ''; } catch (_) {}
      }
      ui.librarySearchTerm = '';

      const stageOrder = (ui.libraryIndex && ui.libraryIndex.stageOrder) ? ui.libraryIndex.stageOrder : [4,5,6,7,8,9,10,11,12];
      for (let si = 0; si < stageOrder.length; si++) {
        const s = stageOrder[si];
        const st = ui.libraryIndex.stageMap ? ui.libraryIndex.stageMap[s] : null;
        if (!st) continue;
        const stageDetails = buildStageGroup(s, st);
        libraryBrowseGroups.appendChild(stageDetails);
      }
      libraryBrowseGroups.dataset.builtFor = nowFor;
    }

    // Keep details panel in sync
    if (ui.librarySelectedIdx != null) {
      if (ui.librarySelectedIdx < 0 || ui.librarySelectedIdx >= RG.methods.length) {
        clearLibrarySelectionUI();
      }
    }
  }

  let libraryMethodLoadInFlight = false;

  async function libraryEnterWithSelected(mode) {
    const idx = ui.librarySelectedIdx;
    if (idx == null) return;

    if (state.phase !== 'idle') {
      alert('Stop the current game first.');
      return;
    }

    if (libraryMethodLoadInFlight) return;
    libraryMethodLoadInFlight = true;

    // Selecting a library method is a user configuration change.
    markUserTouchedConfig();

    const setLoading = (isLoading, msg) => {
      try {
        if (libraryMethodLoading) {
          if (msg != null) libraryMethodLoading.textContent = String(msg);
          if (isLoading) libraryMethodLoading.classList.remove('hidden');
          else libraryMethodLoading.classList.add('hidden');
        }
      } catch (_) {}
      try { if (libraryPlaySelectedBtn) libraryPlaySelectedBtn.disabled = !!isLoading; } catch (_) {}
      try { if (libraryDemoSelectedBtn) libraryDemoSelectedBtn.disabled = !!isLoading; } catch (_) {}
    };

    setLoading(true, 'Loading method…');

    try {
      const result = await loadCCCBRMethod(idx, {
        chunkRows: 1500,
        chunkLeads: 5000,
        onProgress: (p) => {
          try {
            const r = (p && p.rows != null) ? Number(p.rows) : null;
            const l = (p && p.leadsDone != null) ? Number(p.leadsDone) : null;
            if (isFinite(r) && isFinite(l)) setLoading(true, 'Loading method… (' + r + ' rows, ' + l + ' leads)');
            else if (isFinite(r)) setLoading(true, 'Loading method… (' + r + ' rows)');
          } catch (_) {}
        }
      });
      if (!result) return;

      setLoading(false, '');

      setScreen('game');
      if (mode === 'demo') {
        startDemoFromUi();
      }
    } finally {
      libraryMethodLoadInFlight = false;
      try {
        if (ui.screen === 'library') {
          if (libraryMethodLoading) libraryMethodLoading.classList.add('hidden');
          const hasSel = (ui.librarySelectedIdx != null);
          if (libraryPlaySelectedBtn) libraryPlaySelectedBtn.disabled = !hasSel;
          if (libraryDemoSelectedBtn) libraryDemoSelectedBtn.disabled = !hasSel;
        }
      } catch (_) {}
    }
  }

  const CCCBR_WEB_LIBRARY_URL = 'https://methods.cccbr.org.uk/xml/CCCBR_methods.xml.zip';
  async function downloadAndLoadCCCBRLibraryFromWeb() {
    if (!setupLoadCCCBRWebBtn) return;
    if (state.phase !== 'idle') {
      alert('Stop the current game first.');
      return;
    }

    // Loading a library is a user configuration change.
    markUserTouchedConfig();

    // Some browsers cannot unzip in-app; fall back immediately.
    if (typeof DecompressionStream === 'undefined') {
      alert('Could not download directly. Please use the download link and upload the ZIP file manually.');
      return;
    }

    try {
      setupLoadCCCBRWebBtn.disabled = true;
      if (setupLoadCCCBRWebStatus) setupLoadCCCBRWebStatus.textContent = 'Loading…';

      const resp = await fetch(CCCBR_WEB_LIBRARY_URL);
      if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : '0'));
      const blob = await resp.blob();

      const file = new File([blob], 'CCCBR_methods.xml.zip', { type: 'application/zip' });
      const before = RG.methods.length;
      await parseZipArchive(file);
      const added = RG.methods.length - before;

      if (added <= 0 && !RG.methods.length) {
        throw new Error('No methods loaded');
      }

      if (added > 0) {
        state.libraryLoaded = true;
        state.libraryFileName = 'CCCBR_methods.xml.zip';
        try { buildLibraryIndex(); } catch (_) {}
      }

      syncLibraryEntryUI();
      syncLibraryScreenUI();
      refreshMethodList();

      if (setupLoadCCCBRWebStatus) {
        setupLoadCCCBRWebStatus.textContent = 'Loaded ' + RG.methods.length + ' methods.';
      }

      // Prevent accidental double-loading (would duplicate methods).
      setupLoadCCCBRWebBtn.disabled = true;
    } catch (err) {
      console.error('CCCBR web download+load failed', err);
      try { setupLoadCCCBRWebBtn.disabled = false; } catch (_) {}
      if (setupLoadCCCBRWebStatus) setupLoadCCCBRWebStatus.textContent = '';
      alert('Could not download directly. Please use the download link and upload the ZIP file manually.');
    }
  }

  // Prompt 4: mount header controls into Play/View/Sound menus (move existing nodes; preserve IDs)
  function moveControlByChildId(childId, destEl) {
    if (!destEl) return;
    const el = document.getElementById(childId);
    if (!el) return;
    const controlEl = el.closest('.control');
    if (!controlEl) return;
    destEl.appendChild(controlEl);
  }

// v011_p04_bell_pitch_collapsible_blocks: Bell Pitch UI blocks + summary
function coerceBellPitchFamily(raw) {
  const v = String(raw || '').trim();
  if (v === 'diatonic' || v === 'pent_hex' || v === 'chromatic' || v === 'fifths_fourths' || v === 'partials' || v === 'custom') return v;
  return 'diatonic';
}

function fmtAccidentals(label) {
  return String(label || '')
    .replace(/([A-G])#/g, '$1♯')
    .replace(/([A-G])b/g, '$1♭');
}

function getBellPitchSummaryText() {
  const stateFam0 = coerceBellPitchFamily(state.bellPitchFamily);
  const u = ui._bellPitchUi;
  const uiFam = coerceBellPitchFamily((u && u.selectedFamily) ? u.selectedFamily : stateFam0);

  // "Custom" is a UI-only selection. For summary text, always describe the effective pattern mapping,
  // and optionally prefix with "Custom —".
  const fam = (stateFam0 === 'custom') ? 'diatonic' : stateFam0;

  const spanLabel = (String(state.bellPitchSpan || 'compact') === 'extended') ? 'Extended' : 'Compact';

  const keyLabel = (() => {
    if (state.scaleKey === 'custom_hz') return `Custom (${Math.round(state.bellCustomHz || 440)} Hz)`;
    const def = getScaleDefByKey(state.scaleKey) || getScaleDef();
    return fmtAccidentals(def && def.label ? def.label : 'Diatonic');
  })();

  const pentaLabel = (() => {
    const v = String(state.bellPitchPentVariant || 'major_pent');
    if (v === 'minor_pent') return 'Minor Pentatonic';
    if (v === 'whole_tone') return 'Whole Tone';
    if (v === 'blues_hex') return 'Blues Hexatonic';
    return 'Major Pentatonic';
  })();

  const chromLabel = (() => {
    const d = String(state.bellPitchChromaticDirection || 'descending');
    return (d === 'ascending') ? 'Ascending' : 'Descending';
  })();

  const fifthsTitle = (() => {
    const t = String(state.bellPitchFifthsType || 'fifths');
    return (t === 'fourths') ? 'Fourths Ladder' : 'Fifths Ladder';
  })();

  const fifthsShape = (() => {
    const s = String(state.bellPitchFifthsShape || 'folded');
    return (s === 'ladder') ? 'Ladder' : 'Folded';
  })();

  const partialsShape = (() => {
    const s = String(state.bellPitchPartialsShape || 'ladder');
    return (s === 'folded') ? 'Folded' : 'Ladder';
  })();

  let base = `Diatonic — ${keyLabel} — ${spanLabel}`;
  if (fam === 'diatonic') base = `Diatonic — ${keyLabel} — ${spanLabel}`;
  else if (fam === 'pent_hex') base = `Pentatonic/Hexatonic — ${pentaLabel} — ${spanLabel}`;
  else if (fam === 'chromatic') base = `Chromatic — ${chromLabel}`;
  else if (fam === 'fifths_fourths') base = `${fifthsTitle} — ${fifthsShape}`;
  else if (fam === 'partials') base = `Bell Partials — ${partialsShape}`;

  const wantCustom = (uiFam === 'custom') || (stateFam0 === 'custom');
  return wantCustom ? `Custom — ${base}` : base;
}

function syncBellPitchSummaryUI() {
  const el = document.getElementById('soundPitchSummary');
  if (!el) return;
  el.textContent = getBellPitchSummaryText();
}

function setBellPitchUiSelection(family) {
  // UI-only selection of the Bell Pitch block. Must NOT mutate mapping / scheduler / audio engine.
  const u = ui._bellPitchUi;
  if (!u) return;
  u.selectedFamily = coerceBellPitchFamily(family);
  syncBellPitchFamilyUI();
  syncBellPitchSummaryUI();
}

function syncBellPitchFamilyUI() {
  const u = ui._bellPitchUi;
  if (!u || !u.cards) return;
  const stateFam = coerceBellPitchFamily(state.bellPitchFamily);
  const uiFam = coerceBellPitchFamily(u.selectedFamily || stateFam);
  if (!u.selectedFamily) u.selectedFamily = uiFam;

  Object.keys(u.cards).forEach((k) => {
    const card = u.cards[k];
    if (!card) return;
    const isOn = (k === uiFam);
    if (card.radio) card.radio.checked = isOn;
    if (card.el) card.el.classList.toggle('is-selected', isOn);
  });
}

function syncBellPitchSpanUI() {
  const u = ui._bellPitchUi;
  if (!u) return;
  const val = (String(state.bellPitchSpan || 'compact') === 'extended') ? 'extended' : 'compact';
  if (u.spanSelectDiatonic) u.spanSelectDiatonic.value = val;
  if (u.spanSelectPentHex) u.spanSelectPentHex.value = val;
}

function maybeApplyDefaultBellPitchSpanForStage(stage) {
  const s = clamp(parseInt(stage, 10) || 0, 4, 12);
  if (state.bellPitchSpanUser) return;
  const desired = (s >= 9) ? 'extended' : 'compact';
  if (String(state.bellPitchSpan || 'compact') !== desired) {
    state.bellPitchSpan = desired;
    syncBellPitchSpanUI();
    syncBellPitchSummaryUI();
  }
}

function setBellPitchFamily(family, forceRebuild) {
  markUserTouchedConfig();
  const fam = coerceBellPitchFamily(family);
  const changed = (state.bellPitchFamily !== fam);
  state.bellPitchFamily = fam;
  try { if (ui._bellPitchUi) ui._bellPitchUi.selectedFamily = fam; } catch (_) {}
  syncBellPitchFamilyUI();
  syncBellPitchSummaryUI();
  if (changed || forceRebuild) {
    rebuildBellFrequencies();
    onBellTuningChanged();
  }
}

function ensureBellPitchPatternBlocks(destEl) {
  if (!destEl) return null;
  if (ui._bellPitchUi && ui._bellPitchUi.built) return ui._bellPitchUi;

  // Build structure inside the Bell Pitch controls container.
  destEl.innerHTML = '';

  const rootWrap = document.createElement('div');
  rootWrap.className = 'rg-bell-pitch-root';
  const rootTitle = document.createElement('div');
  rootTitle.className = 'rg-bell-pitch-root-title';
  rootTitle.textContent = 'Root & Register';
  const rootDest = document.createElement('div');
  rootDest.className = 'rg-controls';
  rootWrap.appendChild(rootTitle);
  rootWrap.appendChild(rootDest);
  destEl.appendChild(rootWrap);

  const blocksDest = document.createElement('div');
  blocksDest.className = 'rg-bell-pitch-blocks';
  destEl.appendChild(blocksDest);

  const makeCard = (family, title, sub) => {
    const el = document.createElement('div');
    el.className = 'rg-pitch-card';
    el.dataset.family = family;

    const checkCol = document.createElement('div');
    checkCol.className = 'rg-pitch-card-check';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'bellPitchFamily';
    radio.value = family;
    radio.id = `bellPitchFamily_${family}`;

    const check = document.createElement('span');
    check.className = 'rg-pitch-check';

    checkCol.appendChild(radio);
    checkCol.appendChild(check);

    const body = document.createElement('div');
    body.className = 'rg-pitch-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'rg-pitch-card-title-row';

    const t = document.createElement('div');
    t.className = 'rg-pitch-card-title';
    t.textContent = title;

    const s = document.createElement('div');
    s.className = 'rg-pitch-card-sub rg-muted';
    s.textContent = sub || '';

    titleRow.appendChild(t);
    titleRow.appendChild(s);

    const controls = document.createElement('div');
    controls.className = 'rg-pitch-card-controls';
    controls.id = `bellPitchControls_${family}`;

    body.appendChild(titleRow);
    body.appendChild(controls);

    el.appendChild(checkCol);
    el.appendChild(body);

    // Click anywhere on the card selects it. Custom selection is UI-only and must not mutate mapping.
    if (family !== 'custom') {
      el.addEventListener('click', () => setBellPitchFamily(family, false));
      radio.addEventListener('change', () => { if (radio.checked) setBellPitchFamily(family, false); });
    } else {
      const pick = () => setBellPitchUiSelection('custom');
      el.addEventListener('click', pick);
      el.addEventListener('pointerdown', pick);
      el.addEventListener('focusin', pick);
      radio.addEventListener('change', () => { if (radio.checked) pick(); });
    }
    return { el, radio, controls };
  };

  // Build cards in the required order.
  const cards = {
    diatonic: makeCard('diatonic', 'Diatonic', 'Major/minor scales'),
    pent_hex: makeCard('pent_hex', 'Pentatonic & Hexatonic', '5–6 note scales'),
    chromatic: makeCard('chromatic', 'Chromatic', 'Semitone steps'),
    fifths_fourths: makeCard('fifths_fourths', 'Fifths & Fourths', 'Stacked intervals'),
    partials: makeCard('partials', 'Harmonic / Bell Partials', 'Overtone ladder'),
    custom: makeCard('custom', 'Custom', 'Per-bell overrides')
  };

  // Append in order.
  blocksDest.appendChild(cards.diatonic.el);
  blocksDest.appendChild(cards.pent_hex.el);
  blocksDest.appendChild(cards.chromatic.el);
  blocksDest.appendChild(cards.fifths_fourths.el);
  blocksDest.appendChild(cards.partials.el);
  blocksDest.appendChild(cards.custom.el);

  // Custom: collapsible per-bell pitch editor (infrastructure unchanged).
  const customDetails = document.createElement('details');
  customDetails.className = 'rg-pitch-custom-details';
  const customSummary = document.createElement('summary');
  customSummary.className = 'rg-pitch-custom-summaryline';
  const customTitle = document.createElement('span');
  customTitle.className = 'rg-pitch-custom-title';
  customTitle.textContent = 'Per-bell pitch editor';
  const customSum = document.createElement('span');
  customSum.className = 'rg-pitch-custom-summary rg-muted';
  customSum.textContent = 'Showing effective pitches';
  const customCaret = document.createElement('span');
  customCaret.className = 'rg-pitch-custom-caret';
  customCaret.setAttribute('aria-hidden', 'true');
  customSummary.appendChild(customTitle);
  customSummary.appendChild(customSum);
  customSummary.appendChild(customCaret);
  const customBody = document.createElement('div');
  customBody.className = 'rg-pitch-custom-body';
  customDetails.appendChild(customSummary);
  customDetails.appendChild(customBody);
  cards.custom.controls.appendChild(customDetails);
  cards.custom.customDetails = customDetails;
  cards.custom.customBody = customBody;

  customDetails.addEventListener('toggle', () => {
    if (!customDetails.open) return;
    try { syncBellOverridesEffectiveUI(); } catch (_) {}
  });


  // Build internal controls (pattern variants).
  const makeSelectControl = (id, labelText, options) => {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;
    const sel = document.createElement('select');
    sel.id = id;
    options.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      sel.appendChild(opt);
    });
    wrap.appendChild(label);
    wrap.appendChild(sel);
    return { wrap, sel };
  };

  // Diatonic: Pitch span
  const spanD = makeSelectControl('bellPitchSpanSelectDiatonic', 'Pitch span', [
    ['compact', 'Compact'],
    ['extended', 'Extended']
  ]);
  cards.diatonic.controls.appendChild(spanD.wrap);

  // Pent/Hex: variant + pitch span
  const pentV = makeSelectControl('bellPitchPentVariantSelect', 'Scale', [
    ['major_pent', 'Major Pentatonic'],
    ['minor_pent', 'Minor Pentatonic'],
    ['whole_tone', 'Whole Tone (Hexatonic)'],
    ['blues_hex', 'Blues Hexatonic']
  ]);
  cards.pent_hex.controls.appendChild(pentV.wrap);

  const spanP = makeSelectControl('bellPitchSpanSelectPentHex', 'Pitch span', [
    ['compact', 'Compact'],
    ['extended', 'Extended']
  ]);
  cards.pent_hex.controls.appendChild(spanP.wrap);

  // Chromatic: direction
  const chromDir = makeSelectControl('bellPitchChromaticDirSelect', 'Direction', [
    ['descending', 'Descending'],
    ['ascending', 'Ascending']
  ]);
  cards.chromatic.controls.appendChild(chromDir.wrap);

  // Fifths & Fourths: type + shape
  const fifthType = makeSelectControl('bellPitchFifthsTypeSelect', 'Ladder', [
    ['fifths', 'Fifths ladder'],
    ['fourths', 'Fourths ladder']
  ]);
  cards.fifths_fourths.controls.appendChild(fifthType.wrap);

  const fifthShape = makeSelectControl('bellPitchFifthsShapeSelect', 'Shape', [
    ['folded', 'Folded'],
    ['ladder', 'Ladder']
  ]);
  cards.fifths_fourths.controls.appendChild(fifthShape.wrap);

  // Partials: shape
  const partShape = makeSelectControl('bellPitchPartialsShapeSelect', 'Shape', [
    ['ladder', 'Ladder'],
    ['folded', 'Folded']
  ]);
  cards.partials.controls.appendChild(partShape.wrap);

  // Store refs.
  ui._bellPitchUi = {
    built: true,
    rootDest,
    cards,
    selectedFamily: coerceBellPitchFamily(state.bellPitchFamily),
    spanSelectDiatonic: spanD.sel,
    spanSelectPentHex: spanP.sel,
    pentVariantSelect: pentV.sel,
    chromDirSelect: chromDir.sel,
    fifthsTypeSelect: fifthType.sel,
    fifthsShapeSelect: fifthShape.sel,
    partialsShapeSelect: partShape.sel
  };

  // Wire events (controls must select their block and apply immediately).
  spanD.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchSpanUser = true;
    state.bellPitchSpan = spanD.sel.value === 'extended' ? 'extended' : 'compact';
    syncBellPitchSpanUI();
    setBellPitchFamily('diatonic', true);
  });

  pentV.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchPentVariant = pentV.sel.value;
    setBellPitchFamily('pent_hex', true);
  });

  spanP.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchSpanUser = true;
    state.bellPitchSpan = spanP.sel.value === 'extended' ? 'extended' : 'compact';
    syncBellPitchSpanUI();
    setBellPitchFamily('pent_hex', true);
  });

  chromDir.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchChromaticDirection = chromDir.sel.value === 'ascending' ? 'ascending' : 'descending';
    setBellPitchFamily('chromatic', true);
  });

  fifthType.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchFifthsType = (fifthType.sel.value === 'fourths') ? 'fourths' : 'fifths';
    setBellPitchFamily('fifths_fourths', true);
  });

  fifthShape.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchFifthsShape = (fifthShape.sel.value === 'ladder') ? 'ladder' : 'folded';
    setBellPitchFamily('fifths_fourths', true);
  });

  partShape.sel.addEventListener('change', () => {
    markUserTouchedConfig();
    state.bellPitchPartialsShape = (partShape.sel.value === 'folded') ? 'folded' : 'ladder';
    setBellPitchFamily('partials', true);
  });

  // Initial sync.
  syncBellPitchSpanUI();
  if (pentV.sel) pentV.sel.value = state.bellPitchPentVariant || 'major_pent';
  if (chromDir.sel) chromDir.sel.value = state.bellPitchChromaticDirection || 'descending';
  if (fifthType.sel) fifthType.sel.value = state.bellPitchFifthsType || 'fifths';
  if (fifthShape.sel) fifthShape.sel.value = state.bellPitchFifthsShape || 'folded';
  if (partShape.sel) partShape.sel.value = state.bellPitchPartialsShape || 'ladder';

  syncBellPitchFamilyUI();
  syncBellPitchSummaryUI();
  return ui._bellPitchUi;
}


  function mountMenuControls() {
    const playDest = document.getElementById('playMenuControls');
    const viewDest = document.getElementById('viewMenuControls');
    const soundDest = document.getElementById('soundMenuControls');
    // v011_p03_sound_layout_drone_first: split Sound menu into Drone / Pitch / Sound containers.
    const soundDroneDest = document.getElementById('soundDroneControls') || soundDest;
    const soundPitchEl = document.getElementById('soundPitchControls');
    const soundPitchDest = soundPitchEl || soundDest;
    const pitchUI = soundPitchEl ? ensureBellPitchPatternBlocks(soundPitchEl) : null;
    const soundPitchRootDest = (pitchUI && pitchUI.rootDest) ? pitchUI.rootDest : soundPitchDest;
    const soundPitchCustomDest = (pitchUI && pitchUI.cards && pitchUI.cards.custom && (pitchUI.cards.custom.customBody || pitchUI.cards.custom.controls))
      ? (pitchUI.cards.custom.customBody || pitchUI.cards.custom.controls)
      : soundPitchDest;

    if (!playDest && !viewDest && !soundDest) return;

    // PLAY
    // v012_p01_setup_blocks_layout: route Setup controls into the five Setup blocks if present.
    const setupLibDest = document.getElementById('setupBlockLibraryBody') || playDest;
    const setupMethodDest = document.getElementById('setupBlockMethodBody') || playDest;
    const setupTempoDest = document.getElementById('setupBlockTempoBody') || playDest;
    const setupBellsDest = document.getElementById('setupBlockBellsBody') || playDest;
    const setupMicDest = document.getElementById('setupBlockMicBody') || playDest;

    moveControlByChildId('methodSelect', setupMethodDest);
    moveControlByChildId('fileInput', setupMethodDest);

    moveControlByChildId('bpmInput', setupTempoDest);

    moveControlByChildId('bellCount', setupBellsDest);
    moveControlByChildId('liveCount', setupBellsDest);
    moveControlByChildId('bellPicker', setupBellsDest);
    moveControlByChildId('keybindPanel', setupBellsDest);

    moveControlByChildId('micToggleBtn', setupMicDest);
    moveControlByChildId('micCooldown', setupMicDest);

    moveControlByChildId('xmlInput', setupLibDest);

    // v06_p12d_library_browser: CCCBR web download + load control (place next to the XML/ZIP upload)
    try {
      const cccb = document.getElementById('setupCCCBRLibraryControl');
      if (cccb && setupLibDest) {
        const xmlCtl = xmlInput ? xmlInput.closest('.control') : null;
        // Keep the XML/ZIP upload first within the Library block (it may start after CCCBR controls in markup).
        if (xmlCtl && xmlCtl.parentElement === setupLibDest && setupLibDest.firstChild !== xmlCtl) {
          setupLibDest.insertBefore(xmlCtl, setupLibDest.firstChild);
        }
        if (xmlCtl && xmlCtl.parentElement === setupLibDest) {
          setupLibDest.insertBefore(cccb, xmlCtl.nextSibling);
        } else {
          setupLibDest.appendChild(cccb);
        }
      }
    } catch (_) {}

    moveControlByChildId('setupExploreLibraryBtn', setupLibDest);

    // v012_p02a_setup_library_info_placement: place loaded-library summary under Library block (above Method)
    const playScreen = document.getElementById('screenPlay');
    const lib = document.getElementById('methodLibrary');
    const setupControls = document.getElementById('playMenuControls');
    const setupBlockMethod = document.getElementById('setupBlockMethod');
    if (lib) {
      if (setupControls && setupBlockMethod && setupBlockMethod.parentElement === setupControls) {
        setupControls.insertBefore(lib, setupBlockMethod);
      } else if (playScreen) {
        playScreen.appendChild(lib);
      }
      lib.classList.add('rg-splash');
      lib.style.width = '100%';
      lib.style.marginTop = '0';
    }

    // VIEW
    moveControlByChildId('viewDisplay', viewDest);
    moveControlByChildId('displayLiveOnly', viewDest);
    moveControlByChildId('accuracyDotsEnabled', viewDest);
    moveControlByChildId('spotlightSwapsView', viewDest);
    moveControlByChildId('notationSwapsOverlay', viewDest);
    moveControlByChildId('pathNoneBtn', viewDest);    // SOUND
    const droneUI = ensureDroneLayersScaffold(soundDroneDest);
    const droneGlobal = (droneUI && droneUI.globalEl) ? droneUI.globalEl : soundDroneDest;
    const droneLayer1Body = (droneUI && droneUI.cards && droneUI.cards[0] && droneUI.cards[0].body) ? droneUI.cards[0].body : soundDroneDest;

    // Global drone controls
    moveControlByChildId('droneOnOffBtn', droneGlobal);
    moveControlByChildId('droneVolume', droneGlobal);

    // Layer 1 (legacy controls)
    moveControlByChildId('droneTypeSelect', droneLayer1Body);
    moveControlByChildId('droneCustomIntervalsInput', droneLayer1Body);
    moveControlByChildId('droneVariantsAnchor', droneLayer1Body);
    moveControlByChildId('droneScaleSelect', droneLayer1Body);
    moveControlByChildId('droneOctaveSelect', droneLayer1Body);
    moveControlByChildId('droneCustomHzInput', droneLayer1Body);
moveControlByChildId('scaleSelect', soundPitchRootDest);
    moveControlByChildId('octaveSelect', soundPitchRootDest);
    moveControlByChildId('bellCustomHzInput', soundPitchRootDest);
    moveControlByChildId('bellOverridesControl', soundPitchCustomDest);

    moveControlByChildId('bellVolume', soundDest);
  }

  // Home / placeholder navigation buttons
  const homeBtnPlay = document.getElementById('homeBtnPlay');
  const homeBtnView = document.getElementById('homeBtnView');
  const homeBtnSound = document.getElementById('homeBtnSound');
  const homeBtnLoad = document.getElementById('homeBtnLoad');
  const homeBtnDemo = document.getElementById('homeBtnDemo');
  const homeBtnBegin = document.getElementById('homeBtnBegin');

  const homeBellLogo = document.getElementById('homeBellLogo');

  const playBtnEnterGame = document.getElementById('playBtnEnterGame');
  const playBtnDemo = document.getElementById('playBtnDemo');

  const viewBtnEnterGame = document.getElementById('viewBtnEnterGame');
  const viewBtnDemo = document.getElementById('viewBtnDemo');

  const soundBtnEnterGame = document.getElementById('soundBtnEnterGame');
  const soundBtnDemo = document.getElementById('soundBtnDemo');

  // v018_p07_restore_defaults_buttons: per-screen restore defaults buttons
  const restoreSetupDefaultsBtn = document.getElementById('restoreSetupDefaultsBtn');
  const restoreViewDefaultsBtn = document.getElementById('restoreViewDefaultsBtn');
  const restoreSoundDefaultsBtn = document.getElementById('restoreSoundDefaultsBtn');


  // v015_p01_load_screen_nav_shell: Load screen bottom nav
  const loadBtnEnterGame = document.getElementById('loadBtnEnterGame');
  const loadBtnDemo = document.getElementById('loadBtnDemo');

  // v015_p02_export_settings_json_generate_copy_save: Load screen export controls
  const loadBtnLoad = document.getElementById('loadBtnLoad');
  const loadBtnLoadFile = document.getElementById('loadBtnLoadFile');
  const loadBtnGenerate = document.getElementById('loadBtnGenerate');
  const loadBtnCopy = document.getElementById('loadBtnCopy');
  const loadBtnSaveFile = document.getElementById('loadBtnSaveFile');
  const loadBtnAppendRun = document.getElementById('loadBtnAppendRun');
  const loadCodeTextarea = document.getElementById('loadCodeTextarea');

  // v015_p02_export_settings_json_generate_copy_save: Export settings metadata modal
  const rgExportSettingsModal = document.getElementById('rgExportSettingsModal');
  const rgExportSettingsModalClose = document.getElementById('rgExportSettingsModalClose');
  const exportSettingsTitleInput = document.getElementById('exportSettingsTitleInput');
  const exportSettingsNameInput = document.getElementById('exportSettingsNameInput');
  const exportSettingsCancelBtn = document.getElementById('exportSettingsCancelBtn');
  const exportSettingsConfirmBtn = document.getElementById('exportSettingsConfirmBtn');
  const exportSettingsIncludeStats = document.getElementById('exportSettingsIncludeStats');
  const exportSettingsStatsPreview = document.getElementById('exportSettingsStatsPreview');

  // v015_p03_import_settings_json_load_text_file: Import result modal
  const rgImportSettingsModal = document.getElementById('rgImportSettingsModal');
  const rgImportSettingsModalClose = document.getElementById('rgImportSettingsModalClose');
  const rgImportSettingsModalOk = document.getElementById('rgImportSettingsModalOk');
  const rgImportSettingsModalTitle = document.getElementById('rgImportSettingsModalTitle');
  const rgImportSettingsModalLines = document.getElementById('rgImportSettingsModalLines');


  // v011_p01_sound_intro_page: Sound Menu Introduction entry link (Sound screen)
  const soundIntroLink = document.getElementById('soundIntroLink');

  // v011_p02_sound_test_instrument_row: Sound menu bell test instrument row
  const soundTestInstrumentRow = document.getElementById('soundTestInstrumentRow');

  const libraryBtnEnterGame = document.getElementById('libraryBtnEnterGame');
  const libraryBtnDemo = document.getElementById('libraryBtnDemo');

  // v09_p04_unified_hamburger_nav: Privacy bottom nav actions
  const privacyBtnDemo = document.getElementById('privacyBtnDemo');

  const setupExploreLibraryBtn = document.getElementById('setupExploreLibraryBtn');
  const setupLoadLibraryLocalBtn = document.getElementById('setupLoadLibraryLocalBtn');

  // v06_p12d_library_browser: Setup CCCBR web download control
  const setupLoadCCCBRWebBtn = document.getElementById('setupLoadCCCBRWebBtn');
  const setupLoadCCCBRWebStatus = document.getElementById('setupLoadCCCBRWebStatus');

  // v06_p12d_library_browser: Library screen browser UI
  const librarySearchInput = document.getElementById('librarySearchInput');
  const libraryBrowseGroups = document.getElementById('libraryBrowseGroups');
  const libraryDetailsEmpty = document.getElementById('libraryDetailsEmpty');
  const libraryDetailsPanel = document.getElementById('libraryDetailsPanel');
  const librarySelectedTitle = document.getElementById('librarySelectedTitle');
  const librarySelectedMeta = document.getElementById('librarySelectedMeta');
  const libraryGlossary = document.getElementById('libraryGlossary');
  const libraryClassGlossary = document.getElementById('libraryClassGlossary');
  const libraryNotes = document.getElementById('libraryNotes');
  const libraryPlaySelectedBtn = document.getElementById('libraryPlaySelectedBtn');
  const libraryDemoSelectedBtn = document.getElementById('libraryDemoSelectedBtn');
  const libraryMethodLoading = document.getElementById('libraryMethodLoading');
  const libraryPreview = document.getElementById('libraryPreview');
  const libraryPreviewPrevBtn = document.getElementById('libraryPreviewPrevBtn');
  const libraryPreviewNextBtn = document.getElementById('libraryPreviewNextBtn');
  const libraryPreviewPageLabel = document.getElementById('libraryPreviewPageLabel');
  const libraryPreviewLimitNote = document.getElementById('libraryPreviewLimitNote');
  const libraryLineBellSelect = document.getElementById('libraryLineBellSelect');
  const libraryNotLoadedNotice = document.getElementById('libraryNotLoadedNotice');
  const libraryGoSetupBtn = document.getElementById('libraryGoSetupBtn');
  const libraryLayout = document.getElementById('libraryLayout');

  // v06_p14a_library_mobile_layout: Library mobile jump helpers
  const libraryJumpRow = document.getElementById('libraryJumpRow');
  const libraryJumpBrowseBtn = document.getElementById('libraryJumpBrowseBtn');
  const libraryJumpDetailsBtn = document.getElementById('libraryJumpDetailsBtn');
  const libraryBrowseAnchor = document.getElementById('libraryBrowseAnchor');
  const libraryDetailsAnchor = document.getElementById('libraryDetailsAnchor');

  // v08_p04_demo_profile_defaults
  // Apply a minimal "demo profile" only on the first Demo of a pristine session.
  // Important: this is session-only; do NOT persist these values to localStorage.
  function applyDemoProfileDefaults() {
    // View (Spotlight): swaps + show N/N+1/N+2
    try {
      state.spotlightSwapsView = true;
      state.spotlightShowN = true;
      state.spotlightShowN1 = true;
      state.spotlightShowN2 = true;

      if (spotlightSwapsView) spotlightSwapsView.checked = true;
      if (spotlightShowN) spotlightShowN.checked = true;
      if (spotlightShowN1) spotlightShowN1.checked = true;
      if (spotlightShowN2) spotlightShowN2.checked = true;
    } catch (_) {}

    // View (Display): "Display scored bell(s) only"
    try {
      state.displayLiveBellsOnly = true;
      if (displayLiveOnly) displayLiveOnly.checked = true;
    } catch (_) {}

    // Play/Setup: 2 scored bells (1 & 2)
    try {
      state.liveCount = 2;
      state.liveBells = [1, 2];
      if (liveCountSelect) liveCountSelect.value = '2';
      rebuildLiveCountOptions();
      ensureLiveBells();
      rebuildBellPicker();
    } catch (_) {}
    // Re-sync view UI (no persistence)
    try { syncSpotlightSwapRowTogglesUI(); } catch (_) {}
    try { syncViewMenuSelectedUI(); } catch (_) {}
    try { markDirty(); kickLoop(); } catch (_) {}
  }

  function startDemoFromUi() {
    if (state.phase !== 'idle') return;

    if (!ui.userTouchedConfig && !ui.hasRunStartedThisSession && state.phase === 'idle') {
      applyDemoProfileDefaults();
    }

    requestAnimationFrame(() => startPressed('demo'));
  }

  function wireUniversalMenuNav() {
    // Universal nav buttons (Home / Setup / View / Sound) across menu screens.
    document.addEventListener('click', (e) => {
      const btn = (e && e.target && e.target.closest) ? e.target.closest('button[data-go-screen]') : null;
      if (!btn) return;
      const go = (btn.dataset && btn.dataset.goScreen) ? btn.dataset.goScreen : '';
      if (!go) return;
      setScreen(go);
    });

    // Enter game (idle) buttons.
    if (playBtnEnterGame) playBtnEnterGame.addEventListener('click', () => setScreen('game'));
    if (viewBtnEnterGame) viewBtnEnterGame.addEventListener('click', () => setScreen('game'));
    if (soundBtnEnterGame) soundBtnEnterGame.addEventListener('click', () => setScreen('game'));
    if (loadBtnEnterGame) loadBtnEnterGame.addEventListener('click', () => setScreen('game'));
    if (libraryBtnEnterGame) libraryBtnEnterGame.addEventListener('click', () => setScreen('game'));

    // Demo buttons (idle only).
    function wireDemo(btn) {
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (state.phase !== 'idle') {
          showStopCurrentRunModal();
          return;
        }
        setScreen('game');
        startDemoFromUi();
      });
    }
    wireDemo(playBtnDemo);
    wireDemo(viewBtnDemo);
    wireDemo(soundBtnDemo);
    wireDemo(loadBtnDemo);
    wireDemo(libraryBtnDemo);
    wireDemo(privacyBtnDemo);
  }

  if (homeBtnPlay) homeBtnPlay.addEventListener('click', () => setScreen('play'));
  if (homeBtnView) homeBtnView.addEventListener('click', () => setScreen('view'));
  if (homeBtnSound) homeBtnSound.addEventListener('click', () => setScreen('sound'));
  if (homeBtnLoad) homeBtnLoad.addEventListener('click', () => setScreen('load'));

  // v015_p02_export_settings_json_generate_copy_save: Export settings JSON (Load screen)
  const SETTINGS_SCHEMA_VERSION = 'rg_settings_v1';

  function deepCloneJsonable(v) {
    // For settings export, we expect plain JSON-able values only.
    try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return clamp(n, min, max);
  }

  function bellNumberMapFromArray(arr, opts) {
    const out = {};
    const o = opts || {};
    const min = Number.isFinite(o.min) ? o.min : null;
    const max = Number.isFinite(o.max) ? o.max : null;
    const skipNearZero = !!o.skipNearZero;
    const toFixed = Number.isFinite(o.toFixed) ? o.toFixed : null;
    if (!Array.isArray(arr)) return out;
    for (let b = 1; b <= 12; b++) {
      const raw = arr[b];
      if (raw == null) continue;
      let n = Number(raw);
      if (!Number.isFinite(n)) continue;
      if (min != null) n = Math.max(min, n);
      if (max != null) n = Math.min(max, n);
      if (skipNearZero && Math.abs(n) < 0.0005) continue;
      if (toFixed != null) {
        try { n = Number(n.toFixed(toFixed)); } catch (_) {}
      }
      out[b] = n;
    }
    return out;
  }

  function bellStringMapFromArray(arr) {
    const out = {};
    if (!Array.isArray(arr)) return out;
    for (let b = 1; b <= 12; b++) {
      const raw = arr[b];
      if (raw == null) continue;
      const s = String(raw);
      if (!s) continue;
      out[b] = s;
    }
    return out;
  }

  function bellObjectMapFromArray(arr, mapFn) {
    const out = {};
    if (!Array.isArray(arr)) return out;
    for (let b = 1; b <= 12; b++) {
      const raw = arr[b];
      if (raw == null) continue;
      const mapped = mapFn ? mapFn(raw, b) : raw;
      if (mapped == null) continue;
      out[b] = mapped;
    }
    return out;
  }

  function sanitizeExportText(s, maxLen) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const m = Math.max(1, parseInt(maxLen, 10) || 80);
    if (!t) return '';
    return (t.length <= m) ? t : t.slice(0, m);
  }

  function fileSlug(s, fallback) {
    const raw = sanitizeExportText(s, 120);
    if (!raw) return (fallback || 'ringer_game');
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9\-\_\s]+/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    return slug || (fallback || 'ringer_game');
  }

  function readLayoutPresetNow() {
    try {
      if (layoutPresetSelect && layoutPresetSelect.value) return String(layoutPresetSelect.value);
    } catch (_) {}
    try {
      const v = safeGetLS(LS_LAYOUT_PRESET);
      if (v) return String(v);
    } catch (_) {}
    return 'auto';
  }

  function readNotationLayoutNow() {
    try {
      if (ui && ui.notationLayout) return String(ui.notationLayout);
    } catch (_) {}
    try {
      const v = safeGetLS(LS_NOTATION_LAYOUT);
      if (v) return String(v);
    } catch (_) {}
    return 'two_page';
  }

  function buildSettingsExportPayload(meta) {
    const createdAtISO = new Date().toISOString();

    const title = meta && meta.title ? sanitizeExportText(meta.title, 90) : '';
    const name = meta && meta.name ? sanitizeExportText(meta.name, 60) : '';

    // Method + attribution
    const method = {
      key: String(state.method || ''),
      source: String(state.methodSource || ''),
      stage: clampInt(state.stage, 1, 12, 6),
      meta: state.methodMeta ? deepCloneJsonable(state.methodMeta) : null,
      customRows: (state.method === 'custom' && state.customRows) ? deepCloneJsonable(state.customRows) : null,
    };

    // Run configuration
    const run = {
      bpm: clampInt(state.bpm, 1, 240, 120),
      liveCount: clampInt(state.liveCount, 0, 12, 1),
      liveBells: Array.isArray(state.liveBells) ? state.liveBells.slice() : [],
      pathBells: Array.isArray(state.pathBells) ? state.pathBells.slice() : [],
      globalChord: state.globalChord ? deepCloneJsonable(state.globalChord) : null,
    };

    // View configuration
    const view = {
      panes: {
        display: !!(viewDisplay && viewDisplay.checked),
        spotlight: !!(viewSpotlight && viewSpotlight.checked),
        notation: !!(viewNotation && viewNotation.checked),
        stats: !!(viewStats && viewStats.checked),
        mic: !!(viewMic && viewMic.checked),
      },
      layoutPreset: readLayoutPresetNow(),
      notationLayout: readNotationLayoutNow(),
      displayLiveBellsOnly: !!state.displayLiveBellsOnly,
      spotlight: {
        swapsView: !!state.spotlightSwapsView,
        showN: !!state.spotlightShowN,
        showN1: !!state.spotlightShowN1,
        showN2: !!state.spotlightShowN2,
      },
      notation: {
        swapsOverlay: !!state.notationSwapsOverlay,
      },
      accuracyDots: {
        enabled: !!state.accuracyDotsEnabled,
        display: !!state.accuracyDotsDisplay,
        notation: !!state.accuracyDotsNotation,
        spotlight: !!state.accuracyDotsSpotlight,
      }
    };

    // Input / glyphs / bindings
    const input = {
      keyBindings: (state.keyBindings && typeof state.keyBindings === 'object') ? deepCloneJsonable(state.keyBindings) : {},
      glyphBindings: (state.glyphBindings && typeof state.glyphBindings === 'object') ? deepCloneJsonable(state.glyphBindings) : {},
      glyphStyle: (state.glyphStyle && typeof state.glyphStyle === 'object') ? deepCloneJsonable(state.glyphStyle) : { defaultColor: '', bellColors: {}, colorOnly: {} },
    };

    // Sound settings (bells + drones + master FX)
    // Note: per-bell overrides are stored as sparse bell-number maps for readability.
    const sound = {
      pitch: {
        scaleKey: String(state.scaleKey || ''),
        octaveC: clampInt(state.octaveC, 1, 6, 4),
        customHz: Number.isFinite(Number(state.bellCustomHz)) ? Number(state.bellCustomHz) : 440,
        bellPitchFamily: String(state.bellPitchFamily || 'diatonic'),
        bellPitchSpan: String(state.bellPitchSpan || 'compact'),
        bellPitchSpanUser: !!state.bellPitchSpanUser,
        bellPitchPentVariant: String(state.bellPitchPentVariant || 'major_pent'),
        bellPitchChromaticDirection: String(state.bellPitchChromaticDirection || 'descending'),
        bellPitchFifthsType: String(state.bellPitchFifthsType || 'fifths'),
        bellPitchFifthsShape: String(state.bellPitchFifthsShape || 'folded'),
        bellPitchPartialsShape: String(state.bellPitchPartialsShape || 'ladder'),
      },
      bells: {
        masterVolume: clampInt(state.bellVolume, 0, 100, 100),
        timbre: {
          ringLength01: clamp(Number(state.bellRingLength) || 0, 0, 1),
          brightness01: clamp(Number(state.bellBrightness) || 0, 0, 1),
          strikeHardness01: clamp(Number(state.bellStrikeHardness) || 0, 0, 1),
        },
        perBellOverrides: {
          hz: bellNumberMapFromArray(state.bellHzOverride, { min: 20, max: 20000, toFixed: 3 }),
          volume: bellNumberMapFromArray(state.bellVolOverride, { min: 0, max: 100, toFixed: 3 }),
          key: bellStringMapFromArray(state.bellKeyOverride),
          octave: bellNumberMapFromArray(state.bellOctaveOverride, { min: 1, max: 6 }),
          pan: bellNumberMapFromArray(state.bellPan, { min: -1, max: 1, skipNearZero: true, toFixed: 3 }),
          depth: bellNumberMapFromArray(state.bellDepth, { min: 0, max: 1, skipNearZero: true, toFixed: 3 }),
          spatialDepthMode: String(state.spatialDepthMode || 'normal'),
          timbre: bellObjectMapFromArray(state.bellTimbreOverrides, (raw) => {
            if (!raw || typeof raw !== 'object') return null;
            const mode = String(raw.mode || 'inherit');
            if (mode !== 'override') return null;
            const out = {
              mode: 'override',
              bellRingLength: clamp(Number(raw.bellRingLength) || 0, 0, 1),
              bellBrightness: clamp(Number(raw.bellBrightness) || 0, 0, 1),
              bellStrikeHardness: clamp(Number(raw.bellStrikeHardness) || 0, 0, 1),
            };
            return out;
          }),
          chords: (() => {
            try { ensureBellChordOverridesArray(); } catch (_) {}
            return bellObjectMapFromArray(state.bellChordOverrides, (raw) => {
              const cfg = sanitizeBellChordOverride(raw || null);
              if (!cfg || cfg.mode !== 'override') return null;
              return {
                mode: 'override',
                enabled: !!cfg.enabled,
                preset: String(cfg.preset || 'unison'),
                inversion: String(cfg.inversion || 'root'),
                spread: String(cfg.spread || 'close'),
                splitStrikeMode: String(cfg.splitStrikeMode || 'inherit'),
                splitStepMs: clamp(parseInt(String(cfg.splitStepMs), 10) || 0, 0, 15),
                splitMaxMs: clamp(parseInt(String(cfg.splitMaxMs), 10) || 0, 0, 18),
                customIntervals: String(cfg.customIntervals || ''),
                customSplitOffsetsMs: String(cfg.customSplitOffsetsMs || ''),
                customDetuneCents: String(cfg.customDetuneCents || ''),
                customLevelGains: String(cfg.customLevelGains || ''),
              };
            });
          })(),
        },
      },
      polyrhythm: (() => {
        const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
        return {
          v: 1,
          enabledForRuns: !!state.polyEnabledForRuns,
          masterVolume: clamp(Number(state.polyMasterVolume) || 0, 0, 100),
          layers: layers.map((l, i) => {
            const layer = coercePolyLayer(l, i);
            return {
              id: layer.id,
              enabled: !!layer.enabled,
              type: layer.type,
              sound: layer.sound,
              interval: layer.interval,
              offset: layer.offset,
              volume: clamp(Number(layer.volume) || 0, 0, 100),
              token: clamp(parseInt(layer.token, 10) || 1, 1, 12),
              phrase: String(layer.phrase || ''),
              bellSound: polyBellSoundToJSON(layer.bellSound),
            // v018_p01_poly_synth_core
            synthPreset: String(layer.synthPreset || ''),
            pitchSource: String(layer.pitchSource || ''),
            pitchBase: clamp(parseInt(String(layer.pitchBase ?? 60), 10) || 60, 0, 127),
            pitchHz: (Number.isFinite(Number(layer.pitchHz)) && Number(layer.pitchHz) > 0) ? Number(layer.pitchHz) : null,
            synthParams: (layer.synthParams && typeof layer.synthParams === 'object' && !Array.isArray(layer.synthParams)) ? layer.synthParams : {},
            percPreset: String(layer.percPreset || ''),
            percParams: (layer.percParams && typeof layer.percParams === 'object' && !Array.isArray(layer.percParams)) ? layer.percParams : {},
              // v018_p01_poly_synth_core
              synthPreset: String(layer.synthPreset || ''),
              pitchSource: String(layer.pitchSource || ''),
              pitchBase: clamp(parseInt(String(layer.pitchBase ?? 60), 10) || 60, 0, 127),
              pitchHz: (Number.isFinite(Number(layer.pitchHz)) && Number(layer.pitchHz) > 0) ? Number(layer.pitchHz) : null,
              synthParams: (layer.synthParams && typeof layer.synthParams === 'object' && !Array.isArray(layer.synthParams)) ? layer.synthParams : {},
              percPreset: String(layer.percPreset || ''),
              percParams: (layer.percParams && typeof layer.percParams === 'object' && !Array.isArray(layer.percParams)) ? layer.percParams : {},
            };
          }),
        };
      })(),
      drones: {
        legacy: {
          on: !!state.droneOn,
          paused: !!state.dronePaused,
          type: String(state.droneType || ''),
          scaleKey: String(state.droneScaleKey || ''),
          octaveC: clampInt(state.droneOctaveC, 1, 6, 3),
          customHz: Number.isFinite(Number(state.droneCustomHz)) ? Number(state.droneCustomHz) : 440,
          volume: clampInt(state.droneVolume, 0, 100, 50),
          variants: {
            normalize: !!state.droneNormalize,
            density: clampInt(state.droneDensity, 0, 16, 3),
            densityByType: (state.droneDensityByType && typeof state.droneDensityByType === 'object') ? deepCloneJsonable(state.droneDensityByType) : {},
            driftCents: clamp(Number(state.droneDriftCents) || 0, 0, 20),
            motionRate: clamp(Number(state.droneMotionRate) || 0, 0, 10),
            clusterWidth: clampInt(state.droneClusterWidth, 1, 10, 3),
            noiseTilt: clamp(Number(state.droneNoiseTilt) || 0, -1, 1),
            noiseQ: clamp(Number(state.droneNoiseQ) || 1, 0.5, 10)
          }
        },
        layers: {
          enabled: !!state.dronesEnabled,
          paused: !!state.dronesPaused,
          masterVolume: clampInt(state.dronesMasterVolume, 0, 100, 50),
          droneLayers: Array.isArray(state.droneLayers) ? deepCloneJsonable(state.droneLayers.slice(0, 4)) : null,
        },
        owner: String(state.droneOwner || 'run'),
      },
      masterFx: {
        limiter: {
          enabled: !!state.fxLimiterEnabled,
          amount01: clamp(Number(state.fxLimiterAmount) || 0, 0, 1),
        },
        reverb: {
          enabled: !!state.fxReverbEnabled,
          size01: clamp(Number(state.fxReverbSize) || 0, 0, 1),
          mix01: clamp(Number(state.fxReverbMix) || 0, 0, 1),
          highCutHz: clamp(Number(state.fxReverbHighCutHz) || 0, 20, 20000),
        }
      }
    };

    const mic = {
      enabled: !!state.micEnabled,
      cooldownMs: clampInt(state.micCooldownMs, 100, 400, 200),
      bells: Array.isArray(state.micBells) ? state.micBells.slice() : [],
      thresholdRms: Number.isFinite(Number(window.micThreshold)) ? Number(window.micThreshold) : null,
    };

    const library = {
      loaded: !!state.libraryLoaded,
      fileName: (state.libraryFileName != null) ? String(state.libraryFileName) : '',
    };

    const privacy = {
      audienceMeasurementConsent: getAudienceConsent(),
    };

    const payload = {
      metadata: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        appVersion: SITE_VERSION,
        createdAtISO,
      },
      config: {
        method,
        run,
        view,
        input,
        sound,
        mic,
        library,
        privacy,
      }
    };

    if (title) payload.metadata.title = title;
    if (name) payload.metadata.name = name;

    // v015_p04_stats_export_import_and_compare: optional statsHistory export (safe default OFF)
    const includeStats = !!(meta && meta.includeStats);
    if (includeStats) {
      const snap = ui.lastRunStatsSnapshot;

      // If a settings JSON was loaded + retained and matches the current scoring signature,
      // carry forward its full stats history (append-only).
      const currentSig = buildScoringSignatureFromState();
      let runs = [];
      try {
        const canCarry = ui.loadedCodePayload && ui.loadedCodeScoringSignature && scoringSignatureEquals(ui.loadedCodeScoringSignature, currentSig);
        if (canCarry && ui.loadedCodePayload.statsHistory != null) {
          runs = normalizeStatsHistoryArray(ui.loadedCodePayload.statsHistory);
        }
      } catch (_) { runs = []; }

      if (snap) {
        const rec = buildStatsRecordFromSnapshot(snap, { title, name }, createdAtISO);
        const rs = rec && rec.runStartedAtISO ? String(rec.runStartedAtISO) : '';
        const dup = rs ? runs.some(r => r && String(r.runStartedAtISO || '') === rs) : false;
        if (!dup) runs.push(rec);
      }

      payload.statsHistory = { runs: runs };
    }

    return payload;
  }

  function stringifySettingsExport(payload) {
    try { return JSON.stringify(payload, null, 2); } catch (_) { return ''; }
  }

  // v015_p04_stats_export_import_and_compare: Stats export/import + matching helpers

  function escapeHtml(s) {
    const str = (s == null) ? '' : String(s);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fnv1a32Hex(str) {
    let h = 0x811c9dc5;
    const s = (str == null) ? '' : String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const hex = (h >>> 0).toString(16);
    return ('00000000' + hex).slice(-8);
  }

  function stableStringifyForHash(v) {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  function hashMethodRows(rows) {
    const raw = stableStringifyForHash(rows);
    return 'fnv1a32:' + fnv1a32Hex(raw);
  }

  function buildScoringSignatureFromState() {
    const stage = clampInt(state.stage, 1, 12, 6);
    const bpm = clampInt(state.bpm, 1, 240, 120);
    const bells = (state.liveBells || []).slice().sort((a, b) => a - b);

    const method = {
      key: String(state.method || ''),
      source: String(state.methodSource || ''),
      stage: stage,
    };

    // Best-effort identity for non-built-in methods
    if (state.methodMeta && state.methodMeta.title) method.title = String(state.methodMeta.title);
    if (state.methodMeta && state.methodMeta.fileName) method.fileName = String(state.methodMeta.fileName);
    if (state.method === 'custom' && Array.isArray(state.customRows)) method.rowsHash = hashMethodRows(state.customRows);

    return {
      method: method,
      tempoBpm: bpm,
      stage: stage,
      scored: { liveCount: bells.length, bells: bells }
    };
  }

  function scoringSignatureEquals(a, b) {
    if (!a || !b) return false;
    const am = a.method || {};
    const bm = b.method || {};
    if (String(am.key || '') !== String(bm.key || '')) return false;
    if (String(am.source || '') !== String(bm.source || '')) return false;
    if (Number(a.stage) !== Number(b.stage)) return false;
    if (Number(am.stage) !== Number(bm.stage)) return false;
    if (Number(a.tempoBpm) !== Number(b.tempoBpm)) return false;

    const as = a.scored || {};
    const bs = b.scored || {};
    const ab = Array.isArray(as.bells) ? as.bells : [];
    const bb = Array.isArray(bs.bells) ? bs.bells : [];
    if (ab.length !== bb.length) return false;
    for (let i = 0; i < ab.length; i++) {
      if (Number(ab[i]) !== Number(bb[i])) return false;
    }
    if (Number(as.liveCount) !== Number(bs.liveCount)) return false;

    // If either side includes extra method identity fields, require a match.
    const at = (am.title != null) ? String(am.title) : '';
    const bt = (bm.title != null) ? String(bm.title) : '';
    if ((at || bt) && at !== bt) return false;

    const afn = (am.fileName != null) ? String(am.fileName) : '';
    const bfn = (bm.fileName != null) ? String(bm.fileName) : '';
    if ((afn || bfn) && afn !== bfn) return false;

    const arh = (am.rowsHash != null) ? String(am.rowsHash) : '';
    const brh = (bm.rowsHash != null) ? String(bm.rowsHash) : '';
    if ((arh || brh) && arh !== brh) return false;

    return true;
  }

  function snapshotPanesEnabled() {
    return {
      display: !!(viewDisplay && viewDisplay.checked),
      spotlight: !!(viewSpotlight && viewSpotlight.checked),
      notation: !!(viewNotation && viewNotation.checked),
      stats: !!(viewStats && viewStats.checked),
      mic: !!(viewMic && viewMic.checked),
    };
  }

  function markRunInputUsed(kind) {
    const p = state.currentPlay;
    if (!p || p.mode !== 'play') return;
    if (!p.inputUsed || typeof p.inputUsed !== 'object') {
      p.inputUsed = { keyboard: false, tap: false, mic: false };
    }
    if (kind === 'keyboard') p.inputUsed.keyboard = true;
    else if (kind === 'tap') p.inputUsed.tap = true;
    else if (kind === 'mic') p.inputUsed.mic = true;
  }

  function safeParseIso(iso) {
    if (!iso) return null;
    const d = new Date(String(iso));
    if (!Number.isFinite(d.getTime())) return null;
    return d;
  }

  function fmtIsoForUi(iso) {
    const d = safeParseIso(iso);
    if (!d) return (iso == null) ? '' : String(iso);
    try { return d.toLocaleString(); } catch (_) { return d.toISOString(); }
  }

  function captureLastRunStatsSnapshot() {
    const p = state.currentPlay;
    if (!p || p.mode !== 'play') return null;

    const live = (state.liveBells || []).slice().sort((a, b) => a - b);
    const perBell = {};
    let totalHits = 0, totalMisses = 0, sumAbs = 0, scoreTotal = 0;

    for (const b of live) {
      const s = state.statsByBell[b] || {};
      const hits = Number(s.hits) || 0;
      const misses = Number(s.misses) || 0;
      const targets = hits + misses;
      const accPct = targets > 0 ? (hits / targets) * 100 : null;
      const maeMs = hits > 0 ? Math.round((Number(s.sumAbsDelta) || 0) / hits) : null;
      const score = Number(s.score) || 0;

      totalHits += hits;
      totalMisses += misses;
      sumAbs += (Number(s.sumAbsDelta) || 0);
      scoreTotal += score;

      perBell[String(b)] = {
        targets: targets,
        hits: hits,
        misses: misses,
        accPct: accPct,
        maeMs: maeMs,
        score: Math.round(score),
        comboBest: Number(s.comboBest) || 0,
      };
    }

    const totalTargets = totalHits + totalMisses;
    const accOverall = totalTargets > 0 ? (totalHits / totalTargets) * 100 : null;
    const maeOverall = totalHits > 0 ? Math.round(sumAbs / totalHits) : null;

    const anyBells = Array.isArray(p.anyBells) ? p.anyBells.slice().sort((a, b) => a - b) : [];
    const panesEnabled = isPlainObject(p.panesEnabled) ? deepCloneJsonable(p.panesEnabled) : snapshotPanesEnabled();
    const inputUsed = (p.inputUsed && typeof p.inputUsed === 'object') ? {
      keyboard: !!p.inputUsed.keyboard,
      tap: !!p.inputUsed.tap,
      mic: !!p.inputUsed.mic,
    } : { keyboard: false, tap: false, mic: false };

    return {
      runStartedAtISO: (p.startedAtISO != null) ? String(p.startedAtISO) : ((p.createdAtISO != null) ? String(p.createdAtISO) : null),
      runEndedAtISO: (p.endedAtISO != null) ? String(p.endedAtISO) : null,
      scoreGlobal: Math.round(scoreTotal),
      totals: {
        hits: totalHits,
        misses: totalMisses,
        targets: totalTargets,
        accPct: accOverall,
        maeMs: maeOverall,
      },
      perBell: perBell,
      scoringSignature: buildScoringSignatureFromState(),
      inputUsed: inputUsed,
      anyBells: anyBells,
      panesEnabled: panesEnabled,
    };
  }

  function buildStatsRecordFromSnapshot(snapshot, meta, savedAtISO) {
    const snap = snapshot || null;
    const savedAt = savedAtISO || new Date().toISOString();

    const rec = {
      id: rid('sh_'),
      savedAtISO: savedAt,
      scoreGlobal: snap ? (Number(snap.scoreGlobal) || 0) : 0,
      MAEms: snap && snap.totals && Number.isFinite(Number(snap.totals.maeMs)) ? Math.round(Number(snap.totals.maeMs)) : null,
      perBell: snap && snap.perBell ? deepCloneJsonable(snap.perBell) : {},
      scoringSignature: snap && snap.scoringSignature ? deepCloneJsonable(snap.scoringSignature) : buildScoringSignatureFromState(),
      inputMethodsUsed: {
        keyboard: !!(snap && snap.inputUsed && snap.inputUsed.keyboard),
        tap: !!(snap && snap.inputUsed && snap.inputUsed.tap),
        mic: !!(snap && snap.inputUsed && snap.inputUsed.mic && (!snap.panesEnabled || (snap.panesEnabled && snap.panesEnabled.mic))),
        anyKeybinding: !!(snap && Array.isArray(snap.anyBells) && snap.anyBells.length),
      },
      anyBells: (snap && Array.isArray(snap.anyBells)) ? snap.anyBells.slice() : [],
      panesEnabled: snap && snap.panesEnabled ? deepCloneJsonable(snap.panesEnabled) : snapshotPanesEnabled(),
    };

    if (snap) {
      if (snap.runStartedAtISO) rec.runStartedAtISO = String(snap.runStartedAtISO);
      if (snap.runEndedAtISO) rec.runEndedAtISO = String(snap.runEndedAtISO);
    }

    const t = meta && meta.title ? sanitizeExportText(meta.title, 90) : '';
    const n = meta && meta.name ? sanitizeExportText(meta.name, 60) : '';
    if (t || n) {
      rec.meta = {};
      if (t) rec.meta.title = t;
      if (n) rec.meta.name = n;
    }

    return rec;
  }

  function normalizeStatsHistoryArray(raw) {
    let arr = [];
    if (Array.isArray(raw)) arr = raw;
    else if (isPlainObject(raw) && Array.isArray(raw.runs)) arr = raw.runs;
    else arr = [];
    const out = [];
    for (const item of arr) {
      if (!isPlainObject(item)) continue;
      const cloned = deepCloneJsonable(item);
      if (!isPlainObject(cloned)) continue;
      out.push(cloned);
    }
    return out;
  }

  function extractHighestGlobalScoreFromStatsHistory(history) {
    if (!Array.isArray(history) || !history.length) return null;
    let best = null;
    for (const r of history) {
      if (!r) continue;
      const n = Number(r.scoreGlobal);
      if (!Number.isFinite(n)) continue;
      best = (best === null) ? n : Math.max(best, n);
    }
    return (best === null) ? null : best;
  }

  function formatInputMethodsSummary(rec) {
    const m = rec && rec.inputMethodsUsed ? rec.inputMethodsUsed : {};
    const parts = [];
    if (m.keyboard) parts.push('keyboard');
    if (m.tap) parts.push('tap');
    if (m.mic) parts.push('mic');
    const base = parts.length ? parts.join(' + ') : '—';

    const anyBells = Array.isArray(rec && rec.anyBells) ? rec.anyBells : [];
    const anyUsed = !!(m.anyKeybinding || (anyBells && anyBells.length));
    if (anyUsed) {
      return base + (anyBells.length ? (' (ANY: ' + anyBells.join(',') + ')') : ' (ANY)');
    }
    return base;
  }


  function formatPanesSummary(panes) {
    const p = panes && typeof panes === 'object' ? panes : {};
    const order = ['display', 'spotlight', 'notation', 'stats', 'mic'];
    const names = {
      display: 'Display',
      spotlight: 'Spotlight',
      notation: 'Notation',
      stats: 'Stats',
      mic: 'Mic'
    };
    const on = [];
    for (const k of order) {
      if (p[k]) on.push(names[k] || k);
    }
    return on.length ? on.join('+') : '—';
  }

  function renderExportStatsPreview() {
    if (!exportSettingsStatsPreview) return;
    const snap = ui.lastRunStatsSnapshot;
    const enabled = !!(exportSettingsIncludeStats && exportSettingsIncludeStats.checked);

    if (!snap) {
      exportSettingsStatsPreview.innerHTML =
        '<div class="muted">' +
        (enabled ? 'No completed run yet – statsHistory.runs will be empty.' : 'No completed run yet.') +
        '</div>';
      return;
    }

    const whenIso = snap.runEndedAtISO || snap.runStartedAtISO || '';
    const when = whenIso ? fmtIsoForUi(whenIso) : '';
    const score = Number.isFinite(Number(snap.scoreGlobal)) ? Math.round(Number(snap.scoreGlobal)) : 0;
    const maeOverall = (snap && snap.totals && snap.totals.maeMs != null) ? Number(snap.totals.maeMs) : null;

    let carryRuns = [];
    let includeLast = true;
    try {
      const currentSig = buildScoringSignatureFromState();
      const canCarry = ui.loadedCodePayload && ui.loadedCodeScoringSignature && scoringSignatureEquals(ui.loadedCodeScoringSignature, currentSig);
      if (canCarry && ui.loadedCodePayload.statsHistory != null) carryRuns = normalizeStatsHistoryArray(ui.loadedCodePayload.statsHistory);
    } catch (_) { carryRuns = []; }
    try {
      const rs = snap.runStartedAtISO ? String(snap.runStartedAtISO) : '';
      if (rs && carryRuns.some(r => r && String(r.runStartedAtISO || '') === rs)) includeLast = false;
    } catch (_) {}
    const runsToInclude = carryRuns.length + (includeLast ? 1 : 0);

    let html = '';
    html += '<div class="muted">' + (enabled ? 'Included in export:' : 'Preview (not included unless enabled):') + '</div>';
    html += '<div><span class="muted">Last run:</span> ' + escapeHtml(when || '—') + '</div>';
    html += '<div><span class="muted">Score:</span> ' + String(score) + '</div>';
    html += '<div><span class="muted">MAE:</span> ' + ((maeOverall == null || !Number.isFinite(maeOverall)) ? '—' : (escapeHtml(fmtMs(maeOverall, false)) + ' ms')) + '</div>';
    html += '<div><span class="muted">Runs' + (enabled ? ' included' : ' if enabled') + ':</span> ' + String(runsToInclude) + (carryRuns.length ? (' (loaded: ' + String(carryRuns.length) + ')') : '') + '</div>';

    const pb = snap.perBell && typeof snap.perBell === 'object' ? snap.perBell : {};
    const bells = Object.keys(pb).map(k => parseInt(k, 10)).filter(n => Number.isFinite(n)).sort((a,b)=>a-b);

    if (bells.length) {
      html += '<table><thead><tr><th>Bell</th><th>Targets</th><th>Hits</th><th>Misses</th><th>Acc%</th><th>MAE</th><th>Score</th></tr></thead><tbody>';
      for (const b of bells) {
        const s = pb[String(b)] || {};
        const targets = Number(s.targets) || 0;
        const hits = Number(s.hits) || 0;
        const misses = Number(s.misses) || 0;
        const acc = (s.accPct == null) ? null : Number(s.accPct);
        const mae = (s.maeMs == null) ? null : Number(s.maeMs);
        const scoreB = Number(s.score) || 0;
        html += '<tr>';
        html += '<td>' + bellToGlyph(b) + '</td>';
        html += '<td>' + String(targets) + '</td>';
        html += '<td>' + String(hits) + '</td>';
        html += '<td>' + String(misses) + '</td>';
        html += '<td>' + (acc == null || !Number.isFinite(acc) ? '&ndash;' : acc.toFixed(0)) + '</td>';
        html += '<td>' + (mae == null || !Number.isFinite(mae) ? '&ndash;' : (fmtMs(mae, false) + ' ms')) + '</td>';
        html += '<td>' + String(Math.round(scoreB)) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    } else {
      html += '<div class="muted">No per-bell stats available.</div>';
    }

    exportSettingsStatsPreview.innerHTML = html;
  }


  function downloadTextFile(filename, text, mime) {
    const fn = String(filename || 'ringer_game_settings.json');
    const data = String(text == null ? '' : text);
    const type = mime || 'application/json';

    try {
      const blob = new Blob([data], { type });
      // IE/Edge legacy
      if (navigator && navigator.msSaveOrOpenBlob) {
        navigator.msSaveOrOpenBlob(blob, fn);
        return true;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fn;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        try { a.remove(); } catch (_) { try { a.parentNode && a.parentNode.removeChild(a); } catch (_) {} }
      }, 0);
      return true;
    } catch (err) {
      console.error('downloadTextFile failed', err);
      return false;
    }
  }

  async function copyTextToClipboard(text) {
    const t = String(text == null ? '' : text);
    if (!t) return false;

    // Prefer async clipboard API
    try {
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (err) {
      // fall through
    }

    // Fallback: hidden textarea + execCommand('copy')
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      try { ta.remove(); } catch (_) { try { ta.parentNode && ta.parentNode.removeChild(ta); } catch (_) {} }
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function setExportSettingsModalOpen(open) {
    if (!rgExportSettingsModal) return;
    rgExportSettingsModal.classList.toggle('hidden', !open);
    try { rgExportSettingsModal.setAttribute('aria-hidden', open ? 'false' : 'true'); } catch (_) {}
  }

  function resolveExportSettingsModal(result) {
    const r = ui._exportSettingsModalResolve;
    ui._exportSettingsModalResolve = null;
    ui._exportSettingsModalMode = null;
    setExportSettingsModalOpen(false);
    if (typeof r === 'function') {
      try { r(result); } catch (_) {}
    }
  }

  function openExportSettingsModal(mode) {
    return new Promise((resolve) => {
      // If modal DOM is missing, fall back to silent meta.
      if (!rgExportSettingsModal || !exportSettingsConfirmBtn || !exportSettingsTitleInput || !exportSettingsNameInput) {
        resolve({ title: '', name: '' });
        return;
      }

      // Close any prior pending modal.
      if (ui._exportSettingsModalResolve) {
        try { ui._exportSettingsModalResolve(null); } catch (_) {}
      }

      ui._exportSettingsModalResolve = resolve;
      ui._exportSettingsModalMode = String(mode || 'generate');

      // Prefill from session draft
      try {
        if (ui._exportSettingsDraft && typeof ui._exportSettingsDraft === 'object') {
          exportSettingsTitleInput.value = String(ui._exportSettingsDraft.title || '');
          exportSettingsNameInput.value = String(ui._exportSettingsDraft.name || '');
        } else {
          exportSettingsTitleInput.value = '';
          exportSettingsNameInput.value = '';
        }
      } catch (_) {}

      // Button label
      const m = ui._exportSettingsModalMode;
      exportSettingsConfirmBtn.textContent = (m === 'save') ? 'Save file' : 'Generate';

      // v015_p04_stats_export_import_and_compare: default OFF (safe)
      try { if (exportSettingsIncludeStats) exportSettingsIncludeStats.checked = false; } catch (_) {}
      renderExportStatsPreview();

      setExportSettingsModalOpen(true);

      // Focus title first (best-effort)
      window.setTimeout(() => {
        try { exportSettingsTitleInput.focus(); } catch (_) {}
        try { exportSettingsTitleInput.select(); } catch (_) {}
      }, 0);
    });
  }

  function bindExportSettingsModalEventsOnce() {
    if (ui._exportSettingsModalEventsBound) return;
    ui._exportSettingsModalEventsBound = true;

    if (rgExportSettingsModal) {
      rgExportSettingsModal.addEventListener('click', (e) => {
        // Clicking on the dimmed backdrop cancels.
        const panel = (e && e.target && e.target.closest) ? e.target.closest('.rg-export-panel') : null;
        if (panel) return;
        resolveExportSettingsModal(null);
      });
    }

    function cancel() { resolveExportSettingsModal(null); }
    function confirm() {
      const title = sanitizeExportText(exportSettingsTitleInput ? exportSettingsTitleInput.value : '', 90);
      const name = sanitizeExportText(exportSettingsNameInput ? exportSettingsNameInput.value : '', 60);
      ui._exportSettingsDraft = { title, name };
      const includeStats = !!(exportSettingsIncludeStats && exportSettingsIncludeStats.checked);
      resolveExportSettingsModal({ title, name, includeStats });
    }

    if (rgExportSettingsModalClose) rgExportSettingsModalClose.addEventListener('click', () => cancel());
    if (exportSettingsCancelBtn) exportSettingsCancelBtn.addEventListener('click', () => cancel());
    if (exportSettingsConfirmBtn) exportSettingsConfirmBtn.addEventListener('click', () => confirm());
    if (exportSettingsIncludeStats) exportSettingsIncludeStats.addEventListener('change', () => renderExportStatsPreview());

    // Keyboard shortcuts within the modal
    if (rgExportSettingsModal) {
      rgExportSettingsModal.addEventListener('keydown', (e) => {
        const k = e && e.key ? String(e.key) : '';
        if (k === 'Escape') {
          try { e.preventDefault(); } catch (_) {}
          try { e.stopPropagation(); } catch (_) {}
          cancel();
          return;
        }
        if (k === 'Enter') {
          // Enter confirms when inside inputs.
          const t = e && e.target;
          const isInput = t && t.tagName && (String(t.tagName).toLowerCase() === 'input');
          if (isInput) {
            try { e.preventDefault(); } catch (_) {}
            try { e.stopPropagation(); } catch (_) {}
            confirm();
          }
        }
      }, true);
    }
  }

  async function generateSettingsJsonToTextarea(meta) {
    const payload = buildSettingsExportPayload(meta || {});
    const json = stringifySettingsExport(payload);
    if (loadCodeTextarea) {
      loadCodeTextarea.value = json;
      try { loadCodeTextarea.scrollTop = 0; } catch (_) {}
    }
    return { payload, json };
  }

  async function loadScreenGenerateClicked() {
    bindExportSettingsModalEventsOnce();
    const meta = await openExportSettingsModal('generate');
    if (!meta) return;
    await generateSettingsJsonToTextarea(meta);
  }


  // v015_p04_stats_export_import_and_compare: Append run to loaded code (append-only)
  function getAppendRunEligibilityInfo() {
    const hasLoaded = !!(ui.loadedCodeRoot && ui.loadedCodePayload);
    const snap = ui.lastRunStatsSnapshot;
    if (!hasLoaded) return { ok: false, reason: 'No loaded code in this session. Load a JSON first.' };
    if (!snap) return { ok: false, reason: 'No completed run available to append. Play a run first.' };
    const runSig = snap && snap.scoringSignature;
    const loadedSig = ui.loadedCodeScoringSignature;
    if (!runSig || !loadedSig || !scoringSignatureEquals(runSig, loadedSig)) {
      return { ok: false, sigMismatch: true, reason: 'Cannot append: the current run settings do not match the loaded save (method/tempo/scored bells).' };
    }
    return { ok: true, snap: snap };
  }

  function updateLoadAppendRunButtonState() {
    if (!loadBtnAppendRun) return;
    const info = getAppendRunEligibilityInfo();
    loadBtnAppendRun.disabled = !info.ok;
    try { loadBtnAppendRun.setAttribute('aria-disabled', info.ok ? 'false' : 'true'); } catch (_) {}
    if (!info.ok) {
      loadBtnAppendRun.title = info.reason || 'Append is not available.';
    } else {
      loadBtnAppendRun.title = 'Append the most recent run stats into the currently-loaded JSON (append-only).';
    }
  }

  async function loadScreenAppendRunClicked() {
    const info = getAppendRunEligibilityInfo();
    if (!info.ok) {
      showImportSettingsModal({ title: 'Append failed', isError: true, lines: [info.reason || 'Append is not available.'] });
      try { updateLoadAppendRunButtonState(); } catch (_) {}
      return;
    }

    const snap = info.snap;
    const nowIso = new Date().toISOString();

    // Optional prompts (blank = skip).
    let authorName = '';
    let note = '';
    try { authorName = sanitizeExportText(window.prompt('Optional: author name/nickname for this append (leave blank to skip):', '') || '', 60); } catch (_) {}
    try { note = sanitizeExportText(window.prompt('Optional: revision note/title (leave blank to skip):', '') || '', 90); } catch (_) {}

    const payload = ui.loadedCodePayload;
    if (!payload || typeof payload !== 'object') {
      showImportSettingsModal({ title: 'Append failed', isError: true, lines: ['No loaded code in this session. Load a JSON first.'] });
      try { updateLoadAppendRunButtonState(); } catch (_) {}
      return;
    }

    // Ensure metadata (preserve existing title/name; do not overwrite).
    if (!isPlainObject(payload.metadata)) payload.metadata = {};

    // Grow metadata.names[] append-only (optional).
    if (authorName) {
      if (!Array.isArray(payload.metadata.names)) payload.metadata.names = [];
      payload.metadata.names.push(authorName);
    }

    // Ensure metadata.revisions[] append-only.
    if (!Array.isArray(payload.metadata.revisions)) payload.metadata.revisions = [];

    // Ensure statsHistory.runs[] (accept legacy array and migrate without loss).
    const existingRuns = normalizeStatsHistoryArray(payload.statsHistory);
    if (isPlainObject(payload.statsHistory)) {
      if (!Array.isArray(payload.statsHistory.runs)) payload.statsHistory.runs = existingRuns;
    } else {
      payload.statsHistory = { runs: existingRuns };
    }

    const recTitle = (payload.metadata && payload.metadata.title) ? String(payload.metadata.title) : '';
    const recName = authorName || ((payload.metadata && payload.metadata.name) ? String(payload.metadata.name) : '');
    const rec = buildStatsRecordFromSnapshot(snap, { title: recTitle, name: recName }, nowIso);
    payload.statsHistory.runs.push(rec);

    // Record revision entry (append-only).
    const rev = { revisedAtISO: nowIso, action: 'append_run', runId: rec.id };
    if (authorName) rev.authorName = authorName;
    if (note) rev.note = note;
    payload.metadata.revisions.push(rev);

    // Update in-memory historic stats for the Stats pane.
    try { if (Array.isArray(ui.loadedStatsHistory)) ui.loadedStatsHistory.push(deepCloneJsonable(rec)); } catch (_) {}

    // Update textarea with updated JSON (pretty printed).
    try {
      const json = JSON.stringify(ui.loadedCodeRoot, null, 2);
      if (loadCodeTextarea) {
        loadCodeTextarea.value = json;
        try { loadCodeTextarea.scrollTop = 0; } catch (_) {}
      }
    } catch (_) {}

    try { updateLoadAppendRunButtonState(); } catch (_) {}

    const totalRuns = (payload.statsHistory && Array.isArray(payload.statsHistory.runs)) ? payload.statsHistory.runs.length : null;
    const msgLines = ['Appended runId: ' + String(rec.id || ''), (totalRuns != null ? ('Total saved runs: ' + String(totalRuns)) : '')].filter(Boolean);
    showImportSettingsModal({ title: 'Appended run', isError: false, lines: msgLines });
  }

  async function loadScreenSaveFileClicked() {
    // If a JSON was loaded and retained in this session, save the current textarea (including any appended history).
    const hasLoaded = !!(ui.loadedCodeRoot && ui.loadedCodePayload);
    if (hasLoaded) {
      let text = '';
      try { text = loadCodeTextarea ? String(loadCodeTextarea.value || '') : ''; } catch (_) { text = ''; }
      if (!text.trim()) {
        try { text = JSON.stringify(ui.loadedCodeRoot, null, 2); } catch (_) { text = ''; }
        if (loadCodeTextarea && text) {
          loadCodeTextarea.value = text;
          try { loadCodeTextarea.scrollTop = 0; } catch (_) {}
        }
      }
      const fn = ui.loadedCodeFileName ? String(ui.loadedCodeFileName) : 'ringer_game_settings.json';
      const ok = downloadTextFile(fn, text, 'application/json');
      if (!ok) alert('Could not download the settings JSON file.');
      return;
    }

    // Default: generate fresh export JSON from current settings.
    bindExportSettingsModalEventsOnce();
    const meta = await openExportSettingsModal('save');
    if (!meta) return;
    const { payload, json } = await generateSettingsJsonToTextarea(meta);
    const title = (payload && payload.metadata && payload.metadata.title) ? String(payload.metadata.title) : '';
    const date = (payload && payload.metadata && payload.metadata.createdAtISO) ? String(payload.metadata.createdAtISO).slice(0, 10) : (new Date().toISOString().slice(0, 10));
    const fn = fileSlug(title, 'ringer_game_settings') + '_' + date + '.json';
    const ok = downloadTextFile(fn, json, 'application/json');
    if (!ok) alert('Could not download the settings JSON file.');
  }

  async function loadScreenCopyClicked() {
    let text = '';
    try { text = loadCodeTextarea ? String(loadCodeTextarea.value || '') : ''; } catch (_) { text = ''; }

    // If there is no JSON yet, generate it first.
    if (!text.trim()) {
      bindExportSettingsModalEventsOnce();
      const meta = await openExportSettingsModal('generate');
      if (!meta) return;
      const out = await generateSettingsJsonToTextarea(meta);
      text = out && out.json ? out.json : '';
    }

    const btn = loadBtnCopy;
    if (btn && !btn.dataset.rgOrigLabel) btn.dataset.rgOrigLabel = String(btn.textContent || '');

    const ok = await copyTextToClipboard(text);
    if (!ok) {
      if (btn && btn.dataset.rgOrigLabel) btn.textContent = btn.dataset.rgOrigLabel;
      alert('Copy failed. You can manually select the JSON and copy it.');
      return;
    }

    if (btn) {
      const orig = btn.dataset.rgOrigLabel || 'Copy code';
      btn.textContent = 'Copied';
      try { if (btn._rgCopyTimer) clearTimeout(btn._rgCopyTimer); } catch (_) {}
      try { btn._rgCopyTimer = setTimeout(() => { try { btn.textContent = orig; } catch (_) {} }, 1500); } catch (_) {}
    }
}



  // v015_p03_import_settings_json_load_text_file: Import settings (textarea + file) + success UX
  function setImportSettingsModalOpen(open) {
    if (!rgImportSettingsModal) return;
    rgImportSettingsModal.classList.toggle('hidden', !open);
    rgImportSettingsModal.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function bindImportSettingsModalEventsOnce() {
    if (ui._importSettingsModalBound) return;
    ui._importSettingsModalBound = true;

    const close = () => setImportSettingsModalOpen(false);

    if (rgImportSettingsModalClose) rgImportSettingsModalClose.addEventListener('click', close);
    if (rgImportSettingsModalOk) rgImportSettingsModalOk.addEventListener('click', close);

    if (rgImportSettingsModal) {
      rgImportSettingsModal.addEventListener('click', (e) => {
        if (e && e.target === rgImportSettingsModal) close();
      });
    }

    document.addEventListener('keydown', (e) => {
      try {
        if (!e || e.key !== 'Escape') return;
        if (!rgImportSettingsModal) return;
        if (rgImportSettingsModal.classList.contains('hidden')) return;
        close();
      } catch (_) {}
    });
  }

  function showImportSettingsModal(opts) {
    bindImportSettingsModalEventsOnce();
    const o = (opts && typeof opts === 'object') ? opts : {};
    const title = String(o.title || 'Loaded successfully');
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const isError = !!o.isError;

    if (rgImportSettingsModalTitle) rgImportSettingsModalTitle.textContent = title;

    if (rgImportSettingsModalLines) {
      rgImportSettingsModalLines.innerHTML = '';
      for (const line of lines) {
        const div = document.createElement('div');
        const s = String(line || '');
        const isWarn = !isError && (s.startsWith('⚠') || s.startsWith('↳'));
        div.className = 'rg-import-line' + ((isError || isWarn) ? '' : ' rg-muted');
        div.textContent = s;
        rgImportSettingsModalLines.appendChild(div);
      }
    }

    setImportSettingsModalOpen(true);
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function coerceEnum(raw, allowed, fallback) {
    const v = String(raw || '');
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function isValidScaleKey(rawKey) {
    const k = String(rawKey || '').trim();
    if (!k) return false;
    if (k === 'custom_hz') return true;
    try {
      for (const s of SCALE_LIBRARY) {
        if (s && s.key === k) return true;
      }
    } catch (_) {}
    return false;
  }

  function deepMergeJson(base, patch) {
    if (typeof patch === 'undefined') return base;
    if (Array.isArray(patch)) return patch.slice();
    if (!isPlainObject(patch)) return patch;

    const out = isPlainObject(base) ? Object.assign({}, base) : {};
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (typeof pv === 'undefined') continue;
      const bv = out[k];
      if (Array.isArray(pv)) out[k] = pv.slice();
      else if (isPlainObject(pv) && isPlainObject(bv)) out[k] = deepMergeJson(bv, pv);
      else if (isPlainObject(pv) && !isPlainObject(bv)) out[k] = deepMergeJson({}, pv);
      else out[k] = pv;
    }
    return out;
  }

  function normalizeImportedSettingsPayload(raw) {
    if (!isPlainObject(raw)) throw new Error('JSON must be an object.');

    // Allow wrappers (future/legacy)
    let payload = raw;
    if (isPlainObject(raw.settings) && (raw.settings.config || raw.settings.metadata)) payload = raw.settings;

    const metadata = isPlainObject(payload.metadata) ? payload.metadata : (isPlainObject(raw.metadata) ? raw.metadata : {});
    let config = isPlainObject(payload.config) ? payload.config : null;

    // Legacy: treat the object itself as config if it looks like a config.
    if (!config && (isPlainObject(payload.method) || isPlainObject(payload.run) || isPlainObject(payload.view) || isPlainObject(payload.sound) || isPlainObject(payload.input))) {
      config = payload;
    }
    if (!config && isPlainObject(raw.config)) config = raw.config;

    if (!config) throw new Error('Missing "config" object (settings export).');

    // schemaVersion: prefer metadata.schemaVersion; else look in root/config
    if (!metadata.schemaVersion) {
      const sv = (payload && payload.schemaVersion) ? payload.schemaVersion : (raw && raw.schemaVersion) ? raw.schemaVersion : (config && config.schemaVersion) ? config.schemaVersion : '';
      if (sv) metadata.schemaVersion = sv;
    }

    // Optional stats: root.stats or payload.stats (any shape)
    let stats = null;
    if (typeof payload.stats !== 'undefined') stats = payload.stats;
    else if (typeof raw.stats !== 'undefined') stats = raw.stats;

    // v015_p04_stats_export_import_and_compare: optional statsHistory (array of summary records)
    let statsHistory = null;
    if (typeof payload.statsHistory !== 'undefined') statsHistory = payload.statsHistory;
    else if (typeof raw.statsHistory !== 'undefined') statsHistory = raw.statsHistory;

    return { metadata, config, stats, statsHistory };
  }

  function validateImportedSettingsPayload(norm) {
    const metadata = norm && norm.metadata;
    const config = norm && norm.config;

    if (!isPlainObject(config)) throw new Error('Invalid "config": expected an object.');
    if (!isPlainObject(config.method)) throw new Error('Missing required field: config.method');
    if (typeof config.method.key === 'undefined' || String(config.method.key || '').trim() === '') throw new Error('Missing required field: config.method.key');

    const stageNum = Number(config.method.stage);
    if (!Number.isFinite(stageNum) || stageNum < 4 || stageNum > 12) throw new Error('Invalid method.stage (expected 4-12).');

    const methodKey = String(config.method.key || '').trim();
    const okMethods = ['plainhunt', 'plainbob', 'grandsire', 'custom'];
    if (okMethods.indexOf(methodKey) < 0) throw new Error('Unknown method.key: ' + methodKey);

    const stage = clampInt(stageNum, 4, 12, 6);

    const sv = (metadata && typeof metadata.schemaVersion !== 'undefined') ? String(metadata.schemaVersion || '').trim() : '';
    if (sv) {
      if (sv.length > 80) throw new Error('Invalid schemaVersion (too long).');
      // Accept any "rg_settings_*" schemaVersion (legacy) or the current one.
      if (!(sv === SETTINGS_SCHEMA_VERSION || sv.indexOf('rg_settings_') === 0)) {
        throw new Error('Unsupported schemaVersion: ' + sv);
      }
    }

    return { methodKey, stage, schemaVersion: sv || '' };
  }

  function extractHighestGlobalScoreFromStats(stats) {
    if (stats === null || typeof stats === 'undefined') return null;
    let best = null;

    const tryNum = (x) => {
      const n = Number(x);
      if (!Number.isFinite(n)) return;
      best = (best === null) ? n : Math.max(best, n);
    };

    // Prefer explicit fields.
    const scanPreferred = (node, depth) => {
      if (depth > 7) return;
      if (node === null || typeof node === 'undefined') return;
      if (Array.isArray(node)) { for (const v of node) scanPreferred(v, depth + 1); return; }
      if (!isPlainObject(node)) return;

      for (const [k, v] of Object.entries(node)) {
        const key = String(k || '').toLowerCase();
        const preferred = (key.includes('globalscore') || key.includes('global_score') || key.includes('scoreglobal') ||
                           key.includes('totalscore') || key.includes('scoretotal') || key.includes('highscore') || key.includes('bestscore'));
        if (preferred && (typeof v === 'number' || typeof v === 'string')) tryNum(v);
        else scanPreferred(v, depth + 1);
      }
    };

    const scanFallback = (node, depth) => {
      if (best !== null) return;
      if (depth > 6) return;
      if (node === null || typeof node === 'undefined') return;
      if (Array.isArray(node)) { for (const v of node) scanFallback(v, depth + 1); return; }
      if (!isPlainObject(node)) return;

      for (const [k, v] of Object.entries(node)) {
        const key = String(k || '').toLowerCase();
        // Fallback: only count "score" keys if they look global-ish.
        if ((key === 'score' || key.includes('score')) && (key.includes('total') || key.includes('global'))) {
          if (typeof v === 'number' || typeof v === 'string') tryNum(v);
        } else {
          scanFallback(v, depth + 1);
        }
      }
    };

    try { scanPreferred(stats, 0); } catch (_) {}
    try { scanFallback(stats, 0); } catch (_) {}

    return (best === null || !Number.isFinite(best)) ? null : best;
  }

  function applyImportedSettingsConfig(cfg, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const applyPrivacy = !!o.applyPrivacy;
    const privacyValue = (typeof o.privacyValue === 'undefined') ? '' : String(o.privacyValue || '').trim();
    const importedConfig = (o && isPlainObject(o.importedConfig)) ? o.importedConfig : null;
    const srcCfg = importedConfig || cfg;


    // v015_p03a_load_hotfix_glyphs_typing_ui: fail-open optional ensure* helpers during import apply.
    const safeEnsure = (label, fn) => {
      if (typeof fn !== 'function') return;
      try { fn(); } catch (_) {}
    };

    // Large config changes should stop the run first (mirrors other settings changes).
    safeEnsure('ensureIdleForPlayChange', (typeof ensureIdleForPlayChange === 'function') ? ensureIdleForPlayChange : null);

    
    // v015_p03b_load_hotfix_mic_const_popup_copy: fail-open per-section import apply guardrail.
    const importSectionErrors = {};
    const importSkipped = [];
    const importCoreOk = { method: true, run: true, view: true, input: true, sound: true };

    // v015_p05a_load_drone_pause_and_volume_fix: allow load-time drone intent to override auto-start
    const importDronesHint = isPlainObject(o.dronesHint) ? o.dronesHint : null;
    let dronesForcedPaused = false;

    const truncateImportErr = (s, maxLen) => {
      const m = (typeof maxLen === 'number' && maxLen > 20) ? Math.floor(maxLen) : 140;
      let out = '';
      try { out = String(s || ''); } catch (_) { out = ''; }
      out = out.replace(/\s+/g, ' ').trim();
      if (out.length > m) out = out.slice(0, m - 1) + '…';
      return out;
    };

    const recordImportSkip = (section, err, isCore) => {
      const key = String(section || '').trim() || 'unknown';
      if (!Object.prototype.hasOwnProperty.call(importSectionErrors, key)) {
        const msg = err && err.message ? String(err.message) : String(err || 'Error');
        importSectionErrors[key] = truncateImportErr(msg, 140);
      }
      if (!importSkipped.includes(key)) importSkipped.push(key);
      if (isCore && Object.prototype.hasOwnProperty.call(importCoreOk, key)) importCoreOk[key] = false;
    };

    let stage = state.stage;
    let sound = {};

    try {
// --- Method + stage ---
    const method = isPlainObject(cfg.method) ? cfg.method : {};
    stage = clampInt(Number(method.stage), 4, 12, 6);
    state.stage = stage;
    if (bellCountSelect) bellCountSelect.value = String(stage);

    const methodKey = String(method.key || '').trim();
    state.method = methodKey;

    if (methodKey === 'custom') {
      const src = String(method.source || '').trim();
      state.methodSource = (src === 'library' || src === 'custom_rows') ? src : 'custom_rows';
      state.methodMeta = isPlainObject(method.meta) ? deepCloneJsonable(method.meta) : null;
      state.customRows = Array.isArray(method.customRows) ? deepCloneJsonable(method.customRows) : null;
    } else {
      state.methodSource = 'built_in';
      state.methodMeta = null;
      state.customRows = null;
    }

    computeRows();

    
    } catch (e) {
      recordImportSkip('method', e, true);
    }

    try {
// --- Run config ---
    const run = isPlainObject(cfg.run) ? cfg.run : {};
    state.bpm = clampInt(Number(run.bpm), 1, 240, 120);
    if (bpmInput) bpmInput.value = String(state.bpm);
    if (bpmSlider) bpmSlider.value = String(state.bpm);

    state.liveCount = clampInt(Number(run.liveCount), 1, stage, stage);
    rebuildLiveCountOptions();
    if (liveCountSelect) liveCountSelect.value = String(state.liveCount);

    if (Array.isArray(run.liveBells)) state.liveBells = run.liveBells.slice();
    safeEnsure('ensureLiveBells', (typeof ensureLiveBells === 'function') ? ensureLiveBells : null);
    if (Array.isArray(run.pathBells)) state.pathBells = run.pathBells.slice();
    safeEnsure('ensurePathBells', (typeof ensurePathBells === 'function') ? ensurePathBells : null);

    rebuildBellPicker();
    rebuildPathPicker();

    // Global chord
    if (Object.prototype.hasOwnProperty.call(run, 'globalChord')) {
      state.globalChord = sanitizeGlobalChordConfig(run.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    }

    
    } catch (e) {
      recordImportSkip('run', e, true);
    }

    try {
// --- View ---
    const view = isPlainObject(cfg.view) ? cfg.view : {};

    if (isPlainObject(view.panes)) {
      if (viewDisplay) viewDisplay.checked = !!view.panes.display;
      if (viewSpotlight) viewSpotlight.checked = !!view.panes.spotlight;
      if (viewNotation) viewNotation.checked = !!view.panes.notation;
      if (viewStats) viewStats.checked = !!view.panes.stats;
      if (viewMic) viewMic.checked = !!view.panes.mic;
    }

    if (typeof view.layoutPreset !== 'undefined') {
      safeSetLS(LS_LAYOUT_PRESET, String(view.layoutPreset || 'auto'));
      syncLayoutPresetUI();
    }

    if (typeof view.notationLayout !== 'undefined') {
      safeSetLS(LS_NOTATION_LAYOUT, String(view.notationLayout || 'compact'));
      syncNotationLayoutUI();
    }

    if (typeof view.displayLiveBellsOnly !== 'undefined') {
      state.displayLiveBellsOnly = !!view.displayLiveBellsOnly;
      if (displayLiveOnly) displayLiveOnly.checked = state.displayLiveBellsOnly;
      safeSetBoolLS(LS_DISPLAY_LIVE_BELLS_ONLY, state.displayLiveBellsOnly);
    }

    if (isPlainObject(view.spotlight)) {
      if (typeof view.spotlight.swapsView !== 'undefined') {
        state.spotlightSwapsView = !!view.spotlight.swapsView;
        if (spotlightSwapsView) spotlightSwapsView.checked = state.spotlightSwapsView;
        safeSetBoolLS(LS_SPOTLIGHT_SWAPS_VIEW, state.spotlightSwapsView);
        syncSpotlightSwapRowTogglesUI();
      }

      if (typeof view.spotlight.showN !== 'undefined') { if (spotlightShowN) spotlightShowN.checked = !!view.spotlight.showN; }
      if (typeof view.spotlight.showN1 !== 'undefined') { if (spotlightShowN1) spotlightShowN1.checked = !!view.spotlight.showN1; }
      if (typeof view.spotlight.showN2 !== 'undefined') { if (spotlightShowN2) spotlightShowN2.checked = !!view.spotlight.showN2; }
      syncSpotlightRowPrefsFromUI();
    }

    if (isPlainObject(view.notation) && typeof view.notation.swapsOverlay !== 'undefined') {
      state.notationSwapsOverlay = !!view.notation.swapsOverlay;
      if (notationSwapsOverlay) notationSwapsOverlay.checked = state.notationSwapsOverlay;
      safeSetBoolLS(LS_NOTATION_SWAPS_OVERLAY, state.notationSwapsOverlay);
      syncViewMenuSelectedUI();
    }

    if (isPlainObject(view.accuracyDots)) {
      if (typeof view.accuracyDots.enabled !== 'undefined' && accuracyDotsEnabled) accuracyDotsEnabled.checked = !!view.accuracyDots.enabled;
      if (typeof view.accuracyDots.display !== 'undefined' && accuracyDotsDisplay) accuracyDotsDisplay.checked = !!view.accuracyDots.display;
      if (typeof view.accuracyDots.notation !== 'undefined' && accuracyDotsNotation) accuracyDotsNotation.checked = !!view.accuracyDots.notation;
      if (typeof view.accuracyDots.spotlight !== 'undefined' && accuracyDotsSpotlight) accuracyDotsSpotlight.checked = !!view.accuracyDots.spotlight;
      syncAccuracyDotsPrefsFromUI();
    }

    syncViewLayout();

    
    } catch (e) {
      recordImportSkip('view', e, true);
    }

    try {
// --- Input / bindings ---
    const input = isPlainObject(srcCfg.input) ? srcCfg.input : {};
    const kbPresent = Object.prototype.hasOwnProperty.call(input, 'keyBindings');
    if (kbPresent && isPlainObject(input.keyBindings)) {
      state.keyBindings = deepCloneJsonable(input.keyBindings);
      safeEnsure('ensureKeyBindings', (typeof ensureKeyBindings === 'function') ? ensureKeyBindings : null);
      saveKeyBindings();
      rebuildKeybindPanel();
    } else {
      try { resetKeyBindingsToDefaults(); } catch (_) {}
      try { rebuildKeybindPanel(); } catch (_) {}
      if (kbPresent && !isPlainObject(input.keyBindings)) recordImportSkip('keyBindings', new Error('Invalid keyBindings; reset to defaults'), false);
    }

    const gbPresent = Object.prototype.hasOwnProperty.call(input, 'glyphBindings');
    if (gbPresent && isPlainObject(input.glyphBindings)) {
      state.glyphBindings = deepCloneJsonable(input.glyphBindings);
      safeEnsure('ensureGlyphBindings', (typeof ensureGlyphBindings === 'function') ? ensureGlyphBindings : null);
      saveGlyphBindings();
    } else {
      safeDelLS(LS_GLYPHBINDS);
      try { loadGlyphBindings(); } catch (_) {}
      safeEnsure('ensureGlyphBindings', (typeof ensureGlyphBindings === 'function') ? ensureGlyphBindings : null);
      if (gbPresent && !isPlainObject(input.glyphBindings)) recordImportSkip('glyphBindings', new Error('Invalid glyphBindings; reset to defaults'), false);
    }

    const gsPresent = Object.prototype.hasOwnProperty.call(input, 'glyphStyle');
    if (gsPresent && isPlainObject(input.glyphStyle)) {
      state.glyphStyle = deepCloneJsonable(input.glyphStyle);
      safeEnsure('ensureGlyphStyleState', (typeof ensureGlyphStyleState === 'function') ? ensureGlyphStyleState : null);
      saveGlyphStyle();
    } else {
      safeDelLS(LS_GLYPHSTYLE);
      try { loadGlyphStyle(); } catch (_) {}
      safeEnsure('ensureGlyphStyleState', (typeof ensureGlyphStyleState === 'function') ? ensureGlyphStyleState : null);
      if (gsPresent && !isPlainObject(input.glyphStyle)) recordImportSkip('glyphStyle', new Error('Invalid glyphStyle; reset to defaults'), false);
    }
    } catch (e) {
      recordImportSkip('input', e, true);
    }

    try {
// --- Mic prefs ---
    const micPresent = Object.prototype.hasOwnProperty.call(srcCfg, 'mic');
    // Stop capture before mutating prefs to avoid dangling audio state.
    try { setMicEnabled(false, { source: 'import' }); } catch (_) {}
    // Clear persisted mic keys so sparse imports can't inherit prior values.
    safeDelLS(LS_MIC_ENABLED);
    safeDelLS(LS_MIC_BELLS);
    safeDelLS(LS_MIC_THRESHOLD);
    safeDelLS(LS_MIC_COOLDOWN_MS);
    safeDelLS(OLD_LS_MIC_THRESHOLD_DB);

    const mic = (micPresent && isPlainObject(srcCfg.mic)) ? srcCfg.mic : null;
    if (mic) {
      if (typeof mic.enabled !== 'undefined') safeSetBoolLS(LS_MIC_ENABLED, !!mic.enabled);
      if (Array.isArray(mic.bells)) safeSetLS(LS_MIC_BELLS, mic.bells.slice().join(','));
      if (typeof mic.thresholdRms !== 'undefined') safeSetLS(LS_MIC_THRESHOLD, String(Number(mic.thresholdRms) || 0));
      if (typeof mic.cooldownMs !== 'undefined') safeSetLS(LS_MIC_COOLDOWN_MS, String(clampInt(Number(mic.cooldownMs), 100, 400, 200)));
    } else {
      if (micPresent) recordImportSkip('mic', new Error('Invalid mic prefs; reset to defaults'), false);
    }

    loadMicPrefs();
    if (mic && typeof mic.enabled !== 'undefined') setMicEnabled(!!mic.enabled, { source: 'import' });
    } catch (e) {
      recordImportSkip('mic', e, false);
    }

    try {
// --- Library state (informational) ---
    const lib = isPlainObject(cfg.library) ? cfg.library : null;
    if (lib) {
      if (typeof lib.loaded !== 'undefined') state.libraryLoaded = !!lib.loaded;
      if (typeof lib.fileName !== 'undefined') state.libraryFileName = String(lib.fileName || '');
    }

    
    } catch (e) {
      recordImportSkip('library', e, false);
    }

    try {
// --- Sound ---
    sound = isPlainObject(cfg.sound) ? cfg.sound : {};

    // Pitch / scale
    const pitch = isPlainObject(sound.pitch) ? sound.pitch : {};
    if (typeof pitch.scaleKey !== 'undefined') {
      const nextScaleKey = String(pitch.scaleKey || '');
      if (isValidScaleKey(nextScaleKey)) state.scaleKey = nextScaleKey;
    }
    if (typeof pitch.octaveC !== 'undefined') state.octaveC = clampInt(Number(pitch.octaveC), 1, 6, 4);
    if (typeof pitch.customHz !== 'undefined') state.bellCustomHz = clamp(Number(pitch.customHz) || 440, 20, 20000);
    if (typeof pitch.bellPitchFamily !== 'undefined') state.bellPitchFamily = coerceBellPitchFamily(String(pitch.bellPitchFamily || 'diatonic'));
    if (typeof pitch.bellPitchSpan !== 'undefined') state.bellPitchSpan = (String(pitch.bellPitchSpan) === 'extended') ? 'extended' : 'compact';
    if (typeof pitch.bellPitchSpanUser !== 'undefined') state.bellPitchSpanUser = !!pitch.bellPitchSpanUser;

    if (typeof pitch.bellPitchPentVariant !== 'undefined') state.bellPitchPentVariant = coerceEnum(pitch.bellPitchPentVariant, ['major_pent', 'minor_pent', 'whole_tone', 'blues_hex'], 'major_pent');
    if (typeof pitch.bellPitchChromaticDirection !== 'undefined') state.bellPitchChromaticDirection = coerceEnum(pitch.bellPitchChromaticDirection, ['ascending', 'descending'], 'ascending');
    if (typeof pitch.bellPitchFifthsType !== 'undefined') state.bellPitchFifthsType = coerceEnum(pitch.bellPitchFifthsType, ['circle', 'line'], 'circle');
    if (typeof pitch.bellPitchFifthsShape !== 'undefined') state.bellPitchFifthsShape = coerceEnum(pitch.bellPitchFifthsShape, ['soft', 'hard'], 'soft');
    if (typeof pitch.bellPitchPartialsShape !== 'undefined') state.bellPitchPartialsShape = coerceEnum(pitch.bellPitchPartialsShape, ['harmonic', 'inharmonic'], 'harmonic');

    if (scaleSelect) scaleSelect.value = String(state.scaleKey || '');
    if (octaveSelect) octaveSelect.value = String(state.octaveC || 4);
    if (bellCustomHzInput) bellCustomHzInput.value = String(Number.isFinite(Number(state.bellCustomHz)) ? state.bellCustomHz : 440);
    syncBellCustomHzUI();
    syncBellPitchFamilyUI();
    syncBellPitchSpanUI();
    syncBellPitchSummaryUI();

    rebuildBellFrequencies();
    try { onBellTuningChanged(); } catch (_) {}

    const bells = isPlainObject(sound.bells) ? sound.bells : {};
    const soundSrc = isPlainObject(srcCfg.sound) ? srcCfg.sound : {};
    const bellsSrc = isPlainObject(soundSrc.bells) ? soundSrc.bells : {};
    const pboPresent = Object.prototype.hasOwnProperty.call(bellsSrc, 'perBellOverrides');
    const pbo = isPlainObject(bellsSrc.perBellOverrides) ? bellsSrc.perBellOverrides : null;
    // v015_p05b_load_no_leak_between_imports: sparse imports must not retain prior per-bell overrides.
    try { resetAllBellOverrides(); } catch (_) {}
    try { state.bellPan = new Array(13).fill(0); } catch (_) {}
    try { state.bellDepth = new Array(13).fill(0); } catch (_) {}
    try { state.spatialDepthMode = 'normal'; } catch (_) {}
    safeDelLS(LS_BELL_PAN);
    safeDelLS(LS_BELL_DEPTH);
    safeDelLS(LS_SPATIAL_DEPTH_MODE);
    if (pboPresent && !pbo) recordImportSkip('perBellOverrides', new Error('Invalid perBellOverrides; reset to defaults'), false);

    if (typeof bells.masterVolume !== 'undefined') {
      state.bellVolume = clampInt(Number(bells.masterVolume), 0, 100, 100);
      if (bellVolume) bellVolume.value = String(state.bellVolume);
      applyBellMasterGain(true);
    }

    // Global bell timbre
    if (isPlainObject(bells.timbre)) {
      const t = bells.timbre;
      if (typeof t.ringLength01 !== 'undefined') state.bellRingLength = clamp(Number(t.ringLength01) || 0, 0, 1);
      if (typeof t.brightness01 !== 'undefined') state.bellBrightness = clamp(Number(t.brightness01) || 0, 0, 1);
      if (typeof t.strikeHardness01 !== 'undefined') state.bellStrikeHardness = clamp(Number(t.strikeHardness01) || 0, 0, 1);
      saveBellTimbreToLS();
      syncBellTimbreUI();
    }

    // Per-bell overrides: persist via existing LS formats, then re-load.
    const setOrClearMap = (lsKey, mapObj) => {
      try {
        if (mapObj && isPlainObject(mapObj) && Object.keys(mapObj).length) safeSetLS(lsKey, JSON.stringify(mapObj));
        else safeDelLS(lsKey);
      } catch (_) { safeDelLS(lsKey); }
    };

    if (pbo) {
      setOrClearMap(LS_BELL_HZ_OVERRIDE, isPlainObject(pbo.hz) ? pbo.hz : null);
      setOrClearMap(LS_BELL_VOL_OVERRIDE, isPlainObject(pbo.volume) ? pbo.volume : null);
      setOrClearMap(LS_BELL_KEY_OVERRIDE, isPlainObject(pbo.key) ? pbo.key : null);
      setOrClearMap(LS_BELL_OCT_OVERRIDE, isPlainObject(pbo.octave) ? pbo.octave : null);
      setOrClearMap(LS_BELL_PAN, isPlainObject(pbo.pan) ? pbo.pan : null);
      setOrClearMap(LS_BELL_DEPTH, isPlainObject(pbo.depth) ? pbo.depth : null);

      if (typeof pbo.spatialDepthMode !== 'undefined') {
        state.spatialDepthMode = String(pbo.spatialDepthMode || 'static');
        saveSpatialDepthModeToLS();
      }

      setOrClearMap(LS_BELL_TIMBRE_OVERRIDES, isPlainObject(pbo.timbre) ? pbo.timbre : null);
      setOrClearMap(LS_BELL_CHORD_OVERRIDES, isPlainObject(pbo.chords) ? pbo.chords : null);
    }

    loadBellOverridesFromLS();
    loadBellTimbreOverridesFromLS();
    loadBellChordOverridesFromLS();

    rebuildBellFrequencies();
    try { onBellTuningChanged(); } catch (_) {}
    rebuildBellOverridesUI();
    applyBellPanToAudio();
    applyBellDepthToAudio();

    
    } catch (e) {
      recordImportSkip('sound', e, true);
    }

    try {
// --- Polyrhythm ---
    const soundSrc = isPlainObject(srcCfg.sound) ? srcCfg.sound : {};
    const polyPresent = Object.prototype.hasOwnProperty.call(soundSrc, 'polyrhythm');
    const polyCfg = (polyPresent && isPlainObject(soundSrc.polyrhythm)) ? soundSrc.polyrhythm : null;

    if (polyCfg) {
      const runActive = !!(state.mode === 'method' && (state.phase === 'countdown' || state.phase === 'running'));
      const testActive = !!polyTestActive;
      const wasActive = !!(testActive || (runActive && state.polyEnabledForRuns));

      // v017_p03_polyrhythm_load_save: reset to defaults first so sparse imports can't leak prior state.
      state.polyEnabledForRuns = false;
      state.polyMasterVolume = 80;
      state.polyLayers = [];

      if (typeof polyCfg.enabledForRuns !== 'undefined') state.polyEnabledForRuns = !!polyCfg.enabledForRuns;
      if (typeof polyCfg.masterVolume !== 'undefined') state.polyMasterVolume = clamp(Number(polyCfg.masterVolume) || 0, 0, 100);

      if (Array.isArray(polyCfg.layers)) {
        state.polyLayers = polyCfg.layers.map((l, i) => coercePolyLayer(l, i)).filter(Boolean);
      } else if (!Array.isArray(state.polyLayers)) {
        state.polyLayers = [];
      }

      savePolyrhythmToLS();
      applyPolyMasterGain();
      polySchedNextById = Object.create(null);
      try { rebuildPolyrhythmUI(); } catch (_) {}
      try { syncPolyrhythmUI(); } catch (_) {}

      // If audio is already active (test or run), cancel only poly scheduled audio and resync safely.
      const shouldActive = !!(testActive || (runActive && state.polyEnabledForRuns));
      if (wasActive || shouldActive) {
        try { cancelScheduledPolyAudioNow(); } catch (_) {}
        if (shouldActive) {
          try {
            const nowMs = perfNow();
            const bpm = testActive ? (Number(polyTestBpm) || 120) : (Number(state.bpm) || 120);
            const beatMs = 60000 / bpm;
            const anchorMs = testActive ? polyTestStartMs : state.methodStartMs;
            polyResetSchedPointers(nowMs, anchorMs, beatMs);
          } catch (_) {}
          kickLoop();
        }
      }
    } else if (polyPresent) {
      recordImportSkip('polyrhythm', 'Invalid polyrhythm (expected object).', false);
    }

    } catch (e) {
      recordImportSkip('polyrhythm', e, false);
    }

    try {
// Drones + master FX
    const soundSrc = isPlainObject(srcCfg.sound) ? srcCfg.sound : {};
    const dronesPresent = Object.prototype.hasOwnProperty.call(soundSrc, 'drones');

    // v015_p05b_load_no_leak_between_imports: reset drones to defaults first so sparse imports can't leak prior state.
    try { if (state.droneOn) setDroneOn(false); } catch (_) {}
    state.droneOn = false;
    state.dronesEnabled = false;
    state.dronePaused = false;
    state.dronesPaused = false;

    state.droneType = 'single';
    state.droneScaleKey = 'Fs_major';
    state.droneOctaveC = 3;
    state.droneCustomHz = 440;
    state.droneVolume = 50;
    state.dronesMasterVolume = 50;
    state.droneOwner = 'run';

    safeSetBoolLS(LS_DRONE_ON, false);
    safeSetLS(LS_DRONE_OCTAVE_C, String(state.droneOctaveC));
    safeDelLS(LS_DRONE_VARIANTS);
    try { loadDroneVariantsFromLS(); } catch (_) {}
    safeDelLS(LS_DRONE_LAYERS);
    state.droneLayers = null;
    safeEnsure('ensureDroneLayersState', (typeof ensureDroneLayersState === 'function') ? ensureDroneLayersState : null);
    try { saveDroneLayersToLS(); } catch (_) {}
    try { syncDroneOnOffUI(); } catch (_) {}
    try { syncDronePauseBtnUI(); } catch (_) {}
    try { rebuildDroneLayersUI(); } catch (_) {}
    try { applyDroneMasterGain(); } catch (_) {}
    try { refreshAllDroneLayers(); } catch (_) {}

    const dronesCfg = (dronesPresent && isPlainObject(soundSrc.drones)) ? soundSrc.drones : null;
    if (dronesCfg) {
      const drones = dronesCfg;
      if (typeof drones.owner !== 'undefined') {
        const o = String(drones.owner || 'run');
        state.droneOwner = (o === 'meditation') ? 'meditation' : 'run';
      }
      const legacy = isPlainObject(drones.legacy) ? drones.legacy : {};
      const layers = isPlainObject(drones.layers) ? drones.layers : {};

      // Legacy fields (also drive layer 1)
      if (typeof legacy.type !== 'undefined') state.droneType = String(legacy.type || 'sine');
      if (typeof legacy.scaleKey !== 'undefined') {
        const nextDroneScaleKey = String(legacy.scaleKey || '');
        if (isValidScaleKey(nextDroneScaleKey)) state.droneScaleKey = nextDroneScaleKey;
      }
      if (typeof legacy.octaveC !== 'undefined') state.droneOctaveC = clampInt(Number(legacy.octaveC), 1, 6, 4);
      if (typeof legacy.customHz !== 'undefined') state.droneCustomHz = clamp(Number(legacy.customHz) || 55, 20, 20000);

      // v015_p05a_load_drone_pause_and_volume_fix: accept volume stored as 0..100 or 0..1, but keep state in 0..100
      const coerceImportVolPct = (raw, fallbackPct) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallbackPct;
        if (n >= 0 && n <= 1) return clampInt(Math.round(n * 100), 0, 100, fallbackPct);
        return clampInt(Math.round(n), 0, 100, fallbackPct);
      };
      if (typeof legacy.volume !== 'undefined') state.droneVolume = coerceImportVolPct(legacy.volume, clampInt(Number(state.droneVolume) || 0, 0, 100, 50));

      safeSetLS(LS_DRONE_OCTAVE_C, String(state.droneOctaveC));

      if (typeof legacy.variants !== 'undefined' && isPlainObject(legacy.variants)) {
        const v = legacy.variants;
        if (typeof v.normalize !== 'undefined') state.droneNormalize = !!v.normalize;
        if (typeof v.warp !== 'undefined') state.droneWarp = clamp(Number(v.warp) || 0, 0, 1);
        if (typeof v.detuneCents !== 'undefined') state.droneDetuneCents = clamp(Number(v.detuneCents) || 0, -50, 50);
        if (typeof v.spreadCents !== 'undefined') state.droneSpreadCents = clamp(Number(v.spreadCents) || 0, 0, 60);
        if (typeof v.density01 !== 'undefined') state.droneDensity01 = clamp(Number(v.density01) || 0, 0, 1);
        if (typeof v.densityByType !== 'undefined' && isPlainObject(v.densityByType)) state.droneDensityByType = deepCloneJsonable(v.densityByType);
        saveDroneVariantsToLS();
      }

      // Layers (optional)
      if (typeof layers.masterVolume !== 'undefined') state.dronesMasterVolume = coerceImportVolPct(layers.masterVolume, clampInt(Number(state.dronesMasterVolume) || 0, 0, 100, 50));
      if (Array.isArray(layers.droneLayers)) state.droneLayers = deepCloneJsonable(layers.droneLayers);

      // Mirror layered master volume into legacy master for the gain stage.
      state.droneVolume = clampInt(Number(state.droneVolume) || 0, 0, 100, 50);
      state.dronesMasterVolume = clampInt((typeof state.dronesMasterVolume !== 'undefined') ? Number(state.dronesMasterVolume) : state.droneVolume, 0, 100, state.droneVolume);
      state.droneVolume = clampInt(state.dronesMasterVolume, 0, 100, state.droneVolume);

      // On/off + pause state
      const wantOn = (typeof legacy.on !== 'undefined') ? !!legacy.on : (typeof layers.enabled !== 'undefined') ? !!layers.enabled : !!state.droneOn;
      const wantPaused = (typeof legacy.paused !== 'undefined') ? !!legacy.paused : (typeof layers.paused !== 'undefined') ? !!layers.paused : !!state.dronePaused;
      const loadIndicatedEnabled = !!(importDronesHint && importDronesHint.present && importDronesHint.enabled);
      const loadIndicatedPaused = !!(importDronesHint && importDronesHint.present && importDronesHint.paused);
      const targetOn = !!wantOn;
      const forcePaused = loadIndicatedEnabled && targetOn;
      const targetPaused = targetOn ? (forcePaused ? true : !!wantPaused) : false;
      if (forcePaused && !loadIndicatedPaused) dronesForcedPaused = true;

      // Ensure layer 1 matches legacy state.
      safeEnsure('ensureDroneLayersState', (typeof ensureDroneLayersState === 'function') ? ensureDroneLayersState : null);
      syncLayer1FromLegacyDroneState();

      // UI fields
      if (droneTypeSelect) droneTypeSelect.value = String(state.droneType || 'sine');
        if (droneCustomIntervalsInput) {
    const commitDroneCustomIntervals = () => {
      markUserTouchedConfig();
      ensureDroneLayersState();
      if (state.droneLayers && state.droneLayers[0]) {
        state.droneLayers[0].customIntervals = String(droneCustomIntervalsInput.value || '');
      }
      saveDroneLayersToLS();
      rebuildDroneLayersUI();
      if (state.droneOn) refreshAllDroneLayers();
    };
    droneCustomIntervalsInput.addEventListener('change', commitDroneCustomIntervals);
    droneCustomIntervalsInput.addEventListener('blur', commitDroneCustomIntervals);
    droneCustomIntervalsInput.addEventListener('keydown', (e) => {
      if (e && e.key === 'Enter') { try { e.preventDefault(); } catch (_) {} commitDroneCustomIntervals(); }
    });
  }

if (droneScaleSelect) droneScaleSelect.value = String(state.droneScaleKey || '');
      if (droneOctaveSelect) droneOctaveSelect.value = String(state.droneOctaveC || 4);
      if (droneVolume) droneVolume.value = String(clampInt(Math.round(Number(state.droneVolume) || 0), 0, 100, 50));
      if (droneCustomHzInput) droneCustomHzInput.value = String(Number.isFinite(Number(state.droneCustomHz)) ? state.droneCustomHz : 55);

      syncDroneCustomHzUI();
      syncDroneVariantsForType();
      syncDroneVariantsUI();
      rebuildDroneLayersUI();

      const wasOn = !!state.droneOn;

      // Apply on/off and pause state.
      if (!targetOn) {
        if (state.droneOn) setDroneOn(false);
        state.droneOn = false;
        state.dronesEnabled = false;
        state.dronePaused = false;
        state.dronesPaused = false;
        safeSetBoolLS(LS_DRONE_ON, false);
        saveDroneLayersToLS();
        syncDroneOnOffUI();
      } else if (forcePaused) {
        // Preserve enabled state, but ensure drones load paused so no audible output begins automatically.
        state.droneOn = true;
        state.dronesEnabled = true;
        state.dronePaused = true;
        state.dronesPaused = true;

        safeSetBoolLS(LS_DRONE_ON, true);
        saveDroneLayersToLS();

        // If drones were already running in this session, refresh silently (paused) to apply config.
        if (wasOn) {
          applyDroneMasterGain();
          refreshAllDroneLayers();
        } else {
          applyDroneMasterGain();
        }

        syncDroneOnOffUI();
      } else {
        // Legacy apply path: respect saved paused state, and allow auto-start.
        safeSetBoolLS(LS_DRONE_ON, true);
        if (!state.droneOn) setDroneOn(true);

        state.dronePaused = !!wantPaused;
        state.dronesPaused = state.dronePaused;
        saveDroneLayersToLS();
        applyDroneMasterGain();
        syncDronePauseBtnUI();

        refreshAllDroneLayers();
      }
    } else if (dronesPresent) {
      recordImportSkip('drones', new Error('Invalid drones config; reset to defaults'), false);
    }

    
    } catch (e) {
      recordImportSkip('drones', e, false);
    }

    try {
// --- Master FX ---
    const soundSrc = isPlainObject(srcCfg.sound) ? srcCfg.sound : {};
    const fxPresent = Object.prototype.hasOwnProperty.call(soundSrc, 'masterFx');

    // v015_p05b_load_no_leak_between_imports: reset first so sparse imports can't inherit prior FX state.
    safeDelLS(LS_MASTER_FX);
    loadMasterFxFromLS();

    const fx = (fxPresent && isPlainObject(soundSrc.masterFx)) ? soundSrc.masterFx : null;
    if (fx) {
      const limiter = isPlainObject(fx.limiter) ? fx.limiter : {};
      const reverb = isPlainObject(fx.reverb) ? fx.reverb : {};

      if (typeof limiter.enabled !== 'undefined') state.fxLimiterEnabled = !!limiter.enabled;
      if (typeof limiter.amount01 !== 'undefined') state.fxLimiterAmount = clamp(Number(limiter.amount01) || 0, 0, 1);

      if (typeof reverb.enabled !== 'undefined') state.fxReverbEnabled = !!reverb.enabled;
      if (typeof reverb.mix01 !== 'undefined') state.fxReverbMix = clamp(Number(reverb.mix01) || 0, 0, 1);
      else if (typeof reverb.send01 !== 'undefined') state.fxReverbMix = clamp(Number(reverb.send01) || 0, 0, 1); // legacy
      if (typeof reverb.size01 !== 'undefined') state.fxReverbSize = clamp(Number(reverb.size01) || 0, 0, 1);
      else if (typeof reverb.size !== 'undefined') state.fxReverbSize = clamp(Number(reverb.size) || 0, 0, 1); // legacy
      if (typeof reverb.highCutHz !== 'undefined') state.fxReverbHighCutHz = clamp(Number(reverb.highCutHz) || 6000, 500, 20000);
      else if (typeof reverb.highCut01 !== 'undefined') {
        const x = clamp(Number(reverb.highCut01) || 0, 0, 1);
        const minHz = 500, maxHz = 20000;
        state.fxReverbHighCutHz = clamp(minHz * Math.pow(maxHz / minHz, x), 500, 20000);
      }

      // Keep legacy fields if present (harmless; some older builds used these names).
      if (typeof reverb.send01 !== 'undefined') state.fxReverbSend = clamp(Number(reverb.send01) || 0, 0, 1);
      if (typeof reverb.highCut01 !== 'undefined') state.fxReverbHighCut = clamp(Number(reverb.highCut01) || 0, 0, 1);

      saveMasterFxToLS();
    } else {
      if (fxPresent) recordImportSkip('masterFx', new Error('Invalid masterFx; reset to defaults'), false);
    }

    syncMasterFxUI();
    applyMasterFxAll(true);
    queueMasterReverbImpulseRebuild();

    } catch (e) {
      recordImportSkip('masterFx', e, false);
    }

    try {
// --- Privacy ---
    if (applyPrivacy) {
      setAudienceConsent(privacyValue || '');
      syncAudienceConsentUI();
    }

    
    } catch (e) {
      recordImportSkip('privacy', e, false);
    }

    const coreFailed = Object.keys(importCoreOk).filter(k => !importCoreOk[k]);
    if (coreFailed.length) {
      const first = coreFailed[0];
      const why = Object.prototype.hasOwnProperty.call(importSectionErrors, first) ? (' — ' + first + ': ' + importSectionErrors[first]) : '';
      throw new Error('Core sections failed: ' + coreFailed.join(', ') + why);
    }
// Final refresh
    syncGameHeaderMeta();
    syncMethodSelectSourceDropdown();
    renderScoringExplanation();
    resetStats();

    markDirty();
    if (!inLoopTick) kickLoop();

    const optionalSkipped = importSkipped.filter(s => !Object.prototype.hasOwnProperty.call(importCoreOk, s));
    const warnings = optionalSkipped.map(s => s + (Object.prototype.hasOwnProperty.call(importSectionErrors, s) ? (': ' + importSectionErrors[s]) : ''));
    return { optionalSkipped, warnings, dronesForcedPaused };

  }

  async function importSettingsFromText(rawText, opts) {
    const src = (opts && opts.sourceLabel) ? String(opts.sourceLabel) : '';
    let text = '';
    try { text = String(rawText || ''); } catch (_) { text = ''; }
    if (!text.trim()) {
      showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['Nothing to load (empty JSON).'] });
      return false;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : 'Invalid JSON.';
      showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['Invalid JSON: ' + msg] });
      return false;
    }

    let norm = null;
    let vinfo = null;
    try {
      norm = normalizeImportedSettingsPayload(parsed);
      vinfo = validateImportedSettingsPayload(norm);
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e || 'Invalid settings JSON.');
      showImportSettingsModal({ title: 'Load failed', isError: true, lines: [msg] });
      return false;
    }

    // Snapshot current settings to allow rollback on apply failure.
    const beforeConsent = getAudienceConsent();
    const before = buildSettingsExportPayload({});
    const beforeConfig = (before && before.config) ? before.config : {};

    // Merge: imported values override current settings; missing fields keep current values.
    const merged = deepMergeJson(beforeConfig, norm.config);

    const privacySpecified = !!(norm.config && isPlainObject(norm.config.privacy) && Object.prototype.hasOwnProperty.call(norm.config.privacy, 'audienceMeasurementConsent'));
    const wantedConsent = privacySpecified ? String(norm.config.privacy.audienceMeasurementConsent || '').trim() : '';

    // v015_p05a_load_drone_pause_and_volume_fix: detect drone intent in the loaded JSON
    const dronesHint = (() => {
      try {
        const sc = (norm && norm.config) ? norm.config : null;
        const snd = (sc && isPlainObject(sc.sound)) ? sc.sound : null;
        const d = (snd && isPlainObject(snd.drones)) ? snd.drones : null;
        const legacy = (d && isPlainObject(d.legacy)) ? d.legacy : null;
        const layers = (d && isPlainObject(d.layers)) ? d.layers : null;
        const enabled = !!((legacy && legacy.on) || (layers && layers.enabled));
        const paused = !!((legacy && legacy.paused) || (layers && layers.paused));
        return { present: !!d, enabled, paused };
      } catch (_) { return { present: false, enabled: false, paused: false }; }
    })();

    // Apply atomically (best effort)
    let applyInfo = null;
    try {
      applyInfo = applyImportedSettingsConfig(merged, { importedConfig: norm.config, applyPrivacy: privacySpecified, privacyValue: wantedConsent, dronesHint });
    } catch (e) {
      // Rollback attempt
      try { applyImportedSettingsConfig(beforeConfig, { applyPrivacy: true, privacyValue: beforeConsent }); } catch (_) {}

      const msg = (e && e.message) ? String(e.message) : String(e || 'Apply failed.');
      const lines = ['Failed to apply settings: ' + msg];
      if (src) lines.push('Source: ' + src);
      showImportSettingsModal({ title: 'Load failed', isError: true, lines });
      return false;
    }

    // Success UX
    const meta = (norm && norm.metadata) ? norm.metadata : {};
    const title = (meta && (meta.title || meta.Title)) ? String(meta.title || meta.Title) : '';
    const name = (meta && (meta.name || meta.nickname || meta.nick)) ? String(meta.name || meta.nickname || meta.nick) : '';
    // v015_p04_stats_export_import_and_compare: store imported statsHistory (UI-only)
    const importedHistory = normalizeStatsHistoryArray(norm.statsHistory);
    ui.loadedStatsHistory = importedHistory;
    // v015_p04_stats_export_import_and_compare: retain loaded JSON for append-only updates
    try {
      ui.loadedCodeRoot = deepCloneJsonable(parsed);
      ui.loadedCodePayload = ui.loadedCodeRoot;
      if (ui.loadedCodeRoot && isPlainObject(ui.loadedCodeRoot.settings) && (ui.loadedCodeRoot.settings.config || ui.loadedCodeRoot.settings.metadata)) {
        ui.loadedCodePayload = ui.loadedCodeRoot.settings;
      }
      ui.loadedCodeFileName = (opts && opts.sourceFileName) ? String(opts.sourceFileName) : '';
      ui.loadedCodeScoringSignature = buildScoringSignatureFromState();
    } catch (_) {
      ui.loadedCodeRoot = null;
      ui.loadedCodePayload = null;
      ui.loadedCodeFileName = '';
      ui.loadedCodeScoringSignature = null;
    }
    try { updateLoadAppendRunButtonState(); } catch (_) {}

    const highest = (importedHistory && importedHistory.length)
      ? extractHighestGlobalScoreFromStatsHistory(importedHistory)
      : extractHighestGlobalScoreFromStats(norm.stats);

    const lines = [];
    if (title) lines.push('Title: ' + title);
    if (name) lines.push('Name: ' + name);
    if (highest !== null) lines.push('Highest score: ' + String(Math.round(highest)));

    lines.push('Loaded successfully' + (vinfo && vinfo.schemaVersion ? ' (' + vinfo.schemaVersion + ')' : '') + '.');

    if (applyInfo && applyInfo.dronesForcedPaused) lines.push('Drones loaded paused.');

    const warnSections = (applyInfo && Array.isArray(applyInfo.optionalSkipped)) ? applyInfo.optionalSkipped : [];
    if (warnSections.length) {
      lines.push('⚠ Loaded with warnings: ' + warnSections.join(', ') + '.');
      const wlines = (applyInfo && Array.isArray(applyInfo.warnings)) ? applyInfo.warnings : [];
      for (const w of wlines) lines.push('↳ ' + String(w || ''));
    }
    showImportSettingsModal({ title: (warnSections.length ? 'Loaded with warnings' : 'Loaded successfully'), isError: false, lines });

    return true;
  }

  async function loadScreenLoadClicked() {
    const txt = loadCodeTextarea ? String(loadCodeTextarea.value || '') : '';
    await importSettingsFromText(txt, { sourceLabel: 'Textarea' });
  }

  function ensureLoadSettingsFileInput() {
    if (ui._loadSettingsFileInput) return ui._loadSettingsFileInput;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.tabIndex = -1;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';

    input.addEventListener('change', () => {
      const file = (input.files && input.files[0]) ? input.files[0] : null;
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async () => {
        const text = String(reader.result || '');
        await importSettingsFromText(text, { sourceLabel: file && file.name ? file.name : 'File', sourceFileName: file && file.name ? file.name : '' });
        try { input.value = ''; } catch (_) {}
      };
      reader.onerror = () => {
        showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['Failed to read file.'] });
        try { input.value = ''; } catch (_) {}
      };
      try { reader.readAsText(file); } catch (_) {
        showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['Failed to read file.'] });
        try { input.value = ''; } catch (_) {}
      }
    });

    try { document.body.appendChild(input); } catch (_) {}
    ui._loadSettingsFileInput = input;
    return input;
  }

  function loadScreenLoadFileClicked() {
    const input = ensureLoadSettingsFileInput();
    if (!input) {
      showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['File picker is not available.'] });
      return;
    }
    try { input.click(); } catch (_) {
      showImportSettingsModal({ title: 'Load failed', isError: true, lines: ['File picker is not available.'] });
    }
  }
  // Wire Load screen actions
  if (loadBtnGenerate) loadBtnGenerate.addEventListener('click', () => { loadScreenGenerateClicked(); });
  if (loadBtnSaveFile) loadBtnSaveFile.addEventListener('click', () => { loadScreenSaveFileClicked(); });
  if (loadBtnAppendRun) loadBtnAppendRun.addEventListener('click', () => { loadScreenAppendRunClicked(); });
  if (loadBtnCopy) loadBtnCopy.addEventListener('click', () => { loadScreenCopyClicked(); });
  if (loadBtnLoad) loadBtnLoad.addEventListener('click', () => { loadScreenLoadClicked(); });
  if (loadBtnLoadFile) loadBtnLoadFile.addEventListener('click', () => { loadScreenLoadFileClicked(); });


  // v011_p01_sound_intro_page: Sound -> Sound Menu Introduction (SPA navigation)
  if (soundIntroLink) {
    soundIntroLink.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (_) {}
      setScreen('sound_intro');
    });
  }
  if (homeBtnBegin) homeBtnBegin.addEventListener('click', () => {
    setScreen('game');
    requestAnimationFrame(() => {
      try { if (startBtn) startBtn.focus(); } catch (_) {}
    });
  });
  if (homeBtnDemo) homeBtnDemo.addEventListener('click', () => {
    if (state.phase !== 'idle') {
      showStopCurrentRunModal();
      return;
    }
    setScreen('game');
    startDemoFromUi();
  });

  // v06_p12c_library_entry: Setup -> Library screen entry
  if (setupExploreLibraryBtn) setupExploreLibraryBtn.addEventListener('click', () => {
    if (!state.libraryLoaded) {
      alert('Load a CCCBR library first.');
      return;
    }
    setScreen('library');
  });

    // v012_p02_setup_library_block_and_library_header_hamburger: Setup -> Local load CCCBR XML/ZIP
  if (setupLoadLibraryLocalBtn && xmlInput) {
    setupLoadLibraryLocalBtn.addEventListener('click', () => {
      try { xmlInput.click(); } catch (_) {}
    });
  }

// v06_p12d_library_browser: Setup -> Download & load CCCBR library from the web
  if (setupLoadCCCBRWebBtn) {
    setupLoadCCCBRWebBtn.addEventListener('click', () => {
      downloadAndLoadCCCBRLibraryFromWeb();
    });
  }

  // v06_p12d_library_browser: Library screen interactions
  if (libraryGoSetupBtn) libraryGoSetupBtn.addEventListener('click', () => setScreen('play'));
  if (librarySearchInput) librarySearchInput.addEventListener('input', applyLibrarySearchFilter);
  if (libraryLineBellSelect) {
    libraryLineBellSelect.addEventListener('change', () => {
      const v = parseInt(libraryLineBellSelect.value, 10);
      ui.libraryPreviewBell = clamp(isFinite(v) ? v : 0, 0, 12);
      updateLibraryPreview();
    });
  }
  if (libraryPreviewPrevBtn) {
    libraryPreviewPrevBtn.addEventListener('click', () => {
      const p = ui.libraryPreview;
      if (!p) return;
      const next = Math.max(0, (p.leftPage | 0) - 2);
      if (next === p.leftPage) return;
      p.leftPage = next;
      libPreviewRenderSpread(p);
      libPreviewSyncControls(p);
    });
  }
  if (libraryPreviewNextBtn) {
    libraryPreviewNextBtn.addEventListener('click', () => {
      const p = ui.libraryPreview;
      if (!p) return;
      const pageSize = p.pageSize || LIB_PREVIEW_PAGE_SIZE;
      const targetLeft = (p.leftPage | 0) + 2;
      const targetStartRow = targetLeft * pageSize;
      if ((p.done || p.capped) && targetStartRow >= p.rows.length) {
        libPreviewSyncControls(p);
        return;
      }
      const needRows = Math.min(LIB_PREVIEW_MAX_ROWS, (targetLeft + 2) * pageSize);
      libPreviewGenerateTo(p, needRows);
      if (targetStartRow >= p.rows.length) {
        libPreviewSyncControls(p);
        return;
      }
      p.leftPage = targetLeft;
      libPreviewRenderSpread(p);
      libPreviewSyncControls(p);
    });
  }
  if (libraryPlaySelectedBtn) libraryPlaySelectedBtn.addEventListener('click', () => libraryEnterWithSelected('play'));
  if (libraryDemoSelectedBtn) libraryDemoSelectedBtn.addEventListener('click', () => libraryEnterWithSelected('demo'));

  // v06_p14a_library_mobile_layout: Jump buttons (mobile-only via CSS)
  function scrollToLibraryAnchor(anchorEl) {
    if (!anchorEl || !anchorEl.scrollIntoView) return;
    try {
      anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (_) {
      try { anchorEl.scrollIntoView(true); } catch (_) {}
    }
  }
  if (libraryJumpBrowseBtn) libraryJumpBrowseBtn.addEventListener('click', () => scrollToLibraryAnchor(libraryBrowseAnchor));
  if (libraryJumpDetailsBtn) libraryJumpDetailsBtn.addEventListener('click', () => scrollToLibraryAnchor(libraryDetailsAnchor));

  // v09_p01_home_logo_step_method: Home logo steps through the current method (UI + audio only).
  let homeMethodStepIndex = 0; // session-only

  function ringHomeLogoStepOne() {
    try {
      const stage = Math.max(1, Number(state.stage) || 1);
      const rowsLen = (state.rows && state.rows.length) ? state.rows.length : 0;
      const totalBeats = rowsLen * stage;
      if (!totalBeats) {
        ensureAudio();
        playBellAt(1, perfNow());
        return;
      }

      const idx = ((homeMethodStepIndex % totalBeats) + totalBeats) % totalBeats;
      const bell = getBellForStrikeIndex(idx);

      ensureAudio();
      playBellAt(bell, perfNow());

      homeMethodStepIndex = idx + 1;
      if (homeMethodStepIndex >= totalBeats) homeMethodStepIndex = 0;
    } catch (_) {}
  }

  if (homeBellLogo) {
    homeBellLogo.addEventListener('click', () => ringHomeLogoStepOne());
    homeBellLogo.addEventListener('keydown', (e) => {
      const k = e && e.key ? String(e.key) : '';
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        if (k === ' ' || k === 'Spacebar') {
          try { e.preventDefault(); } catch (_) {}
        }
        ringHomeLogoStepOne();
      }
    });
  }


  wireUniversalMenuNav();

  const viewDisplay = document.getElementById('viewDisplay');
  const viewSpotlight = document.getElementById('viewSpotlight');
  const viewNotation = document.getElementById('viewNotation');
  const viewStats = document.getElementById('viewStats');
  const viewMic = document.getElementById('viewMic');
  const displayLiveOnly = document.getElementById('displayLiveOnly');

  // v09_p07b_notation_spotlight_accuracy_dots
  const accuracyDotsEnabled = document.getElementById('accuracyDotsEnabled');
  const accuracyDotsDisplay = document.getElementById('accuracyDotsDisplay');
  const accuracyDotsNotation = document.getElementById('accuracyDotsNotation');
  const accuracyDotsSpotlight = document.getElementById('accuracyDotsSpotlight');
  // v07_p02_privacy_footer_policy_friendly_banner
  const privacyAudienceCheckbox = document.getElementById('privacyAudienceCheckbox');
  const privacyRefreshNotice = document.getElementById('privacyRefreshNotice');
  const privacyPolicyPre = document.getElementById('privacyPolicyPre');
  const footerPrivacyLink = document.getElementById('footerPrivacyLink');

  const consentBanner = document.getElementById('rgConsentBanner');
  const consentAllowBtn = document.getElementById('rgConsentAllow');
  const consentDenyBtn = document.getElementById('rgConsentDeny');
  const consentPrivacyLink = document.getElementById('rgConsentPrivacyLink');


  // View: layout presets
  const layoutPresetSelect = document.getElementById('layoutPresetSelect');
  // v06_p15_notation_single_page_mode
  const notationLayoutSelect = document.getElementById('notationLayoutSelect');


  // swaps view controls
  const spotlightSwapsView = document.getElementById('spotlightSwapsView');
  const spotlightSwapRows = document.getElementById('spotlightSwapRows');
  const spotlightShowN = document.getElementById('spotlightShowN');
  const spotlightShowN1 = document.getElementById('spotlightShowN1');
  const spotlightShowN2 = document.getElementById('spotlightShowN2');
  const notationSwapsOverlay = document.getElementById('notationSwapsOverlay');


  const pathNoneBtn = document.getElementById('pathNoneBtn');
  const pathAllBtn = document.getElementById('pathAllBtn');
  const pathPicker = document.getElementById('pathPicker');

  // swaps view localStorage keys
  const LS_SPOTLIGHT_SWAPS_VIEW = 'spotlight_swaps_view';
  const LS_SPOTLIGHT_SHOW_N = 'spotlight_show_N';
  const LS_SPOTLIGHT_SHOW_N1 = 'spotlight_show_N1';
  const LS_SPOTLIGHT_SHOW_N2 = 'spotlight_show_N2';
  const LS_NOTATION_SWAPS_OVERLAY = 'notation_swaps_overlay';
  const LS_DISPLAY_LIVE_BELLS_ONLY = 'display_live_bells_only';

  // v09_p07b_notation_spotlight_accuracy_dots
  const LS_ACCURACY_DOTS = 'rg_accuracy_dots_v1';

  // layout preset localStorage key
  const LS_LAYOUT_PRESET = 'rg_layout_preset';

  // v06_p15_notation_single_page_mode
  const LS_NOTATION_LAYOUT = 'rg_notation_layout';

  // v08_p05_sound_per_bell_overrides localStorage keys
  const LS_BELL_HZ_OVERRIDE = 'rg_bell_hz_override_v1';
  const LS_BELL_VOL_OVERRIDE = 'rg_bell_vol_override_v1';

  
  // v014_p045a_spatial_pan_only
  const LS_BELL_PAN = 'rg_bell_pan_v1';
  // v014_p045b_spatial_depth_and_send
  const LS_BELL_DEPTH = 'rg_bell_depth_v1';
  const LS_SPATIAL_DEPTH_MODE = 'rg_spatial_depth_mode_v1';
// v09_p06_sound_per_bell_key_register localStorage keys
  const LS_BELL_KEY_OVERRIDE = 'rg_bell_key_override_v1';
  const LS_BELL_OCT_OVERRIDE = 'rg_bell_oct_override_v1';

  // v10_p08_sound_global_chords_splitstrike localStorage key
  const LS_GLOBAL_CHORD = 'rg_global_chord_v1';
  // v014_p05a_bell_timbre_global localStorage key
  const LS_BELL_TIMBRE_GLOBAL = 'rg_bell_timbre_global_v1';


  function saveBellDepthToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const v0 = Number(state.bellDepth[b]);
      if (!Number.isFinite(v0)) continue;
      const v = clamp(v0, 0, 1);
      if (v < 0.0005) continue;
      out[b] = Number(v.toFixed(3));
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_DEPTH);
    else safeSetLS(LS_BELL_DEPTH, JSON.stringify(out));
  }

  // v014_p045b_spatial_depth_and_send
  function loadSpatialDepthModeFromLS() {
    const raw = safeGetLS(LS_SPATIAL_DEPTH_MODE);
    if (raw == null) {
      state.spatialDepthMode = sanitizeSpatialDepthMode(state.spatialDepthMode);
      return false;
    }
    state.spatialDepthMode = sanitizeSpatialDepthMode(raw);
    return true;
  }

  function saveSpatialDepthModeToLS() {
    const m = sanitizeSpatialDepthMode(state.spatialDepthMode);
    state.spatialDepthMode = m;
    safeSetLS(LS_SPATIAL_DEPTH_MODE, m);
  }

  // v10_p09_sound_per_bell_chords_overrides localStorage key
  const LS_BELL_CHORD_OVERRIDES = 'rg_bell_chord_overrides_v1';

  // v014_p05b_bell_timbre_per_bell_overrides localStorage key
  const LS_BELL_TIMBRE_OVERRIDES = 'rg_bell_timbre_overrides_v1';

  // v08_p07_drone_on_off_button localStorage key
  const LS_DRONE_ON = 'rg_drone_on_v1';

  // v08_p08_defaults_and_ui_fixes: Drone register (octave) preference (C1..C6)
  const LS_DRONE_OCTAVE_C = 'rg_drone_octave_c_v1';

  // v014_p02_drone_variant_knobs: Drone variant settings
  const LS_DRONE_VARIANTS = 'rg_drone_variants_v1';

  // v014_p04_multi_drone_layers: Drone layers (global + per-layer) persisted structure
  const LS_DRONE_LAYERS = 'rg_drone_layers_v1';
// v014_p03_master_fx_limiter_reverb localStorage key
const LS_MASTER_FX = 'rg_master_fx_v1';

// v017_p01_polyrhythm_core localStorage key
const LS_POLYRHYTHM = 'rg_polyrhythm_v1';



  // mic localStorage keys
  const LS_MIC_ENABLED = 'rg_mic_enabled';
  const LS_MIC_BELLS = 'rg_mic_bells_v1';
  const LS_MIC_THRESHOLD = 'rg.mic.threshold';
  const OLD_LS_MIC_THRESHOLD_DB = 'rg_mic_threshold_db'; // v1 (dB slider)
  const LS_MIC_COOLDOWN_MS = 'rg_mic_cooldown_ms';


  function syncSpotlightSwapRowTogglesUI() {
    if (!spotlightSwapRows || !spotlightSwapsView) return;
    spotlightSwapRows.classList.toggle('hidden', !spotlightSwapsView.checked);
    syncViewMenuSelectedUI();
    markDirty();
    kickLoop();
  }


  // === Musical scales (8 tones incl octave) ===
  // Intervals are semitones ascending from root to octave.
  const SCALE_LIBRARY = [
    { key: 'C_major', label: 'C major', root: 'C', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'Cs_major', label: 'C# major', root: 'C#', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'D_major', label: 'D major', root: 'D', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'Ef_major', label: 'Eb major', root: 'Eb', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'E_major', label: 'E major', root: 'E', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'F_major', label: 'F major', root: 'F', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'Fs_major', label: 'F# major', root: 'F#', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'G_major', label: 'G major', root: 'G', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'Af_major', label: 'Ab major', root: 'Ab', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'A_major', label: 'A major', root: 'A', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'Bf_major', label: 'Bb major', root: 'Bb', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'B_major', label: 'B major', root: 'B', intervals: [0,2,4,5,7,9,11,12] },
    { key: 'C_minor', label: 'C minor', root: 'C', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'Cs_minor', label: 'C# minor', root: 'C#', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'D_minor', label: 'D minor', root: 'D', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'Ef_minor', label: 'Eb minor', root: 'Eb', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'E_minor', label: 'E minor', root: 'E', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'F_minor', label: 'F minor', root: 'F', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'Fs_minor', label: 'F# minor', root: 'F#', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'G_minor', label: 'G minor', root: 'G', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'Af_minor', label: 'Ab minor', root: 'Ab', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'A_minor', label: 'A minor', root: 'A', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'Bf_minor', label: 'Bb minor', root: 'Bb', intervals: [0,2,3,5,7,8,10,12] },
    { key: 'B_minor', label: 'B minor', root: 'B', intervals: [0,2,3,5,7,8,10,12] }
  ];

  const NOTE_TO_SEMI = { 'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11 };

  function noteToMidi(note, octave) {
    const semi = NOTE_TO_SEMI[note];
    // MIDI: C-1 = 0, C4 = 60
    return (octave + 1) * 12 + semi;
  }
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // === Game state ===
  const state = {
    method: 'plainhunt',
    methodSource: 'built_in',
    methodMeta: null,
    stage: 6,
    liveCount: 1,
    liveBells: [1],
    bpm: 120,

    // musical settings
    scaleKey: 'Fs_major',
    octaveC: 4,
    bellCustomHz: 440, // used when scaleKey === 'custom_hz' // UI shows C1..C6

    // v011_p04_bell_pitch_collapsible_blocks: bell pitch pattern selection
    bellPitchFamily: 'diatonic', // 'diatonic' | 'pent_hex' | 'chromatic' | 'fifths_fourths' | 'partials' | 'custom'
    bellPitchSpan: 'compact', // 'compact' | 'extended' (stages 9–12 default to extended)
    bellPitchSpanUser: false,
    bellPitchPentVariant: 'major_pent',
    bellPitchChromaticDirection: 'descending', // 'descending' (treble-high) | 'ascending' (treble-low)
    bellPitchFifthsType: 'fifths', // 'fifths' | 'fourths'
    bellPitchFifthsShape: 'folded', // 'ladder' | 'folded'
    bellPitchPartialsShape: 'ladder', // 'ladder' | 'folded'
    // audio settings
    bellVolume: 100, // 0..100 master bell volume
    // v014_p05a_bell_timbre_global (global bell strike timbre; defaults preserve legacy sound)
    bellRingLength: 0.5, // 0..1 (0.5 = legacy envelope)
    bellBrightness: 0.5, // 0..1 (0.5 = neutral/no-op)
    bellStrikeHardness: 0.0, // 0..1 (0 = off/no-op)
    // v014_p05b_bell_timbre_per_bell_overrides (per-bell timbre override configs)
    bellTimbreOverrides: new Array(13),
    // v08_p07_drone_on_off_button: drone on/off is now a separate boolean; droneType is pattern only.
    droneOn: false,
    droneType: 'single',
    droneScaleKey: 'Fs_major',
    droneOctaveC: 3,
    droneCustomHz: 440, // used when droneScaleKey === 'custom_hz'
    droneVolume: 50, // 0..100
    dronePaused: false, // Prompt 7: mute/unmute drone without stopping

// v014_p03_master_fx_limiter_reverb: master FX (persisted)
fxLimiterEnabled: true,
fxLimiterAmount: 0.25, // 0..1 (optional strength)
fxReverbEnabled: false,
fxReverbSize: 0.55, // 0..1
fxReverbMix: 0.15, // 0..1 (send amount)
fxReverbHighCutHz: 6000, // Hz


    // v014_p02_drone_variant_knobs: parameterize drone families (persisted)
    droneNormalize: true,
    droneDensity: 3,
    droneDensityByType: {}, // internal: remembers last density per type
    droneDriftCents: 0,
    droneMotionRate: 0,
    droneClusterWidth: 3,
    droneNoiseTilt: 0,
    droneNoiseQ: 1,

    // v09_p08p_background_policy_and_drone_ownership
    // Internal-only lifecycle wiring (no UI yet)
    droneOwner: 'run',           // 'run' | 'meditation'

    // v014_p04_multi_drone_layers: global drone state + 1–4 independent layers (persisted)
    dronesEnabled: false,
    dronesPaused: false,
    dronesMasterVolume: 50, // 0..100 (applied after summing layers)
    droneLayers: null,
    // v017_p01_polyrhythm_core
    polyEnabledForRuns: false,
    polyMasterVolume: 80,
    polyLayers: [],


    meditationActive: false,     // placeholder for future Meditation


    bellFreq: [],

    // v08_p05_sound_per_bell_overrides
    bellHzOverride: new Array(13).fill(null),
    bellVolOverride: new Array(13).fill(null),

    // v014_p045a_spatial_pan_only
    bellPan: new Array(13).fill(0),

    // v014_p045b_spatial_depth_and_send
    bellDepth: new Array(13).fill(0),
    spatialDepthMode: 'normal',

    // v09_p06_sound_per_bell_key_register
    bellKeyOverride: new Array(13).fill(null),
    bellOctaveOverride: new Array(13).fill(null),

    // v10_p08_sound_global_chords_splitstrike
    globalChord: {
      enabled: false,
      size: 'single',
      preset: 'unison',
      inversion: 'root',
      spread: 'close',
      splitStrike: 'simultaneous',
      stepMs: 6,
      maxMs: 12,
    },

    pathBells: [1],
    rows: [],
    customRows: null,
    mode: 'play', // 'play' | 'demo'
    phase: 'idle', // 'idle' | 'countdown' | 'running' | 'paused'

    // pause bookkeeping
    pausePrevPhase: '',
    pauseAtMs: 0,

    countFirstBeatMs: 0,
    countExec: 0,
    countSched: 0,
    methodStartMs: 0,

    schedBeatIndex: 0,
    execBeatIndex: 0,

    targets: [],

    elapsedMs: 0,
    runStartPerfMs: 0,

    statsByBell: {},
    // v09_p07_stats_overlay_hit_12slot_shape: per-bell last judged outcome for lightweight display overlay
    lastJudgeByBell: {}, // bell -> { kind:'hit'|'miss', bin:0..11|null, errMs?:number }

    // v09_p07c_notation_spotlight_persistent_accuracy: per-row judged accuracy record (Notation + Spotlight)
    // rowIndex -> Array(stage) of {kind:'hit', bin:0..11, errMs?:number} | {kind:'miss'} | null
    accuracyByRow: [],
    _accuracyScratchByRow: {},
    _rowJudgedCount: [],
    comboCurrentGlobal: 0,
    comboBestGlobal: 0,

    currentPlay: null, // { playId, began }

    lastRingAtMs: {}, // bell -> ms (intended beat time or actual key time)

    // keybindings
    keyBindings: {}, // bell -> normalized key name
    keybindCaptureBell: null,

    // v013_p01_setup_glyph_bindings_ui_persist: per-bell glyph bindings (UI/config only)
    glyphBindings: {}, // bell -> single-character glyph
    glyphCaptureBell: null,


    // v013_p01c_setup_glyph_color_bindings: setup-only glyph styling (colors, per-bell overrides, and color-only mode)
    glyphStyle: { defaultColor: '', bellColors: {}, colorOnly: {} },
    glyphPickerBell: null,
    // swaps view settings
    spotlightSwapsView: true,
    spotlightShowN: true,
    spotlightShowN1: true,
    spotlightShowN2: true,
    notationSwapsOverlay: true,
    notationPageSize: 16,
    displayLiveBellsOnly: false,

    // v09_p07b_notation_spotlight_accuracy_dots: accuracy dot overlays (master + per-pane)
    accuracyDotsEnabled: true,
    accuracyDotsDisplay: true,
    accuracyDotsNotation: true,
    accuracyDotsSpotlight: true,

    // mic input
    micEnabled: false,          // desired toggle state (persisted)
    micActive: false,           // stream + analyser running
    micStream: null,
    micSource: null,
    micAnalyser: null,
    micSink: null,
    micBuf: null,
    micRms: 0,
    micDb: -Infinity,
    micWasAbove: false,
    micLastFireTimeMs: -1e9,
    micCooldownMs: 200,
    micBells: [],
    micError: '',

    // v06_p12c_library_entry
    libraryLoaded: false,
    libraryFileName: '',
  };

  let audioCtx = null;
  let bellMasterGain = null;
  let droneMasterGain = null;
  // v017_p01_polyrhythm_core: separate master bus for polyrhythm layers
  let polyMasterGain = null;
  // v014_p045a_spatial_pan_only: per-bell pan stages (one per bell; shared by chord voices)
  let bellPanStages = null;

  // v014_p045b_spatial_depth_and_send: per-bell depth stages (post-pan split)
  let bellDepthStages = null;

// v014_p03_master_fx_limiter_reverb: Master FX rack nodes
let masterPreFX = null;
let masterSumGain = null;
let masterOut = null;
let masterLimiter = null;
let masterLimiterPathGain = null;
let masterBypassPathGain = null;
let reverbSendGain = null;
let masterReverbSend = null;
let reverbConvolver = null;
let reverbHighCut = null;
let reverbReturnGain = null;
let masterFxRouted = false;
let polyFxRouted = false; // v017_p01_polyrhythm_core
let reverbImpulseQuant = null;
let reverbImpulseRebuildTimer = 0;

  let droneCurrent = null;
  // v014_p04_multi_drone_layers: up to 4 independent drone layers feeding the shared drone bus.
  let droneLayerCurrents = [];
  let noiseBuffer = null;
  let noiseBufferSampleRate = 0;

  // Prompt 6: registry of scheduled bell/tick strike nodes (NOT drone nodes)
  let scheduledBellNodes = [];

  // v017_p01_polyrhythm_core: registry of scheduled polyrhythm strike nodes (independent cancellation)
  let scheduledPolyNodes = [];

  // v017_p01_polyrhythm_core: per-call overrides for bell/tick routing + scheduling registry
  let bellVoiceDestOverride = null;
  let bellVoiceRegistryOverride = null;
  let bellVoiceGainMulOverride = 1;

  // v017_p01_polyrhythm_core: runtime scheduler state (not persisted)
  let polyTestActive = false;
  let polyTestStartMs = 0;
  let polyTestBpm = 0;
  let polySchedNextById = Object.create(null);


  // Mic v2 threshold (linear RMS)
  const DEFAULT_MIC_THRESHOLD = 0.06;
  if (!Number.isFinite(window.micThreshold)) window.micThreshold = DEFAULT_MIC_THRESHOLD;

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  // v014_p045a_spatial_pan_only: pan helpers (UI formatting + audio smoothing)
  const PAN_RAMP_SEC = 0.02;

  // v014_p045b_spatial_depth_and_send
  const DEPTH_RAMP_TC = 0.045; // 25–60ms smoothing (time constant)

  function sanitizeSpatialDepthMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (m === 'subtle') return 'subtle';
    if (m === 'strong') return 'strong';
    return 'normal';
  }

  function spatialDepthMultiplier(mode) {
    const m = sanitizeSpatialDepthMode(mode);
    if (m === 'subtle') return 0.6;
    if (m === 'strong') return 1.4;
    return 1.0;
  }

  function computeDepthTargets(depth, mode) {
    const d = clamp(Number(depth) || 0, 0, 1);
    const d2 = d * d;
    const mult = spatialDepthMultiplier(mode);
    const dry = clamp(1.0 + ((0.55 - 1.0) * d2 * mult), 0.35, 1.0);
    let hz = 18000 + ((2500 - 18000) * d2 * mult);
    hz = clamp(hz, 1200, 20000);
    try {
      if (audioCtx && audioCtx.sampleRate) {
        const ny = (audioCtx.sampleRate * 0.5) - 10;
        if (Number.isFinite(ny) && ny > 0) hz = Math.min(hz, ny);
      }
    } catch (_) {}
    const send = clamp(0.05 + ((0.45 - 0.05) * d2 * mult), 0, 0.7);
    return { dry, hz, send };
  }

  function createDepthStage(ctx, destBusNode, sendBusNode, nodesOut) {
    if (!ctx || !destBusNode) return null;
    const stage = { input: null, output: null, lpf: null, dryGain: null, wetSendGain: null };
    try {
      const input = ctx.createGain();
      try { input.gain.value = 1; } catch (_) {}

      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      try { lpf.Q.value = 0.707; } catch (_) {}

      const dryGain = ctx.createGain();
      try { dryGain.gain.value = 1; } catch (_) {}

      const wetSendGain = ctx.createGain();
      try { wetSendGain.gain.value = 0; } catch (_) {}

      input.connect(lpf);
      lpf.connect(dryGain);
      dryGain.connect(destBusNode);

      if (sendBusNode) {
        input.connect(wetSendGain);
        wetSendGain.connect(sendBusNode);
      }

      stage.input = input;
      stage.output = input;
      stage.lpf = lpf;
      stage.dryGain = dryGain;
      stage.wetSendGain = wetSendGain;

      if (nodesOut && Array.isArray(nodesOut)) {
        nodesOut.push(input, lpf, dryGain, wetSendGain);
      }
      return stage;
    } catch (_) {
      try { stage.input && stage.input.disconnect(); } catch (_) {}
      try { stage.lpf && stage.lpf.disconnect(); } catch (_) {}
      try { stage.dryGain && stage.dryGain.disconnect(); } catch (_) {}
      try { stage.wetSendGain && stage.wetSendGain.disconnect(); } catch (_) {}
      return null;
    }
  }

  function applyDepthOnStage(stage, depth, mode, instant) {
    if (!audioCtx || !stage) return;
    const t = computeDepthTargets(depth, mode);
    try { if (stage.dryGain && stage.dryGain.gain) fxSetParam(stage.dryGain.gain, t.dry, DEPTH_RAMP_TC, !!instant); } catch (_) {}
    try { if (stage.lpf && stage.lpf.frequency) fxSetParam(stage.lpf.frequency, t.hz, DEPTH_RAMP_TC, !!instant); } catch (_) {}
    try { if (stage.wetSendGain && stage.wetSendGain.gain) fxSetParam(stage.wetSendGain.gain, t.send, DEPTH_RAMP_TC, !!instant); } catch (_) {}
  }


  function fmtPan1(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0.0';
    const x = (Math.abs(n) < 0.0005) ? 0 : clamp(n, -1, 1);
    return x.toFixed(1);
  }

  // v014_p045b_spatial_depth_and_send
  function fmtDepth2(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0.00';
    const x = (Math.abs(n) < 0.0005) ? 0 : clamp(n, 0, 1);
    return x.toFixed(2);
  }

  function panRampParam(param, target, now) {
    if (!param) return;
    const t = Number.isFinite(now) ? now : ((audioCtx && Number.isFinite(audioCtx.currentTime)) ? audioCtx.currentTime : 0);
    const v = clamp(Number(target) || 0, -1, 1);
    try {
      param.cancelScheduledValues(t);
      const cur = Number(param.value);
      if (Number.isFinite(cur)) param.setValueAtTime(cur, t);
      param.linearRampToValueAtTime(v, t + PAN_RAMP_SEC);
    } catch (_) {
      try { param.setValueAtTime(v, t); } catch (_) {}
    }
  }

  function createPanStage(ctx, initialPan, destNode, nodesOut) {
    if (!ctx || !destNode) return null;
    const now = ctx.currentTime;
    const p0 = clamp(Number(initialPan) || 0, -1, 1);

    // Prefer StereoPannerNode if available.
    try {
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        try { p.pan.setValueAtTime(p0, now); } catch (_) { try { p.pan.value = p0; } catch (_) {} }
        let ok = false;
        try { p.connect(destNode); ok = true; } catch (_) {}
        if (!ok) { try { p.disconnect(); } catch (_) {} return null; }
        if (nodesOut && Array.isArray(nodesOut)) nodesOut.push(p);
        return { type: 'stereo', input: p, output: p, panner: p };
      }
    } catch (_) {}

    // Fallback: mono -> L/R gains -> merger.
    try {
      const input = ctx.createGain();
      try { input.channelCountMode = 'explicit'; input.channelCount = 1; input.channelInterpretation = 'speakers'; } catch (_) {}

      const lg = ctx.createGain();
      const rg = ctx.createGain();
      const merger = ctx.createChannelMerger(2);

      input.connect(lg);
      input.connect(rg);
      lg.connect(merger, 0, 0);
      rg.connect(merger, 0, 1);

      const l0 = clamp((p0 >= 0) ? (1 - p0) : 1, 0, 1);
      const r0 = clamp((p0 <= 0) ? (1 + p0) : 1, 0, 1);
      lg.gain.setValueAtTime(l0, now);
      rg.gain.setValueAtTime(r0, now);

      let ok = false;
      try { merger.connect(destNode); ok = true; } catch (_) {}
      if (!ok) {
        try { merger.disconnect(); } catch (_) {}
        try { input.disconnect(); } catch (_) {}
        try { lg.disconnect(); } catch (_) {}
        try { rg.disconnect(); } catch (_) {}
        return null;
      }
      if (nodesOut && Array.isArray(nodesOut)) nodesOut.push(input, lg, rg, merger);
      return { type: 'fallback', input, output: merger, leftGain: lg, rightGain: rg, merger };
    } catch (_) {}

    return null;
  }

  function setPanOnStage(stage, pan, now) {
    if (!stage || !audioCtx) return;
    const p = clamp(Number(pan) || 0, -1, 1);
    const t = Number.isFinite(now) ? now : audioCtx.currentTime;

    if (stage.type === 'stereo' && stage.panner && stage.panner.pan) {
      panRampParam(stage.panner.pan, p, t);
      return;
    }
    if (stage.type === 'fallback' && stage.leftGain && stage.rightGain) {
      const l = clamp((p >= 0) ? (1 - p) : 1, 0, 1);
      const r = clamp((p <= 0) ? (1 + p) : 1, 0, 1);
      try {
        stage.leftGain.gain.cancelScheduledValues(t);
        stage.leftGain.gain.setValueAtTime(stage.leftGain.gain.value, t);
        stage.leftGain.gain.linearRampToValueAtTime(l, t + PAN_RAMP_SEC);
      } catch (_) { try { stage.leftGain.gain.setValueAtTime(l, t); } catch (_) {} }
      try {
        stage.rightGain.gain.cancelScheduledValues(t);
        stage.rightGain.gain.setValueAtTime(stage.rightGain.gain.value, t);
        stage.rightGain.gain.linearRampToValueAtTime(r, t + PAN_RAMP_SEC);
      } catch (_) { try { stage.rightGain.gain.setValueAtTime(r, t); } catch (_) {} }
    }
  }

  function getBellPanInput(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    if (!audioCtx || !bellMasterGain) return null;
    ensureBellOverridesArrays();
    if (!bellPanStages) bellPanStages = new Array(13).fill(null);
    let st = bellPanStages[b];
    if (st && st.input) return st.input;

    const p0 = clamp(Number(state.bellPan[b]) || 0, -1, 1);
    let depthSt = null;
    try { depthSt = ensureBellDepthStage(b); } catch (_) { depthSt = null; }
    const depthDest = (depthSt && depthSt.input) ? depthSt.input : bellMasterGain;

    st = createPanStage(audioCtx, p0, depthDest, null);
    if (!st) return null;
    bellPanStages[b] = st;
    return st.input;
  }

  function applyBellPanToAudio(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    if (!audioCtx || !bellPanStages) return;
    const st = bellPanStages[b];
    if (!st) return;
    ensureBellOverridesArrays();
    setPanOnStage(st, state.bellPan[b], audioCtx.currentTime);
  }

  function perfNow() { return performance.now(); }

  function isMobileLikely() {
    try {
      return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth < 700;
    } catch (_) {
      return window.innerWidth < 700;
    }
  }

  async function requestWakeLock() {
    try {
      if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
      if (wakeLockSentinel) return;
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      try {
        if (wakeLockSentinel && typeof wakeLockSentinel.addEventListener === 'function') {
          wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
        }
      } catch (_) {}
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try {
      if (wakeLockSentinel) await wakeLockSentinel.release();
    } catch (_) {}
    wakeLockSentinel = null;
  }

  function isActiveRunForWakeLock() {
    // Wake-lock is for active attention only (Play/Demo countdown or running).
    return (state.phase === 'countdown' || state.phase === 'running');
  }

  function syncWakeLockForRun() {
    // Best effort: browsers release wake locks while hidden.
    if (document.hidden || !isActiveRunForWakeLock()) {
      releaseWakeLock();
    } else {
      requestWakeLock();
    }
  }

  function demoEffectiveHorizonMs() {
    const bpm = Math.max(1, Number(state.bpm) || 1);
    const beatMs = 60000 / bpm;
    // Interactive-only policy: keep scheduling modest. Demo may tolerate a bit more
    // lookahead while hidden on desktop to reduce background-tab timer throttling,
    // but we do not pre-schedule long runs to survive device lock / sleep.
    let baseHorizonMs = Math.max(LOOKAHEAD_MS, getMaintenanceIntervalMs());
    if (document.hidden && !isMobileLikely()) baseHorizonMs = Math.max(baseHorizonMs, 2500);
    const capMs = beatMs * DEMO_MAX_AHEAD_STRIKES;
    return Math.min(baseHorizonMs, capMs);
  }

  // === Audio ===
    // v014_p03_master_fx_limiter_reverb: single master bus routing (bells+drones → masterPreFX → reverb send/return → limiter → masterOut)
function ensureMasterFxGraph() {
  if (!audioCtx) return;

  if (!masterOut) {
    // Core nodes (deterministic; must reach destination)
    try { masterPreFX = audioCtx.createGain(); } catch (_) { masterPreFX = null; }
    try { if (masterPreFX) masterPreFX.gain.value = 1; } catch (_) {}

    try { masterSumGain = audioCtx.createGain(); } catch (_) { masterSumGain = null; }
    try { if (masterSumGain) masterSumGain.gain.value = 1; } catch (_) {}

    // Ensure a connectable master reverb send exists even if reverb init fails.
    try { masterReverbSend = audioCtx.createGain(); } catch (_) { masterReverbSend = null; }
    reverbSendGain = masterReverbSend;
    try { if (reverbSendGain) reverbSendGain.gain.value = 0; } catch (_) {}

    // Output + bypass chain (fail-open)
    try { masterLimiterPathGain = audioCtx.createGain(); } catch (_) { masterLimiterPathGain = null; }
    try { masterBypassPathGain = audioCtx.createGain(); } catch (_) { masterBypassPathGain = null; }
    try { masterOut = audioCtx.createGain(); } catch (_) { masterOut = null; }
    try { if (masterOut) masterOut.gain.value = 1; } catch (_) {}

    // Dry path
    try { if (masterPreFX && masterSumGain) masterPreFX.connect(masterSumGain); } catch (_) {}

    // Always wire a direct bypass to destination so audio never globally silences.
    try {
      if (masterSumGain && masterBypassPathGain) masterSumGain.connect(masterBypassPathGain);
      if (masterBypassPathGain && masterOut) masterBypassPathGain.connect(masterOut);
      if (masterOut) masterOut.connect(audioCtx.destination);
    } catch (_) {}

    // Default fail-open gains; applyMasterFxAll will override if limiter exists & enabled.
    try { if (masterBypassPathGain) masterBypassPathGain.gain.value = 1; } catch (_) {}
    try { if (masterLimiterPathGain) masterLimiterPathGain.gain.value = 0; } catch (_) {}

    // Optional reverb path (no-op if it fails)
    try { if (masterPreFX && reverbSendGain) masterPreFX.connect(reverbSendGain); } catch (_) {}
    try {
      reverbConvolver = audioCtx.createConvolver();
      try { reverbConvolver.normalize = true; } catch (_) {}

      reverbHighCut = audioCtx.createBiquadFilter();
      reverbHighCut.type = 'lowpass';
      try { reverbHighCut.Q.value = 0.707; } catch (_) {}
      try { reverbHighCut.frequency.value = clamp(Number(state.fxReverbHighCutHz) || 6000, 500, 20000); } catch (_) {}

      reverbReturnGain = audioCtx.createGain();
      try { reverbReturnGain.gain.value = 1; } catch (_) {}

      if (reverbSendGain && reverbConvolver) reverbSendGain.connect(reverbConvolver);
      if (reverbConvolver && reverbHighCut) reverbConvolver.connect(reverbHighCut);
      if (reverbHighCut && reverbReturnGain) reverbHighCut.connect(reverbReturnGain);
      if (reverbReturnGain && masterSumGain) reverbReturnGain.connect(masterSumGain);
    } catch (_) {
      // Keep send node connectable; wet chain can remain absent.
    }

    // Optional limiter path (fail-open keeps bypass alive)
    try {
      masterLimiter = audioCtx.createDynamicsCompressor();
      try {
        masterLimiter.knee.value = 0;
        masterLimiter.ratio.value = 20;
        masterLimiter.attack.value = 0.001;
        masterLimiter.release.value = 0.12;
      } catch (_) {}

      if (masterSumGain && masterLimiter) masterSumGain.connect(masterLimiter);
      if (masterLimiter && masterLimiterPathGain) masterLimiter.connect(masterLimiterPathGain);
      if (masterLimiterPathGain && masterOut) masterLimiterPathGain.connect(masterOut);
    } catch (_) {
      masterLimiter = null;
    }

    // Apply initial (persisted) settings (best effort; never block audio)
    try { applyMasterFxAll(true); } catch (_) {
      try { if (masterBypassPathGain) masterBypassPathGain.gain.value = 1; } catch (_) {}
      try { if (masterLimiterPathGain) masterLimiterPathGain.gain.value = 0; } catch (_) {}
      try { if (reverbSendGain) reverbSendGain.gain.value = 0; } catch (_) {}
    }
  } else {
    // Back-compat: keep a stable master reverb send alias.
    if (!masterReverbSend && reverbSendGain) masterReverbSend = reverbSendGain;
    if (!reverbSendGain && masterReverbSend) reverbSendGain = masterReverbSend;
  }

  // Route existing bell + drone masters into the shared masterPreFX bus (fail-open).
  if (bellMasterGain && droneMasterGain) {
    const fallback = audioCtx.destination;
    const routeOne = (bus) => {
      if (!bus) return false;
      let ok = false;
      try { bus.disconnect(); } catch (_) {}
      try { if (masterPreFX) { bus.connect(masterPreFX); ok = true; } } catch (_) { ok = false; }
      if (!ok) {
        try { bus.connect(fallback); } catch (_) {}
      }
      return ok;
    };

    if (!masterFxRouted) {
      const okB = routeOne(bellMasterGain);
      const okD = routeOne(droneMasterGain);
      masterFxRouted = !!(okB && okD);
    }
  }


  // v017_p01_polyrhythm_core: route polyrhythm master into the shared masterPreFX bus (fail-open).
  if (polyMasterGain && !polyFxRouted) {
    const fallback = audioCtx.destination;
    let okP = false;
    try { polyMasterGain.disconnect(); } catch (_) {}
    try { if (masterPreFX) { polyMasterGain.connect(masterPreFX); okP = true; } } catch (_) { okP = false; }
    if (!okP) {
      try { polyMasterGain.connect(fallback); } catch (_) {}
    }
    polyFxRouted = !!okP;
  }
}

// v014_p045b_spatial_depth_and_send
function ensureBellDepthStage(bell) {
  const b = clamp(parseInt(String(bell), 10) || 0, 1, 12);
  if (!audioCtx || !bellMasterGain) return null;
  ensureBellOverridesArrays();
  if (!bellDepthStages) bellDepthStages = new Array(13).fill(null);

  let st = bellDepthStages[b];
  if (st && st.input) return st;

  const sendBus = masterReverbSend || reverbSendGain || null;
  st = createDepthStage(audioCtx, bellMasterGain, sendBus, null);
  if (!st) return null;
  bellDepthStages[b] = st;
  try { applyDepthOnStage(st, clamp(Number(state.bellDepth[b]) || 0, 0, 1), state.spatialDepthMode, true); } catch (_) {}
  return st;
}

function applyBellDepthToAudio(bell, instant) {
  const b = clamp(parseInt(String(bell), 10) || 0, 1, 12);
  if (!audioCtx || !bellDepthStages) return;
  const st = bellDepthStages[b];
  if (!st) return;
  ensureBellOverridesArrays();
  const d = clamp(Number(state.bellDepth[b]) || 0, 0, 1);
  applyDepthOnStage(st, d, state.spatialDepthMode, !!instant);
}


function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();

      // Master gain for bell sounds (global bell volume slider)
      bellMasterGain = audioCtx.createGain();
      bellMasterGain.gain.value = clamp((Number(state.bellVolume) || 100) / 100, 0, 1);

      // Master gain for the drone (separate from bell volume)
      droneMasterGain = audioCtx.createGain();
      droneMasterGain.gain.value = clamp((Number(state.droneVolume) || 50) / 100, 0, 1);

      // v017_p01_polyrhythm_core: master gain for polyrhythm layers (separate from bell volume)
      polyMasterGain = audioCtx.createGain();
      polyMasterGain.gain.value = clamp((Number(state.polyMasterVolume) || 80) / 100, 0, 1);

      // v014_p03_master_fx_limiter_reverb: wire bells+drones into a single master bus (FX + limiter)
      try { ensureMasterFxGraph(); } catch (_) {
              // Fail-open: never leave master buses disconnected on init errors.
              try { if (bellMasterGain) bellMasterGain.disconnect(); } catch (_) {}
              try { if (droneMasterGain) droneMasterGain.disconnect(); } catch (_) {}
              try { if (polyMasterGain) polyMasterGain.disconnect(); } catch (_) {}
              try { if (bellMasterGain) bellMasterGain.connect(audioCtx.destination); } catch (_) {}
              try { if (droneMasterGain) droneMasterGain.connect(audioCtx.destination); } catch (_) {}
              try { if (polyMasterGain) polyMasterGain.connect(audioCtx.destination); } catch (_) {}
            }

      noiseBuffer = null;
      noiseBufferSampleRate = 0;
    } else {
      let created = false;
      if (!bellMasterGain) {
        bellMasterGain = audioCtx.createGain();
        bellMasterGain.gain.value = clamp((Number(state.bellVolume) || 100) / 100, 0, 1);
        created = true;
      }
      if (!droneMasterGain) {
        droneMasterGain = audioCtx.createGain();
        droneMasterGain.gain.value = clamp((Number(state.droneVolume) || 50) / 100, 0, 1);
        created = true;
      }
      if (!polyMasterGain) {
        // v017_p01_polyrhythm_core: master gain for polyrhythm layers (separate from bell volume)
        polyMasterGain = audioCtx.createGain();
        polyMasterGain.gain.value = clamp((Number(state.polyMasterVolume) || 80) / 100, 0, 1);
        created = true;
      }
      if (created) {
        masterFxRouted = false;
        polyFxRouted = false;
      }
      try { ensureMasterFxGraph(); } catch (_) {
              // Fail-open: never leave master buses disconnected on init errors.
              try { if (bellMasterGain) bellMasterGain.disconnect(); } catch (_) {}
              try { if (droneMasterGain) droneMasterGain.disconnect(); } catch (_) {}
              try { if (polyMasterGain) polyMasterGain.disconnect(); } catch (_) {}
              try { if (bellMasterGain) bellMasterGain.connect(audioCtx.destination); } catch (_) {}
              try { if (droneMasterGain) droneMasterGain.connect(audioCtx.destination); } catch (_) {}
              try { if (polyMasterGain) polyMasterGain.connect(audioCtx.destination); } catch (_) {}
            }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

function closeAudio() {
    if (audioCtx) {
      // v09_p08p_background_policy_and_drone_ownership:
      // Keep the shared AudioContext alive while any background-capable audio is active.
      // (Drone, Mic, future Meditation). Do not close during an active run.
      if (state.phase !== 'idle') return;
      if (state.meditationActive) return;
      if (state.droneOn) return;
      if (state.micEnabled || state.micActive) return;
      // v10_p05_sound_per_bell_hz_slider_preview: ensure any preview oscillator is stopped before closing.
      try { cancelHzSliderPreviewGesture(); } catch (_) {}
      try { stopHzPreviewTone(); } catch (_) {}
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
      bellMasterGain = null;
      droneMasterGain = null;
      bellPanStages = null;
      bellDepthStages = null;
      droneCurrent = null;
      noiseBuffer = null;
      noiseBufferSampleRate = 0;
// v014_p03_master_fx_limiter_reverb: reset master FX nodes
masterPreFX = null;
masterSumGain = null;
masterOut = null;
masterLimiter = null;
masterLimiterPathGain = null;
masterBypassPathGain = null;
reverbSendGain = null;
masterReverbSend = null;
reverbConvolver = null;
reverbHighCut = null;
reverbReturnGain = null;
masterFxRouted = false;
polyFxRouted = false; // v017_p01_polyrhythm_core
reverbImpulseQuant = null;
if (reverbImpulseRebuildTimer) {
  try { window.clearTimeout(reverbImpulseRebuildTimer); } catch (_) {}
  reverbImpulseRebuildTimer = 0;
}
    }
  }
  function msToAudioTime(whenMs) {
    ensureAudio();
    const deltaMs = Math.max(0, whenMs - perfNow());
    return audioCtx.currentTime + deltaMs / 1000;
  }

  function getBellFrequencyDefault(bell) {
    const i = bell - 1;
    return state.bellFreq[i] || 440;
  }

  // v08_p05_sound_per_bell_overrides
  function getBellFrequencyFromKeyOct(bell, scaleKey, octaveC) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const stage = clamp(parseInt(state.stage, 10) || 1, 1, 12);
    const bb = clamp(b, 1, stage);
    const key = String(scaleKey || state.scaleKey || '');

    let def;
    let rootFreq;
    if (key === 'custom_hz') {
      def = getScaleDef();
      rootFreq = coerceCustomHz(state.bellCustomHz, 440);
      const o = clamp(parseInt(octaveC, 10) || state.octaveC, 1, 6);
      const o0 = clamp(parseInt(state.octaveC, 10) || 4, 1, 6);
      if (o !== o0) rootFreq = rootFreq * Math.pow(2, (o - o0));
    } else {
      def = getScaleDefByKey(key);
      const o = clamp(parseInt(octaveC, 10) || state.octaveC, 1, 6);
      const rootMidi = noteToMidi(def.root, o);
      rootFreq = midiToFreq(rootMidi);
    }

    const intervals = downsampleIntervals(def.intervals, stage);
    const off = intervals[stage - bb];
    return rootFreq * Math.pow(2, off / 12);
  }

  // v017_p01_polyrhythm_core: stage-independent frequency helpers (treat as stage=12 for default pitches)
  function getBellFrequencyFromKeyOctStage(bell, scaleKey, octaveC, stageOverride) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const stage = clamp(parseInt(stageOverride, 10) || 12, 1, 12);
    const bb = clamp(b, 1, stage);
    const key = String(scaleKey || state.scaleKey || '');

    let def;
    let rootFreq;
    if (key === 'custom_hz') {
      def = getScaleDef();
      rootFreq = coerceCustomHz(state.bellCustomHz, 440);
      const o = clamp(parseInt(octaveC, 10) || state.octaveC, 1, 6);
      const o0 = clamp(parseInt(state.octaveC, 10) || 4, 1, 6);
      if (o !== o0) rootFreq = rootFreq * Math.pow(2, (o - o0));
    } else {
      def = getScaleDefByKey(key);
      const o = clamp(parseInt(octaveC, 10) || state.octaveC, 1, 6);
      const rootMidi = noteToMidi(def.root, o);
      rootFreq = midiToFreq(rootMidi);
    }

    const intervals = downsampleIntervals(def.intervals, stage);
    const off = intervals[stage - bb];
    return rootFreq * Math.pow(2, off / 12);
  }

  function getPolyBellFrequencyDefault(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const rootFreq = getBellRootFrequency();
    const offsets = getBellPitchOffsets(12) || [];
    const off = (offsets[b - 1] != null) ? Number(offsets[b - 1]) : 0;
    return rootFreq * Math.pow(2, off / 12);
  }

  function getPolyBellHz(bell, soundCtx) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const ctx = soundCtx || null;
    if (ctx && ctx.profile === 'custom' && ctx.bs) {
      const bs = ctx.bs;
      const pb = (bs.perBell && bs.perBell[b]) ? bs.perBell[b] : null;

      let hz = getPolyBellFrequencyDefault(b);
      if (pb && pb.pitch) {
        const hzOv = Number((pb.pitch.hz != null) ? pb.pitch.hz : pb.pitch.hzOverride);
        if (Number.isFinite(hzOv) && hzOv > 0) hz = hzOv;
      }

      let semis = 0;
      if (bs.pitch && bs.pitch.layerTransposeSemis != null) {
        semis += clamp(parseInt(bs.pitch.layerTransposeSemis, 10) || 0, -24, 24);
      }
      if (pb && pb.pitch && pb.pitch.transposeSemis != null) {
        semis += clamp(parseInt(pb.pitch.transposeSemis, 10) || 0, -24, 24);
      }

      if (semis !== 0) hz = hz * Math.pow(2, semis / 12);
      return hz;
    }


    const ov = (state.bellHzOverride && state.bellHzOverride[b] != null) ? Number(state.bellHzOverride[b]) : NaN;
    if (Number.isFinite(ov) && ov > 0) return ov;

    const hasKeyOv = (state.bellKeyOverride && state.bellKeyOverride[b] != null) && String(state.bellKeyOverride[b] || '').trim();
    const hasOctOv = (state.bellOctaveOverride && state.bellOctaveOverride[b] != null) && Number.isFinite(Number(state.bellOctaveOverride[b]));

    if (hasKeyOv || hasOctOv) {
      const key = hasKeyOv ? String(state.bellKeyOverride[b] || '').trim() : String(state.scaleKey || '');
      const oct = hasOctOv ? Number(state.bellOctaveOverride[b]) : Number(state.octaveC);
      return getBellFrequencyFromKeyOctStage(b, key, oct, 12);
    }

    return getPolyBellFrequencyDefault(b);
  }

  function getPolyBellFrequency(bell, soundCtx) { return getPolyBellHz(bell, soundCtx); }


  function getBellHz(bell) {
    const b = parseInt(bell, 10) || 0;
    const ov = (state.bellHzOverride && state.bellHzOverride[b] != null) ? Number(state.bellHzOverride[b]) : NaN;
    if (Number.isFinite(ov) && ov > 0) return ov;

    const hasKeyOv = (state.bellKeyOverride && state.bellKeyOverride[b] != null) && String(state.bellKeyOverride[b] || '').trim();
    const hasOctOv = (state.bellOctaveOverride && state.bellOctaveOverride[b] != null) && Number.isFinite(Number(state.bellOctaveOverride[b]));
    if (hasKeyOv || hasOctOv) {
      const key = hasKeyOv ? String(state.bellKeyOverride[b]) : String(state.scaleKey);
      const oct = hasOctOv ? clamp(parseInt(String(state.bellOctaveOverride[b]), 10) || state.octaveC, 1, 6) : state.octaveC;
      return getBellFrequencyFromKeyOct(b, key, oct);
    }
    return getBellFrequencyDefault(bell);
  }

  function getBellGain(bell, soundCtx) {
    const ctx = soundCtx || null;
    if (ctx && ctx.profile === 'custom') return 1;
    const b = parseInt(bell, 10) || 0;
    const ovRaw = (state.bellVolOverride && state.bellVolOverride[b] != null) ? Number(state.bellVolOverride[b]) : NaN;
    if (!Number.isFinite(ovRaw)) return 1;
    return clamp(ovRaw / 100, 0, 1);
  }

  // Back-compat name (used throughout the existing audio code)
  function getBellFrequency(bell) {
    return getBellHz(bell);
  }

  // v10_p08_sound_global_chords_splitstrike: Global chord config + helpers
  const GLOBAL_CHORD_PRESETS = {
    unison: [0],
    octave: [0, 12],
    fifth: [0, 7],
    power: [0, 7, 12],
    major: [0, 4, 7],
    minor: [0, 3, 7],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    maj7: [0, 4, 7, 11],
    min7: [0, 3, 7, 10],
    // v014_p01_global_custom_chords_advanced: authorable semitone list
    custom: [0, 4, 7],
    // v10_p09_sound_per_bell_chords_overrides: 5-tone partial stack (allow 5 voices when selected)
    bell_partials5: [-12, 0, 3, 7, 12],
  };
  const GLOBAL_CHORD_PRESET_ORDER = ['unison','octave','fifth','power','major','minor','sus2','sus4','maj7','min7','bell_partials5'];
  // v014_p01_global_custom_chords_advanced: include Custom preset only for the global Chords dropdown
  const GLOBAL_CHORD_PRESET_ORDER_GLOBAL_UI = GLOBAL_CHORD_PRESET_ORDER.concat(['custom']);
  const GLOBAL_CHORD_INVERSION_ORDER = ['root','first','second','third'];
  const GLOBAL_CHORD_SPREAD_ORDER = ['close','open'];
  const GLOBAL_CHORD_SPLIT_ORDER = ['simultaneous','belllike'];

  function chordPresetLabel(k) {
    const LABEL = {
      unison: 'Unison (root)',
      octave: 'Octave (0, +12)',
      fifth: 'Fifth (0, +7)',
      power: 'Power (0, +7, +12)',
      major: 'Major (0, +4, +7)',
      minor: 'Minor (0, +3, +7)',
      sus2: 'Sus2 (0, +2, +7)',
      sus4: 'Sus4 (0, +5, +7)',
      maj7: 'Maj7 (0, +4, +7, +11)',
      min7: 'Min7 (0, +3, +7, +10)',
      custom: 'Custom',
      bell_partials5: 'Bell partials (5) (-12, 0, +3, +7, +12)',
    };
    const kk = String(k || '').trim();
    return LABEL[kk] || kk;
  }

  function chordVoiceCapForPreset(preset) {
    const p = String(preset || '').trim();
    // Preferred approach: allow 5 tones only for the 5-tone partial preset; keep the legacy cap of 4 otherwise.
    if (p === 'bell_partials5') return 5;
    return 4;
  }

  function globalChordDefaults() {
    return {
      enabled: false,
      size: 'single',
      preset: 'unison',
      inversion: 'root',
      spread: 'close',
      splitStrike: 'simultaneous',
      stepMs: 6,
      maxMs: 12,
      // v014_p01_global_custom_chords_advanced
      customIntervals: '0, 4, 7, 12',
      globalDetuneCents: 0,
      globalLevelMode: 'equal',
      globalLevelGains: '',
      globalSplitOffsetMode: 'auto',
      globalSplitOffsetsMs: '',
    };
  }

  function globalChordSizeFromPreset(preset) {
    const k = String(preset || '').toLowerCase();
    if (k === 'octave' || k === 'fifth') return 'dyad';
    if (k === 'power' || k === 'major' || k === 'minor' || k === 'sus2' || k === 'sus4') return 'triad';
    if (k === 'maj7' || k === 'min7') return 'tetrad';
    if (k === 'bell_partials5') return 'pentad';
    return 'single';
  }

  function sanitizeGlobalChordConfig(raw) {
    const d = globalChordDefaults();
    const out = Object.assign({}, d);

    if (raw && typeof raw === 'object') {
      const en = raw.enabled;
      if (typeof en === 'boolean') out.enabled = en;
      else if (en === 1 || en === '1' || en === 'true' || en === 'on') out.enabled = true;
      else if (en === 0 || en === '0' || en === 'false' || en === 'off') out.enabled = false;

      const p = String(raw.preset || raw.quality || raw.qualityPreset || raw.chord || '').trim();
      if (p && GLOBAL_CHORD_PRESETS[p]) out.preset = p;

      const inv = String(raw.inversion || '').trim();
      if (inv && GLOBAL_CHORD_INVERSION_ORDER.includes(inv)) out.inversion = inv;

      const sp = String(raw.spread || '').trim();
      if (sp && GLOBAL_CHORD_SPREAD_ORDER.includes(sp)) out.spread = sp;

      const ss = String(raw.splitStrike || raw.split || '').trim();
      if (ss && GLOBAL_CHORD_SPLIT_ORDER.includes(ss)) out.splitStrike = ss;

      const st = parseFloat(raw.stepMs);
      if (Number.isFinite(st)) out.stepMs = clamp(Math.round(st), 0, 15);
      const mx = parseFloat(raw.maxMs);
      if (Number.isFinite(mx)) out.maxMs = clamp(Math.round(mx), 0, 18);

      // v014_p01_global_custom_chords_advanced
      if (raw.customIntervals != null) out.customIntervals = String(raw.customIntervals);

      const gd = parseFloat(raw.globalDetuneCents);
      if (Number.isFinite(gd)) out.globalDetuneCents = clamp(Math.round(gd), -20, 20);

      const lm = String(raw.globalLevelMode || '').trim();
      if (lm === 'equal' || lm === 'custom') out.globalLevelMode = lm;
      if (raw.globalLevelGains != null) out.globalLevelGains = String(raw.globalLevelGains);

      const som = String(raw.globalSplitOffsetMode || '').trim();
      if (som === 'auto' || som === 'custom') out.globalSplitOffsetMode = som;
      if (raw.globalSplitOffsetsMs != null) out.globalSplitOffsetsMs = String(raw.globalSplitOffsetsMs);
    }

    // Keep size in sync with preset so preset selection always produces the expected chord.
    out.size = globalChordSizeFromPreset(out.preset);

    // Inversion is only meaningful for triads/tetrads; clamp to root otherwise.
    if (out.size === 'single' || out.size === 'dyad') out.inversion = 'root';

    // Defensive clamping (in case callers mutated fields directly).
    out.stepMs = clamp(Math.round(Number(out.stepMs) || d.stepMs), 0, 15);
    out.maxMs = clamp(Math.round(Number(out.maxMs) || d.maxMs), 0, 18);

    // v014_p01_global_custom_chords_advanced
    out.customIntervals = String((out.customIntervals != null) ? out.customIntervals : d.customIntervals);
    out.globalDetuneCents = clamp(Math.round(Number(out.globalDetuneCents) || 0), -20, 20);
    out.globalLevelMode = (String(out.globalLevelMode) === 'custom') ? 'custom' : 'equal';
    out.globalLevelGains = String((out.globalLevelGains != null) ? out.globalLevelGains : d.globalLevelGains);
    out.globalSplitOffsetMode = (String(out.globalSplitOffsetMode) === 'custom') ? 'custom' : 'auto';
    out.globalSplitOffsetsMs = String((out.globalSplitOffsetsMs != null) ? out.globalSplitOffsetsMs : d.globalSplitOffsetsMs);

    return out;
  }

  function loadGlobalChordFromLS() {
    const raw = safeJsonParse(safeGetLS(LS_GLOBAL_CHORD) || '');
    return sanitizeGlobalChordConfig(raw);
  }

  function saveGlobalChordToLS() {
    if (!state.globalChord) return;
    safeSetLS(LS_GLOBAL_CHORD, JSON.stringify(sanitizeGlobalChordConfig(state.globalChord)));
  }


    // v014_p05a_bell_timbre_global (global bell strike timbre shaping; bells only)
  const BELL_RING_LENGTH_DEFAULT = 0.5;
  const BELL_BRIGHTNESS_DEFAULT = 0.5;
  const BELL_STRIKE_HARDNESS_DEFAULT = 0.0;

  function sanitizeBellTimbreConfig(raw) {
    const out = {
      bellRingLength: BELL_RING_LENGTH_DEFAULT,
      bellBrightness: BELL_BRIGHTNESS_DEFAULT,
      bellStrikeHardness: BELL_STRIKE_HARDNESS_DEFAULT,
    };
    if (raw && typeof raw === 'object') {
      const rl = Number(raw.bellRingLength);
      if (Number.isFinite(rl)) out.bellRingLength = clamp(rl, 0, 1);
      const br = Number(raw.bellBrightness);
      if (Number.isFinite(br)) out.bellBrightness = clamp(br, 0, 1);
      const hd = Number(raw.bellStrikeHardness);
      if (Number.isFinite(hd)) out.bellStrikeHardness = clamp(hd, 0, 1);
    }
    // snap near defaults to avoid drift
    if (Math.abs(out.bellRingLength - BELL_RING_LENGTH_DEFAULT) < 1e-6) out.bellRingLength = BELL_RING_LENGTH_DEFAULT;
    if (Math.abs(out.bellBrightness - BELL_BRIGHTNESS_DEFAULT) < 1e-6) out.bellBrightness = BELL_BRIGHTNESS_DEFAULT;
    if (Math.abs(out.bellStrikeHardness - BELL_STRIKE_HARDNESS_DEFAULT) < 1e-6) out.bellStrikeHardness = BELL_STRIKE_HARDNESS_DEFAULT;
    return out;
  }

  function loadBellTimbreFromLS() {
    const raw = safeJsonParse(safeGetLS(LS_BELL_TIMBRE_GLOBAL) || '');
    return sanitizeBellTimbreConfig(raw);
  }

  function saveBellTimbreToLS() {
    const out = sanitizeBellTimbreConfig({
      bellRingLength: state.bellRingLength,
      bellBrightness: state.bellBrightness,
      bellStrikeHardness: state.bellStrikeHardness,
    });
    safeSetLS(LS_BELL_TIMBRE_GLOBAL, JSON.stringify(out));
  }

  function syncBellTimbreUI() {
    if (bellRingLength) bellRingLength.value = String(clamp(Number(state.bellRingLength) || BELL_RING_LENGTH_DEFAULT, 0, 1));
    if (bellRingLengthValue) bellRingLengthValue.textContent = fmtDepth2(state.bellRingLength);
    if (bellBrightness) bellBrightness.value = String(clamp(Number(state.bellBrightness) || BELL_BRIGHTNESS_DEFAULT, 0, 1));
    if (bellBrightnessValue) bellBrightnessValue.textContent = fmtDepth2(state.bellBrightness);
    if (bellStrikeHardness) bellStrikeHardness.value = String(clamp(Number(state.bellStrikeHardness) || BELL_STRIKE_HARDNESS_DEFAULT, 0, 1));
    if (bellStrikeHardnessValue) bellStrikeHardnessValue.textContent = fmtDepth2(state.bellStrikeHardness);
  }

  function bellRingLengthMult01(v01) {
    const x = clamp(Number(v01) || 0, 0, 1);
    // 0.5 is legacy; range ~0.5x..2x
    return Math.pow(4, x - BELL_RING_LENGTH_DEFAULT);
  }

  function bellBrightnessCutoffHz(v01, sampleRate) {
    const sr = Math.max(8000, Number(sampleRate) || 48000);
    const ny = 0.5 * sr;
    const maxHz = ny * 0.95;
    const minHz = 350;
    const x = clamp(Number(v01) || BELL_BRIGHTNESS_DEFAULT, 0, 1);
    if (x >= BELL_BRIGHTNESS_DEFAULT) return maxHz;
    const u = clamp(x / BELL_BRIGHTNESS_DEFAULT, 0, 1);
    return minHz * Math.pow(maxHz / minHz, u);
  }

// v014_p01_global_custom_chords_advanced: global custom preset + advanced parsing helpers
  let globalCustomChordLastGoodIntervals = [0, 4, 7];

  function parseCustomChordIntervalsText(raw, cap) {
    const tokens = String(raw || '').split(/[\s,]+/);
    const vals = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = String(tokens[i] || '').trim();
      if (!t) continue;
      const n = parseInt(t, 10);
      if (!Number.isFinite(n)) continue;
      vals.push(clamp(n, -24, 24));
    }
    if (vals.length === 0) return { ok: false, vals: [], autoAddedZero: false };
    let hasZero = false;
    for (let i = 0; i < vals.length; i++) { if (vals[i] === 0) { hasZero = true; break; } }
    let autoAddedZero = false;
    if (!hasZero) { vals.unshift(0); autoAddedZero = true; }
    const out = (typeof cap === 'number' && cap > 0) ? vals.slice(0, cap) : vals;
    return { ok: out.length > 0, vals: out, autoAddedZero };
  }

  function parseGlobalChordVoiceGainsText(raw, n) {
    const N = clamp(parseInt(n, 10) || 1, 1, 6);
    const out = new Array(N);
    for (let i = 0; i < N; i++) out[i] = 1;
    const tokens = String(raw || '').split(/[\s,]+/);
    let j = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = String(tokens[i] || '').trim();
      if (!t) continue;
      const x = parseFloat(t);
      if (!Number.isFinite(x)) continue;
      if (j >= N) break;
      out[j] = Math.max(0, x);
      j++;
    }
    return out;
  }

  function parseGlobalChordSplitOffsetsText(raw, n, stepMs) {
    const N = clamp(parseInt(n, 10) || 1, 1, 6);
    const out = new Array(N);
    const tokens = String(raw || '').split(/[\s,]+/);
    const vals = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = String(tokens[i] || '').trim();
      if (!t) continue;
      const x = parseFloat(t);
      if (!Number.isFinite(x)) continue;
      vals.push(Math.max(0, x));
    }
    // Allow omitting the leading 0; treat first offset as 0 when omitted.
    if (vals.length && vals[0] !== 0) vals.unshift(0);

    const st = parseFloat(stepMs);
    const step = Number.isFinite(st) ? Math.max(0, st) : 6;

    let last = 0;
    for (let i = 0; i < N; i++) {
      if (i < vals.length) out[i] = vals[i];
      else out[i] = last + step;
      last = out[i];
    }
    out[0] = 0;
    return out;
  }

  function deriveGlobalChordSemitones(cfg) {
    const c = cfg || state.globalChord;
    if (!c || !c.enabled) return [0];
    const preset = (c.preset && GLOBAL_CHORD_PRESETS[c.preset]) ? c.preset : 'unison';
    const cap = Math.min(6, chordVoiceCapForPreset(preset));

    if (preset === 'custom') {
      const parsed = parseCustomChordIntervalsText(c.customIntervals, cap);
      if (parsed && parsed.ok && parsed.vals && parsed.vals.length) {
        globalCustomChordLastGoodIntervals = parsed.vals.slice(0, cap);
        return parsed.vals.slice(0, cap);
      }
      const fallback = (globalCustomChordLastGoodIntervals && globalCustomChordLastGoodIntervals.length)
        ? globalCustomChordLastGoodIntervals
        : (GLOBAL_CHORD_PRESETS.custom || [0, 4, 7]);
      return fallback.slice(0, cap);
    }

    let semis = (GLOBAL_CHORD_PRESETS[preset] || [0]).slice(0, cap);

    // Apply inversion + spread only when they can matter.
    if (semis.length >= 3) {
      const inv = String(c.inversion || 'root');
      let shift = (inv === 'first') ? 1 : (inv === 'second') ? 2 : (inv === 'third') ? 3 : 0;
      shift = clamp(shift, 0, semis.length - 1);
      if (shift > 0) {
        semis = semis.slice();
        for (let i = 0; i < shift; i++) semis[i] += 12;
      }

      const spread = String(c.spread || 'close');
      if (spread === 'open') {
        // Simple open voicing: push the second-lowest chord tone up an octave.
        semis = semis.slice();
        semis[1] += 12;
      }
      semis.sort((a, b) => a - b);
    }

    // Cap voices (safety)
    if (semis.length > cap) semis = semis.slice(0, cap);
    return semis;
  }

  function deriveGlobalChordOffsetsMs(cfg, n) {
    const c = cfg || state.globalChord;
    const N = clamp(parseInt(n, 10) || 1, 1, 6);
    const out = new Array(N);

    const mode = c ? String(c.splitStrike || 'simultaneous') : 'simultaneous';
    if (mode === 'belllike') {
      const step = clamp(parseInt(String(c.stepMs), 10) || 0, 0, 15);
      const max = clamp(parseInt(String(c.maxMs), 10) || 0, 0, 18);
      for (let i = 0; i < N; i++) out[i] = (i === 0) ? 0 : Math.min(i * step, max);
    } else {
      for (let i = 0; i < N; i++) out[i] = 0;
    }
    out[0] = 0;
    return out;
  }

  // v10_p09_sound_per_bell_chords_overrides: per-bell chord override resolution + derivation
  function resolveBellChordOverrideForStrike(bell, soundCtx) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const ctx = soundCtx || null;
    if (ctx && ctx.profile === 'custom' && ctx.bs) {
      const bs = ctx.bs;
      const pb = (bs.perBell && bs.perBell[b]) ? bs.perBell[b] : null;
      const src = (pb && pb.chords && typeof pb.chords === 'object')
        ? pb.chords
        : ((bs.chords && typeof bs.chords === 'object') ? bs.chords : null);

      const en = src ? !!src.enabled : false;
      const presetRaw = (src && src.preset) ? String(src.preset) : 'unison';
      const preset = (GLOBAL_CHORD_PRESETS && GLOBAL_CHORD_PRESETS[presetRaw]) ? presetRaw : 'unison';

      let intervals = null;
      if (src && src._intervals && src._intervals.length) {
        intervals = src._intervals.slice(0, 6);
      } else {
        const t = String((src && src.customIntervals) || '').trim();
        if (t) {
          const parsed = parseCustomChordIntervalsText(t, 6);
          if (parsed && parsed.ok && parsed.vals && parsed.vals.length) intervals = parsed.vals.slice(0, 6);
        }
      }

      // Always return a chord config (even when disabled) so custom layers bypass global chord settings.
      return {
        enabled: en,
        preset,
        inversion: 'root',
        spread: 'close',
        splitStrike: 'simultaneous',
        stepMs: 6,
        maxMs: 12,
        customIntervals: intervals,
        customSplitOffsets: null,
        detune: null,
        levels: null,
      };
    }

    ensureBellChordOverridesArray();
    const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
    state.bellChordOverrides[b] = cfg;
    if (cfg.mode !== 'override' || !cfg.enabled) return null;

    const g = state.globalChord ? sanitizeGlobalChordConfig(state.globalChord) : globalChordDefaults();

    // Split-strike: per-bell can inherit global, or override to simultaneous/bell-like.
    const sm = String(cfg.splitStrikeMode || 'inherit');
    let splitStrike = 'simultaneous';
    let stepMs = 6;
    let maxMs = 12;
    let customSplitOffsets = null;

    if (sm === 'inherit') {
      splitStrike = String((g && g.splitStrike) || 'simultaneous');
      stepMs = clamp(parseInt(String(g && g.stepMs), 10) || 0, 0, 15);
      maxMs = clamp(parseInt(String(g && g.maxMs), 10) || 0, 0, 18);
      // Custom split offsets are only applied when the bell explicitly overrides split-strike.
      customSplitOffsets = null;
    } else if (sm === 'belllike') {
      splitStrike = 'belllike';
      stepMs = clamp(parseInt(String(cfg.splitStepMs), 10) || 0, 0, 15);
      maxMs = clamp(parseInt(String(cfg.splitMaxMs), 10) || 0, 0, 18);
      customSplitOffsets = (cfg._splitOffsets && cfg._splitOffsets.length) ? cfg._splitOffsets.slice(0, 6) : null;
    } else {
      splitStrike = 'simultaneous';
    }

    return {
      enabled: true,
      preset: (cfg.preset && GLOBAL_CHORD_PRESETS[cfg.preset]) ? String(cfg.preset) : 'unison',
      inversion: GLOBAL_CHORD_INVERSION_ORDER.includes(String(cfg.inversion || 'root')) ? String(cfg.inversion) : 'root',
      spread: GLOBAL_CHORD_SPREAD_ORDER.includes(String(cfg.spread || 'close')) ? String(cfg.spread) : 'close',
      splitStrike,
      stepMs,
      maxMs,
      // Interval precedence: custom intervals override preset-derived semitones.
      customIntervals: (cfg._intervals && cfg._intervals.length) ? cfg._intervals.slice(0, 6) : null,
      customSplitOffsets,
      detune: (cfg._detune && cfg._detune.length) ? cfg._detune.slice(0, 6) : null,
      levels: (cfg._levels && cfg._levels.length) ? cfg._levels.slice(0, 6) : null,
    };
  }

  function deriveChordSemitonesFromAnyConfig(cfg) {
    const c = cfg || null;
    if (!c || !c.enabled) return [0];

    const preset = (c.preset && GLOBAL_CHORD_PRESETS[c.preset]) ? String(c.preset) : 'unison';
    const useCustom = (c.customIntervals && Array.isArray(c.customIntervals) && c.customIntervals.length);
    let semis = useCustom ? c.customIntervals.slice() : (GLOBAL_CHORD_PRESETS[preset] || [0]).slice();

    // Safety: hard cap 6 tones. If using a preset, keep the legacy cap of 4 (5 only for bell_partials5).
    const cap = Math.min(6, useCustom ? 6 : chordVoiceCapForPreset(preset));
    if (semis.length > cap) semis = semis.slice(0, cap);

    // Apply inversion + spread only when they can matter.
    if (semis.length >= 3) {
      const inv = String(c.inversion || 'root');
      let shift = (inv === 'first') ? 1 : (inv === 'second') ? 2 : (inv === 'third') ? 3 : 0;
      shift = clamp(shift, 0, semis.length - 1);
      if (shift > 0) {
        semis = semis.slice();
        for (let i = 0; i < shift; i++) semis[i] += 12;
      }
      const spread = String(c.spread || 'close');
      if (spread === 'open') {
        semis = semis.slice();
        semis[1] += 12;
      }
      semis.sort((a, b) => a - b);
    }

    if (semis.length > 6) semis = semis.slice(0, 6);
    return semis;
  }

  function deriveChordOffsetsMsFromAnyConfig(cfg, n) {
    const c = cfg || null;
    const N = clamp(parseInt(n, 10) || 1, 1, 6);
    const out = new Array(N);

    const mode = c ? String(c.splitStrike || 'simultaneous') : 'simultaneous';
    if (mode !== 'belllike') {
      for (let i = 0; i < N; i++) out[i] = 0;
      out[0] = 0;
      return out;
    }

    const step = clamp(parseInt(String(c.stepMs), 10) || 0, 0, 15);
    const max = clamp(parseInt(String(c.maxMs), 10) || 0, 0, 18);

    const custom = (c.customSplitOffsets && Array.isArray(c.customSplitOffsets) && c.customSplitOffsets.length) ? c.customSplitOffsets.slice(0, 6) : null;
    if (custom && custom.length) {
      // If the custom offsets list is shorter than N, pad using the step/max formula.
      let prev = 0;
      for (let i = 0; i < N; i++) {
        if (i < custom.length) {
          const v = clamp(parseInt(String(custom[i]), 10) || 0, 0, 18);
          out[i] = (i === 0) ? 0 : Math.max(prev, v);
        } else {
          out[i] = (i === 0) ? 0 : Math.min(i * step, max);
          if (out[i] < prev) out[i] = prev;
        }
        prev = out[i];
      }
      out[0] = 0;
      return out;
    }

    for (let i = 0; i < N; i++) out[i] = (i === 0) ? 0 : Math.min(i * step, max);
    out[0] = 0;
    return out;
  }

  function playBellVoiceAtHz(bell, hz, whenMs, gainScale, minGain, soundCtx) {
    ensureAudio();
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const t = msToAudioTime(whenMs);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    const f = Number(hz);
    osc.frequency.setValueAtTime((Number.isFinite(f) && f > 0) ? f : 440, t);

    // v08_p05_sound_per_bell_overrides: per-bell volume scales on top of the global bell master volume
    const bellVol = getBellGain(b, soundCtx);
    const MIN_G = Math.max(0.0000001, Number(minGain) || 0.000001);
    const sMul = Number.isFinite(Number(bellVoiceGainMulOverride)) ? Number(bellVoiceGainMulOverride) : 1;
    const s = Math.max(0.000001, (Number(gainScale) || 1) * sMul);
    let g0 = Math.max(MIN_G, 0.0001 * bellVol * s);
    let g1 = Math.max(MIN_G, 0.16 * bellVol * s);
    let g2 = Math.max(MIN_G, 0.001 * bellVol * s);
    if (g1 < g0) g1 = g0;

    // v014_p05b_bell_timbre_per_bell_overrides: effective bell timbre (global first, then per-bell override)
    const tim = resolveBellTimbreForStrike(b, soundCtx);

    // v014_p05a_bell_timbre_global: ring length scales the strike decay/release (defaults preserve legacy)
    const rl01 = clamp(Number(tim.bellRingLength), 0, 1);
    const rlNeutral = Math.abs(rl01 - BELL_RING_LENGTH_DEFAULT) < 1e-6;

    // Legacy envelope times (exactly match baseline)
    const t1 = t + 0.01;
    let t2 = t + 0.28;
    let tStop = t + 0.32;

    // Non-neutral: scale decay + tail
    if (!rlNeutral) {
      const lenMult = bellRingLengthMult01(rl01);
      t2 = t1 + 0.27 * lenMult;
      tStop = t2 + 0.04 * lenMult;
    }

    gain.gain.setValueAtTime(g0, t);
    gain.gain.exponentialRampToValueAtTime(g1, t1);
    gain.gain.exponentialRampToValueAtTime(g2, t2);

    let dest = bellVoiceDestOverride || bellMasterGain || audioCtx.destination;
    if (!bellVoiceDestOverride) {
      try { dest = getBellPanInput(b) || dest; } catch (_) {}
    }

    // v014_p05a_bell_timbre_global: brightness lowpass (neutral default is exact no-op via bypass)
    const br01 = clamp(Number(tim.bellBrightness), 0, 1);
    const brNeutral = Math.abs(br01 - BELL_BRIGHTNESS_DEFAULT) < 1e-6;
    let lpf = null;
    if (!brNeutral) {
      try {
        lpf = audioCtx.createBiquadFilter();
        lpf.type = 'lowpass';
        const hz0 = bellBrightnessCutoffHz(br01, audioCtx.sampleRate);
        lpf.frequency.setValueAtTime(hz0, t);
        lpf.Q.setValueAtTime(0.707, t);
      } catch (_) {
        lpf = null;
      }
    }

    const out = lpf || dest;
    osc.connect(gain);
    gain.connect(out);
    if (lpf) lpf.connect(dest);

    // v014_p05a_bell_timbre_global: strike hardness transient (off by default)
    const hard01 = clamp(Number(tim.bellStrikeHardness), 0, 1);
    let hardSrc = null;
    let hardGain = null;
    if (hard01 > 0.0005) {
      try {
        hardSrc = audioCtx.createBufferSource();
        hardSrc.buffer = getNoiseBuffer();
        hardGain = audioCtx.createGain();
        const peak = Math.min(0.12, Math.max(0.000001, g1 * 0.75 * hard01));
        const ta = 0.0012;
        const td = 0.020;
        hardGain.gain.setValueAtTime(0.000001, t);
        hardGain.gain.linearRampToValueAtTime(peak, t + ta);
        hardGain.gain.exponentialRampToValueAtTime(0.000001, t + ta + td);
        hardSrc.connect(hardGain);
        hardGain.connect(out);
        hardSrc.start(t);
        hardSrc.stop(Math.min(tStop, t + ta + td + 0.03));
      } catch (_) {
        try { if (hardSrc) hardSrc.disconnect(); } catch (_) {}
        try { if (hardGain) hardGain.disconnect(); } catch (_) {}
        hardSrc = null;
        hardGain = null;
      }
    }

    osc.start(t);
    osc.stop(tStop);

    (bellVoiceRegistryOverride || scheduledBellNodes).push({ bell: b, osc, gain, startAt: t, stopAt: tStop, lpf, hardSrc, hardGain });
  }

  function playBellStrikeAtHz(bell, baseHz, whenMs, minGain, soundCtx) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const ignoreGlobalAdv = !!(soundCtx && soundCtx.ignoreGlobalChordAdvanced);
    // v014_p01_global_custom_chords_advanced: global Advanced modifiers (apply to all chord strikes)
    const gcfg = (!ignoreGlobalAdv && state.globalChord) ? sanitizeGlobalChordConfig(state.globalChord) : globalChordDefaults();
    const gDetuneCents = clamp(Number(gcfg.globalDetuneCents) || 0, -20, 20);
    const gDetuneMul = (gDetuneCents !== 0) ? Math.pow(2, gDetuneCents / 1200) : 1;
    const gLevelMode = String(gcfg.globalLevelMode || 'equal');
    const gLevelGainsRaw = String(gcfg.globalLevelGains || '');
    const gSplitOffsetMode = String(gcfg.globalSplitOffsetMode || 'auto');
    const gSplitOffsetsRaw = String(gcfg.globalSplitOffsetsMs || '');

    // v10_p09_sound_per_bell_chords_overrides: bell-local chord override takes priority.
    const ov = resolveBellChordOverrideForStrike(b, soundCtx);
    if (ov) {
      const semis = deriveChordSemitonesFromAnyConfig(ov);
      const N = clamp(semis.length, 1, 6);
      const base = (Number.isFinite(Number(baseHz)) && Number(baseHz) > 0) ? Number(baseHz) : getBellFrequency(b);
      if (N <= 1) {
        // Still allow detune/levels to apply to the single tone.
        let hz1 = base;
        if (ov.detune && ov.detune.length) {
          const cents = clamp(Number(ov.detune[0]) || 0, -50, 50);
          hz1 = hz1 * Math.pow(2, cents / 1200);
        }
        const lv = (ov.levels && ov.levels.length) ? clamp(Number(ov.levels[0]) || 1, 0, 1.5) : 1;
        if (gDetuneMul !== 1) hz1 *= gDetuneMul;
        const g1 = (gLevelMode === 'custom') ? parseGlobalChordVoiceGainsText(gLevelGainsRaw, 1) : null;
        const gw = g1 ? (Number(g1[0]) || 1) : 1;
        playBellVoiceAtHz(b, hz1, whenMs, lv * gw, minGain, soundCtx);
        return;
      }

      let offsets = deriveChordOffsetsMsFromAnyConfig(ov, N);
      if (gSplitOffsetMode === 'custom' && ov.splitStrike === 'belllike' && !ov.customSplitOffsets) {
        offsets = parseGlobalChordSplitOffsetsText(gSplitOffsetsRaw, N, ov.stepMs);
      }
      const gGains = (gLevelMode === 'custom') ? parseGlobalChordVoiceGainsText(gLevelGainsRaw, N) : null;
      const perToneBase = 1 / Math.sqrt(N);
      for (let i = 0; i < N; i++) {
        const semi = Number(semis[i]) || 0;
        let hz = base * Math.pow(2, semi / 12);
        if (ov.detune && i < ov.detune.length) {
          const cents = clamp(Number(ov.detune[i]) || 0, -50, 50);
          hz = hz * Math.pow(2, cents / 1200);
        }
        if (gDetuneMul !== 1) hz *= gDetuneMul;
        const w = (ov.levels && i < ov.levels.length) ? clamp(Number(ov.levels[i]) || 1, 0, 1.5) : 1;
        const gw = gGains ? (Number(gGains[i]) || 1) : 1;
        const gainScale = perToneBase * w * gw;
        const atMs = (Number(whenMs) || 0) + (Number(offsets[i]) || 0);
        playBellVoiceAtHz(b, hz, atMs, gainScale, minGain, soundCtx);
      }
      return;
    }

    // Otherwise: global chord config (legacy behavior).
    const cfg = state.globalChord || null;
    if (!cfg || !cfg.enabled) {
      playBellVoiceAtHz(b, baseHz, whenMs, 1, minGain, soundCtx);
      return;
    }

    const semis = deriveGlobalChordSemitones(cfg);
    const N = clamp(semis.length, 1, 6);
    if (N <= 1) {
      let hz1 = (Number.isFinite(Number(baseHz)) && Number(baseHz) > 0) ? Number(baseHz) : getBellFrequency(b);
      if (gDetuneMul !== 1) hz1 *= gDetuneMul;
      const g1 = (gLevelMode === 'custom') ? parseGlobalChordVoiceGainsText(gLevelGainsRaw, 1) : null;
      const gw = g1 ? (Number(g1[0]) || 1) : 1;
      playBellVoiceAtHz(b, hz1, whenMs, gw, minGain, soundCtx);
      return;
    }

    const base = (Number.isFinite(Number(baseHz)) && Number(baseHz) > 0) ? Number(baseHz) : getBellFrequency(b);
    let offsets = deriveGlobalChordOffsetsMs(cfg, N);
    if (gSplitOffsetMode === 'custom' && String(cfg.splitStrike || '') === 'belllike') {
      offsets = parseGlobalChordSplitOffsetsText(gSplitOffsetsRaw, N, cfg.stepMs);
    }
    const gGains = (gLevelMode === 'custom') ? parseGlobalChordVoiceGainsText(gLevelGainsRaw, N) : null;
    const perToneScale = 1 / Math.sqrt(N);

    for (let i = 0; i < N; i++) {
      const semi = Number(semis[i]) || 0;
      let hz = base * Math.pow(2, semi / 12);
      if (gDetuneMul !== 1) hz *= gDetuneMul;
      const atMs = (Number(whenMs) || 0) + (Number(offsets[i]) || 0);
      const gw = gGains ? (Number(gGains[i]) || 1) : 1;
      playBellVoiceAtHz(b, hz, atMs, perToneScale * gw, minGain, soundCtx);
    }
  }

  function playBellAt(bell, whenMs) {
    // v10_p08_sound_global_chords_splitstrike: central bell strike path (applies everywhere bells ring)
    playBellStrikeAtHz(bell, getBellFrequency(bell), whenMs, 0.000001);
  }

  // v10_p05_sound_per_bell_hz_slider_preview: shared continuous tone preview (single instance)
  let hzPreviewOsc = null;
  let hzPreviewGain = null;
  let hzPreviewBell = 0;
  const HZ_PREVIEW_MIN_GAIN = 0.0001;

  function stopHzPreviewTone() {
    if (!hzPreviewOsc) {
      hzPreviewGain = null;
      hzPreviewBell = 0;
      return;
    }

    const osc = hzPreviewOsc;
    const gain = hzPreviewGain;
    hzPreviewOsc = null;
    hzPreviewGain = null;
    hzPreviewBell = 0;

    if (!audioCtx) {
      try { osc.disconnect(); } catch (_) {}
      try { if (gain) gain.disconnect(); } catch (_) {}
      return;
    }

    const now = audioCtx.currentTime;
    try {
      if (gain && gain.gain) {
        gain.gain.cancelScheduledValues(now);
        const cur = Math.max(HZ_PREVIEW_MIN_GAIN, Number(gain.gain.value) || HZ_PREVIEW_MIN_GAIN);
        gain.gain.setValueAtTime(cur, now);
        gain.gain.exponentialRampToValueAtTime(HZ_PREVIEW_MIN_GAIN, now + 0.03);
      }
    } catch (_) {}
    try { osc.stop(now + 0.04); } catch (_) { try { osc.stop(); } catch (_) {} }
    try { osc.disconnect(); } catch (_) {}
    try { if (gain) gain.disconnect(); } catch (_) {}
  }

  function startHzPreviewTone(bell, hz) {
    ensureAudio();
    stopHzPreviewTone();

    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const f = clamp(Number(hz) || 440, 20, 5000);
    const now = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, now);

    // Keep the preview comfortably under the bell strike peak.
    const bellVol = getBellGain(b);
    const level = Math.max(HZ_PREVIEW_MIN_GAIN, Math.min(0.09, 0.065 * bellVol));
    gain.gain.setValueAtTime(HZ_PREVIEW_MIN_GAIN, now);
    try { gain.gain.exponentialRampToValueAtTime(level, now + 0.02); } catch (_) { gain.gain.setValueAtTime(level, now + 0.02); }

    let dest = bellMasterGain || audioCtx.destination;
    try { dest = getBellPanInput(bell) || dest; } catch (_) {}
    osc.connect(gain).connect(dest);
    osc.start(now);

    hzPreviewOsc = osc;
    hzPreviewGain = gain;
    hzPreviewBell = b;
  }

  function updateHzPreviewTone(bell, hz) {
    if (!hzPreviewOsc || !audioCtx) return;
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const f = clamp(Number(hz) || 440, 20, 5000);
    const now = audioCtx.currentTime;

    try {
      hzPreviewOsc.frequency.cancelScheduledValues(now);
      hzPreviewOsc.frequency.setTargetAtTime(f, now, 0.015);
    } catch (_) {
      try { hzPreviewOsc.frequency.setValueAtTime(f, now); } catch (_) {}
    }

    if (b !== hzPreviewBell && hzPreviewGain && hzPreviewGain.gain) {
      hzPreviewBell = b;
      const bellVol = getBellGain(b);
      const level = Math.max(HZ_PREVIEW_MIN_GAIN, Math.min(0.09, 0.065 * bellVol));
      try {
        hzPreviewGain.gain.cancelScheduledValues(now);
        hzPreviewGain.gain.setTargetAtTime(level, now, 0.02);
      } catch (_) {}
    }
  }

  function playBellStrikePreviewAtHz(bell, hz, whenMs) {
    // v10_p08_sound_global_chords_splitstrike: piano strikes also follow global chord settings
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const f = clamp(Number(hz) || getBellFrequency(b), 20, 5000);
    playBellStrikeAtHz(b, f, whenMs, HZ_PREVIEW_MIN_GAIN);
  }

  // v10_p05_sound_per_bell_hz_slider_preview: gesture tracking (so safety stops can also cancel pending holds)
  const HZ_SLIDER_HOLD_MS = 160;
  const HZ_SLIDER_MOVE_PX2 = 16; // 4px squared
  const hzSliderPreview = {
    active: false,
    pointerId: null,
    el: null,
    bell: 0,
    didStartTone: false,
    downX: 0,
    downY: 0,
    holdTimer: null
  };

  function cancelHzSliderPreviewGesture() {
    if (hzSliderPreview && hzSliderPreview.holdTimer) {
      try { window.clearTimeout(hzSliderPreview.holdTimer); } catch (_) {}
      hzSliderPreview.holdTimer = null;
    }
    if (!hzSliderPreview) return;
    hzSliderPreview.active = false;
    hzSliderPreview.pointerId = null;
    hzSliderPreview.el = null;
    hzSliderPreview.bell = 0;
    hzSliderPreview.didStartTone = false;
    hzSliderPreview.downX = 0;
    hzSliderPreview.downY = 0;
  }

  function playTickAt(whenMs) {
    ensureAudio();
    const t = msToAudioTime(whenMs);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(bellMasterGain || audioCtx.destination);
    const tStop = t + 0.07;
    osc.start(t);
    osc.stop(tStop);

    scheduledBellNodes.push({ osc, gain, startAt: t, stopAt: tStop });
  }

  // Prompt 6: cancel any already-scheduled future bell/tick strikes (keep drone playing)
  function cancelScheduledBellAudioNow() {
    if (!scheduledBellNodes.length) return;
    if (!audioCtx) {
      scheduledBellNodes.length = 0;
      return;
    }

    const now = audioCtx.currentTime;
    for (let i = 0; i < scheduledBellNodes.length; i++) {
      const n = scheduledBellNodes[i];
      if (!n || !n.osc) continue;
      const stopAt = Number(n.stopAt) || 0;
      if (stopAt <= now) continue;
      try {
        if (n.gain && n.gain.gain) {
          n.gain.gain.cancelScheduledValues(now);
          n.gain.gain.setValueAtTime(0.0001, now);
        }
      } catch (_) {}
      try {
        const startAt = Number(n.startAt) || now;
        n.osc.stop(Math.max(now + 0.001, startAt + 0.001));
      } catch (_) {}
      try { n.osc.disconnect(); } catch (_) {}
      try { if (n.gain) n.gain.disconnect(); } catch (_) {}

      // v014_p05a_bell_timbre_global: extra bell-strike nodes (brightness LPF, hardness transient)
      try { if (n.lpf) n.lpf.disconnect(); } catch (_) {}
      try {
        if (n.hardSrc && typeof n.hardSrc.stop === 'function') n.hardSrc.stop(now + 0.001);
      } catch (_) {}
      try { if (n.hardSrc) n.hardSrc.disconnect(); } catch (_) {}
      try { if (n.hardGain) n.hardGain.disconnect(); } catch (_) {}
    }
    scheduledBellNodes.length = 0;
  }


  // v017_p01_polyrhythm_core: cancel any already-scheduled future polyrhythm strikes (independent registry)
  function cancelScheduledPolyAudioNow() {
    if (!scheduledPolyNodes.length) return;
    if (!audioCtx) { scheduledPolyNodes.length = 0; return; }

    const now = audioCtx.currentTime;
    const MIN_G = 0.0001;

    for (let i = 0; i < scheduledPolyNodes.length; i++) {
      const n = scheduledPolyNodes[i];
      if (n && n.gain && n.gain.gain) {
        try {
          n.gain.gain.cancelScheduledValues(now);
          n.gain.gain.setValueAtTime(MIN_G, now);
        } catch (_) {}
      }
      if (n && n.osc) {
        try { n.osc.stop(now); } catch (_) {}
        try { n.osc.disconnect(); } catch (_) {}
      }
      if (n && n.oscs && Array.isArray(n.oscs)) {
        for (let j = 0; j < n.oscs.length; j++) {
          const o = n.oscs[j];
          if (!o) continue;
          try { o.stop(now); } catch (_) {}
          try { o.disconnect(); } catch (_) {}
        }
      }
      if (n && n.modOscs && Array.isArray(n.modOscs)) {
        for (let j = 0; j < n.modOscs.length; j++) {
          const o = n.modOscs[j];
          if (!o) continue;
          try { o.stop(now); } catch (_) {}
          try { o.disconnect(); } catch (_) {}
        }
      }
      if (n && n.modGains && Array.isArray(n.modGains)) {
        for (let j = 0; j < n.modGains.length; j++) {
          const g = n.modGains[j];
          if (!g) continue;
          try { g.disconnect(); } catch (_) {}
        }
      }
      if (n && n.src) {
        try { n.src.stop(now); } catch (_) {}
        try { n.src.disconnect(); } catch (_) {}
      }
      if (n && n.hardSrc) {
        try { n.hardSrc.stop(now); } catch (_) {}
        try { n.hardSrc.disconnect(); } catch (_) {}
      }
      if (n && n.hardGain) {
        try { n.hardGain.disconnect(); } catch (_) {}
      }
      if (n && n.lpf) {
        try { n.lpf.disconnect(); } catch (_) {}
      }
    }
    scheduledPolyNodes.length = 0;
  }


  // v018_p01_poly_synth_core: cancel only synth/perc nodes in scheduledPolyNodes (leave poly bell/tick tails intact)
  function cancelScheduledPolySynthAudioNow() {
    if (!scheduledPolyNodes.length) return;
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const MIN_G = 0.0001;

    const keep = [];
    for (let i = 0; i < scheduledPolyNodes.length; i++) {
      const n = scheduledPolyNodes[i];
      const kind = n ? String(n.kind || '') : '';
      const isSP = (kind === 'synth' || kind === 'perc');

      if (!isSP) { keep.push(n); continue; }

      if (n && n.gain && n.gain.gain) {
        try {
          n.gain.gain.cancelScheduledValues(now);
          n.gain.gain.setValueAtTime(MIN_G, now);
        } catch (_) {}
      }
      if (n && n.osc) {
        try { n.osc.stop(now); } catch (_) {}
        try { n.osc.disconnect(); } catch (_) {}
      }
      if (n && n.oscs && Array.isArray(n.oscs)) {
        for (let j = 0; j < n.oscs.length; j++) {
          const o = n.oscs[j];
          if (!o) continue;
          try { o.stop(now); } catch (_) {}
          try { o.disconnect(); } catch (_) {}
        }
      }
      if (n && n.modOscs && Array.isArray(n.modOscs)) {
        for (let j = 0; j < n.modOscs.length; j++) {
          const o = n.modOscs[j];
          if (!o) continue;
          try { o.stop(now); } catch (_) {}
          try { o.disconnect(); } catch (_) {}
        }
      }
      if (n && n.modGains && Array.isArray(n.modGains)) {
        for (let j = 0; j < n.modGains.length; j++) {
          const g = n.modGains[j];
          if (!g) continue;
          try { g.disconnect(); } catch (_) {}
        }
      }
      if (n && n.src) {
        try { n.src.stop(now); } catch (_) {}
        try { n.src.disconnect(); } catch (_) {}
      }
      if (n && n.hardSrc) {
        try { n.hardSrc.stop(now); } catch (_) {}
        try { n.hardSrc.disconnect(); } catch (_) {}
      }
      if (n && n.hardGain) {
        try { n.hardGain.disconnect(); } catch (_) {}
      }
      if (n && n.lpf) {
        try { n.lpf.disconnect(); } catch (_) {}
      }
    }

    scheduledPolyNodes.length = 0;
    for (let i = 0; i < keep.length; i++) scheduledPolyNodes.push(keep[i]);
  }


  // v017_p01_polyrhythm_core: play tick/bell strikes routed into polyMasterGain + registered in scheduledPolyNodes
  function playPolyTickAt(whenMs, gainMul = 1) {
    ensureAudio();
    if (!audioCtx) return;

    const t = msToAudioTime(whenMs);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);

    const s = clamp(Number(gainMul) || 1, 0, 2);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.08 * s), t + 0.005);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, 0.001 * s), t + 0.06);

    const tStop = t + 0.07;

    const dest = polyMasterGain || bellMasterGain || audioCtx.destination;
    try {
      osc.connect(gain).connect(dest);
    } catch (_) {
      try { osc.connect(gain).connect(audioCtx.destination); } catch (_) {}
    }

    try { osc.start(t); osc.stop(tStop); } catch (_) {}

    scheduledPolyNodes.push({ osc, gain, startAt: t, stopAt: tStop });
  }

  function playPolyBellAt(bell, whenMs, gainMul = 1, soundCtx) {
    ensureAudio();
    if (!audioCtx) return;

    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const hz = getPolyBellFrequency(b, soundCtx);

    const dest = polyMasterGain || bellMasterGain || audioCtx.destination;

    const prevDest = bellVoiceDestOverride;
    const prevReg = bellVoiceRegistryOverride;
    const prevMul = bellVoiceGainMulOverride;
    bellVoiceDestOverride = dest;
    bellVoiceRegistryOverride = scheduledPolyNodes;
    bellVoiceGainMulOverride = Number.isFinite(Number(gainMul)) ? Number(gainMul) : 1;

    try {
      playBellStrikeAtHz(b, hz, whenMs, 0.000001, soundCtx);
    } catch (_) {}

    bellVoiceDestOverride = prevDest;
    bellVoiceRegistryOverride = prevReg;
    bellVoiceGainMulOverride = prevMul;
  }

  // v018_p01_poly_synth_core: WebAudio synth + perc voices for polyrhythm layers (no worklets, no libs)
  const POLY_SYNTH_PRESETS = {
    tone_sine: {
      kind: 'tone', label: 'Sine', oscType: 'sine',
      env: { a: 0.002, d: 0.08, s: 0.0, r: 0.09, hold: 0.00 },
      level: 0.12,
      filter: null,
    },
    tone_triangle_pluck: {
      kind: 'tone', label: 'Triangle Pluck', oscType: 'triangle',
      env: { a: 0.002, d: 0.14, s: 0.0, r: 0.06, hold: 0.00 },
      level: 0.14,
      filter: { type: 'lowpass', cutoffHz: 2600, Q: 0.7 },
    },
    tone_saw_pad: {
      kind: 'tone', label: 'Saw Pad', oscType: 'sawtooth',
      env: { a: 0.02, d: 0.18, s: 0.55, r: 0.25, hold: 0.08 },
      level: 0.10,
      filter: { type: 'lowpass', cutoffHz: 1400, Q: 0.8 },
    },
    fm_bell: {
      kind: 'fm', label: 'FM Bell', carrierType: 'sine', modType: 'sine',
      modRatio: 2.0, modIndexHz: 120, modDecay: 0.10,
      env: { a: 0.002, d: 0.24, s: 0.0, r: 0.18, hold: 0.00 },
      level: 0.11,
      filter: { type: 'lowpass', cutoffHz: 6000, Q: 0.6 },
    },
    tone_square_lead: {
      kind: 'tone', label: 'Square Lead', oscType: 'square',
      env: { a: 0.002, d: 0.09, s: 0.12, r: 0.10, hold: 0.00 },
      level: 0.11,
      filter: { type: 'lowpass', cutoffHz: 3200, Q: 0.8 },
    },
    tone_soft_pad: {
      kind: 'tone', label: 'Soft Pad', oscType: 'triangle',
      env: { a: 0.06, d: 0.40, s: 0.65, r: 0.90, hold: 0.10 },
      level: 0.09,
      filter: { type: 'lowpass', cutoffHz: 1200, Q: 0.7 },
    },
    fm_marimba: {
      kind: 'fm', label: 'FM Marimba', carrierType: 'sine', modType: 'sine',
      modRatio: 3.0, modIndexHz: 220, modDecay: 0.06,
      env: { a: 0.002, d: 0.13, s: 0.0, r: 0.10, hold: 0.00 },
      level: 0.11,
      filter: { type: 'lowpass', cutoffHz: 6500, Q: 0.7 },
    },
  };
  const POLY_PERC_PRESETS = {
    noise_hat: {
      label: 'Noise Hat',
      env: { a: 0.0005, d: 0.030, s: 0.0, r: 0.020, hold: 0.00 },
      level: 0.12,
      filter: { type: 'highpass', cutoffHz: 6500, Q: 0.9 },
    },
    click_block: {
      label: 'Click/Block',
      env: { a: 0.0005, d: 0.010, s: 0.0, r: 0.010, hold: 0.00 },
      level: 0.10,
      filter: { type: 'bandpass', cutoffHz: 2400, Q: 4.0 },
    },
    kick_sine: {
      kind: 'kick', label: 'Kick',
      env: { a: 0.0005, d: 0.08, s: 0.0, r: 0.10, hold: 0.00 },
      level: 0.15,
      oscType: 'sine',
      fStart: 140,
      fEnd: 50,
      dropTime: 0.05,
    },
    snare_noise: {
      kind: 'snare', label: 'Snare',
      env: { a: 0.0005, d: 0.10, s: 0.0, r: 0.12, hold: 0.00 },
      level: 0.12,
      filter: { type: 'bandpass', cutoffHz: 1800, Q: 0.9 },
      toneHz: 190,
      toneLevel: 0.35,
      toneDecay: 0.07,
    },
    clap_noise: {
      kind: 'clap', label: 'Clap',
      env: { a: 0.0005, d: 0.03, s: 0.0, r: 0.14, hold: 0.00 },
      level: 0.12,
      filter: { type: 'highpass', cutoffHz: 1200, Q: 0.8 },
      tapsMs: [0, 16, 32, 48],
      tail: 0.25,
    },
  };

  function polyGetSynthPreset(id) {
    const k = String(id || '').trim();
    return (k && POLY_SYNTH_PRESETS[k]) ? POLY_SYNTH_PRESETS[k] : POLY_SYNTH_PRESETS.tone_sine;
  }

  function polyGetPercPreset(id) {
    const k = String(id || '').trim();
    return (k && POLY_PERC_PRESETS[k]) ? POLY_PERC_PRESETS[k] : POLY_PERC_PRESETS.noise_hat;
  }

  function polyApplyEnv(gainParam, t, peak, env) {
    const MIN_G = 0.0001;
    const e = env || {};
    const a = clamp(Number(e.a) || 0.002, 0.0001, 1.0);
    const d = clamp(Number(e.d) || 0.05, 0.0001, 2.0);
    const s = clamp(Number(e.s) || 0.0, 0.0, 1.0);
    const r = clamp(Number(e.r) || 0.05, 0.0001, 3.0);
    const hold = clamp(Number(e.hold) || 0.0, 0.0, 2.0);

    const pk = Math.max(MIN_G * 1.2, Number(peak) || 0.12);
    const sus = Math.max(MIN_G * 1.1, pk * s);

    try {
      gainParam.cancelScheduledValues(t);
      gainParam.setValueAtTime(MIN_G, t);
      gainParam.exponentialRampToValueAtTime(pk, t + a);
      gainParam.exponentialRampToValueAtTime(sus, t + a + d);
      gainParam.setValueAtTime(sus, t + a + d + hold);
      gainParam.exponentialRampToValueAtTime(MIN_G, t + a + d + hold + r);
    } catch (_) {}

    return t + a + d + hold + r;
  }
  function polyApplyClapEnv(gainParam, t, peak, env, tapsMs, tail01) {
    const MIN_G = 0.0001;
    const pk = Math.max(MIN_G * 1.2, Number(peak) || 0.12);
    const e = env || {};
    const r = clamp(Number(e.r) || 0.14, 0.01, 1.5);
    const taps = (Array.isArray(tapsMs) && tapsMs.length) ? tapsMs : [0, 16, 32, 48];
    const tail = clamp(Number(tail01) || 0.25, 0.05, 0.6);

    let last = t;
    try {
      gainParam.cancelScheduledValues(t);
      gainParam.setValueAtTime(MIN_G, t);

      for (let i = 0; i < taps.length; i++) {
        const ms = clamp(Number(taps[i]) || 0, 0, 120);
        const tt = t + ms / 1000;
        last = Math.max(last, tt);

        gainParam.setValueAtTime(MIN_G, tt);
        gainParam.exponentialRampToValueAtTime(pk, tt + 0.0015);
        gainParam.exponentialRampToValueAtTime(MIN_G, tt + 0.011);
      }

      const tailStart = last + 0.014;
      const tailPk = Math.max(MIN_G * 1.1, pk * tail);
      gainParam.exponentialRampToValueAtTime(tailPk, tailStart);
      gainParam.exponentialRampToValueAtTime(MIN_G, tailStart + r);
    } catch (_) {}

    return last + 0.014 + r;
  }


  function polySynthTokenToHz(token, layer) {
    const tok = clamp(parseInt(token, 10) || 1, 1, 12);
    const l = (layer && typeof layer === 'object') ? layer : {};
    const ps = String(l.pitchSource || 'bell12');

    if (ps === 'chromatic') {
      const base = clamp(parseInt(String(l.pitchBase ?? 60), 10) || 60, 0, 127);
      const midi = clamp(base + (tok - 1), 0, 127);
      return midiToFreq(midi);
    }
    if (ps === 'fixed') {
      const hzRaw = Number(l.pitchHz);
      if (Number.isFinite(hzRaw) && hzRaw > 0) return hzRaw;
      const base = clamp(parseInt(String(l.pitchBase ?? 60), 10) || 60, 0, 127);
      return midiToFreq(base);
    }

    // Default: Bell pitch map (as-if stage=12), rendered with synth timbre.
    try { return getPolyBellFrequency(tok, null); } catch (_) { return 440; }
  }

  function playPolySynthAt(token, whenMs, gainMul = 1, layer) {
    ensureAudio();
    if (!audioCtx) return;

    const t0 = msToAudioTime(whenMs);
    const dest = polyMasterGain || bellMasterGain || audioCtx.destination;

    const l = (layer && typeof layer === 'object') ? layer : {};
    const preset = polyGetSynthPreset(l.synthPreset);
    let baseHz = polySynthTokenToHz(token, l);


    // v018_p02_poly_synth_advanced: per-layer advanced params + per-token overrides (synth hits only)
    const adv = (l.synthParamsAdvanced && typeof l.synthParamsAdvanced === 'object' && !Array.isArray(l.synthParamsAdvanced)) ? l.synthParamsAdvanced : {};
    const tokMap = (l.tokenOverrides && typeof l.tokenOverrides === 'object' && !Array.isArray(l.tokenOverrides)) ? l.tokenOverrides : null;
    const tokOvr = (tokMap && tokMap[String(token)] && typeof tokMap[String(token)] === 'object') ? tokMap[String(token)] : null;

    let tokenPitchSemis = 0;
    let tokenGain = 1.0;
    let tokenCutoffDeltaHz = 0;
    let tokenBrightness = 1.0;

    if (tokOvr) {
      const ps = Number(tokOvr.pitchSemis);
      if (Number.isFinite(ps)) tokenPitchSemis = clamp(Math.round(ps), -24, 24);

      const g = Number(tokOvr.gain);
      if (Number.isFinite(g)) tokenGain = clamp(g, 0, 2);

      const cd = Number(tokOvr.cutoffDeltaHz);
      if (Number.isFinite(cd)) tokenCutoffDeltaHz = clamp(cd, -20000, 20000);

      const br = Number(tokOvr.brightness);
      if (Number.isFinite(br)) tokenBrightness = clamp(br, 0.1, 4);
    }

    if (tokenPitchSemis) {
      baseHz = baseHz * Math.pow(2, tokenPitchSemis / 12);
    }

    // Optional chords (reuse existing chord config if present)
    let semis = [0];
    let offsMs = [0];
    try {
      const bs = (l.bellSound && typeof l.bellSound === 'object') ? l.bellSound : null;
      const ch = (bs && bs.chords && typeof bs.chords === 'object') ? bs.chords : null;
      if (ch && ch.enabled) {
        semis = deriveChordSemitonesFromAnyConfig(ch) || [0];
        offsMs = deriveChordOffsetsMsFromAnyConfig(ch, semis.length) || new Array(semis.length).fill(0);
      }
    } catch (_) {}
    const N = clamp(semis.length, 1, 6);

    let s = clamp(Number(gainMul) || 1, 0, 2);
    const vel = Number(adv.velocity);
    if (Number.isFinite(vel)) s *= clamp(vel, 0, 2);
    s *= tokenGain;
    s = clamp(s, 0, 2);

    let unison = clamp(parseInt(String(adv.unison ?? 1), 10) || 1, 1, 4);
    const detuneCents = clamp(Number(adv.detuneCents) || 0, 0, 100);
    if (detuneCents <= 0.0001) unison = 1;
    const perVoiceCost = (preset.kind === 'fm') ? 2 : 1;
    const maxUnison = Math.max(1, Math.floor(12 / Math.max(1, N * perVoiceCost)));
    unison = Math.min(unison, maxUnison);

    const perPeak = clamp((Number(preset.level) || 0.12) * s / Math.max(1, N * unison), 0.00005, 0.35);
    const env = (adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)) ? Object.assign({}, (preset.env || {}), adv.env) : preset.env;

    // Final gain node used for cancellation fade-out
    const mix = audioCtx.createGain();
    mix.gain.setValueAtTime(1.0, t0);

    // Optional shared filter (preset + advanced + per-token timbre)
    let filt = null;
    const advF = (adv.filter && typeof adv.filter === 'object' && !Array.isArray(adv.filter)) ? adv.filter : null;
    const presetF = (preset.filter && typeof preset.filter === 'object') ? preset.filter : null;
    const needFilter = !!(audioCtx.createBiquadFilter && (presetF || advF || tokenCutoffDeltaHz || (tokenBrightness !== 1)));
    if (needFilter) {
      try {
        filt = audioCtx.createBiquadFilter();
        const type = String((advF && advF.type) || (presetF && presetF.type) || 'lowpass');
        filt.type = type;

        let hz = Number(presetF && presetF.cutoffHz);
        if (!Number.isFinite(hz)) hz = 12000;
        const advHz = Number(advF && advF.cutoffHz);
        if (Number.isFinite(advHz)) hz = advHz;

        hz = clamp(Number(hz) || 12000, 20, 20000);
        if (tokenCutoffDeltaHz) hz = clamp(hz + tokenCutoffDeltaHz, 20, 20000);
        if (tokenBrightness !== 1) hz = clamp(hz * tokenBrightness, 20, 20000);

        let q = Number(presetF && presetF.Q);
        if (!Number.isFinite(q)) q = 0.707;
        const advQ = Number(advF && advF.Q);
        if (Number.isFinite(advQ)) q = advQ;
        q = clamp(q, 0.1, 20);

        filt.frequency.setValueAtTime(hz, t0);
        filt.Q.setValueAtTime(q, t0);
      } catch (_) { filt = null; }
    }



    if (filt) {
      try { filt.connect(mix); } catch (_) {}
    }
    try { mix.connect(dest); } catch (_) { try { mix.connect(audioCtx.destination); } catch (_) {} }

    const oscs = [];
    const modOscs = [];
    const modGains = [];
    let tEndMax = t0 + 0.12;

    for (let i = 0; i < N; i++) {
      const semi = Number(semis[i]) || 0;
      const hz = baseHz * Math.pow(2, semi / 12);
      const off = (offsMs && offsMs[i] != null) ? Number(offsMs[i]) : 0;
      const t = t0 + (Number.isFinite(off) ? clamp(off, 0, 30) / 1000 : 0);

      const vGain = audioCtx.createGain();
      vGain.gain.setValueAtTime(0.0001, t);

      let tEnd = polyApplyEnv(vGain.gain, t, perPeak, env);
      tEndMax = Math.max(tEndMax, tEnd);

      try { vGain.connect(filt || mix); } catch (_) {}

      if (preset.kind === 'fm') {
        // Simple FM: mod oscillator -> mod gain -> carrier.frequency
        const ratio = Number(preset.modRatio) || 2;
        for (let u = 0; u < unison; u++) {
          const cents = (unison === 1) ? 0 : (u - (unison - 1) / 2) * detuneCents;
          const hzU = (Number.isFinite(hz) && hz > 0) ? (hz * Math.pow(2, cents / 1200)) : 440;

          const carrier = audioCtx.createOscillator();
          carrier.type = String(preset.carrierType || 'sine');
          carrier.frequency.setValueAtTime(hzU, t);

          const modOsc = audioCtx.createOscillator();
          modOsc.type = String(preset.modType || 'sine');
          modOsc.frequency.setValueAtTime(Math.max(0.1, hzU * ratio), t);

          const modGain = audioCtx.createGain();
          const idxHz = clamp(Number(preset.modIndexHz) || 120, 0, 1200);
          const depth = idxHz * Math.sqrt(Math.max(0.01, hzU / 440));
          modGain.gain.setValueAtTime(depth, t);
          // Fast decay for bell-ish attack
          const md = clamp(Number(preset.modDecay) || 0.10, 0.01, 1.0);
          modGain.gain.exponentialRampToValueAtTime(0.0001, t + md);

          try { modOsc.connect(modGain); modGain.connect(carrier.frequency); } catch (_) {}

          try { carrier.connect(vGain); } catch (_) {}

          const stopAt = tEnd + 0.02;
          try { modOsc.start(t); modOsc.stop(stopAt); } catch (_) {}
          try { carrier.start(t); carrier.stop(stopAt); } catch (_) {}

          oscs.push(carrier);
          modOscs.push(modOsc);
          modGains.push(modGain);
        }
      } else {
        for (let u = 0; u < unison; u++) {
          const cents = (unison === 1) ? 0 : (u - (unison - 1) / 2) * detuneCents;
          const hzU = (Number.isFinite(hz) && hz > 0) ? (hz * Math.pow(2, cents / 1200)) : 440;

          const osc = audioCtx.createOscillator();
          osc.type = String(preset.oscType || 'sine');
          osc.frequency.setValueAtTime(hzU, t);
          try { osc.connect(vGain); } catch (_) {}
          const stopAt = tEnd + 0.02;
          try { osc.start(t); osc.stop(stopAt); } catch (_) {}
          oscs.push(osc);
        }
      }
    }

    // Keep registry small (avoid node explosion on extreme configs)
    if (oscs.length > 12) oscs.length = 12;

    scheduledPolyNodes.push({ kind: 'synth', gain: mix, oscs, modOscs, modGains, lpf: filt, startAt: t0, stopAt: tEndMax });
  }

  function playPolyPercAt(token, whenMs, gainMul = 1, layer) {
    ensureAudio();
    if (!audioCtx) return;

    const t0 = msToAudioTime(whenMs);
    const dest = polyMasterGain || bellMasterGain || audioCtx.destination;

    const l = (layer && typeof layer === 'object') ? layer : {};
    const preset = polyGetPercPreset(l.percPreset);

    const adv = (l.synthParamsAdvanced && typeof l.synthParamsAdvanced === 'object' && !Array.isArray(l.synthParamsAdvanced)) ? l.synthParamsAdvanced : {};

    let s = clamp(Number(gainMul) || 1, 0, 2);
    const vel = Number(adv.velocity);
    if (Number.isFinite(vel)) s *= clamp(vel, 0, 2);
    s = clamp(s, 0, 2);
    const peak = clamp((Number(preset.level) || 0.12) * s, 0.00005, 0.35);

    const kind = String(preset.kind || '').trim();

    let src = null;
    let osc = null;
    let pre = null;

    if (kind === 'kick') {
      const o = audioCtx.createOscillator();
      o.type = String(preset.oscType || 'sine');
      const f0 = clamp(Number(preset.fStart) || 140, 30, 400);
      const f1 = clamp(Number(preset.fEnd) || 50, 20, 300);
      const dt = clamp(Number(preset.dropTime) || 0.05, 0.005, 0.25);
      o.frequency.setValueAtTime(f0, t0);
      try { o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dt); } catch (_) { try { o.frequency.linearRampToValueAtTime(f1, t0 + dt); } catch (_) {} }
      src = o;
      pre = o;
    } else {
      const n = audioCtx.createBufferSource();
      try { n.buffer = getNoiseBuffer(); } catch (_) {}
      n.loop = true;
      src = n;
      pre = n;
    }

    // Optional snare tone mixed into the noise burst (still shaped by the same envelope)
    if (kind === 'snare') {
      const mix = audioCtx.createGain();
      mix.gain.setValueAtTime(1.0, t0);
      try { pre.connect(mix); } catch (_) {}
      pre = mix;

      osc = audioCtx.createOscillator();
      osc.type = 'sine';
      const thz = clamp(Number(preset.toneHz) || 190, 60, 800);
      osc.frequency.setValueAtTime(thz, t0);

      const tonePre = audioCtx.createGain();
      const tl = clamp(Number(preset.toneLevel) || 0.35, 0, 1);
      const td = clamp(Number(preset.toneDecay) || 0.07, 0.01, 0.30);
      tonePre.gain.setValueAtTime(Math.max(0.0001, tl), t0);
      try { tonePre.gain.exponentialRampToValueAtTime(0.0001, t0 + td); } catch (_) {}

      try { osc.connect(tonePre); tonePre.connect(mix); } catch (_) {}
    }

    let filt = null;
    const advF = (adv.filter && typeof adv.filter === 'object' && !Array.isArray(adv.filter)) ? adv.filter : null;
    const presetF = (preset.filter && typeof preset.filter === 'object') ? preset.filter : null;
    const needFilter = !!(audioCtx.createBiquadFilter && (presetF || advF));
    if (needFilter) {
      try {
        filt = audioCtx.createBiquadFilter();
        filt.type = String((advF && advF.type) || (presetF && presetF.type) || 'highpass');

        let hz = Number(presetF && presetF.cutoffHz);
        if (!Number.isFinite(hz)) hz = 6500;
        const advHz = Number(advF && advF.cutoffHz);
        if (Number.isFinite(advHz)) hz = advHz;

        hz = clamp(Number(hz) || 6500, 20, 20000);
        // Optional light "pitch" influence: token 1..12 nudges cutoff upward
        const tok = clamp(parseInt(token, 10) || 1, 1, 12);
        hz = clamp(hz * Math.pow(2, (tok - 1) / 48), 20, 20000);

        let q = Number(presetF && presetF.Q);
        if (!Number.isFinite(q)) q = 0.7;
        const advQ = Number(advF && advF.Q);
        if (Number.isFinite(advQ)) q = advQ;
        q = clamp(q, 0.1, 20);

        filt.frequency.setValueAtTime(hz, t0);
        filt.Q.setValueAtTime(q, t0);
      } catch (_) { filt = null; }
    }



    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    const env = (adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)) ? Object.assign({}, (preset.env || {}), adv.env) : preset.env;
    const taps = (preset && Array.isArray(preset.tapsMs)) ? preset.tapsMs : null;
    const tail = (preset && preset.tail != null) ? preset.tail : null;
    const tEnd = (kind === 'clap') ? polyApplyClapEnv(gain.gain, t0, peak, env, taps, tail) : polyApplyEnv(gain.gain, t0, peak, env);

    try {
      if (filt) pre.connect(filt).connect(gain).connect(dest);
      else pre.connect(gain).connect(dest);
    } catch (_) {
      try { src.connect(gain).connect(audioCtx.destination); } catch (_) {}
    }

    const stopAt = tEnd + 0.02;
    try { src.start(t0); src.stop(stopAt); } catch (_) {}
    if (osc) { try { osc.start(t0); osc.stop(stopAt); } catch (_) {} }

    scheduledPolyNodes.push({ kind: 'perc', gain, src, osc, lpf: filt, startAt: t0, stopAt: stopAt });
  }

    // === Bell master volume + Drone (background) ===
  const DRONE_FADE_SEC = 0.12;
  const DRONE_TONAL_LEVEL = 0.10;
  const DRONE_NOISE_LEVEL = 0.06;

  // v014_p02_drone_variant_knobs: guardrails
  const DRONE_VOICE_CAP = 16;
  
  // v014_p04_multi_drone_layers: global voice cap across all layers.
  // Degrade rule (deterministic): if cap would be exceeded, clamp density on later layers first (Layer 4 → 3 → 2 → 1).
  const DRONE_GLOBAL_VOICE_CAP = 28;
const DRONE_MOD_TICK_MS = 220;
  let droneModTimer = 0;

  function applyBellMasterGain() {
    if (!audioCtx || !bellMasterGain) return;
    const g = clamp((Number(state.bellVolume) || 0) / 100, 0, 1);
    const now = audioCtx.currentTime;
    try {
      bellMasterGain.gain.cancelScheduledValues(now);
      bellMasterGain.gain.setTargetAtTime(g, now, 0.01);
    } catch (_) {}
  }

  function applyDroneMasterGain() {
    if (!audioCtx || !droneMasterGain) return;
    const g0 = clamp((Number(state.droneVolume) || 0) / 100, 0, 1);
    const g = state.dronePaused ? 0 : g0;
    const now = audioCtx.currentTime;
    try {
      droneMasterGain.gain.cancelScheduledValues(now);
      droneMasterGain.gain.setTargetAtTime(g, now, 0.02);
    } catch (_) {}
  }

  // v017_p01_polyrhythm_core: separate master gain for polyrhythm layers
  function applyPolyMasterGain() {
    if (!audioCtx || !polyMasterGain) return;
    const g = clamp((Number(state.polyMasterVolume) || 0) / 100, 0, 1);
    const now = audioCtx.currentTime;
    try {
      polyMasterGain.gain.cancelScheduledValues(now);
      polyMasterGain.gain.setTargetAtTime(g, now, 0.01);
    } catch (_) {}
  }


  // v014_p03_master_fx_limiter_reverb: Master FX (Limiter + Reverb send) persisted + UI
function masterFxDefaults() {
  return {
    fxLimiterEnabled: true,
    fxLimiterAmount: 0.25,
    fxReverbEnabled: false,
    fxReverbSize: 0.55,
    fxReverbMix: 0.15,
    fxReverbHighCutHz: 6000,
  };
}

function loadMasterFxFromLS() {
  const def = masterFxDefaults();
  const raw = safeGetLS(LS_MASTER_FX);
  const parsed = raw ? safeJsonParse(raw) : null;
  const obj = (parsed && typeof parsed === 'object') ? parsed : {};
  let dirty = false;

  if (typeof obj.fxLimiterEnabled === 'undefined') dirty = true;
  state.fxLimiterEnabled = (typeof obj.fxLimiterEnabled === 'undefined') ? def.fxLimiterEnabled : !!obj.fxLimiterEnabled;

  const amt = Number(obj.fxLimiterAmount);
  if (!Number.isFinite(amt)) dirty = true;
  state.fxLimiterAmount = clamp(Number.isFinite(amt) ? amt : def.fxLimiterAmount, 0, 1);

  if (typeof obj.fxReverbEnabled === 'undefined') dirty = true;
  state.fxReverbEnabled = (typeof obj.fxReverbEnabled === 'undefined') ? def.fxReverbEnabled : !!obj.fxReverbEnabled;

  const size = Number(obj.fxReverbSize);
  if (!Number.isFinite(size)) dirty = true;
  state.fxReverbSize = clamp(Number.isFinite(size) ? size : def.fxReverbSize, 0, 1);

  const mix = Number(obj.fxReverbMix);
  if (!Number.isFinite(mix)) dirty = true;
  state.fxReverbMix = clamp(Number.isFinite(mix) ? mix : def.fxReverbMix, 0, 1);

  const hc = Number(obj.fxReverbHighCutHz);
  if (!Number.isFinite(hc)) dirty = true;
  state.fxReverbHighCutHz = clamp(Number.isFinite(hc) ? hc : def.fxReverbHighCutHz, 500, 20000);

  if (dirty) saveMasterFxToLS();
}

function saveMasterFxToLS() {
  try {
    const out = {
      fxLimiterEnabled: !!state.fxLimiterEnabled,
      fxLimiterAmount: clamp(Number(state.fxLimiterAmount) || 0, 0, 1),
      fxReverbEnabled: !!state.fxReverbEnabled,
      fxReverbSize: clamp(Number(state.fxReverbSize) || 0, 0, 1),
      fxReverbMix: clamp(Number(state.fxReverbMix) || 0, 0, 1),
      fxReverbHighCutHz: clamp(Number(state.fxReverbHighCutHz) || 6000, 500, 20000),
    };
    safeSetLS(LS_MASTER_FX, JSON.stringify(out));
  } catch (_) {}
}

function syncMasterFxUI() {
  if (masterLimiterToggle) {
    masterLimiterToggle.textContent = state.fxLimiterEnabled ? 'Limiter On' : 'Limiter Off';
    masterLimiterToggle.classList.toggle('active', !!state.fxLimiterEnabled);
    try { masterLimiterToggle.setAttribute('aria-pressed', state.fxLimiterEnabled ? 'true' : 'false'); } catch (_) {}
  }
  if (masterLimiterStrength) {
    masterLimiterStrength.value = String(clamp(Number(state.fxLimiterAmount) || 0, 0, 1));
  }

  if (masterReverbToggle) {
    masterReverbToggle.textContent = state.fxReverbEnabled ? 'Reverb On' : 'Reverb Off';
    masterReverbToggle.classList.toggle('active', !!state.fxReverbEnabled);
    try { masterReverbToggle.setAttribute('aria-pressed', state.fxReverbEnabled ? 'true' : 'false'); } catch (_) {}
  }
  if (masterReverbSize) masterReverbSize.value = String(clamp(Number(state.fxReverbSize) || 0, 0, 1));
  if (masterReverbMix) masterReverbMix.value = String(clamp(Number(state.fxReverbMix) || 0, 0, 1));
  if (masterReverbHighCut) masterReverbHighCut.value = String(clamp(Number(state.fxReverbHighCutHz) || 6000, 500, 20000));
}

  // v017_p01_polyrhythm_core: Polyrhythm (Sound) — config + UI (no backend, no external libs)
  // v017_p02_polyrhythm_layer_sound: per-layer bell sound profile (Mirror Base / Custom)
  function polyBellSoundDefaults() {
    return {
      profile: 'mirror',
      timbre: {
        ringLength01: BELL_RING_LENGTH_DEFAULT,
        brightness01: BELL_BRIGHTNESS_DEFAULT,
        strikeHardness01: BELL_STRIKE_HARDNESS_DEFAULT,
      },
      chords: {
        enabled: false,
        preset: 'unison',
        customIntervals: '',
        _intervals: null,
      },
      pitch: {
        layerTransposeSemis: 0,
      },
      perBell: {},
    };
  }

  function sanitizePolyBellSound(raw) {
    const d = polyBellSoundDefaults();
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {
      profile: (r.profile === 'custom') ? 'custom' : 'mirror',
      timbre: {
        ringLength01: d.timbre.ringLength01,
        brightness01: d.timbre.brightness01,
        strikeHardness01: d.timbre.strikeHardness01,
      },
      chords: {
        enabled: d.chords.enabled,
        preset: d.chords.preset,
        customIntervals: d.chords.customIntervals,
        _intervals: null,
      },
      pitch: {
        layerTransposeSemis: d.pitch.layerTransposeSemis,
      },
      perBell: {},
    };

    // Timbre (layer)
    const t = (r.timbre && typeof r.timbre === 'object') ? r.timbre : null;
    if (t) {
      const rl = Number(t.ringLength01);
      if (Number.isFinite(rl)) out.timbre.ringLength01 = clamp(rl, 0, 1);
      const br = Number(t.brightness01);
      if (Number.isFinite(br)) out.timbre.brightness01 = clamp(br, 0, 1);
      const hd = Number(t.strikeHardness01);
      if (Number.isFinite(hd)) out.timbre.strikeHardness01 = clamp(hd, 0, 1);
    }

    // Pitch (layer)
    const p = (r.pitch && typeof r.pitch === 'object') ? r.pitch : null;
    if (p) {
      const s = parseInt(p.layerTransposeSemis, 10);
      if (Number.isFinite(s)) out.pitch.layerTransposeSemis = clamp(s, -24, 24);
    }

    // Chords (layer)
    const c = (r.chords && typeof r.chords === 'object') ? r.chords : null;
    if (c) {
      out.chords.enabled = (c.enabled != null) ? !!c.enabled : out.chords.enabled;
      const preset = String(c.preset || out.chords.preset);
      out.chords.preset = (GLOBAL_CHORD_PRESETS && GLOBAL_CHORD_PRESETS[preset]) ? preset : out.chords.preset;
      out.chords.customIntervals = String(c.customIntervals || '');
    }
    const txt = String(out.chords.customIntervals || '').trim();
    if (txt) {
      const parsed = parseCustomChordIntervalsText(txt, 6);
      out.chords._intervals = (parsed && parsed.ok && parsed.vals && parsed.vals.length) ? parsed.vals.slice(0, 6) : null;
    }

    // Per-bell overrides (optional)
    const pb = (r.perBell && typeof r.perBell === 'object') ? r.perBell : null;
    if (pb) {
      for (const k in pb) {
        const b = clamp(parseInt(k, 10) || 0, 1, 12);
        const entRaw = pb[k];
        if (!entRaw || typeof entRaw !== 'object') continue;
        const ent = {};

        // Pitch override
        if (entRaw.pitch && typeof entRaw.pitch === 'object') {
          const pr = entRaw.pitch;
          const po = {};
          if (pr.transposeSemis != null) {
            const ps = parseInt(pr.transposeSemis, 10);
            po.transposeSemis = Number.isFinite(ps) ? clamp(ps, -24, 24) : 0;
          } else {
            po.transposeSemis = 0;
          }
          const hz = Number(pr.hz != null ? pr.hz : pr.hzOverride);
          po.hz = (Number.isFinite(hz) && hz > 0) ? hz : null;
          ent.pitch = po;
        }

        // Timbre override
        if (entRaw.timbre && typeof entRaw.timbre === 'object') {
          const tr = entRaw.timbre;
          const to = {};
          const rl = Number(tr.ringLength01);
          if (Number.isFinite(rl)) to.ringLength01 = clamp(rl, 0, 1);
          const br = Number(tr.brightness01);
          if (Number.isFinite(br)) to.brightness01 = clamp(br, 0, 1);
          const hd = Number(tr.strikeHardness01);
          if (Number.isFinite(hd)) to.strikeHardness01 = clamp(hd, 0, 1);
          ent.timbre = to;
        }

        // Chord override
        if (entRaw.chords && typeof entRaw.chords === 'object') {
          const cr = entRaw.chords;
          const co = {
            enabled: (cr.enabled != null) ? !!cr.enabled : true,
            preset: 'unison',
            customIntervals: String(cr.customIntervals || ''),
            _intervals: null,
          };
          const preset = String(cr.preset || '');
          if (preset && GLOBAL_CHORD_PRESETS && GLOBAL_CHORD_PRESETS[preset]) co.preset = preset;
          const cTxt = String(co.customIntervals || '').trim();
          if (cTxt) {
            const parsed = parseCustomChordIntervalsText(cTxt, 6);
            co._intervals = (parsed && parsed.ok && parsed.vals && parsed.vals.length) ? parsed.vals.slice(0, 6) : null;
          }
          ent.chords = co;
        }

        if (ent.pitch || ent.timbre || ent.chords) {
          out.perBell[String(b)] = ent;
        }
      }
    }

    return out;
  }

  function polyBellSoundToJSON(raw) {
    const s = sanitizePolyBellSound(raw);
    const out = {
      profile: s.profile,
      timbre: {
        ringLength01: s.timbre.ringLength01,
        brightness01: s.timbre.brightness01,
        strikeHardness01: s.timbre.strikeHardness01,
      },
      chords: {
        enabled: !!s.chords.enabled,
        preset: String(s.chords.preset || 'unison'),
        customIntervals: String(s.chords.customIntervals || ''),
      },
      pitch: {
        layerTransposeSemis: clamp(parseInt(s.pitch.layerTransposeSemis, 10) || 0, -24, 24),
      },
    };

    const pb = (s.perBell && typeof s.perBell === 'object') ? s.perBell : null;
    if (pb) {
      const outPb = {};
      for (let b = 1; b <= 12; b++) {
        const e = pb[b];
        if (!e || typeof e !== 'object') continue;
        const oe = {};
        if (e.pitch && typeof e.pitch === 'object') {
          oe.pitch = {
            transposeSemis: clamp(parseInt(e.pitch.transposeSemis, 10) || 0, -24, 24),
            hz: (Number.isFinite(Number(e.pitch.hz)) && Number(e.pitch.hz) > 0) ? Number(e.pitch.hz) : null,
          };
        }
        if (e.timbre && typeof e.timbre === 'object') {
          oe.timbre = {
            ringLength01: Number.isFinite(Number(e.timbre.ringLength01)) ? clamp(Number(e.timbre.ringLength01), 0, 1) : undefined,
            brightness01: Number.isFinite(Number(e.timbre.brightness01)) ? clamp(Number(e.timbre.brightness01), 0, 1) : undefined,
            strikeHardness01: Number.isFinite(Number(e.timbre.strikeHardness01)) ? clamp(Number(e.timbre.strikeHardness01), 0, 1) : undefined,
          };
        }
        if (e.chords && typeof e.chords === 'object') {
          oe.chords = {
            enabled: (e.chords.enabled != null) ? !!e.chords.enabled : true,
            preset: (e.chords.preset && GLOBAL_CHORD_PRESETS && GLOBAL_CHORD_PRESETS[e.chords.preset]) ? e.chords.preset : 'unison',
            customIntervals: String(e.chords.customIntervals || ''),
          };
        }
        if (oe.pitch || oe.timbre || oe.chords) {
          outPb[String(b)] = oe;
        }
      }
      if (Object.keys(outPb).length) out.perBell = outPb;
    }

    return out;
  }

  function polyBuildBellSoundCtx(layer) {
    const l = (layer && typeof layer === 'object') ? layer : null;
    if (!l) return null;

    const bsRaw = l.bellSound;
    const looksOk = !!(bsRaw && typeof bsRaw === 'object'
      && (bsRaw.profile === 'custom' || bsRaw.profile === 'mirror')
      && bsRaw.timbre && typeof bsRaw.timbre === 'object'
      && bsRaw.chords && typeof bsRaw.chords === 'object'
      && bsRaw.pitch && typeof bsRaw.pitch === 'object'
      && bsRaw.perBell && (typeof bsRaw.perBell === 'object'));

    const s = looksOk ? bsRaw : sanitizePolyBellSound(bsRaw);
    if (s !== bsRaw) l.bellSound = s;

    if (s.profile !== 'custom') return null;
    return { profile: 'custom', ignoreGlobalChordAdvanced: true, bs: s };
  }
  function makeDefaultPolyLayer() {
    return {
      id: rid('pl_'),
      enabled: true,
      type: 'pulse', // 'pulse' | 'phrase' | 'method_current'
      sound: 'bell', // 'bell' | 'tick' | 'synth' | 'perc'
      interval: '1',
      offset: '0',
      volume: 80,
      token: 1,      // 1..12 (pulse)
      phrase: '',    // (phrase)
      bellSound: polyBellSoundDefaults(),
      // v018_p01_poly_synth_core
      synthPreset: 'tone_sine',
      pitchSource: 'bell12', // 'bell12' | 'chromatic' | 'fixed'
      pitchBase: 60,         // MIDI base (C4=60)
      pitchHz: null,         // optional fixed Hz override
      synthParams: {},
      synthParamsAdvanced: {},
      tokenOverrides: {},
      percPreset: 'noise_hat',
      percParams: {},
    };
  }

  

  // v018_p02_poly_synth_advanced: layer-level advanced params + per-token overrides (fail-open)
  function sanitizePolySynthParamsAdvanced(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    const out = {};
    if (!r) return out;

    // ADSR
    if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
      const e = r.env;
      const oe = {};
      const a = Number(e.a); if (Number.isFinite(a)) oe.a = clamp(a, 0.0001, 1.0);
      const d = Number(e.d); if (Number.isFinite(d)) oe.d = clamp(d, 0.0001, 2.0);
      const s = Number(e.s); if (Number.isFinite(s)) oe.s = clamp(s, 0.0, 1.0);
      const rr = Number(e.r); if (Number.isFinite(rr)) oe.r = clamp(rr, 0.0001, 3.0);
      if (Object.keys(oe).length) out.env = oe;
    }

    // Filter
    if (r.filter && typeof r.filter === 'object' && !Array.isArray(r.filter)) {
      const f = r.filter;
      const of = {};
      const t = String(f.type || '').trim();
      if (t) {
        const ok = (t === 'lowpass' || t === 'highpass' || t === 'bandpass' || t === 'notch'
          || t === 'allpass' || t === 'lowshelf' || t === 'highshelf' || t === 'peaking');
        if (ok) of.type = t;
      }
      const hz = Number(f.cutoffHz); if (Number.isFinite(hz)) of.cutoffHz = clamp(hz, 20, 20000);
      const q = Number(f.Q); if (Number.isFinite(q)) of.Q = clamp(q, 0.1, 20);
      if (Object.keys(of).length) out.filter = of;
    }

    // Detune/unison (synth only, but safe to store)
    const det = Number(r.detuneCents); if (Number.isFinite(det)) out.detuneCents = clamp(det, 0, 100);
    const uni = parseInt(String(r.unison ?? ''), 10);
    if (Number.isFinite(uni)) out.unison = clamp(uni, 1, 4);

    // Velocity scalar
    const vel = Number(r.velocity); if (Number.isFinite(vel)) out.velocity = clamp(vel, 0, 2);

    return out;
  }

  function sanitizePolyTokenOverrides(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    const out = {};
    if (!r) return out;

    for (const k in r) {
      if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
      const tok = parseInt(String(k), 10);
      if (!Number.isFinite(tok) || tok < 1 || tok > 12) continue;

      const v = r[k];
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;

      const o = {};
      const ps = Number(v.pitchSemis);
      if (Number.isFinite(ps)) {
        const n = clamp(Math.round(ps), -24, 24);
        if (n !== 0) o.pitchSemis = n;
      }
      const g = Number(v.gain);
      if (Number.isFinite(g)) {
        const gg = clamp(g, 0, 2);
        if (Math.abs(gg - 1) > 1e-6) o.gain = gg;
      }
      const cd = Number(v.cutoffDeltaHz);
      if (Number.isFinite(cd)) {
        const cdd = clamp(cd, -20000, 20000);
        if (Math.abs(cdd) > 0.5) o.cutoffDeltaHz = cdd;
      }
      const br = Number(v.brightness);
      if (Number.isFinite(br)) {
        const bb = clamp(br, 0.1, 4);
        if (Math.abs(bb - 1) > 1e-6) o.brightness = bb;
      }

      if (Object.keys(o).length) out[String(tok)] = o;
    }
    return out;
  }
function coercePolyLayer(raw, fallbackIdx = 0) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const id = (typeof r.id === 'string' && r.id.trim()) ? r.id.trim() : rid('pl_');

    const type = (r.type === 'pulse' || r.type === 'phrase' || r.type === 'method_current') ? r.type : 'pulse';
    const sound = (r.sound === 'bell' || r.sound === 'tick' || r.sound === 'synth' || r.sound === 'perc') ? r.sound : 'bell';

    const interval = (r.interval === '2' || r.interval === '1' || r.interval === '1/2' || r.interval === '1/3' || r.interval === '1/4') ? r.interval : '1';

    let offset = (typeof r.offset === 'string') ? r.offset : String(r.offset ?? '0');
    offset = String(offset || '0').trim();
    const offOpts = polyOffsetOptionsForInterval(interval);
    if (!offOpts.some(o => o.value === offset)) offset = '0';

    const volume = clamp(Number(r.volume ?? 80) || 0, 0, 100);
    const token = clamp(parseInt(r.token ?? (fallbackIdx + 1), 10) || 1, 1, 12);
    const phrase = (r.phrase == null) ? '' : String(r.phrase);


    // v018_p01_poly_synth_core: per-layer synth/perc config (fail-open)
    const synthPreset = (typeof r.synthPreset === 'string' && r.synthPreset.trim()) ? r.synthPreset.trim() : 'tone_sine';
    const pitchSource = (r.pitchSource === 'bell12' || r.pitchSource === 'chromatic' || r.pitchSource === 'fixed') ? r.pitchSource : 'bell12';
    const pitchBase = clamp(parseInt(String(r.pitchBase ?? 60), 10) || 60, 0, 127);
    const hzRaw = Number(r.pitchHz);
    const pitchHz = (Number.isFinite(hzRaw) && hzRaw > 0) ? hzRaw : null;
    const synthParams = (r.synthParams && typeof r.synthParams === 'object' && !Array.isArray(r.synthParams)) ? r.synthParams : {};
    const percPreset = (typeof r.percPreset === 'string' && r.percPreset.trim()) ? r.percPreset.trim() : 'noise_hat';
    const percParams = (r.percParams && typeof r.percParams === 'object' && !Array.isArray(r.percParams)) ? r.percParams : {};

    const synthParamsAdvanced = sanitizePolySynthParamsAdvanced(r.synthParamsAdvanced);
    const tokenOverrides = sanitizePolyTokenOverrides(r.tokenOverrides);
    const bellSound = sanitizePolyBellSound(r.bellSound);
    return { id, enabled: r.enabled !== false, type, sound, interval, offset, volume, token, phrase, bellSound, synthPreset, pitchSource, pitchBase, pitchHz, synthParams, synthParamsAdvanced, tokenOverrides, percPreset, percParams };
  }

  function loadPolyrhythmFromLS() {
    try {
      const txt = safeGetLS(LS_POLYRHYTHM);
      if (!txt) return;
      const raw = safeJsonParse(txt);
      if (!raw || typeof raw !== 'object') return;

      if (raw.enabledForRuns != null) state.polyEnabledForRuns = !!raw.enabledForRuns;
      if (raw.masterVolume != null) state.polyMasterVolume = clamp(Number(raw.masterVolume) || 0, 0, 100);

      if (Array.isArray(raw.layers)) {
        state.polyLayers = raw.layers.map((l, i) => coercePolyLayer(l, i)).filter(Boolean);
      } else if (!Array.isArray(state.polyLayers)) {
        state.polyLayers = [];
      }
    } catch (_) {}
  }

  function savePolyrhythmToLS() {
    try {
      const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
      const out = {
        v: 1,
        enabledForRuns: !!state.polyEnabledForRuns,
        masterVolume: clamp(Number(state.polyMasterVolume) || 0, 0, 100),
        layers: layers.map((l, i) => {
          const layer = coercePolyLayer(l, i);
          return {
            id: layer.id,
            enabled: !!layer.enabled,
            type: layer.type,
            sound: layer.sound,
            interval: layer.interval,
            offset: layer.offset,
            volume: clamp(Number(layer.volume) || 0, 0, 100),
            token: clamp(parseInt(layer.token, 10) || 1, 1, 12),
            phrase: String(layer.phrase || ''),
            bellSound: polyBellSoundToJSON(layer.bellSound),
            // v018_p01_poly_synth_core
            synthPreset: String(layer.synthPreset || ''),
            pitchSource: String(layer.pitchSource || ''),
            pitchBase: clamp(parseInt(String(layer.pitchBase ?? 60), 10) || 60, 0, 127),
            pitchHz: (Number.isFinite(Number(layer.pitchHz)) && Number(layer.pitchHz) > 0) ? Number(layer.pitchHz) : null,
            synthParams: (layer.synthParams && typeof layer.synthParams === 'object' && !Array.isArray(layer.synthParams)) ? layer.synthParams : {},
            percPreset: String(layer.percPreset || ''),
            percParams: (layer.percParams && typeof layer.percParams === 'object' && !Array.isArray(layer.percParams)) ? layer.percParams : {},
          };
        }),
      };
      safeSetLS(LS_POLYRHYTHM, JSON.stringify(out));
    } catch (_) {}
  }

  function polyIsRunActive() {
    return !!(state.polyEnabledForRuns && (state.mode === 'demo' || state.mode === 'play') && (state.phase === 'countdown' || state.phase === 'running'));
  }

  function polyIsActive() {
    return !!(polyTestActive || polyIsRunActive());
  }

  function polyResyncActiveNow() {
    if (!polyIsActive()) return;
    try { cancelScheduledPolyAudioNow(); } catch (_) {}
    try {
      const nowMs = perfNow();
      const bpm = polyTestActive ? (Number(polyTestBpm) || 120) : (Number(state.bpm) || 120);
      const beatMs = 60000 / bpm;
      const anchorMs = polyTestActive ? polyTestStartMs : state.methodStartMs;
      polyResetSchedPointers(nowMs, anchorMs, beatMs);
    } catch (_) {}
    kickLoop();
  }

  function startPolyrhythmTest() {
    if (polyTestActive) return;
    if (state.phase !== 'idle') return; // avoid interfering with an active run
    ensureAudio();

    polyTestActive = true;
    polyTestStartMs = perfNow();
    polyTestBpm = Number(state.bpm) || 120;
    polySchedNextById = Object.create(null);

    try { cancelScheduledPolyAudioNow(); } catch (_) {}
    polyResyncActiveNow();
    syncPolyrhythmUI();
  }

  function stopPolyrhythmTest() {
    if (!polyTestActive) { syncPolyrhythmUI(); return; }
    polyTestActive = false;
    polyTestStartMs = 0;
    polyTestBpm = 0;
    polySchedNextById = Object.create(null);

    try { cancelScheduledPolyAudioNow(); } catch (_) {}
    syncPolyrhythmUI();
  }

  function rebuildPolyrhythmUI() {
    const dest = document.getElementById('soundPolyrhythmControls');
    if (!dest) return;

    ui.poly = ui.poly || {};
    const P = ui.poly;
    P.layerUiById = Object.create(null);

    dest.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'rg-poly-root';
    dest.appendChild(root);
    P.root = root;

    function mkControl(labelText, childEl) {
      const c = document.createElement('div');
      c.className = 'control';
      const lab = document.createElement('label');
      lab.textContent = labelText;
      c.appendChild(lab);
      if (childEl) c.appendChild(childEl);
      return c;
    }

    function mkSelect(opts) {
      const s = document.createElement('select');
      for (let i = 0; i < opts.length; i++) {
        const o = document.createElement('option');
        o.value = String(opts[i].value);
        o.textContent = String(opts[i].label);
        s.appendChild(o);
      }
      return s;
    }

    function mkOffsetSelect(intervalKey) {
      const opts = polyOffsetOptionsForInterval(intervalKey);
      return mkSelect(opts);
    }

    const global = document.createElement('div');
    global.className = 'rg-poly-global';
    root.appendChild(global);

    // Enabled for runs
    const enabledBtn = document.createElement('button');
    enabledBtn.type = 'button';
    enabledBtn.className = 'pill';
    enabledBtn.addEventListener('click', () => {
      const was = !!state.polyEnabledForRuns;
      state.polyEnabledForRuns = !state.polyEnabledForRuns;
      savePolyrhythmToLS();
      if (was && !state.polyEnabledForRuns) {
        try { cancelScheduledPolySynthAudioNow(); } catch (_) {}
      }
      polyResyncActiveNow();
      syncPolyrhythmUI();
    });
    P.enabledBtn = enabledBtn;
    global.appendChild(mkControl('Enabled for runs', enabledBtn));

    // Master volume
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.step = '1';
    vol.addEventListener('input', () => {
      state.polyMasterVolume = clamp(Number(vol.value) || 0, 0, 100);
      savePolyrhythmToLS();
      applyPolyMasterGain();
    });
    vol.addEventListener('change', () => {
      applyPolyMasterGain();
    });
    P.masterVol = vol;
    global.appendChild(mkControl('Master volume', vol));

    // Test / Stop
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'pill';
    testBtn.addEventListener('click', () => {
      if (polyTestActive) stopPolyrhythmTest();
      else startPolyrhythmTest();
    });
    P.testBtn = testBtn;
    global.appendChild(mkControl('Test / Stop', testBtn));

    // Add layer
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pill';
    addBtn.textContent = 'Add layer';
    addBtn.addEventListener('click', () => {
      if (!Array.isArray(state.polyLayers)) state.polyLayers = [];
      state.polyLayers.push(makeDefaultPolyLayer());
      savePolyrhythmToLS();
      rebuildPolyrhythmUI();
      polyResyncActiveNow();
    });
    P.addBtn = addBtn;
    global.appendChild(addBtn);

    const layersWrap = document.createElement('div');
    layersWrap.className = 'rg-poly-layers';
    root.appendChild(layersWrap);
    P.layersWrap = layersWrap;

    const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
    if (!layers.length) {
      const note = document.createElement('div');
      note.className = 'rg-poly-inline-note';
      note.textContent = 'Add one or more layers to hear polyrhythm during Demo/Play, or use Test to preview.';
      layersWrap.appendChild(note);
    }

    function setVisible(el, on) {
      if (!el) return;
      el.style.display = on ? '' : 'none';
    }

    function rebuildOffsetOptions(sel, intervalKey, keepValue) {
      const opts = polyOffsetOptionsForInterval(intervalKey);
      sel.innerHTML = '';
      for (let i = 0; i < opts.length; i++) {
        const o = document.createElement('option');
        o.value = String(opts[i].value);
        o.textContent = String(opts[i].label);
        sel.appendChild(o);
      }
      const wanted = String(keepValue ?? '0');
      const has = opts.some(o => String(o.value) === wanted);
      sel.value = has ? wanted : '0';
    }

    for (let i = 0; i < layers.length; i++) {
      const layer = coercePolyLayer(layers[i], i);
      layers[i] = layer; // normalize in-place

      const card = document.createElement('div');
      card.className = 'rg-poly-layer-card';
      card.dataset.layerId = layer.id;
      layersWrap.appendChild(card);

      const head = document.createElement('div');
      head.className = 'rg-poly-layer-head';
      card.appendChild(head);

      const title = document.createElement('div');
      title.className = 'rg-poly-layer-title';
      title.textContent = `Layer ${i + 1}`;
      head.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'rg-poly-layer-actions';
      head.appendChild(actions);

      const enabled = document.createElement('button');
      enabled.type = 'button';
      enabled.className = 'pill';
      enabled.addEventListener('click', () => {
        layer.enabled = !layer.enabled;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      actions.appendChild(enabled);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'pill';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        // Cancel only polyrhythm scheduled audio (not base bells)
        try { cancelScheduledPolyAudioNow(); } catch (_) {}

        if (Array.isArray(state.polyLayers)) {
          const idx = state.polyLayers.findIndex(l => l && l.id === layer.id);
          if (idx >= 0) state.polyLayers.splice(idx, 1);
          else if (i >= 0 && i < state.polyLayers.length) state.polyLayers.splice(i, 1);
        }

        try { delete polySchedNextById[layer.id]; } catch (_) {}

        savePolyrhythmToLS();
        rebuildPolyrhythmUI();
        polyResyncActiveNow();
      });
      actions.appendChild(removeBtn);

      const controls = document.createElement('div');
      controls.className = 'rg-poly-layer-controls';
      card.appendChild(controls);

      // Type
      const typeSel = mkSelect([
        { value: 'pulse', label: 'Pulse' },
        { value: 'phrase', label: 'Phrase' },
        { value: 'method_current', label: 'Method (Current)' },
      ]);
      typeSel.addEventListener('change', () => {
        layer.type = typeSel.value;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      controls.appendChild(mkControl('Type', typeSel));

      // Sound
      const soundSel = mkSelect([
        { value: 'bell', label: 'Bell' },
        { value: 'tick', label: 'Tick' },
        { value: 'synth', label: 'Synth' },
        { value: 'perc', label: 'Perc' },
      ]);
      soundSel.addEventListener('change', () => {
        layer.sound = soundSel.value;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      controls.appendChild(mkControl('Sound', soundSel));

      // Interval
      const intervalSel = mkSelect([
        { value: '2', label: '2 beats' },
        { value: '1', label: '1 beat' },
        { value: '1/2', label: '1/2 beat' },
        { value: '1/3', label: '1/3 beat' },
        { value: '1/4', label: '1/4 beat' },
      ]);
      intervalSel.addEventListener('change', () => {
        layer.interval = intervalSel.value;
        rebuildOffsetOptions(offsetSel, layer.interval, layer.offset);
        layer.offset = offsetSel.value;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      controls.appendChild(mkControl('Interval', intervalSel));

      // Offset
      const offsetSel = mkOffsetSelect(layer.interval);
      offsetSel.addEventListener('change', () => {
        layer.offset = offsetSel.value;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      controls.appendChild(mkControl('Offset', offsetSel));

      // Volume
      const volRange = document.createElement('input');
      volRange.type = 'range';
      volRange.min = '0';
      volRange.max = '100';
      volRange.step = '1';
      volRange.addEventListener('input', () => {
        layer.volume = clamp(Number(volRange.value) || 0, 0, 100);
        savePolyrhythmToLS();
      });
      volRange.addEventListener('change', () => {
        layer.volume = clamp(Number(volRange.value) || 0, 0, 100);
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });
      controls.appendChild(mkControl('Volume', volRange));

      // Test (one-shot audition; does not affect run/scoring)
      const testArea = document.createElement('div');
      testArea.className = 'rg-poly-test-area';

      const polyAuditionGainMul = () => clamp((Number(layer.volume) || 0) / 100, 0, 1);
      const polyAuditionPickToken = () => {
        const t = clamp(parseInt(layer.token, 10) || 1, 1, 12);
        if (layer.type === 'phrase') {
          try {
            const steps = parsePolyPhraseSteps(layer.phrase);
            for (let si = 0; si < steps.length; si++) {
              const v = clamp(parseInt(steps[si], 10) || 0, 0, 12);
              if (v > 0) return v;
            }
          } catch (_) {}
        }
        return t;
      };

      const polyAuditionLayerTokenNow = (tok) => {
        const token = clamp(parseInt(tok, 10) || 1, 1, 12);
        const nowMs = perfNow();
        try {
          ensureAudio();
          try { applyPolyMasterGain(); } catch (_) {}

          const g = polyAuditionGainMul();
          const s = String(layer.sound || 'bell');

          if (s === 'tick') {
            playPolyTickAt(nowMs, g);
            return;
          }
          if (s === 'perc') {
            playPolyPercAt(token, nowMs, g, layer);
            return;
          }
          if (s === 'synth') {
            try {
              playPolySynthAt(token, nowMs, g, layer);
              return;
            } catch (e1) {
              // Fail-open: ignore overrides and try again.
              try {
                const safeLayer = Object.assign({}, layer);
                safeLayer.tokenOverrides = null;
                playPolySynthAt(token, nowMs, g, safeLayer);
                return;
              } catch (_) {}
            }
            // Last resort: a tick so the button never "does nothing"
            try { playPolyTickAt(nowMs, (g > 0 ? g : 1)); } catch (_) {}
            return;
          }

          // Default: Bell
          try {
            const sc = polyBuildBellSoundCtx(layer);
            playPolyBellAt(token, nowMs, g, sc);
          } catch (_) {
            try { playPolyTickAt(nowMs, (g > 0 ? g : 1)); } catch (_) {}
          }
        } catch (_) {
          try { playPolyTickAt(perfNow(), 1); } catch (_) {}
        }
      };

      const polyAuditionOverrideTokenNow = (tok) => {
        const token = clamp(parseInt(tok, 10) || 1, 1, 12);
        const nowMs = perfNow();
        try {
          ensureAudio();
          try { applyPolyMasterGain(); } catch (_) {}

          const g = polyAuditionGainMul();
          const synthLike = Object.assign({}, layer);
          if (synthLike.pitchSource == null) synthLike.pitchSource = 'bell12';
          if (synthLike.pitchBase == null) synthLike.pitchBase = 60;
          if (synthLike.synthPreset == null) synthLike.synthPreset = 'tone_sine';

          try {
            playPolySynthAt(token, nowMs, g, synthLike);
            return;
          } catch (e1) {
            // Fail-open: ignore overrides and try again.
            try {
              const safeLayer = Object.assign({}, synthLike);
              safeLayer.tokenOverrides = null;
              playPolySynthAt(token, nowMs, g, safeLayer);
              return;
            } catch (_) {}
          }

          // Fallback: play something using the layer's current sound
          try { polyAuditionLayerTokenNow(token); } catch (_) {}
        } catch (_) {
          try { playPolyTickAt(perfNow(), 1); } catch (_) {}
        }
      };

      const testTickBtn = document.createElement('button');
      testTickBtn.type = 'button';
      testTickBtn.className = 'pill rg-mini';
      testTickBtn.textContent = 'Test Tick';
      testTickBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        polyAuditionLayerTokenNow(polyAuditionPickToken());
      });
      testArea.appendChild(testTickBtn);

      const testPercBtn = document.createElement('button');
      testPercBtn.type = 'button';
      testPercBtn.className = 'pill rg-mini';
      testPercBtn.textContent = 'Test Perc';
      testPercBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        polyAuditionLayerTokenNow(polyAuditionPickToken());
      });
      testArea.appendChild(testPercBtn);

      // 12-token sampling keyboard (1–9,0,E,T) for Bell/Synth
      const testKbWrap = document.createElement('div');
      testKbWrap.className = 'rg-poly-test-kb';
      const testKbBtns = [];
      const testKbLabels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'E', 'T'];
      for (let k = 0; k < testKbLabels.length; k++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rg-quick-bell-btn';
        b.textContent = testKbLabels[k];
        b.dataset.token = String(k + 1);
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          const tok = clamp(parseInt(String(b.dataset.token || ''), 10) || (k + 1), 1, 12);
          polyAuditionLayerTokenNow(tok);
        });
        testKbWrap.appendChild(b);
        testKbBtns.push(b);
      }
      testArea.appendChild(testKbWrap);

      const testCtl = mkControl('Test', testArea);
      controls.appendChild(testCtl);

      // Token (Pulse)
      const tokenSel = mkSelect([
        { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' },
        { value: 5, label: '5' }, { value: 6, label: '6' }, { value: 7, label: '7' }, { value: 8, label: '8' },
        { value: 9, label: '9' }, { value: 10, label: '0 (10)' }, { value: 11, label: 'E (11)' }, { value: 12, label: 'T (12)' },
      ]);
      tokenSel.addEventListener('change', () => {
        layer.token = clamp(parseInt(tokenSel.value, 10) || 1, 1, 12);
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });
      const tokenCtl = mkControl('Token', tokenSel);
      controls.appendChild(tokenCtl);

      // Phrase (Phrase)
      const phraseInput = document.createElement('input');
      phraseInput.type = 'text';
      phraseInput.placeholder = 'e.g., 1234 0ET.. (non-tokens become rests)';
      phraseInput.addEventListener('input', () => {
        layer.phrase = String(phraseInput.value || '');
        savePolyrhythmToLS();
      });
      phraseInput.addEventListener('change', () => {
        layer.phrase = String(phraseInput.value || '');
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });
      const phraseCtl = mkControl('Phrase', phraseInput);
      controls.appendChild(phraseCtl);
      // v017_p02_polyrhythm_layer_sound: per-layer bell sound profile UI (Bell layers only)
      const soundDetails = document.createElement('details');
      soundDetails.className = 'rg-poly-sound-details';
      card.appendChild(soundDetails);

      const soundSummary = document.createElement('summary');
      soundSummary.className = 'rg-poly-sound-summary';
      soundDetails.appendChild(soundSummary);

      const soundSummaryTitle = document.createElement('span');
      soundSummaryTitle.textContent = 'Sound';
      soundSummary.appendChild(soundSummaryTitle);

      const soundBadge = document.createElement('span');
      soundBadge.className = 'rg-poly-sound-badge';
      soundSummary.appendChild(soundBadge);

      const soundBody = document.createElement('div');
      soundBody.className = 'rg-poly-sound-body';
      soundDetails.appendChild(soundBody);

      const soundControls = document.createElement('div');
      soundControls.className = 'rg-poly-sound-controls';
      soundBody.appendChild(soundControls);

      const soundProfileSel = mkSelect([
        { value: 'mirror', label: 'Mirror Base' },
        { value: 'custom', label: 'Custom' },
      ]);
      const soundProfileCtl = mkControl('Profile', soundProfileSel);
      soundControls.appendChild(soundProfileCtl);

      // v018_p01_poly_synth_core: synth controls (Synth layers)
      const soundSynthControls = document.createElement('div');
      soundSynthControls.className = 'rg-poly-sound-controls';
      soundBody.appendChild(soundSynthControls);

      const synthPresetSel = mkSelect([
        { value: 'tone_sine', label: 'Sine' },
        { value: 'tone_triangle_pluck', label: 'Triangle Pluck' },
        { value: 'tone_square_lead', label: 'Square Lead' },
        { value: 'tone_saw_pad', label: 'Saw Pad' },
        { value: 'tone_soft_pad', label: 'Soft Pad' },
        { value: 'fm_bell', label: 'FM Bell' },
        { value: 'fm_marimba', label: 'FM Marimba' },
      ]);
      soundSynthControls.appendChild(mkControl('Preset', synthPresetSel));

      const pitchSourceSel = mkSelect([
        { value: 'bell12', label: 'Bell map (12)' },
        { value: 'chromatic', label: 'Chromatic' },
        { value: 'fixed', label: 'Fixed' },
      ]);
      soundSynthControls.appendChild(mkControl('Pitch source', pitchSourceSel));

      const pitchBaseInput = document.createElement('input');
      pitchBaseInput.type = 'number';
      pitchBaseInput.min = '0';
      pitchBaseInput.max = '127';
      pitchBaseInput.step = '1';
      pitchBaseInput.placeholder = '60';
      pitchBaseInput.title = 'MIDI note number (C4=60)';
      const pitchBaseCtl = mkControl('Base MIDI', pitchBaseInput);
      soundSynthControls.appendChild(pitchBaseCtl);

      const pitchHzInput = document.createElement('input');
      pitchHzInput.type = 'number';
      pitchHzInput.min = '1';
      pitchHzInput.max = '20000';
      pitchHzInput.step = '1';
      pitchHzInput.placeholder = '440';
      const pitchHzCtl = mkControl('Fixed Hz', pitchHzInput);
      soundSynthControls.appendChild(pitchHzCtl);

      // v018_p01_poly_synth_core: perc controls (Perc layers)
      const soundPercControls = document.createElement('div');
      soundPercControls.className = 'rg-poly-sound-controls';
      soundBody.appendChild(soundPercControls);

      const percPresetSel = mkSelect([
        { value: 'noise_hat', label: 'Noise Hat' },
        { value: 'kick_sine', label: 'Kick' },
        { value: 'snare_noise', label: 'Snare' },
        { value: 'clap_noise', label: 'Clap' },
        { value: 'click_block', label: 'Click/Block' },
      ]);
      soundPercControls.appendChild(mkControl('Preset', percPresetSel));


      // v018_p02_poly_synth_advanced: advanced synth settings (Synth/Perc layers)
      const advDetails = document.createElement('details');
      advDetails.className = 'rg-poly-adv-details';
      const advSummary = document.createElement('summary');
      advSummary.textContent = 'Advanced synth settings';
      advDetails.appendChild(advSummary);

      const advBody = document.createElement('div');
      advBody.className = 'rg-poly-adv-body';
      advDetails.appendChild(advBody);

      const advHint = document.createElement('div');
      advHint.className = 'rg-poly-inline-note';
      advHint.textContent = 'Leave fields blank to use preset.';
      advBody.appendChild(advHint);

      // ADSR
      const advAdsrControls = document.createElement('div');
      advAdsrControls.className = 'rg-poly-sound-controls';
      advBody.appendChild(advAdsrControls);

      const advAInput = document.createElement('input');
      advAInput.type = 'number';
      advAInput.min = '0.0001';
      advAInput.max = '1';
      advAInput.step = '0.001';
      advAdsrControls.appendChild(mkControl('A', advAInput));

      const advDInput = document.createElement('input');
      advDInput.type = 'number';
      advDInput.min = '0.0001';
      advDInput.max = '2';
      advDInput.step = '0.001';
      advAdsrControls.appendChild(mkControl('D', advDInput));

      const advSInput = document.createElement('input');
      advSInput.type = 'number';
      advSInput.min = '0';
      advSInput.max = '1';
      advSInput.step = '0.01';
      advAdsrControls.appendChild(mkControl('S', advSInput));

      const advRInput = document.createElement('input');
      advRInput.type = 'number';
      advRInput.min = '0.0001';
      advRInput.max = '3';
      advRInput.step = '0.001';
      advAdsrControls.appendChild(mkControl('R', advRInput));

      // Filter
      const advFilterControls = document.createElement('div');
      advFilterControls.className = 'rg-poly-sound-controls';
      advBody.appendChild(advFilterControls);

      const advFilterTypeSel = mkSelect([
        { value: '', label: '(Preset)' },
        { value: 'lowpass', label: 'Lowpass' },
        { value: 'highpass', label: 'Highpass' },
        { value: 'bandpass', label: 'Bandpass' },
        { value: 'notch', label: 'Notch' },
        { value: 'allpass', label: 'Allpass' },
        { value: 'lowshelf', label: 'Low-shelf' },
        { value: 'highshelf', label: 'High-shelf' },
        { value: 'peaking', label: 'Peaking' },
      ]);
      advFilterControls.appendChild(mkControl('Filter', advFilterTypeSel));

      const advFilterCutoffInput = document.createElement('input');
      advFilterCutoffInput.type = 'number';
      advFilterCutoffInput.min = '20';
      advFilterCutoffInput.max = '20000';
      advFilterCutoffInput.step = '1';
      advFilterControls.appendChild(mkControl('Cutoff', advFilterCutoffInput));

      const advFilterQInput = document.createElement('input');
      advFilterQInput.type = 'number';
      advFilterQInput.min = '0.1';
      advFilterQInput.max = '20';
      advFilterQInput.step = '0.1';
      advFilterControls.appendChild(mkControl('Q', advFilterQInput));

      // Detune / Unison / Velocity
      const advMiscControls = document.createElement('div');
      advMiscControls.className = 'rg-poly-sound-controls';
      advBody.appendChild(advMiscControls);

      const advUnisonInput = document.createElement('input');
      advUnisonInput.type = 'number';
      advUnisonInput.min = '1';
      advUnisonInput.max = '4';
      advUnisonInput.step = '1';
      const advUnisonCtl = mkControl('Unison', advUnisonInput);
      advMiscControls.appendChild(advUnisonCtl);

      const advDetuneInput = document.createElement('input');
      advDetuneInput.type = 'number';
      advDetuneInput.min = '0';
      advDetuneInput.max = '100';
      advDetuneInput.step = '0.1';
      const advDetuneCtl = mkControl('Detune (c)', advDetuneInput);
      advMiscControls.appendChild(advDetuneCtl);

      const advVelocityInput = document.createElement('input');
      advVelocityInput.type = 'number';
      advVelocityInput.min = '0';
      advVelocityInput.max = '2';
      advVelocityInput.step = '0.01';
      advMiscControls.appendChild(mkControl('Velocity', advVelocityInput));

      // Per-token overrides (synth hits only)
      const tokenOvrDetails = document.createElement('details');
      tokenOvrDetails.className = 'rg-poly-tokenovr-details';
      const tokenOvrSummary = document.createElement('summary');
      tokenOvrSummary.textContent = 'Per-token overrides (1..12)';
      tokenOvrDetails.appendChild(tokenOvrSummary);

      const tokenOvrBody = document.createElement('div');
      tokenOvrBody.className = 'rg-poly-tokenovr-body';
      tokenOvrDetails.appendChild(tokenOvrBody);

      const tokenOvrNote = document.createElement('div');
      tokenOvrNote.className = 'rg-poly-inline-note';
      tokenOvrNote.textContent = 'Applies to Synth hits only.';
      tokenOvrBody.appendChild(tokenOvrNote);

      const tokenOvrGrid = document.createElement('div');
      tokenOvrGrid.className = 'rg-poly-token-grid';
      tokenOvrBody.appendChild(tokenOvrGrid);

      const tokenOvrUi = [];
      for (let tt = 1; tt <= 12; tt++) {
        const row = document.createElement('div');
        row.className = 'rg-poly-token-row';
        tokenOvrGrid.appendChild(row);

        const lab = document.createElement('div');
        lab.className = 'rg-poly-token-label';
        lab.textContent = 'Token ' + tt;
        row.appendChild(lab);

        const en = document.createElement('input');
        en.type = 'checkbox';
        const enWrap = document.createElement('label');
        enWrap.className = 'rg-poly-check';
        enWrap.appendChild(en);
        enWrap.appendChild(document.createTextNode('Enable'));
        row.appendChild(enWrap);

        const testTokBtn = document.createElement('button');
        testTokBtn.type = 'button';
        testTokBtn.className = 'pill rg-mini';
        testTokBtn.textContent = 'Test ' + tt;
        testTokBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          polyAuditionOverrideTokenNow(tt);
        });
        row.appendChild(testTokBtn);

        const pitchInput = document.createElement('input');
        pitchInput.type = 'number';
        pitchInput.min = '-24';
        pitchInput.max = '24';
        pitchInput.step = '1';
        row.appendChild(mkControl('Pitch', pitchInput));

        const gainInput = document.createElement('input');
        gainInput.type = 'number';
        gainInput.min = '0';
        gainInput.max = '2';
        gainInput.step = '0.01';
        row.appendChild(mkControl('Gain', gainInput));

        const cutoffDeltaInput = document.createElement('input');
        cutoffDeltaInput.type = 'number';
        cutoffDeltaInput.min = '-20000';
        cutoffDeltaInput.max = '20000';
        cutoffDeltaInput.step = '1';
        row.appendChild(mkControl('Cutoff Δ', cutoffDeltaInput));

        const brightInput = document.createElement('input');
        brightInput.type = 'number';
        brightInput.min = '0.1';
        brightInput.max = '4';
        brightInput.step = '0.01';
        row.appendChild(mkControl('Bright', brightInput));

        tokenOvrUi.push({ en, pitchInput, gainInput, cutoffDeltaInput, brightInput });
      }

      soundBody.appendChild(advDetails);
      advBody.appendChild(tokenOvrDetails);

      function ensureAdvObj() {
        if (!layer.synthParamsAdvanced || typeof layer.synthParamsAdvanced !== 'object' || Array.isArray(layer.synthParamsAdvanced)) {
          layer.synthParamsAdvanced = {};
        }
        return layer.synthParamsAdvanced;
      }
      function ensureAdvEnv() {
        const adv = ensureAdvObj();
        if (!adv.env || typeof adv.env !== 'object' || Array.isArray(adv.env)) adv.env = {};
        return adv.env;
      }
      function ensureAdvFilter() {
        const adv = ensureAdvObj();
        if (!adv.filter || typeof adv.filter !== 'object' || Array.isArray(adv.filter)) adv.filter = {};
        return adv.filter;
      }
      function pruneAdv() {
        const adv = ensureAdvObj();
        if (adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env) && !Object.keys(adv.env).length) delete adv.env;
        if (adv.filter && typeof adv.filter === 'object' && !Array.isArray(adv.filter) && !Object.keys(adv.filter).length) delete adv.filter;
      }
      function ensureTokenMap() {
        if (!layer.tokenOverrides || typeof layer.tokenOverrides !== 'object' || Array.isArray(layer.tokenOverrides)) {
          layer.tokenOverrides = {};
        }
        return layer.tokenOverrides;
      }
      function setTokenEnabled(tt, on) {
        const m = ensureTokenMap();
        const k = String(tt);
        if (!on) {
          delete m[k];
          return;
        }
        if (!m[k] || typeof m[k] !== 'object' || Array.isArray(m[k])) m[k] = {};
      }
      function pruneToken(tt) {
        const m = ensureTokenMap();
        const k = String(tt);
        const o = m[k];
        if (o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length) delete m[k];
      }

      function bindAdvNum(inputEl, kind, key, minV, maxV, isInt) {
        function apply() {
          const vStr = String(inputEl.value || '').trim();
          if (!vStr) {
            const adv = ensureAdvObj();
            if (kind === 'env') {
              const e = ensureAdvEnv();
              delete e[key];
              pruneAdv();
            } else if (kind === 'filter') {
              const f = ensureAdvFilter();
              delete f[key];
              pruneAdv();
            } else {
              delete adv[key];
            }
            return;
          }
          const num = Number(vStr);
          if (!Number.isFinite(num)) return;
          const adv = ensureAdvObj();
          if (kind === 'env') {
            const e = ensureAdvEnv();
            e[key] = clamp(isInt ? Math.round(num) : num, minV, maxV);
            pruneAdv();
          } else if (kind === 'filter') {
            const f = ensureAdvFilter();
            f[key] = clamp(isInt ? Math.round(num) : num, minV, maxV);
            pruneAdv();
          } else {
            adv[key] = clamp(isInt ? Math.round(num) : num, minV, maxV);
          }
        }
        inputEl.addEventListener('input', () => {
          apply();
          savePolyrhythmToLS();
        });
        inputEl.addEventListener('change', () => {
          apply();
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });
      }

      // Bind ADSR
      bindAdvNum(advAInput, 'env', 'a', 0.0001, 1.0, false);
      bindAdvNum(advDInput, 'env', 'd', 0.0001, 2.0, false);
      bindAdvNum(advSInput, 'env', 's', 0.0, 1.0, false);
      bindAdvNum(advRInput, 'env', 'r', 0.0001, 3.0, false);

      // Bind filter params (type handled separately)
      bindAdvNum(advFilterCutoffInput, 'filter', 'cutoffHz', 20, 20000, false);
      bindAdvNum(advFilterQInput, 'filter', 'Q', 0.1, 20, false);

      advFilterTypeSel.addEventListener('change', () => {
        const v = String(advFilterTypeSel.value || '').trim();
        const adv = ensureAdvObj();
        if (!v) {
          if (adv.filter && typeof adv.filter === 'object' && !Array.isArray(adv.filter)) {
            delete adv.filter.type;
            pruneAdv();
          }
        } else {
          const f = ensureAdvFilter();
          f.type = v;
          pruneAdv();
        }
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      // Bind misc
      bindAdvNum(advUnisonInput, 'misc', 'unison', 1, 4, true);
      bindAdvNum(advDetuneInput, 'misc', 'detuneCents', 0, 100, false);
      bindAdvNum(advVelocityInput, 'misc', 'velocity', 0, 2, false);

      // Token override bindings
      for (let ti = 0; ti < tokenOvrUi.length; ti++) {
        const tt = ti + 1;
        const uiT = tokenOvrUi[ti];

        function setDisabled(on) {
          const dis = !on;
          uiT.pitchInput.disabled = dis;
          uiT.gainInput.disabled = dis;
          uiT.cutoffDeltaInput.disabled = dis;
          uiT.brightInput.disabled = dis;
        }

        uiT.en.addEventListener('change', () => {
          const on = !!uiT.en.checked;
          setTokenEnabled(tt, on);
          if (!on) {
            uiT.pitchInput.value = '';
            uiT.gainInput.value = '';
            uiT.cutoffDeltaInput.value = '';
            uiT.brightInput.value = '';
          }
          setDisabled(on);
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });

        function bindTokNum(inputEl, key, minV, maxV, isInt, omitDefault1) {
          function apply() {
            if (!uiT.en.checked) return;
            const vStr = String(inputEl.value || '').trim();
            const m = ensureTokenMap();
            const kTok = String(tt);
            if (!m[kTok] || typeof m[kTok] !== 'object' || Array.isArray(m[kTok])) m[kTok] = {};
            const o = m[kTok];

            if (!vStr) {
              delete o[key];
              pruneToken(tt);
              return;
            }
            const num = Number(vStr);
            if (!Number.isFinite(num)) return;
            const vv = clamp(isInt ? Math.round(num) : num, minV, maxV);
            if (omitDefault1 && Math.abs(vv - 1) < 1e-6) {
              delete o[key];
              pruneToken(tt);
              return;
            }
            o[key] = vv;
            pruneToken(tt);
          }

          inputEl.addEventListener('input', () => {
            apply();
            savePolyrhythmToLS();
          });
          inputEl.addEventListener('change', () => {
            apply();
            savePolyrhythmToLS();
            polyResyncActiveNow();
            syncPolyrhythmUI();
          });
        }

        bindTokNum(uiT.pitchInput, 'pitchSemis', -24, 24, true, false);
        bindTokNum(uiT.gainInput, 'gain', 0, 2, false, true);
        bindTokNum(uiT.cutoffDeltaInput, 'cutoffDeltaHz', -20000, 20000, false, false);
        bindTokNum(uiT.brightInput, 'brightness', 0.1, 4, false, true);

        // initial disabled (sync will set checked)
        setDisabled(false);
      }

      const soundCustomWrap = document.createElement('div');
      soundCustomWrap.className = 'rg-poly-sound-custom';
      soundBody.appendChild(soundCustomWrap);

      const soundCustomControls = document.createElement('div');
      soundCustomControls.className = 'rg-poly-sound-controls';
      soundCustomWrap.appendChild(soundCustomControls);

      // Layer pitch
      const soundTransposeInput = document.createElement('input');
      soundTransposeInput.type = 'number';
      soundTransposeInput.min = '-24';
      soundTransposeInput.max = '24';
      soundTransposeInput.step = '1';
      soundCustomControls.appendChild(mkControl('Transpose (semis)', soundTransposeInput));

      // Layer timbre (0..1)
      function mkPolyRange01() {
        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '1';
        range.step = '0.01';
        const val = document.createElement('span');
        val.className = 'rg-poly-range-val';
        const wrap = document.createElement('div');
        wrap.className = 'rg-poly-range-wrap';
        wrap.appendChild(range);
        wrap.appendChild(val);
        return { wrap, range, val };
      }

      const rlCtl = mkPolyRange01();
      const brCtl = mkPolyRange01();
      const hdCtl = mkPolyRange01();
      soundCustomControls.appendChild(mkControl('Ring length', rlCtl.wrap));
      soundCustomControls.appendChild(mkControl('Brightness', brCtl.wrap));
      soundCustomControls.appendChild(mkControl('Strike hardness', hdCtl.wrap));

      // Layer chords
      const soundChordsEnabled = document.createElement('input');
      soundChordsEnabled.type = 'checkbox';
      const soundChordsEnabledWrap = document.createElement('label');
      soundChordsEnabledWrap.className = 'rg-poly-check';
      soundChordsEnabledWrap.appendChild(soundChordsEnabled);
      soundChordsEnabledWrap.appendChild(document.createTextNode('Enabled'));
      soundCustomControls.appendChild(mkControl('Chords', soundChordsEnabledWrap));

      const layerChordOpts = (typeof GLOBAL_CHORD_PRESET_ORDER !== 'undefined' && Array.isArray(GLOBAL_CHORD_PRESET_ORDER))
        ? GLOBAL_CHORD_PRESET_ORDER.map(k => ({ value: k, label: chordPresetLabel(k) }))
        : [{ value: 'unison', label: 'Unison' }];

      const soundChordsPresetSel = mkSelect(layerChordOpts);
      soundCustomControls.appendChild(mkControl('Chord preset', soundChordsPresetSel));

      const soundChordsIntervalsInput = document.createElement('input');
      soundChordsIntervalsInput.type = 'text';
      soundChordsIntervalsInput.placeholder = '0 4 7 (optional)';
      soundCustomControls.appendChild(mkControl('Custom intervals', soundChordsIntervalsInput));

      // Nested advanced section (per-bell overrides)
      const soundAdvDetails = document.createElement('details');
      soundAdvDetails.className = 'rg-poly-sound-advanced';
      soundCustomWrap.appendChild(soundAdvDetails);

      const soundAdvSummary = document.createElement('summary');
      soundAdvSummary.textContent = 'Per-bell overrides (Advanced)';
      soundAdvDetails.appendChild(soundAdvSummary);

      const soundAdvBody = document.createElement('div');
      soundAdvBody.className = 'rg-poly-perbell-body';
      soundAdvDetails.appendChild(soundAdvBody);

      const advNote = document.createElement('div');
      advNote.className = 'rg-poly-inline-note';
      advNote.textContent = 'Overrides apply only to this polyrhythm layer.';
      soundAdvBody.appendChild(advNote);

      const perBellUi = {};

      function ensureLayerBellSound() {
        layer.bellSound = sanitizePolyBellSound(layer.bellSound);
        if (!layer.bellSound.perBell || typeof layer.bellSound.perBell !== 'object') layer.bellSound.perBell = {};
        return layer.bellSound;
      }

      function ensureLayerPerBellEntry(bellNum) {
        const bs = ensureLayerBellSound();
        const k = String(bellNum);
        if (!bs.perBell[k] || typeof bs.perBell[k] !== 'object') bs.perBell[k] = {};
        return bs.perBell[k];
      }

      function cleanupLayerPerBellEntry(bellNum) {
        const bs = ensureLayerBellSound();
        const k = String(bellNum);
        const e = bs.perBell[k];
        if (!e) return;
        if (!e.pitch && !e.timbre && !e.chords) delete bs.perBell[k];
      }

      function mkPerBellGroup(titleText) {
        const g = document.createElement('div');
        g.className = 'rg-poly-perbell-group';

        const head = document.createElement('label');
        head.className = 'rg-poly-perbell-group-head';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        head.appendChild(cb);
        head.appendChild(document.createTextNode(titleText));
        g.appendChild(head);

        const body = document.createElement('div');
        body.className = 'rg-poly-perbell-group-body';
        g.appendChild(body);

        body.style.display = 'none';
        cb.addEventListener('change', () => {
          body.style.display = cb.checked ? '' : 'none';
        });

        return { g, cb, body };
      }

      for (let b = 1; b <= 12; b++) {
        const row = document.createElement('div');
        row.className = 'rg-poly-perbell-row';
        soundAdvBody.appendChild(row);

        const head = document.createElement('div');
        head.className = 'rg-poly-perbell-head';
        row.appendChild(head);

        const title = document.createElement('div');
        title.className = 'rg-poly-perbell-title';
        title.textContent = 'Bell ' + b;
        head.appendChild(title);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'pill';
        clearBtn.type = 'button';
        clearBtn.textContent = 'Clear';
        head.appendChild(clearBtn);

        const rowCtrls = document.createElement('div');
        rowCtrls.className = 'rg-poly-perbell-controls';
        row.appendChild(rowCtrls);

        // Pitch override
        const pitchG = mkPerBellGroup('Pitch');
        const pitchSemis = document.createElement('input');
        pitchSemis.type = 'number';
        pitchSemis.min = '-24';
        pitchSemis.max = '24';
        pitchSemis.step = '1';
        pitchSemis.title = 'Transpose semis';
        const pitchHz = document.createElement('input');
        pitchHz.type = 'number';
        pitchHz.min = '1';
        pitchHz.step = '0.01';
        pitchHz.placeholder = 'Hz (optional)';
        pitchHz.title = 'Hz override (optional)';
        pitchG.body.appendChild(pitchSemis);
        pitchG.body.appendChild(pitchHz);
        rowCtrls.appendChild(pitchG.g);

        // Timbre override
        const timbreG = mkPerBellGroup('Timbre');
        const timbreRL = document.createElement('input');
        timbreRL.type = 'number';
        timbreRL.min = '0';
        timbreRL.max = '1';
        timbreRL.step = '0.01';
        timbreRL.placeholder = 'Ring';
        const timbreBR = document.createElement('input');
        timbreBR.type = 'number';
        timbreBR.min = '0';
        timbreBR.max = '1';
        timbreBR.step = '0.01';
        timbreBR.placeholder = 'Bright';
        const timbreHD = document.createElement('input');
        timbreHD.type = 'number';
        timbreHD.min = '0';
        timbreHD.max = '1';
        timbreHD.step = '0.01';
        timbreHD.placeholder = 'Hard';
        timbreG.body.appendChild(timbreRL);
        timbreG.body.appendChild(timbreBR);
        timbreG.body.appendChild(timbreHD);
        rowCtrls.appendChild(timbreG.g);

        // Chord override
        const chordG = mkPerBellGroup('Chord');
        const chordEnabled = document.createElement('input');
        chordEnabled.type = 'checkbox';
        const chordEnabledWrap = document.createElement('label');
        chordEnabledWrap.className = 'rg-poly-check';
        chordEnabledWrap.appendChild(chordEnabled);
        chordEnabledWrap.appendChild(document.createTextNode('Enabled'));
        chordG.body.appendChild(chordEnabledWrap);

        const chordPresetSel = mkSelect(layerChordOpts);
        chordG.body.appendChild(chordPresetSel);

        const chordIntervals = document.createElement('input');
        chordIntervals.type = 'text';
        chordIntervals.placeholder = '0 4 7 (optional)';
        chordG.body.appendChild(chordIntervals);
        rowCtrls.appendChild(chordG.g);

        // Data wiring
        clearBtn.addEventListener('click', () => {
          const bs = ensureLayerBellSound();
          const k = String(b);
          if (bs.perBell && bs.perBell[k]) delete bs.perBell[k];
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });

        pitchG.cb.addEventListener('change', () => {
          const bs = ensureLayerBellSound();
          const k = String(b);
          if (pitchG.cb.checked) {
            const e = ensureLayerPerBellEntry(b);
            if (!e.pitch) e.pitch = { transposeSemis: 0, hz: null };
          } else {
            const e = bs.perBell[k];
            if (e && e.pitch) delete e.pitch;
            cleanupLayerPerBellEntry(b);
          }
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });

        pitchSemis.addEventListener('input', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.pitch) e.pitch = { transposeSemis: 0, hz: null };
          e.pitch.transposeSemis = clamp(parseInt(pitchSemis.value, 10) || 0, -24, 24);
          savePolyrhythmToLS();
        });
        pitchSemis.addEventListener('change', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.pitch) e.pitch = { transposeSemis: 0, hz: null };
          e.pitch.transposeSemis = clamp(parseInt(pitchSemis.value, 10) || 0, -24, 24);
          savePolyrhythmToLS();
          polyResyncActiveNow();
        });

        pitchHz.addEventListener('input', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.pitch) e.pitch = { transposeSemis: 0, hz: null };
          const v = String(pitchHz.value || '').trim();
          const n = v ? Number(v) : NaN;
          e.pitch.hz = (Number.isFinite(n) && n > 0) ? n : null;
          savePolyrhythmToLS();
        });
        pitchHz.addEventListener('change', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.pitch) e.pitch = { transposeSemis: 0, hz: null };
          const v = String(pitchHz.value || '').trim();
          const n = v ? Number(v) : NaN;
          e.pitch.hz = (Number.isFinite(n) && n > 0) ? n : null;
          savePolyrhythmToLS();
          polyResyncActiveNow();
        });

        timbreG.cb.addEventListener('change', () => {
          const bs = ensureLayerBellSound();
          const k = String(b);
          if (timbreG.cb.checked) {
            const e = ensureLayerPerBellEntry(b);
            if (!e.timbre) e.timbre = {
              ringLength01: bs.timbre.ringLength01,
              brightness01: bs.timbre.brightness01,
              strikeHardness01: bs.timbre.strikeHardness01,
            };
          } else {
            const e = bs.perBell[k];
            if (e && e.timbre) delete e.timbre;
            cleanupLayerPerBellEntry(b);
          }
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });

        function timbreInputSync() {
          const e = ensureLayerPerBellEntry(b);
          if (!e.timbre) e.timbre = {};
          const rl = Number(timbreRL.value);
          const br = Number(timbreBR.value);
          const hd = Number(timbreHD.value);
          e.timbre.ringLength01 = Number.isFinite(rl) ? clamp(rl, 0, 1) : e.timbre.ringLength01;
          e.timbre.brightness01 = Number.isFinite(br) ? clamp(br, 0, 1) : e.timbre.brightness01;
          e.timbre.strikeHardness01 = Number.isFinite(hd) ? clamp(hd, 0, 1) : e.timbre.strikeHardness01;
        }

        timbreRL.addEventListener('input', () => { timbreInputSync(); savePolyrhythmToLS(); });
        timbreBR.addEventListener('input', () => { timbreInputSync(); savePolyrhythmToLS(); });
        timbreHD.addEventListener('input', () => { timbreInputSync(); savePolyrhythmToLS(); });

        timbreRL.addEventListener('change', () => { timbreInputSync(); savePolyrhythmToLS(); polyResyncActiveNow(); });
        timbreBR.addEventListener('change', () => { timbreInputSync(); savePolyrhythmToLS(); polyResyncActiveNow(); });
        timbreHD.addEventListener('change', () => { timbreInputSync(); savePolyrhythmToLS(); polyResyncActiveNow(); });

        chordG.cb.addEventListener('change', () => {
          const bs = ensureLayerBellSound();
          const k = String(b);
          if (chordG.cb.checked) {
            const e = ensureLayerPerBellEntry(b);
            if (!e.chords) e.chords = {
              enabled: true,
              preset: bs.chords.preset || 'unison',
              customIntervals: String(bs.chords.customIntervals || ''),
              _intervals: (bs.chords._intervals && bs.chords._intervals.length) ? bs.chords._intervals.slice(0, 6) : null,
            };
          } else {
            const e = bs.perBell[k];
            if (e && e.chords) delete e.chords;
            cleanupLayerPerBellEntry(b);
          }
          savePolyrhythmToLS();
          polyResyncActiveNow();
          syncPolyrhythmUI();
        });

        chordEnabled.addEventListener('change', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.chords) e.chords = { enabled: true, preset: 'unison', customIntervals: '', _intervals: null };
          e.chords.enabled = !!chordEnabled.checked;
          savePolyrhythmToLS();
          polyResyncActiveNow();
        });

        chordPresetSel.addEventListener('change', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.chords) e.chords = { enabled: true, preset: 'unison', customIntervals: '', _intervals: null };
          e.chords.preset = String(chordPresetSel.value || 'unison');
          savePolyrhythmToLS();
          polyResyncActiveNow();
        });

        chordIntervals.addEventListener('input', () => {
          const e = ensureLayerPerBellEntry(b);
          if (!e.chords) e.chords = { enabled: true, preset: 'unison', customIntervals: '', _intervals: null };
          e.chords.customIntervals = String(chordIntervals.value || '');
          const t = String(e.chords.customIntervals || '').trim();
          if (t) {
            const parsed = parseCustomChordIntervalsText(t, 6);
            e.chords._intervals = (parsed && parsed.ok && parsed.vals && parsed.vals.length) ? parsed.vals.slice(0, 6) : null;
          } else {
            e.chords._intervals = null;
          }
          savePolyrhythmToLS();
        });
        chordIntervals.addEventListener('change', () => {
          savePolyrhythmToLS();
          polyResyncActiveNow();
        });

        perBellUi[b] = {
          clearBtn,
          pitchToggle: pitchG.cb,
          pitchBody: pitchG.body,
          pitchSemis,
          pitchHz,
          timbreToggle: timbreG.cb,
          timbreBody: timbreG.body,
          timbreRL,
          timbreBR,
          timbreHD,
          chordToggle: chordG.cb,
          chordBody: chordG.body,
          chordEnabled,
          chordPresetSel,
          chordIntervals,
        };
      }

      soundProfileSel.addEventListener('change', () => {
        ensureLayerBellSound();
        layer.bellSound.profile = (soundProfileSel.value === 'custom') ? 'custom' : 'mirror';
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      // v018_p01_poly_synth_core: synth/perc controls
      synthPresetSel.addEventListener('change', () => {
        layer.synthPreset = String(synthPresetSel.value || 'tone_sine');
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      pitchSourceSel.addEventListener('change', () => {
        layer.pitchSource = String(pitchSourceSel.value || 'bell12');
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      pitchBaseInput.addEventListener('change', () => {
        layer.pitchBase = clamp(parseInt(String(pitchBaseInput.value ?? 60), 10) || 60, 0, 127);
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      pitchHzInput.addEventListener('change', () => {
        const v = String(pitchHzInput.value || '').trim();
        layer.pitchHz = v ? ((Number.isFinite(Number(v)) && Number(v) > 0) ? Number(v) : null) : null;
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      percPresetSel.addEventListener('change', () => {
        layer.percPreset = String(percPresetSel.value || 'noise_hat');
        savePolyrhythmToLS();
        polyResyncActiveNow();
        syncPolyrhythmUI();
      });

      soundTransposeInput.addEventListener('input', () => {
        ensureLayerBellSound();
        layer.bellSound.pitch.layerTransposeSemis = clamp(parseInt(soundTransposeInput.value, 10) || 0, -24, 24);
        savePolyrhythmToLS();
      });
      soundTransposeInput.addEventListener('change', () => {
        ensureLayerBellSound();
        layer.bellSound.pitch.layerTransposeSemis = clamp(parseInt(soundTransposeInput.value, 10) || 0, -24, 24);
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });

      function syncLayerTimbreFromRanges() {
        ensureLayerBellSound();
        layer.bellSound.timbre.ringLength01 = clamp(Number(rlCtl.range.value) || 0, 0, 1);
        layer.bellSound.timbre.brightness01 = clamp(Number(brCtl.range.value) || 0, 0, 1);
        layer.bellSound.timbre.strikeHardness01 = clamp(Number(hdCtl.range.value) || 0, 0, 1);
        rlCtl.val.textContent = fmtDepth2(layer.bellSound.timbre.ringLength01);
        brCtl.val.textContent = fmtDepth2(layer.bellSound.timbre.brightness01);
        hdCtl.val.textContent = fmtDepth2(layer.bellSound.timbre.strikeHardness01);
      }

      rlCtl.range.addEventListener('input', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); });
      brCtl.range.addEventListener('input', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); });
      hdCtl.range.addEventListener('input', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); });

      rlCtl.range.addEventListener('change', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); polyResyncActiveNow(); });
      brCtl.range.addEventListener('change', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); polyResyncActiveNow(); });
      hdCtl.range.addEventListener('change', () => { syncLayerTimbreFromRanges(); savePolyrhythmToLS(); polyResyncActiveNow(); });

      soundChordsEnabled.addEventListener('change', () => {
        ensureLayerBellSound();
        layer.bellSound.chords.enabled = !!soundChordsEnabled.checked;
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });

      soundChordsPresetSel.addEventListener('change', () => {
        ensureLayerBellSound();
        layer.bellSound.chords.preset = String(soundChordsPresetSel.value || 'unison');
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });

      soundChordsIntervalsInput.addEventListener('input', () => {
        ensureLayerBellSound();
        layer.bellSound.chords.customIntervals = String(soundChordsIntervalsInput.value || '');
        const t = String(layer.bellSound.chords.customIntervals || '').trim();
        if (t) {
          const parsed = parseCustomChordIntervalsText(t, 6);
          layer.bellSound.chords._intervals = (parsed && parsed.ok && parsed.vals && parsed.vals.length) ? parsed.vals.slice(0, 6) : null;
        } else {
          layer.bellSound.chords._intervals = null;
        }
        savePolyrhythmToLS();
      });

      soundChordsIntervalsInput.addEventListener('change', () => {
        savePolyrhythmToLS();
        polyResyncActiveNow();
      });

      const methodNote = document.createElement('div');
      methodNote.className = 'rg-poly-inline-note';
      methodNote.textContent = 'Uses current method rows (loops).';
      card.appendChild(methodNote);

      P.layerUiById[layer.id] = {
        card, enabled, typeSel, soundSel, intervalSel, offsetSel, volRange, testCtl, testArea, testTickBtn, testPercBtn, testKbWrap, testKbBtns,
        tokenSel, phraseInput, tokenCtl, phraseCtl, methodNote,
        soundDetails, soundProfileSel, soundBadge, soundCustomWrap,
        // v018_p01_poly_synth_core
        soundBellControls: soundControls, soundProfileCtl,
        soundSynthControls, synthPresetSel, pitchSourceSel, pitchBaseCtl, pitchBaseInput, pitchHzCtl, pitchHzInput,
        soundPercControls, percPresetSel,
        soundTransposeInput,
        soundRingLengthRange: rlCtl.range, soundRingLengthValue: rlCtl.val,
        soundBrightnessRange: brCtl.range, soundBrightnessValue: brCtl.val,
        soundStrikeHardnessRange: hdCtl.range, soundStrikeHardnessValue: hdCtl.val,
        soundChordsEnabled, soundChordsPresetSel, soundChordsIntervalsInput,
        soundAdvDetails, perBellUi,
      };
    }

    savePolyrhythmToLS();
    syncPolyrhythmUI();
  }

  function syncPolyrhythmUI() {
    if (!ui.poly) return;
    const P = ui.poly;

    function setVisible(el, on) {
      if (!el) return;
      el.style.display = on ? '' : 'none';
    }

    const en = !!state.polyEnabledForRuns;
    if (P.enabledBtn) {
      P.enabledBtn.textContent = en ? 'On' : 'Off';
      P.enabledBtn.setAttribute('aria-pressed', en ? 'true' : 'false');
    }

    if (P.masterVol) P.masterVol.value = String(clamp(Number(state.polyMasterVolume) || 0, 0, 100));
    applyPolyMasterGain();

    if (P.testBtn) {
      P.testBtn.textContent = polyTestActive ? 'Stop' : 'Test';
      // Only allow Test while idle (Stop always allowed)
      if (!polyTestActive) P.testBtn.disabled = state.phase !== 'idle';
      else P.testBtn.disabled = false;
    }

    const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const lu = P.layerUiById ? P.layerUiById[layer.id] : null;
      if (!lu) continue;

      const enabled = layer.enabled !== false;
      lu.enabled.textContent = enabled ? 'Mute' : 'Muted';
      lu.enabled.setAttribute('aria-pressed', enabled ? 'true' : 'false');

      lu.typeSel.value = layer.type;
      lu.soundSel.value = layer.sound;
      lu.intervalSel.value = layer.interval;

      // Ensure offset list is compatible with interval
      const opts = polyOffsetOptionsForInterval(layer.interval);
      if (!opts.some(o => o.value === layer.offset)) layer.offset = '0';
      if (lu.offsetSel.value !== layer.offset) lu.offsetSel.value = layer.offset;

      lu.volRange.value = String(clamp(Number(layer.volume) || 0, 0, 100));
      lu.tokenSel.value = String(clamp(parseInt(layer.token, 10) || 1, 1, 12));
      lu.phraseInput.value = String(layer.phrase || '');

      const isPulse = layer.type === 'pulse';
      const isPhrase = layer.type === 'phrase';
      const isMethod = layer.type === 'method_current';

      setVisible(lu.tokenCtl, isPulse);
      setVisible(lu.phraseCtl, isPhrase);
      setVisible(lu.methodNote, isMethod);
      // v017_p02_polyrhythm_layer_sound: per-layer sound UI (Bell/Synth/Perc)
      const isBell = (layer.sound === 'bell');
      const isSynth = (layer.sound === 'synth');
      const isPerc = (layer.sound === 'perc');
      const isTick = (layer.sound === 'tick');
      setVisible(lu.testTickBtn, isTick);
      setVisible(lu.testPercBtn, isPerc);
      setVisible(lu.testKbWrap, (isBell || isSynth));
      const hasSoundDetails = (isBell || isSynth || isPerc);
      setVisible(lu.soundDetails, hasSoundDetails);
      setVisible(lu.soundBellControls, isBell);
      setVisible(lu.soundSynthControls, isSynth);
      setVisible(lu.soundPercControls, isPerc);
      setVisible(lu.advDetails, (isSynth || isPerc));
      setVisible(lu.advDetuneCtl, isSynth);
      setVisible(lu.advUnisonCtl, isSynth);
      setVisible(lu.tokenOvrDetails, isSynth);
      if (!isBell) setVisible(lu.soundCustomWrap, false);

      if (isSynth) {
        // Defaults (do not auto-start)
        if (layer.pitchSource == null) layer.pitchSource = 'bell12';
        if (layer.pitchBase == null) layer.pitchBase = 60;
        if (layer.synthPreset == null) layer.synthPreset = 'tone_sine';

        if (lu.synthPresetSel) {
          try { lu.synthPresetSel.value = String(layer.synthPreset || 'tone_sine'); } catch (_) {}
        }
        if (lu.pitchSourceSel) {
          try { lu.pitchSourceSel.value = String(layer.pitchSource || 'bell12'); } catch (_) {}
        }
        if (lu.pitchBaseInput) {
          lu.pitchBaseInput.value = String(clamp(parseInt(String(layer.pitchBase ?? 60), 10) || 60, 0, 127));
        }
        if (lu.pitchHzInput) {
          lu.pitchHzInput.value = (layer.pitchHz != null) ? String(layer.pitchHz) : '';
        }

        const ps = String(layer.pitchSource || 'bell12');
        setVisible(lu.pitchBaseCtl, ps !== 'bell12');
        setVisible(lu.pitchHzCtl, ps === 'fixed');

        if (lu.soundBadge) {
          const lab = (lu.synthPresetSel && lu.synthPresetSel.selectedOptions && lu.synthPresetSel.selectedOptions[0]) ? String(lu.synthPresetSel.selectedOptions[0].textContent || '').trim() : '';
          lu.soundBadge.textContent = lab ? ('Synth: ' + lab) : 'Synth';
        }
      } else if (isPerc) {
        if (layer.percPreset == null) layer.percPreset = 'noise_hat';
        if (lu.percPresetSel) {
          try { lu.percPresetSel.value = String(layer.percPreset || 'noise_hat'); } catch (_) {}
        }
        if (lu.soundBadge) {
          const lab = (lu.percPresetSel && lu.percPresetSel.selectedOptions && lu.percPresetSel.selectedOptions[0]) ? String(lu.percPresetSel.selectedOptions[0].textContent || '').trim() : '';
          lu.soundBadge.textContent = lab ? ('Perc: ' + lab) : 'Perc';
        }


      // v018_p02_poly_synth_advanced: sync UI values for advanced synth settings
      if (isSynth || isPerc) {
        if (!layer.synthParamsAdvanced || typeof layer.synthParamsAdvanced !== 'object' || Array.isArray(layer.synthParamsAdvanced)) {
          layer.synthParamsAdvanced = {};
        }
        const adv = layer.synthParamsAdvanced;
        const env = (adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)) ? adv.env : {};
        const filt = (adv.filter && typeof adv.filter === 'object' && !Array.isArray(adv.filter)) ? adv.filter : {};

        if (lu.advAInput) lu.advAInput.value = (env.a != null) ? String(env.a) : '';
        if (lu.advDInput) lu.advDInput.value = (env.d != null) ? String(env.d) : '';
        if (lu.advSInput) lu.advSInput.value = (env.s != null) ? String(env.s) : '';
        if (lu.advRInput) lu.advRInput.value = (env.r != null) ? String(env.r) : '';

        if (lu.advFilterTypeSel) {
          const t = (filt.type != null) ? String(filt.type || '').trim() : '';
          lu.advFilterTypeSel.value = t || '';
        }
        if (lu.advFilterCutoffInput) lu.advFilterCutoffInput.value = (filt.cutoffHz != null) ? String(filt.cutoffHz) : '';
        if (lu.advFilterQInput) lu.advFilterQInput.value = (filt.Q != null) ? String(filt.Q) : '';

        if (lu.advUnisonInput) lu.advUnisonInput.value = (adv.unison != null) ? String(adv.unison) : '';
        if (lu.advDetuneInput) lu.advDetuneInput.value = (adv.detuneCents != null) ? String(adv.detuneCents) : '';
        if (lu.advVelocityInput) lu.advVelocityInput.value = (adv.velocity != null) ? String(adv.velocity) : '';

        // Per-token overrides (synth hits only)
        if (isSynth && lu.tokenOvrUi && Array.isArray(lu.tokenOvrUi)) {
          if (!layer.tokenOverrides || typeof layer.tokenOverrides !== 'object' || Array.isArray(layer.tokenOverrides)) {
            layer.tokenOverrides = {};
          }
          const m = layer.tokenOverrides;
          for (let tt = 1; tt <= 12 && tt <= lu.tokenOvrUi.length; tt++) {
            const uiT = lu.tokenOvrUi[tt - 1];
            if (!uiT) continue;

            const o = (m[String(tt)] && typeof m[String(tt)] === 'object') ? m[String(tt)] : null;
            const on = !!o;

            uiT.en.checked = on;
            uiT.pitchInput.disabled = !on;
            uiT.gainInput.disabled = !on;
            uiT.cutoffDeltaInput.disabled = !on;
            uiT.brightInput.disabled = !on;

            uiT.pitchInput.value = (o && o.pitchSemis != null) ? String(o.pitchSemis) : '';
            uiT.gainInput.value = (o && o.gain != null) ? String(o.gain) : '';
            uiT.cutoffDeltaInput.value = (o && o.cutoffDeltaHz != null) ? String(o.cutoffDeltaHz) : '';
            uiT.brightInput.value = (o && o.brightness != null) ? String(o.brightness) : '';
          }
        }
      }

      }

      if (isBell && lu.soundProfileSel) {
        layer.bellSound = sanitizePolyBellSound(layer.bellSound);
        const bs = layer.bellSound;

        lu.soundProfileSel.value = (bs.profile === 'custom') ? 'custom' : 'mirror';
        if (lu.soundBadge) lu.soundBadge.textContent = (bs.profile === 'custom') ? 'Custom' : 'Mirror Base';

        const isCustom = (bs.profile === 'custom');
        setVisible(lu.soundCustomWrap, isCustom);

        if (lu.soundTransposeInput) {
          lu.soundTransposeInput.value = String(clamp(parseInt(bs.pitch.layerTransposeSemis, 10) || 0, -24, 24));
        }

        if (lu.soundRingLengthRange) {
          const v = clamp(Number(bs.timbre.ringLength01) || 0, 0, 1);
          lu.soundRingLengthRange.value = String(v);
          if (lu.soundRingLengthValue) lu.soundRingLengthValue.textContent = fmtDepth2(v);
        }
        if (lu.soundBrightnessRange) {
          const v = clamp(Number(bs.timbre.brightness01) || 0, 0, 1);
          lu.soundBrightnessRange.value = String(v);
          if (lu.soundBrightnessValue) lu.soundBrightnessValue.textContent = fmtDepth2(v);
        }
        if (lu.soundStrikeHardnessRange) {
          const v = clamp(Number(bs.timbre.strikeHardness01) || 0, 0, 1);
          lu.soundStrikeHardnessRange.value = String(v);
          if (lu.soundStrikeHardnessValue) lu.soundStrikeHardnessValue.textContent = fmtDepth2(v);
        }

        if (lu.soundChordsEnabled) lu.soundChordsEnabled.checked = !!bs.chords.enabled;
        if (lu.soundChordsPresetSel) lu.soundChordsPresetSel.value = String(bs.chords.preset || 'unison');
        if (lu.soundChordsIntervalsInput) lu.soundChordsIntervalsInput.value = String(bs.chords.customIntervals || '');

        const pb = (bs.perBell && typeof bs.perBell === 'object') ? bs.perBell : {};
        if (lu.perBellUi && typeof lu.perBellUi === 'object') {
          for (let b = 1; b <= 12; b++) {
            const ui = lu.perBellUi[b];
            if (!ui) continue;
            const ent = pb[String(b)] || null;

            const hasPitch = !!(ent && ent.pitch);
            ui.pitchToggle.checked = hasPitch;
            ui.pitchBody.style.display = hasPitch ? '' : 'none';
            ui.pitchSemis.value = hasPitch ? String(clamp(parseInt(ent.pitch.transposeSemis, 10) || 0, -24, 24)) : '0';
            ui.pitchHz.value = (hasPitch && ent.pitch.hz != null) ? String(ent.pitch.hz) : '';

            const hasTimbre = !!(ent && ent.timbre);
            ui.timbreToggle.checked = hasTimbre;
            ui.timbreBody.style.display = hasTimbre ? '' : 'none';
            ui.timbreRL.value = hasTimbre ? String((ent.timbre.ringLength01 != null) ? ent.timbre.ringLength01 : bs.timbre.ringLength01) : '';
            ui.timbreBR.value = hasTimbre ? String((ent.timbre.brightness01 != null) ? ent.timbre.brightness01 : bs.timbre.brightness01) : '';
            ui.timbreHD.value = hasTimbre ? String((ent.timbre.strikeHardness01 != null) ? ent.timbre.strikeHardness01 : bs.timbre.strikeHardness01) : '';

            const hasChord = !!(ent && ent.chords);
            ui.chordToggle.checked = hasChord;
            ui.chordBody.style.display = hasChord ? '' : 'none';
            ui.chordEnabled.checked = hasChord ? !!ent.chords.enabled : true;
            ui.chordPresetSel.value = hasChord ? String(ent.chords.preset || 'unison') : String(bs.chords.preset || 'unison');
            ui.chordIntervals.value = hasChord ? String(ent.chords.customIntervals || '') : '';
          }
        }
      }
    }
  }



// v014_p045b_spatial_depth_and_send
function syncSpatialDepthModeUI() {
  if (!spatialDepthModeSelect) return;
  const m = sanitizeSpatialDepthMode(state.spatialDepthMode);
  state.spatialDepthMode = m;
  try { spatialDepthModeSelect.value = m; } catch (_) {}
}

function applySpatialDepthModeToAudio() {
  // Bells
  if (audioCtx && bellDepthStages) {
    for (let b = 1; b <= 12; b++) {
      try { applyBellDepthToAudio(b, false); } catch (_) {}
    }
  }

  // Drones
  try {
    if (audioCtx && droneLayerCurrents) {
      const layers = state.droneLayers || [];
      for (let i = 0; i < droneLayerCurrents.length; i++) {
        const cur = droneLayerCurrents[i];
        if (!cur || !cur.depthStage) continue;
        const d = clamp(Number((layers[i] && layers[i].depth) || 0), 0, 1);
        applyDepthOnStage(cur.depthStage, d, state.spatialDepthMode, false);
      }
    }
  } catch (_) {}
}


function fxSetParam(param, value, timeConstant, instant) {
  if (!audioCtx || !param) return;
  const now = audioCtx.currentTime;
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  const tc = Math.max(0.000001, Number(timeConstant) || 0.02);
  try {
    param.cancelScheduledValues(now);
    if (instant) {
      param.setValueAtTime(v, now);
    } else {
      param.setTargetAtTime(v, now, tc);
    }
  } catch (_) {
    try { param.value = v; } catch (_) {}
  }
}

function limiterThresholdDb(amount) {
  const a = clamp(Number(amount) || 0, 0, 1);
  return -2.0 - (a * 7.0); // -2 .. -9 dB
}

function applyMasterLimiterParams(instant) {
  if (!audioCtx || !masterLimiter) return;
  fxSetParam(masterLimiter.threshold, limiterThresholdDb(state.fxLimiterAmount), 0.03, !!instant);
}

function applyMasterLimiterEnabled(instant) {
  if (!audioCtx || !masterLimiterPathGain || !masterBypassPathGain) return;
  // Fail-open: never mute output if the limiter graph is unavailable.
  const canLimit = !!masterLimiter;
  const on = (!!state.fxLimiterEnabled) && canLimit;
  fxSetParam(masterLimiterPathGain.gain, on ? 1 : 0, 0.02, !!instant);
  fxSetParam(masterBypassPathGain.gain, on ? 0 : 1, 0.02, !!instant);
}
function quantizeReverbSize(size) {
  const s = clamp(Number(size) || 0, 0, 1);
  return Math.round(s * 50) / 50; // rebuild only on meaningful change
}

function reverbImpulseSeconds(qSize) {
  const s = clamp(Number(qSize) || 0, 0, 1);
  // 0.22s .. ~2.32s
  return 0.22 + (Math.pow(s, 1.6) * 2.1);
}

function generateReverbImpulseBuffer(seconds) {
  if (!audioCtx) return null;
  const sr = audioCtx.sampleRate || 48000;
  const maxS = 2.5;
  const n = Math.max(1, Math.min(Math.floor(sr * Math.max(0.05, Number(seconds) || 0.5)), Math.floor(sr * maxS)));
  const buf = audioCtx.createBuffer(2, n, sr);
  const amp = 0.35;
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const decay = Math.pow(1 - t, 2.3);
      data[i] = ((Math.random() * 2) - 1) * decay * amp;
    }
  }
  return buf;
}

function ensureMasterReverbImpulse(force, instant) {
  try {
  if (!audioCtx || !reverbConvolver) return;
  const q = quantizeReverbSize(state.fxReverbSize);
  if (!force && reverbConvolver.buffer && reverbImpulseQuant === q) return;
  reverbImpulseQuant = q;

  const buf = generateReverbImpulseBuffer(reverbImpulseSeconds(q));
  if (!buf) return;

  // Avoid clicks by briefly ducking the wet return during swaps.
  if (!instant && reverbReturnGain) {
    const now = audioCtx.currentTime;
    try {
      reverbReturnGain.gain.cancelScheduledValues(now);
      reverbReturnGain.gain.setTargetAtTime(0, now, 0.02);
    } catch (_) {}
    window.setTimeout(() => {
      try { if (reverbConvolver) reverbConvolver.buffer = buf; } catch (_) {}
      if (!audioCtx || !reverbReturnGain) return;
      const now2 = audioCtx.currentTime;
      try {
        reverbReturnGain.gain.cancelScheduledValues(now2);
        reverbReturnGain.gain.setTargetAtTime(1, now2, 0.03);
      } catch (_) {}
    }, 45);
  } else {
    try { reverbConvolver.buffer = buf; } catch (_) {}
  }
  } catch (_) {}
}

function queueMasterReverbImpulseRebuild() {
  if (!audioCtx || !reverbConvolver) return;
  if (!state.fxReverbEnabled) return;
  if (reverbImpulseRebuildTimer) {
    try { window.clearTimeout(reverbImpulseRebuildTimer); } catch (_) {}
    reverbImpulseRebuildTimer = 0;
  }
  reverbImpulseRebuildTimer = window.setTimeout(() => {
    reverbImpulseRebuildTimer = 0;
    ensureMasterReverbImpulse(true, false);
  }, 90);
}

function applyMasterReverbHighCut(instant) {
  if (!audioCtx || !reverbHighCut) return;
  const hz = clamp(Number(state.fxReverbHighCutHz) || 6000, 500, 20000);
  fxSetParam(reverbHighCut.frequency, hz, 0.03, !!instant);
}

function applyMasterReverbSend(instant) {
  const send = masterReverbSend || reverbSendGain;
  if (!audioCtx || !send) return;
  const on = !!state.fxReverbEnabled;
  const mix = clamp(Number(state.fxReverbMix) || 0, 0, 1);
  if (on) { try { ensureMasterReverbImpulse(false, true); } catch (_) {} }
  fxSetParam(send.gain, on ? mix : 0, 0.03, !!instant);
}
function applyMasterFxAll(instant) {
  applyMasterLimiterParams(instant);
  applyMasterLimiterEnabled(instant);
  applyMasterReverbHighCut(instant);
  applyMasterReverbSend(instant);
}

// v014_p02_drone_variant_knobs: Drone Variants (persisted + UI)
  function droneTypeFamily(type) {
    if (type === 'shepard') return 'cloud';
    if (type === 'cluster') return 'cluster';
    if (type === 'noise' || type === 'resnoise' || type === 'noisetone') return 'noise';
    if (type === 'harm4' || type === 'harm6' || type === 'oddharm') return 'harmonic';
    return 'fixed';
  }

  function coerceDroneClusterWidth(raw) {
    const v = parseInt(raw || '', 10);
    if (v === 1 || v === 2 || v === 3 || v === 5) return v;
    return 3;
  }

  function defaultDroneDensityForType(type) {
    switch (type) {
      case 'harm4': return 4;
      case 'harm6': return 6;
      case 'oddharm': return 4;
      case 'shepard': return 3;
      case 'cluster': return 3;
      case 'noise':
      case 'resnoise':
      case 'noisetone':
        return 1;
      default:
        return 3;
    }
  }

  function seedDefaultDroneDensityByType() {
    const m = {};
    try {
      if (droneTypeSelect && droneTypeSelect.options) {
        Array.from(droneTypeSelect.options).forEach((o) => { m[String(o.value)] = defaultDroneDensityForType(String(o.value)); });
        return m;
      }
    } catch (_) {}
    const types = ['single', 'octaves', 'root5', 'fifth', 'majtriad', 'mintriad', 'seventh', 'harm4', 'harm6', 'oddharm', 'shepard', 'cluster', 'noise', 'resnoise', 'noisetone'];
    for (let i = 0; i < types.length; i++) m[types[i]] = defaultDroneDensityForType(types[i]);
    return m;
  }

  function maxDroneDensityForType(type) {
    const cap = DRONE_VOICE_CAP || 16;
    if (type === 'noise' || type === 'resnoise') return 1;
    if (type === 'noisetone') return Math.min(8, Math.max(1, cap - 1));
    const fam = droneTypeFamily(type);
    if (fam === 'cloud' || fam === 'cluster') return Math.max(1, Math.floor((cap - 1) / 2));
    return Math.min(12, cap);
  }

  function clampDroneDensityForType(type, rawDensity) {
    const def = defaultDroneDensityForType(type);
    const v = parseInt(rawDensity || '', 10);
    const max = maxDroneDensityForType(type);
    return clamp(Number.isFinite(v) ? v : def, 1, max);
  }

  function getDroneDensityForType(type) {
    const byType = (state.droneDensityByType && typeof state.droneDensityByType === 'object') ? state.droneDensityByType : null;
    const raw = byType ? byType[type] : state.droneDensity;
    return clampDroneDensityForType(type, raw);
  }

  function droneBaselineVoiceFactor(type) {
    switch (type) {
      case 'octaves': return 3;
      case 'root5': return 2;
      case 'fifth': return 3;
      case 'majtriad': return 3;
      case 'mintriad': return 3;
      case 'seventh': return 4;
      case 'harm4': return 4;
      case 'harm6': return 6;
      case 'oddharm': return 4;
      case 'shepard': return 7;
      case 'cluster': return 7;
      case 'noisetone': return 2;
      case 'noise': return 1;
      case 'resnoise': return 1;
      default: return 1;
    }
  }

  function computeDroneNormalizeGain(type, spec, normalizeEnabled) {
    const on = (typeof normalizeEnabled === 'boolean') ? normalizeEnabled : !!state.droneNormalize;
    if (!on) return 1;
    const nVoices = Math.max(0, (spec && spec.voices) ? spec.voices.length : 0);
    const hasNoise = !!(spec && spec.noise);
    const n = Math.max(1, nVoices + (hasNoise ? 1 : 0));
    const n0 = Math.max(1, droneBaselineVoiceFactor(type));
    return clamp(Math.sqrt(n0 / n), 0.35, 2.0);
  }

  function loadDroneVariantsFromLS() {
    let dirty = false;

    const raw = safeGetLS(LS_DRONE_VARIANTS);
    const parsed = raw ? safeJsonParse(raw) : null;
    const obj = (parsed && typeof parsed === 'object') ? parsed : {};

    if (typeof obj.droneNormalize === 'undefined') dirty = true;
    state.droneNormalize = (typeof obj.droneNormalize === 'undefined') ? true : !!obj.droneNormalize;

    // numeric knobs
    const drift = Number(obj.droneDriftCents);
    if (!Number.isFinite(drift)) dirty = true;
    state.droneDriftCents = clamp(Number.isFinite(drift) ? drift : 0, 0, 20);

    const motion = Number(obj.droneMotionRate);
    if (!Number.isFinite(motion)) dirty = true;
    state.droneMotionRate = clamp(Number.isFinite(motion) ? motion : 0, 0, 10);

    const cwRaw = parseInt(obj.droneClusterWidth || '', 10);
    if (!(cwRaw === 1 || cwRaw === 2 || cwRaw === 3 || cwRaw === 5)) dirty = true;
    state.droneClusterWidth = coerceDroneClusterWidth(obj.droneClusterWidth);

    const tilt = Number(obj.droneNoiseTilt);
    if (!Number.isFinite(tilt)) dirty = true;
    state.droneNoiseTilt = clamp(Number.isFinite(tilt) ? tilt : 0, -1, 1);

    const nq = Number(obj.droneNoiseQ);
    if (!Number.isFinite(nq)) dirty = true;
    state.droneNoiseQ = clamp(Number.isFinite(nq) ? nq : 1, 0.5, 10);

    // density per type
    let byType = obj.droneDensityByType;
    if (!byType || typeof byType !== 'object') {
      byType = seedDefaultDroneDensityByType();
      dirty = true;
    }
    state.droneDensityByType = byType;

    // legacy single density (if present) -> current type
    const legacyDensity = parseInt(obj.droneDensity || '', 10);
    if (Number.isFinite(legacyDensity) && !Object.prototype.hasOwnProperty.call(byType, state.droneType)) {
      byType[state.droneType] = legacyDensity;
      dirty = true;
    }

    syncDroneVariantsForType(state.droneType);

    if (!raw) dirty = true;
    if (dirty) saveDroneVariantsToLS();
  }

  
function saveDroneVariantsToLS() {
    try {
      syncDroneVariantsForType(state.droneType);
      const out = {
        droneNormalize: !!state.droneNormalize,
        droneDensity: state.droneDensity,
        droneDensityByType: state.droneDensityByType || {},
        droneDriftCents: clamp(Number(state.droneDriftCents) || 0, 0, 20),
        droneMotionRate: clamp(Number(state.droneMotionRate) || 0, 0, 10),
        droneClusterWidth: coerceDroneClusterWidth(state.droneClusterWidth),
        droneNoiseTilt: clamp(Number(state.droneNoiseTilt) || 0, -1, 1),
        droneNoiseQ: clamp(Number(state.droneNoiseQ) || 1, 0.5, 10)
      };
      safeSetLS(LS_DRONE_VARIANTS, JSON.stringify(out));
    } catch (_) {}

    // v014_p04_multi_drone_layers: keep Layer 1 and layered persistence in-sync.
    try {
      syncLayer1FromLegacyDroneState();
      saveDroneLayersToLS();
    } catch (_) {}
  }


  function syncDroneNormalizeBtnUI() {
    if (!droneNormalizeBtn) return;
    const on = !!state.droneNormalize;
    droneNormalizeBtn.classList.toggle('active', on);
    droneNormalizeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    droneNormalizeBtn.textContent = on ? 'On' : 'Off';
  }

  function syncDroneVariantsForType(type) {
    // clamp shared fields
    state.droneClusterWidth = coerceDroneClusterWidth(state.droneClusterWidth);
    state.droneDriftCents = clamp(Number(state.droneDriftCents) || 0, 0, 20);
    state.droneMotionRate = clamp(Number(state.droneMotionRate) || 0, 0, 10);
    state.droneNoiseTilt = clamp(Number(state.droneNoiseTilt) || 0, -1, 1);
    state.droneNoiseQ = clamp(Number(state.droneNoiseQ) || 1, 0.5, 10);

    if (!state.droneDensityByType || typeof state.droneDensityByType !== 'object') state.droneDensityByType = seedDefaultDroneDensityByType();
    const byType = state.droneDensityByType;

    const raw = Object.prototype.hasOwnProperty.call(byType, type) ? byType[type] : defaultDroneDensityForType(type);
    const d = clampDroneDensityForType(type, raw);
    byType[type] = d;
    state.droneDensity = d;
  }

  function syncDroneVariantsUI() {
    syncDroneVariantsForType(state.droneType);
    syncDroneNormalizeBtnUI();

    const fam = droneTypeFamily(state.droneType);

    if (droneVariantMotionControl) droneVariantMotionControl.classList.toggle('hidden', fam !== 'cloud');
    if (droneVariantClusterControl) droneVariantClusterControl.classList.toggle('hidden', fam !== 'cluster');

    const isNoiseFam = (fam === 'noise');
    if (droneVariantNoiseTiltControl) droneVariantNoiseTiltControl.classList.toggle('hidden', !isNoiseFam);
    if (droneVariantNoiseQControl) droneVariantNoiseQControl.classList.toggle('hidden', !isNoiseFam);

    // Density slider clamps by current drone family/type
    if (droneDensity) {
      const maxD = maxDroneDensityForType(state.droneType);
      droneDensity.max = String(maxD);
      const next = clampDroneDensityForType(state.droneType, droneDensity.value || state.droneDensity);
      state.droneDensity = next;
      if (state.droneDensityByType && typeof state.droneDensityByType === 'object') state.droneDensityByType[state.droneType] = next;
      droneDensity.value = String(next);
      droneDensity.disabled = (state.droneType === 'noise' || state.droneType === 'resnoise');
    }

    if (droneDriftCents) droneDriftCents.value = String(clamp(Number(state.droneDriftCents) || 0, 0, 20));
    if (droneMotionRate) droneMotionRate.value = String(clamp(Number(state.droneMotionRate) || 0, 0, 10));

    if (droneClusterWidth) {
      const cw = coerceDroneClusterWidth(state.droneClusterWidth);
      state.droneClusterWidth = cw;
      droneClusterWidth.value = String(cw);
    }

    if (droneNoiseTilt) droneNoiseTilt.value = String(clamp(Number(state.droneNoiseTilt) || 0, -1, 1));
    if (droneNoiseQ) droneNoiseQ.value = String(clamp(Number(state.droneNoiseQ) || 1, 0.5, 10));

    // lightweight mod timer (drift + motion)
    syncDroneModTimer();
  }

// v014_p04_multi_drone_layers: Drone Layers (state + UI + synthesis)
// Notes:
// - Layer 1 is backed by the existing drone controls; we keep legacy state fields in-sync for compatibility.
// - All layers feed the shared drone bus (droneMasterGain) and master FX.
// - Voice caps:
//   - Per-layer: DRONE_VOICE_CAP (enforced inside computeDroneSpec).
//   - Global: DRONE_GLOBAL_VOICE_CAP (enforced across unmuted layers by clamping density on later layers first).

function defaultDroneLayerVariantsForType(type) {
  return {
    normalize: true,
    density: defaultDroneDensityForType(type),
    driftCents: 0,
    motionRate: 0,
    clusterWidth: 3,
    noiseTilt: 0,
    noiseQ: 1
  };
}

function coerceDroneLayerVariants(raw, type) {
  const base = defaultDroneLayerVariantsForType(type);
  const v = (raw && typeof raw === 'object') ? raw : {};
  return {
    normalize: !!v.normalize,
    density: clampDroneDensityForType(type, (v.density != null) ? v.density : base.density),
    driftCents: clamp(Number(v.driftCents ?? v.droneDriftCents ?? v.drift) || 0, 0, 20),
    motionRate: clamp(Number(v.motionRate ?? v.droneMotionRate) || 0, 0, 10),
    clusterWidth: coerceDroneClusterWidth(v.clusterWidth ?? v.droneClusterWidth),
    noiseTilt: clamp(Number(v.noiseTilt ?? v.droneNoiseTilt) || 0, -1, 1),
    noiseQ: clamp(Number(v.noiseQ ?? v.droneNoiseQ) || 1, 0.5, 10)
  };
}

function parseCustomDroneIntervalsText(raw, cap) {
  const tokens = String(raw || '').split(/[\s,]+/);
  const vals = [];
  const seen = Object.create(null);
  let hadInvalid = false;
  let didClamp = false;
  let didDedupe = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i] || '').trim();
    if (!t) continue;
    const n0 = parseInt(t, 10);
    if (!Number.isFinite(n0)) { hadInvalid = true; continue; }
    const n = clamp(n0, -36, 36);
    if (n !== n0) didClamp = true;
    if (seen[n]) { didDedupe = true; continue; }
    seen[n] = 1;
    vals.push(n);
  }

  if (vals.length === 0) {
    return { ok: false, vals: [0], autoAddedZero: true, hadInvalid: true, didClamp, didDedupe };
  }

  let autoAddedZero = false;
  if (!seen[0]) { vals.unshift(0); autoAddedZero = true; }
  const out = (typeof cap === 'number' && cap > 0) ? vals.slice(0, cap) : vals;
  return { ok: out.length > 0, vals: out, autoAddedZero, hadInvalid, didClamp, didDedupe };
}

function buildLayer1FromLegacyDroneState() {
  const type = state.droneType;
  const layer = {
    muted: false,
    type,
    followBellKey: false,
    key: state.droneScaleKey,
    register: clamp(Number(state.droneOctaveC) || 3, 1, 6),
    customHzEnabled: state.droneScaleKey === 'custom_hz',
    customHz: coerceCustomHz(state.droneCustomHz, 440),
    customIntervals: '0',
    volume: 1,  // keep legacy sound (master volume controls overall level)
    pan: 0,
    depth: 0,
    // v018_p03_drone_synth
    soundType: 'drone',
    synthPreset: 'tone_sine',
    synthParamsAdvanced: {},
    variants: {
      normalize: !!state.droneNormalize,
      density: clampDroneDensityForType(type, state.droneDensity),
      driftCents: clamp(Number(state.droneDriftCents) || 0, 0, 20),
      motionRate: clamp(Number(state.droneMotionRate) || 0, 0, 10),
      clusterWidth: coerceDroneClusterWidth(state.droneClusterWidth),
      noiseTilt: clamp(Number(state.droneNoiseTilt) || 0, -1, 1),
      noiseQ: clamp(Number(state.droneNoiseQ) || 1, 0.5, 10)
    }
  };

  // Migration: only enable followBellKey if it would not change the audible result.
  try {
    if (layer.key === state.scaleKey) {
      if (layer.key !== 'custom_hz') {
        layer.followBellKey = true;
      } else {
        const b = coerceCustomHz(state.bellCustomHz, 440);
        const d = coerceCustomHz(layer.customHz, 440);
        if (Math.abs(b - d) < 1e-6) layer.followBellKey = true;
      }
    }
  } catch (_) {}

  return layer;
}

function coerceDroneLayer(raw, fallback) {
  const base = fallback || buildLayer1FromLegacyDroneState();
  const v = (raw && typeof raw === 'object') ? raw : {};
  const type = (typeof v.type === 'string' && v.type) ? v.type : base.type;
  const soundType = (String(v.soundType || base.soundType || '') === 'synth') ? 'synth' : 'drone';

  const out = {
    muted: !!v.muted,
    type,
    followBellKey: !!v.followBellKey,
    key: (typeof v.key === 'string' && v.key) ? v.key : base.key,
    register: clamp(Number(v.register) || base.register || 3, 1, 6),
    customHzEnabled: !!v.customHzEnabled,
    customHz: coerceCustomHz(v.customHz, base.customHz || 440),
    volume: clamp(Number.isFinite(Number(v.volume)) ? Number(v.volume) : (Number.isFinite(Number(base.volume)) ? Number(base.volume) : 1), 0, 1),
    pan: clamp(Number(v.pan) || base.pan || 0, -1, 1),
    depth: clamp(Number(v.depth) || base.depth || 0, 0, 1),
    // v018_p03_drone_synth
    soundType,
    synthPreset: (typeof v.synthPreset === 'string' && v.synthPreset.trim()) ? v.synthPreset.trim() : ((typeof base.synthPreset === 'string' && base.synthPreset.trim()) ? base.synthPreset.trim() : 'tone_sine'),
    synthParamsAdvanced: sanitizePolySynthParamsAdvanced(v.synthParamsAdvanced ?? base.synthParamsAdvanced),
    variants: coerceDroneLayerVariants(v.variants, type)
  };

  // Keep customHzEnabled consistent with key selection.
  if (out.key === 'custom_hz') out.customHzEnabled = true;
  if (out.key !== 'custom_hz') out.customHzEnabled = false;

  return out;
}

function ensureDroneLayersState() {
  if (!Array.isArray(state.droneLayers) || state.droneLayers.length < 1) {
    state.droneLayers = [buildLayer1FromLegacyDroneState()];
  }

  // Clamp 1..4
  if (state.droneLayers.length > 4) state.droneLayers.length = 4;
  if (state.droneLayers.length < 1) state.droneLayers = [buildLayer1FromLegacyDroneState()];

  const fallback1 = buildLayer1FromLegacyDroneState();

  for (let i = 0; i < state.droneLayers.length; i++) {
    const existing = state.droneLayers[i];
    const coerced = coerceDroneLayer(existing, (i === 0) ? fallback1 : null);

    if (existing && typeof existing === 'object') {
      // Preserve object identity for UI closures (Layer 2+ controls are rebuilt often).
      const prevVars = existing.variants;
      Object.assign(existing, coerced);
      if (prevVars && typeof prevVars === 'object') {
        existing.variants = prevVars;
        Object.assign(existing.variants, coerced.variants || {});
      }
      state.droneLayers[i] = existing;
    } else {
      state.droneLayers[i] = coerced;
    }
  }

  // Mirror global drone fields for persistence
  state.dronesEnabled = !!state.droneOn;
  state.dronesPaused = !!state.dronePaused;
  state.dronesMasterVolume = clamp(Number(state.droneVolume) || 0, 0, 100);

  // Keep legacy fields aligned with Layer 1 for existing controls.
  syncLegacyDroneStateFromLayer1();
}

function syncLegacyDroneStateFromLayer1() {
  if (!Array.isArray(state.droneLayers) || !state.droneLayers[0]) return;
  const l1 = state.droneLayers[0];

  state.droneType = l1.type;
  state.droneScaleKey = l1.key;
  state.droneOctaveC = clamp(Number(l1.register) || 3, 1, 6);
  state.droneCustomHz = coerceCustomHz(l1.customHz, 440);

  const vv = l1.variants || {};
  state.droneNormalize = !!vv.normalize;
  state.droneDensity = clampDroneDensityForType(l1.type, vv.density);
  state.droneDriftCents = clamp(Number(vv.driftCents) || 0, 0, 20);
  state.droneMotionRate = clamp(Number(vv.motionRate) || 0, 0, 10);
  state.droneClusterWidth = coerceDroneClusterWidth(vv.clusterWidth);
  state.droneNoiseTilt = clamp(Number(vv.noiseTilt) || 0, -1, 1);
  state.droneNoiseQ = clamp(Number(vv.noiseQ) || 1, 0.5, 10);

  // Keep densityByType behavior for the legacy Layer 1 controls.
  if (!state.droneDensityByType || typeof state.droneDensityByType !== 'object') {
    state.droneDensityByType = seedDefaultDroneDensityByType();
  }
  state.droneDensityByType[l1.type] = state.droneDensity;
}

function syncLayer1FromLegacyDroneState() {
  // NOTE: ensureDroneLayersState() mirrors Layer 1 -> legacy, so capture desired legacy values first.
  const desiredType = state.droneType;
  const desiredKey = state.droneScaleKey;
  const desiredRegister = clamp(Number(state.droneOctaveC) || 3, 1, 6);
  const desiredCustomHz = coerceCustomHz(state.droneCustomHz, 440);
  const desiredVariants = {
    normalize: !!state.droneNormalize,
    density: clampDroneDensityForType(desiredType, state.droneDensity),
    driftCents: clamp(Number(state.droneDriftCents) || 0, 0, 20),
    motionRate: clamp(Number(state.droneMotionRate) || 0, 0, 10),
    clusterWidth: coerceDroneClusterWidth(state.droneClusterWidth),
    noiseTilt: clamp(Number(state.droneNoiseTilt) || 0, -1, 1),
    noiseQ: clamp(Number(state.droneNoiseQ) || 1, 0.5, 10)
  };

  ensureDroneLayersState();
  const l1 = state.droneLayers[0];
  if (!l1) return;

  l1.type = desiredType;
  l1.key = desiredKey;
  l1.register = desiredRegister;
  l1.customHz = desiredCustomHz;
  l1.customHzEnabled = (l1.key === 'custom_hz');

  if (!l1.variants || typeof l1.variants !== 'object') l1.variants = defaultDroneLayerVariantsForType(l1.type);
  l1.variants.normalize = desiredVariants.normalize;
  l1.variants.density = desiredVariants.density;
  l1.variants.driftCents = desiredVariants.driftCents;
  l1.variants.motionRate = desiredVariants.motionRate;
  l1.variants.clusterWidth = desiredVariants.clusterWidth;
  l1.variants.noiseTilt = desiredVariants.noiseTilt;
  l1.variants.noiseQ = desiredVariants.noiseQ;

  // Keep legacy controls aligned after pushing changes into Layer 1.
  syncLegacyDroneStateFromLayer1();
}

function loadDroneLayersFromLS() {
  const raw = safeGetLS(LS_DRONE_LAYERS, '');
  if (!raw) return false;

  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') return false;

  const layersRaw = Array.isArray(parsed.droneLayers) ? parsed.droneLayers : null;
  if (!layersRaw || layersRaw.length < 1) return false;

  // Global
  state.droneOn = !!parsed.dronesEnabled;
    try { safeSetBoolLS(LS_DRONE_ON, state.droneOn); } catch (_) {}
  state.dronePaused = !!parsed.dronesPaused;
  state.droneVolume = clamp(Number(parsed.dronesMasterVolume) || 0, 0, 100);

  // Layers
  const fallback1 = buildLayer1FromLegacyDroneState();
  state.droneLayers = layersRaw.slice(0, 4).map((l, i) => coerceDroneLayer(l, (i === 0) ? fallback1 : null));

  // Mirror fields + legacy alignment
  ensureDroneLayersState();

  return true;
}

function saveDroneLayersToLS() {
  try {
    ensureDroneLayersState();
    const out = {
      dronesEnabled: !!state.droneOn,
      dronesPaused: !!state.dronePaused,
      dronesMasterVolume: clamp(Number(state.droneVolume) || 0, 0, 100),
      droneLayers: (state.droneLayers || []).slice(0, 4)
    };
    safeSetLS(LS_DRONE_LAYERS, JSON.stringify(out));
  
      try { safeSetBoolLS(LS_DRONE_ON, !!state.droneOn); } catch (_) {}} catch (_) {}
}

function makeNewDroneLayerTemplate() {
  ensureDroneLayersState();
  const base = state.droneLayers[0] || buildLayer1FromLegacyDroneState();
  const type = base.type || state.droneType;
  return {
    muted: false,
    type,
    followBellKey: true, // default ON for new layers
    key: base.key || state.scaleKey,
    register: clamp(Number(base.register) || 3, 1, 6),
    customHzEnabled: false,
    customHz: 440,
    customIntervals: String(base.customIntervals || '0'),
    volume: 0.5, // moderate by default
    pan: 0,
    depth: 0,
    // v018_p03_drone_synth
    soundType: (base && base.soundType === 'synth') ? 'synth' : 'drone',
    synthPreset: (typeof base.synthPreset === 'string' && base.synthPreset.trim()) ? base.synthPreset.trim() : 'tone_sine',
    synthParamsAdvanced: sanitizePolySynthParamsAdvanced(base && base.synthParamsAdvanced),
    variants: defaultDroneLayerVariantsForType(type)
  };
}

function getDroneLayerRootFrequency(layer) {
  const key = (layer && layer.followBellKey) ? state.scaleKey : (layer ? layer.key : state.droneScaleKey);
  if (key === 'custom_hz') {
    const hz = (layer && layer.followBellKey) ? state.bellCustomHz : (layer ? layer.customHz : state.droneCustomHz);
    return coerceCustomHz(hz, 440);
  }
  const def = getScaleDefByKey(key);
  const oct = clamp(Number(layer && layer.register) || 3, 1, 6);
  const rootMidi = noteToMidi(def.root, oct);
  return midiToFreq(rootMidi);
}

function applyDroneSpecVoiceTrim(spec, maxVoicesTotal) {
  if (!spec || typeof spec !== 'object' || !Number.isFinite(maxVoicesTotal)) return spec;
  const maxTotal = Math.max(0, Math.floor(maxVoicesTotal));
  const hasNoise = !!spec.noise;
  let budget = maxTotal;

  // Keep noise if possible (counts as 1 voice for budgeting)
  let keepNoise = false;
  if (hasNoise && budget >= 1) {
    keepNoise = true;
    budget -= 1;
  }

  const voices = Array.isArray(spec.voices) ? spec.voices : [];
  const keepTonal = Math.min(voices.length, budget);
  const out = { ...spec };
  out.voices = voices.slice(0, keepTonal);
  if (!keepNoise) out.noise = null;
  return out;
}

function computeDroneLayerEffectiveConfigs() {
  ensureDroneLayersState();
  const layers = state.droneLayers || [];
  const nyquist = audioCtx ? (audioCtx.sampleRate * 0.5) : 24000;

  const eff = layers.map((layer) => {
    const active = !!layer && !layer.muted && (Number(layer.volume) || 0) > 0.00001;
    const density = clampDroneDensityForType(layer.type, layer.variants && layer.variants.density);
    const motionRate = clamp(Number(layer.variants && layer.variants.motionRate) || 0, 0, 10);
    return { active, density, motionRate, maxVoicesTotal: null, voiceCount: 0 };
  });

  // First pass: compute desired voice counts.
  let total = 0;
  for (let i = 0; i < layers.length; i++) {
    if (!eff[i].active) continue;
    const layer = layers[i];
    const f = getDroneLayerRootFrequency(layer);
    const vars = {
      density: eff[i].density,
      clusterWidth: layer.variants && layer.variants.clusterWidth,
      noiseTilt: layer.variants && layer.variants.noiseTilt,
      noiseQ: layer.variants && layer.variants.noiseQ,

      customIntervals: layer.customIntervals
    };
    const spec = computeDroneSpec(layer.type, f, nyquist, vars);
    const n = (spec.voices ? spec.voices.length : 0) + (spec.noise ? 1 : 0);
    eff[i].voiceCount = n;
    total += n;
  }

  const capTriggered = total > DRONE_GLOBAL_VOICE_CAP;

  // Degrade rule (deterministic): clamp density on later layers first until within cap.
  if (capTriggered) {
    for (let i = layers.length - 1; i >= 0 && total > DRONE_GLOBAL_VOICE_CAP; i--) {
      if (!eff[i].active) continue;
      const layer = layers[i];

      let d = eff[i].density;
      while (d > 1 && total > DRONE_GLOBAL_VOICE_CAP) {
        const prevCount = eff[i].voiceCount;
        d -= 1;

        const f = getDroneLayerRootFrequency(layer);
        const vars = {
          density: d,
          clusterWidth: layer.variants && layer.variants.clusterWidth,
          noiseTilt: layer.variants && layer.variants.noiseTilt,
          noiseQ: layer.variants && layer.variants.noiseQ,

          customIntervals: layer.customIntervals
        };
        const spec = computeDroneSpec(layer.type, f, nyquist, vars);
        const n = (spec.voices ? spec.voices.length : 0) + (spec.noise ? 1 : 0);

        eff[i].density = d;
        eff[i].voiceCount = n;
        total += (n - prevCount);

        // Guard against non-density types: if density doesn't change voice count, stop early.
        if (n === prevCount) break;
      }
    }
  }

  // Optional CPU relief: if global cap was triggered, disable motion on later layers first.
  if (capTriggered) {
    for (let i = layers.length - 1; i >= 1; i--) {
      eff[i].motionRate = 0;
    }
  }

  // Last resort: deterministic voice trimming on later layers (should rarely be needed).
  if (total > DRONE_GLOBAL_VOICE_CAP) {
    let over = total - DRONE_GLOBAL_VOICE_CAP;
    for (let i = layers.length - 1; i >= 0 && over > 0; i--) {
      if (!eff[i].active) continue;
      const prev = eff[i].voiceCount;
      const keep = Math.max(0, prev - over);
      eff[i].maxVoicesTotal = keep;
      eff[i].voiceCount = keep;
      over -= (prev - keep);
    }
  }

  return eff;
}

function stopDroneLayer(layerIndex) {
  if (!droneLayerCurrents) droneLayerCurrents = [];
  const cur = droneLayerCurrents[layerIndex];
  if (!cur) return;

  droneLayerCurrents[layerIndex] = null;
  if (layerIndex === 0) droneCurrent = null;

  const g = cur.groupGain;
  const nodes = cur.nodes || [];
  const vGain = cur.variantGain;
  const lGain = cur.layerGain;
  const p = cur.panNode;

  if (!audioCtx) {
    try { g.disconnect(); } catch (_) {}
    try { vGain && vGain.disconnect(); } catch (_) {}
    try { lGain && lGain.disconnect(); } catch (_) {}
    try { p && p.disconnect(); } catch (_) {}
    return;
  }

  const now = audioCtx.currentTime;
  try {
    g.gain.cancelScheduledValues(now);
    const v0 = Math.max(0.0001, g.gain.value || 0.0001);
    g.gain.setValueAtTime(v0, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + DRONE_FADE_SEC);
  } catch (_) {}

  const timeoutMs = Math.round((DRONE_FADE_SEC + 0.12) * 1000);
  setTimeout(() => {
    for (const n of nodes) { try { n.stop && n.stop(0); } catch (_) {} }
    for (const n of nodes) { try { n.disconnect && n.disconnect(); } catch (_) {} }
    try { g.disconnect(); } catch (_) {}
    try { vGain && vGain.disconnect(); } catch (_) {}
    try { lGain && lGain.disconnect(); } catch (_) {}
    try { p && p.disconnect(); } catch (_) {}
  }, timeoutMs);
}

function stopAllDroneLayers() {
  if (!droneLayerCurrents) droneLayerCurrents = [];
  for (let i = 0; i < droneLayerCurrents.length; i++) stopDroneLayer(i);
  droneLayerCurrents = [];
  droneCurrent = null;
}

function startDroneLayer(layerIndex, effCfg) {
  if (!state.droneOn) return;
  ensureDroneLayersState();
  if (!audioCtx || !droneMasterGain) ensureAudio();
  if (!audioCtx || !droneMasterGain) return;

  const layers = state.droneLayers || [];
  const layer = layers[layerIndex];
  if (!layer) return;

  // Muted layers should not be audible or consume heavy CPU.
  if (layer.muted || (Number(layer.volume) || 0) <= 0.00001) {
    stopDroneLayer(layerIndex);
    syncDroneModTimer();
    return;
  }

  applyDroneMasterGain();

  // Crossfade: fade old layer out while new fades in.
  stopDroneLayer(layerIndex);

  const now = audioCtx.currentTime;
  const nyquist = audioCtx.sampleRate * 0.5;
  const f = getDroneLayerRootFrequency(layer);

  const eff = effCfg || {};
  const vars = {
    density: (eff.density != null) ? eff.density : (layer.variants && layer.variants.density),
    clusterWidth: layer.variants && layer.variants.clusterWidth,
    noiseTilt: layer.variants && layer.variants.noiseTilt,
    noiseQ: layer.variants && layer.variants.noiseQ,

    customIntervals: layer.customIntervals
  };

  let spec = computeDroneSpec(layer.type, f, nyquist, vars);
  if (Number.isFinite(eff.maxVoicesTotal)) spec = applyDroneSpecVoiceTrim(spec, eff.maxVoicesTotal);

  const nodes = [];
  const voices = [];

  const groupGain = audioCtx.createGain();
  groupGain.gain.setValueAtTime(0.0001, now);
  nodes.push(groupGain);

  const variantGain = audioCtx.createGain();
  const norm = computeDroneNormalizeGain(layer.type, spec, !!(layer.variants && layer.variants.normalize));
  variantGain.gain.setValueAtTime(norm, now);
  nodes.push(variantGain);

  const layerGain = audioCtx.createGain();
  layerGain.gain.setValueAtTime(clamp(Number(layer.volume) || 0, 0, 1), now);
  nodes.push(layerGain);

    let depthStage = null;

    let panStage = null;
  let panNode = null;
  try {
    const sendBus = masterReverbSend || reverbSendGain || null;
    depthStage = createDepthStage(audioCtx, droneMasterGain, sendBus, nodes);
    if (depthStage) {
      try { applyDepthOnStage(depthStage, clamp(Number(layer.depth) || 0, 0, 1), state.spatialDepthMode, true); } catch (_) {}
    }

    const panDest = (depthStage && depthStage.input) ? depthStage.input : droneMasterGain;
    panStage = createPanStage(audioCtx, clamp(Number(layer.pan) || 0, -1, 1), panDest, nodes);
    if (panStage && panStage.output) panNode = (panStage.type === 'stereo' && panStage.panner) ? panStage.panner : panStage.output;
  } catch (_) {
    panStage = null;
    panNode = null;
  }

  // Connect: voices/noise -> groupGain -> variantGain -> layerGain -> pan -> droneMasterGain
  groupGain.connect(variantGain);
  variantGain.connect(layerGain);
  if (panStage && panStage.input) {
    try { layerGain.connect(panStage.input); } catch (_) { try { layerGain.connect(droneMasterGain); } catch (_) {} }
  } else {
    try { layerGain.connect(droneMasterGain); } catch (_) {}
  }

  const soundType = (layer.soundType === 'synth') ? 'synth' : 'drone';
  const synthAdv = (soundType === 'synth' && layer.synthParamsAdvanced && typeof layer.synthParamsAdvanced === 'object' && !Array.isArray(layer.synthParamsAdvanced)) ? layer.synthParamsAdvanced : {};
  const synthVel = (soundType === 'synth' && Number.isFinite(Number(synthAdv.velocity))) ? clamp(Number(synthAdv.velocity), 0, 2) : 1.0;
  const synthPresetId = (soundType === 'synth') ? String(layer.synthPreset || '') : '';
  const synthPreset = (soundType === 'synth') ? polyGetSynthPreset(synthPresetId) : null;

  // Tonal voices
  if (soundType === 'synth') {
    const synthKind = (synthPreset && synthPreset.kind) ? synthPreset.kind : 'tone';
    const carrierType = (synthPreset && synthPreset.kind === 'fm') ? (synthPreset.carrierType || 'sine') : ((synthPreset && synthPreset.oscType) ? synthPreset.oscType : 'sine');
    const modType = (synthPreset && synthPreset.modType) ? synthPreset.modType : 'sine';
    const modRatio = clamp(Number(synthPreset && synthPreset.modRatio) || 2, 0.1, 16);
    const modIndexHz = clamp(Number(synthPreset && synthPreset.modIndexHz) || 0, 0, 2000);

    // Optional filter (preset + advanced overrides)
    const fBase = (synthPreset && synthPreset.filter && typeof synthPreset.filter === 'object') ? synthPreset.filter : null;
    const fAdv = (synthAdv && synthAdv.filter && typeof synthAdv.filter === 'object') ? synthAdv.filter : null;
    const fType = (fAdv && typeof fAdv.type === 'string' && fAdv.type) ? fAdv.type : (fBase && fBase.type);
    const fCut = (fAdv && Number.isFinite(Number(fAdv.cutoffHz))) ? clamp(Number(fAdv.cutoffHz), 20, nyquist) : (fBase && Number.isFinite(Number(fBase.cutoffHz)) ? clamp(Number(fBase.cutoffHz), 20, nyquist) : null);
    const fQ = (fAdv && Number.isFinite(Number(fAdv.Q))) ? clamp(Number(fAdv.Q), 0.1, 30) : (fBase && Number.isFinite(Number(fBase.Q)) ? clamp(Number(fBase.Q), 0.1, 30) : null);

    for (const v of (spec.voices || [])) {
      const osc = audioCtx.createOscillator();
      osc.type = carrierType || 'sine';
      osc.frequency.setValueAtTime(v.f, now);
      if (Number.isFinite(v.detune)) osc.detune.setValueAtTime(v.detune, now);

      let modOsc = null;
      let modGain = null;
      if (synthKind === 'fm') {
        modOsc = audioCtx.createOscillator();
        modOsc.type = modType || 'sine';
        modOsc.frequency.setValueAtTime(clamp(v.f * modRatio, 20, nyquist * 0.9), now);
        if (Number.isFinite(v.detune)) modOsc.detune.setValueAtTime(v.detune, now);

        modGain = audioCtx.createGain();
        modGain.gain.setValueAtTime(0.0001, now);
        try { modGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, modIndexHz), now + Math.min(0.08, DRONE_FADE_SEC)); } catch (_) {}

        modOsc.connect(modGain);
        modGain.connect(osc.frequency);
        nodes.push(modOsc, modGain);
      }

      let pre = osc;
      if (fType) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = fType;
        if (fCut != null) filter.frequency.setValueAtTime(fCut, now);
        if (fQ != null) filter.Q.setValueAtTime(fQ, now);
        pre.connect(filter);
        pre = filter;
        nodes.push(filter);
      }

      const g = audioCtx.createGain();
      const target = clamp((Number(v.g) || 0) * synthVel, 0, 1);
      g.gain.setValueAtTime(0.0, now);
      try { g.gain.linearRampToValueAtTime(target, now + Math.min(0.06, DRONE_FADE_SEC)); } catch (_) {}

      pre.connect(g);
      g.connect(groupGain);
      nodes.push(osc, g);

      voices.push({
        osc,
        gain: g,
        baseFreq: v.f,
        baseDetune: Number.isFinite(v.detune) ? v.detune : 0,
        drift: 0,
        motion: 0,
        modOsc,
        modGain
      });

      try { osc.start(); } catch (_) {}
      if (modOsc) { try { modOsc.start(); } catch (_) {} }
    }
  } else {
    for (const v of (spec.voices || [])) {
      const osc = audioCtx.createOscillator();
      osc.type = v.wave || 'sine';
      osc.frequency.setValueAtTime(v.f, now);
      if (Number.isFinite(v.detune)) osc.detune.setValueAtTime(v.detune, now);

      const g = audioCtx.createGain();
      g.gain.setValueAtTime(clamp(Number(v.g) || 0, 0, 1), now);

      osc.connect(g);
      g.connect(groupGain);
      nodes.push(osc, g);

      voices.push({
        osc,
        gain: g,
        baseFreq: v.f,
        baseDetune: Number.isFinite(v.detune) ? v.detune : 0,
        drift: 0,
        motion: 0
      });

      try { osc.start(); } catch (_) {}
    }
  }

  // Noise
  let noise = null;
  if (spec.noise) {
    const src = audioCtx.createBufferSource();
    src.buffer = getNoiseBuffer();
    src.loop = true;

    const ng = audioCtx.createGain();
    ng.gain.setValueAtTime(clamp(Number(spec.noise.g) || 0, 0, 1), now);

    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(clamp(Number(spec.noise.lpHz) || 1000, 20, nyquist), now);
    lp.Q.setValueAtTime(clamp(Number(spec.noise.lpQ) || 0.707, 0.1, 30), now);

    src.connect(lp);
    lp.connect(ng);
    ng.connect(groupGain);

    nodes.push(src, lp, ng);
    noise = { src, lp, gain: ng };

    // Optional resonant peak (noiseQ)
    if (spec.noise.peakHz) {
      const pk = audioCtx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.setValueAtTime(clamp(Number(spec.noise.peakHz) || 1000, 20, nyquist), now);
      pk.Q.setValueAtTime(clamp(Number(spec.noise.peakQ) || 1, 0.1, 30), now);
      pk.gain.setValueAtTime(clamp(Number(spec.noise.peakGain) || 0, -40, 40), now);

      lp.disconnect();
      src.connect(pk);
      pk.connect(lp);

      nodes.push(pk);
      noise.pk = pk;
    }

    try { src.start(); } catch (_) {}
  }

  // Fade in
  try { groupGain.gain.exponentialRampToValueAtTime(1.0, now + DRONE_FADE_SEC); } catch (_) {}

  const cur = {
    layerIndex,
    type: layer.type,
    soundType,
    synthPreset: (soundType === 'synth') ? String(layer.synthPreset || '') : '',
    synthVel,
    groupGain,
    variantGain,
    layerGain,
    panNode,
    panStage,
    depthStage,
    nodes,
    voices,
    noise,
    modLastTime: now,
    motionPhase: 0,
    effectiveMotionRate: (eff.motionRate != null) ? eff.motionRate : clamp(Number(layer.variants && layer.variants.motionRate) || 0, 0, 10)
  };

  if (!droneLayerCurrents) droneLayerCurrents = [];
  droneLayerCurrents[layerIndex] = cur;
  if (layerIndex === 0) droneCurrent = cur;

  syncDroneModTimer();
}

function refreshDroneLayer(layerIndex, effCfg) {
  if (!state.droneOn) return;
  ensureDroneLayersState();

  const layers = state.droneLayers || [];
  const layer = layers[layerIndex];
  if (!layer) return;

  // Muted layers: stop and return.
  if (layer.muted || (Number(layer.volume) || 0) <= 0.00001) {
    stopDroneLayer(layerIndex);
    syncDroneModTimer();
    return;
  }

  if (!audioCtx || !droneLayerCurrents || !droneLayerCurrents[layerIndex]) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }

  const cur = droneLayerCurrents[layerIndex];
  if (cur.type !== layer.type) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }

  const soundType = (layer.soundType === 'synth') ? 'synth' : 'drone';
  if ((cur.soundType || 'drone') !== soundType) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }
  if (soundType === 'synth' && String(cur.synthPreset || '') !== String(layer.synthPreset || '')) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }

  const now = audioCtx.currentTime;
  const synthPreset = (soundType === 'synth') ? polyGetSynthPreset(layer.synthPreset) : null;
  const synthAdv = (soundType === 'synth' && layer.synthParamsAdvanced && typeof layer.synthParamsAdvanced === 'object' && !Array.isArray(layer.synthParamsAdvanced)) ? layer.synthParamsAdvanced : {};
  const synthVel = (soundType === 'synth' && Number.isFinite(Number(synthAdv.velocity))) ? clamp(Number(synthAdv.velocity), 0, 2) : 1.0;
  if (soundType === 'synth') cur.synthVel = synthVel;

  const nyquist = audioCtx.sampleRate * 0.5;
  const f = getDroneLayerRootFrequency(layer);

  const eff = effCfg || {};
  const vars = {
    density: (eff.density != null) ? eff.density : (layer.variants && layer.variants.density),
    clusterWidth: layer.variants && layer.variants.clusterWidth,
    noiseTilt: layer.variants && layer.variants.noiseTilt,
    noiseQ: layer.variants && layer.variants.noiseQ,

    customIntervals: layer.customIntervals
  };

  let spec = computeDroneSpec(layer.type, f, nyquist, vars);
  if (Number.isFinite(eff.maxVoicesTotal)) spec = applyDroneSpecVoiceTrim(spec, eff.maxVoicesTotal);

  // Update normalization
  const targetNorm = computeDroneNormalizeGain(layer.type, spec, !!(layer.variants && layer.variants.normalize));
  try {
    cur.variantGain.gain.cancelScheduledValues(now);
    cur.variantGain.gain.setTargetAtTime(targetNorm, now, 0.06);
  } catch (_) {}

  // Update layer mix (volume/pan) smoothly.
  try {
    cur.layerGain.gain.cancelScheduledValues(now);
    cur.layerGain.gain.setTargetAtTime(clamp(Number(layer.volume) || 0, 0, 1), now, 0.04);
  } catch (_) {}
  if (cur.panStage) {
    try { setPanOnStage(cur.panStage, layer.pan, now); } catch (_) {}
  } else if (cur.panNode && cur.panNode.pan) {
    try { panRampParam(cur.panNode.pan, Number(layer.pan) || 0, now); } catch (_) {}
  }

  if (cur.depthStage) {
    try { applyDepthOnStage(cur.depthStage, clamp(Number(layer.depth) || 0, 0, 1), state.spatialDepthMode, false); } catch (_) {}
  }

  // Store effective motion rate (for mod tick).
  cur.effectiveMotionRate = (eff.motionRate != null) ? eff.motionRate : clamp(Number(layer.variants && layer.variants.motionRate) || 0, 0, 10);

  // Structure mismatch -> rebuild this layer.
  if ((spec.voices || []).length !== (cur.voices || []).length) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }
  if (!!spec.noise !== !!cur.noise) {
    startDroneLayer(layerIndex, effCfg);
    return;
  }

  // Update voices
  const t = now + 0.08;
  for (let i = 0; i < (spec.voices || []).length; i++) {
    const sv = spec.voices[i];
    const cv = cur.voices[i];
    if (!cv || !cv.osc) continue;

    if (soundType === 'synth') {
      const wantWave = (synthPreset && synthPreset.kind === 'fm') ? (synthPreset.carrierType || 'sine') : ((synthPreset && synthPreset.oscType) ? synthPreset.oscType : 'sine');
      if (wantWave && cv.osc.type !== wantWave) cv.osc.type = wantWave;
      if (synthPreset && synthPreset.kind === 'fm' && cv.modOsc) {
        const wantMod = synthPreset.modType || 'sine';
        if (wantMod && cv.modOsc.type !== wantMod) cv.modOsc.type = wantMod;
      }
    } else {
      if (sv.wave && cv.osc.type !== sv.wave) cv.osc.type = sv.wave;
    }

    cv.baseFreq = sv.f;
    cv.baseDetune = Number.isFinite(sv.detune) ? sv.detune : 0;

    try {
      cv.osc.frequency.cancelScheduledValues(now);
      cv.osc.frequency.setValueAtTime(cv.osc.frequency.value, now);
      cv.osc.frequency.linearRampToValueAtTime(sv.f, t);
    } catch (_) {}

    if (soundType === 'synth' && synthPreset && synthPreset.kind === 'fm' && cv.modOsc) {
      const ratio = clamp(Number(synthPreset.modRatio) || 2, 0.1, 16);
      const targetHz = clamp(sv.f * ratio, 20, nyquist * 0.9);
      try {
        cv.modOsc.frequency.cancelScheduledValues(now);
        cv.modOsc.frequency.setValueAtTime(cv.modOsc.frequency.value, now);
        cv.modOsc.frequency.linearRampToValueAtTime(targetHz, t);
      } catch (_) {}
    }

    try {
      cv.osc.detune.cancelScheduledValues(now);
      cv.osc.detune.setValueAtTime(cv.osc.detune.value, now);
      cv.osc.detune.linearRampToValueAtTime(cv.baseDetune + cv.drift + cv.motion, t);
    } catch (_) {}

    if (soundType === 'synth' && synthPreset && synthPreset.kind === 'fm' && cv.modOsc && cv.modOsc.detune) {
      try {
        cv.modOsc.detune.cancelScheduledValues(now);
        cv.modOsc.detune.setValueAtTime(cv.modOsc.detune.value, now);
        cv.modOsc.detune.linearRampToValueAtTime(cv.baseDetune + cv.drift + cv.motion, t);
      } catch (_) {}
    }

    try {
      cv.gain.gain.cancelScheduledValues(now);
      cv.gain.gain.setValueAtTime(cv.gain.gain.value, now);
      cv.gain.gain.linearRampToValueAtTime(clamp((Number(sv.g) || 0) * ((soundType === 'synth') ? synthVel : 1), 0, 1), t);
    } catch (_) {}
  }

  // Update noise
  if (spec.noise && cur.noise) {
    try {
      cur.noise.gain.gain.cancelScheduledValues(now);
      cur.noise.gain.gain.setValueAtTime(cur.noise.gain.gain.value, now);
      cur.noise.gain.gain.linearRampToValueAtTime(clamp(Number(spec.noise.g) || 0, 0, 1), t);
    } catch (_) {}

    try {
      cur.noise.lp.frequency.cancelScheduledValues(now);
      cur.noise.lp.frequency.setValueAtTime(cur.noise.lp.frequency.value, now);
      cur.noise.lp.frequency.linearRampToValueAtTime(clamp(Number(spec.noise.lpHz) || 1000, 20, nyquist), t);
    } catch (_) {}

    try {
      cur.noise.lp.Q.cancelScheduledValues(now);
      cur.noise.lp.Q.setValueAtTime(cur.noise.lp.Q.value, now);
      cur.noise.lp.Q.linearRampToValueAtTime(clamp(Number(spec.noise.lpQ) || 0.707, 0.1, 30), t);
    } catch (_) {}

    if (cur.noise.pk && spec.noise.peakHz) {
      try {
        cur.noise.pk.frequency.cancelScheduledValues(now);
        cur.noise.pk.frequency.setValueAtTime(cur.noise.pk.frequency.value, now);
        cur.noise.pk.frequency.linearRampToValueAtTime(clamp(Number(spec.noise.peakHz) || 1000, 20, nyquist), t);
      } catch (_) {}
      try {
        cur.noise.pk.Q.cancelScheduledValues(now);
        cur.noise.pk.Q.setValueAtTime(cur.noise.pk.Q.value, now);
        cur.noise.pk.Q.linearRampToValueAtTime(clamp(Number(spec.noise.peakQ) || 1, 0.1, 30), t);
      } catch (_) {}
      try {
        cur.noise.pk.gain.cancelScheduledValues(now);
        cur.noise.pk.gain.setValueAtTime(cur.noise.pk.gain.value, now);
        cur.noise.pk.gain.linearRampToValueAtTime(clamp(Number(spec.noise.peakGain) || 0, -40, 40), t);
      } catch (_) {}
    }
  }

  syncDroneModTimer();
}

function refreshAllDroneLayers() {
  if (!state.droneOn) return;
  if (!audioCtx || !droneMasterGain) ensureAudio();
  if (!audioCtx || !droneMasterGain) return;

  ensureDroneLayersState();
  applyDroneMasterGain();

  const layers = state.droneLayers || [];
  const eff = computeDroneLayerEffectiveConfigs();

  // Refresh or start each layer in order.
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer || layer.muted || (Number(layer.volume) || 0) <= 0.00001) {
      stopDroneLayer(i);
    } else if (!droneLayerCurrents || !droneLayerCurrents[i]) {
      startDroneLayer(i, eff[i]);
    } else {
      refreshDroneLayer(i, eff[i]);
    }
  }

  // Stop any extra running layers beyond current layer count.
  if (droneLayerCurrents && droneLayerCurrents.length > layers.length) {
    for (let i = layers.length; i < droneLayerCurrents.length; i++) stopDroneLayer(i);
  }

  syncDroneModTimer();
}

function ensureDroneLayersScaffold(destEl) {
  if (!destEl) return null;
  if (!ui.droneLayersUI) ui.droneLayersUI = {};

  const existing = ui.droneLayersUI;
  if (existing.rootEl && existing.rootEl.parentElement === destEl) return existing;

  // Rebuild scaffold
  destEl.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'rg-drone-layers-root';
  root.id = 'rgDroneLayersRoot';

  const globalEl = document.createElement('div');
  globalEl.className = 'rg-drone-layers-global';

  const stackEl = document.createElement('div');
  stackEl.className = 'rg-drone-layers-stack';

  const addRowEl = document.createElement('div');
  addRowEl.className = 'rg-drone-layer-add-row';

  const addBtnEl = document.createElement('button');
  addBtnEl.type = 'button';
  addBtnEl.className = 'pill';
  addBtnEl.id = 'droneAddLayerBtn';
  addBtnEl.textContent = '+ Add drone layer';
  addRowEl.appendChild(addBtnEl);

  root.appendChild(globalEl);
  root.appendChild(stackEl);
  root.appendChild(addRowEl);
  destEl.appendChild(root);

  ui.droneLayersUI = { rootEl: root, globalEl, stackEl, addRowEl, addBtnEl, cards: [] };

  // Create Layer 1 shell immediately so mountMenuControls can move legacy controls into it.
  const shell0 = createLayerCardShell(0);
  ui.droneLayersUI.cards.push(shell0);
  stackEl.appendChild(shell0.card);

  return ui.droneLayersUI;
}

function createLayerCardShell(layerIndex) {
  const card = document.createElement('div');
  card.className = 'rg-drone-layer-card';
  card.dataset.layerIndex = String(layerIndex);

  const head = document.createElement('div');
  head.className = 'rg-drone-layer-head';

  const title = document.createElement('div');
  title.className = 'rg-drone-layer-title';
  title.textContent = `Layer ${layerIndex + 1}`;

  const actions = document.createElement('div');
  actions.className = 'rg-drone-layer-actions';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'pill';
  muteBtn.textContent = 'Mute';
  actions.appendChild(muteBtn);

  let removeBtn = null;
  if (layerIndex > 0) {
    removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pill';
    removeBtn.textContent = 'Remove';
    actions.appendChild(removeBtn);
  }

  head.appendChild(title);
  head.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'rg-drone-layer-body';

  card.appendChild(head);
  card.appendChild(body);

  return { card, head, body, title, actions, muteBtn, removeBtn };
}

function cloneControlByChildId(childId, newIdSuffix) {
  const src = document.getElementById(childId);
  if (!src) return null;
  const control = src.closest('.control');
  if (!control) return null;
  const cloned = control.cloneNode(true);

  // Update ids + label fors inside clone
  const allWithId = cloned.querySelectorAll('[id]');
  for (const el of allWithId) {
    el.id = `${el.id}${newIdSuffix}`;
  }
  const labels = cloned.querySelectorAll('label[for]');
  for (const lab of labels) {
    lab.htmlFor = `${lab.htmlFor}${newIdSuffix}`;
  }

  return cloned;
}

function syncLayerCardHeaderUI(layerIndex, shell) {
  ensureDroneLayersState();
  const layer = state.droneLayers && state.droneLayers[layerIndex];
  if (!layer || !shell) return;

  const muted = !!layer.muted;
  if (muted) {
    shell.card.classList.add('rg-drone-layer-muted');
    shell.muteBtn.classList.add('active');
    shell.muteBtn.setAttribute('aria-pressed', 'true');
    shell.muteBtn.textContent = 'Muted';
  } else {
    shell.card.classList.remove('rg-drone-layer-muted');
    shell.muteBtn.classList.remove('active');
    shell.muteBtn.setAttribute('aria-pressed', 'false');
    shell.muteBtn.textContent = 'Mute';
  }
}

function rebuildDroneLayersUI() {
  const soundDroneDest = document.getElementById('soundDroneControls');
  const uiD = ensureDroneLayersScaffold(soundDroneDest);
  if (!uiD) return;

  ensureDroneLayersState();

  // v018_p03_drone_synth: build options for the same synth preset IDs as polyrhythm
  const fillPolySynthPresetSelect = (selEl, currentValue) => {
    if (!selEl) return;
    let cur = (currentValue == null) ? '' : String(currentValue || '');
    cur = String(cur);
    let keys = null;
    try { keys = (typeof POLY_SYNTH_PRESETS === 'object' && POLY_SYNTH_PRESETS) ? Object.keys(POLY_SYNTH_PRESETS) : null; } catch (_) { keys = null; }
    if (!Array.isArray(keys) || !keys.length) keys = ['tone_sine', 'tone_triangle_pluck', 'tone_saw_pad', 'fm_bell'];

    // Preserve unknown preset IDs for forward-compat configs (show as Custom)
    selEl.innerHTML = '';
    const hasCur = (cur && keys.indexOf(cur) !== -1);
    if (cur && !hasCur) {
      const o0 = document.createElement('option');
      o0.value = cur;
      o0.textContent = 'Custom: ' + cur;
      selEl.appendChild(o0);
    }
    for (const k of keys) {
      const o = document.createElement('option');
      o.value = k;
      let label = k;
      try {
        const p = (POLY_SYNTH_PRESETS && POLY_SYNTH_PRESETS[k]) ? POLY_SYNTH_PRESETS[k] : null;
        if (p && p.label) label = String(p.label);
      } catch (_) {}
      o.textContent = label;
      selEl.appendChild(o);
    }
    if (!cur) cur = keys[0] || 'tone_sine';
    selEl.value = cur;
  };

  // Ensure stack shells match layer count
  const desired = (state.droneLayers || []).length;
  while (uiD.cards.length < desired) {
    const idx = uiD.cards.length;
    const shell = createLayerCardShell(idx);
    uiD.cards.push(shell);
    uiD.stackEl.appendChild(shell.card);
  }
  while (uiD.cards.length > desired) {
    const shell = uiD.cards.pop();
    try { shell.card.remove(); } catch (_) {}
  }

  // Global add button
  if (!uiD.addBtnEl._rgBound) {
    uiD.addBtnEl._rgBound = true;
    uiD.addBtnEl.addEventListener('click', () => {
      ensureDroneLayersState();
      if ((state.droneLayers || []).length >= 4) return;

      state.droneLayers.push(makeNewDroneLayerTemplate());
      saveDroneLayersToLS();
      rebuildDroneLayersUI();
      if (state.droneOn) refreshAllDroneLayers();
    });
  }
  uiD.addBtnEl.disabled = (state.droneLayers.length >= 4);

  // Layer 1: create per-layer controls once
  const layer1Body = uiD.cards[0] && uiD.cards[0].body;
  if (layer1Body && !layer1Body._rgHasLayerExtras) {
    layer1Body._rgHasLayerExtras = true;

    const followCtl = document.createElement('div');
    followCtl.className = 'control';
    const followLab = document.createElement('label');
    followLab.textContent = 'Follow Bell Key';
    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.className = 'pill';
    followBtn.id = 'droneFollowBellKeyBtn_L1';
    followBtn.textContent = 'On';
    followCtl.appendChild(followLab);
    followCtl.appendChild(followBtn);

    // Sound type (classic drone vs synth)
    const soundCtl = document.createElement('div');
    soundCtl.className = 'control';
    const soundLab = document.createElement('label');
    soundLab.textContent = 'Sound type';
    const soundSel = document.createElement('select');
    soundSel.id = 'droneLayerSoundType_L1';
    soundSel.innerHTML = '<option value="drone">Drone</option><option value="synth">Synth</option>';
    soundCtl.appendChild(soundLab);
    soundCtl.appendChild(soundSel);

    const presetCtl = document.createElement('div');
    presetCtl.className = 'control';
    presetCtl.id = 'droneLayerSynthPresetControl_L1';
    const presetLab = document.createElement('label');
    presetLab.textContent = 'Synth preset';
    const presetSel = document.createElement('select');
    presetSel.id = 'droneLayerSynthPreset_L1';
    presetCtl.appendChild(presetLab);
    presetCtl.appendChild(presetSel);
    presetCtl.classList.add('hidden');
    fillPolySynthPresetSelect(presetSel, 'tone_sine');

    const volCtl = document.createElement('div');
    volCtl.className = 'control';
    const volLab = document.createElement('label');
    volLab.textContent = 'Layer volume';
    const volIn = document.createElement('input');
    volIn.type = 'range';
    volIn.min = '0';
    volIn.max = '100';
    volIn.step = '1';
    volIn.id = 'droneLayerVolume_L1';
    volCtl.appendChild(volLab);
    volCtl.appendChild(volIn);

    const panCtl = document.createElement('div');
    panCtl.className = 'control';
    const panLab = document.createElement('label');
    panLab.textContent = 'Pan ';
    const panVal = document.createElement('span');
    panVal.className = 'rg-range-readout';
    panVal.id = 'droneLayerPanVal_L1';
    panVal.textContent = '0.0';
    panLab.appendChild(panVal);
    const panIn = document.createElement('input');
    panIn.type = 'range';
    panIn.min = '-1';
    panIn.max = '1';
    panIn.step = '0.1';
    panIn.id = 'droneLayerPan_L1';
    panCtl.appendChild(panLab);
    panCtl.appendChild(panIn);



    const depthCtl = document.createElement('div');
    depthCtl.className = 'control';
    const depthLab = document.createElement('label');
    depthLab.textContent = 'Depth ';
    const depthVal = document.createElement('span');
    depthVal.className = 'rg-range-readout';
    depthVal.id = 'droneLayerDepthVal_L1';
    depthVal.textContent = '0.00';
    depthLab.appendChild(depthVal);
    const depthIn = document.createElement('input');
    depthIn.type = 'range';
    depthIn.min = '0';
    depthIn.max = '1';
    depthIn.step = '0.01';
    depthIn.id = 'droneLayerDepth_L1';
    depthCtl.appendChild(depthLab);
    depthCtl.appendChild(depthIn);


    layer1Body.appendChild(followCtl);
    layer1Body.appendChild(soundCtl);
    layer1Body.appendChild(presetCtl);
    layer1Body.appendChild(volCtl);
    layer1Body.appendChild(panCtl);
    layer1Body.appendChild(depthCtl);

    followBtn.addEventListener('click', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.followBellKey = !l1.followBellKey;
      saveDroneLayersToLS();
      rebuildDroneLayersUI();
      if (state.droneOn) refreshAllDroneLayers();
    });

    soundSel.addEventListener('change', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.soundType = (soundSel.value === 'synth') ? 'synth' : 'drone';
      if (l1.soundType === 'synth' && !(typeof l1.synthPreset === 'string' && l1.synthPreset.trim())) l1.synthPreset = 'tone_sine';
      saveDroneLayersToLS();
      rebuildDroneLayersUI();
      if (state.droneOn) refreshAllDroneLayers();
    });

    presetSel.addEventListener('change', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.synthPreset = presetSel.value;
      saveDroneLayersToLS();
      rebuildDroneLayersUI();
      if (state.droneOn) refreshAllDroneLayers();
    });

    volIn.addEventListener('input', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.volume = clamp(Number(volIn.value) / 100, 0, 1);
      saveDroneLayersToLS();
      if (state.droneOn) refreshAllDroneLayers();
    });

    panIn.addEventListener('input', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.pan = clamp(Number(panIn.value), -1, 1);
      const panValEl = document.getElementById('droneLayerPanVal_L1');
      if (panValEl) panValEl.textContent = fmtPan1(l1.pan);
      saveDroneLayersToLS();
      if (state.droneOn) refreshAllDroneLayers();
    });

    depthIn.addEventListener('input', () => {
      ensureDroneLayersState();
      const l1 = state.droneLayers[0];
      l1.depth = clamp(Number(depthIn.value), 0, 1);
      const depthValEl = document.getElementById('droneLayerDepthVal_L1');
      if (depthValEl) depthValEl.textContent = fmtDepth2(l1.depth);
      saveDroneLayersToLS();
      if (state.droneOn) refreshAllDroneLayers();
    });
  }

  // Bind mute/remove + build controls per layer
  for (let i = 0; i < uiD.cards.length; i++) {
    const shell = uiD.cards[i];
    const layer = state.droneLayers[i];
    if (!layer) continue;

    // Header controls
    if (!shell.muteBtn._rgBound) {
      shell.muteBtn._rgBound = true;
      shell.muteBtn.addEventListener('click', () => {
        ensureDroneLayersState();
        const l = state.droneLayers[i];
        if (!l) return;
        l.muted = !l.muted;
        saveDroneLayersToLS();
        syncLayerCardHeaderUI(i, shell);
        if (state.droneOn) refreshAllDroneLayers();
      });
    }
    if (shell.removeBtn && !shell.removeBtn._rgBound) {
      shell.removeBtn._rgBound = true;
      shell.removeBtn.addEventListener('click', () => {
        ensureDroneLayersState();
        if (i <= 0) return;
        state.droneLayers.splice(i, 1);
        saveDroneLayersToLS();

        // Restart layers to keep indices clean.
        if (state.droneOn) {
          stopAllDroneLayers();
          refreshAllDroneLayers();
        }
        rebuildDroneLayersUI();
      });
    }
    syncLayerCardHeaderUI(i, shell);

    // Layer bodies
    if (i === 0) {
      // Sync Layer 1 extra controls
      const followBtn = document.getElementById('droneFollowBellKeyBtn_L1');
      const volIn = document.getElementById('droneLayerVolume_L1');
      const panIn = document.getElementById('droneLayerPan_L1');
      const depthIn = document.getElementById('droneLayerDepth_L1');
      const soundSel = document.getElementById('droneLayerSoundType_L1');
      const presetSel = document.getElementById('droneLayerSynthPreset_L1');
      const presetCtl = document.getElementById('droneLayerSynthPresetControl_L1');
      if (followBtn) {
        if (layer.followBellKey) {
          followBtn.classList.add('active');
          followBtn.setAttribute('aria-pressed', 'true');
          followBtn.textContent = 'On';
        } else {
          followBtn.classList.remove('active');
          followBtn.setAttribute('aria-pressed', 'false');
          followBtn.textContent = 'Off';
        }
      }

      // v018_p03_drone_synth: sync Layer 1 sound type controls
      const st = (layer.soundType === 'synth') ? 'synth' : 'drone';
      if (soundSel) soundSel.value = st;
      if (presetCtl) presetCtl.classList.toggle('hidden', st !== 'synth');
      if (presetSel) fillPolySynthPresetSelect(presetSel, layer.synthPreset || 'tone_sine');

      if (volIn) volIn.value = String(Math.round(clamp(Number(layer.volume) || 0, 0, 1) * 100));
      if (panIn) panIn.value = fmtPan1(layer.pan);
      const panValEl = document.getElementById('droneLayerPanVal_L1');
      if (panValEl) panValEl.textContent = fmtPan1(layer.pan);
      if (depthIn) depthIn.value = fmtDepth2(layer.depth);
      const depthValEl = document.getElementById('droneLayerDepthVal_L1');
      if (depthValEl) depthValEl.textContent = fmtDepth2(layer.depth);

      // Hide/show legacy key controls depending on followBellKey.
      const keyCtl = (typeof droneScaleSelect !== 'undefined' && droneScaleSelect) ? droneScaleSelect.closest('.control') : null;
      const hzCtl = (typeof droneCustomHzInput !== 'undefined' && droneCustomHzInput) ? droneCustomHzInput.closest('.control') : null;
      if (keyCtl) keyCtl.classList.toggle('hidden', !!layer.followBellKey);
      if (hzCtl) hzCtl.classList.toggle('hidden', !!layer.followBellKey || (state.droneScaleKey !== 'custom_hz'));
      if (droneCustomIntervalsControl) droneCustomIntervalsControl.classList.toggle('hidden', String(layer.type || '') !== 'custom');
      if (droneCustomIntervalsInput) droneCustomIntervalsInput.value = String(layer.customIntervals || '');
      if (droneCustomIntervalsWarn) {
        let msg = '';
        if (String(layer.type || '') === 'custom') {
          const p = parseCustomDroneIntervalsText(layer.customIntervals, DRONE_VOICE_CAP || 16);
          if (!p || !p.ok) msg = 'Invalid intervals. Using [0].';
          else {
            const parts = [];
            if (p.autoAddedZero) parts.push('Added 0');
            if (p.didClamp) parts.push('Clamped -36..36');
            if (p.didDedupe) parts.push('De-duped');
            if (p.hadInvalid) parts.push('Ignored invalid');
            if (parts.length) msg = parts.join('. ') + '.';
          }
        }
        droneCustomIntervalsWarn.textContent = msg;
        droneCustomIntervalsWarn.classList.toggle('hidden', !msg);
      }
    } else {
      // Rebuild Layer 2+ controls each time (small n; easier to keep in sync).
      shell.body.innerHTML = '';

      // Type
      const typeCtl = cloneControlByChildId('droneTypeSelect', `_L${i + 1}`);
      if (typeCtl) shell.body.appendChild(typeCtl);
      const typeSel = typeCtl ? typeCtl.querySelector('select') : null;
      if (typeSel) typeSel.value = layer.type;

      // Custom intervals (only when type is Custom)
      const ciCtl = cloneControlByChildId('droneCustomIntervalsInput', `_L${i + 1}`);
      if (ciCtl) shell.body.appendChild(ciCtl);
      const ciInput = ciCtl ? ciCtl.querySelector('input[type="text"]') : null;
      const ciWarn = ciCtl ? ciCtl.querySelector('.rg-inline-warn') : null;
      if (ciInput) ciInput.value = String(layer.customIntervals || '');
      if (ciCtl) ciCtl.classList.toggle('hidden', String(layer.type || '') !== 'custom');
      if (ciWarn) {
        let msg = '';
        if (String(layer.type || '') === 'custom') {
          const p = parseCustomDroneIntervalsText(layer.customIntervals, DRONE_VOICE_CAP || 16);
          if (!p || !p.ok) msg = 'Invalid intervals. Using [0].';
          else {
            const parts = [];
            if (p.autoAddedZero) parts.push('Added 0');
            if (p.didClamp) parts.push('Clamped -36..36');
            if (p.didDedupe) parts.push('De-duped');
            if (p.hadInvalid) parts.push('Ignored invalid');
            if (parts.length) msg = parts.join('. ') + '.';
          }
        }
        ciWarn.textContent = msg;
        ciWarn.classList.toggle('hidden', !msg);
      }

      // Sound type
      const soundCtl = document.createElement('div');
      soundCtl.className = 'control';
      const soundLab = document.createElement('label');
      soundLab.textContent = 'Sound type';
      const soundSel = document.createElement('select');
      soundSel.id = `droneLayerSoundType_L${i + 1}`;
      soundSel.innerHTML = '<option value="drone">Drone</option><option value="synth">Synth</option>';
      soundCtl.appendChild(soundLab);
      soundCtl.appendChild(soundSel);
      shell.body.appendChild(soundCtl);

      const presetCtl = document.createElement('div');
      presetCtl.className = 'control';
      presetCtl.id = `droneLayerSynthPresetControl_L${i + 1}`;
      const presetLab = document.createElement('label');
      presetLab.textContent = 'Synth preset';
      const presetSel = document.createElement('select');
      presetSel.id = `droneLayerSynthPreset_L${i + 1}`;
      presetCtl.appendChild(presetLab);
      presetCtl.appendChild(presetSel);
      shell.body.appendChild(presetCtl);

      const st = (layer.soundType === 'synth') ? 'synth' : 'drone';
      soundSel.value = st;
      fillPolySynthPresetSelect(presetSel, layer.synthPreset || 'tone_sine');
      presetCtl.classList.toggle('hidden', st !== 'synth');

      // Follow toggle
      const followCtl = document.createElement('div');
      followCtl.className = 'control';
      const followLab = document.createElement('label');
      followLab.textContent = 'Follow Bell Key';
      const followBtn = document.createElement('button');
      followBtn.type = 'button';
      followBtn.className = 'pill';
      followBtn.textContent = layer.followBellKey ? 'On' : 'Off';
      if (layer.followBellKey) followBtn.classList.add('active');
      followCtl.appendChild(followLab);
      followCtl.appendChild(followBtn);
      shell.body.appendChild(followCtl);

      // Key
      const keyCtl = cloneControlByChildId('droneScaleSelect', `_L${i + 1}`);
      if (keyCtl) shell.body.appendChild(keyCtl);
      const keySel = keyCtl ? keyCtl.querySelector('select') : null;
      if (keySel) keySel.value = layer.key;
      if (keyCtl) keyCtl.classList.toggle('hidden', !!layer.followBellKey);

      // Register
      const regCtl = cloneControlByChildId('droneOctaveSelect', `_L${i + 1}`);
      if (regCtl) shell.body.appendChild(regCtl);
      const regSel = regCtl ? regCtl.querySelector('select') : null;
      if (regSel) regSel.value = String(layer.register);

      // Custom Hz (only when not following and key is custom_hz)
      const hzCtl = cloneControlByChildId('droneCustomHzInput', `_L${i + 1}`);
      if (hzCtl) shell.body.appendChild(hzCtl);
      if (hzCtl) hzCtl.classList.toggle('hidden', !!layer.followBellKey || (layer.key !== 'custom_hz'));
      const hzInput = hzCtl ? hzCtl.querySelector('input[type="number"]') : null;
      const hzSlider = hzCtl ? hzCtl.querySelector('input[type="range"]') : null;
      if (hzInput) hzInput.value = String(layer.customHz);
      if (hzSlider) hzSlider.value = String(layer.customHz);

      // Layer volume
      const volCtl = document.createElement('div');
      volCtl.className = 'control';
      const volLab = document.createElement('label');
      volLab.textContent = 'Layer volume';
      const volIn2 = document.createElement('input');
      volIn2.type = 'range';
      volIn2.min = '0';
      volIn2.max = '100';
      volIn2.step = '1';
      volIn2.value = String(Math.round(clamp(Number(layer.volume) || 0, 0, 1) * 100));
      volCtl.appendChild(volLab);
      volCtl.appendChild(volIn2);
      shell.body.appendChild(volCtl);

      // Pan
      const panCtl = document.createElement('div');
      panCtl.className = 'control';
      const panLab = document.createElement('label');
      panLab.textContent = 'Pan ';
      const panVal2 = document.createElement('span');
      panVal2.className = 'rg-range-readout';
      panVal2.textContent = fmtPan1(layer.pan);
      panLab.appendChild(panVal2);
      const panIn2 = document.createElement('input');
      panIn2.type = 'range';
      panIn2.min = '-1';
      panIn2.max = '1';
      panIn2.step = '0.1';
      panIn2.value = fmtPan1(layer.pan);
      panCtl.appendChild(panLab);
      panCtl.appendChild(panIn2);
      shell.body.appendChild(panCtl);

      // Depth
      const depthCtl = document.createElement('div');
      depthCtl.className = 'control';
      const depthLab = document.createElement('label');
      depthLab.textContent = 'Depth ';
      const depthVal2 = document.createElement('span');
      depthVal2.className = 'rg-range-readout';
      depthVal2.textContent = fmtDepth2(layer.depth);
      depthLab.appendChild(depthVal2);
      const depthIn2 = document.createElement('input');
      depthIn2.type = 'range';
      depthIn2.min = '0';
      depthIn2.max = '1';
      depthIn2.step = '0.01';
      depthIn2.value = fmtDepth2(layer.depth);
      depthCtl.appendChild(depthLab);
      depthCtl.appendChild(depthIn2);
      shell.body.appendChild(depthCtl);

      // Variants (clone)
      const varCtl = cloneControlByChildId('droneVariantsAnchor', `_L${i + 1}`);
      if (varCtl) shell.body.appendChild(varCtl);

      const layerUpdateAndRefresh = () => {
        saveDroneLayersToLS();
        rebuildDroneLayersUI();
        if (state.droneOn) refreshAllDroneLayers();
      };

      if (typeSel) {
        typeSel.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.type = typeSel.value;
          // Reset density default for new type (Batch-2 defaults)
          layer.variants = coerceDroneLayerVariants({ ...layer.variants, density: defaultDroneDensityForType(layer.type) }, layer.type);
          layerUpdateAndRefresh();
        });
      }

      if (soundSel) {
        soundSel.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.soundType = (soundSel.value === 'synth') ? 'synth' : 'drone';
          if (layer.soundType === 'synth' && !(typeof layer.synthPreset === 'string' && layer.synthPreset.trim())) layer.synthPreset = 'tone_sine';
          layerUpdateAndRefresh();
        });
      }

      if (presetSel) {
        presetSel.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.synthPreset = presetSel.value;
          layerUpdateAndRefresh();
        });
      }

      if (ciInput) {
        const onCICommit = () => {
          ensureDroneLayersState();
          layer.customIntervals = String(ciInput.value || '');
          layerUpdateAndRefresh();
        };
        ciInput.addEventListener('change', onCICommit);
        ciInput.addEventListener('blur', onCICommit);
        ciInput.addEventListener('keydown', (e) => {
          if (e && e.key === 'Enter') { try { e.preventDefault(); } catch (_) {} onCICommit(); }
        });
      }

      followBtn.addEventListener('click', () => {
        ensureDroneLayersState();
        layer.followBellKey = !layer.followBellKey;
        layerUpdateAndRefresh();
      });

      if (keySel) {
        keySel.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.key = keySel.value;
          layer.customHzEnabled = (layer.key === 'custom_hz');
          layerUpdateAndRefresh();
        });
      }
      if (regSel) {
        regSel.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.register = clamp(Number(regSel.value) || 3, 1, 6);
          layerUpdateAndRefresh();
        });
      }

      const onHzCommit = () => {
        ensureDroneLayersState();
        layer.customHz = coerceCustomHz(hzInput && hzInput.value, layer.customHz);
        if (hzSlider) hzSlider.value = String(layer.customHz);
        layerUpdateAndRefresh();
      };
      if (hzInput) hzInput.addEventListener('change', onHzCommit);
      if (hzSlider) hzSlider.addEventListener('input', () => {
        if (!hzInput) return;
        hzInput.value = hzSlider.value;
      });
      if (hzSlider) hzSlider.addEventListener('change', onHzCommit);

      volIn2.addEventListener('input', () => {
        ensureDroneLayersState();
        layer.volume = clamp(Number(volIn2.value) / 100, 0, 1);
        saveDroneLayersToLS();
        if (state.droneOn) refreshAllDroneLayers();
      });
      panIn2.addEventListener('input', () => {
        ensureDroneLayersState();
        layer.pan = clamp(Number(panIn2.value), -1, 1);
        try { panVal2.textContent = fmtPan1(layer.pan); } catch (_) {}
        saveDroneLayersToLS();
        if (state.droneOn) refreshAllDroneLayers();
      });

      depthIn2.addEventListener('input', () => {
        ensureDroneLayersState();
        layer.depth = clamp(Number(depthIn2.value), 0, 1);
        try { depthVal2.textContent = fmtDepth2(layer.depth); } catch (_) {}
        saveDroneLayersToLS();
        if (state.droneOn) refreshAllDroneLayers();
      });

      // Variants controls inside cloned section
      if (varCtl) {
        const densEl = varCtl.querySelector(`#droneDensity_L${i + 1}`);
        const driftEl = varCtl.querySelector(`#droneDriftCents_L${i + 1}`);
        const motionEl = varCtl.querySelector(`#droneMotionRate_L${i + 1}`);
        const cwEl = varCtl.querySelector(`#droneClusterWidth_L${i + 1}`);
        const ntEl = varCtl.querySelector(`#droneNoiseTilt_L${i + 1}`);
        const nqEl = varCtl.querySelector(`#droneNoiseQ_L${i + 1}`);
        const normEl = varCtl.querySelector(`#droneNormalizeBtn_L${i + 1}`);

        // Set initial values + max density based on type
        if (densEl) {
          densEl.max = String(maxDroneDensityForType(layer.type));
          densEl.value = String(clampDroneDensityForType(layer.type, layer.variants.density));
        }
        if (driftEl) driftEl.value = String(clamp(Number(layer.variants.driftCents) || 0, 0, 20));
        if (motionEl) motionEl.value = String(clamp(Number(layer.variants.motionRate) || 0, 0, 10));
        if (cwEl) cwEl.value = String(coerceDroneClusterWidth(layer.variants.clusterWidth));
        if (ntEl) ntEl.value = String(clamp(Number(layer.variants.noiseTilt) || 0, -1, 1));
        if (nqEl) nqEl.value = String(clamp(Number(layer.variants.noiseQ) || 1, 0.5, 10));
        if (normEl) {
          if (layer.variants.normalize) {
            normEl.classList.add('active');
            normEl.setAttribute('aria-pressed', 'true');
            normEl.textContent = 'On';
          } else {
            normEl.classList.remove('active');
            normEl.setAttribute('aria-pressed', 'false');
            normEl.textContent = 'Off';
          }
        }

        // Visibility based on type family
        const fam = droneTypeFamily(layer.type);
        const motionCtl = varCtl.querySelector(`#droneVariantMotionControl_L${i + 1}`);
        const clusterCtl = varCtl.querySelector(`#droneVariantClusterControl_L${i + 1}`);
        const ntCtl = varCtl.querySelector(`#droneVariantNoiseTiltControl_L${i + 1}`);
        const nqCtl = varCtl.querySelector(`#droneVariantNoiseQControl_L${i + 1}`);
        if (motionCtl) motionCtl.classList.toggle('hidden', layer.type !== 'shepard');
        if (clusterCtl) clusterCtl.classList.toggle('hidden', fam !== 'cluster');
        if (ntCtl) ntCtl.classList.toggle('hidden', fam !== 'noise');
        if (nqCtl) nqCtl.classList.toggle('hidden', fam !== 'noise');

        if (normEl) normEl.addEventListener('click', () => {
          ensureDroneLayersState();
          layer.variants.normalize = !layer.variants.normalize;
          layerUpdateAndRefresh();
        });
        if (densEl) densEl.addEventListener('input', () => {
          ensureDroneLayersState();
          layer.variants.density = clampDroneDensityForType(layer.type, densEl.value);
          saveDroneLayersToLS();
          if (state.droneOn) refreshAllDroneLayers();
        });
        if (driftEl) driftEl.addEventListener('input', () => {
          ensureDroneLayersState();
          layer.variants.driftCents = clamp(Number(driftEl.value) || 0, 0, 20);
          saveDroneLayersToLS();
          if (state.droneOn) syncDroneModTimer();
        });
        if (motionEl) motionEl.addEventListener('input', () => {
          ensureDroneLayersState();
          layer.variants.motionRate = clamp(Number(motionEl.value) || 0, 0, 10);
          saveDroneLayersToLS();
          if (state.droneOn) syncDroneModTimer();
        });
        if (cwEl) cwEl.addEventListener('change', () => {
          ensureDroneLayersState();
          layer.variants.clusterWidth = coerceDroneClusterWidth(cwEl.value);
          layerUpdateAndRefresh();
        });
        if (ntEl) ntEl.addEventListener('input', () => {
          ensureDroneLayersState();
          layer.variants.noiseTilt = clamp(Number(ntEl.value) || 0, -1, 1);
          saveDroneLayersToLS();
          if (state.droneOn) refreshAllDroneLayers();
        });
        if (nqEl) nqEl.addEventListener('input', () => {
          ensureDroneLayersState();
          layer.variants.noiseQ = clamp(Number(nqEl.value) || 1, 0.5, 10);
          saveDroneLayersToLS();
          if (state.droneOn) refreshAllDroneLayers();
        });
      }
    }
  }
}


  
function syncDroneModTimer() {
    // v014_p04_multi_drone_layers: mod tick if any active layer needs drift and/or motion.
    if (droneModTimer) {
      clearInterval(droneModTimer);
      droneModTimer = null;
    }

    if (!state.droneOn || state.dronePaused || !audioCtx) return;

    ensureDroneLayersState();
    const layers = state.droneLayers || [];
    let needs = false;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const cur = droneLayerCurrents && droneLayerCurrents[i];
      if (!layer || !cur || layer.muted) continue;

      const driftMax = clamp(Number(layer.variants && layer.variants.driftCents) || 0, 0, 20);
      const motionRate = clamp(Number(cur.effectiveMotionRate ?? (layer.variants && layer.variants.motionRate)) || 0, 0, 10);
      const needsMotion = (cur.type === 'shepard') && motionRate > 0;

      if (driftMax > 0 || needsMotion) { needs = true; break; }
    }

    if (needs) {
      droneModTimer = setInterval(droneModTick, DRONE_MOD_TICK_MS);
    }
  }



  
function droneModTick() {
    if (!state.droneOn || state.dronePaused || !audioCtx) {
      syncDroneModTimer();
      return;
    }

    ensureDroneLayersState();
    const layers = state.droneLayers || [];
    if (!droneLayerCurrents || droneLayerCurrents.length === 0) {
      syncDroneModTimer();
      return;
    }

    const now = audioCtx.currentTime;

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const cur = droneLayerCurrents[li];
      if (!layer || !cur || layer.muted) continue;

      const voices = cur.voices || [];
      if (!voices.length) continue;

      const driftMax = clamp(Number(layer.variants && layer.variants.driftCents) || 0, 0, 20);

      const motionRate = clamp(Number(cur.effectiveMotionRate ?? (layer.variants && layer.variants.motionRate)) || 0, 0, 10);
      const doMotion = (cur.type === 'shepard') && motionRate > 0;
      if (driftMax <= 0 && !doMotion) continue;

      const last = cur.modLastTime || now;
      const dt = clamp(now - last, 0, 0.5);
      cur.modLastTime = now;

      // Motion: map 0..10 -> 0..0.2 Hz (same as legacy)
      if (doMotion) {
        const rateHz = motionRate * 0.02;
        cur.motionPhase = (cur.motionPhase || 0) + (2 * Math.PI * rateHz * dt);
      }

      const depth = doMotion ? 25 : 0;
      const phase = cur.motionPhase || 0;

      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (!v || !v.osc) continue;

        // Drift: slow random walk in cents
        if (driftMax > 0) {
          const step = (Math.random() * 2 - 1) * driftMax * 0.015;
          v.drift = clamp((v.drift || 0) + step, -driftMax, driftMax);
        } else {
          v.drift = 0;
        }

        // Shepard motion: phase-offset per voice
        v.motion = depth ? (depth * Math.sin(phase + i * 0.77)) : 0;

        const target = (v.baseDetune || 0) + (v.drift || 0) + (v.motion || 0);
        try {
          v.osc.detune.setTargetAtTime(target, now, 0.18);
        } catch (_) {}
        if (v.modOsc && v.modOsc.detune) {
          try { v.modOsc.detune.setTargetAtTime(target, now, 0.18); } catch (_) {}
        }
      }
    }

    // If nothing needs modulation anymore, stop the timer.
    syncDroneModTimer();
  }


  function syncDroneOnOffUI() {
    if (droneOnOffBtn) {
      droneOnOffBtn.textContent = state.droneOn ? 'Drone Off' : 'Drone On';
      droneOnOffBtn.classList.toggle('active', !!state.droneOn);
      try { droneOnOffBtn.setAttribute('aria-pressed', state.droneOn ? 'true' : 'false'); } catch (_) {}
    }

    // Game-screen pause button visibility + label (and safety reset while off).
    syncDronePauseBtnUI();
  }

  
function setDroneOn(on) {
    // v014_p04_multi_drone_layers: global toggle for the whole drone bus.
    const next = !!on;
    if (state.droneOn === next) return;

    state.droneOn = next;
    state.dronesEnabled = next;
    safeSetBoolLS(LS_DRONE_ON, next);

    // Unpause whenever master is toggled (legacy behavior).
    state.dronePaused = false;
    state.dronesPaused = false;

    // Persist layered structure.
    saveDroneLayersToLS();

    if (state.droneOn) {
      startDrone();
    } else {
      stopDrone();
    }

    syncDroneOnOffUI();
    syncDronePauseBtnUI();
  }


  function syncDronePauseBtnUI() {
    if (!dronePauseBtn) return;

    if (!state.droneOn) {
      state.dronePaused = false;
      dronePauseBtn.classList.add('hidden');
      dronePauseBtn.disabled = true;
      dronePauseBtn.textContent = 'Pause Drone';
      return;
    }

    dronePauseBtn.classList.remove('hidden');
    dronePauseBtn.disabled = false;
    dronePauseBtn.textContent = state.dronePaused ? 'Resume Drone' : 'Pause Drone';
  }

  
function toggleDronePaused() {
    if (!state.droneOn) return;

    const wasPaused = !!state.dronePaused;
    state.dronePaused = !wasPaused;
    state.dronesPaused = state.dronePaused;

    // Safety: if drones are on but graphs don't exist, rebuild before resuming.
    if (!state.dronePaused && state.droneOn) {
      const anyRunning = Array.isArray(droneLayerCurrents) && droneLayerCurrents.some(Boolean);
      if (!anyRunning) {
        try { startDrone(); } catch (_) {}
      }
    }

    saveDroneLayersToLS();
    applyDroneMasterGain();
    syncDronePauseBtnUI();
    syncDroneModTimer();
  }



  function getScaleDefByKey(key) {
    return SCALE_LIBRARY.find(s => s.key === key) || SCALE_LIBRARY[0];
  }

  function getBellRootFrequency() {
    if (state.scaleKey === 'custom_hz') {
      let f = parseFloat(state.bellCustomHz);
      if (!Number.isFinite(f)) f = 440;
      f = Math.min(Math.max(f, 20), 4000);
      return f;
    }

    const def = getScaleDefByKey(state.scaleKey);
    const rootMidi = noteToMidi(def.root, state.octaveC);
    return midiToFreq(rootMidi);
  }

  function getDroneRootFrequency() {
    if (state.droneScaleKey === 'custom_hz') {
      let f = parseFloat(state.droneCustomHz);
      if (!Number.isFinite(f)) f = 440;
      f = Math.min(Math.max(f, 20), 4000);
      return f;
    }

    const def = getScaleDefByKey(state.droneScaleKey);
    const rootMidi = noteToMidi(def.root, state.droneOctaveC);
    return midiToFreq(rootMidi);
  }

  function coerceCustomHz(raw, fallbackHz) {
    let f = parseFloat(raw);
    if (!Number.isFinite(f)) f = fallbackHz;
    return clamp(f, 20, 4000);
  }

  function syncBellCustomHzUI() {
    const on = state.scaleKey === 'custom_hz';
    const f = coerceCustomHz(state.bellCustomHz, 440);
    state.bellCustomHz = f;
    if (bellCustomHzInput) {
      bellCustomHzInput.value = String(f);
      bellCustomHzInput.disabled = !on;
    }
    if (bellCustomHzSlider) {
      bellCustomHzSlider.value = String(f);
      bellCustomHzSlider.disabled = !on;
    }
  }

  function syncDroneCustomHzUI() {
    const on = state.droneScaleKey === 'custom_hz';
    const f = coerceCustomHz(state.droneCustomHz, 440);
    state.droneCustomHz = f;
    if (droneCustomHzInput) {
      droneCustomHzInput.value = String(f);
      droneCustomHzInput.disabled = !on;
    }
    if (droneCustomHzSlider) {
      droneCustomHzSlider.value = String(f);
      droneCustomHzSlider.disabled = !on;
    }
  }

  
function setBellCustomHzFromUI(raw, commit) {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      if (!commit) return;
    }
    const f = coerceCustomHz(raw, 440);
    state.bellCustomHz = f;
    if (bellCustomHzSlider) bellCustomHzSlider.value = String(f);
    if (commit && bellCustomHzInput) bellCustomHzInput.value = String(f);
    if (state.scaleKey === 'custom_hz') {
      rebuildBellFrequencies();
      onBellTuningChanged();
      syncBellPitchSummaryUI();

      // v014_p04_multi_drone_layers: refresh any drone layers that follow the bell key.
      if (state.droneOn) refreshDrone();
    }
  }



  
function setDroneCustomHzFromUI(raw, commit) {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      if (!commit) return;
    }
    const f = coerceCustomHz(raw, 440);
    state.droneCustomHz = f;
    if (droneCustomHzSlider) droneCustomHzSlider.value = String(f);
    if (commit && droneCustomHzInput) droneCustomHzInput.value = String(f);

    // v014_p04_multi_drone_layers: keep Layer 1 + layers persistence in sync.
    syncLayer1FromLegacyDroneState();
    saveDroneLayersToLS();
    rebuildDroneLayersUI();

    if (state.droneScaleKey === 'custom_hz' && state.droneOn) refreshDrone();
  }




  function getNoiseBuffer() {
    ensureAudio();
    if (noiseBuffer && noiseBufferSampleRate === audioCtx.sampleRate) return noiseBuffer;

    const seconds = 2.0;
    const len = Math.max(1, Math.floor(audioCtx.sampleRate * seconds));
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    noiseBuffer = buf;
    noiseBufferSampleRate = audioCtx.sampleRate;
    return noiseBuffer;
  }

  
function stopDrone() {
    // v014_p04_multi_drone_layers: stop all layers (each fades out) and clear the shared pointer.
    stopAllDroneLayers();

    // v014_p02_drone_variant_knobs: stop modulation timer
    syncDroneModTimer();
  }



  

  function computeDroneSpec(type, f, nyquist, variants) {
    const MIN_F = 20;
    const MAX_F = Math.max(MIN_F, nyquist * 0.9);
    const clampVoiceFreq = (hz) => clamp(hz, MIN_F, MAX_F);
    const et = (semi) => Math.pow(2, semi / 12);

    // v014_p02_drone_variant_knobs: variant knobs
    const v = (variants && typeof variants === 'object') ? variants : null;
    const density = v ? clampDroneDensityForType(type, v.density) : getDroneDensityForType(type);
    const clusterWidth = coerceDroneClusterWidth(v ? v.clusterWidth : state.droneClusterWidth);
    const noiseTilt = clamp(Number(v ? v.noiseTilt : state.droneNoiseTilt) || 0, -1, 1);
    const noiseQ = clamp(Number(v ? v.noiseQ : state.droneNoiseQ) || 1, 0.5, 10);

    function tonal(ratios, weights, detunes, wave, level) {
      const n = ratios.length;
      const out = new Array(n);
      let sumW = 0;

      for (let i = 0; i < n; i++) {
        const ratio = ratios[i];
        const rawFreq = f * ratio;

        let w = (weights && weights[i] != null) ? weights[i] : 1;
        if (!Number.isFinite(w) || w < 0) w = 0;

        // If raw is outside usable range, exclude from normalization
        if (!Number.isFinite(rawFreq) || rawFreq < MIN_F || rawFreq > MAX_F) w = 0;

        const det = (detunes && detunes[i] != null && Number.isFinite(detunes[i])) ? detunes[i] : 0;

        out[i] = {
          wave: wave || 'sine',
          f: clampVoiceFreq(Number.isFinite(rawFreq) ? rawFreq : f),
          g: 0,
          // legacy aliases (pre multi-layer refactor)
          freq: clampVoiceFreq(Number.isFinite(rawFreq) ? rawFreq : f),
          amp: 0,
          detune: det,
          _w: w
        };
        sumW += w;
      }

      if (sumW <= 0) {
        // Fallback: pick the middle voice
        const mid = Math.floor(n / 2);
        out[mid]._w = 1;
        sumW = 1;
      }

      for (let i = 0; i < n; i++) {
        out[i].amp = level * (out[i]._w / sumW);
        out[i].g = out[i].amp;
        delete out[i]._w;
      }

      return out;
    }

    function noiseSpec(opts) {
      const gain = opts && Number.isFinite(opts.gain) ? opts.gain : DRONE_NOISE_LEVEL;
      const baseLP = clampVoiceFreq(f * 2);
      const lpFreq = clampVoiceFreq(baseLP * Math.pow(2, noiseTilt * 1.7));
      const lpQ = noiseQ;

      const peakOn = !!(opts && opts.peak);
      const peak = peakOn ? {
        freq: clampVoiceFreq(f),
        Q: (opts.peak && Number.isFinite(opts.peak.Q)) ? opts.peak.Q : 4.0,
        gainDb: (opts.peak && Number.isFinite(opts.peak.gainDb)) ? opts.peak.gainDb : 6
      } : null;

      return {
        // fields consumed by v014_p04_multi_drone_layers (start/refresh)
        lpHz: lpFreq,
        lpQ,
        g: gain,
        peakHz: peak ? peak.freq : 0,
        peakQ: peak ? peak.Q : 0,
        peakGain: peak ? peak.gainDb : 0,
        // legacy aliases (older single-drone code paths)
        lpFreq,
        gain,
        peak
      };
    }

    switch (type) {
      case 'single':
        return { kind: 'tonal', voices: tonal([1], [1], [0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'octaves':
        return { kind: 'tonal', voices: tonal([0.5, 1, 2], [0.7, 1.0, 0.7], [0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'root5':
        return { kind: 'tonal', voices: tonal([1, et(7)], [1.0, 0.85], [0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'fifth':
        return { kind: 'tonal', voices: tonal([1, et(7), 2], [1, 1, 1], [0, 2, -2], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'majtriad':
        return { kind: 'tonal', voices: tonal([1, et(4), et(7)], [1.0, 0.9, 0.85], [0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'mintriad':
        return { kind: 'tonal', voices: tonal([1, et(3), et(7)], [1.0, 0.9, 0.85], [0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'seventh':
        return { kind: 'tonal', voices: tonal([1, et(4), et(7), et(11)], [1, 1, 1, 1], [0, -2, 1, 2], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'custom': {
        const raw = (v && v.customIntervals != null) ? v.customIntervals : null;
        const parsed = parseCustomDroneIntervalsText(raw, DRONE_VOICE_CAP || 16);
        const semis = (parsed && Array.isArray(parsed.vals) && parsed.vals.length) ? parsed.vals : [0];

        const ratios = [];
        const weights = [];
        const detunes = [];
        for (let i = 0; i < semis.length; i++) {
          const s = clamp(Number(semis[i]) || 0, -36, 36);
          ratios.push(et(s));
          weights.push(1 / (1 + Math.abs(s) / 24));
          detunes.push(0);
        }
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'harm4': {
        const d = clamp(density, 1, Math.min(12, DRONE_VOICE_CAP));
        const ratios = [];
        const weights = [];
        const detunes = [];
        const baseW = [1.0, 0.6, 0.4, 0.3];
        for (let p = 1; p <= d; p++) {
          ratios.push(p);
          weights.push(p <= baseW.length ? baseW[p - 1] : (1 / p));
          detunes.push(0);
        }
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'harm6': {
        const d = clamp(density, 1, Math.min(12, DRONE_VOICE_CAP));
        const ratios = [];
        const weights = [];
        const detunes = [];
        const baseW = [1.0, 0.7, 0.5, 0.4, 0.3, 0.25];
        for (let p = 1; p <= d; p++) {
          ratios.push(p);
          weights.push(p <= baseW.length ? baseW[p - 1] : (1 / p));
          detunes.push(0);
        }
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'oddharm': {
        const d = clamp(density, 1, Math.min(12, DRONE_VOICE_CAP));
        const ratios = [];
        const weights = [];
        const detunes = [];
        const baseW = [1.0, 0.7, 0.5, 0.4];
        for (let i = 0; i < d; i++) {
          const odd = 1 + i * 2;
          ratios.push(odd);
          weights.push(i < baseW.length ? baseW[i] : (1 / odd));
          detunes.push(0);
        }
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'shepard': {
        const d = clamp(density, 1, Math.max(1, Math.floor((DRONE_VOICE_CAP - 1) / 2)));
        const ratios = [];
        const weights = [];
        const detunes = [];
        const sigma = 1.05;
        for (let k = -d; k <= d; k++) {
          ratios.push(Math.pow(2, k));
          const x = k / (Math.max(1, d) * sigma);
          weights.push(Math.exp(-0.5 * x * x));
        }
        const n = ratios.length;
        for (let i = 0; i < n; i++) detunes.push(n <= 1 ? 0 : ((i / (n - 1)) * 9 - 4.5));
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'cluster': {
        const W = clamp(clusterWidth, 1, 5);
        const d = clamp(density, 1, Math.max(1, Math.floor((DRONE_VOICE_CAP - 1) / 2)));

        const allKs = [];
        for (let k = -W; k <= W; k++) allKs.push(k);

        const fullWeights =
          (W === 1) ? [0.75, 1.0, 0.75] :
          (W === 2) ? [0.5, 0.75, 1.0, 0.75, 0.5] :
          (W === 3) ? [0.35, 0.5, 0.75, 1.0, 0.75, 0.5, 0.35] :
          [0.3, 0.4, 0.55, 0.7, 0.85, 1.0, 0.85, 0.7, 0.55, 0.4, 0.3];

        const total = allKs.length;
        const want = clamp(Math.min(total, (2 * d + 1)), 1, DRONE_VOICE_CAP);

        const ratios = [];
        const weights = [];
        const detunes = [];

        if (want >= total) {
          for (let i = 0; i < total; i++) {
            ratios.push(et(allKs[i]));
            weights.push(fullWeights[i] || 1);
            detunes.push(0);
          }
        } else {
          const used = new Set();
          for (let i = 0; i < want; i++) {
            const idx = (want <= 1) ? Math.floor((total - 1) / 2) : Math.round(i * (total - 1) / (want - 1));
            let j = clamp(idx, 0, total - 1);
            while (used.has(j) && j < total - 1) j++;
            while (used.has(j) && j > 0) j--;
            used.add(j);
            ratios.push(et(allKs[j]));
            weights.push(fullWeights[j] || 1);
            detunes.push(0);
          }
        }

        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'noise':
        return { kind: 'noise', voices: [], noise: noiseSpec({ gain: DRONE_NOISE_LEVEL }) };

      case 'resnoise':
        return { kind: 'noise', voices: [], noise: noiseSpec({ gain: DRONE_NOISE_LEVEL, peak: { Q: 4.0, gainDb: 6 } }) };

      case 'noisetone': {
        const maxTonal = Math.max(1, DRONE_VOICE_CAP - 1);
        const d = clamp(density, 1, Math.min(8, maxTonal));
        const ratios = [];
        const weights = [];
        const detunes = [];
        for (let p = 1; p <= d; p++) {
          ratios.push(p);
          weights.push(p === 1 ? 1.0 : (1 / p));
          detunes.push(0);
        }
        return {
          kind: 'hybrid',
          voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL * 0.25),
          noise: noiseSpec({ gain: DRONE_NOISE_LEVEL * 0.75 })
        };
      }

      default:
        return { kind: 'none', voices: [], noise: null };
    }
  }


  
function startDrone() {
    // v014_p04_multi_drone_layers: start/refresh all layers.
    if (!state.droneOn) {
      stopDrone();
      return;
    }

    ensureDroneLayersState();
    if (!audioCtx || !droneMasterGain) ensureAudio();
    if (!audioCtx || !droneMasterGain) return;

    applyDroneMasterGain();
    refreshAllDroneLayers();
  }




  
function refreshDrone() {
    // v014_p04_multi_drone_layers: refresh all layers (and enforce caps).
    if (!state.droneOn) return;
    refreshAllDroneLayers();
  }


  function fitCanvas(el, ctx) {
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { W: rect.width, H: rect.height };
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // === Methods ===
  function applyX(row, stage) {
    const next = row.slice();
    for (let i = 0; i < stage - 1; i += 2) { const tmp = next[i]; next[i] = next[i+1]; next[i+1] = tmp; }
    return next;
  }
  function applyY(row, stage) {
    const next = row.slice();
    for (let i = 1; i < stage - 1; i += 2) { const tmp = next[i]; next[i] = next[i+1]; next[i+1] = tmp; }
    return next;
  }
  function makePlainHunt(stage, leads) {
    const rows = [];
    let current = [];
    for (let i = 1; i <= stage; i++) current.push(i);
    rows.push(current.slice());
    let useX = true;
    const steps = stage * 2 * leads;
    for (let i = 0; i < steps; i++) {
      current = useX ? applyX(current, stage) : applyY(current, stage);
      rows.push(current.slice());
      useX = !useX;
    }
    return rows;
  }
  function rotateRow(row, k) {
    const n = row.length;
    const off = ((k % n) + n) % n;
    return row.slice(off).concat(row.slice(0, off));
  }
  function makeLibraryRows(name, stage) {
    const base = makePlainHunt(stage, 5);
    if (name === 'plainbob') return base.map((r, i) => rotateRow(r, i % stage));
    if (name === 'grandsire') return base.map((r, i) => rotateRow(r, (i * 2) % stage));
    return base;
  }
  function parseCustom(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const rows = [];
    let stage = null;

    function charToBell(ch) {
      return glyphToBell(ch);
    }

    for (const line of lines) {
      if (!/^[1-90EeTt]+$/.test(line)) continue;
      const nums = line.split('').map(c => charToBell(c)).filter(v => v != null);
      if (stage == null) stage = nums.length;
      if (nums.length !== stage) throw new Error('All rows must have the same number of bells.');
      rows.push(nums);
    }
    if (!rows.length) throw new Error('No valid rows found in file.');
    if (stage < 4 || stage > 12) throw new Error('Unsupported bell count in file.');
    return { rows, stage };
  }

  function computeRows() {
    if (state.method === 'custom' && state.customRows) state.rows = state.customRows.slice();
    else state.rows = makeLibraryRows(state.method, state.stage);

    // v09_p01_home_logo_step_method: reset Home logo method-step pointer when rows rebuild.
    homeMethodStepIndex = 0;

    // v06_p12a_notation_paging_arrows: reset paging on row rebuild
    ui.notationFollow = true;
    ui.notationPage = 0;
    syncNotationPagingUI();
  }


  function cccbGetElements(root, localName) {
    if (!root || !localName) return [];
    if (typeof root.getElementsByTagNameNS === 'function') {
      try {
        const els = root.getElementsByTagNameNS('*', localName);
        if (els && els.length) return els;
      } catch (_) {}
    }
    if (typeof root.getElementsByTagName === 'function') {
      return root.getElementsByTagName(localName);
    }
    return [];
  }

  function cccbFirstText(root, names) {
    if (!root) return '';
    const arr = Array.isArray(names) ? names : [names];
    for (let i = 0; i < arr.length; i++) {
      const localName = arr[i];
      const els = cccbGetElements(root, localName);
      if (els && els[0] && els[0].textContent != null) {
        const txt = String(els[0].textContent).trim();
        if (txt) return txt;
      }
    }
    return '';
  }

  function cccbFamilyFromFilename(filename) {
    let name = (filename == null ? '' : String(filename)).trim();
    if (!name) return '';
    let lower = name.toLowerCase();
    if (lower.endsWith('.zip')) {
      name = name.slice(0, -4);
      lower = name.toLowerCase();
    }
    if (lower.endsWith('.xml')) {
      name = name.slice(0, -4);
    }
    return name;
  }

  function parseCCCBR(xmlText, filename) {
    let text = xmlText == null ? '' : String(xmlText);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let doc;
    try {
      const parser = new DOMParser();
      doc = parser.parseFromString(text, 'application/xml');
    } catch (err) {
      console.error('CCCBR XML parse error', filename, err);
      alert('Could not parse XML in ' + (filename || 'file') + '.');
      return 0;
    }

    if (!doc || !doc.documentElement) {
      alert('Empty XML document in ' + (filename || 'file') + '.');
      return 0;
    }

    const perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) {
      console.error('CCCBR XML parsererror', filename, perr[0] && perr[0].textContent);
      alert('Could not parse XML in ' + (filename || 'file') + '.');
      return 0;
    }

    const family = cccbFamilyFromFilename(filename);
    const methodEls = cccbGetElements(doc, 'method');
    if (!methodEls || !methodEls.length) {
      alert('No <method> entries found in ' + (filename || 'file') + '.');
      return 0;
    }

    let added = 0;

    for (let i = 0; i < methodEls.length; i++) {
      const mEl = methodEls[i];

      const title = cccbFirstText(mEl, ['title', 'name']) || 'Untitled';
      const pnRaw = cccbFirstText(mEl, ['pn', 'notation', 'placeNotation']);
      const lh = cccbFirstText(mEl, ['lh', 'leadHead']);

      let stageText = cccbFirstText(mEl, 'stage');
      let classText = cccbFirstText(mEl, ['class', 'classification']);

      

      let leadLenText = cccbFirstText(mEl, 'lengthOfLead');if (!stageText || !classText || !leadLenText) {
        let cur = mEl.parentElement;
        while (cur && cur.nodeType === 1) {
          const props = cccbGetElements(cur, 'properties');
          for (let j = 0; j < props.length; j++) {
            const p = props[j];
            if (p.parentNode !== cur) continue;
            if (!stageText) {
              const st = cccbFirstText(p, 'stage');
              if (st) stageText = st;
            }
            if (!classText) {
              const cl = cccbFirstText(p, ['class', 'classification']);
              if (cl) classText = cl;
            }
            if (!leadLenText) {
              const ll = cccbFirstText(p, 'lengthOfLead');
              if (ll) leadLenText = ll;
            }
          }
          if (stageText && classText && leadLenText) break;
          cur = cur.parentElement;
        }
      }

      let stageNum = parseInt(stageText, 10);
      if (!isFinite(stageNum)) continue;
      stageNum = clamp(stageNum, 1, 16);
      if (stageNum < 4 || stageNum > 12) continue;

      let lengthOfLead = parseInt(leadLenText, 10);
      if (!isFinite(lengthOfLead) || lengthOfLead <= 0) lengthOfLead = undefined;

      let pnNorm = pnRaw == null ? '' : String(pnRaw);
      pnNorm = pnNorm.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
      pnNorm = pnNorm.replace(/\s*,\s*/g, ',');

      const methodObj = {
        title: title,
        class: classText || '',
        stage: stageNum,
        lengthOfLead: lengthOfLead,
        pn: pnNorm,
        lh: lh || '',
        family: family
      };

      RG.methods.push(methodObj);
      added += 1;
    }

    if (!added) {
      alert('No supported 4–12 bell methods found in ' + (filename || 'file') + '.');
      return 0;
    }

    refreshMethodList();
    return added;
  }

  // v012_p03_setup_method_block_sources_dropdown: parse a single CCCBR-style method XML.
  // Best-effort: expects one <method> element containing stage and place notation (pn).
  // Throws on errors; caller must keep current method unchanged on failure.
  function parseCCCBRSingleMethod(xmlText, filename) {
    let text = xmlText == null ? '' : String(xmlText);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let doc;
    try {
      const parser = new DOMParser();
      doc = parser.parseFromString(text, 'application/xml');
    } catch (err) {
      throw new Error('Could not parse XML.');
    }

    if (!doc || !doc.documentElement) {
      throw new Error('Empty XML document.');
    }

    const perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) {
      console.error('Method XML parsererror', filename, perr[0] && perr[0].textContent);
      throw new Error('Could not parse XML.');
    }

    const methodEls = cccbGetElements(doc, 'method');
    if (!methodEls || !methodEls.length) {
      throw new Error('No <method> entry found.');
    }

    const mEl = methodEls[0];
    const title = cccbFirstText(mEl, ['title', 'name']) || 'Untitled';
    const pnRaw = cccbFirstText(mEl, ['pn', 'notation', 'placeNotation']);

    let stageText = cccbFirstText(mEl, 'stage');
    if (!stageText) {
      let cur = mEl.parentElement;
      while (cur && cur.nodeType === 1) {
        const props = cccbGetElements(cur, 'properties');
        for (let j = 0; j < props.length; j++) {
          const p = props[j];
          if (p.parentNode !== cur) continue;
          const st = cccbFirstText(p, 'stage');
          if (st) stageText = st;
        }
        if (stageText) break;
        cur = cur.parentElement;
      }
    }

    let stageNum = parseInt(stageText, 10);
    if (!isFinite(stageNum)) {
      throw new Error('Could not read stage (bell count) from method XML.');
    }
    stageNum = clamp(stageNum, 1, 16);
    if (stageNum < 4 || stageNum > 12) {
      throw new Error('Only 4–12 bell methods are supported in this game.');
    }

    let pnNorm = pnRaw == null ? '' : String(pnRaw);
    pnNorm = pnNorm.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
    pnNorm = pnNorm.replace(/\s*,\s*/g, ',');
    if (!pnNorm) {
      throw new Error('Could not read place notation (pn) from method XML.');
    }

    return { title: title, stage: stageNum, pn: pnNorm };
  }

  function cccbParsePnTokens(pn) {
    if (pn == null) return [];
    let raw = String(pn);
    raw = raw.replace(/;/g, ' ').replace(/[\r\n]+/g, ' ').trim();
    raw = raw.replace(/\s*,\s*/g, ',');
    if (!raw) return [];

    function tokenizeSide(sideRaw) {
      const parts = String(sideRaw || '').split(/[.\s]+/);
      const tokens = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;
        let buf = '';
        for (let j = 0; j < part.length; j++) {
          const ch = part[j];
          if (ch === 'x' || ch === 'X' || ch === '-') {
            if (buf) {
              tokens.push(buf);
              buf = '';
            }
            tokens.push('-');
          } else if (/[0-9A-Za-z]/.test(ch)) {
            buf += ch;
          }
        }
        if (buf) tokens.push(buf);
      }
      return tokens;
    }

    function expandPal(seq) {
      const base = (seq && seq.length) ? seq.slice() : [];
      if (base.length <= 1) return base;
      for (let i = base.length - 2; i >= 0; i--) base.push(base[i]);
      return base;
    }

    const commaIdx = raw.indexOf(',');
    if (commaIdx >= 0) {
      const left = raw.slice(0, commaIdx).trim();
      const right = raw.slice(commaIdx + 1).trim();
      const leftTokens = tokenizeSide(left);
      const rightTokens = tokenizeSide(right);
      return expandPal(leftTokens).concat(expandPal(rightTokens));
    }

    return tokenizeSide(raw);
  }

  function cccbPlacesFromToken(token, stage) {
    const places = [];
    if (!token || token === '-') return places;
    const s = String(token);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let place = null;
      if (ch >= '1' && ch <= '9') place = ch.charCodeAt(0) - '0'.charCodeAt(0);
      else if (ch === '0') place = 10;
      else if (ch === 'E' || ch === 'e') place = 11;
      else if (ch === 'T' || ch === 't') place = 12;
      if (place == null) continue;
      if (stage && place > stage) continue;
      if (places.indexOf(place) === -1) places.push(place);
    }
    places.sort(function(a, b) { return a - b; });
    return places;
  }

  function cccbApplyPn(row, stage, token) {
    const next = row.slice();
    const n = stage || row.length;
    if (token === '-') {
      for (let i = 0; i + 1 < n; i += 2) {
        const tmp = next[i];
        next[i] = next[i + 1];
        next[i + 1] = tmp;
      }
      return next;
    }

    const places = cccbPlacesFromToken(token, n);
    const placeSet = {};
    for (let i = 0; i < places.length; i++) placeSet[places[i]] = true;

    let i = 0;
    while (i < n) {
      const pos = i + 1;
      if (placeSet[pos]) {
        i += 1;
      } else {
        const nextPos = pos + 1;
        if (i + 1 < n && !placeSet[nextPos]) {
          const tmp = next[i];
          next[i] = next[i + 1];
          next[i + 1] = tmp;
          i += 2;
        } else {
          i += 1;
        }
      }
    }
    return next;
  }

  function cccbRowsFromPn(stage, pn, leads) {
    let s = parseInt(stage, 10);
    if (!isFinite(s) || s <= 1) return null;
    s = clamp(s, 2, 12);
    const tokens = cccbParsePnTokens(pn);
    if (!tokens.length) return null;
    let leadCount = parseInt(leads, 10);
    if (!isFinite(leadCount) || leadCount <= 0) leadCount = 5;
    leadCount = clamp(leadCount, 1, 20);

    const rows = [];
    let row = [];
    for (let i = 1; i <= s; i++) row.push(i);
    rows.push(row.slice());

    for (let l = 0; l < leadCount; l++) {
      for (let ti = 0; ti < tokens.length; ti++) {
        const tok = tokens[ti];
        row = cccbApplyPn(row, s, tok);
        rows.push(row.slice());
      }
    }
    return rows;
  }

  // v016_p02_library_play_full_cycle_sync: guardrails for CCCBR Library→Play/Demo generation (synchronous)
  const CCCBR_PLAY_MAX_ROWS = 20000;
  const CCCBR_PLAY_MAX_LEADS = 2000;

  // v016_p02_library_play_full_cycle_sync:
  // Full CCCBR "method" definition for Library Play/Demo:
  // - start at rounds
  // - repeat PN tokens lead-by-lead
  // - stop only when we return to the starting row at a LEAD BOUNDARY (tokenIdx wraps to 0)
  // - cap with explicit warning handled by caller (no silent truncation)
  function cccbRowsFromPnFullCycle(stage, pn, maxRows, maxLeads) {
    let s = parseInt(stage, 10);
    if (!isFinite(s) || s <= 1) return { rows: null, done: false, capped: false, capReason: '' };
    s = clamp(s, 2, 12);

    const tokens = cccbParsePnTokens(pn);
    if (!tokens.length) return { rows: null, done: false, capped: false, capReason: '' };

    let mr = parseInt(maxRows, 10);
    if (!isFinite(mr) || mr <= 0) mr = CCCBR_PLAY_MAX_ROWS;
    mr = clamp(mr, 10, 200000);

    let ml = parseInt(maxLeads, 10);
    if (!isFinite(ml) || ml <= 0) ml = CCCBR_PLAY_MAX_LEADS;
    ml = clamp(ml, 1, 50000);

    const startRow = [];
    for (let i = 1; i <= s; i++) startRow.push(i);

    const rows = [];
    let row = startRow.slice();
    rows.push(row.slice());

    let tokenIdx = 0;
    let leadsDone = 0;
    let done = false;
    let capped = false;
    let capReason = '';

    while (!done) {
      if (rows.length >= mr) { capped = true; capReason = 'maxRows'; break; }
      if (leadsDone >= ml) { capped = true; capReason = 'maxLeads'; break; }

      const tok = tokens[tokenIdx];
      row = cccbApplyPn(row, s, tok);
      rows.push(row.slice());

      tokenIdx += 1;
      if (tokenIdx >= tokens.length) {
        tokenIdx = 0;
        leadsDone += 1;

        // Complete cycle: back to the starting row at a lead boundary.
        if (rows.length > 1) {
          let same = true;
          for (let k = 0; k < startRow.length; k++) {
            if (row[k] !== startRow[k]) { same = false; break; }
          }
          if (same) done = true;
        }
      }
    }

    return { rows: rows, done: done, capped: capped, capReason: capReason, leadsDone: leadsDone };
  }

  // v016_p03_library_play_async_precompute: async chunked full-cycle generator (yields to UI; no mid-play streaming)
  async function cccbRowsFromPnFullCycleAsync(stage, pn, maxRows, maxLeads, opts) {
    let s = parseInt(stage, 10);
    if (!isFinite(s) || s <= 1) return { rows: null, done: false, capped: false, capReason: '' };
    s = clamp(s, 2, 12);

    const tokens = cccbParsePnTokens(pn);
    if (!tokens.length) return { rows: null, done: false, capped: false, capReason: '' };

    let mr = parseInt(maxRows, 10);
    if (!isFinite(mr) || mr <= 0) mr = CCCBR_PLAY_MAX_ROWS;
    mr = clamp(mr, 10, 200000);

    let ml = parseInt(maxLeads, 10);
    if (!isFinite(ml) || ml <= 0) ml = CCCBR_PLAY_MAX_LEADS;
    ml = clamp(ml, 1, 50000);

    const o = opts || {};
    let chunkRows = parseInt(o.chunkRows, 10);
    if (!isFinite(chunkRows) || chunkRows <= 0) chunkRows = 1500;
    chunkRows = clamp(chunkRows, 100, 50000);

    let chunkLeads = parseInt(o.chunkLeads, 10);
    if (!isFinite(chunkLeads) || chunkLeads <= 0) chunkLeads = 5000;
    chunkLeads = clamp(chunkLeads, 1, 50000);

    const onProgress = (typeof o.onProgress === 'function') ? o.onProgress : null;

    const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

    const startRow = [];
    for (let i = 1; i <= s; i++) startRow.push(i);

    const rows = [];
    let row = startRow.slice();
    rows.push(row.slice());

    let tokenIdx = 0;
    let leadsDone = 0;
    let done = false;
    let capped = false;
    let capReason = '';

    let rowsSinceYield = 0;
    let leadsSinceYield = 0;

    while (!done) {
      if (rows.length >= mr) { capped = true; capReason = 'maxRows'; break; }
      if (leadsDone >= ml) { capped = true; capReason = 'maxLeads'; break; }

      const tok = tokens[tokenIdx];
      row = cccbApplyPn(row, s, tok);
      rows.push(row.slice());
      rowsSinceYield += 1;

      tokenIdx += 1;
      if (tokenIdx >= tokens.length) {
        tokenIdx = 0;
        leadsDone += 1;
        leadsSinceYield += 1;

        // Complete cycle: back to the starting row at a lead boundary.
        if (rows.length > 1) {
          let same = true;
          for (let k = 0; k < startRow.length; k++) {
            if (row[k] !== startRow[k]) { same = false; break; }
          }
          if (same) done = true;
        }
      }

      if (rowsSinceYield >= chunkRows || leadsSinceYield >= chunkLeads) {
        if (onProgress) {
          try { onProgress({ rows: rows.length, leadsDone: leadsDone, done: done, capped: capped, capReason: capReason }); } catch (_) {}
        }
        rowsSinceYield = 0;
        leadsSinceYield = 0;
        await yieldToUi();
      }
    }

    if (onProgress) {
      try { onProgress({ rows: rows.length, leadsDone: leadsDone, done: done, capped: capped, capReason: capReason }); } catch (_) {}
    }

    return { rows: rows, done: done, capped: capped, capReason: capReason, leadsDone: leadsDone };
  }



  async function inflateZipDeflate(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream not supported');
    }
    const types = ['deflate-raw', 'deflate'];
    let lastErr = null;
    for (let i = 0; i < types.length; i++) {
      try {
        const ds = new DecompressionStream(types[i]);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const resp = new Response(stream);
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Could not decompress deflate stream');
  }

  async function parseZipArchive(file) {
    const name = file && file.name ? String(file.name) : '';
    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (err) {
      console.error('ZIP read failed', err);
      alert('Could not read ' + name + ': ' + (err && err.message ? err.message : err));
      return;
    }

    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const len = bytes.length;
    if (len < 22) {
      alert('Not a valid ZIP archive: ' + name);
      return;
    }

    const EOCD_SIG = 0x06054b50;
    const CEN_SIG = 0x02014b50;
    const maxComment = 65535;
    let eocdOffset = -1;
    const startSearch = Math.max(0, len - 22 - maxComment);
    for (let i = len - 22; i >= startSearch; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      alert('Not a valid ZIP archive: ' + name);
      return;
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const entries = [];
    let ptr = cdOffset;
    const decoder = new TextDecoder('utf-8');

    for (let i = 0; i < totalEntries && ptr + 46 <= len; i++) {
      const sig = view.getUint32(ptr, true);
      if (sig !== CEN_SIG) break;

      const compMethod = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const fnameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);

      const nameStart = ptr + 46;
      const nameEnd = nameStart + fnameLen;
      if (nameEnd > len) break;

      const fnameBytes = bytes.subarray(nameStart, nameEnd);
      let fname = '';
      try {
        fname = decoder.decode(fnameBytes);
      } catch (_) {}

      entries.push({ fname: fname, compMethod: compMethod, compSize: compSize, localOffset: localOffset });

      ptr = nameEnd + extraLen + commentLen;
      if (ptr > cdOffset + cdSize) break;
    }

    if (!entries.length) {
      alert('No files found in ' + name);
      return;
    }

    let xmlCount = 0;
    let methodsAddedTotal = 0;
    let decompressionUnsupported = false;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fname = entry.fname || '';
      const lower = fname.toLowerCase();

      if (!lower.endsWith('.xml')) continue;
      xmlCount += 1;

      try {
        const localOffset = entry.localOffset;
        if (localOffset + 30 > len) {
          console.warn('Local header truncated for', fname);
          alert('Could not read ' + fname + ' in ' + name + ' (truncated header).');
          continue;
        }

        const localSig = view.getUint32(localOffset, true);
        if (localSig !== 0x04034b50) {
          console.warn('Bad local header sig for', fname);
          alert('Could not read ' + fname + ' in ' + name + ' (invalid local header).');
          continue;
        }

        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;

        const compSize = entry.compSize;
        if (dataStart + compSize > len) {
          console.warn('Data truncated for', fname);
          alert('Could not read ' + fname + ' in ' + name + ' (truncated data).');
          continue;
        }

        const compMethod = entry.compMethod;
        const compBytes = bytes.subarray(dataStart, dataStart + compSize);

        let plainBytes;
        if (compMethod === 0) {
          plainBytes = compBytes;
        } else if (compMethod === 8) {
          try {
            plainBytes = await inflateZipDeflate(compBytes);
          } catch (err) {
            const msg = err && err.message ? String(err.message) : String(err);
            if (msg && msg.toLowerCase().indexOf('decompressionstream not supported') >= 0) {
              decompressionUnsupported = true;
              break;
            } else {
              console.error('Deflate inflate failed for', fname, err);
              alert('Could not decompress ' + fname + ' in ' + name + '.');
              continue;
            }
          }
        } else {
          console.warn('Skipping entry with unsupported compression method', compMethod);
          continue;
        }

        let xmlText = '';
        try {
          xmlText = decoder.decode(plainBytes);
        } catch (err) {
          console.error('UTF-8 decode failed for', fname, err);
          alert('Could not decode ' + fname + ' in ' + name + '.');
          continue;
        }

        const before = RG.methods.length;
        parseCCCBR(xmlText, fname);
        const added = RG.methods.length - before;
        if (added > 0) methodsAddedTotal += added;
      } catch (err) {
        console.error('Error loading ZIP entry', fname, err);
        alert('Could not load ' + fname + ' in ' + name + ': ' + (err && err.message ? err.message : err));
      }
    }

    if (decompressionUnsupported) {
      alert('This browser cannot open ZIP archives directly. Please unzip "' + name + '" and load the XML file(s) instead.');
      return;
    }

    if (!xmlCount) {
      alert('No XML files found in ' + name + '.');
      return;
    }

    if (xmlCount && methodsAddedTotal === 0) {
      alert('No supported 4–12 bell methods found in "' + name + '".');
    }
  }

  function refreshMethodList() {
    const lib = document.getElementById('methodLibrary');
    const list = document.getElementById('methodList');
    if (!lib || !list) return;

    if (!RG.methods || !RG.methods.length) {
      lib.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    lib.classList.remove('hidden');
    list.innerHTML = '';

    // v06_p12d_library_browser: compact summary (avoid dumping thousands of methods in Setup)
    const methods = RG.methods || [];
    const filename = (state && state.libraryFileName) ? String(state.libraryFileName) : '';

    const stageOrder = [4,5,6,7,8,9,10,11,12];
    const counts = {};
    for (let si = 0; si < stageOrder.length; si++) counts[stageOrder[si]] = 0;
    for (let i = 0; i < methods.length; i++) {
      const m = methods[i];
      const s = clamp(parseInt(m && m.stage, 10) || 0, 4, 12);
      if (counts[s] != null) counts[s] += 1;
    }

    const summary = document.createElement('div');
    summary.className = 'rg-lib-summary';

    const head = document.createElement('div');
    head.className = 'rg-lib-summary-head';

    const title = document.createElement('div');
    title.className = 'rg-lib-summary-title';
    title.textContent = 'Library loaded';
    head.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'rg-lib-summary-meta rg-muted';
    meta.textContent = (filename ? ('Loaded: ' + filename) : 'Loaded: (unnamed)');
    head.appendChild(meta);
    summary.appendChild(head);

    const totals = document.createElement('div');
    totals.className = 'rg-lib-summary-totals';
    totals.innerHTML = '<span class="rg-muted">Total methods:</span> <b>' + methods.length + '</b>';
    summary.appendChild(totals);

    const stagePills = document.createElement('div');
    stagePills.className = 'rg-lib-stage-pills';
    for (let si = 0; si < stageOrder.length; si++) {
      const s = stageOrder[si];
      const pill = document.createElement('span');
      pill.className = 'rg-lib-stage-pill';
      pill.textContent = s + ' ' + libStageWord(s) + ': ' + (counts[s] || 0);
      stagePills.appendChild(pill);
    }
    summary.appendChild(stagePills);

    const hint = document.createElement('div');
    hint.className = 'rg-lib-summary-hint rg-muted';
    hint.textContent = 'Use Explore library to browse by stage/class, preview, then Play or Demo a selected method.';
    summary.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'rg-lib-summary-actions';
    try {
      const ctl = setupExploreLibraryBtn ? setupExploreLibraryBtn.closest('.control') : null;
      if (ctl) actions.appendChild(ctl);
    } catch (_) {}
    summary.appendChild(actions);

    list.appendChild(summary);
  }

  async function loadCCCBRMethod(i, opts) {
    const methods = RG.methods || [];
    const m = methods[i];
    if (!m) {
      alert('Invalid method.');
      return;
    }

    if (state.phase !== 'idle') {
      alert('Stop the current game first.');
      return;
    }

    let stage = parseInt(m.stage, 10);
    if (!isFinite(stage)) stage = 0;
    stage = clamp(stage, 4, 12);
    if (stage < 4 || stage > 12) {
      alert('Only 4–12 bell methods are supported in this game.');
      return;
    }

    state.method = 'custom';
    if (methodSelect) methodSelect.value = 'custom';


    // Prompt 5: method source + attribution metadata
    state.methodSource = 'library';
    state.methodMeta = {
      title: m.title || '',
      family: m.family || '',
      class: m.class || '',
      stage: stage,
      pnPresent: !!(m.pn && String(m.pn).trim()),
      cycleWarning: ''
    };

    state.stage = stage;
    if (bellCountSelect) bellCountSelect.value = String(stage);

    let rows = null;
    if (m.pn && String(m.pn).trim()) {
      try {
        const gen = await cccbRowsFromPnFullCycleAsync(stage, m.pn, CCCBR_PLAY_MAX_ROWS, CCCBR_PLAY_MAX_LEADS, opts);
        rows = (gen && gen.rows) ? gen.rows : null;
        if (gen && gen.capped && !gen.done) {
          const warn = '⚠ Method truncated (limit reached); may not be a complete cycle.';
          try { if (state.methodMeta) state.methodMeta.cycleWarning = warn; } catch (_) {}
          alert('Warning: This library method hit the safety limit while generating and was truncated.\n\nIt may NOT be a complete cycle.');
        } else {
          try { if (state.methodMeta) state.methodMeta.cycleWarning = ''; } catch (_) {}
        }
      } catch (err) {
        console.error('cccbRowsFromPn failed', m, err);
      }
    }
    if (!rows || !rows.length) {
      rows = makePlainHunt(stage, 5);
    }

    state.customRows = rows.slice();
    computeRows();

    rebuildLiveCountOptions();
    ensureLiveBells();
    rebuildBellPicker();
    ensurePathBells();
    rebuildPathPicker();
    resetStats();
    rebuildBellFrequencies();
    rebuildBellOverridesUI();

    syncGameHeaderMeta();
    renderScoringExplanation();

    // Loaded into the existing pipeline; Play/Demo start is user-controlled from the UI.
    return { title: m.title || '', stage: stage };
  }
  window.loadCCCBRMethod = loadCCCBRMethod;

  function methodLabel() {
    if (state.method === 'custom') return 'Custom';
    if (state.method === 'plainhunt') return 'Plain Hunt';
    if (state.method === 'plainbob') return 'Plain Bob (variation)';
    if (state.method === 'grandsire') return 'Grandsire (variation)';
    return state.method;
  }

  // v012_p03_setup_method_block_sources_dropdown: keep Method dropdown reflecting source (built-in / library / file).
  function syncMethodSelectSourceDropdown() {
    try {
      if (!methodSelect) return;

      // Remove dynamic source options (re-added as needed).
      for (let i = methodSelect.options.length - 1; i >= 0; i--) {
        const opt = methodSelect.options[i];
        const val = opt && opt.value;
        if (val === '__from_library' || val === '__from_file') {
          try { methodSelect.remove(i); } catch (_) {
            try { opt.parentNode && opt.parentNode.removeChild(opt); } catch (_) {}
          }
        }
      }

      // Built-in methods: just select the built-in value.
      if (state.method !== 'custom') {
        if (state.method && methodSelect.value !== state.method) {
          methodSelect.value = state.method;
        }
        return;
      }

      // Custom: reflect whether this custom method came from library or a file.
      let wantedVal = null;
      let label = '';
      if (state.methodSource === 'library') {
        wantedVal = '__from_library';
        const title = (state.methodMeta && state.methodMeta.title) ? String(state.methodMeta.title) : '';
        label = '[method from library] ' + (title ? shortenForUi(title, 46) : 'Custom');
      } else if (state.methodSource === 'custom_rows') {
        wantedVal = '__from_file';
        const fn = (state.methodMeta && state.methodMeta.fileName) ? String(state.methodMeta.fileName) : '';
        label = '[method from file] ' + (fn ? shortenForUi(fn, 46) : 'Custom');
      }

      if (!wantedVal) {
        methodSelect.value = 'custom';
        return;
      }

      const opt = document.createElement('option');
      opt.value = wantedVal;
      opt.textContent = label;
      opt.disabled = true;

      // Insert after the existing "custom" option when possible.
      let inserted = false;
      for (let i = 0; i < methodSelect.childNodes.length; i++) {
        const n = methodSelect.childNodes[i];
        if (n && n.nodeType === 1 && n.tagName && n.tagName.toLowerCase() === 'option' && n.value === 'custom') {
          try {
            if (n.nextSibling) methodSelect.insertBefore(opt, n.nextSibling);
            else methodSelect.appendChild(opt);
            inserted = true;
          } catch (_) {}
          break;
        }
      }
      if (!inserted) {
        try { methodSelect.appendChild(opt); } catch (_) {}
      }

      methodSelect.value = wantedVal;
    } catch (_) {}
  }

  // Prompt 5: in-game header meta sync
  function syncGameHeaderMeta() {
    try {
      // v012_p03_setup_method_block_sources_dropdown: dropdown should show method source.
      syncMethodSelectSourceDropdown();

      if (!gameMetaMethod || !gameMetaSource || !gameMetaAttr || !gameMetaBpm) return;

      // Method name
      let methodName = '';
      if (state.methodSource === 'library' && state.methodMeta && state.methodMeta.title) {
        methodName = String(state.methodMeta.title);
      } else if (state.method === 'custom') {
        const fn = state.methodMeta && state.methodMeta.fileName ? String(state.methodMeta.fileName) : '';
        methodName = fn ? ('Custom rows: ' + shortenForUi(fn, 42)) : 'Custom rows';
      } else {
        methodName = methodLabel();
      }

      // Source tag
      let src = '(built-in)';
      if (state.methodSource === 'library') src = '(library)';
      else if (state.methodSource === 'custom_rows') src = '(custom rows)';

      // Attribution
      let attr = '';
      if (state.methodSource === 'library') {
        const parts = ['CCCBR'];
        if (state.methodMeta && state.methodMeta.family) parts.push(String(state.methodMeta.family));
        if (state.methodMeta && state.methodMeta.class) parts.push(String(state.methodMeta.class));
        if (state.methodMeta && state.methodMeta.cycleWarning) parts.push(String(state.methodMeta.cycleWarning));
        attr = parts.filter(Boolean).join(' • ');
      } else if (state.methodSource === 'custom_rows') {
        const fn = state.methodMeta && state.methodMeta.fileName ? String(state.methodMeta.fileName) : '';
        if (fn) attr = shortenForUi(fn, 52);
      }

      // BPM (idle shows selected tempo, running/countdown shows state.bpm)
      let bpmVal = state.bpm;
      if (state.phase === 'idle') {
        const v = bpmInput ? parseInt(bpmInput.value, 10) : NaN;
        if (Number.isFinite(v) && v > 0) bpmVal = v;
      }

      gameMetaMethod.textContent = methodName;
      gameMetaSource.textContent = src;

      gameMetaAttr.textContent = attr;
      gameMetaAttr.classList.toggle('hidden', !attr);

      let bpmLine = String(Math.round(bpmVal)) + ' BPM';
      if (state.phase === 'paused') bpmLine += ' • Paused';
      gameMetaBpm.textContent = bpmLine;
    } catch (_) {}
  }

  function shortenForUi(s, maxLen) {
    const str = String(s || '').trim();
    const m = Math.max(10, parseInt(maxLen, 10) || 42);
    if (str.length <= m) return str;
    return str.slice(0, m - 1) + '…';
  }

  // === Scale -> bell frequencies ===
  function getScaleDef() { return SCALE_LIBRARY.find(s => s.key === state.scaleKey) || SCALE_LIBRARY[0]; }

  function downsampleIntervals(intervals, stage) {
    if (stage <= 1) return [intervals[0]];
    const out = [];
    const last = intervals.length - 1;
    for (let i = 0; i < stage; i++) {
      const t = i / (stage - 1);
      const idx = Math.round(t * last);
      out.push(intervals[idx]);
    }
    out[0] = intervals[0];
    out[out.length - 1] = intervals[last];
    return out;
  }

  // v011_p04_bell_pitch_collapsible_blocks: bell pitch patterns (offsets in semitones from root)
function expandIntervalsAcrossOctaves(baseIntervals, octaves) {
  const base = Array.isArray(baseIntervals) ? baseIntervals.slice() : [0, 12];
  const o = clamp(parseInt(octaves, 10) || 1, 1, 4);
  if (o <= 1) return base.slice();
  const out = [];
  for (let oi = 0; oi < o; oi++) {
    const add = oi * 12;
    for (let j = 0; j < base.length; j++) {
      // Avoid duplicating the octave root at boundaries.
      if (oi > 0 && j === 0) continue;
      out.push(Number(base[j]) + add);
    }
  }
  return out;
}

function getBellPitchOffsets(stage) {
  const s = clamp(parseInt(stage, 10) || 0, 1, 12);
  const fam = String(state.bellPitchFamily || 'diatonic');
  if (fam === 'pent_hex') return getBellPitchOffsetsPentHex(s);
  if (fam === 'chromatic') return getBellPitchOffsetsChromatic(s);
  if (fam === 'fifths_fourths') return getBellPitchOffsetsFifthsFourths(s);
  if (fam === 'partials') return getBellPitchOffsetsPartials(s);
  if (fam === 'custom') return getBellPitchOffsetsDiatonic(s); // Custom uses per-bell overrides layered on top.
  return getBellPitchOffsetsDiatonic(s);
}

function getBellPitchOffsetsDiatonic(stage) {
  // Use existing major/minor scale intervals.
  let intervals;
  if (state.scaleKey && state.scaleKey !== 'custom_hz') {
    const def = getScaleDefByKey(state.scaleKey) || SCALE_LIBRARY[0];
    intervals = (def && def.intervals) ? def.intervals : [0,2,4,5,7,9,11,12];
  } else {
    // "Custom (Hz)" keeps diatonic intervals (major) while allowing a custom root frequency.
    const def0 = SCALE_LIBRARY[0] || { intervals: [0,2,4,5,7,9,11,12] };
    intervals = def0.intervals || [0,2,4,5,7,9,11,12];
  }

  const span = String(state.bellPitchSpan || 'compact');
  // Ensure enough distinct scale degrees for the current stage so the effective mapping is computed immediately.
  // (e.g., stage 8 minor pentatonic needs >1 octave to avoid duplicated pitches.)
  if (span === 'extended' || stage > intervals.length) intervals = expandIntervalsAcrossOctaves(intervals, 2);
  const ds = downsampleIntervals(intervals, stage); // ascending low->high
  const offsets = [];
  for (let bell = 1; bell <= stage; bell++) offsets.push(ds[stage - bell] || 0); // bell 1 highest
  return offsets;
}

function getBellPitchOffsetsPentHex(stage) {
  const v = String(state.bellPitchPentVariant || 'major_pent');
  let intervals;
  if (v === 'minor_pent') intervals = [0,3,5,7,10,12];
  else if (v === 'whole_tone') intervals = [0,2,4,6,8,10,12];
  else if (v === 'blues_hex') intervals = [0,3,5,6,7,10,12];
  else intervals = [0,2,4,7,9,12]; // major pentatonic

  const span = String(state.bellPitchSpan || 'compact');
  if (span === 'extended') intervals = expandIntervalsAcrossOctaves(intervals, 2);

  const ds = downsampleIntervals(intervals, stage); // ascending low->high
  const offsets = [];
  for (let bell = 1; bell <= stage; bell++) offsets.push(ds[stage - bell] || 0); // bell 1 highest
  return offsets;
}

function getBellPitchOffsetsChromatic(stage) {
  const span = String(state.bellPitchSpan || 'compact');
  const maxSemi = (span === 'extended') ? 23 : 11;
  const intervals = [];
  for (let i = 0; i <= maxSemi; i++) intervals.push(i);

  const ds = downsampleIntervals(intervals, stage); // ascending
  const dir = String(state.bellPitchChromaticDirection || 'descending');

  const offsets = [];
  if (dir === 'ascending') {
    // Bell 1 lowest -> bell N highest
    for (let bell = 1; bell <= stage; bell++) offsets.push(ds[bell - 1] || 0);
  } else {
    // Bell 1 highest -> bell N lowest (traditional treble-high mapping)
    for (let bell = 1; bell <= stage; bell++) offsets.push(ds[stage - bell] || 0);
  }
  return offsets;
}

function getBellPitchOffsetsFifthsFourths(stage) {
  const type = String(state.bellPitchFifthsType || 'fifths');
  const shape = String(state.bellPitchFifthsShape || 'folded');
  const step = (type === 'fourths') ? 5 : 7;

  // Build from low->high, then map so bell 1 is "top" (last).
  const lowToHigh = [];
  for (let i = 0; i < stage; i++) {
    let off = i * step;
    if (shape === 'folded') off = ((off % 12) + 12) % 12;
    lowToHigh.push(off);
  }

  const offsets = [];
  for (let bell = 1; bell <= stage; bell++) offsets.push(lowToHigh[stage - bell] || 0);
  return offsets;
}

function getBellPitchOffsetsPartials(stage) {
  const shape = String(state.bellPitchPartialsShape || 'ladder');

  // Harmonic series: partial n has ratio n:1 relative to the fundamental.
  // Represent as semitone offsets (can be fractional).
  const lowToHigh = [];
  for (let n = 1; n <= stage; n++) {
    let off = 12 * (Math.log(n) / Math.log(2));
    if (shape === 'folded') off = off % 12;
    lowToHigh.push(off);
  }

  const offsets = [];
  for (let bell = 1; bell <= stage; bell++) offsets.push(lowToHigh[stage - bell] || 0);
  return offsets;
}

function rebuildBellFrequencies() {
  const rootFreq = getBellRootFrequency();
  const stage = clamp(parseInt(state.stage, 10) || 1, 1, 12);
  const offsets = getBellPitchOffsets(stage) || [];
  const freq = [];
  for (let bell = 1; bell <= stage; bell++) {
    const off = (offsets[bell - 1] != null) ? Number(offsets[bell - 1]) : 0;
    freq.push(rootFreq * Math.pow(2, off / 12));
  }
  state.bellFreq = freq;
  try { syncBellOverridesEffectiveUI(); } catch (_) {}
}


  // v08_p05_sound_per_bell_overrides: per-bell sound overrides (UI + persistence)
  function ensureBellOverridesArrays() {
    if (!Array.isArray(state.bellHzOverride) || state.bellHzOverride.length < 13) state.bellHzOverride = new Array(13).fill(null);
    if (!Array.isArray(state.bellVolOverride) || state.bellVolOverride.length < 13) state.bellVolOverride = new Array(13).fill(null);
    if (!Array.isArray(state.bellKeyOverride) || state.bellKeyOverride.length < 13) state.bellKeyOverride = new Array(13).fill(null);
    if (!Array.isArray(state.bellOctaveOverride) || state.bellOctaveOverride.length < 13) state.bellOctaveOverride = new Array(13).fill(null);
    if (!Array.isArray(state.bellPan) || state.bellPan.length < 13) state.bellPan = new Array(13).fill(0);
    if (!Array.isArray(state.bellDepth) || state.bellDepth.length < 13) state.bellDepth = new Array(13).fill(0);
  }

  function loadBellOverridesFromLS() {
    ensureBellOverridesArrays();

    const hzObj = safeJsonParse(safeGetLS(LS_BELL_HZ_OVERRIDE) || '') || null;
    if (hzObj && typeof hzObj === 'object') {
      for (const k in hzObj) {
        if (!Object.prototype.hasOwnProperty.call(hzObj, k)) continue;
        const b = parseInt(k, 10);
        if (!Number.isFinite(b) || b < 1 || b > 12) continue;
        const v = Number(hzObj[k]);
        if (Number.isFinite(v) && v > 0) state.bellHzOverride[b] = clamp(v, 20, 5000);
      }
    }

    const volObj = safeJsonParse(safeGetLS(LS_BELL_VOL_OVERRIDE) || '') || null;
    if (volObj && typeof volObj === 'object') {
      for (const k in volObj) {
        if (!Object.prototype.hasOwnProperty.call(volObj, k)) continue;
        const b = parseInt(k, 10);
        if (!Number.isFinite(b) || b < 1 || b > 12) continue;
        let v = Number(volObj[k]);
        if (!Number.isFinite(v)) continue;
        if (v <= 1.0001 && v >= 0) v = v * 100; // allow 0..1 factor too
        state.bellVolOverride[b] = clamp(v, 0, 100);
      }
    }

    // v09_p06_sound_per_bell_key_register
    const keyObj = safeJsonParse(safeGetLS(LS_BELL_KEY_OVERRIDE) || '') || null;
    if (keyObj && typeof keyObj === 'object') {
      for (const k in keyObj) {
        if (!Object.prototype.hasOwnProperty.call(keyObj, k)) continue;
        const b = parseInt(k, 10);
        if (!Number.isFinite(b) || b < 1 || b > 12) continue;
        const v = String(keyObj[k] || '').trim();
        if (!v) continue;
        if (v === 'custom_hz') continue;
        if (SCALE_LIBRARY.some(s => s.key === v)) state.bellKeyOverride[b] = v;
      }
    }

    const octObj = safeJsonParse(safeGetLS(LS_BELL_OCT_OVERRIDE) || '') || null;
    if (octObj && typeof octObj === 'object') {
      for (const k in octObj) {
        if (!Object.prototype.hasOwnProperty.call(octObj, k)) continue;
        const b = parseInt(k, 10);
        if (!Number.isFinite(b) || b < 1 || b > 12) continue;
        const v = parseInt(String(octObj[k] || ''), 10);
        if (!Number.isFinite(v)) continue;
        state.bellOctaveOverride[b] = clamp(v, 1, 6);
      }
    }
  

    // v014_p045a_spatial_pan_only
    const panObj = safeJsonParse(safeGetLS(LS_BELL_PAN) || '') || null;
    if (panObj && typeof panObj === 'object') {
      if (Array.isArray(panObj)) {
        for (let b = 1; b <= 12; b++) {
          const v = Number(panObj[b]);
          if (!Number.isFinite(v)) continue;
          state.bellPan[b] = clamp(v, -1, 1);
        }
      } else {
        for (const k in panObj) {
          if (!Object.prototype.hasOwnProperty.call(panObj, k)) continue;
          const b = parseInt(k, 10);
          if (!Number.isFinite(b) || b < 1 || b > 12) continue;
          const v = Number(panObj[k]);
          if (!Number.isFinite(v)) continue;
          state.bellPan[b] = clamp(v, -1, 1);
        }
      }
    }


    // v014_p045b_spatial_depth_and_send
    const depthObj = safeJsonParse(safeGetLS(LS_BELL_DEPTH) || '') || null;
    if (depthObj && typeof depthObj === 'object') {
      if (Array.isArray(depthObj)) {
        for (let b = 1; b <= 12; b++) {
          const v = Number(depthObj[b]);
          if (!Number.isFinite(v)) continue;
          state.bellDepth[b] = clamp(v, 0, 1);
        }
      } else {
        for (const k in depthObj) {
          if (!Object.prototype.hasOwnProperty.call(depthObj, k)) continue;
          const b = parseInt(String(k), 10) || 0;
          if (b < 1 || b > 12) continue;
          const v = Number(depthObj[k]);
          if (!Number.isFinite(v)) continue;
          state.bellDepth[b] = clamp(v, 0, 1);
        }
      }
    }
}

  function saveBellKeyOverridesToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const v = (state.bellKeyOverride[b] != null) ? String(state.bellKeyOverride[b]) : '';
      if (!v) continue;
      if (v === 'custom_hz') continue;
      if (!SCALE_LIBRARY.some(s => s.key === v)) continue;
      out[b] = v;
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_KEY_OVERRIDE);
    else safeSetLS(LS_BELL_KEY_OVERRIDE, JSON.stringify(out));
  }

  function saveBellOctOverridesToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      if (state.bellOctaveOverride[b] == null) continue;
      const v = parseInt(String(state.bellOctaveOverride[b]), 10);
      if (!Number.isFinite(v)) continue;
      out[b] = clamp(v, 1, 6);
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_OCT_OVERRIDE);
    else safeSetLS(LS_BELL_OCT_OVERRIDE, JSON.stringify(out));
  }

  function saveBellHzOverridesToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const v = Number(state.bellHzOverride[b]);
      if (!Number.isFinite(v) || v <= 0) continue;
      out[b] = v;
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_HZ_OVERRIDE);
    else safeSetLS(LS_BELL_HZ_OVERRIDE, JSON.stringify(out));
  }

  function saveBellVolOverridesToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      if (state.bellVolOverride[b] == null) continue;
      const v = Number(state.bellVolOverride[b]);
      if (!Number.isFinite(v)) continue;
      out[b] = clamp(v, 0, 100);
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_VOL_OVERRIDE);
    else safeSetLS(LS_BELL_VOL_OVERRIDE, JSON.stringify(out));
  }

  function saveBellPanToLS() {
    ensureBellOverridesArrays();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const v0 = Number(state.bellPan[b]);
      if (!Number.isFinite(v0)) continue;
      const v = clamp(v0, -1, 1);
      if (Math.abs(v) < 0.0005) continue;
      out[b] = v;
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_PAN);
    else safeSetLS(LS_BELL_PAN, JSON.stringify(out));
  }


  // v10_p09_sound_per_bell_chords_overrides: per-bell chord + split-strike overrides (UI + persistence)

  // v014_p05b_bell_timbre_per_bell_overrides (per-bell bell strike timbre overrides)
  function bellTimbreOverrideDefaults() {
    return {
      mode: 'inherit', // 'inherit' | 'override'
      bellRingLength: BELL_RING_LENGTH_DEFAULT,
      bellBrightness: BELL_BRIGHTNESS_DEFAULT,
      bellStrikeHardness: BELL_STRIKE_HARDNESS_DEFAULT,
      // Internal (not persisted)
      _fromLS: false,
    };
  }

  function sanitizeBellTimbreOverride(raw) {
    const out = bellTimbreOverrideDefaults();
    if (raw && typeof raw === 'object') {
      const m = String(raw.mode || 'inherit');
      out.mode = (m === 'override') ? 'override' : 'inherit';

      const rl = Number(raw.bellRingLength);
      if (Number.isFinite(rl)) out.bellRingLength = clamp(rl, 0, 1);

      const br = Number(raw.bellBrightness);
      if (Number.isFinite(br)) out.bellBrightness = clamp(br, 0, 1);

      const hd = Number(raw.bellStrikeHardness);
      if (Number.isFinite(hd)) out.bellStrikeHardness = clamp(hd, 0, 1);

      // preserve internal flags when present
      out._fromLS = !!raw._fromLS;
    }
    // snap near defaults to avoid drift
    if (Math.abs(out.bellRingLength - BELL_RING_LENGTH_DEFAULT) < 1e-6) out.bellRingLength = BELL_RING_LENGTH_DEFAULT;
    if (Math.abs(out.bellBrightness - BELL_BRIGHTNESS_DEFAULT) < 1e-6) out.bellBrightness = BELL_BRIGHTNESS_DEFAULT;
    if (Math.abs(out.bellStrikeHardness - BELL_STRIKE_HARDNESS_DEFAULT) < 1e-6) out.bellStrikeHardness = BELL_STRIKE_HARDNESS_DEFAULT;
    return out;
  }

  function ensureBellTimbreOverridesArray() {
    if (!Array.isArray(state.bellTimbreOverrides) || state.bellTimbreOverrides.length < 13) {
      state.bellTimbreOverrides = new Array(13);
      for (let b = 0; b < 13; b++) state.bellTimbreOverrides[b] = bellTimbreOverrideDefaults();
      return;
    }
    for (let b = 0; b < 13; b++) {
      state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b]);
    }
  }

  function loadBellTimbreOverridesFromLS() {
    ensureBellTimbreOverridesArray();
    const raw = safeJsonParse(safeGetLS(LS_BELL_TIMBRE_OVERRIDES) || '') || null;
    if (!raw || typeof raw !== 'object') return;
    for (const k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      const b = parseInt(k, 10);
      if (!Number.isFinite(b) || b < 1 || b > 12) continue;
      const cfg = sanitizeBellTimbreOverride(raw[k]);
      cfg.mode = 'override';
      cfg._fromLS = true;
      state.bellTimbreOverrides[b] = cfg;
    }
  }

  function saveBellTimbreOverridesToLS() {
    ensureBellTimbreOverridesArray();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b]);
      state.bellTimbreOverrides[b] = cfg;
      if (cfg.mode !== 'override') continue;
      out[b] = {
        mode: 'override',
        bellRingLength: cfg.bellRingLength,
        bellBrightness: cfg.bellBrightness,
        bellStrikeHardness: cfg.bellStrikeHardness,
      };
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_TIMBRE_OVERRIDES);
    else safeSetLS(LS_BELL_TIMBRE_OVERRIDES, JSON.stringify(out));
  }

  // Resolve effective bell timbre (global first, then optional per-bell override)
  function resolveBellTimbreForStrike(bell, soundCtx) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const ctx = soundCtx || null;
    if (ctx && ctx.profile === 'custom' && ctx.bs) {
      const bs = ctx.bs;
      const t = (bs.timbre && typeof bs.timbre === 'object') ? bs.timbre : {};
      let rl01 = Number(t.ringLength01);
      let br01 = Number(t.brightness01);
      let hd01 = Number(t.strikeHardness01);
      rl01 = Number.isFinite(rl01) ? clamp(rl01, 0, 1) : BELL_RING_LENGTH_DEFAULT;
      br01 = Number.isFinite(br01) ? clamp(br01, 0, 1) : BELL_BRIGHTNESS_DEFAULT;
      hd01 = Number.isFinite(hd01) ? clamp(hd01, 0, 1) : BELL_STRIKE_HARDNESS_DEFAULT;

      const pb = (bs.perBell && bs.perBell[b]) ? bs.perBell[b] : null;
      if (pb && pb.timbre && typeof pb.timbre === 'object') {
        const tr = pb.timbre;
        const orl = Number(tr.ringLength01);
        const obr = Number(tr.brightness01);
        const ohd = Number(tr.strikeHardness01);
        if (Number.isFinite(orl)) rl01 = clamp(orl, 0, 1);
        if (Number.isFinite(obr)) br01 = clamp(obr, 0, 1);
        if (Number.isFinite(ohd)) hd01 = clamp(ohd, 0, 1);
      }

      return { bellRingLength: rl01, bellBrightness: br01, bellStrikeHardness: hd01 };
    }

    let rl01 = clamp(Number(state.bellRingLength), 0, 1);
    let br01 = clamp(Number(state.bellBrightness), 0, 1);
    let hd01 = clamp(Number(state.bellStrikeHardness), 0, 1);

    ensureBellTimbreOverridesArray();
    const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
    state.bellTimbreOverrides[b] = cfg;

    if (cfg.mode === 'override') {
      rl01 = clamp(Number(cfg.bellRingLength), 0, 1);
      br01 = clamp(Number(cfg.bellBrightness), 0, 1);
      hd01 = clamp(Number(cfg.bellStrikeHardness), 0, 1);
    }
    return { bellRingLength: rl01, bellBrightness: br01, bellStrikeHardness: hd01 };
  }

  // Smoothing: ramp live bell filter frequency to avoid clicks when brightness changes.
  function rampActiveBellTimbreBrightness(bell) {
    try {
      if (!audioCtx || !scheduledBellNodes || !scheduledBellNodes.length) return;
      const b = clamp(parseInt(bell, 10) || 0, 1, 12);
      const now = audioCtx.currentTime || 0;
      const tim = resolveBellTimbreForStrike(b);
      const br01 = clamp(Number(tim.bellBrightness), 0, 1);
      const brNeutral = Math.abs(br01 - BELL_BRIGHTNESS_DEFAULT) < 1e-6;
      const ny = 0.5 * Math.max(8000, Number(audioCtx.sampleRate) || 48000);
      const maxHz = ny * 0.95;
      const hzTarget = brNeutral ? maxHz : bellBrightnessCutoffHz(br01, audioCtx.sampleRate);
      const tau = 0.015;

      for (let i = 0; i < scheduledBellNodes.length; i++) {
        const n = scheduledBellNodes[i];
        if (!n || n.bell !== b || !n.lpf || !n.lpf.frequency) continue;
        if (n.stopAt != null && Number.isFinite(Number(n.stopAt)) && n.stopAt <= now) continue;
        try {
          n.lpf.frequency.cancelScheduledValues(now);
          n.lpf.frequency.setTargetAtTime(hzTarget, now, tau);
        } catch (_) {}
      }
    } catch (_) {}
  }


  function bellChordOverrideDefaults() {
    return {
      mode: 'inherit',              // 'inherit' | 'override'
      enabled: false,               // only meaningful when mode === 'override'
      preset: 'unison',
      inversion: 'root',
      spread: 'close',
      splitStrikeMode: 'inherit',   // 'inherit'|'simultaneous'|'belllike'
      splitStepMs: 6,
      splitMaxMs: 12,
      // Advanced (strings for robust storage)
      customIntervals: '',
      customSplitOffsetsMs: '',
      customDetuneCents: '',
      customLevelGains: '',
      // Internal (not persisted)
      _intervals: null,
      _splitOffsets: null,
      _detune: null,
      _levels: null,
      _warn: ''
    };
  }

  function parseIntListLoose(raw, maxItems) {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      const out = [];
      for (let i = 0; i < raw.length && out.length < (maxItems || 6); i++) {
        const v = parseInt(String(raw[i]).trim(), 10);
        if (Number.isFinite(v)) out.push(v);
      }
      return out;
    }
    const txt = String(raw || '').trim();
    if (!txt) return [];
    const parts = txt.split(/[\s,]+/g).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length && out.length < (maxItems || 6); i++) {
      const v = parseInt(parts[i], 10);
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  function parseNumListLoose(raw, maxItems) {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      const out = [];
      for (let i = 0; i < raw.length && out.length < (maxItems || 6); i++) {
        const v = parseFloat(String(raw[i]).trim());
        if (Number.isFinite(v)) out.push(v);
      }
      return out;
    }
    const txt = String(raw || '').trim();
    if (!txt) return [];
    const parts = txt.split(/[\s,]+/g).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length && out.length < (maxItems || 6); i++) {
      const v = parseFloat(parts[i]);
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  function sanitizeBellChordOverride(raw) {
    const d = bellChordOverrideDefaults();
    const out = Object.assign({}, d);
    let warn = '';

    if (raw && typeof raw === 'object') {
      const mode = String(raw.mode || '').trim();
      if (mode === 'override' || mode === 'inherit') out.mode = mode;

      const en = raw.enabled;
      if (typeof en === 'boolean') out.enabled = en;
      else if (en === 1 || en === '1' || en === 'true' || en === 'on') out.enabled = true;
      else if (en === 0 || en === '0' || en === 'false' || en === 'off') out.enabled = false;

      const p = String(raw.preset || raw.quality || raw.qualityPreset || raw.chord || '').trim();
      if (p && GLOBAL_CHORD_PRESETS[p]) out.preset = p;

      const inv = String(raw.inversion || '').trim();
      if (inv && GLOBAL_CHORD_INVERSION_ORDER.includes(inv)) out.inversion = inv;

      const sp = String(raw.spread || '').trim();
      if (sp && GLOBAL_CHORD_SPREAD_ORDER.includes(sp)) out.spread = sp;

      const ss = String(raw.splitStrikeMode || raw.splitStrike || raw.split || '').trim();
      if (ss === 'inherit' || ss === 'simultaneous' || ss === 'belllike') out.splitStrikeMode = ss;

      const st = parseFloat(raw.splitStepMs != null ? raw.splitStepMs : raw.stepMs);
      if (Number.isFinite(st)) out.splitStepMs = clamp(Math.round(st), 0, 15);
      const mx = parseFloat(raw.splitMaxMs != null ? raw.splitMaxMs : raw.maxMs);
      if (Number.isFinite(mx)) out.splitMaxMs = clamp(Math.round(mx), 0, 18);

      // Advanced strings (store as-is for forward/back compat)
      if (raw.customIntervals != null) out.customIntervals = Array.isArray(raw.customIntervals) ? raw.customIntervals.join(', ') : String(raw.customIntervals);
      if (raw.customSplitOffsetsMs != null) out.customSplitOffsetsMs = Array.isArray(raw.customSplitOffsetsMs) ? raw.customSplitOffsetsMs.join(', ') : String(raw.customSplitOffsetsMs);
      if (raw.customDetuneCents != null) out.customDetuneCents = Array.isArray(raw.customDetuneCents) ? raw.customDetuneCents.join(', ') : String(raw.customDetuneCents);
      if (raw.customLevelGains != null) out.customLevelGains = Array.isArray(raw.customLevelGains) ? raw.customLevelGains.join(', ') : String(raw.customLevelGains);
    }

    // Parse + clamp advanced (hard cap 6 for safety)
    const intervalTxt = String(out.customIntervals || '').trim();
    if (intervalTxt) {
      const ints = parseIntListLoose(intervalTxt, 6);
      if (!ints.length) warn = 'Invalid custom intervals';
      else {
        out._intervals = ints.map(v => clamp(parseInt(String(v), 10) || 0, -24, 24)).slice(0, 6);
      }
    }

    const splitTxt = String(out.customSplitOffsetsMs || '').trim();
    if (splitTxt) {
      const ints = parseIntListLoose(splitTxt, 6);
      if (!ints.length) warn = warn ? (warn + '; invalid split offsets') : 'Invalid split offsets';
      else {
        const arr = ints.map(v => clamp(parseInt(String(v), 10) || 0, 0, 18)).slice(0, 6);
        // Must start at 0.
        if (arr.length && arr[0] !== 0) {
          warn = warn ? (warn + '; split offsets must start at 0') : 'Split offsets must start at 0';
        } else {
          // Enforce nondecreasing.
          for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) arr[i] = arr[i - 1];
          out._splitOffsets = arr;
        }
      }
    }

    const detuneTxt = String(out.customDetuneCents || '').trim();
    if (detuneTxt) {
      const nums = parseNumListLoose(detuneTxt, 6);
      if (!nums.length) warn = warn ? (warn + '; invalid detune') : 'Invalid detune';
      else out._detune = nums.map(v => clamp(Number(v) || 0, -50, 50)).slice(0, 6);
    }

    const levelTxt = String(out.customLevelGains || '').trim();
    if (levelTxt) {
      const nums = parseNumListLoose(levelTxt, 6);
      if (!nums.length) warn = warn ? (warn + '; invalid levels') : 'Invalid levels';
      else out._levels = nums.map(v => clamp(Number(v) || 1, 0, 1.5)).slice(0, 6);
    }

    out._warn = String(warn || '').trim();
    return out;
  }

  function ensureBellChordOverridesArray() {
    if (!Array.isArray(state.bellChordOverrides) || state.bellChordOverrides.length < 13) {
      state.bellChordOverrides = new Array(13);
      for (let b = 0; b < 13; b++) state.bellChordOverrides[b] = bellChordOverrideDefaults();
      return;
    }
    for (let b = 0; b < 13; b++) {
      state.bellChordOverrides[b] = sanitizeBellChordOverride(state.bellChordOverrides[b]);
    }
  }

  function loadBellChordOverridesFromLS() {
    ensureBellChordOverridesArray();
    const raw = safeJsonParse(safeGetLS(LS_BELL_CHORD_OVERRIDES) || '') || null;
    if (!raw || typeof raw !== 'object') return;
    for (const k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      const b = parseInt(k, 10);
      if (!Number.isFinite(b) || b < 1 || b > 12) continue;
      state.bellChordOverrides[b] = sanitizeBellChordOverride(raw[k]);
    }
  }

  function saveBellChordOverridesToLS() {
    ensureBellChordOverridesArray();
    const out = {};
    for (let b = 1; b <= 12; b++) {
      const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b]);
      state.bellChordOverrides[b] = cfg;
      if (cfg.mode !== 'override') continue;
      // Persist only user-facing fields; keep storage resilient across versions.
      out[b] = {
        mode: cfg.mode,
        enabled: !!cfg.enabled,
        preset: String(cfg.preset || 'unison'),
        inversion: String(cfg.inversion || 'root'),
        spread: String(cfg.spread || 'close'),
        splitStrikeMode: String(cfg.splitStrikeMode || 'inherit'),
        splitStepMs: clamp(parseInt(String(cfg.splitStepMs), 10) || 0, 0, 15),
        splitMaxMs: clamp(parseInt(String(cfg.splitMaxMs), 10) || 0, 0, 18),
        customIntervals: String(cfg.customIntervals || ''),
        customSplitOffsetsMs: String(cfg.customSplitOffsetsMs || ''),
        customDetuneCents: String(cfg.customDetuneCents || ''),
        customLevelGains: String(cfg.customLevelGains || ''),
      };
    }
    if (!Object.keys(out).length) safeDelLS(LS_BELL_CHORD_OVERRIDES);
    else safeSetLS(LS_BELL_CHORD_OVERRIDES, JSON.stringify(out));
  }

  function fmtHz(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return String(Math.round(n * 100) / 100);
  }

  function fmtPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return String(Math.round(n));
  }

  function scaleKeyLabel(key) {
    const k = String(key || '');
    if (k === 'custom_hz') return 'Custom (Hz)';
    const def = SCALE_LIBRARY.find(s => s.key === k);
    return def ? def.label : k;
  }


  // v10_p06_sound_per_bell_piano_keypicker: per-bell Key piano picker (UI + mapping helpers)
  const PIANO_WHITE_NOTES = ['C','D','E','F','G','A','B'];
  const PIANO_BLACK_NOTES = ['C#','Eb','F#','Ab','Bb'];
  const PIANO_NOTE_TO_PREFIX = { 'C':'C', 'C#':'Cs', 'D':'D', 'Eb':'Ef', 'E':'E', 'F':'F', 'F#':'Fs', 'G':'G', 'Ab':'Af', 'A':'A', 'Bb':'Bf', 'B':'B' };

  function scaleModeFromScaleKey(key) {
    const k = String(key || '');
    if (k.endsWith('_minor')) return 'minor';
    return 'major';
  }

  function scaleKeyFromPianoNote(note, mode) {
    const n = String(note || '');
    const pref = PIANO_NOTE_TO_PREFIX[n];
    if (!pref) return '';
    const m = (mode === 'minor') ? 'minor' : 'major';
    const key = pref + '_' + m;
    return SCALE_LIBRARY.some(s => s.key === key) ? key : '';
  }

  function pianoNoteFromScaleKey(key) {
    const k = String(key || '');
    if (!k || k === 'custom_hz') return '';
    const def = SCALE_LIBRARY.find(s => s.key === k);
    return def ? String(def.root || '') : '';
  }

  function effectiveBellScaleKeyForPiano(bell) {
    ensureBellOverridesArrays();
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const ov = (state.bellKeyOverride && state.bellKeyOverride[b] != null) ? String(state.bellKeyOverride[b] || '').trim() : '';
    if (ov) return ov;
    return String(state.scaleKey || '');
  }

  function effectiveBellOctaveForPiano(bell) {
    ensureBellOverridesArrays();
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const raw = (state.bellOctaveOverride && state.bellOctaveOverride[b] != null) ? parseInt(String(state.bellOctaveOverride[b]), 10) : NaN;
    if (Number.isFinite(raw)) return clamp(raw, 1, 6);
    return clamp(parseInt(String(state.octaveC), 10) || 4, 1, 6);
  }

  function bellPianoKeyboardHtml(bell, glyph) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const g = String(glyph || bellToGlyph(b));
    let html = '<div class="rg-piano" data-bell="' + b + '" role="group" aria-label="Bell ' + g + ' key picker">';
    html += '<div class="rg-piano-white">';
    for (const n of PIANO_WHITE_NOTES) {
      html += '<button type="button" class="rg-piano-key rg-piano-key--white" data-note="' + n + '" aria-label="' + n + '">' + n + '</button>';
    }
    html += '</div>';
    for (const n of PIANO_BLACK_NOTES) {
      html += '<button type="button" class="rg-piano-key rg-piano-key--black" data-note="' + n + '" aria-label="' + n + '">' + n + '</button>';
    }
    html += '</div>';
    return html;
  }

  function syncBellPianoKeypickerUI(bell) {
    if (!bellOverridesList) return;
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    const piano = bellOverridesList.querySelector('.rg-piano[data-bell="' + b + '"]');
    if (!piano) return;

    const keys = piano.querySelectorAll('.rg-piano-key');
    for (const k of keys) {
      try { k.classList.remove('is-selected'); } catch (_) {}
    }

    const effKey = effectiveBellScaleKeyForPiano(b);
    const note = pianoNoteFromScaleKey(effKey);
    if (!note) return;
    const sel = piano.querySelector('.rg-piano-key[data-note="' + note + '"]');
    if (sel) {
      try { sel.classList.add('is-selected'); } catch (_) {}
    }
  }

  function syncBellOverridesEffectiveUI() {
    if (!bellOverridesList) return;
    ensureBellOverridesArrays();
    ensureBellTimbreOverridesArray();
    ensureBellChordOverridesArray();
    const base = clamp(Number(state.bellVolume) || 0, 0, 100);

    for (let b = 1; b <= state.stage; b++) {
      const hzEl = document.getElementById('bellHzEffective_' + b);
      if (hzEl) {
        const hasHzOv = (state.bellHzOverride[b] != null) && Number.isFinite(Number(state.bellHzOverride[b]));
        const hasKeyOv = (state.bellKeyOverride[b] != null) && String(state.bellKeyOverride[b] || '').trim();
        const hasOctOv = (state.bellOctaveOverride[b] != null) && Number.isFinite(Number(state.bellOctaveOverride[b]));
        const tag = hasHzOv ? ' (Hz override)' : ((hasKeyOv || hasOctOv) ? ' (key/reg)' : '');
        hzEl.textContent = 'Eff: ' + fmtHz(getBellHz(b)) + ' Hz' + tag;
      }

      const keyEl = document.getElementById('bellKeyEffective_' + b);
      if (keyEl) {
        const hasKeyOv = (state.bellKeyOverride[b] != null) && String(state.bellKeyOverride[b] || '').trim();
        const effKey = hasKeyOv ? String(state.bellKeyOverride[b]) : String(state.scaleKey);
        keyEl.textContent = 'Eff: ' + scaleKeyLabel(effKey) + (hasKeyOv ? ' (override)' : '');
      }
      try { syncBellPianoKeypickerUI(b); } catch (_) {}

      const octEl = document.getElementById('bellOctEffective_' + b);
      if (octEl) {
        const hasOctOv = (state.bellOctaveOverride[b] != null) && Number.isFinite(Number(state.bellOctaveOverride[b]));
        const effOct = hasOctOv ? clamp(parseInt(String(state.bellOctaveOverride[b]), 10) || state.octaveC, 1, 6) : state.octaveC;
        octEl.textContent = 'Eff: C' + String(effOct) + (hasOctOv ? ' (override)' : '');
      }

      const volEl = document.getElementById('bellVolEffective_' + b);
      if (volEl) {
        const ovRaw = (state.bellVolOverride[b] != null) ? Number(state.bellVolOverride[b]) : NaN;
        const hasOv = Number.isFinite(ovRaw);
        const factor = hasOv ? clamp(ovRaw / 100, 0, 1) : 1;
        const eff = base * factor;
        volEl.textContent = 'Eff: ' + fmtPct(eff) + '%' + (hasOv ? (' (x' + fmtPct(ovRaw) + '%)') : '');
      }

      // v10_p09_sound_per_bell_chords_overrides: per-bell chord effective label + control visibility
      try {
        const chordEl = document.getElementById('bellChordEffective_' + b);
        if (chordEl) chordEl.textContent = bellChordEffectiveLabel(b);
        syncBellChordOverrideRowUI(b);

        // v014_p05b_bell_timbre_per_bell_overrides: per-bell timbre effective label + control visibility
        const timbreEl = document.getElementById('bellTimbreEffective_' + b);
        if (timbreEl) timbreEl.textContent = bellTimbreEffectiveLabel(b);
        syncBellTimbreOverrideRowUI(b);
      } catch (_) {}
    }
  }

  // v10_p08_sound_global_chords_splitstrike: Sound menu UI (global)
  function buildGlobalChordControlsUI() {
    // Presets
    if (globalChordPresetSelect && (!globalChordPresetSelect.options || globalChordPresetSelect.options.length === 0)) {
      globalChordPresetSelect.innerHTML = '';
      for (const k of GLOBAL_CHORD_PRESET_ORDER_GLOBAL_UI) {
        if (!GLOBAL_CHORD_PRESETS[k]) continue;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = chordPresetLabel(k);
        globalChordPresetSelect.appendChild(opt);
      }
    }

    // Split-strike
    if (globalChordSplitSelect && (!globalChordSplitSelect.options || globalChordSplitSelect.options.length === 0)) {
      globalChordSplitSelect.innerHTML = '';
      {
        const opt = document.createElement('option');
        opt.value = 'simultaneous';
        opt.textContent = 'Simultaneous';
        globalChordSplitSelect.appendChild(opt);
      }
      {
        const opt = document.createElement('option');
        opt.value = 'belllike';
        opt.textContent = 'Bell-like';
        globalChordSplitSelect.appendChild(opt);
      }
    }

    // Inversion (optional)
    if (globalChordInversionSelect && (!globalChordInversionSelect.options || globalChordInversionSelect.options.length === 0)) {
      globalChordInversionSelect.innerHTML = '';
      const invLabel = { root: 'Root', first: '1st', second: '2nd', third: '3rd' };
      for (const k of GLOBAL_CHORD_INVERSION_ORDER) {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = invLabel[k] || k;
        globalChordInversionSelect.appendChild(opt);
      }
    }

    // Spread (optional)
    if (globalChordSpreadSelect && (!globalChordSpreadSelect.options || globalChordSpreadSelect.options.length === 0)) {
      globalChordSpreadSelect.innerHTML = '';
      {
        const opt = document.createElement('option');
        opt.value = 'close';
        opt.textContent = 'Close';
        globalChordSpreadSelect.appendChild(opt);
      }
      {
        const opt = document.createElement('option');
        opt.value = 'open';
        opt.textContent = 'Open';
        globalChordSpreadSelect.appendChild(opt);
      }
    }

    syncGlobalChordControlsUI();
  }

  function syncGlobalChordControlsUI() {
    if (!state.globalChord) state.globalChord = globalChordDefaults();
    state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
    const cfg = state.globalChord;

    if (globalChordOnOffBtn) {
      const on = !!cfg.enabled;
      globalChordOnOffBtn.textContent = on ? 'Chords (global) On' : 'Chords (global) Off';
      globalChordOnOffBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      try { globalChordOnOffBtn.classList.toggle('active', on); } catch (_) {}
    }

    if (globalChordPresetSelect) {
      try { globalChordPresetSelect.value = String(cfg.preset || 'unison'); } catch (_) {}
    }
    if (globalChordSplitSelect) {
      try { globalChordSplitSelect.value = String(cfg.splitStrike || 'simultaneous'); } catch (_) {}
    }
    if (globalChordInversionSelect) {
      const invEnabled = (cfg.size !== 'single' && cfg.size !== 'dyad');
      globalChordInversionSelect.disabled = !invEnabled;
      try { globalChordInversionSelect.value = invEnabled ? String(cfg.inversion || 'root') : 'root'; } catch (_) {}
    }
    if (globalChordSpreadSelect) {
      const spEnabled = (cfg.size !== 'single' && cfg.size !== 'dyad');
      globalChordSpreadSelect.disabled = !spEnabled;
      try { globalChordSpreadSelect.value = String(cfg.spread || 'close'); } catch (_) {}
    }

    const belllike = String(cfg.splitStrike || 'simultaneous') === 'belllike';
    if (globalChordSplitStepControl) globalChordSplitStepControl.classList.toggle('hidden', !belllike);
    if (globalChordSplitMaxControl) globalChordSplitMaxControl.classList.toggle('hidden', !belllike);

    if (globalChordStepMs) {
      try { globalChordStepMs.value = String(clamp(parseInt(String(cfg.stepMs), 10) || 0, 0, 15)); } catch (_) {}
    }
    if (globalChordMaxMs) {
      try { globalChordMaxMs.value = String(clamp(parseInt(String(cfg.maxMs), 10) || 0, 0, 18)); } catch (_) {}
    }

    // v014_p01_global_custom_chords_advanced: Custom preset controls
    const isCustom = String(cfg.preset || '') === 'custom';
    if (globalChordCustomIntervalsControl) globalChordCustomIntervalsControl.classList.toggle('hidden', !isCustom);
    if (globalChordCustomIntervalsInput) {
      try { globalChordCustomIntervalsInput.value = String(cfg.customIntervals || ''); } catch (_) {}
    }
    if (globalChordCustomIntervalsWarn) {
      let msg = '';
      if (isCustom) {
        const cap = Math.min(6, chordVoiceCapForPreset('custom'));
        const parsed = parseCustomChordIntervalsText(cfg.customIntervals, cap);
        if (parsed && parsed.ok && parsed.vals && parsed.vals.length) {
          globalCustomChordLastGoodIntervals = parsed.vals.slice(0, cap);
          if (parsed.autoAddedZero) msg = 'Note: 0 (root) was auto-added.';
        } else {
          msg = 'Invalid intervals; using last valid.';
        }
      }
      globalChordCustomIntervalsWarn.textContent = msg;
      globalChordCustomIntervalsWarn.classList.toggle('hidden', !msg);
    }

    // v014_p01_global_custom_chords_advanced: Global Advanced subsection
    if (globalChordDetuneCents) {
      const v = clamp(parseInt(String(cfg.globalDetuneCents), 10) || 0, -20, 20);
      try { globalChordDetuneCents.value = String(v); } catch (_) {}
      if (globalChordDetuneCentsValue) globalChordDetuneCentsValue.textContent = String(v);
    } else if (globalChordDetuneCentsValue) {
      globalChordDetuneCentsValue.textContent = String(clamp(parseInt(String(cfg.globalDetuneCents), 10) || 0, -20, 20));
    }

    if (globalChordLevelModeSelect) {
      try { globalChordLevelModeSelect.value = String(cfg.globalLevelMode || 'equal'); } catch (_) {}
    }
    if (globalChordLevelGainsControl) globalChordLevelGainsControl.classList.toggle('hidden', String(cfg.globalLevelMode || 'equal') !== 'custom');
    if (globalChordLevelGainsInput) {
      try { globalChordLevelGainsInput.value = String(cfg.globalLevelGains || ''); } catch (_) {}
    }

    if (globalChordSplitOffsetModeSelect) {
      try { globalChordSplitOffsetModeSelect.value = String(cfg.globalSplitOffsetMode || 'auto'); } catch (_) {}
    }
    if (globalChordSplitOffsetsControl) globalChordSplitOffsetsControl.classList.toggle('hidden', String(cfg.globalSplitOffsetMode || 'auto') !== 'custom');
    if (globalChordSplitOffsetsInput) {
      try { globalChordSplitOffsetsInput.value = String(cfg.globalSplitOffsetsMs || ''); } catch (_) {}
    }

    // Keep per-bell effective labels in sync when global chord changes.
    try { syncBellOverridesEffectiveUI(); } catch (_) {}
  }

  // v011_p02_sound_test_instrument_row: stage-sized bell test instrument row (Sound menu)
  function rebuildSoundTestInstrumentRow() {
    if (!soundTestInstrumentRow) return;
    const stage = clamp(parseInt(state.stage, 10) || 6, 4, 12);
    const stageKey = String(stage);
    if (soundTestInstrumentRow.dataset && soundTestInstrumentRow.dataset.stage === stageKey && soundTestInstrumentRow.childElementCount === stage) return;

    let html = '';
    for (let b = 1; b <= stage; b++) {
      const g = bellToGlyph(b);
      // Add Spotlight-row base button class for shared styling (visual only).
      html += '<button type="button" class="rg-sound-test-btn rg-quick-bell-btn" data-bell="' + b + '" aria-label="Ring bell ' + g + '">' + g + '</button>';
    }
    soundTestInstrumentRow.innerHTML = html;
    try { soundTestInstrumentRow.dataset.stage = stageKey; } catch (_) {}
  }

  // v10_p04_sound_quick_bell_row: stage-sized quick test row (Sound menu)
  function rebuildSoundQuickBellRow() {
    if (!soundQuickBellRow) return;
    const stage = clamp(parseInt(state.stage, 10) || 6, 4, 12);
    const stageKey = String(stage);
    if (soundQuickBellRow.dataset && soundQuickBellRow.dataset.stage === stageKey && soundQuickBellRow.childElementCount === stage) return;

    let html = '';
    for (let b = 1; b <= stage; b++) {
      const g = bellToGlyph(b);
      html += '<button type="button" class="rg-quick-bell-btn" data-bell="' + b + '" aria-label="Ring bell ' + g + '">' + g + '</button>';
    }
    soundQuickBellRow.innerHTML = html;
    try { soundQuickBellRow.dataset.stage = stageKey; } catch (_) {}
  }

  function rebuildBellOverridesUI() {
    // Keep Sound test rows in sync with stage, even if the overrides list is not present.
    try { rebuildSoundTestInstrumentRow(); } catch (_) {}
    try { rebuildSoundQuickBellRow(); } catch (_) {}
    // v10_p05_sound_per_bell_hz_slider_preview: rebuilding the list should never leave the preview tone running.
    try { cancelHzSliderPreviewGesture(); } catch (_) {}
    try { stopHzPreviewTone(); } catch (_) {}
    if (!bellOverridesList) return;
    ensureBellOverridesArrays();
    ensureBellChordOverridesArray();

    function escAttr(s) {
      const t = String(s == null ? '' : s);
      return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function chordPresetOptionsHtml(selected) {
      let out = '';
      for (const k of GLOBAL_CHORD_PRESET_ORDER) {
        if (!GLOBAL_CHORD_PRESETS[k]) continue;
        const sel = (String(selected || '') === String(k)) ? ' selected' : '';
        out += '<option value="' + String(k) + '"' + sel + '>' + escAttr(chordPresetLabel(k)) + '</option>';
      }
      return out;
    }

    let html = '';
    for (let b = 1; b <= state.stage; b++) {
      const g = bellToGlyph(b);
      const hzV = (state.bellHzOverride[b] != null && Number.isFinite(Number(state.bellHzOverride[b]))) ? String(state.bellHzOverride[b]) : '';
      const hzSliderV = String(clamp(getBellHz(b), PER_BELL_HZ_SLIDER_MIN, PER_BELL_HZ_SLIDER_MAX));
      const volV = (state.bellVolOverride[b] != null && Number.isFinite(Number(state.bellVolOverride[b]))) ? String(state.bellVolOverride[b]) : '';
      const panV = fmtPan1(state.bellPan[b]);
      const depthV = fmtDepth2(state.bellDepth[b]);


      // v014_p05b_bell_timbre_per_bell_overrides: per-bell timbre override editor state
      const tCfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
      state.bellTimbreOverrides[b] = tCfg;
      const tMode = (String(tCfg.mode || 'inherit') === 'override') ? 'override' : 'inherit';
      const tRl = fmtDepth2(tCfg.bellRingLength);
      const tBr = fmtDepth2(tCfg.bellBrightness);
      const tHd = fmtDepth2(tCfg.bellStrikeHardness);

      // v10_p09_sound_per_bell_chords_overrides: per-bell chord editor state
      const cCfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
      state.bellChordOverrides[b] = cCfg;
      const cMode = (String(cCfg.mode || 'inherit') === 'override') ? 'override' : 'inherit';
      const cEn = !!cCfg.enabled;
      const cPreset = (cCfg.preset && GLOBAL_CHORD_PRESETS[cCfg.preset]) ? String(cCfg.preset) : 'unison';
      const cInv = GLOBAL_CHORD_INVERSION_ORDER.includes(String(cCfg.inversion || 'root')) ? String(cCfg.inversion) : 'root';
      const cSpread = GLOBAL_CHORD_SPREAD_ORDER.includes(String(cCfg.spread || 'close')) ? String(cCfg.spread) : 'close';
      const cSplit = (String(cCfg.splitStrikeMode || 'inherit') === 'simultaneous' || String(cCfg.splitStrikeMode) === 'belllike') ? String(cCfg.splitStrikeMode) : 'inherit';
      const cStep = String(clamp(parseInt(String(cCfg.splitStepMs), 10) || 0, 0, 15));
      const cMax = String(clamp(parseInt(String(cCfg.splitMaxMs), 10) || 0, 0, 18));
      const cWarn = String(cCfg._warn || '').trim();
      const cIntervals = escAttr(String(cCfg.customIntervals || ''));
      const cSplitOffsets = escAttr(String(cCfg.customSplitOffsetsMs || ''));
      const cDetune = escAttr(String(cCfg.customDetuneCents || ''));
      const cLevels = escAttr(String(cCfg.customLevelGains || ''));

      const pianoHtml = bellPianoKeyboardHtml(b, g);

      const octRaw = (state.bellOctaveOverride[b] != null) ? parseInt(String(state.bellOctaveOverride[b]), 10) : NaN;
      const octV = Number.isFinite(octRaw) ? String(clamp(octRaw, 1, 6)) : '';
      let octOpts = '<option value="">(global)</option>';
      for (let o = 1; o <= 6; o++) {
        const sel = (octV && String(o) === octV) ? ' selected' : '';
        octOpts += '<option value="' + String(o) + '"' + sel + '>C' + String(o) + '</option>';
      }
      html += '<div class="rg-bell-override-row" data-bell="' + b + '">' +
        '<div class="rg-bell-override-bell" data-bell="' + b + '" role="button" aria-label="Ring bell ' + g + '">' + g + '</div>' +
        '<div class="rg-bell-override-body">' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Hz</div>' +
              '<div id="bellHzEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<input id="bellHzOverride_' + b + '" type="number" min="20" max="5000" step="0.01" placeholder="(default)" value="' + hzV + '" />' +
              '<input id="bellHzSlider_' + b + '" class="rg-bell-hz-slider" type="range" min="' + String(PER_BELL_HZ_SLIDER_MIN) + '" max="' + String(PER_BELL_HZ_SLIDER_MAX) + '" step="' + String(PER_BELL_HZ_SLIDER_STEP) + '" value="' + hzSliderV + '" aria-label="Bell ' + g + ' Hz slider" />' +
              '<button type="button" class="pill rg-mini" data-act="clearHz" data-bell="' + b + '">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Key</div>' +
              '<div id="bellKeyEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              pianoHtml +
              '<button type="button" class="pill rg-mini" data-act="clearKey" data-bell="' + b + '">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Reg</div>' +
              '<div id="bellOctEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<select id="bellOctOverride_' + b + '">' + octOpts + '</select>' +
              '<button type="button" class="pill rg-mini" data-act="clearOct" data-bell="' + b + '">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Vol</div>' +
              '<div id="bellVolEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<input id="bellVolOverride_' + b + '" type="number" min="0" max="100" step="1" placeholder="(default)" value="' + volV + '" />' +
              '<button type="button" class="pill rg-mini" data-act="clearVol" data-bell="' + b + '">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Pan</div>' +
              '<div id="bellPanReadout_' + b + '" class="rg-bell-override-effective">' + escAttr(panV) + '</div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<input id="bellPan_' + b + '" type="range" min="-1" max="1" step="0.1" value="' + escAttr(panV) + '" />' +
            '</div>' +
          '</div>' +
          '<div class="rg-bell-override-group">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Depth</div>' +
              '<div id="bellDepthReadout_' + b + '" class="rg-bell-override-effective">' + escAttr(depthV) + '</div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<input id="bellDepth_' + b + '" type="range" min="0" max="1" step="0.01" value="' + escAttr(depthV) + '" />' +
            '</div>' +
          '</div>' +

          '<div class="rg-bell-override-group rg-bell-override-group--timbre">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Timbre override</div>' +
              '<div id="bellTimbreEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls rg-bell-timbre-controls">' +
              '<select id="bellTimbreMode_' + b + '" aria-label="Timbre override mode for bell ' + g + '">' +
                '<option value="inherit"' + (tMode === 'inherit' ? ' selected' : '') + '>Inherit (global)</option>' +
                '<option value="override"' + (tMode === 'override' ? ' selected' : '') + '>Override</option>' +
              '</select>' +
              '<div id="bellTimbreOverrideBody_' + b + '" class="rg-bell-timbre-body' + (tMode === 'override' ? '' : ' hidden') + '">' +
                '<div class="rg-bell-timbre-row">' +
                  '<label for="bellTimbreRingLength_' + b + '">Ring Length <span id="bellTimbreRingLengthValue_' + b + '" class="rg-bell-timbre-value">' + escAttr(tRl) + '</span></label>' +
                  '<input id="bellTimbreRingLength_' + b + '" type="range" min="0" max="1" step="0.01" value="' + escAttr(tRl) + '" />' +
                '</div>' +
                '<div class="rg-bell-timbre-row">' +
                  '<label for="bellTimbreBrightness_' + b + '">Brightness <span id="bellTimbreBrightnessValue_' + b + '" class="rg-bell-timbre-value">' + escAttr(tBr) + '</span></label>' +
                  '<input id="bellTimbreBrightness_' + b + '" type="range" min="0" max="1" step="0.01" value="' + escAttr(tBr) + '" />' +
                '</div>' +
                '<div class="rg-bell-timbre-row">' +
                  '<label for="bellTimbreHardness_' + b + '">Hardness <span id="bellTimbreHardnessValue_' + b + '" class="rg-bell-timbre-value">' + escAttr(tHd) + '</span></label>' +
                  '<input id="bellTimbreHardness_' + b + '" type="range" min="0" max="1" step="0.01" value="' + escAttr(tHd) + '" />' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="rg-bell-override-group rg-bell-override-group--chord">' +
            '<div class="rg-bell-override-group-head">' +
              '<div class="rg-bell-override-group-title">Chord</div>' +
              '<div id="bellChordEffective_' + b + '" class="rg-bell-override-effective"></div>' +
            '</div>' +
            '<div class="rg-bell-override-group-controls">' +
              '<div class="rg-bell-chord-controls">' +
                '<div class="rg-bell-chord-row">' +
                  '<select id="bellChordMode_' + b + '" aria-label="Chord mode for bell ' + g + '">' +
                    '<option value="inherit"' + (cMode === 'inherit' ? ' selected' : '') + '>Inherit (global)</option>' +
                    '<option value="override"' + (cMode === 'override' ? ' selected' : '') + '>Override</option>' +
                  '</select>' +
                  '<label class="rg-chord-enable' + (cMode === 'override' ? '' : ' hidden') + '"><input id="bellChordEnabled_' + b + '" type="checkbox"' + (cEn ? ' checked' : '') + ' /> Enable</label>' +
                '</div>' +
                '<div id="bellChordOverrideBody_' + b + '" class="rg-bell-chord-override' + (cMode === 'override' ? '' : ' hidden') + '">' +
                  '<div class="rg-bell-chord-row">' +
                    '<select id="bellChordPreset_' + b + '" aria-label="Chord preset for bell ' + g + '">' + chordPresetOptionsHtml(cPreset) + '</select>' +
                    '<select id="bellChordSplit_' + b + '" aria-label="Split-strike mode for bell ' + g + '">' +
                      '<option value="inherit"' + (cSplit === 'inherit' ? ' selected' : '') + '>Split: Inherit (global)</option>' +
                      '<option value="simultaneous"' + (cSplit === 'simultaneous' ? ' selected' : '') + '>Split: Simultaneous</option>' +
                      '<option value="belllike"' + (cSplit === 'belllike' ? ' selected' : '') + '>Split: Bell-like</option>' +
                    '</select>' +
                  '</div>' +
                  '<div class="rg-bell-chord-row">' +
                    '<select id="bellChordInversion_' + b + '" aria-label="Inversion for bell ' + g + '">' +
                      '<option value="root"' + (cInv === 'root' ? ' selected' : '') + '>Inv: Root</option>' +
                      '<option value="first"' + (cInv === 'first' ? ' selected' : '') + '>Inv: 1st</option>' +
                      '<option value="second"' + (cInv === 'second' ? ' selected' : '') + '>Inv: 2nd</option>' +
                      '<option value="third"' + (cInv === 'third' ? ' selected' : '') + '>Inv: 3rd</option>' +
                    '</select>' +
                    '<select id="bellChordSpread_' + b + '" aria-label="Spread for bell ' + g + '">' +
                      '<option value="close"' + (cSpread === 'close' ? ' selected' : '') + '>Spread: Close</option>' +
                      '<option value="open"' + (cSpread === 'open' ? ' selected' : '') + '>Spread: Open</option>' +
                    '</select>' +
                  '</div>' +
                  '<div id="bellChordBelllikeRow_' + b + '" class="rg-bell-chord-row' + (cSplit === 'belllike' ? '' : ' hidden') + '">' +
                    '<label class="rg-chord-num">Step <input id="bellChordStepMs_' + b + '" type="number" min="0" max="15" step="1" value="' + cStep + '" /></label>' +
                    '<label class="rg-chord-num">Max <input id="bellChordMaxMs_' + b + '" type="number" min="0" max="18" step="1" value="' + cMax + '" /></label>' +
                  '</div>' +
                  '<div id="bellChordWarn_' + b + '" class="rg-inline-warn' + (cWarn ? '' : ' hidden') + '">' + escAttr(cWarn) + '</div>' +
                  '<button id="bellChordAdvBtn_' + b + '" type="button" class="pill rg-mini" data-act="toggleChordAdv" data-bell="' + b + '" aria-expanded="false">Advanced</button>' +
                  '<div id="bellChordAdv_' + b + '" class="rg-bell-chord-adv hidden">' +
                    '<div class="rg-bell-chord-adv-grid">' +
                      '<div class="rg-bell-chord-adv-field">' +
                        '<div class="rg-bell-chord-adv-label">Custom intervals (semitones)</div>' +
                        '<input id="bellChordIntervals_' + b + '" type="text" placeholder="0,4,7" value="' + cIntervals + '" />' +
                      '</div>' +
                      '<div class="rg-bell-chord-adv-field">' +
                        '<div class="rg-bell-chord-adv-label">Custom split offsets (ms)</div>' +
                        '<input id="bellChordSplitOffsets_' + b + '" type="text" placeholder="0,6,12" value="' + cSplitOffsets + '" />' +
                      '</div>' +
                      '<div class="rg-bell-chord-adv-field">' +
                        '<div class="rg-bell-chord-adv-label">Detune (cents)</div>' +
                        '<input id="bellChordDetune_' + b + '" type="text" placeholder="0, -10, 0, +5" value="' + cDetune + '" />' +
                      '</div>' +
                      '<div class="rg-bell-chord-adv-field">' +
                        '<div class="rg-bell-chord-adv-label">Levels</div>' +
                        '<input id="bellChordLevels_' + b + '" type="text" placeholder="1, 0.8, 0.7" value="' + cLevels + '" />' +
                      '</div>' +
                    '</div>' +
                    '<div class="rg-muted rg-bell-chord-adv-note">Detune clamps to ±50 cents. Levels clamp to 0..1.5. Max 6 tones.</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    bellOverridesList.innerHTML = html;
    syncBellOverridesEffectiveUI();
  }

  // v10_p09_sound_per_bell_chords_overrides: per-bell chord UI helpers
  // v014_p05b_bell_timbre_per_bell_overrides: per-bell timbre override UI helpers
  function bellTimbreEffectiveLabel(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    ensureBellTimbreOverridesArray();
    const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
    state.bellTimbreOverrides[b] = cfg;
    return (cfg.mode === 'override') ? 'Override' : 'Inherit';
  }

  function syncBellTimbreOverrideRowUI(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    if (!bellOverridesList) return;
    ensureBellTimbreOverridesArray();
    const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
    state.bellTimbreOverrides[b] = cfg;

    const eff = document.getElementById('bellTimbreEffective_' + b);
    if (eff) eff.textContent = (cfg.mode === 'override') ? 'Override' : 'Inherit';

    const body = document.getElementById('bellTimbreOverrideBody_' + b);
    if (body) body.classList.toggle('hidden', cfg.mode !== 'override');

    const sel = document.getElementById('bellTimbreMode_' + b);
    if (sel) {
      try { sel.value = (cfg.mode === 'override') ? 'override' : 'inherit'; } catch (_) {}
    }

    const rl = document.getElementById('bellTimbreRingLength_' + b);
    if (rl) {
      try { rl.value = String(clamp(Number(cfg.bellRingLength), 0, 1)); } catch (_) {}
    }
    const rlV = document.getElementById('bellTimbreRingLengthValue_' + b);
    if (rlV) rlV.textContent = fmtDepth2(cfg.bellRingLength);

    const br = document.getElementById('bellTimbreBrightness_' + b);
    if (br) {
      try { br.value = String(clamp(Number(cfg.bellBrightness), 0, 1)); } catch (_) {}
    }
    const brV = document.getElementById('bellTimbreBrightnessValue_' + b);
    if (brV) brV.textContent = fmtDepth2(cfg.bellBrightness);

    const hd = document.getElementById('bellTimbreHardness_' + b);
    if (hd) {
      try { hd.value = String(clamp(Number(cfg.bellStrikeHardness), 0, 1)); } catch (_) {}
    }
    const hdV = document.getElementById('bellTimbreHardnessValue_' + b);
    if (hdV) hdV.textContent = fmtDepth2(cfg.bellStrikeHardness);
  }


  function bellChordToneCountHint(cfg) {
    const c = cfg || bellChordOverrideDefaults();
    if (c && c._intervals && Array.isArray(c._intervals) && c._intervals.length) return clamp(c._intervals.length, 1, 6);
    const preset = (c && c.preset && GLOBAL_CHORD_PRESETS[c.preset]) ? String(c.preset) : 'unison';
    const arr = GLOBAL_CHORD_PRESETS[preset] || [0];
    return clamp(arr.length, 1, 6);
  }

  function bellChordEffectiveLabel(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    ensureBellChordOverridesArray();
    const bc = state.bellChordOverrides ? state.bellChordOverrides[b] : null;
    const cfg = sanitizeBellChordOverride(bc || bellChordOverrideDefaults());
    state.bellChordOverrides[b] = cfg;

    const g = state.globalChord ? sanitizeGlobalChordConfig(state.globalChord) : globalChordDefaults();
    const globalOn = !!(g && g.enabled);
    const globalLine = globalOn ? ('Global: On • ' + chordPresetLabel(g.preset)) : 'Global: Off';

    if (cfg.mode === 'override') {
      if (!cfg.enabled) return 'Override: Off • ' + globalLine;
      const toneHint = bellChordToneCountHint(cfg);
      const name = (cfg._intervals && cfg._intervals.length) ? 'Custom intervals' : chordPresetLabel(cfg.preset);
      return 'Override: On • ' + name + ' • ' + String(toneHint) + ' tone' + (toneHint === 1 ? '' : 's');
    }
    return globalLine;
  }

  function syncBellChordOverrideRowUI(bell) {
    const b = clamp(parseInt(bell, 10) || 0, 1, 12);
    if (!bellOverridesList) return;
    ensureBellChordOverridesArray();
    const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
    state.bellChordOverrides[b] = cfg;

    const body = document.getElementById('bellChordOverrideBody_' + b);
    if (body) body.classList.toggle('hidden', cfg.mode !== 'override');

    const enableBox = document.getElementById('bellChordEnabled_' + b);
    if (enableBox) {
      try { enableBox.checked = !!cfg.enabled; } catch (_) {}
      const lab = enableBox.closest ? enableBox.closest('label') : null;
      if (lab) lab.classList.toggle('hidden', cfg.mode !== 'override');
    }

    const splitSel = document.getElementById('bellChordSplit_' + b);
    const splitVal = splitSel ? String(splitSel.value || cfg.splitStrikeMode || 'inherit') : String(cfg.splitStrikeMode || 'inherit');
    const belllikeRow = document.getElementById('bellChordBelllikeRow_' + b);
    if (belllikeRow) belllikeRow.classList.toggle('hidden', !(cfg.mode === 'override' && splitVal === 'belllike'));

    // Disable inversion/spread when the chord has fewer than 3 tones (triad+ only).
    const N = bellChordToneCountHint(cfg);
    const invSel = document.getElementById('bellChordInversion_' + b);
    const spSel = document.getElementById('bellChordSpread_' + b);
    const canInv = (N >= 3);
    if (invSel) invSel.disabled = !canInv;
    if (spSel) spSel.disabled = !canInv;

    const warnEl = document.getElementById('bellChordWarn_' + b);
    if (warnEl) {
      const w = String(cfg._warn || '').trim();
      warnEl.textContent = w;
      warnEl.classList.toggle('hidden', !w);
    }
  }

  function clearBellHzOverride(b) {
    ensureBellOverridesArrays();
    const bb = clamp(parseInt(b, 10) || 0, 1, 12);
    state.bellHzOverride[bb] = null;
    saveBellHzOverridesToLS();
    const input = document.getElementById('bellHzOverride_' + bb);
    if (input) input.value = '';
    const slider = document.getElementById('bellHzSlider_' + bb);
    if (slider) slider.value = String(clamp(getBellHz(bb), PER_BELL_HZ_SLIDER_MIN, PER_BELL_HZ_SLIDER_MAX));
    syncBellOverridesEffectiveUI();
  }

  function clearBellVolOverride(b) {
    ensureBellOverridesArrays();
    const bb = clamp(parseInt(b, 10) || 0, 1, 12);
    state.bellVolOverride[bb] = null;
    saveBellVolOverridesToLS();
    const input = document.getElementById('bellVolOverride_' + bb);
    if (input) input.value = '';
    syncBellOverridesEffectiveUI();
  }

  function clearBellKeyOverride(b) {
    ensureBellOverridesArrays();
    const bb = clamp(parseInt(b, 10) || 0, 1, 12);
    state.bellKeyOverride[bb] = null;
    saveBellKeyOverridesToLS();
    const sel = document.getElementById('bellKeyOverride_' + bb);
    if (sel) sel.value = '';
    syncBellOverridesEffectiveUI();
  }

  function clearBellOctOverride(b) {
    ensureBellOverridesArrays();
    const bb = clamp(parseInt(b, 10) || 0, 1, 12);
    state.bellOctaveOverride[bb] = null;
    saveBellOctOverridesToLS();
    const sel = document.getElementById('bellOctOverride_' + bb);
    if (sel) sel.value = '';
    syncBellOverridesEffectiveUI();
  }

  function resetAllBellOverrides() {
    state.bellHzOverride = new Array(13).fill(null);
    state.bellVolOverride = new Array(13).fill(null);
    state.bellKeyOverride = new Array(13).fill(null);
    state.bellOctaveOverride = new Array(13).fill(null);
    state.bellTimbreOverrides = new Array(13);
    for (let b = 0; b < 13; b++) state.bellTimbreOverrides[b] = bellTimbreOverrideDefaults();
    state.bellChordOverrides = new Array(13);
    for (let b = 0; b < 13; b++) state.bellChordOverrides[b] = bellChordOverrideDefaults();
    safeDelLS(LS_BELL_HZ_OVERRIDE);
    safeDelLS(LS_BELL_VOL_OVERRIDE);
    safeDelLS(LS_BELL_KEY_OVERRIDE);
    safeDelLS(LS_BELL_OCT_OVERRIDE);
    safeDelLS(LS_BELL_TIMBRE_OVERRIDES);
    safeDelLS(LS_BELL_CHORD_OVERRIDES);
    rebuildBellOverridesUI();
  }

  function currentTrebleToneLabel() { return getScaleDef().label; }
  function currentOctaveLabel() { return 'C' + String(state.octaveC); }

  // === Selection ===
  function ensureLiveBells() {
    const max = state.liveCount;

    // v08_p08_defaults_and_ui_fixes: if scoring all bells, auto-select all bells.
    if (max >= state.stage) {
      const all = [];
      for (let b = 1; b <= state.stage; b++) all.push(b);
      state.liveBells = all;
      return;
    }

    const chosen = [];
    for (const b of state.liveBells) {
      if (b >= 1 && b <= state.stage && !chosen.includes(b)) {
        chosen.push(b);
        if (chosen.length >= max) break;
      }
    }
    if (!chosen.length) for (let b = 1; b <= state.stage && chosen.length < max; b++) chosen.push(b);
    state.liveBells = chosen;
  }

  function rebuildLiveCountOptions() {
    liveCountSelect.innerHTML = '';
    for (let n = 1; n <= state.stage; n++) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      liveCountSelect.appendChild(opt);
    }
    state.liveCount = clamp(state.liveCount, 1, state.stage);
    liveCountSelect.value = String(state.liveCount);
  }

  function rebuildBellPicker() {
    ensureLiveBells();
    bellPicker.innerHTML = '';
    for (let b = 1; b <= state.stage; b++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = bellToGlyph(b);
      btn.addEventListener('click', () => {
        markUserTouchedConfig();
        if (state.phase !== 'idle') ensureIdleForPlayChange();
        const max = state.liveCount;
        const list = state.liveBells.slice();
        const idx = list.indexOf(b);
        if (idx >= 0) list.splice(idx, 1);
        else {
          if (list.length >= max) {
            if (max === 1) list.splice(0, 1, b);
            else return;
          } else list.push(b);
        }
        state.liveBells = list;
        rebuildBellPicker();
        resetStats();
      });
      if (state.liveBells.includes(b)) btn.classList.add('selected');
      bellPicker.appendChild(btn);
    }
    rebuildKeybindPanel();
    rebuildMicBellControls();
    syncMicToggleUI();
  }


  // === Keybindings ===
  const LS_KEYBINDS = 'rg_keybindings_v1';
  const LS_GLYPHBINDS = 'rg_glyph_bindings_v1';

  const LS_GLYPHSTYLE = 'rg_glyph_style_v1';
  function loadGlyphBindings() {
    state.glyphBindings = {};
    const raw = safeGetLS(LS_GLYPHBINDS);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        const bell = parseInt(k, 10);
        if (!isFinite(bell) || bell < 1 || bell > 12) continue;
        const val = parsed[k];
        if (typeof val === 'string' && val.length === 1) state.glyphBindings[bell] = val;
      }
    }
  }

  function saveGlyphBindings() {
    safeSetLS(LS_GLYPHBINDS, JSON.stringify(state.glyphBindings || {}));
  }

    // v015_p03a_load_hotfix_glyphs_typing_ui: validate imported glyph binding overrides.
  function ensureGlyphBindings() {
    if (!state.glyphBindings || typeof state.glyphBindings !== 'object') {
      state.glyphBindings = {};
      return;
    }
    const cleaned = {};
    for (const k in state.glyphBindings) {
      if (!Object.prototype.hasOwnProperty.call(state.glyphBindings, k)) continue;
      const bell = parseInt(k, 10);
      if (!isFinite(bell) || bell < 1 || bell > 12) continue;
      const v = state.glyphBindings[k];
      if (typeof v === 'string' && v.length === 1) cleaned[bell] = v;
    }
    state.glyphBindings = cleaned;
  }

// v013_p01c_setup_glyph_color_bindings: setup-only glyph styling persistence.
  function ensureGlyphStyleState() {
    if (!state.glyphStyle || typeof state.glyphStyle !== 'object') {
      state.glyphStyle = { defaultColor: '', bellColors: {}, colorOnly: {} };
    }
    if (typeof state.glyphStyle.defaultColor !== 'string') state.glyphStyle.defaultColor = '';
    if (!state.glyphStyle.bellColors || typeof state.glyphStyle.bellColors !== 'object') state.glyphStyle.bellColors = {};
    if (!state.glyphStyle.colorOnly || typeof state.glyphStyle.colorOnly !== 'object') state.glyphStyle.colorOnly = {};
  }

  function normalizeHexColor(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    const m = /^#([0-9a-fA-F]{6})$/.exec(s);
    return m ? ('#' + m[1].toLowerCase()) : '';
  }

  function loadGlyphStyle() {
    ensureGlyphStyleState();
    state.glyphStyle.defaultColor = '';
    state.glyphStyle.bellColors = {};
    state.glyphStyle.colorOnly = {};

    const raw = safeGetLS(LS_GLYPHSTYLE);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return;

    state.glyphStyle.defaultColor = normalizeHexColor(parsed.defaultColor);

    const bc = parsed.bellColors;
    if (bc && typeof bc === 'object') {
      for (const k in bc) {
        if (!Object.prototype.hasOwnProperty.call(bc, k)) continue;
        const bell = parseInt(k, 10);
        if (!isFinite(bell) || bell < 1 || bell > 12) continue;
        const c = normalizeHexColor(bc[k]);
        if (c) state.glyphStyle.bellColors[bell] = c;
      }
    }

    const co = parsed.colorOnly;
    if (co && typeof co === 'object') {
      for (const k in co) {
        if (!Object.prototype.hasOwnProperty.call(co, k)) continue;
        const bell = parseInt(k, 10);
        if (!isFinite(bell) || bell < 1 || bell > 12) continue;
        if (co[k]) state.glyphStyle.colorOnly[bell] = true;
      }
    }
  }

  function saveGlyphStyle() {
    ensureGlyphStyleState();
    const out = { defaultColor: normalizeHexColor(state.glyphStyle.defaultColor), bellColors: {}, colorOnly: {} };

    const bc = state.glyphStyle.bellColors || {};
    for (const k in bc) {
      if (!Object.prototype.hasOwnProperty.call(bc, k)) continue;
      const bell = parseInt(k, 10);
      if (!isFinite(bell) || bell < 1 || bell > 12) continue;
      const c = normalizeHexColor(bc[k]);
      if (c) out.bellColors[bell] = c;
    }

    const co = state.glyphStyle.colorOnly || {};
    for (const k in co) {
      if (!Object.prototype.hasOwnProperty.call(co, k)) continue;
      const bell = parseInt(k, 10);
      if (!isFinite(bell) || bell < 1 || bell > 12) continue;
      if (co[k]) out.colorOnly[bell] = true;
    }

    safeSetLS(LS_GLYPHSTYLE, JSON.stringify(out));
  }

  function effectiveGlyphBgColor(bell) {
    ensureGlyphStyleState();
    const bc = state.glyphStyle.bellColors;
    if (bc && Object.prototype.hasOwnProperty.call(bc, bell)) return normalizeHexColor(bc[bell]);
    return normalizeHexColor(state.glyphStyle.defaultColor);
  }

  function setupTextColorForBg(hex) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return '';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const y = (r * 299 + g * 587 + b * 114) / 1000;
    return (y >= 150) ? '#10162c' : '';
  }


  // v013_p02b_apply_glyph_color_runtime_views: runtime glyph + color resolution helpers.
  function getBellGlyphChar(bell) {
    const b = parseInt(bell, 10);
    if (!isFinite(b)) return '?';
    const v = (state.glyphBindings && Object.prototype.hasOwnProperty.call(state.glyphBindings, b))
      ? state.glyphBindings[b]
      : null;
    return (typeof v === 'string' && v.length === 1) ? v : bellToGlyph(b);
  }

  function getBellGlyphColor(bell) {
    ensureGlyphStyleState();
    const b = parseInt(bell, 10);
    if (!isFinite(b)) return '';
    const gs = state.glyphStyle || {};
    const bc = gs.bellColors || {};
    let c = '';
    if (Object.prototype.hasOwnProperty.call(bc, b)) c = normalizeHexColor(bc[b]);
    if (!c) c = normalizeHexColor(gs.defaultColor);
    return c;
  }

  function isBellColorOnly(bell) {
    ensureGlyphStyleState();
    const b = parseInt(bell, 10);
    if (!isFinite(b)) return false;
    const co = (state.glyphStyle && state.glyphStyle.colorOnly) ? state.glyphStyle.colorOnly : null;
    return !!(co && co[b]);
  }

  function drawGlyphBgCircle(ctx, cx, cy, r, hex, alpha) {
    if (!hex) return;
    ctx.save();
    ctx.globalAlpha = (alpha == null) ? 0.22 : alpha;
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawGlyphBgRoundRect(ctx, x, y, w, h, radius, hex, alpha) {
    if (!hex) return;
    if (!(w > 1 && h > 1)) return;
    ctx.save();
    ctx.globalAlpha = (alpha == null) ? 0.22 : alpha;
    ctx.fillStyle = hex;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.restore();
  }


  function glyphForBell(bell) {
    const v = (state.glyphBindings && Object.prototype.hasOwnProperty.call(state.glyphBindings, bell))
      ? state.glyphBindings[bell]
      : null;
    return (typeof v === 'string' && v.length === 1) ? v : bellToGlyph(bell);
  }

  // v013_p01a_glyph_binding_allow_modifiers_and_paste:
  // Hidden, focusable input used for glyph binding capture so modifiers (Shift/Alt) and paste (Ctrl/Cmd+V) work.
  let glyphCaptureInputEl = null;

  function ensureGlyphCaptureInput() {
    if (glyphCaptureInputEl && glyphCaptureInputEl.isConnected) return glyphCaptureInputEl;
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'glyph-capture-input';
    el.autocomplete = 'off';
    el.autocapitalize = 'none';
    el.spellcheck = false;
    el.setAttribute('aria-label', 'Glyph capture');
    el.addEventListener('input', onGlyphCaptureInputEvent);
    el.addEventListener('paste', onGlyphCapturePasteEvent);
    el.addEventListener('keydown', onGlyphCaptureKeydownEvent);
    document.body.appendChild(el);
    glyphCaptureInputEl = el;
    return el;
  }

  // Deterministic rule: the glyph is the FIRST character of the typed/pasted text.
  function applyGlyphCaptureText(text) {
    const g = (typeof text === 'string' && text.length) ? text[0] : '';
    const bell = state.glyphCaptureBell;
    if (bell != null && g && g.length === 1) {
      if (!state.glyphBindings || typeof state.glyphBindings !== 'object') state.glyphBindings = {};
      state.glyphBindings[bell] = g;
      saveGlyphBindings();
    }
    state.glyphCaptureBell = null;
    blurGlyphCaptureInput();
    rebuildKeybindPanel();
  }

  function focusGlyphCaptureInput() {
    const el = ensureGlyphCaptureInput();
    el.value = '';
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
  }

  function blurGlyphCaptureInput() {
    if (!glyphCaptureInputEl) return;
    glyphCaptureInputEl.value = '';
    if (document.activeElement === glyphCaptureInputEl) glyphCaptureInputEl.blur();
  }

  function onGlyphCaptureInputEvent(e) {
    if (state.glyphCaptureBell == null) return;
    const el = e && e.target;
    const v = (el && typeof el.value === 'string') ? el.value : '';
    if (v && v.length) applyGlyphCaptureText(v);
  }

  function onGlyphCapturePasteEvent(e) {
    if (state.glyphCaptureBell == null) return;
    if (!e || !e.clipboardData || typeof e.clipboardData.getData !== 'function') return; // allow default paste
    const t = e.clipboardData.getData('text') || '';
    e.preventDefault();
    if (t && t.length) applyGlyphCaptureText(t);
    else applyGlyphCaptureText('');
  }

  function onGlyphCaptureKeydownEvent(e) {
    if (state.glyphCaptureBell == null) return;
    if (e && (e.key === 'Escape' || e.key === 'Enter')) {
      e.preventDefault();
      applyGlyphCaptureText('');
    }
  }


  function normalizeBindKey(k) {
    if (k === ' ') return 'Space';
    if (k === 'Spacebar') return 'Space';
    if (!k) return '';
    if (k.length === 1) return k.toUpperCase();
    return k;
  }

  function formatBindKey(k) {
    const kk = normalizeBindKey(k);
    return kk ? kk : 'Unbound';
  }

  function isAllowedBindKey(k) {
    const kk = normalizeBindKey(k);
    return (kk.length === 1) || kk === 'Enter' || kk === 'Space';
  }

  function defaultBindKeyForBell(bell) {
    const g = bellToGlyph(bell);
    return (g === '?') ? '' : g;
  }

  function loadKeyBindings() {
    state.keyBindings = {};
    const raw = safeGetLS(LS_KEYBINDS);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        const bell = parseInt(k, 10);
        if (!isFinite(bell)) continue;
        const val = parsed[k];
        if (typeof val === 'string') state.keyBindings[bell] = normalizeBindKey(val);
      }
    }
  }

  function saveKeyBindings() {
    safeSetLS(LS_KEYBINDS, JSON.stringify(state.keyBindings));
  }

  function ensureKeyBindings() {
    for (let b = 1; b <= state.stage; b++) {
      if (!Object.prototype.hasOwnProperty.call(state.keyBindings, b)) {
        state.keyBindings[b] = defaultBindKeyForBell(b);
      }
    }
  }

  function resetKeyBindingsToDefaults() {
    for (let b = 1; b <= 12; b++) state.keyBindings[b] = defaultBindKeyForBell(b);
    saveKeyBindings();
  }

  function getLiveKeyConflicts() {
    const live = state.liveBells.slice();
    const usage = {};
    for (const b of live) {
      const k = state.keyBindings[b];
      if (!k) continue;
      if (!usage[k]) usage[k] = [];
      usage[k].push(b);
    }
    const conflicts = new Set();
    for (const k in usage) {
      if (usage[k].length > 1) usage[k].forEach(b => conflicts.add(b));
    }
    return conflicts;
  }


  // v013_p01c_setup_glyph_color_bindings: curated glyph picker (Setup UI only).
  const GLYPH_PICKER_CHARS = (() => {
    // No emojis, no accented letters, omit digits and lowercase.
    const s =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
      '! ? @ # $ % & * + = ~ ^ ( ) [ ] { } < >' +
      ' . , ; : _ - / \\ |' +
      ' ± × ÷ ≠ ≈ ≤ ≥' +
      ' · • ● ○ ◎ ◉' +
      ' ■ □ ◆ ◇ ◈' +
      ' ▲ △ ▼ ▽ ▶ ◀' +
      ' ★ ☆ ✦ ✧ ✩ ✪' +
      ' ← ↑ → ↓ ↖ ↗ ↘ ↙ ⇐ ⇑ ⇒ ⇓' +
      ' ♩ ♪ ♫ ♬ ♭ ♯ ♮';
    const out = [];
    const seen = new Set();
    for (const ch of s) {
      if (!ch || /\s/.test(ch)) continue;
      if (ch >= '0' && ch <= '9') continue;
      if (ch >= 'a' && ch <= 'z') continue;
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push(ch);
    }
    return out;
  })();

  let glyphPickerOverlayEl = null;
  let glyphPickerTitleEl = null;
  let glyphPickerGridEl = null;

  function ensureGlyphPickerOverlay() {
    if (glyphPickerOverlayEl && glyphPickerOverlayEl.isConnected) return glyphPickerOverlayEl;

    const overlay = document.createElement('div');
    overlay.className = 'glyph-picker-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Glyph picker');
    overlay.tabIndex = -1;

    const panel = document.createElement('div');
    panel.className = 'glyph-picker';

    const header = document.createElement('div');
    header.className = 'glyph-picker-header';

    const title = document.createElement('div');
    title.className = 'glyph-picker-title';
    title.textContent = 'Pick a glyph';
    glyphPickerTitleEl = title;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pill glyph-picker-close';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => closeGlyphPicker());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const grid = document.createElement('div');
    grid.className = 'glyph-picker-grid';
    glyphPickerGridEl = grid;

    // Build buttons once; on click, apply to the currently selected bell.
    for (const ch of GLYPH_PICKER_CHARS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'glyph-picker-btn';
      btn.textContent = ch;
      btn.setAttribute('aria-label', `Pick glyph ${ch}`);
      btn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        const bell = state.glyphPickerBell;
        if (bell == null) return;
        markUserTouchedConfig();
        if (!state.glyphBindings || typeof state.glyphBindings !== 'object') state.glyphBindings = {};
        state.glyphBindings[bell] = ch;
        saveGlyphBindings();
        closeGlyphPicker();
        rebuildKeybindPanel();
      });
      grid.appendChild(btn);
    }

    const foot = document.createElement('div');
    foot.className = 'glyph-picker-foot';
    foot.textContent = 'Tip: You can also type/paste any single character via “Bind Glyph”. (Esc closes)';

    panel.appendChild(header);
    panel.appendChild(grid);
    panel.appendChild(foot);

    overlay.appendChild(panel);

    overlay.addEventListener('click', (e) => {
      if (e && e.target === overlay) closeGlyphPicker();
    });

    document.body.appendChild(overlay);
    glyphPickerOverlayEl = overlay;
    return overlay;
  }

  function openGlyphPicker(bell) {
    if (state.phase !== 'idle') return;
    state.keybindCaptureBell = null;
    state.glyphCaptureBell = null;
    blurGlyphCaptureInput();

    state.glyphPickerBell = bell;
    const overlay = ensureGlyphPickerOverlay();
    if (glyphPickerTitleEl) glyphPickerTitleEl.textContent = 'Pick a glyph for Bell ' + bellToGlyph(bell);
    try { overlay.focus(); } catch (_) {}
    rebuildKeybindPanel();
  }

  function closeGlyphPicker() {
    state.glyphPickerBell = null;
    if (glyphPickerOverlayEl && glyphPickerOverlayEl.isConnected) glyphPickerOverlayEl.remove();
    glyphPickerOverlayEl = null;
    glyphPickerTitleEl = null;
    glyphPickerGridEl = null;
  }



  function rebuildKeybindPanel() {
    if (!keybindPanel) return;
    ensureKeyBindings();
    ensureGlyphStyleState();
    if (!state.glyphBindings || typeof state.glyphBindings !== 'object') state.glyphBindings = {};

    const live = state.liveBells.slice().sort((a,b)=>a-b);
    const stageN = clamp(parseInt(state.stage, 10) || 0, 1, 12);
    keybindPanel.innerHTML = '';

    const makeCell = (extraClass) => {
      const cell = document.createElement('div');
      cell.className = extraClass ? ('keybind-cell ' + extraClass) : 'keybind-cell';
      return cell;
    };

    // v013_p03_setup_bells_block_ui_polish: header row for geometric grid
    const headerRow = document.createElement('div');
    headerRow.className = 'keybind-row keybind-header';
    for (const h of ['Bell','Glyph','Key','Color','Color-only','Clear']) {
      const cell = makeCell('keybind-cell-header');
      cell.textContent = h;
      headerRow.appendChild(cell);
    }
    keybindPanel.appendChild(headerRow);

    // v013_p01c_setup_glyph_color_bindings: global default glyph color (Setup UI only)
    const globalRow = document.createElement('div');
    globalRow.className = 'keybind-row keybind-row-global';

    const globalLabel = document.createElement('span');
    globalLabel.className = 'keybind-bell keybind-global-label';
    globalLabel.textContent = 'Default';

    const globalDesc = document.createElement('span');
    globalDesc.className = 'keybind-global-desc';
    globalDesc.textContent = 'Default glyph color';

    const globalColorInput = document.createElement('input');
    globalColorInput.type = 'color';
    globalColorInput.className = 'keybind-color-input keybind-color-default';
    globalColorInput.value = normalizeHexColor(state.glyphStyle.defaultColor) || '#000000';
    globalColorInput.disabled = state.phase !== 'idle';
    globalColorInput.addEventListener('input', () => {
      markUserTouchedConfig();
      ensureGlyphStyleState();
      state.glyphStyle.defaultColor = normalizeHexColor(globalColorInput.value);
      saveGlyphStyle();
      rebuildKeybindPanel();
    });

    const globalMeta = document.createElement('span');
    globalMeta.className = 'keybind-color-meta';
    globalMeta.textContent = state.glyphStyle.defaultColor ? state.glyphStyle.defaultColor.toUpperCase() : 'none';

    const globalClearBtn = document.createElement('button');
    globalClearBtn.type = 'button';
    globalClearBtn.className = 'pill keybind-bind-btn keybind-color-clear';
    globalClearBtn.textContent = 'Clear';
    globalClearBtn.title = 'Clear default glyph color';
    globalClearBtn.disabled = state.phase !== 'idle' || !state.glyphStyle.defaultColor;
    globalClearBtn.addEventListener('click', () => {
      if (state.phase !== 'idle') return;
      markUserTouchedConfig();
      ensureGlyphStyleState();
      state.glyphStyle.defaultColor = '';
      saveGlyphStyle();
      rebuildKeybindPanel();
    });

    const gBellCell = makeCell('keybind-cell-bell');
    gBellCell.appendChild(globalLabel);

    const gGlyphCell = makeCell('keybind-cell-empty');
    const gKeyCell = makeCell('keybind-cell-empty');

    const gColorCell = makeCell('keybind-cell-color');
    const gColorControls = document.createElement('div');
    gColorControls.className = 'keybind-color-controls keybind-color-controls-global';
    gColorControls.appendChild(globalDesc);
    gColorControls.appendChild(globalColorInput);
    gColorControls.appendChild(globalMeta);
    gColorCell.appendChild(gColorControls);

    const gCOCell = makeCell('keybind-cell-empty');
    const gClearCell = makeCell('keybind-cell-clear');
    gClearCell.appendChild(globalClearBtn);

    globalRow.appendChild(gBellCell);
    globalRow.appendChild(gGlyphCell);
    globalRow.appendChild(gKeyCell);
    globalRow.appendChild(gColorCell);
    globalRow.appendChild(gCOCell);
    globalRow.appendChild(gClearCell);
    keybindPanel.appendChild(globalRow);

    const conflicts = getLiveKeyConflicts();

    let alt = false;
    for (let b = 1; b <= stageN; b++) {
      const row = document.createElement('div');
      row.className = 'keybind-row keybind-row-bell';
      alt = !alt;
      if (alt) row.classList.add('alt');
      if (conflicts.has(b)) row.classList.add('conflict');
      if (state.keybindCaptureBell === b) row.classList.add('capture');
      if (state.glyphCaptureBell === b) row.classList.add('glyph-capture');

      const bellLabel = document.createElement('span');
      bellLabel.className = 'keybind-bell';
      bellLabel.textContent = 'Bell ' + bellToGlyph(b);
      bellLabel.title = 'Bell ' + b;

      const glyphLabel = document.createElement('span');
      glyphLabel.className = 'keybind-glyph';

      const isColorOnly = !!(state.glyphStyle && state.glyphStyle.colorOnly && state.glyphStyle.colorOnly[b]);
      glyphLabel.textContent = (state.glyphCaptureBell === b) ? 'Type glyph…' : glyphForBell(b);
      if (isColorOnly) glyphLabel.classList.add('keybind-glyph-muted');

      // Apply Setup-only color preview (do not affect Display/Spotlight/Notation in this prompt).
      if (state.glyphCaptureBell !== b) {
        const bg = effectiveGlyphBgColor(b);
        if (bg) {
          glyphLabel.style.backgroundColor = bg;
          glyphLabel.style.borderColor = 'rgba(0,0,0,0.18)';
          const tc = setupTextColorForBg(bg);
          glyphLabel.style.color = tc || '';
        } else {
          glyphLabel.style.backgroundColor = '';
          glyphLabel.style.borderColor = '';
          glyphLabel.style.color = '';
        }
      } else {
        // Let capture highlight styles apply
        glyphLabel.style.backgroundColor = '';
        glyphLabel.style.borderColor = '';
        glyphLabel.style.color = '';
      }

      const glyphBtn = document.createElement('button');
      glyphBtn.type = 'button';
      glyphBtn.className = 'pill keybind-bind-btn keybind-glyph-btn';
      glyphBtn.textContent = (state.glyphCaptureBell === b) ? 'Cancel' : 'Bind Glyph';
      glyphBtn.disabled = state.phase !== 'idle';
      glyphBtn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        closeGlyphPicker();
        state.keybindCaptureBell = null;
        state.glyphCaptureBell = (state.glyphCaptureBell === b) ? null : b;
        rebuildKeybindPanel();
      });

      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = 'pill keybind-bind-btn keybind-glyph-pick-btn';
      pickBtn.textContent = 'Pick…';
      pickBtn.disabled = state.phase !== 'idle';
      pickBtn.addEventListener('click', () => openGlyphPicker(b));

      const glyphControls = document.createElement('div');
      glyphControls.className = 'keybind-glyph-controls';
      glyphControls.appendChild(glyphBtn);
      glyphControls.appendChild(pickBtn);

      // Per-bell color override + clear
      const bellOverride = (state.glyphStyle && state.glyphStyle.bellColors && Object.prototype.hasOwnProperty.call(state.glyphStyle.bellColors, b))
        ? normalizeHexColor(state.glyphStyle.bellColors[b])
        : '';

      const globalNorm = normalizeHexColor(state.glyphStyle.defaultColor) || '';

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'keybind-color-input keybind-color-bell';
      colorInput.value = bellOverride || globalNorm || '#000000';
      colorInput.disabled = state.phase !== 'idle';
      colorInput.title = bellOverride
        ? ('Color override: ' + bellOverride)
        : (globalNorm ? ('Using global: ' + globalNorm) : 'No color set');
      colorInput.addEventListener('input', () => {
        markUserTouchedConfig();
        ensureGlyphStyleState();
        if (!state.glyphStyle.bellColors || typeof state.glyphStyle.bellColors !== 'object') state.glyphStyle.bellColors = {};
        const c = normalizeHexColor(colorInput.value);
        if (c) state.glyphStyle.bellColors[b] = c;
        saveGlyphStyle();
        rebuildKeybindPanel();
      });

      const colorMeta = document.createElement('span');
      colorMeta.className = 'keybind-color-meta';
      colorMeta.textContent = bellOverride ? ('override ' + bellOverride.toUpperCase()) : (globalNorm ? ('global ' + globalNorm.toUpperCase()) : 'none');

      const colorClearBtn = document.createElement('button');
      colorClearBtn.type = 'button';
      colorClearBtn.className = 'pill keybind-bind-btn keybind-color-clear';
      colorClearBtn.textContent = 'Clear';
      colorClearBtn.title = 'Clear color override';
      colorClearBtn.disabled = state.phase !== 'idle' || !bellOverride;
      colorClearBtn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        markUserTouchedConfig();
        ensureGlyphStyleState();
        if (state.glyphStyle.bellColors && Object.prototype.hasOwnProperty.call(state.glyphStyle.bellColors, b)) {
          delete state.glyphStyle.bellColors[b];
        }
        saveGlyphStyle();
        rebuildKeybindPanel();
      });

      const coLabel = document.createElement('label');
      coLabel.className = 'keybind-coloronly';
      const co = document.createElement('input');
      co.type = 'checkbox';
      co.checked = isColorOnly;
      co.disabled = state.phase !== 'idle';
      co.addEventListener('change', () => {
        if (state.phase !== 'idle') return;
        markUserTouchedConfig();
        ensureGlyphStyleState();
        if (co.checked) state.glyphStyle.colorOnly[b] = true;
        else if (state.glyphStyle.colorOnly && Object.prototype.hasOwnProperty.call(state.glyphStyle.colorOnly, b)) delete state.glyphStyle.colorOnly[b];
        saveGlyphStyle();
        rebuildKeybindPanel();
      });
      coLabel.appendChild(co);
      coLabel.appendChild(document.createTextNode('Color-only'));

      const keyLabel = document.createElement('span');
      keyLabel.className = 'keybind-key';
      keyLabel.textContent = (state.keybindCaptureBell === b) ? 'Press key…' : formatBindKey(state.keyBindings[b]);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill keybind-bind-btn';
      btn.textContent = (state.keybindCaptureBell === b) ? 'Cancel' : 'Bind key';
      btn.disabled = state.phase !== 'idle';
      btn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        closeGlyphPicker();
        state.glyphCaptureBell = null;
        state.keybindCaptureBell = (state.keybindCaptureBell === b) ? null : b;
        rebuildKeybindPanel();
      });

      // v013_p04_setup_any_keybinding_ui: Setup-only ANY keybinding option (no runtime behavior here)
      const anyBtn = document.createElement('button');
      anyBtn.type = 'button';
      anyBtn.className = 'pill keybind-bind-btn keybind-any-btn';
      anyBtn.textContent = 'ANY';
      anyBtn.title = 'Bind ANY (setup only)';
      anyBtn.disabled = state.phase !== 'idle';
      const isAny = (normalizeBindKey(state.keyBindings[b]) === 'ANY');
      anyBtn.classList.toggle('active', isAny);
      anyBtn.setAttribute('aria-pressed', isAny ? 'true' : 'false');
      anyBtn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        closeGlyphPicker();
        state.glyphCaptureBell = null;
        state.keybindCaptureBell = null;
        state.keyBindings[b] = 'ANY';
        saveKeyBindings();
        rebuildKeybindPanel();
      });


      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'pill keybind-bind-btn keybind-mic-btn';
      micBtn.textContent = 'Mic';
      micBtn.setAttribute('data-mic-bell', String(b));
      micBtn.title = 'Toggle mic input for this bell';
      const micSelected = (state.micBells || []).includes(b);
      const micActive = micSelected && !!state.micEnabled && state.mode !== 'demo';
      // v08_p08_defaults_and_ui_fixes: highlight only when mic is truly enabled for this configuration.
      micBtn.classList.toggle('mic-on', micActive);
      micBtn.setAttribute('aria-pressed', micSelected ? 'true' : 'false');
      micBtn.setAttribute('aria-label', micSelected ? `Mic selected for bell ${bellToGlyph(b)}` : `Mic not selected for bell ${bellToGlyph(b)}`);
      micBtn.addEventListener('click', () => {
        markUserTouchedConfig();
        const set = new Set(state.micBells || []);
        if (set.has(b)) set.delete(b);
        else set.add(b);
        state.micBells = Array.from(set).sort((x, y) => x - y);
        rebuildMicBellControls();
        syncMicToggleUI();
      });

      // Per-bell Clear: glyph binding + color override + color-only flag
      const rowClearBtn = document.createElement('button');
      rowClearBtn.type = 'button';
      rowClearBtn.className = 'pill keybind-bind-btn keybind-row-clear';
      rowClearBtn.textContent = 'Clear';
      rowClearBtn.title = 'Clear per-bell glyph/color settings';
      const hasGlyphOverride = Object.prototype.hasOwnProperty.call(state.glyphBindings, b);
      const canClearRow = hasGlyphOverride || !!bellOverride || isColorOnly;
      rowClearBtn.disabled = state.phase !== 'idle' || !canClearRow;
      rowClearBtn.addEventListener('click', () => {
        if (state.phase !== 'idle') return;
        markUserTouchedConfig();
        closeGlyphPicker();
        state.glyphCaptureBell = null;
        state.keybindCaptureBell = null;

        let touched = false;
        if (state.glyphBindings && Object.prototype.hasOwnProperty.call(state.glyphBindings, b)) {
          delete state.glyphBindings[b];
          touched = true;
        }
        ensureGlyphStyleState();
        if (state.glyphStyle.bellColors && Object.prototype.hasOwnProperty.call(state.glyphStyle.bellColors, b)) {
          delete state.glyphStyle.bellColors[b];
          touched = true;
        }
        if (state.glyphStyle.colorOnly && Object.prototype.hasOwnProperty.call(state.glyphStyle.colorOnly, b)) {
          delete state.glyphStyle.colorOnly[b];
          touched = true;
        }
        if (touched) {
          saveGlyphBindings();
          saveGlyphStyle();
        }
        rebuildKeybindPanel();
      });

      // Build geometric grid cells
      const bellCell = makeCell('keybind-cell-bell');
      bellCell.appendChild(bellLabel);

      const glyphCell = makeCell('keybind-cell-glyph');
      const glyphStack = document.createElement('div');
      glyphStack.className = 'keybind-cell-stack';
      glyphStack.appendChild(glyphLabel);
      glyphStack.appendChild(glyphControls);
      glyphCell.appendChild(glyphStack);

      const keyCell = makeCell('keybind-cell-key');
      const keyStack = document.createElement('div');
      keyStack.className = 'keybind-cell-stack';
      keyStack.appendChild(keyLabel);
      const keyControls = document.createElement('div');
      keyControls.className = 'keybind-controls keybind-key-controls';
      keyControls.appendChild(btn);
      keyControls.appendChild(anyBtn);
      keyControls.appendChild(micBtn);
      keyStack.appendChild(keyControls);
      keyCell.appendChild(keyStack);

      const colorCell = makeCell('keybind-cell-color');
      const colorControls = document.createElement('div');
      colorControls.className = 'keybind-color-controls';
      colorControls.appendChild(colorInput);
      colorControls.appendChild(colorMeta);
      colorControls.appendChild(colorClearBtn);
      colorCell.appendChild(colorControls);

      const colorOnlyCell = makeCell('keybind-cell-coloronly');
      colorOnlyCell.appendChild(coLabel);

      const clearCell = makeCell('keybind-cell-clear');
      clearCell.appendChild(rowClearBtn);

      row.appendChild(bellCell);
      row.appendChild(glyphCell);
      row.appendChild(keyCell);
      row.appendChild(colorCell);
      row.appendChild(colorOnlyCell);
      row.appendChild(clearCell);

      keybindPanel.appendChild(row);
    }

    if (keybindResetBtn) keybindResetBtn.disabled = state.phase !== 'idle';

    if (keybindNote) {
      if (state.glyphCaptureBell != null) {
        keybindNote.textContent = 'Type or paste a single character for the glyph (Ctrl/Cmd+V, Esc to cancel).';
      } else if (state.keybindCaptureBell != null) {
        keybindNote.textContent = 'Press a letter/number key, Space, or Enter (Esc to cancel).';
      } else if (!live.length) {
        keybindNote.textContent = 'No scored bells selected.';
      } else if (live.length === 1) {
        keybindNote.textContent = 'Tip: Space and Enter also ring the only scored bell.';
      } else if (conflicts.size) {
        keybindNote.textContent = 'Fix conflicts: each key can be bound to only one scored bell.';
      } else keybindNote.textContent = '';
    }

    // v013_p01a_glyph_binding_allow_modifiers_and_paste: keep hidden glyph input focused so
    // modifiers (Shift/Alt) and paste (Ctrl/Cmd+V) work during glyph binding.
    if (state.glyphCaptureBell != null) {
      focusGlyphCaptureInput();
    } else {
      blurGlyphCaptureInput();
    }
  }


  function ensurePathBells() {
    const keep = [];
    for (const b of state.pathBells) if (b >= 1 && b <= state.stage && !keep.includes(b)) keep.push(b);
    state.pathBells = keep;
  }
  function updatePathButtons() {
    const none = state.pathBells.length === 0;
    const all = state.pathBells.length === state.stage && state.pathBells.every(b => b>=1 && b<=state.stage);
    pathNoneBtn.classList.toggle('active', none);
    pathAllBtn.classList.toggle('active', all);
    syncViewMenuSelectedUI();
  }
  function rebuildPathPicker() {
    ensurePathBells();
    pathPicker.innerHTML = '';
    for (let b = 1; b <= state.stage; b++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = bellToGlyph(b);
      btn.addEventListener('click', () => {
        markUserTouchedConfig();
        const list = state.pathBells.slice();
        const idx = list.indexOf(b);
        if (idx >= 0) list.splice(idx, 1);
        else list.push(b);
        state.pathBells = list;
        rebuildPathPicker();
      });
      if (state.pathBells.includes(b)) btn.classList.add('selected');
      pathPicker.appendChild(btn);
    }
    updatePathButtons();
    markDirty();
  }
  function setPathNone() { state.pathBells = []; rebuildPathPicker(); }
  function setPathAll() { state.pathBells = []; for (let b=1; b<=state.stage; b++) state.pathBells.push(b); rebuildPathPicker(); }
  function getPathMode() {
    if (state.pathBells.length === 0) return 'none';
    if (state.pathBells.length === state.stage) return 'all';
    return 'custom';
  }

  // === Layout presets (CSS classes only; no DOM moves) ===
  function applyLayoutPreset(presetValue) {
    if (!main) return;
    const v = String(presetValue || 'auto');

    main.classList.remove('layout-two-col', 'layout-one-wide', 'layout-one-narrow', 'layout-mobile-thumb');

    let cls = '';
    if (v === 'two_col') cls = 'layout-two-col';
    else if (v === 'one_wide') cls = 'layout-one-wide';
    else if (v === 'one_narrow') cls = 'layout-one-narrow';
    else if (v === 'mobile_thumb') cls = 'layout-mobile-thumb';
    else {
      const coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || (window.innerWidth < 700);
      cls = coarse ? 'layout-mobile-thumb' : 'layout-two-col';
    }

    if (cls) main.classList.add(cls);
    markDirty();
    kickLoop();
  }

  function syncLayoutPresetUI() {
    let v = safeGetLS(LS_LAYOUT_PRESET);
    if (!v) v = 'auto';
    v = String(v);
    if (!(v === 'auto' || v === 'two_col' || v === 'one_wide' || v === 'one_narrow' || v === 'mobile_thumb')) v = 'auto';

    if (layoutPresetSelect) layoutPresetSelect.value = v;
    applyLayoutPreset(v);
  }

  // v06_p15_notation_single_page_mode
  function syncNotationLayoutUI() {
    let v = safeGetLS(LS_NOTATION_LAYOUT);
    if (!v) v = isMobileLikely() ? 'one_page' : 'two_page';
    v = String(v);
    if (!(v === 'two_page' || v === 'one_page')) v = isMobileLikely() ? 'one_page' : 'two_page';

    ui.notationLayout = v;
    if (notationLayoutSelect) notationLayoutSelect.value = v;

    // Layout affects paging step and geometry.
    markDirty();
    kickLoop();
  }

  // v06_p9b_view_menu_selected_states: Selected/on UI for View menu toggles & button groups.
  // Pure UI: reads existing inputs/state as the source of truth; no new persistence.
  function syncViewMenuSelectedUI() {
    const root = document.getElementById('viewMenuControls');
    if (!root) return;

    // Checkbox/radio toggles styled as pills: reflect checked state on the label.
    const toggleLabels = root.querySelectorAll('label.toggle');
    for (const lbl of toggleLabels) {
      const inp = lbl.querySelector('input[type="checkbox"], input[type="radio"]');
      if (!inp) continue;
      lbl.classList.toggle('is-selected', !!inp.checked);
    }

    // Button-style toggle group(s) within View (e.g., Line: None/All)
    if (pathNoneBtn) {
      const on = pathNoneBtn.classList.contains('active');
      pathNoneBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      pathNoneBtn.classList.toggle('is-selected', on);
    }
    if (pathAllBtn) {
      const on = pathAllBtn.classList.contains('active');
      pathAllBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      pathAllBtn.classList.toggle('is-selected', on);
    }
  }

  // v09_p07b_notation_spotlight_accuracy_dots: preferences + UI
  function loadAccuracyDotsPrefs() {
    const raw = safeGetLS(LS_ACCURACY_DOTS);
    const j = safeJsonParse(raw || '');
    if (!j || typeof j !== 'object') return;
    if (typeof j.accuracyDotsEnabled === 'boolean') state.accuracyDotsEnabled = j.accuracyDotsEnabled;
    if (typeof j.accuracyDotsDisplay === 'boolean') state.accuracyDotsDisplay = j.accuracyDotsDisplay;
    if (typeof j.accuracyDotsNotation === 'boolean') state.accuracyDotsNotation = j.accuracyDotsNotation;
    if (typeof j.accuracyDotsSpotlight === 'boolean') state.accuracyDotsSpotlight = j.accuracyDotsSpotlight;
  }

  function saveAccuracyDotsPrefs() {
    const payload = {
      accuracyDotsEnabled: !!state.accuracyDotsEnabled,
      accuracyDotsDisplay: !!state.accuracyDotsDisplay,
      accuracyDotsNotation: !!state.accuracyDotsNotation,
      accuracyDotsSpotlight: !!state.accuracyDotsSpotlight
    };
    safeSetLS(LS_ACCURACY_DOTS, JSON.stringify(payload));
  }

  function syncAccuracyDotsUI() {
    if (accuracyDotsEnabled) accuracyDotsEnabled.checked = !!state.accuracyDotsEnabled;
    if (accuracyDotsDisplay) accuracyDotsDisplay.checked = !!state.accuracyDotsDisplay;
    if (accuracyDotsNotation) accuracyDotsNotation.checked = !!state.accuracyDotsNotation;
    if (accuracyDotsSpotlight) accuracyDotsSpotlight.checked = !!state.accuracyDotsSpotlight;

    const masterOn = !!state.accuracyDotsEnabled;
    if (accuracyDotsDisplay) accuracyDotsDisplay.disabled = !masterOn;
    if (accuracyDotsNotation) accuracyDotsNotation.disabled = !masterOn;
    if (accuracyDotsSpotlight) accuracyDotsSpotlight.disabled = !masterOn;
    syncViewMenuSelectedUI();
  }

  function syncAccuracyDotsPrefsFromUI() {
    if (accuracyDotsEnabled) state.accuracyDotsEnabled = !!accuracyDotsEnabled.checked;
    if (accuracyDotsDisplay) state.accuracyDotsDisplay = !!accuracyDotsDisplay.checked;
    if (accuracyDotsNotation) state.accuracyDotsNotation = !!accuracyDotsNotation.checked;
    if (accuracyDotsSpotlight) state.accuracyDotsSpotlight = !!accuracyDotsSpotlight.checked;
    saveAccuracyDotsPrefs();
    syncAccuracyDotsUI();
    markDirty();
    if (!inLoopTick && (loopTimer != null || loopRAF != null)) kickLoop();
  }

  // === View layout ===
  function syncViewLayout() {
    displayPane.classList.toggle('hidden', !viewDisplay.checked);
    spotlightPane.classList.toggle('hidden', !viewSpotlight.checked);
    micPane.classList.toggle('hidden', !viewMic.checked);
    notationPane.classList.toggle('hidden', !viewNotation.checked);
    statsPane.classList.toggle('hidden', !viewStats.checked);

    const leftVisible = viewDisplay.checked || viewSpotlight.checked || viewMic.checked;
    leftStack.classList.toggle('hidden', !leftVisible);

    const rightVisible = viewNotation.checked;
    main.classList.toggle('onecol', !(leftVisible && rightVisible));

    syncViewMenuSelectedUI();
    markDirty();
    if (state.micActive && viewMic.checked) kickLoop();
  }


  // === Mic input (silent scoring) ===
  function dbToLin(db) { return Math.pow(10, db / 20); }
  function linToDb(lin) { return lin > 0 ? (20 * Math.log10(lin)) : -Infinity; }

  function setMicUiStatus(msg, isError = false) {
    if (micStatus) {
      micStatus.textContent = msg || '';
      micStatus.style.color = isError ? 'rgba(255, 107, 107, 0.95)' : '';
    }
    if (micPaneStatus) {
      micPaneStatus.textContent = msg || '';
      micPaneStatus.style.color = isError ? 'rgba(255, 107, 107, 0.95)' : '';
    }
  }

  function syncMicToggleUI() {
    if (!micToggleBtn) return;
    const on = !!state.micEnabled;
    micToggleBtn.textContent = on ? 'Mic ON' : 'Mic OFF';
    micToggleBtn.classList.toggle('mic-on', on);
    micToggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');

    // status hint
    if (!on) {
      setMicUiStatus(state.micError ? state.micError : '', !!state.micError);
      return;
    }

    const live = (state.liveBells || []).length;
    const chosen = getMicControlledBells().length;
    if (live >= 1 && chosen === 0) {
      setMicUiStatus('Select mic bell(s) below');
      return;
    }

    if (!state.micActive) {
      // Enabled in UI, but capture requires a gesture.
      setMicUiStatus(state.micError ? state.micError : 'Click Mic or Start to activate', !!state.micError);
      return;
    }

    // Active: only show errors persistently.
    setMicUiStatus(state.micError ? state.micError : '', !!state.micError);
  }

  function syncMicSlidersUI() {
    if (micCooldown) micCooldown.value = String(state.micCooldownMs);
    if (micCooldownVal) micCooldownVal.textContent = `${Math.round(state.micCooldownMs)} ms`;
  }

  let micCalibrateTimer = null;
  let micCalibrating = false;

  function setMicCalibrateStatus(msg, isError = false, autoClearMs = 2500) {
    if (!micCalibrateStatus) return;
    micCalibrateStatus.textContent = msg || '';
    micCalibrateStatus.style.color = isError ? 'rgba(255, 107, 107, 0.95)' : '';
    if (micCalibrateTimer) {
      clearTimeout(micCalibrateTimer);
      micCalibrateTimer = null;
    }
    if (msg && autoClearMs > 0) {
      micCalibrateTimer = setTimeout(() => {
        if (!micCalibrateStatus) return;
        micCalibrateStatus.textContent = '';
        micCalibrateStatus.style.color = '';
        micCalibrateTimer = null;
      }, autoClearMs);
    }
  }

  function rmsFromByteTimeDomain(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = (bytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / bytes.length);
  }

  async function calibrateMicThreshold() {
    if (micCalibrating) return;
    micCalibrating = true;
    if (micCalibrateBtn) micCalibrateBtn.disabled = true;

    const durationMs = 1200;
    const headroom = 1.8;

    let tmpStream = null;
    let tmpSource = null;
    let tmpAnalyser = null;
    let tmpSink = null;
    let usingExisting = false;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia not supported');

      setMicCalibrateStatus('listening…', false, 0);

      let analyser = null;
      if (state.micActive && state.micAnalyser) {
        analyser = state.micAnalyser;
        usingExisting = true;
      } else {
        ensureAudio();
        try { if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); } catch (_) {}

        tmpStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        });
        tmpSource = audioCtx.createMediaStreamSource(tmpStream);
        tmpAnalyser = audioCtx.createAnalyser();
        tmpAnalyser.fftSize = 2048;
        tmpSink = audioCtx.createMediaStreamDestination();
        tmpSource.connect(tmpAnalyser);
        tmpAnalyser.connect(tmpSink);
        analyser = tmpAnalyser;
      }

      const buf = new Uint8Array(analyser.fftSize);
      const samples = [];
      const startMs = perfNow();

      await new Promise(resolve => {
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          samples.push(rmsFromByteTimeDomain(buf));
          if (perfNow() - startMs < durationMs) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      });

      if (!samples.length) throw new Error('no samples');
      samples.sort((a, b) => a - b);
      const mid = Math.floor(samples.length / 2);
      const median = (samples.length % 2) ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;

      const next = clamp(median * headroom, 0.01, 0.25);
      window.micThreshold = next;
      safeSetLS(LS_MIC_THRESHOLD, String(next));

      setMicCalibrateStatus(`threshold: ${next.toFixed(3)}`, false, 2500);
    } catch (err) {
      console.error('Mic calibration failed', err);
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setMicCalibrateStatus(denied ? 'mic denied' : 'calibration failed', true, 2500);
    } finally {
      // cleanup
      try {
        if (!usingExisting && tmpSource) tmpSource.disconnect();
      } catch (_) {}
      try {
        if (!usingExisting && tmpAnalyser) tmpAnalyser.disconnect();
      } catch (_) {}
      if (tmpStream) {
        try { tmpStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }

      if (micCalibrateBtn) micCalibrateBtn.disabled = false;
      micCalibrating = false;
    }
  }

  function parseBellList(s) {
    if (!s) return [];
    const out = [];
    String(s).split(',').forEach(x => {
      const n = parseInt(String(x).trim(), 10);
      if (!Number.isFinite(n)) return;
      if (n < 1 || n > 12) return;
      out.push(n);
    });
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }


  function getMicControlledBells() {
    const live = (state.liveBells || []).slice().sort((a, b) => a - b);
    const liveSet = new Set(live);
    const chosen = (state.micBells || []).filter(b => liveSet.has(b));
    // dedupe + sort
    return Array.from(new Set(chosen)).sort((a, b) => a - b);
  }

  function rebuildMicBellControls() {
    // Mic v2: per-bell mic toggles live next to "Bind key" in the Keybindings panel.
    safeSetLS(LS_MIC_BELLS, (state.micBells || []).join(','));

    // Update any visible per-bell Mic buttons without forcing a full rebuild.
    try {
      const btns = document.querySelectorAll('[data-mic-bell]');
      btns.forEach(btn => {
        const bell = parseInt(btn.getAttribute('data-mic-bell') || '', 10);
        const micSelected = Number.isFinite(bell) && (state.micBells || []).includes(bell);
        const micActive = micSelected && !!state.micEnabled && state.mode !== 'demo';
        // v08_p08_defaults_and_ui_fixes: highlight only when mic is truly enabled for this configuration.
        btn.classList.toggle('mic-on', micActive);
        btn.setAttribute('aria-pressed', micSelected ? 'true' : 'false');
        btn.setAttribute('aria-label', micSelected ? `Mic selected for bell ${bellToGlyph(bell)}` : `Mic not selected for bell ${bellToGlyph(bell)}`);
      });
    } catch (_) {}
  }


  function loadMicPrefs() {
    state.micEnabled = safeGetBoolLS(LS_MIC_ENABLED, false);

    // Mic threshold (linear RMS)
    let th = parseFloat(safeGetLS(LS_MIC_THRESHOLD) || '');
    if (!Number.isFinite(th)) {
      // Migrate legacy dB slider value if present.
      const oldDb = parseFloat(safeGetLS(OLD_LS_MIC_THRESHOLD_DB) || '');
      if (Number.isFinite(oldDb)) th = dbToLin(clamp(oldDb, -72, 0));
    }
    if (Number.isFinite(th)) window.micThreshold = clamp(th, 0.01, 0.25);
    else window.micThreshold = DEFAULT_MIC_THRESHOLD;

    // Persist to the new key so it sticks going forward.
    safeSetLS(LS_MIC_THRESHOLD, String(window.micThreshold));

    const cd = parseFloat(safeGetLS(LS_MIC_COOLDOWN_MS) || '');
    if (Number.isFinite(cd)) state.micCooldownMs = clamp(cd, 100, 400);

    const bellsRaw = safeGetLS(LS_MIC_BELLS);
    state.micBells = (bellsRaw == null) ? (state.liveBells || []).slice() : parseBellList(bellsRaw);
    if (bellsRaw == null) safeSetLS(LS_MIC_BELLS, state.micBells.join(','));

    syncMicSlidersUI();
    rebuildMicBellControls();
    syncMicToggleUI();
  }


  function setMicEnabled(on, opts = {}) {
    const next = !!on;
    if (next) state.micError = '';
    state.micEnabled = next;
    safeSetBoolLS(LS_MIC_ENABLED, next);

    if (!next) {
      if (!opts.keepError) state.micError = '';
      stopMicCapture();
    }
    // v08_p08_defaults_and_ui_fixes: keep keybinding Mic button highlights in sync.
    rebuildMicBellControls();
    syncMicToggleUI();
  }

  function stopMicCapture() {
    state.micActive = false;

    try { if (state.micSource) state.micSource.disconnect(); } catch (_) {}
    try { if (state.micAnalyser) state.micAnalyser.disconnect(); } catch (_) {}
    try { if (state.micSink) state.micSink.disconnect(); } catch (_) {}
    state.micSource = null;
    state.micAnalyser = null;
    state.micSink = null;
    state.micBuf = null;

    if (state.micStream) {
      try { state.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    state.micStream = null;

    state.micWasAbove = false;
    if (micMeterFill) micMeterFill.style.width = '0%';
    if (micDbReadout) micDbReadout.textContent = '–∞ dB';

    // If mic was the only reason we kept audio alive while idle, restore old behavior.
    if (state.phase === 'idle') closeAudio();
    markDirty();
    kickLoop();
  }

  function startMicCapture() {
    if (!state.micEnabled || state.micActive) return;
    if (state.mode === 'demo') { setMicUiStatus('Mic disabled in Demo'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.micError = 'Mic unsupported';
      setMicEnabled(false, { keepError: true });
      setMicUiStatus('Mic unsupported', true);
      return;
    }

    ensureAudio();
    setMicUiStatus('Requesting mic…');
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(stream => {
      if (!state.micEnabled) { stream.getTracks().forEach(t => t.stop()); return; }
      state.micStream = stream;
      state.micSource = audioCtx.createMediaStreamSource(stream);

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.2;

      // Keep graph alive without speaker output.
      const sink = audioCtx.createMediaStreamDestination();
      state.micAnalyser = analyser;
      state.micSink = sink;

      state.micSource.connect(analyser);
      analyser.connect(sink);

      state.micBuf = new Float32Array(analyser.fftSize);
      state.micActive = true;
      state.micWasAbove = false;
      state.micLastFireTimeMs = -1e9;

      setMicUiStatus('');
      syncMicToggleUI();
      markDirty();
      kickLoop();
    }).catch(err => {
      const name = err && err.name ? String(err.name) : '';
      state.micError = (name === 'NotAllowedError' || name === 'SecurityError') ? 'Mic blocked' : 'Mic error';
      setMicEnabled(false, { keepError: true });
      setMicUiStatus(state.micError, true);
    });
  }

  function updateMicMeter(rms) {
    const db = linToDb(rms);
    state.micRms = rms;
    state.micDb = db;

    if (micDbReadout) micDbReadout.textContent = Number.isFinite(db) ? `${Math.round(db)} dB` : '–∞ dB';
    if (micMeterFill) {
      const p = Number.isFinite(db) ? clamp((db + 72) / 72, 0, 1) : 0;
      micMeterFill.style.width = `${Math.round(p * 100)}%`;
    }
  }

  function pickMicTargetInWindow(nowMs) {
    if (state.phase !== 'running') return null;
    const bells = getMicControlledBells();
    if (!bells.length) return null;

    const bellSet = new Set(bells);
    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;

    let chosen = null;
    for (const t of state.targets) {
      if (t.judged) continue;
      if (!bellSet.has(t.bell)) continue;

      const ws = t.timeMs - halfBeat;
      const we = t.timeMs + halfBeat;
      if (nowMs >= ws && nowMs < we) {
        if (!chosen || t.timeMs < chosen.timeMs || (t.timeMs === chosen.timeMs && t.bell < chosen.bell)) chosen = t;
      }
    }
    return chosen;
  }


  // v013_p05_any_keybinding_capture_option_a: ANY keybinding capture (Option A).
  function getAnyKeyboundBells() {
    const live = (state.liveBells || []);
    if (!live.length || !state.keyBindings) return [];
    const out = [];
    for (const b of live) {
      if (normalizeBindKey(state.keyBindings[b]) === 'ANY') out.push(b);
    }
    return out;
  }

  function pickAnyTargetInWindow(nowMs) {
    if (state.mode !== 'play') return null;
    // Mirror ringBell scoring eligibility: allow countdown→running boundary.
    if (!(state.phase === 'running' || state.phase === 'countdown')) return null;
    if (!state.targets || !state.targets.length) return null;

    const anyBells = getAnyKeyboundBells();
    if (!anyBells.length) return null;

    const bellSet = new Set(anyBells);
    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;

    let chosen = null;
    for (const t of state.targets) {
      if (t.judged) continue;
      if (!bellSet.has(t.bell)) continue;

      const ws = t.timeMs - halfBeat;
      const we = t.timeMs + halfBeat;
      if (nowMs >= ws && nowMs < we) {
        if (!chosen || t.timeMs < chosen.timeMs || (t.timeMs === chosen.timeMs && t.bell < chosen.bell)) chosen = t;
      }
    }
    return chosen;
  }

  // Returns true if this event was consumed to ring an ANY bell, and should not be routed further.
  function tryCaptureAnyInput(nowMs, src, e, normalizedKey) {
    // Usable input filters (capture only).
    if (src === 'kbd') {
      if (e && e.repeat) return false;
      const k = (normalizedKey != null) ? String(normalizedKey) : normalizeBindKey(e ? e.key : '');
      // Ignore modifier-only keys.
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return false;
    }

    // Mic can satisfy ANY only when mic is actually enabled/active.
    if (src === 'mic') {
      if (!state.micActive) return false;
    }

    const target = pickAnyTargetInWindow(nowMs);
    if (!target) return false;

    if (src === 'mic') {
      markRunInputUsed('mic');
      registerMicHit(target.bell, nowMs);
    } else if (src === 'tap') {
      markRunInputUsed('tap');
      ringBell(target.bell);
    } else {
      markRunInputUsed('keyboard');
      ringBell(target.bell);
    }
    return true;
  }

  function registerMicHit(bell, timeMs) {
    if (state.mode !== 'play') return;
    // v015_p04_stats_export_import_and_compare: input fidelity (mic)
    markRunInputUsed('mic');
    // Mic hits are silent: score + visuals only, no bell audio.
    markRung(bell, timeMs);
    scoreHit(bell, timeMs);
  }

  function updateMicAnalysis(nowMs) {
    if (!state.micActive || !state.micAnalyser || !state.micBuf) return;
    try { state.micAnalyser.getFloatTimeDomainData(state.micBuf); } catch (_) { return; }

    let sum = 0;
    const buf = state.micBuf;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    updateMicMeter(rms);

    const thresholdLin = clamp(Number(window.micThreshold) || DEFAULT_MIC_THRESHOLD, 0.01, 0.25);
    const above = rms >= thresholdLin;
    const rising = above && !state.micWasAbove;

    if (rising) {
      const cdOk = (nowMs - state.micLastFireTimeMs) >= state.micCooldownMs;
      if (cdOk) {
        // v013_p05_any_keybinding_capture_option_a: allow mic hits to satisfy ANY windows (silent) before normal mic routing.
        if (tryCaptureAnyInput(nowMs, 'mic', null, null)) {
          state.micLastFireTimeMs = nowMs;
        } else {
          const target = pickMicTargetInWindow(nowMs);
          if (target) {
            registerMicHit(target.bell, nowMs);
            state.micLastFireTimeMs = nowMs;
          }
        }
      }
    }
    state.micWasAbove = above;
  }

  // === Visual ring flash ===
  function markRung(bell, atMs) { state.lastRingAtMs[bell] = atMs; markDirty(); }

  // === Bell ring action (user) ===
  function ringBell(bell) {
    const now = perfNow();
    syncWakeLockForRun();
    markRung(bell, now);
    playBellAt(bell, now);
    // v09_p09_p01_first_hit_window_fix: during the countdown→running boundary,
    // the first scoring window can begin before state.phase flips to 'running'.
    // Let scoreHit decide eligibility based on the timing reference.
    if (state.mode === 'play' && (state.phase === 'running' || state.phase === 'countdown')) scoreHit(bell, now);
    if (state.phase === 'idle') kickLoop();
  }

  // v08_p06_sound_testpad_tap_to_ring: ring bell for Sound test pad (no scoring, no run state)
  function ringBellTestPad(bell) {
    const b = parseInt(bell, 10) || 0;
    if (b < 1 || b > state.stage) return;
    const now = perfNow();
    // v10_p05_sound_per_bell_hz_slider_preview: stop any ongoing continuous Hz preview before other previews.
    cancelHzSliderPreviewGesture();
    stopHzPreviewTone();
    playBellAt(b, now);
  }

  // === Stats ===
  function resetStats() {
    state.statsByBell = {};
    state.lastJudgeByBell = {};

    // v09_p07c_notation_spotlight_persistent_accuracy: reset per-row accuracy record
    state.accuracyByRow = [];
    state._accuracyScratchByRow = {};
    state._rowJudgedCount = [];

    for (let b = 1; b <= state.stage; b++) {
      state.statsByBell[b] = { bell: b, hits: 0, misses: 0, sumAbsDelta: 0, sumSignedDelta: 0, score: 0, comboCurrent: 0, comboBest: 0 };
      state.lastJudgeByBell[b] = null;
    }
    state.targets.length = 0;
    state.comboCurrentGlobal = 0;
    state.comboBestGlobal = 0;
    markDirty();
  }

  function getBellForStrikeIndex(i) {
    const stage = state.stage;
    const rowIdx = Math.floor(i / stage);
    const pos = i % stage;
    const row = state.rows[rowIdx];
    return row ? row[pos] : 1;
  }

  function recordTarget(bell, timeMs) {
    state.targets.push({ bell, timeMs, judged: false, hit: false });
  }

  function buildAllTargets(beatMs) {
    state.targets.length = 0;
    const stage = state.stage;
    const totalBeats = state.rows.length * stage;
    for (let i = 0; i < totalBeats; i++) {
      const bell = getBellForStrikeIndex(i);
      const tMs = state.methodStartMs + i * beatMs;
      recordTarget(bell, tMs);
    }
  }

  // v09_p07c_notation_spotlight_persistent_accuracy: per-row accuracy recording (committed only when a row is fully judged)
  function getRowPosForTarget(bell, targetTimeMs, beatMs) {
    const stage = state.stage;
    if (!Number.isFinite(targetTimeMs) || !Number.isFinite(beatMs) || beatMs <= 0) return null;
    const i = Math.round((targetTimeMs - state.methodStartMs) / beatMs);
    if (!Number.isFinite(i)) return null;
    const rowIdx = Math.floor(i / stage);
    if (rowIdx < 0 || !state.rows || rowIdx >= state.rows.length) return null;
    const row = state.rows[rowIdx];
    if (!row) return null;
    let posInRow = i % stage;
    if (posInRow < 0) posInRow += stage;
    if (row[posInRow] !== bell) {
      const j = row.indexOf(bell);
      if (j >= 0) posInRow = j;
    }
    return { rowIdx, posInRow };
  }

  function recordAccuracyScratch(rowIdx, posInRow, rec) {
    const stage = state.stage;
    if (rowIdx == null || posInRow == null) return;
    if (rowIdx < 0 || !state.rows || rowIdx >= state.rows.length) return;
    if (posInRow < 0 || posInRow >= stage) return;
    if (!state._accuracyScratchByRow) state._accuracyScratchByRow = {};
    let arr = state._accuracyScratchByRow[rowIdx];
    if (!arr) {
      arr = new Array(stage).fill(null);
      state._accuracyScratchByRow[rowIdx] = arr;
    }
    if (arr[posInRow] != null) return; // do not overwrite
    arr[posInRow] = rec;
  }

  function commitAccuracyRowIfComplete(rowIdx) {
    const stage = state.stage;
    if (rowIdx == null) return;
    if (rowIdx < 0 || !state.rows || rowIdx >= state.rows.length) return;
    if (!state._rowJudgedCount) state._rowJudgedCount = [];
    const next = (state._rowJudgedCount[rowIdx] || 0) + 1;
    state._rowJudgedCount[rowIdx] = next;
    if (next < stage) return;

    if (!state.accuracyByRow) state.accuracyByRow = [];
    if (state.accuracyByRow[rowIdx] != null) return; // already committed

    const rec = new Array(stage).fill(null);
    const scratch = state._accuracyScratchByRow && state._accuracyScratchByRow[rowIdx];
    if (scratch) {
      for (let p = 0; p < stage; p++) {
        if (scratch[p] != null) rec[p] = scratch[p];
      }
      try { delete state._accuracyScratchByRow[rowIdx]; } catch (_) {}
    }
    state.accuracyByRow[rowIdx] = rec;
    markDirty();
  }

  function updateMisses(nowMs) {
    const live = new Set(state.liveBells);
    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;
    let didChange = false;
    for (const t of state.targets) {
      if (t.judged) continue;
      if (nowMs > t.timeMs + halfBeat) {
        t.judged = true;
        const rp = getRowPosForTarget(t.bell, t.timeMs, beatMs);
        if (live.has(t.bell)) {
          const s = state.statsByBell[t.bell];
          s.misses += 1;
          if (state.mode === 'play' && state.lastJudgeByBell) state.lastJudgeByBell[t.bell] = { kind: 'miss', bin: null };
          if (rp) recordAccuracyScratch(rp.rowIdx, rp.posInRow, { kind: 'miss' });
          s.comboCurrent = 0;
          state.comboCurrentGlobal = 0;
          didChange = true;
        }
        if (rp) commitAccuracyRowIfComplete(rp.rowIdx);
      }
    }
    const cutoff = nowMs - 8000;
    while (state.targets.length && state.targets[0].timeMs < cutoff && state.targets[0].judged) state.targets.shift();
    if (didChange) markDirty();
  }

  function finalizePendingAsMisses(nowMs) {
    state.targets = state.targets.filter(t => t.timeMs <= nowMs);
    const live = new Set(state.liveBells);
    const beatMs = 60000 / state.bpm;
    for (const t of state.targets) {
      if (t.judged) continue;
      t.judged = true;
      const rp = getRowPosForTarget(t.bell, t.timeMs, beatMs);
      if (live.has(t.bell)) {
        const s = state.statsByBell[t.bell];
        s.misses += 1;
        if (state.mode === 'play' && state.lastJudgeByBell) state.lastJudgeByBell[t.bell] = { kind: 'miss', bin: null };
        if (rp) recordAccuracyScratch(rp.rowIdx, rp.posInRow, { kind: 'miss' });
        s.comboCurrent = 0;
        state.comboCurrentGlobal = 0;
      }
      if (rp) commitAccuracyRowIfComplete(rp.rowIdx);
    }
  }

  function scoreHit(bell, timeMs) {
    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;

    // v09_p09_p01_first_hit_window_fix:
    // The first scoring window opens at (methodStartMs - halfBeat), but state.phase
    // flips from 'countdown' to 'running' exactly at methodStartMs. If the player
    // strikes during that early half-window (or right at the boundary before the
    // loop advances phase), the hit must be judged like later windows.
    if (state.phase !== 'running') {
      if (state.phase !== 'countdown') return;
      if (timeMs < (state.methodStartMs - halfBeat)) return;
    }
    if (!state.liveBells.includes(bell)) return;

    // Only the first ring for this bell within the current row counts (hit or miss).
    const rel = timeMs - (state.methodStartMs - halfBeat);
    if (rel < 0) return;

    const beatIndex = Math.floor(rel / beatMs);
    if (beatIndex < 0) return;

    const rowIdx = Math.floor(beatIndex / state.stage);
    if (rowIdx < 0 || rowIdx >= state.rows.length) return;

    const row = state.rows[rowIdx];
    if (!row) return;

    const posInRow = row.indexOf(bell);
    if (posInRow < 0) return;

    const targetTimeMs = state.methodStartMs + (rowIdx * state.stage + posInRow) * beatMs;

    let t = null;
    let bestAbs = Infinity;
    for (let i = 0; i < state.targets.length; i++) {
      const cand = state.targets[i];
      if (cand.bell !== bell) continue;
      const abs = Math.abs(cand.timeMs - targetTimeMs);
      if (abs < bestAbs) { bestAbs = abs; t = cand; }
    }
    if (!t) return;
    if (bestAbs > halfBeat) return; // target already expired/trimmed
    if (t.judged) return;

    const windowStart = targetTimeMs - halfBeat;
    const windowEnd = targetTimeMs + halfBeat;

    // Miss if the first ring in the row is outside the bell's own window.
    if (Math.abs(timeMs - targetTimeMs) > halfBeat) {
      t.judged = true;
      t.hit = false;

      const s = state.statsByBell[bell];
      s.misses += 1;
      if (state.mode === 'play' && state.lastJudgeByBell) { state.lastJudgeByBell[bell] = { kind: 'miss', bin: null }; markDirty(); }
      recordAccuracyScratch(rowIdx, posInRow, { kind: 'miss' });
      commitAccuracyRowIfComplete(rowIdx);
      s.comboCurrent = 0;
      state.comboCurrentGlobal = 0;
      return;
    }

    // Hit: tiered score within the bell window (12 bins across [-W, +W]).
    t.judged = true;
    t.hit = true;

    const deltaMs = timeMs - targetTimeMs;
    const absDelta = Math.abs(deltaMs);
    const s = state.statsByBell[bell];

    s.hits += 1;
    s.sumAbsDelta += absDelta;
    s.sumSignedDelta += deltaMs;

    const W = halfBeat;
    let bin = Math.floor(((deltaMs + W) / (2 * W)) * 12);
    bin = clamp(bin, 0, 11);
    const points = TIER12_BY_BIN[bin];

    s.score += points;

    s.comboCurrent += 1;
    if (s.comboCurrent > s.comboBest) s.comboBest = s.comboCurrent;

    state.comboCurrentGlobal += 1;
    if (state.comboCurrentGlobal > state.comboBestGlobal) state.comboBestGlobal = state.comboCurrentGlobal;

    recordAccuracyScratch(rowIdx, posInRow, { kind: 'hit', bin, errMs: deltaMs });
    commitAccuracyRowIfComplete(rowIdx);

    if (state.mode === 'play' && state.lastJudgeByBell) { state.lastJudgeByBell[bell] = { kind: 'hit', bin, errMs: deltaMs }; markDirty(); }
  }

  function getElapsedSeconds(nowMs) {
    if (state.phase === 'running') return (state.elapsedMs + (nowMs - state.runStartPerfMs)) / 1000;
    return state.elapsedMs / 1000;
  }

  function countdownDisplay(nowMs) {
    let tNow = nowMs;
    let phase = state.phase;
    if (phase === 'paused' && state.pausePrevPhase === 'countdown' && state.pauseAtMs) {
      phase = 'countdown';
      tNow = state.pauseAtMs;
    }
    if (phase !== 'countdown') return null;
    const beatMs = 60000 / state.bpm;

    // Before the first count-in beat, show Ready (no sound yet).
    if (tNow < state.countFirstBeatMs) return 'Ready';

    const k = Math.floor((tNow - state.countFirstBeatMs) / beatMs); // 0-based count-in beat
    if (k >= 0 && k < state.stage) return String(k + 1);
    return null;
  }

  const countOverlay = document.getElementById('countOverlay');
  function renderCountdownOverlay(nowMs) {
    if (!countOverlay) return;
    const cd = countdownDisplay(nowMs);
    if (!cd) { countOverlay.style.display = 'none'; countOverlay.innerHTML = ''; return; }

    countOverlay.style.display = 'block';

    if (cd === 'Ready') {
      countOverlay.innerHTML =
        '<div class="bubble"><div class="num ready">Ready</div><div class="lbl">Count in</div></div>';
      return;
    }

    countOverlay.innerHTML =
      '<div class="bubble"><div class="num">' + cd + '</div><div class="lbl">Count in</div></div>';
  }


  // === Spotlight (cue + touch input) ===
    function drawSpotlight(nowMs) {
      const { W, H } = fitCanvas(spotlightCanvas, sctx);
      sctx.clearRect(0, 0, W, H);

      const cd = countdownDisplay(nowMs);
      if (!state.rows.length) return;

      // v06_p17_spotlight_tap_drag_to_ring: expire tap flash without timers.
      if (ui.spotlightTapFlash && nowMs >= ui.spotlightTapFlash.untilMs) ui.spotlightTapFlash = null;
      const tapFlash = ui.spotlightTapFlash;

      // countdown badge intentionally omitted (overlay handles count-in)

      const stage = state.stage;
      const totalBeats = state.rows.length * stage;
      const strikeIdx = clamp(state.execBeatIndex - 1, 0, Math.max(0, totalBeats - 1));
      const rowIdx = Math.floor(strikeIdx / stage);
      const pos = strikeIdx % stage;

      // Default Spotlight (exactly as before)
      if (!state.spotlightSwapsView) {
        const currentRow = state.rows[rowIdx] || state.rows[0];
        const nextRowIdx = Math.min(rowIdx + 1, state.rows.length - 1);
        const nextRow = state.rows[nextRowIdx] || currentRow;

        const padX = 14, padY = 12, gapY = 10;
        const rowBlockH = (H - padY * 2 - gapY) / 2;
        const cellW = (W - padX * 2) / stage;

        function drawRow(row, yTop, highlightPos, faded, rowKind, rowIndex) {
          sctx.save();
          sctx.translate(padX, yTop);
          sctx.fillStyle = faded ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)';
          sctx.strokeStyle = 'rgba(255,255,255,0.08)';
          roundRect(sctx, 0, 0, W - padX * 2, rowBlockH, 12);
          sctx.fill(); sctx.stroke();

          const fontSize = Math.max(20, Math.min(34, Math.floor(rowBlockH * 0.58)));
          sctx.font = fontSize + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
          sctx.textAlign = 'center';
          sctx.textBaseline = 'middle';

          for (let i = 0; i < stage; i++) {
            const x = i * cellW + cellW / 2;
            const y = rowBlockH / 2;
            const bell = row[i];
            const isLive = state.liveBells.includes(bell);
            const flashOn = !!(tapFlash && tapFlash.rowKind === rowKind && tapFlash.bell === bell);

            if (!faded && i === highlightPos) {
              sctx.fillStyle = (cd === 'Ready') ? 'rgba(232,238,255,0.86)' : '#f9c74f';
              roundRect(sctx, i * cellW + 4, 6, cellW - 8, rowBlockH - 12, 10);
              sctx.fill();
              sctx.fillStyle = '#10162c';
            } else if (flashOn) {
              sctx.fillStyle = faded ? 'rgba(249,199,79,0.22)' : 'rgba(249,199,79,0.34)';
              roundRect(sctx, i * cellW + 4, 6, cellW - 8, rowBlockH - 12, 10);
              sctx.fill();
              sctx.fillStyle = '#10162c';
            } else sctx.fillStyle = isLive ? '#e8eeff' : '#9aa2bb';

            const bgHex = getBellGlyphColor(bell);
            const colorOnly = isBellColorOnly(bell);
            if (bgHex) {
              const a = ((!faded && i === highlightPos) || flashOn) ? 0.16 : (faded ? 0.14 : 0.22);
              const mw = Math.max(12, Math.min(cellW - 10, cellW * 0.74));
              const mh = Math.max(12, Math.min(rowBlockH - 14, rowBlockH * 0.56));
              const mx = i * cellW + (cellW - mw) / 2;
              const my = (rowBlockH - mh) / 2;
              drawGlyphBgRoundRect(sctx, mx, my, mw, mh, Math.min(10, mh / 2), bgHex, a);
            }
            if (!colorOnly) sctx.fillText(getBellGlyphChar(bell), x, y);
            if (accuracyDotsEnabledForPane('spotlight')) {
              const darkOnLight = ((!faded && i === highlightPos) || flashOn);
              drawRowAccuracyOverlayUnderGlyph(sctx, x, y, cellW, rowBlockH, fontSize, rowIndex, i, darkOnLight);
            }
          }
          sctx.restore();
        }

        drawRow(currentRow, padY, pos, false, 'N', rowIdx);
        drawRow(nextRow, padY + rowBlockH + gapY, -1, true, 'N1', nextRowIdx);
        return;
      }

      // === Swaps View ===
      const rows = state.rows;
      const padX = 14, padY = 12;
      const gapY = 8;
      const diagramH = 18;

      const show0 = !!state.spotlightShowN;
      const show1 = !!state.spotlightShowN1 && (rowIdx + 1 < rows.length);
      const show2 = !!state.spotlightShowN2 && (rowIdx + 2 < rows.length);

      const row0 = rows[rowIdx] || rows[0];
      const row1 = show1 ? rows[rowIdx + 1] : null;
      const row2 = show2 ? rows[rowIdx + 2] : null;

      const items = [];
      if (show0) items.push({ type: 'row', row: row0, highlightPos: pos, faded: false, offset: 0 });
      if (show0 && show1) items.push({ type: 'diagram', before: row0, after: row1 });
      if (show1) items.push({ type: 'row', row: row1, highlightPos: -1, faded: true, offset: 1 });
      if (show1 && show2) items.push({ type: 'diagram', before: row1, after: row2 });
      if (show2) items.push({ type: 'row', row: row2, highlightPos: -1, faded: true, offset: 2 });

      const rowCount = items.reduce((n, it) => n + (it.type === 'row' ? 1 : 0), 0);
      if (!rowCount) return;

      // If row N is hidden, avoid a permanently "faded" first row.
      if (!show0) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === 'row') { items[i].faded = false; break; }
        }
      }

      const diagramCount = items.length - rowCount;
      const availH = H - padY * 2;
      const gapsH = Math.max(0, (items.length - 1) * gapY);
      let rowBlockH = (availH - diagramCount * diagramH - gapsH) / rowCount;
      if (!isFinite(rowBlockH) || rowBlockH <= 0) rowBlockH = Math.max(34, (availH - diagramCount * diagramH) / rowCount);

      const cellW = (W - padX * 2) / stage;
      const liveSet = new Set(state.liveBells);

      function drawRowBlock(row, yTop, highlightPos, faded, offset) {
        sctx.save();
        sctx.translate(padX, yTop);

        const absRowIdx = rowIdx + (Number(offset) || 0);

        const rowKind = (offset === 0) ? 'N' : ((offset === 1) ? 'N1' : 'N2');
        sctx.fillStyle = faded ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)';
        sctx.strokeStyle = 'rgba(255,255,255,0.08)';
        roundRect(sctx, 0, 0, W - padX * 2, rowBlockH, 12);
        sctx.fill(); sctx.stroke();

        let fontSize = Math.max(16, Math.min(34, Math.floor(rowBlockH * 0.58)));
        if (stage >= 10) {
          fontSize = Math.min(fontSize, Math.max(12, Math.floor(cellW * 0.82)));
        }
        sctx.font = fontSize + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';

        for (let i = 0; i < stage; i++) {
          const x = i * cellW + cellW / 2;
          const y = rowBlockH / 2;
          const bell = row[i];
          const isLive = liveSet.has(bell);
          const flashOn = !!(tapFlash && tapFlash.rowKind === rowKind && tapFlash.bell === bell);

          if (!faded && i === highlightPos) {
            sctx.fillStyle = (cd === 'Ready') ? 'rgba(232,238,255,0.86)' : '#f9c74f';
            roundRect(sctx, i * cellW + 4, 6, cellW - 8, rowBlockH - 12, 10);
            sctx.fill();
            sctx.fillStyle = '#10162c';
          } else if (flashOn) {
            sctx.fillStyle = faded ? 'rgba(249,199,79,0.22)' : 'rgba(249,199,79,0.34)';
            roundRect(sctx, i * cellW + 4, 6, cellW - 8, rowBlockH - 12, 10);
            sctx.fill();
            sctx.fillStyle = '#10162c';
          } else sctx.fillStyle = isLive ? '#e8eeff' : '#9aa2bb';

          const bgHex = getBellGlyphColor(bell);
          const colorOnly = isBellColorOnly(bell);
          if (bgHex) {
            const a = ((!faded && i === highlightPos) || flashOn) ? 0.16 : (faded ? 0.14 : 0.22);
            const mw = Math.max(12, Math.min(cellW - 10, cellW * 0.74));
            const mh = Math.max(12, Math.min(rowBlockH - 14, rowBlockH * 0.56));
            const mx = i * cellW + (cellW - mw) / 2;
            const my = (rowBlockH - mh) / 2;
            drawGlyphBgRoundRect(sctx, mx, my, mw, mh, Math.min(10, mh / 2), bgHex, a);
          }
          if (!colorOnly) sctx.fillText(getBellGlyphChar(bell), x, y);
          if (accuracyDotsEnabledForPane('spotlight')) {
            const darkOnLight = ((!faded && i === highlightPos) || flashOn);
            drawRowAccuracyOverlayUnderGlyph(sctx, x, y, cellW, rowBlockH, fontSize, absRowIdx, i, darkOnLight);
          }
        }

        sctx.restore();
      }

      function drawSwapDiagram(before, after, yTop) {
        if (!before || !after) return;
        sctx.save();
        sctx.translate(padX, yTop);

        const y1 = 2;
        const y2 = diagramH - 2;

        for (let i = 0; i < stage; i++) {
          const bell = before[i];
          const j = after.indexOf(bell);
          if (j < 0) continue;

          const x1 = i * cellW + cellW / 2;
          const x2 = j * cellW + cellW / 2;
          const isLive = liveSet.has(bell);

          sctx.strokeStyle = isLive ? 'rgba(232,238,255,0.60)' : 'rgba(154,162,187,0.20)';
          sctx.lineWidth = isLive ? 1.5 : 1;
          sctx.beginPath();
          sctx.moveTo(x1, y1);
          sctx.lineTo(x2, y2);
          sctx.stroke();
        }
        sctx.restore();
      }

      let y = padY;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it.type === 'row') {
          drawRowBlock(it.row, y, it.highlightPos, it.faded, it.offset);
          y += rowBlockH;
        } else {
          drawSwapDiagram(it.before, it.after, y);
          y += diagramH;
        }
        if (k < items.length - 1) y += gapY;
      }
    }

  // === Display (polygon; primary touch control) ===
  function computeDisplayPoints(W, H) {
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) * 0.34;
    const pts = [];
    for (let b = 1; b <= state.stage; b++) {
      const ang = -Math.PI / 2 + (b - 1) * (2 * Math.PI / state.stage);
      pts.push({ bell: b, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
    }
    return { cx, cy, r, pts };
  }


  function getSortedLiveBells() {
    return state.liveBells.slice().filter(b => b >= 1 && b <= state.stage).sort((a,b)=>a-b);
  }

  function computeDisplayLiveOnlyLayout(W, H, bellsSorted) {
    const padX = 14;
    const padY = 12;
    const x0 = padX, y0 = padY;
    const w0 = W - padX * 2;
    const h0 = H - padY * 2;

    const n = bellsSorted.length;

    let rows = 1, cols = Math.max(1, n);
    if (n <= 3) { rows = 1; cols = Math.max(1, n); }
    else if (n === 4) { rows = 2; cols = 2; }
    else if (n <= 6) { rows = 2; cols = 3; }
    else if (n <= 8) { rows = 2; cols = 4; }
    else {
      cols = Math.ceil(Math.sqrt(n));
      rows = Math.ceil(n / cols);
    }

    const cellW = w0 / cols;
    const cellH = h0 / rows;

    return { x0, y0, w0, h0, rows, cols, cellW, cellH, bells: bellsSorted };
  }

  // v09_p07b_notation_spotlight_accuracy_dots: shared judge overlay helpers
  function accuracyDotsEnabledForPane(paneKey) {
    if (!state.accuracyDotsEnabled) return false;
    if (paneKey === 'display') return !!state.accuracyDotsDisplay;
    if (paneKey === 'notation') return !!state.accuracyDotsNotation;
    if (paneKey === 'spotlight') return !!state.accuracyDotsSpotlight;
    return false;
  }

  function judgeRenderBinFromLastJudge(lj) {
    if (!lj || lj.kind !== 'hit' || lj.bin == null) return null;
    let dispBin = lj.bin;
    const errMs = lj.errMs;
    // Special render rule: exactly on-beat hits render in the "late" center bin (choose the later center)
    if (errMs != null && Math.abs(errMs) < 0.0001) dispBin = Math.floor(12 / 2); // 6
    return clamp(dispBin, 0, 11);
  }

  function judgeStrengthFromBin(bin) {
    const pts = TIER12_BY_BIN[bin == null ? 0 : bin] || 5;
    return clamp((pts - 5) / 5, 0, 1);
  }

  function drawJudgeOverlayUnderGlyph(ctx, cx, cy, cellW, cellH, fontSize, bell, darkOnLight) {
    if (state.mode !== 'play') return;
    const map = state.lastJudgeByBell;
    if (!map) return;
    const lj = map[bell];
    if (!lj) return;

    if (lj.kind === 'miss') {
      const r = Math.max(7, Math.min(Math.min(cellW, cellH) * 0.42, fontSize * 0.72));
      const lw = Math.max(1.15, Math.min(2.4, fontSize * 0.10));
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 90, 90, 0.82)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const bin = judgeRenderBinFromLastJudge(lj);
    if (bin == null) return;
    const strength = judgeStrengthFromBin(bin);

    let slotW = fontSize * 2.4;
    slotW = Math.max(18, Math.min(slotW, cellW * 0.80));
    const x0 = cx - slotW / 2;
    const x = x0 + (bin / 11) * slotW;

    const alpha = 0.20 + strength * 0.65;
    const baseR = Math.max(1.6, Math.min(5.0, fontSize * 0.12));
    const r = baseR * (0.75 + strength * 0.55);

    const yOff = Math.min(fontSize * 0.75, cellH * 0.42);
    let y = cy + yOff;
    const yMax = (cy + cellH / 2) - (r + 1.0);
    if (y > yMax) y = yMax;

    const rgb = darkOnLight ? '16,22,44' : '249,199,79';
    ctx.save();
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // v09_p07c_notation_spotlight_persistent_accuracy: per-row accuracy overlay (Notation + Spotlight)
  function judgeRenderBinFromAccuracyEntry(e) {
    if (!e || e.kind !== 'hit' || e.bin == null) return null;
    let dispBin = e.bin;
    const errMs = e.errMs;
    // Match display rule: exactly on-beat hits render in the "late" center bin.
    if (errMs != null && Math.abs(errMs) < 0.0001) dispBin = Math.floor(12 / 2); // 6
    return clamp(dispBin, 0, 11);
  }

  function drawRowAccuracyOverlayUnderGlyph(ctx, cx, cy, cellW, cellH, fontSize, rowIdx, posInRow, darkOnLight) {
    if (state.mode !== 'play') return;
    const byRow = state.accuracyByRow;
    if (!byRow) return;
    const rowRec = byRow[rowIdx];
    if (!rowRec) return;
    const e = rowRec[posInRow];
    if (!e) return;

    if (e.kind === 'miss') {
      const r = Math.max(7, Math.min(Math.min(cellW, cellH) * 0.42, fontSize * 0.72));
      const lw = Math.max(1.15, Math.min(2.4, fontSize * 0.10));
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 90, 90, 0.82)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const bin = judgeRenderBinFromAccuracyEntry(e);
    if (bin == null) return;
    const strength = judgeStrengthFromBin(bin);

    let slotW = fontSize * 2.4;
    slotW = Math.max(18, Math.min(slotW, cellW * 0.80));
    const x0 = cx - slotW / 2;
    const x = x0 + (bin / 11) * slotW;

    const alpha = 0.20 + strength * 0.65;
    const baseR = Math.max(1.6, Math.min(5.0, fontSize * 0.12));
    const r = baseR * (0.75 + strength * 0.55);

    const yOff = Math.min(fontSize * 0.75, cellH * 0.42);
    let y = cy + yOff;
    const yMax = (cy + cellH / 2) - (r + 1.0);
    if (y > yMax) y = yMax;

    const rgb = darkOnLight ? '16,22,44' : '249,199,79';
    ctx.save();
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // v09_p07_stats_overlay_hit_12slot_shape: per-bell last-judged overlay (12-slot timing dot + miss ring)
  function drawDisplayJudgeOverlay(ctx, cx, cy, ringRadius, fontSize, bell) {
    if (state.mode !== 'play') return;
    const map = state.lastJudgeByBell;
    if (!map) return;
    const lj = map[bell];
    if (!lj) return;

    if (lj.kind === 'miss') {
      const rNum = Math.min(ringRadius - 4, Math.max(10, fontSize * 0.65));
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 90, 90, 0.85)';
      ctx.lineWidth = Math.max(1.2, Math.min(3.0, ringRadius * 0.08));
      ctx.beginPath();
      ctx.arc(cx, cy, rNum, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (lj.kind !== 'hit' || lj.bin == null) return;

    // Dot slot corresponds to scoring bin 0..11 (left=early/ahead, right=late/behind)
    let dispBin = lj.bin;
    const errMs = lj.errMs;
    // Special render rule: exactly on-beat hits render in the "late" center bin (if you're not early, you're late)
    if (errMs != null && Math.abs(errMs) < 0.0001) dispBin = Math.floor(12 / 2); // 6 (late-center)
    dispBin = clamp(dispBin, 0, 11);

    // Dot strength follows 5|6|7|8|9|10|10|9|8|7|6|5 (visual only)
    const pts = TIER12_BY_BIN[dispBin] || 5;
    const strength = clamp((pts - 5) / 5, 0, 1);

    const slotW = Math.max(28, Math.min(56, ringRadius * 1.55));
    const x0 = cx - slotW / 2;
    const x = x0 + (dispBin / 11) * slotW;
    let y = cy + Math.min(ringRadius * 0.62, fontSize * 0.75);
    y = Math.min(y, cy + ringRadius - 6);

    const alpha = 0.28 + strength * 0.62;
    const baseR = Math.max(1.8, Math.min(5.0, ringRadius * 0.12));
    const r = baseR * (0.75 + strength * 0.55);

    ctx.save();
    ctx.fillStyle = `rgba(249,199,79,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawDisplayLiveOnly(nowMs, W, H, bellsSorted) {
    const layout = computeDisplayLiveOnlyLayout(W, H, bellsSorted);
    const n = bellsSorted.length;
    const totalCells = layout.rows * layout.cols;

    let inset = Math.floor(Math.min(layout.cellW, layout.cellH) * 0.08);
    inset = Math.max(6, Math.min(14, inset));
    inset = Math.max(4, Math.min(inset, Math.floor(layout.cellW / 2 - 10), Math.floor(layout.cellH / 2 - 10)));

    for (let idx = 0; idx < totalCells; idx++) {
      const row = Math.floor(idx / layout.cols);
      const col = idx % layout.cols;
      const x = layout.x0 + col * layout.cellW;
      const y = layout.y0 + row * layout.cellH;

      const tx = x + inset;
      const ty = y + inset;
      const tw = layout.cellW - inset * 2;
      const th = layout.cellH - inset * 2;
      if (tw <= 0 || th <= 0) continue;

      const rr = Math.min(16, tw / 2, th / 2);

      dctx.save();
      dctx.fillStyle = 'rgba(255,255,255,0.04)';
      dctx.strokeStyle = 'rgba(255,255,255,0.08)';
      roundRect(dctx, tx, ty, tw, th, rr);
      dctx.fill(); dctx.stroke();
      dctx.restore();

      if (idx >= n) continue;

      const bell = bellsSorted[idx];
      const cx = x + layout.cellW / 2;
      const cy = y + layout.cellH / 2;

      const t = state.lastRingAtMs[bell] || -1e9;
      const age = nowMs - t;

      let glow = 0;
      if (age >= 0 && age <= 260) glow = 1 - (age / 260);
      if (age < 0 && age >= -60) glow = 0.25;

      const minDim = Math.max(10, Math.min(tw, th));
      let ringRadius = minDim * (n === 1 ? 0.42 : 0.36);
      ringRadius = Math.max(18, Math.min(ringRadius, minDim / 2 - 10));
      const fontSize = Math.max(16, Math.min(96, Math.floor(ringRadius * 0.9)));
      const lineW = Math.max(2, Math.min(6, ringRadius * 0.06));
      const glowExtra = Math.max(6, Math.min(18, ringRadius * 0.18));

      dctx.save();
      dctx.fillStyle = 'rgba(255,255,255,0.05)';
      dctx.strokeStyle = 'rgba(249,199,79,0.50)';
      dctx.lineWidth = lineW;
      dctx.beginPath();
      dctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      dctx.fill();
      dctx.stroke();

      if (glow > 0) {
        dctx.fillStyle = `rgba(249,199,79,${0.18 + glow * 0.30})`;
        dctx.beginPath();
        dctx.arc(cx, cy, ringRadius + glowExtra, 0, Math.PI * 2);
        dctx.fill();
      }

      dctx.font = fontSize + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      dctx.textAlign = 'center';
      dctx.textBaseline = 'middle';
      dctx.fillStyle = glow > 0.2 ? '#10162c' : '#e8eeff';
      const bgHex = getBellGlyphColor(bell);
      const colorOnly = isBellColorOnly(bell);
      if (bgHex) {
        const a = (glow > 0.2) ? 0.18 : 0.22;
        const mr = Math.max(10, ringRadius * 0.62);
        drawGlyphBgCircle(dctx, cx, cy, mr, bgHex, a);
      }
      if (!colorOnly) dctx.fillText(getBellGlyphChar(bell), cx, cy);
      if (accuracyDotsEnabledForPane('display')) drawDisplayJudgeOverlay(dctx, cx, cy, ringRadius, fontSize, bell);
      dctx.restore();
    }
  }


  function drawDisplay(nowMs) {
    const { W, H } = fitCanvas(displayCanvas, dctx);
    dctx.clearRect(0, 0, W, H);

    dctx.save();
    dctx.fillStyle = 'rgba(255,255,255,0.03)';
    dctx.strokeStyle = 'rgba(255,255,255,0.08)';
    roundRect(dctx, 14, 12, W - 28, H - 24, 16);
    dctx.fill(); dctx.stroke();
    dctx.restore();

    if (state.displayLiveBellsOnly) {
      const liveSorted = getSortedLiveBells();
      if (liveSorted.length) {
        drawDisplayLiveOnly(nowMs, W, H, liveSorted);
        return;
      }
    }

    const geom = computeDisplayPoints(W, H);

    const ringRadius = Math.max(18, Math.min(34, Math.floor(Math.min(W, H) * 0.06)));
    let fontSize = Math.max(16, Math.min(26, Math.floor(ringRadius * 0.9)));
    if (state.stage >= 10) fontSize = Math.max(14, Math.floor(fontSize * 0.85));

    dctx.save();
    dctx.strokeStyle = 'rgba(255,255,255,0.06)';
    dctx.setLineDash([4, 6]);
    dctx.beginPath();
    geom.pts.forEach((p, i) => { if (i === 0) dctx.moveTo(p.x, p.y); else dctx.lineTo(p.x, p.y); });
    dctx.closePath();
    dctx.stroke();
    dctx.setLineDash([]);
    dctx.restore();

    for (const p of geom.pts) {
      const bell = p.bell;
      const isLive = state.liveBells.includes(bell);
      const t = state.lastRingAtMs[bell] || -1e9;
      const age = nowMs - t;

      let glow = 0;
      if (age >= 0 && age <= 260) glow = 1 - (age / 260);
      if (age < 0 && age >= -60) glow = 0.25;

      dctx.save();
      dctx.fillStyle = 'rgba(255,255,255,0.05)';
      dctx.strokeStyle = isLive ? 'rgba(249,199,79,0.50)' : 'rgba(255,255,255,0.12)';
      dctx.lineWidth = 2;
      dctx.beginPath();
      dctx.arc(p.x, p.y, ringRadius, 0, Math.PI * 2);
      dctx.fill();
      dctx.stroke();

      if (glow > 0) {
        dctx.fillStyle = `rgba(249,199,79,${0.18 + glow * 0.30})`;
        dctx.beginPath();
        dctx.arc(p.x, p.y, ringRadius + 6, 0, Math.PI * 2);
        dctx.fill();
      }

      dctx.font = fontSize + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      dctx.textAlign = 'center';
      dctx.textBaseline = 'middle';
      dctx.fillStyle = glow > 0.2 ? '#10162c' : (isLive ? '#e8eeff' : '#9aa2bb');
      const bgHex = getBellGlyphColor(bell);
      const colorOnly = isBellColorOnly(bell);
      if (bgHex) {
        const a = (glow > 0.2) ? 0.18 : 0.22;
        const mr = Math.max(10, ringRadius * 0.62);
        drawGlyphBgCircle(dctx, p.x, p.y, mr, bgHex, a);
      }
      if (!colorOnly) dctx.fillText(getBellGlyphChar(bell), p.x, p.y);
      if (accuracyDotsEnabledForPane('display')) drawDisplayJudgeOverlay(dctx, p.x, p.y, ringRadius, fontSize, bell);
      dctx.restore();
    }
  }

  function displayHitTest(clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const liveSorted = getSortedLiveBells();
    if (state.displayLiveBellsOnly && liveSorted.length) {
      const layout = computeDisplayLiveOnlyLayout(rect.width, rect.height, liveSorted);
      if (x < layout.x0 || y < layout.y0 || x > layout.x0 + layout.w0 || y > layout.y0 + layout.h0) return null;

      const col = Math.floor((x - layout.x0) / layout.cellW);
      const row = Math.floor((y - layout.y0) / layout.cellH);
      if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return null;

      const idx = row * layout.cols + col;
      return (idx >= 0 && idx < liveSorted.length) ? liveSorted[idx] : null;
    }

    const geom = computeDisplayPoints(rect.width, rect.height);
    const ringRadius = Math.max(18, Math.min(34, Math.floor(Math.min(rect.width, rect.height) * 0.06)));

    let best = null;
    let bestD2 = Infinity;
    for (const p of geom.pts) {
      const dx = x - p.x;
      const dy = y - p.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = p.bell; }
    }
    if (best == null) return null;
    return bestD2 <= (ringRadius + 10) * (ringRadius + 10) ? best : null;
  }

  // === Notation ===
  const PATH_STYLES = [[ ], [8,4], [2,6], [10,4,2,4], [4,4], [1,3], [12,5,3,5]];

  function getNotationPagingMeta() {
    const pageSize = Math.max(1, Number(state.notationPageSize) || 1);
    const rowsLen = (state.rows && state.rows.length) ? state.rows.length : 0;
    const totalPages = Math.ceil(rowsLen / pageSize);
    // v08_p03_two_page_present_peek: in two-page mode, ui.notationPage is the PRESENT (left) page.
    // The right page is always the immediate next page (peek), so the present page can advance by 1.
    const lastLeft = Math.max(0, totalPages - 1);
    const lastPage = Math.max(0, totalPages - 1);
    return { pageSize, totalPages, lastLeft, lastPage };
  }

  function syncNotationPagingUI() {
    if (!notationPrevBtn || !notationNextBtn) return;

    const { totalPages, lastLeft, lastPage } = getNotationPagingMeta();
    const onePage = (ui.notationLayout === 'one_page');
    let changed = false;

    const prevPage = ui.notationPage;
    let p = Number(ui.notationPage) || 0;
    if (onePage) {
      if (p < 0) p = 0;
      if (p > lastPage) p = lastPage;
    } else {
      // v08_p03_two_page_present_peek: no even-page alignment; present page is always the left page.
      if (p < 0) p = 0;
      if (p > lastLeft) p = lastLeft;
    }
    if (p !== prevPage) { ui.notationPage = p; changed = true; }

    const canPrev = p > 0;
    const canNext = onePage ? (p < lastPage) : (p < lastLeft);
    const showButtons = totalPages > 1;

    const prevHidden = notationPrevBtn.classList.contains('hidden');
    const nextHidden = notationNextBtn.classList.contains('hidden');

    if (showButtons) {
      if (prevHidden || nextHidden) changed = true;
      notationPrevBtn.classList.remove('hidden');
      notationNextBtn.classList.remove('hidden');
      notationPrevBtn.disabled = !canPrev;
      notationNextBtn.disabled = !canNext;
    } else {
      if (!prevHidden || !nextHidden) changed = true;
      notationPrevBtn.classList.add('hidden');
      notationNextBtn.classList.add('hidden');
      notationPrevBtn.disabled = true;
      notationNextBtn.disabled = true;
    }

    if (changed) {
      markDirty();
      if (!inLoopTick && (loopTimer != null || loopRAF != null)) kickLoop();
    }
  }

  function notationPrevPressed() {
    ui.notationFollow = false;
    const prevPage = Number(ui.notationPage) || 0;
    // v08_p03_two_page_present_peek: in two-page mode, arrows turn the PRESENT page by one page.
    const delta = 1;
    ui.notationPage = (Number(ui.notationPage) || 0) - delta;
    if (ui.notationPage < 0) ui.notationPage = 0;
    syncNotationPagingUI();

    // v09_p02_notation_arrow_redraw_fix: ensure arrow paging redraws immediately.
    if ((Number(ui.notationPage) || 0) !== prevPage) {
      markDirty();
      if (!inLoopTick && (loopTimer != null || loopRAF != null)) kickLoop();
    }
  }

  function notationNextPressed() {
    ui.notationFollow = false;
    const prevPage = Number(ui.notationPage) || 0;
    const { lastLeft, lastPage } = getNotationPagingMeta();
    const onePage = (ui.notationLayout === 'one_page');
    // v08_p03_two_page_present_peek: in two-page mode, arrows turn the PRESENT page by one page.
    const delta = 1;
    const maxP = onePage ? lastPage : lastLeft;
    ui.notationPage = (Number(ui.notationPage) || 0) + delta;
    if (ui.notationPage > maxP) ui.notationPage = maxP;
    syncNotationPagingUI();

    // v09_p02_notation_arrow_redraw_fix: ensure arrow paging redraws immediately.
    if ((Number(ui.notationPage) || 0) !== prevPage) {
      markDirty();
      if (!inLoopTick && (loopTimer != null || loopRAF != null)) kickLoop();
    }
  }

  function drawNotation() {
    const nowMs = perfNow();
    const { W, H } = fitCanvas(notationCanvas, nctx);
    nctx.clearRect(0, 0, W, H);
    if (!state.rows.length) return;

    if (ui.notationTapFlash && nowMs >= ui.notationTapFlash.untilMs) ui.notationTapFlash = null;
    const tapFlash = ui.notationTapFlash;

    const stage = state.stage;
    const rows = state.rows;
    const totalBeats = rows.length * stage;
    const strikeIdx = clamp(state.execBeatIndex - 1, 0, Math.max(0, totalBeats - 1));
    const activeRowIdx = Math.floor(strikeIdx / stage);

    const onePage = (ui.notationLayout === 'one_page');
    const pad = 14;
    const gap = onePage ? 0 : 14;
    const pageW = onePage ? (W - pad * 2) : ((W - pad * 2 - gap) / 2);
    const pageH = H - pad * 2;
    const titleH = 18;

    const lineH = 24;
    const fontSize = 20;

    // Page size is computed from available height, but stored so the paging UI can reason about total pages.
    // Single-page mode reserves space for a 2-row peek strip.
    let computedPageSize = 10;
    if (onePage) {
      const peekRows = 2;
      const peekTopPad = 6;
      const peekLabelH = 14;
      const peekLabelPad = 8;
      const peekBottomPad = 12;
      const peekAreaH = peekRows * lineH + peekTopPad + peekLabelH + peekLabelPad + peekBottomPad;
      const contentTop = pad + 12;
      const dividerY = pad + pageH - peekAreaH;
      const contentBottom = dividerY - 8;
      const usableMain = contentBottom - contentTop;
      computedPageSize = clamp(Math.floor(usableMain / lineH), 8, 24);
    } else {
      const usable = pageH - titleH - 18;
      computedPageSize = clamp(Math.floor(usable / lineH), 10, 24);
    }
    if (state.notationPageSize !== computedPageSize) {
      state.notationPageSize = computedPageSize;
      syncNotationPagingUI();
    }
    const pageSize = state.notationPageSize;

    // Auto-follow (default): keep the active row visible within the current layout.
    if (ui.notationFollow && (state.phase === 'running' || state.phase === 'countdown')) {
      const activePage = Math.floor(activeRowIdx / pageSize);

      // v08_p03_two_page_present_peek: in two-page layout, the left page is always the PRESENT page
      // (it contains the current cursor), and the right page is a PEEK of the following page.
      const desired = activePage;
      if (ui.notationPage !== desired) {
        ui.notationPage = desired;
        syncNotationPagingUI();
      }
    }

    const pageAStart = (Number(ui.notationPage) || 0) * pageSize;
    const pageBStart = ((Number(ui.notationPage) || 0) + 1) * pageSize;

    // v08_p03_two_page_present_peek: in two-page layout, keep the highlight/cursor on the PRESENT (left) page only.
    // v09_p07d_notation_cursor_wrap_fix: in single-page mode, keep the cursor confined to the active rows
    // (exclude the peek strip) by wrapping within the visible main rows when follow-mode is off.
    const highlightRowIdx = (() => {
      if (!onePage) return (ui.notationFollow ? activeRowIdx : pageAStart);
      if (ui.notationFollow) return activeRowIdx;
      const maxRows = Math.max(1, Math.min(pageSize, rows.length - pageAStart));
      let d = activeRowIdx - pageAStart;
      if (!isFinite(d)) d = 0;
      d = ((d % maxRows) + maxRows) % maxRows;
      return pageAStart + d;
    })();

    const bellsForPath = state.pathBells.slice().sort((a,b)=>a-b);
    const liveSet = new Set(state.liveBells);

    function drawPage(pageStartRow, x0, y0, label, isCurrent) {
      const w0 = pageW, h0 = pageH;
      nctx.save();
      nctx.fillStyle = 'rgba(255,255,255,0.03)';
      nctx.strokeStyle = 'rgba(255,255,255,0.08)';
      roundRect(nctx, x0, y0, w0, h0, 16);
      nctx.fill(); nctx.stroke();

      if (label) {
        nctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        nctx.fillStyle = isCurrent ? 'rgba(249,199,79,0.92)' : 'rgba(200,210,235,0.75)';
        nctx.textAlign = 'left';
        nctx.textBaseline = 'top';
        nctx.fillText(label, x0 + 10, y0 + 8);
      }

      // v06_p13_notation_touch_polish: labels removed, so don't reserve header height.
      const labelH = label ? titleH : 0;
      const contentTop = y0 + labelH + 12;
      const contentBottom = y0 + h0 - 12;
      const contentH = contentBottom - contentTop;

      const maxColW = 60;
      const baseColW = w0 / stage;
      const colW = Math.min(baseColW, maxColW);
      const gridW = colW * stage;
      const left = x0 + (w0 - gridW) / 2;
      const rowsToShow = pageSize;

      nctx.strokeStyle = 'rgba(255,255,255,0.06)';
      nctx.setLineDash([4,5]);
      for (let j = 0; j <= stage; j++) {
        const x = left + j * colW;
        nctx.beginPath(); nctx.moveTo(x, contentTop); nctx.lineTo(x, contentBottom); nctx.stroke();
      }
      nctx.setLineDash([]);

      // clip
      nctx.save();
      nctx.beginPath();
      nctx.rect(x0 + 2, contentTop, w0 - 4, contentH);
      nctx.clip();


      // swaps overlay (optional)
      if (state.notationSwapsOverlay) {
        nctx.save();

        // non-live swaps (very light)
        nctx.lineWidth = 1;
        nctx.strokeStyle = 'rgba(255,255,255,0.06)';
        nctx.beginPath();
        for (let i = 0; i < rowsToShow - 1; i++) {
          const beforeIdx = pageStartRow + i;
          const afterIdx = beforeIdx + 1;
          if (afterIdx >= rows.length) break;
          const before = rows[beforeIdx];
          const after = rows[afterIdx];
          const y1 = contentTop + i * lineH + lineH / 2;
          const y2 = contentTop + (i + 1) * lineH + lineH / 2;

          for (let p = 0; p < stage; p++) {
            const bell = before[p];
            if (liveSet.has(bell)) continue;
            const j = after.indexOf(bell);
            if (j < 0) continue;
            const x1 = left + p * colW + colW / 2;
            const x2 = left + j * colW + colW / 2;
            nctx.moveTo(x1, y1);
            nctx.lineTo(x2, y2);
          }
        }
        nctx.stroke();

        // live swaps (slightly stronger tint)
        nctx.lineWidth = 1.25;
        nctx.strokeStyle = 'rgba(249,199,79,0.16)';
        nctx.beginPath();
        for (let i = 0; i < rowsToShow - 1; i++) {
          const beforeIdx = pageStartRow + i;
          const afterIdx = beforeIdx + 1;
          if (afterIdx >= rows.length) break;
          const before = rows[beforeIdx];
          const after = rows[afterIdx];
          const y1 = contentTop + i * lineH + lineH / 2;
          const y2 = contentTop + (i + 1) * lineH + lineH / 2;

          for (let p = 0; p < stage; p++) {
            const bell = before[p];
            if (!liveSet.has(bell)) continue;
            const j = after.indexOf(bell);
            if (j < 0) continue;
            const x1 = left + p * colW + colW / 2;
            const x2 = left + j * colW + colW / 2;
            nctx.moveTo(x1, y1);
            nctx.lineTo(x2, y2);
          }
        }
        nctx.stroke();

        nctx.restore();
      }

      // paths terminate per page
      bellsForPath.forEach((bell, bi) => {
        nctx.strokeStyle = '#f9c74f';
        nctx.lineWidth = 2;
        nctx.setLineDash(PATH_STYLES[bi % PATH_STYLES.length]);
        let prev = null;
        for (let i = 0; i < rowsToShow; i++) {
          const rowIdx = pageStartRow + i;
          if (rowIdx >= rows.length) break;
          const row = rows[rowIdx];
          const pos = row.indexOf(bell);
          if (pos < 0) continue;
          const x = left + pos * colW + colW / 2;
          const y = contentTop + i * lineH + lineH / 2;
          if (prev) { nctx.beginPath(); nctx.moveTo(prev.x, prev.y); nctx.lineTo(x, y); nctx.stroke(); }
          prev = { x, y };
        }
        nctx.setLineDash([]);
      });

      // digits
      let fs = fontSize;
      if (stage >= 10) fs = Math.min(fs, Math.max(10, Math.floor(colW * 0.85)));
      nctx.font = fs + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      nctx.textAlign = 'center';
      nctx.textBaseline = 'middle';

      for (let i = 0; i < rowsToShow; i++) {
        const rowIdx = pageStartRow + i;
        if (rowIdx >= rows.length) break;
        const row = rows[rowIdx];
        const y = contentTop + i * lineH + lineH / 2;
        const isActive = (rowIdx === highlightRowIdx);

        if (isActive) {
          nctx.fillStyle = 'rgba(249,199,79,0.14)';
          roundRect(nctx, x0 + 8, y - lineH / 2 + 2, w0 - 16, lineH - 4, 10);
          nctx.fill();
        }

        for (let p = 0; p < stage; p++) {
          const bell = row[p];
          const isLive = state.liveBells.includes(bell);
          const x = left + p * colW + colW / 2;

          // v06_p12b_notation_tap_to_ring: brief tap highlight
          if (tapFlash && tapFlash.rowIndex === rowIdx && tapFlash.bell === bell) {
            const rw = colW - 8;
            const rh = lineH - 6;
            if (rw > 2 && rh > 2) {
              nctx.save();
              nctx.fillStyle = 'rgba(249,199,79,0.20)';
              roundRect(nctx, left + p * colW + 4, y - lineH / 2 + 3, rw, rh, 8);
              nctx.fill();
              nctx.restore();
            }
          }

          nctx.fillStyle = isActive ? (isLive ? '#ffffff' : '#c6cbe0') : (isLive ? '#dde8ff' : '#9aa2bb');
          const bgHex = getBellGlyphColor(bell);
          const colorOnly = isBellColorOnly(bell);
          if (bgHex) {
            const tapOn = !!(tapFlash && tapFlash.rowIndex === rowIdx && tapFlash.bell === bell);
            const a = (isActive || tapOn) ? 0.14 : 0.22;
            const mw = Math.max(10, Math.min(colW - 10, colW * 0.74));
            const mh = Math.max(10, Math.min(lineH - 8, lineH * 0.72));
            const mx = left + p * colW + (colW - mw) / 2;
            const my = y - mh / 2;
            drawGlyphBgRoundRect(nctx, mx, my, mw, mh, Math.min(8, mh / 2), bgHex, a);
          }
          if (!colorOnly) nctx.fillText(getBellGlyphChar(bell), x, y);
          if (accuracyDotsEnabledForPane('notation')) {
            drawRowAccuracyOverlayUnderGlyph(nctx, x, y, colW, lineH, fs, rowIdx, p, false);
          }
        }
      }

      nctx.restore();
      nctx.restore();
    }

    // v06_p15_notation_single_page_mode: full-width page + 2-row peek of next page
    function drawOnePageWithPeek(pageStartRow, x0, y0) {
      const w0 = pageW, h0 = pageH;
      nctx.save();
      nctx.fillStyle = 'rgba(255,255,255,0.03)';
      nctx.strokeStyle = 'rgba(255,255,255,0.08)';
      roundRect(nctx, x0, y0, w0, h0, 16);
      nctx.fill(); nctx.stroke();

      const peekRows = 2;
      const peekTopPad = 6;
      const peekLabelH = 14;
      const peekLabelPad = 8;
      const peekBottomPad = 12;
      const peekAreaH = peekRows * lineH + peekTopPad + peekLabelH + peekLabelPad + peekBottomPad;
      const dividerY = y0 + h0 - peekAreaH;

      const contentTop = y0 + 12;
      const contentBottom = dividerY - 8;
      const contentH = contentBottom - contentTop;

      const maxColW = 60;
      const baseColW = w0 / stage;
      const colW = Math.min(baseColW, maxColW);
      const gridW = colW * stage;
      const left = x0 + (w0 - gridW) / 2;
      const rowsToShow = pageSize;

      // vertical grid (full height, including peek)
      nctx.save();
      nctx.strokeStyle = 'rgba(255,255,255,0.06)';
      nctx.setLineDash([4,5]);
      const gridTop = contentTop;
      const gridBottom = y0 + h0 - 12;
      for (let j = 0; j <= stage; j++) {
        const x = left + j * colW;
        nctx.beginPath(); nctx.moveTo(x, gridTop); nctx.lineTo(x, gridBottom); nctx.stroke();
      }
      nctx.setLineDash([]);
      nctx.restore();

      // main clip
      nctx.save();
      nctx.beginPath();
      nctx.rect(x0 + 2, contentTop, w0 - 4, contentH);
      nctx.clip();

      // swaps overlay (optional)
      if (state.notationSwapsOverlay) {
        nctx.save();

        nctx.lineWidth = 1;
        nctx.strokeStyle = 'rgba(255,255,255,0.06)';
        nctx.beginPath();
        for (let i = 0; i < rowsToShow - 1; i++) {
          const beforeIdx = pageStartRow + i;
          const afterIdx = beforeIdx + 1;
          if (afterIdx >= rows.length) break;
          const before = rows[beforeIdx];
          const after = rows[afterIdx];
          const y1 = contentTop + i * lineH + lineH / 2;
          const y2 = contentTop + (i + 1) * lineH + lineH / 2;

          for (let p = 0; p < stage; p++) {
            const bell = before[p];
            if (liveSet.has(bell)) continue;
            const j = after.indexOf(bell);
            if (j < 0) continue;
            const x1 = left + p * colW + colW / 2;
            const x2 = left + j * colW + colW / 2;
            nctx.moveTo(x1, y1);
            nctx.lineTo(x2, y2);
          }
        }
        nctx.stroke();

        nctx.lineWidth = 1.25;
        nctx.strokeStyle = 'rgba(249,199,79,0.16)';
        nctx.beginPath();
        for (let i = 0; i < rowsToShow - 1; i++) {
          const beforeIdx = pageStartRow + i;
          const afterIdx = beforeIdx + 1;
          if (afterIdx >= rows.length) break;
          const before = rows[beforeIdx];
          const after = rows[afterIdx];
          const y1 = contentTop + i * lineH + lineH / 2;
          const y2 = contentTop + (i + 1) * lineH + lineH / 2;

          for (let p = 0; p < stage; p++) {
            const bell = before[p];
            if (!liveSet.has(bell)) continue;
            const j = after.indexOf(bell);
            if (j < 0) continue;
            const x1 = left + p * colW + colW / 2;
            const x2 = left + j * colW + colW / 2;
            nctx.moveTo(x1, y1);
            nctx.lineTo(x2, y2);
          }
        }
        nctx.stroke();

        nctx.restore();
      }

      // paths terminate per page (main section)
      bellsForPath.forEach((bell, bi) => {
        nctx.strokeStyle = '#f9c74f';
        nctx.lineWidth = 2;
        nctx.setLineDash(PATH_STYLES[bi % PATH_STYLES.length]);
        let prev = null;
        for (let i = 0; i < rowsToShow; i++) {
          const rowIdx = pageStartRow + i;
          if (rowIdx >= rows.length) break;
          const row = rows[rowIdx];
          const pos = row.indexOf(bell);
          if (pos < 0) continue;
          const x = left + pos * colW + colW / 2;
          const y = contentTop + i * lineH + lineH / 2;
          if (prev) { nctx.beginPath(); nctx.moveTo(prev.x, prev.y); nctx.lineTo(x, y); nctx.stroke(); }
          prev = { x, y };
        }
        nctx.setLineDash([]);
      });

      // digits (main)
      let fs = fontSize;
      if (stage >= 10) fs = Math.min(fs, Math.max(10, Math.floor(colW * 0.85)));
      nctx.font = fs + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      nctx.textAlign = 'center';
      nctx.textBaseline = 'middle';

      for (let i = 0; i < rowsToShow; i++) {
        const rowIdx = pageStartRow + i;
        if (rowIdx >= rows.length) break;
        const row = rows[rowIdx];
        const y = contentTop + i * lineH + lineH / 2;
        const isActive = (rowIdx === highlightRowIdx);

        if (isActive) {
          nctx.fillStyle = 'rgba(249,199,79,0.14)';
          roundRect(nctx, x0 + 8, y - lineH / 2 + 2, w0 - 16, lineH - 4, 10);
          nctx.fill();
        }

        for (let p = 0; p < stage; p++) {
          const bell = row[p];
          const isLive = state.liveBells.includes(bell);
          const x = left + p * colW + colW / 2;

          if (tapFlash && tapFlash.rowIndex === rowIdx && tapFlash.bell === bell) {
            const rw = colW - 8;
            const rh = lineH - 6;
            if (rw > 2 && rh > 2) {
              nctx.save();
              nctx.fillStyle = 'rgba(249,199,79,0.20)';
              roundRect(nctx, left + p * colW + 4, y - lineH / 2 + 3, rw, rh, 8);
              nctx.fill();
              nctx.restore();
            }
          }

          nctx.fillStyle = isActive ? (isLive ? '#ffffff' : '#c6cbe0') : (isLive ? '#dde8ff' : '#9aa2bb');
          const bgHex = getBellGlyphColor(bell);
          const colorOnly = isBellColorOnly(bell);
          if (bgHex) {
            const tapOn = !!(tapFlash && tapFlash.rowIndex === rowIdx && tapFlash.bell === bell);
            const a = (isActive || tapOn) ? 0.14 : 0.22;
            const mw = Math.max(10, Math.min(colW - 10, colW * 0.74));
            const mh = Math.max(10, Math.min(lineH - 8, lineH * 0.72));
            const mx = left + p * colW + (colW - mw) / 2;
            const my = y - mh / 2;
            drawGlyphBgRoundRect(nctx, mx, my, mw, mh, Math.min(8, mh / 2), bgHex, a);
          }
          if (!colorOnly) nctx.fillText(getBellGlyphChar(bell), x, y);
          if (accuracyDotsEnabledForPane('notation')) {
            drawRowAccuracyOverlayUnderGlyph(nctx, x, y, colW, lineH, fs, rowIdx, p, false);
          }
        }
      }

      nctx.restore(); // main clip

      // Peek strip: only if a next page exists.
      const { totalPages } = getNotationPagingMeta();
      const curPage = Number(ui.notationPage) || 0;
      const hasNext = (curPage + 1) < totalPages;
      if (hasNext) {
        // divider
        nctx.save();
        nctx.strokeStyle = 'rgba(255,255,255,0.22)';
        nctx.lineWidth = 1;
        nctx.beginPath();
        nctx.moveTo(x0 + 8, dividerY);
        nctx.lineTo(x0 + w0 - 8, dividerY);
        nctx.stroke();
        nctx.restore();

        // peek frame
        const peekY0 = dividerY + 2;
        const peekH = (y0 + h0) - peekY0 - 2;
        nctx.save();
        nctx.fillStyle = 'rgba(255,255,255,0.02)';
        nctx.strokeStyle = 'rgba(255,255,255,0.10)';
        roundRect(nctx, x0 + 6, peekY0, w0 - 12, peekH, 12);
        nctx.fill(); nctx.stroke();
        nctx.restore();

        // label
        nctx.save();
        nctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        nctx.fillStyle = 'rgba(200,210,235,0.92)';
        nctx.textAlign = 'left';
        nctx.textBaseline = 'top';
        nctx.fillText('Next page', x0 + 14, dividerY + peekTopPad);
        nctx.restore();

        const peekContentTop = dividerY + peekTopPad + peekLabelH + peekLabelPad;
        const peekContentBottom = y0 + h0 - 12;
        const peekContentH = peekContentBottom - peekContentTop;

        // peek digits (clipped)
        nctx.save();
        nctx.beginPath();
        nctx.rect(x0 + 2, peekContentTop, w0 - 4, peekContentH);
        nctx.clip();

        const nextStart = (curPage + 1) * pageSize;

        // v06_p15b_notation_peek_marker_only: per-row continuation markers (no cross-row connectors)
        const pathSet = (bellsForPath && bellsForPath.length) ? new Set(bellsForPath) : null;
        const markerW = Math.max(10, Math.min(colW - 10, colW * 0.55));
        const markerDY = Math.min(9, Math.max(6, Math.floor(lineH * 0.32)));
        if (pathSet) {
          nctx.save();
          nctx.strokeStyle = 'rgba(249,199,79,0.85)';
          nctx.lineWidth = Math.max(2, Math.min(2.8, lineH * 0.10));
          nctx.lineCap = 'round';
        }
        for (let i = 0; i < peekRows; i++) {
          const rowIdx = nextStart + i;
          if (rowIdx >= rows.length) break;
          const row = rows[rowIdx];
          const y = peekContentTop + i * lineH + lineH / 2;
          const isActive = (rowIdx === highlightRowIdx);

          if (isActive) {
            nctx.fillStyle = 'rgba(249,199,79,0.14)';
            roundRect(nctx, x0 + 8, y - lineH / 2 + 2, w0 - 16, lineH - 4, 10);
            nctx.fill();
          }

          for (let p = 0; p < stage; p++) {
            const bell = row[p];
            const isLive = state.liveBells.includes(bell);
            const x = left + p * colW + colW / 2;
            const bgHex = getBellGlyphColor(bell);
            const colorOnly = isBellColorOnly(bell);
            if (bgHex) {
              const a = isActive ? 0.14 : 0.18;
              const mw = Math.max(10, Math.min(colW - 10, colW * 0.74));
              const mh = Math.max(10, Math.min(lineH - 8, lineH * 0.72));
              const mx = left + p * colW + (colW - mw) / 2;
              const my = y - mh / 2;
              drawGlyphBgRoundRect(nctx, mx, my, mw, mh, Math.min(8, mh / 2), bgHex, a);
            }
            if (pathSet && pathSet.has(bell)) {
              const yMark = y + markerDY;
              nctx.beginPath();
              nctx.moveTo(x - markerW / 2, yMark);
              nctx.lineTo(x + markerW / 2, yMark);
              nctx.stroke();
            }
            nctx.fillStyle = isActive ? (isLive ? '#ffffff' : '#c6cbe0') : (isLive ? '#dde8ff' : 'rgba(154,162,187,0.92)');
            if (!colorOnly) nctx.fillText(getBellGlyphChar(bell), x, y);
            if (accuracyDotsEnabledForPane('notation')) {
              drawRowAccuracyOverlayUnderGlyph(nctx, x, y, colW, lineH, fs, rowIdx, p, false);
            }
          }
        }

        if (pathSet) nctx.restore();

        nctx.restore();
      }

      nctx.restore();
    }

    if (onePage) {
      drawOnePageWithPeek(pageAStart, pad, pad);
    } else {
      drawPage(pageAStart, pad, pad, '', true);
      drawPage(pageBStart, pad + pageW + gap, pad, '', false);
    }
  }

  // v06_p12b_notation_tap_to_ring: hit-test a tap/click to (rowIndex, bell)
  function hitTestNotation(evt, whichPage) {
    if (!notationCanvas || !state.rows || !state.rows.length) return null;

    const rect = notationCanvas.getBoundingClientRect();
    if (!rect || rect.width <= 2 || rect.height <= 2) return null;

    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const W = rect.width;
    const H = rect.height;
    const stage = state.stage;

    const onePage = (ui.notationLayout === 'one_page');
    const pad = 14;
    const gap = onePage ? 0 : 14;
    const pageW = onePage ? (W - pad * 2) : ((W - pad * 2 - gap) / 2);
    const pageH = H - pad * 2;
    if (!(pageW > 10 && pageH > 10 && stage >= 1)) return null;

    let page = whichPage;
    if (onePage) {
      page = 0;
    } else if (page == null) {
      if (x >= pad && x <= pad + pageW) page = 0;
      else if (x >= pad + pageW + gap && x <= pad + pageW + gap + pageW) page = 1;
      else return null;
    } else {
      if (page === 'left') page = 0;
      else if (page === 'right') page = 1;
      page = (Number(page) || 0) ? 1 : 0;
    }

    const x0 = (page === 0) ? pad : (pad + pageW + gap);
    const y0 = pad;
    if (x < x0 || x > x0 + pageW) return null;
    if (y < y0 || y > y0 + pageH) return null;

    const lineH = 24;
    const pageSize = Math.max(1, Number(state.notationPageSize) || 1);

    // v06_p13_notation_touch_polish: labels removed, so don't reserve header height.
    const contentTop = y0 + 12;
    let contentBottom = y0 + pageH - 12;
    if (onePage) {
      const peekRows = 2;
      const peekTopPad = 6;
      const peekLabelH = 14;
      const peekLabelPad = 8;
      const peekBottomPad = 12;
      const peekAreaH = peekRows * lineH + peekTopPad + peekLabelH + peekLabelPad + peekBottomPad;
      const dividerY = y0 + pageH - peekAreaH;
      contentBottom = dividerY - 8;
    }
    if (y < contentTop || y > contentBottom) return null;

    const maxColW = 60;
    const baseColW = pageW / stage;
    const colW = Math.min(baseColW, maxColW);
    const gridW = colW * stage;
    const left = x0 + (pageW - gridW) / 2;
    if (x < left || x > left + gridW) return null;

    const rowOffset = Math.floor((y - contentTop) / lineH);
    if (rowOffset < 0 || rowOffset >= pageSize) return null;

    const col = Math.floor((x - left) / colW);
    if (col < 0 || col >= stage) return null;

    // v08_p03_two_page_present_peek: in two-page layout, ui.notationPage is the PRESENT (left) page.
    let basePage = Number(ui.notationPage) || 0;
    if (basePage < 0) basePage = 0;
    const pageStartRow = (basePage + page) * pageSize;
    const rowIndex = pageStartRow + rowOffset;
    if (rowIndex < 0 || rowIndex >= state.rows.length) return null;

    const row = state.rows[rowIndex];
    if (!row) return null;
    const bell = row[col];
    if (bell == null || bell < 1 || bell > stage) return null;

    return { rowIndex, bell };
  }

  // === Stats render (MAE + scale/octave) ===
  function fmtMs(ms, signed) {
    if (ms == null || isNaN(ms)) return '&ndash;';
    const v = Math.round(ms);
    if (signed) {
      if (v === 0) return '0';
      const sign = v > 0 ? '+' : '−';
      return sign + Math.abs(v);
    }
    return String(v);
  }

  function getPRCombo() {
    const t = analytics.totals || analytics.refreshTotals();
    return Number((t && t.pr_combo_global) || 0);
  }

  // v08_p02_scoring_explanation_sync: shared scoring explanation copy (Setup + Stats)
  function getScoringExplanationText() {
    const stage = clamp(parseInt(state.stage, 10) || 6, 4, 12);
    return "Scoring: each row is divided into '" + stage + "' bell windows. For each scored bell and row, you get one scoring chance. Hits inside the window score 5–10 points based on accuracy; hits outside score 0. Extra rings still sound but only the first ring for a bell in a row counts for scoring. MAE (ms) is Mean Absolute Error: average timing error per hit. Lower values mean greater overall accuracy.";
  }

  function renderScoringExplanation() {
    const txt = getScoringExplanationText();
    const setupEl = document.getElementById('setupScoringExplain');
    if (setupEl) setupEl.textContent = txt;
    const statsEl = document.getElementById('statsScoringExplain');
    if (statsEl) statsEl.textContent = txt;
  }

  function renderStats(nowMs) {
    if (!viewStats.checked) return;
    if (state.mode === 'demo') {
      const rowsTotal = state.rows ? state.rows.length : 0;
      const rowsDone = rowsTotal ? Math.min(Math.floor(state.execBeatIndex / state.stage), rowsTotal) : 0;
      const elapsed = getElapsedSeconds(nowMs);
      statsDiv.innerHTML = `
        <div class="summary">
          <div><span>Rows:</span> ${rowsDone}/${rowsTotal}</div>
          <div><span>Time:</span> ${elapsed.toFixed(1)} s</div>
          <div><span>Mode:</span> Demo</div>
          <div><span>Scoring:</span> Disabled</div>
        </div>
        <div class="stats-info">
          Demo mode – all bells ring automatically according to the method.
          You can still ring bells via keyboard or display for musical expression,
          but hits/misses are not tracked.
        </div>
      `;
      return;
    }
    const live = state.liveBells.slice().sort((a,b)=>a-b);
    if (!live.length) { statsDiv.textContent = 'No scored bells selected.'; return; }

    let totalHits = 0, totalMisses = 0, sumAbs = 0, scoreTotal = 0;
    live.forEach(b => {
      const s = state.statsByBell[b];
      totalHits += s.hits;
      totalMisses += s.misses;
      sumAbs += s.sumAbsDelta;
      scoreTotal += s.score;
    });

    const totalTargets = totalHits + totalMisses;
    const rowsCompleted = Math.min(Math.floor(state.execBeatIndex / state.stage), state.rows.length);
    const totalRows = state.rows.length;

    const accOverall = totalTargets > 0 ? (totalHits / totalTargets) * 100 : null;
    const maeOverall = totalHits > 0 ? Math.round(sumAbs / totalHits) : null;
    const elapsed = getElapsedSeconds(nowMs);
    let html = '';
    html += '<div class="summary">';
    html += 'Rows: ' + rowsCompleted + ' / ' + totalRows + ' &nbsp; ';
    html += 'Acc%: ' + (accOverall == null ? '&ndash;' : accOverall.toFixed(0)) + ' &nbsp; ';
    html += 'Combo: ' + state.comboCurrentGlobal + ' (best ' + state.comboBestGlobal + ') &nbsp; ';
    html += 'MAE (ms): ' + (maeOverall == null ? '&ndash;' : fmtMs(maeOverall, false) + ' ms') + ' &nbsp; ';
    html += 'Score: ' + Math.round(scoreTotal) + ' &nbsp; ';
    html += 'Time: ' + elapsed.toFixed(1) + ' s';
    html += '</div>';

    html += '<table><thead><tr>';
    html += '<th>Bell</th><th>Targets</th><th>Hits</th><th>Misses</th><th>Acc%</th><th>Cur combo</th><th>Best combo</th><th>MAE (ms)</th><th>Score</th>';
    html += '</tr></thead><tbody>';

    live.forEach(bell => {
      const s = state.statsByBell[bell];
      const targets = s.hits + s.misses;
      const acc = targets > 0 ? (s.hits / targets) * 100 : null;
      const mae = s.hits > 0 ? Math.round(s.sumAbsDelta / s.hits) : null;

      html += '<tr>';
      html += '<td>' + bellToGlyph(bell) + '</td>';
      html += '<td>' + targets + '</td>';
      html += '<td>' + s.hits + '</td>';
      html += '<td>' + s.misses + '</td>';
      html += '<td>' + (acc == null ? '&ndash;' : acc.toFixed(0)) + '</td>';
      html += '<td>' + s.comboCurrent + '</td>';
      html += '<td>' + s.comboBest + '</td>';
      html += '<td>' + fmtMs(mae, false) + '</td>';
      html += '<td>' + Math.round(s.score) + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';

    html += '<div class="stats-info" id="statsScoringExplain"></div>';

    // v015_p04_stats_export_import_and_compare: show loaded historic stats when compatible
    const histAll = (ui.loadedStatsHistory && Array.isArray(ui.loadedStatsHistory)) ? ui.loadedStatsHistory : [];
    if (histAll.length) {
      const currentSig = buildScoringSignatureFromState();
      const matching = [];
      let otherCount = 0;
      for (const rec of histAll) {
        const sig = rec && rec.scoringSignature;
        if (sig && scoringSignatureEquals(currentSig, sig)) matching.push(rec);
        else otherCount += 1;
      }

      if (matching.length) {
        const getMaeMs = (rec) => {
          const m = Number(rec && rec.MAEms);
          if (Number.isFinite(m)) return Math.round(m);
          // Fallback: weighted MAE from perBell (may be approximate due to rounding).
          const pb = (rec && rec.perBell && typeof rec.perBell === 'object') ? rec.perBell : {};
          let hits = 0, sum = 0;
          for (const k of Object.keys(pb)) {
            const s = pb[k] || {};
            const h = Number(s.hits) || 0;
            const mae = Number(s.maeMs);
            if (h > 0 && Number.isFinite(mae)) { hits += h; sum += h * mae; }
          }
          return hits > 0 ? Math.round(sum / hits) : null;
        };

        const getWhenIso = (rec) => (rec && rec.savedAtISO) ? String(rec.savedAtISO) : ((rec && rec.runEndedAtISO) ? String(rec.runEndedAtISO) : '');
        const getWhenMs = (iso) => { const d = safeParseIso(iso); return d ? d.getTime() : 0; };

        const formatPanesCompact = (panes) => {
          const p = panes && typeof panes === 'object' ? panes : {};
          const out = [];
          if (p.display) out.push('D');
          if (p.spotlight) out.push('S');
          if (p.notation) out.push('N');
          if (p.stats) out.push('T');
          if (p.mic) out.push('M');
          return out.length ? out.join('') : '—';
        };

        matching.sort((a, b) => {
          const sa = Number(a && a.scoreGlobal);
          const sb = Number(b && b.scoreGlobal);
          const sca = Number.isFinite(sa) ? sa : -Infinity;
          const scb = Number.isFinite(sb) ? sb : -Infinity;
          if (scb !== sca) return scb - sca;

          const ma = getMaeMs(a);
          const mb = getMaeMs(b);
          const maa = Number.isFinite(ma) ? ma : Infinity;
          const mbb = Number.isFinite(mb) ? mb : Infinity;
          if (maa !== mbb) return maa - mbb;

          const ta = getWhenMs(getWhenIso(a));
          const tb = getWhenMs(getWhenIso(b));
          return tb - ta;
        });

        const top = matching.slice(0, 10);

        html += '<div class="stats-historic">';
        html += '<div class="stats-historic-title">Historic (Top 10)</div>';

        for (const rec of top) {
          const score = Number(rec && rec.scoreGlobal);
          const scoreTxt = Number.isFinite(score) ? String(Math.round(score)) : '&ndash;';

          const mae = getMaeMs(rec);
          const maeTxt = (mae == null || !Number.isFinite(mae)) ? '&ndash;' : (escapeHtml(fmtMs(mae, false)) + ' ms');

          const whenIso = getWhenIso(rec);
          const whenTxt = whenIso ? escapeHtml(fmtIsoForUi(whenIso)) : '&ndash;';

          const meta = (rec && rec.meta && typeof rec.meta === 'object') ? rec.meta : {};
          const nm = meta && meta.name ? String(meta.name) : '';
          const label = nm ? escapeHtml(nm) : '';

          const inputTxt = formatInputMethodsSummary(rec);
          const panesTxt = formatPanesCompact(rec && rec.panesEnabled);


          html += '<div class="stats-historic-item">';
          html += '<span class="stats-historic-score">' + scoreTxt + '</span>';
          html += '<span class="stats-historic-mae">' + maeTxt + '</span>';
          html += '<span class="stats-historic-when">' + whenTxt + '</span>';
          if (label) html += '<span class="stats-historic-label">' + label + '</span>';
          html += '<span class="stats-historic-details">Input: ' + escapeHtml(inputTxt) + ' • Panes:' + escapeHtml(panesTxt) + '</span>';
          html += '</div>';
        }

        if (matching.length > 10) {
          html += '<div class="stats-historic-note">Showing top 10 of ' + String(matching.length) + ' matching runs.</div>';
        }

        if (otherCount > 0) {
          html += '<div class="stats-historic-note">Saved stats exist for other setups (' + otherCount + ').</div>';
        }
        html += '</div>';
      } else {
        html += '<div class="stats-historic">';
        html += '<div class="stats-historic-title">Historic</div>';
        html += '<div class="stats-historic-note">Saved stats exist for other setups.</div>';
        html += '</div>';
      }
    }

    statsDiv.innerHTML = html;
    renderScoringExplanation();
  }

  // === Engine start/stop + analytics ===
  function startPressed(mode) {
    if (!state.rows.length) { alert('No rows loaded.'); return; }
    if (state.phase !== 'idle') return;
    // v017_p01_polyrhythm_core: ensure a clean start (stop polyrhythm test if active)
    try { stopPolyrhythmTest(); } catch (_) {}


    // v08_p04_demo_profile_defaults: any run (Play or Demo) means the session is no longer pristine.
    ui.hasRunStartedThisSession = true;

    state.mode = (mode === 'demo') ? 'demo' : 'play';

    state.keybindCaptureBell = null;
    rebuildKeybindPanel();

    const playId = rid('p_');
    state.currentPlay = {
      playId,
      began: false,
      mode: state.mode,
      createdAtISO: new Date().toISOString(),
      startedAtISO: null,
      endedAtISO: null,
      panesEnabled: snapshotPanesEnabled(),
      anyBells: getAnyKeyboundBells(),
      inputUsed: { keyboard: false, tap: false, mic: false },
    };

    const tempoBpm = clamp(parseInt(bpmInput.value, 10) || 80, 1, 240);
    state.bpm = tempoBpm;
    bpmInput.value = String(state.bpm);
    if (bpmSlider) bpmSlider.value = String(state.bpm);
    syncGameHeaderMeta();
    const beatMs = 60000 / state.bpm;

    const pathMode = getPathMode();
    const pathBellsStr = (pathMode === 'custom')
      ? state.pathBells.slice().sort((a,b)=>a-b).join(',')
      : (pathMode === 'all')
        ? Array.from({length: state.stage}, (_,i)=>i+1).join(',')
        : '';


    if (state.mode === 'demo') stopMicCapture();
    ensureAudio();
    // v09_p08p_background_policy_and_drone_ownership:
    // If the drone is currently owned by the run, ensure it is audible during active Play/Demo.
    if (state.droneOwner === 'run' && state.droneOn) {
      state.dronePaused = false;
      if (!droneCurrent) { try { startDrone(); } catch (_) {} }
      applyDroneMasterGain();
      syncDronePauseBtnUI();
    }
    if (state.mode === 'play' && state.micEnabled && !state.micActive && getMicControlledBells().length) startMicCapture();

    const now = perfNow();

    state.phase = 'countdown';
    state.pausePrevPhase = '';
    state.pauseAtMs = 0;
    state.elapsedMs = 0;
    state.runStartPerfMs = 0;
    state.schedBeatIndex = 0;
    state.execBeatIndex = 0;
    // v017_p01_polyrhythm_core: reset polyrhythm scheduler cursors for new run
    polySchedNextById = Object.create(null);
    state.targets.length = 0;
    resetStats();

    state.countFirstBeatMs = now + beatMs;
    state.countExec = 0;
    state.countSched = 0;
    state.countdownBeats = state.stage; // rounds: 1..stage
    state.methodStartMs = state.countFirstBeatMs + state.countdownBeats * beatMs;

    // Build all scoring targets upfront for row-based scoring.
    if (state.mode === 'play') buildAllTargets(beatMs);

    startBtn.disabled = true;
    if (pauseBtn) {
      pauseBtn.textContent = 'Pause';
      pauseBtn.disabled = false;
    }
    stopBtn.disabled = false;
    if (demoBtn) demoBtn.disabled = true;
    syncWakeLockForRun();
    markDirty();
    kickLoop();
  }

  function buildPlayEndPayload(nowMs, endReason) {
    updateMisses(nowMs);
    finalizePendingAsMisses(nowMs);

    const live = state.liveBells.slice().sort((a,b)=>a-b);
    let totalHits = 0, totalMisses = 0, sumAbs = 0, sumSigned = 0, scoreTotal = 0;

    for (const b of live) {
      const s = state.statsByBell[b];
      totalHits += s.hits;
      totalMisses += s.misses;
      sumAbs += s.sumAbsDelta;
      sumSigned += s.sumSignedDelta;
      scoreTotal += s.score;
    }
    const totalTargets = totalHits + totalMisses;
    const accuracyPct = totalTargets > 0 ? (totalHits / totalTargets) * 100 : 0;

    const meanAbs = totalHits > 0 ? Math.round(sumAbs / totalHits) : 0;
    const meanSigned = totalHits > 0 ? Math.round(sumSigned / totalHits) : 0;

    const totalBeats = state.rows.length * state.stage;
    const beatsExecuted = clamp(state.execBeatIndex, 0, totalBeats);
    const rowsCompleted = Math.min(Math.floor(beatsExecuted / state.stage), state.rows.length);

    const durationMs = Math.max(0, Math.round(state.elapsedMs));

    const parts = [];
    for (const b of live) {
      const s = state.statsByBell[b];
      const targets = s.hits + s.misses;
      const ma = s.hits > 0 ? Math.round(s.sumAbsDelta / s.hits) : 0;
      const ms = s.hits > 0 ? Math.round(s.sumSignedDelta / s.hits) : 0;
      const msStr = (ms > 0 ? '+' + ms : (ms < 0 ? '' + ms : '0'));
      parts.push('b' + b +
        ':h' + s.hits +
        'm' + s.misses +
        't' + targets +
        's' + Math.round(s.score) +
        'ma' + ma +
        'ms' + msStr +
        'cb' + s.comboBest
      );
    }

    return {
      play_id: state.currentPlay ? state.currentPlay.playId : '',
      session_id: analytics.sessionId,
      end_reason: endReason,
      duration_ms: durationMs,
      rows_completed: rowsCompleted,
      total_targets: totalTargets,
      total_hits: totalHits,
      total_misses: totalMisses,
      accuracy_pct: Math.round(accuracyPct * 10) / 10,
      mean_abs_delta_ms: meanAbs,
      mean_signed_delta_ms: meanSigned,
      score_total: Math.round(scoreTotal),
      combo_best_global: state.comboBestGlobal,
      bell_stats: parts.join('|'),
      treble_tone: currentTrebleToneLabel(),
      octave: currentOctaveLabel(),
      bell_root_type: state.scaleKey === 'custom_hz' ? 'custom' : 'scale',
      bell_custom_hz: state.scaleKey === 'custom_hz' ? getBellRootFrequency() : null,
      drone_root_type: state.droneScaleKey === 'custom_hz' ? 'custom' : 'scale',
      drone_custom_hz: state.droneScaleKey === 'custom_hz' ? getDroneRootFrequency() : null
    };
  }

  function updateVisitorTotals(playEndPayload) {
    const t = analytics.totals;
    t.plays_total += 1;
    t.seconds_total += Math.round((playEndPayload.duration_ms || 0) / 1000);
    t.targets_total += Number(playEndPayload.total_targets || 0);
    t.hits_total += Number(playEndPayload.total_hits || 0);
    t.misses_total += Number(playEndPayload.total_misses || 0);
    t.score_total += Number(playEndPayload.score_total || 0);

    const combo = Number(playEndPayload.combo_best_global || 0);
    if (combo > t.pr_combo_global) t.pr_combo_global = combo;

    analytics.saveTotals();
  }

  function stopPressed(endReason) {
    const now = perfNow();
    if (state.phase === 'running') state.elapsedMs += (now - state.runStartPerfMs);

    // Stop any already-scheduled future bell/tick strikes immediately.
    // (Important when the AudioContext stays alive for the drone / mic, especially in Demo where we may schedule far ahead.)
    cancelScheduledBellAudioNow();
    // v017_p01_polyrhythm_core: stop any scheduled polyrhythm strikes
    cancelScheduledPolyAudioNow();
    polySchedNextById = Object.create(null);

    const hadPlay = !!state.currentPlay;
    const runMode = (state.currentPlay && state.currentPlay.mode) || state.mode;

    state.phase = 'idle';
    state.pausePrevPhase = '';
    state.pauseAtMs = 0;
    if (pauseBtn) {
      pauseBtn.textContent = 'Pause';
      pauseBtn.disabled = true;
    }
    scheduledBellNodes.length = 0;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (demoBtn) demoBtn.disabled = false;

    if (hadPlay) {
      // v015_p04_stats_export_import_and_compare: snapshot run-end info for optional export
      try { if (state.currentPlay) state.currentPlay.endedAtISO = new Date().toISOString(); } catch (_) {}

      const payload = buildPlayEndPayload(now, endReason);
      payload.mode = runMode;
      if (runMode === 'play') updateVisitorTotals(payload);

      if (runMode === 'play') {
        try { ui.lastRunStatsSnapshot = captureLastRunStatsSnapshot(); } catch (_) { ui.lastRunStatsSnapshot = null; }
        try { updateLoadAppendRunButtonState(); } catch (_) {}
      }

      state.currentPlay = null;
    }

    // v09_p08p_background_policy_and_drone_ownership:
    // If the drone is owned by the run, end it with the run. Meditation-owned drone persists.
    if (state.droneOwner === 'run' && state.droneOn) {
      state.dronePaused = true;
      applyDroneMasterGain();
      syncDronePauseBtnUI();
    }

    syncWakeLockForRun();

    closeAudio();
    state.mode = 'play';

    // v06_p12a_notation_paging_arrows: reset paging to follow mode
    ui.notationFollow = true;
    ui.notationPage = 0;
    syncNotationPagingUI();

    syncGameHeaderMeta();
    markDirty();
  }

  // Prompt 6: pause/resume (does not pause the AudioContext; drone continues)
  function togglePause() {
    if (state.phase === 'paused') {
      const nowMs = perfNow();
      const pausedDurMs = Math.max(0, nowMs - (state.pauseAtMs || nowMs));
      const prev = (state.pausePrevPhase === 'countdown' || state.pausePrevPhase === 'running') ? state.pausePrevPhase : 'running';

      state.phase = prev;
      state.methodStartMs += pausedDurMs;

      if (prev === 'countdown') {
        state.countFirstBeatMs += pausedDurMs;
        state.countSched = state.countExec;
      } else {
        state.runStartPerfMs = nowMs;
        state.schedBeatIndex = state.execBeatIndex;
      }

      // Shift unjudged scoring targets only (play mode)
      if (state.mode === 'play' && Array.isArray(state.targets) && pausedDurMs > 0) {
        for (let i = 0; i < state.targets.length; i++) {
          const t = state.targets[i];
          if (t && !t.judged) t.timeMs += pausedDurMs;
        }
      }

      state.pausePrevPhase = '';
      state.pauseAtMs = 0;
      if (pauseBtn) pauseBtn.textContent = 'Pause';

      // Wake lock is only held while actively running/countdown.
      syncWakeLockForRun();

      syncGameHeaderMeta();
      markDirty();
      kickLoop();
      return;
    }

    if (state.phase !== 'countdown' && state.phase !== 'running') return;
    const nowMs = perfNow();

    state.pausePrevPhase = state.phase;
    state.pauseAtMs = nowMs;
    if (state.phase === 'running') {
      state.elapsedMs += (nowMs - state.runStartPerfMs);
    }

    state.phase = 'paused';

    // Wake lock is only held while actively running/countdown.
    syncWakeLockForRun();

    // Stop auto-ringing immediately by canceling already-scheduled future strikes.
    cancelScheduledBellAudioNow();
    // v017_p01_polyrhythm_core: cancel already-scheduled future polyrhythm strikes (pause-safe)
    cancelScheduledPolyAudioNow();
    try {
      const beatMs = 60000 / (Number(state.bpm) || 120);
      polyResetSchedPointers(nowMs, state.methodStartMs, beatMs);
    } catch (_) {}


    // Align sched pointers so Resume can reschedule cleanly.
    state.schedBeatIndex = state.execBeatIndex;
    state.countSched = state.countExec;

    if (pauseBtn) {
      pauseBtn.textContent = 'Resume';
      pauseBtn.disabled = false;
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (demoBtn) demoBtn.disabled = true;

    syncGameHeaderMeta();
    markDirty();
    kickLoop();
  }

  function resyncDemoToNow(nowMs) {
    if (state.mode !== 'demo') return;
    if (state.phase === 'idle') return;
    if (state.phase === 'paused') return;

    const beatMs = 60000 / state.bpm;
    const totalBeats = (state.rows && state.rows.length ? state.rows.length * state.stage : 0);
    if (!totalBeats) return;

    if (nowMs >= state.methodStartMs) {
      if (state.phase !== 'running') {
        state.phase = 'running';
        state.runStartPerfMs = state.methodStartMs;

        if (state.currentPlay && !state.currentPlay.began) {
          state.currentPlay.began = true;
          try { if (!state.currentPlay.startedAtISO) state.currentPlay.startedAtISO = new Date().toISOString(); } catch (_) {}
        }
      }

      let elapsedBeats = Math.floor((nowMs - state.methodStartMs) / beatMs) + 1;
      if (!Number.isFinite(elapsedBeats)) elapsedBeats = 0;
      elapsedBeats = clamp(elapsedBeats, 0, totalBeats);

      state.execBeatIndex = elapsedBeats;
      state.schedBeatIndex = Math.max(state.schedBeatIndex, state.execBeatIndex);

      if (state.execBeatIndex > 0) {
        const lastStrike = clamp(state.execBeatIndex - 1, 0, Math.max(0, totalBeats - 1));
        const bell = getBellForStrikeIndex(lastStrike);
        const tMs = state.methodStartMs + lastStrike * beatMs;
        markRung(bell, tMs);
      }

      // v08_p03_last_bell_fix: don't end the run at the exact final strike.
      // Allow the last bell to sound and the final scoring window/tail to complete.
      if (state.execBeatIndex >= totalBeats) {
        const lastBeatAtMs = state.methodStartMs + (totalBeats - 1) * beatMs;
        const graceMs = Math.max(beatMs / 2, 340);
        if (nowMs >= lastBeatAtMs + graceMs) {
          stopPressed('completed');
          return;
        }
      }
    }
  }


    function scheduleCountdown(nowMs) {
    if (state.phase === 'paused') return;
    if (state.phase !== 'countdown') return;
    const beatMs = 60000 / state.bpm;
    const total = state.countdownBeats || state.stage;

    const isDemo = state.mode === 'demo';
    const horizonMs = isDemo ? demoEffectiveHorizonMs() : Math.max(LOOKAHEAD_MS, getMaintenanceIntervalMs());
    let schedThisPass = 0;

    // Rounds: ring 1..stage on each beat.
    while (state.countSched < total) {
      const tMs = state.countFirstBeatMs + state.countSched * beatMs;
      if (tMs <= nowMs + horizonMs && (!isDemo || schedThisPass < DEMO_SCHED_MAX_PER_PASS)) {
        const bell = (state.countSched % state.stage) + 1; // 1..stage
        playBellAt(bell, tMs);
        state.countSched += 1;
        if (isDemo) schedThisPass += 1;
      } else break;
    }

    // Do not advance demo visuals/state while hidden (we resync on return).
    if (isDemo && document.hidden) return;

    while (state.countExec < total) {
      const tMs = state.countFirstBeatMs + state.countExec * beatMs;
      if (nowMs >= tMs) state.countExec += 1; else break;
    }

    if (state.countExec >= total && nowMs >= state.methodStartMs) {
      state.phase = 'running';
      state.runStartPerfMs = state.methodStartMs;

      if (state.currentPlay && !state.currentPlay.began) {
        state.currentPlay.began = true;
      }
    }
  }




    // v017_p01_polyrhythm_core: Polyrhythm scheduler + phrase parser
    function polyFracToBeats(fracStr) {
      const s = String(fracStr ?? '0').trim();
      if (!s) return 0;
      if (s.includes('/')) {
        const parts = s.split('/');
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !b) return 0;
        return a / b;
      }
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }

    function polyIntervalBeats(intervalKey) {
      const v = polyFracToBeats(intervalKey ?? '1');
      return (v > 0) ? v : 1;
    }

    function polyOffsetOptionsForInterval(intervalKey) {
      const key = String(intervalKey || '1');
      const presets = {
        '2': ['0', '1/2', '1', '3/2'],
        '1': ['0', '1/2'],
        '1/2': ['0', '1/4', '1/2'],
        '1/3': ['0', '1/6', '1/3', '1/2', '2/3'],
        '1/4': ['0', '1/8', '1/4', '3/8', '1/2'],
      };
      const arr = presets[key] || presets['1'];
      return arr.map(v => ({ value: v, label: v }));
    }

    // Tokens: 1–9, 0=10, E=11, T=12 (case-insensitive).
    // Separators: whitespace and commas (ignored).
    // Any other non-assigned character counts as a rest step (silent beat).
    function parsePolyPhraseSteps(phrase) {
      const s = String(phrase || '');
      const steps = [];
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') continue;

        const up = ch.toUpperCase();
        if (up >= '1' && up <= '9') steps.push(parseInt(up, 10));
        else if (up === '0') steps.push(10);
        else if (up === 'E') steps.push(11);
        else if (up === 'T') steps.push(12);
        else steps.push(0); // rest
      }
      return steps;
    }

    function polyComputeNextIndex(nowMs, anchorMs, beatMs, intervalBeats, offsetBeats) {
      if (!(beatMs > 0) || !(intervalBeats > 0)) return 0;
      const firstMs = anchorMs + offsetBeats * beatMs;
      if (nowMs < firstMs) return 0;
      const deltaBeats = (nowMs - anchorMs) / beatMs - offsetBeats;
      const n = Math.floor(deltaBeats / intervalBeats) + 1;
      return Math.max(0, n);
    }

    function polyResetSchedPointers(nowMs, anchorMs, beatMs) {
      const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer || !layer.id) continue;
        const intervalBeats = polyIntervalBeats(layer.interval);
        const offsetBeats = polyFracToBeats(layer.offset);
        polySchedNextById[layer.id] = polyComputeNextIndex(nowMs, anchorMs, beatMs, intervalBeats, offsetBeats);
      }
    }

    function schedulePolyrhythm(nowMs) {
      // Pause gates all scheduling.
      if (state.phase === 'paused') return;

      const runActive = polyIsRunActive();
      if (!polyTestActive && !runActive) return;

      const layers = Array.isArray(state.polyLayers) ? state.polyLayers : [];
      if (!layers.length) return;

      const bpm = polyTestActive ? (Number(polyTestBpm) || 120) : (Number(state.bpm) || 120);
      const beatMs = 60000 / bpm;
      const anchorMs = polyTestActive ? polyTestStartMs : state.methodStartMs;

      const isDemo = (!polyTestActive && state.mode === 'demo');
      const horizonMs = isDemo ? demoEffectiveHorizonMs() : Math.max(LOOKAHEAD_MS, getMaintenanceIntervalMs());
      const maxPerPass = isDemo ? 1200 : 360;

      const totalBeats = (state.rows && state.rows.length) ? (state.rows.length * state.stage) : 0;

      let scheduledCount = 0;

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer || layer.enabled === false) continue;

        const intervalBeats = polyIntervalBeats(layer.interval);
        if (!(intervalBeats > 0)) continue;

        const offsetBeats = polyFracToBeats(layer.offset);
        const layerVol = clamp((Number(layer.volume) || 0) / 100, 0, 1);

        // In demo, never schedule infinitely far ahead for fast intervals.
        const layerHorizonMs = Math.min(horizonMs, intervalBeats * beatMs * DEMO_MAX_AHEAD_STRIKES);

        let next = polySchedNextById[layer.id];
        if (!Number.isFinite(next) || next < 0) {
          next = polyComputeNextIndex(nowMs, anchorMs, beatMs, intervalBeats, offsetBeats);
        }

        const type = layer.type || 'pulse';
        const sound = layer.sound || 'bell';
        const soundCtx = (sound === 'bell') ? polyBuildBellSoundCtx(layer) : null;

        // Pre-parse phrase once per pass per layer (cheap but avoids per-strike work).
        const phraseSteps = (type === 'phrase') ? parsePolyPhraseSteps(layer.phrase) : null;

        while (scheduledCount < maxPerPass) {
          const tMs = anchorMs + (offsetBeats + next * intervalBeats) * beatMs;
          if (tMs > nowMs + layerHorizonMs) break;

          let doSound = false;
          let bellToken = 0;

          if (type === 'pulse') {
            doSound = true;
            bellToken = clamp(parseInt(layer.token, 10) || 1, 1, 12);
          } else if (type === 'phrase') {
            if (phraseSteps && phraseSteps.length) {
              bellToken = phraseSteps[next % phraseSteps.length] || 0;
              doSound = (bellToken > 0);
            } else {
              doSound = false;
            }
          } else if (type === 'method_current') {
            if (totalBeats > 0) {
              bellToken = getBellForStrikeIndex(next % totalBeats);
              doSound = true;
            }
          }

          if (doSound) {
            try {
              if (Number.isFinite(tMs)) {
                if (sound === 'tick') playPolyTickAt(tMs, layerVol);
                else if (sound === 'bell') playPolyBellAt(bellToken, tMs, layerVol, soundCtx);
                else if (sound === 'synth') {
                  if (typeof playPolySynthAt === 'function') playPolySynthAt(bellToken, tMs, layerVol, layer);
                  else playPolyTickAt(tMs, layerVol);
                } else if (sound === 'perc') {
                  if (typeof playPolyPercAt === 'function') playPolyPercAt(bellToken, tMs, layerVol, layer);
                  else playPolyTickAt(tMs, layerVol);
                } else {
                  playPolyTickAt(tMs, layerVol);
                }
              }
            } catch (_) {}
            scheduledCount++;
          }

          next++;
          if (scheduledCount >= maxPerPass) break;
        }

        polySchedNextById[layer.id] = next;
        if (scheduledCount >= maxPerPass) break;
      }
    }

    function scheduleMethod(nowMs) {
    if (state.phase === 'paused') return;
    // v09_p09_p01_first_hit_window_fix: allow scheduling to start during countdown
    // so the first method strike is scheduled on the same time reference as later strikes.
    if (state.phase !== 'running' && state.phase !== 'countdown') return;
    const beatMs = 60000 / state.bpm;
    const totalBeats = state.rows.length * state.stage;
    const liveSet = new Set(state.liveBells);

    const isDemo = state.mode === 'demo';
    const horizonMs = isDemo ? demoEffectiveHorizonMs() : Math.max(LOOKAHEAD_MS, getMaintenanceIntervalMs());
    let schedThisPass = 0;

    while (state.schedBeatIndex < totalBeats) {
      const tMs = state.methodStartMs + state.schedBeatIndex * beatMs;
      if (tMs <= nowMs + horizonMs && (!isDemo || schedThisPass < DEMO_SCHED_MAX_PER_PASS)) {
        const bell = getBellForStrikeIndex(state.schedBeatIndex);
        if (state.mode === 'demo' || !liveSet.has(bell)) playBellAt(bell, tMs);
        state.schedBeatIndex += 1;
        if (isDemo) schedThisPass += 1;
      } else break;
    }

    if (state.phase !== 'running') return;

    // Do not advance demo visuals/state while hidden (we resync on return).
    if (isDemo && document.hidden) return;

    while (state.execBeatIndex < totalBeats) {
      const tMs = state.methodStartMs + state.execBeatIndex * beatMs;
      if (nowMs >= tMs) {
        const bell = getBellForStrikeIndex(state.execBeatIndex);
        markRung(bell, tMs);
        state.execBeatIndex += 1;
      } else break;
    }

    // v08_p03_last_bell_fix: don't stop exactly at the final strike.
    // Give the final bell time to sound and the last scoring window to be judged.
    if (state.execBeatIndex >= totalBeats) {
      const lastBeatAtMs = state.methodStartMs + (totalBeats - 1) * beatMs;
      const graceMs = Math.max(beatMs / 2, 340);
      if (nowMs >= lastBeatAtMs + graceMs) stopPressed('completed');
    }
  }


  function loop() {
    const nowMs = perfNow();
    inLoopTick = true;

    // Reacquire wake lock if the browser/OS released it while a run is still active.
    if (!wakeLockSentinel && !document.hidden && isActiveRunForWakeLock()) {
      requestWakeLock();
    }

    // === Maintenance tick (logic + audio scheduling only) ===
    const prevExecBeatIndex = state.execBeatIndex;
    const prevCountExec = state.countExec;
    const prevPhase = state.phase;

    const dprNow = window.devicePixelRatio || 1;
    if (dprNow !== lastKnownDPR) {
      lastKnownDPR = dprNow;
      markDirty();
    }

    scheduleCountdown(nowMs);
    scheduleMethod(nowMs);
    try { schedulePolyrhythm(nowMs); } catch (_) {}
    updateMicAnalysis(nowMs);
    if (state.phase === 'running') updateMisses(nowMs);

    // Beat-aligned / phase-aligned redraw triggers (esp. low BPM)
    if (state.execBeatIndex !== prevExecBeatIndex) markDirty();
    if (state.countExec !== prevCountExec) markDirty();
    if (state.phase !== prevPhase) markDirty();

    // === Rendering (only when needed) ===
    const useRAF = shouldUseRAFForRender();

    const screenIsGame = (ui && ui.screen === 'game');

    if (screenIsGame && (needsRedraw || useRAF)) {
      renderCountdownOverlay(nowMs);

      if (viewDisplay.checked) drawDisplay(nowMs);
      if (viewSpotlight.checked) drawSpotlight(nowMs);
      if (viewNotation.checked) drawNotation();
      if (viewStats.checked) renderStats(nowMs);
      needsRedraw = false;
    } else if (!screenIsGame && needsRedraw) {
      // Game screen is hidden; avoid zero-size canvas layout work until shown.
      needsRedraw = false;
    }

    inLoopTick = false;

    // === Scheduler (choose ONE mechanism per tick) ===
    if (useRAF) {
      lastTickWasRAF = true;
      loopTimer = null;
      loopRAF = window.requestAnimationFrame(loop);
    } else {
      lastTickWasRAF = false;
      loopRAF = null;
      loopTimer = window.setTimeout(loop, getMaintenanceIntervalMs());
    }
  }

  // === Inputs ===

  // v10_p07_global_default_ring_keys: global default bell ring keys.
  // 1-0 => bells 1-10 (0 is 10), E => 11, T => 12.
  // Applied only as a fallback when the configured keybinding system does not handle the key.
  function globalDefaultRingBellForKey(k) {
    const kk = String(k || '');
    if (kk.length !== 1) return null;
    if (kk >= '1' && kk <= '9') return parseInt(kk, 10);
    if (kk === '0') return 10;
    if (kk === 'E') return 11;
    if (kk === 'T') return 12;
    return null;
  }

  document.addEventListener('keydown', (e) => {
    const t = e && e.target;
    const tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    const a = document.activeElement;
    const atag = a && a.tagName;
    if (a && a !== t && (atag === 'INPUT' || atag === 'SELECT' || atag === 'TEXTAREA' || a.isContentEditable)) return;

    // v015_p03a_load_hotfix_glyphs_typing_ui: avoid global shortcuts while Export settings modal is open (typing safety).
    if (rgExportSettingsModal && !rgExportSettingsModal.classList.contains('hidden')) return;

    // v013_p01c_setup_glyph_color_bindings: glyph picker overlay intercepts keys.
    if (state.glyphPickerBell != null) {
      if (e && e.key === 'Escape') {
        e.preventDefault();
        closeGlyphPicker();
      }
      return;
    }

    // v013_p01a_glyph_binding_allow_modifiers_and_paste:
    // Glyph binding capture uses a hidden text input (see ensureGlyphCaptureInput()) so Shift/Alt and paste work.
    if (state.glyphCaptureBell != null) {
      if (e && e.key === 'Escape') {
        applyGlyphCaptureText('');
        return;
      }
      focusGlyphCaptureInput();
      return;
    }


    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const k = normalizeBindKey(e.key);

    // Capture mode: bind the next key pressed to the chosen bell.
    if (state.keybindCaptureBell != null) {
      e.preventDefault();
      if (k === 'Escape') {
        state.keybindCaptureBell = null;
        rebuildKeybindPanel();
        return;
      }
      if (!isAllowedBindKey(k)) return;

      for (const b of state.liveBells) {
        if (b === state.keybindCaptureBell) continue;
        if (state.keyBindings[b] === k) {
          alert('That key is already bound to bell ' + b + '. Choose a different key.');
          return;
        }
      }

      state.keyBindings[state.keybindCaptureBell] = k;
      saveKeyBindings();
      state.keybindCaptureBell = null;
      rebuildKeybindPanel();
      return;
    }

    // v08_p06_sound_testpad_tap_to_ring: Sound screen keyboard test pad (no scoring)
    if (ui && ui.screen === 'sound') {
      let found = null;
      let hits = 0;
      const stage = clamp(parseInt(state.stage, 10) || 0, 1, 12);
      for (let b = 1; b <= stage; b++) {
        if (state.keyBindings && state.keyBindings[b] === k) {
          hits += 1;
          if (hits === 1) found = b;
          else { found = null; break; }
        }
      }
      // Preserve existing conflict behavior (ignore if ambiguous).
      if (hits > 1) return;
      if (found != null) {
        if (k === 'Space') e.preventDefault();
        ringBellTestPad(found);
        return;
      }

      // v10_p07_global_default_ring_keys: fallback default bell keys (Sound screen: audio-only).
      const defBell = globalDefaultRingBellForKey(k);
      if (defBell != null && defBell <= stage) ringBellTestPad(defBell);
      return;
    }

    // v013_p05_any_keybinding_capture_option_a: consume the first usable input during any open ANY window.
    if (tryCaptureAnyInput(perfNow(), 'kbd', e, k)) {
      if (k === 'Space') e.preventDefault();
      return;
    }

    // Default extra keys: if exactly one live bell is selected, Space and Enter also ring it.
    if (state.liveBells.length === 1 && (k === 'Space' || k === 'Enter')) {
      e.preventDefault();
      // v015_p04_stats_export_import_and_compare: input fidelity (keyboard)
      markRunInputUsed('keyboard');
      ringBell(state.liveBells[0]);
      return;
    }

    // Keybinding match for live bells (ignore conflicts).
    let found = null;
    let hits = 0;
    for (const b of state.liveBells) {
      if (state.keyBindings[b] === k) {
        hits += 1;
        if (hits === 1) found = b;
        else { found = null; break; }
      }
    }
    // If the user's bindings are ambiguous, don't fall back to defaults.
    if (hits > 1) return;
    if (found != null) {
      if (k === 'Space') e.preventDefault();
      // v015_p04_stats_export_import_and_compare: input fidelity (keyboard)
      markRunInputUsed('keyboard');
      ringBell(found);
      return;
    }

    // v10_p07_global_default_ring_keys: global fallback mapping (does not override custom bindings).
    const defBell = globalDefaultRingBellForKey(k);
    if (defBell != null) {
      const stage = clamp(parseInt(state.stage, 10) || 0, 1, 12);
      if (defBell <= stage) { markRunInputUsed('keyboard'); ringBell(defBell); }
      return;
    }
  });

  // Display tap: ring the tapped bell (standard touch control).
  displayCanvas.addEventListener('pointerdown', (e) => {
    const bell = displayHitTest(e.clientX, e.clientY);
    if (bell != null) { e.preventDefault(); if (tryCaptureAnyInput(perfNow(), 'tap', e, null)) return; markRunInputUsed('tap'); ringBell(bell); }
  });

  // v06_p13_notation_touch_polish: tap + drag-across-to-ring on notation (both pages)
  function endNotationDrag(evt) {
    if (!ui.notationDragActive) return;
    if (evt && ui.notationDragPointerId != null && evt.pointerId !== ui.notationDragPointerId) return;
    const pid = ui.notationDragPointerId;
    ui.notationDragActive = false;
    ui.notationDragPointerId = null;
    ui.notationDragLastKey = null;
    if (pid != null) {
      try { notationCanvas.releasePointerCapture(pid); } catch (_) {}
    }
  }

  notationCanvas.addEventListener('pointerdown', (e) => {
    const hit = hitTestNotation(e, null);
    if (!hit) return;

    // If another pointer is already dragging, ignore additional touches.
    if (ui.notationDragActive && ui.notationDragPointerId != null && e.pointerId !== ui.notationDragPointerId) return;

    ui.notationDragActive = true;
    ui.notationDragPointerId = e.pointerId;
    ui.notationDragLastKey = hit.rowIndex + ':' + hit.bell;
    try { notationCanvas.setPointerCapture(e.pointerId); } catch (_) {}

    // Optional library hook: remember last tapped row.
    ui.notationCursorRow = hit.rowIndex;

    // Minimal visual feedback: flash the tapped cell.
    ui.notationTapFlash = { rowIndex: hit.rowIndex, bell: hit.bell, untilMs: perfNow() + 150 };

    // Ring audibly (and score via the existing input path when applicable).
    if (!tryCaptureAnyInput(perfNow(), 'tap', e, null)) { markRunInputUsed('tap'); ringBell(hit.bell); }

    // Prevent tap highlight / selection only while actively tracking a notation gesture.
    e.preventDefault();
  });

  notationCanvas.addEventListener('pointermove', (e) => {
    if (!ui.notationDragActive) return;
    if (ui.notationDragPointerId != null && e.pointerId !== ui.notationDragPointerId) return;

    const hit = hitTestNotation(e, null);
    if (!hit) {
      // Keep the last key so jitter off-grid doesn't cause repeat rings on re-entry.
      e.preventDefault();
      return;
    }

    const key = hit.rowIndex + ':' + hit.bell;
    if (key === ui.notationDragLastKey) {
      e.preventDefault();
      return;
    }
    ui.notationDragLastKey = key;

    ui.notationCursorRow = hit.rowIndex;
    ui.notationTapFlash = { rowIndex: hit.rowIndex, bell: hit.bell, untilMs: perfNow() + 150 };
    if (!tryCaptureAnyInput(perfNow(), 'tap', e, null)) { markRunInputUsed('tap'); ringBell(hit.bell); }

    e.preventDefault();
  });

  notationCanvas.addEventListener('pointerup', endNotationDrag);
  notationCanvas.addEventListener('pointercancel', endNotationDrag);

  // Safety net: if capture fails, still end the gesture when the pointer finishes elsewhere.
  window.addEventListener('pointerup', endNotationDrag);
  window.addEventListener('pointercancel', endNotationDrag);

  // v06_p17_spotlight_tap_drag_to_ring: hit-test Spotlight rows (N/N+1/N+2)
  function hitTestSpotlight(evt) {
    const rect = spotlightCanvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const stage = state.stage;
    if (!stage || stage < 1) return null;
    if (!state.rows || !state.rows.length) return null;

    const totalBeats = state.rows.length * stage;
    const strikeIdx = clamp(state.execBeatIndex - 1, 0, Math.max(0, totalBeats - 1));
    const rowIdx = Math.floor(strikeIdx / stage);

    // Default Spotlight: two stacked row blocks (N and N+1).
    if (!state.spotlightSwapsView) {
      const padX = 14, padY = 12, gapY = 10;
      const rowBlockH = (rect.height - padY * 2 - gapY) / 2;
      if (rowBlockH <= 0) return null;

      if (x < padX || x > rect.width - padX) return null;
      const cellW = (rect.width - padX * 2) / stage;
      if (cellW <= 0) return null;
      const idx = clamp(Math.floor((x - padX) / cellW), 0, stage - 1);

      const topY = padY;
      const botY = padY + rowBlockH + gapY;

      const inTop = (y >= topY && y <= topY + rowBlockH);
      const inBot = (y >= botY && y <= botY + rowBlockH);
      if (!inTop && !inBot) return null;

      const row = inTop
        ? (state.rows[rowIdx] || state.rows[0])
        : (state.rows[Math.min(rowIdx + 1, state.rows.length - 1)] || state.rows[rowIdx] || state.rows[0]);

      const bell = row ? row[idx] : null;
      if (bell == null) return null;
      return { bell, rowKind: inTop ? 'N' : 'N1' };
    }

    // Swaps view: stacked rows with optional swap diagrams in between.
    const rows = state.rows;
    const padX = 14, padY = 12;
    const gapY = 8;
    const diagramH = 18;

    const show0 = !!state.spotlightShowN;
    const show1 = !!state.spotlightShowN1 && (rowIdx + 1 < rows.length);
    const show2 = !!state.spotlightShowN2 && (rowIdx + 2 < rows.length);

    const row0 = rows[rowIdx] || rows[0];
    const row1 = show1 ? rows[rowIdx + 1] : null;
    const row2 = show2 ? rows[rowIdx + 2] : null;

    const items = [];
    if (show0) items.push({ type: 'row', row: row0, offset: 0 });
    if (show0 && show1) items.push({ type: 'diagram' });
    if (show1) items.push({ type: 'row', row: row1, offset: 1 });
    if (show1 && show2) items.push({ type: 'diagram' });
    if (show2) items.push({ type: 'row', row: row2, offset: 2 });

    const rowCount = items.reduce((n, it) => n + (it.type === 'row' ? 1 : 0), 0);
    if (!rowCount) return null;

    const diagramCount = items.length - rowCount;
    const availH = rect.height - padY * 2;
    const gapsH = Math.max(0, (items.length - 1) * gapY);
    let rowBlockH = (availH - diagramCount * diagramH - gapsH) / rowCount;
    if (!isFinite(rowBlockH) || rowBlockH <= 0) rowBlockH = Math.max(34, (availH - diagramCount * diagramH) / rowCount);

    if (x < padX || x > rect.width - padX) return null;
    const cellW = (rect.width - padX * 2) / stage;
    if (cellW <= 0) return null;
    const idx = clamp(Math.floor((x - padX) / cellW), 0, stage - 1);

    let yy = padY;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.type === 'row') {
        if (y >= yy && y <= yy + rowBlockH) {
          const bell = it.row ? it.row[idx] : null;
          if (bell == null) return null;
          const rowKind = (it.offset === 0) ? 'N' : ((it.offset === 1) ? 'N1' : 'N2');
          return { bell, rowKind };
        }
        yy += rowBlockH;
      } else {
        yy += diagramH;
      }
      if (k < items.length - 1) yy += gapY;
    }
    return null;
  }

  function endSpotlightDrag(evt) {
    if (!ui.spotlightDragActive) return;
    if (evt && ui.spotlightDragPointerId != null && evt.pointerId !== ui.spotlightDragPointerId) return;
    const pid = ui.spotlightDragPointerId;
    ui.spotlightDragActive = false;
    ui.spotlightDragPointerId = null;
    ui.spotlightDragLastKey = null;
    if (pid != null) {
      try { spotlightCanvas.releasePointerCapture(pid); } catch (_) {}
    }
  }

  spotlightCanvas.addEventListener('pointerdown', (e) => {
    const hit = hitTestSpotlight(e);
    if (!hit) return;

    // If another pointer is already dragging, ignore additional touches.
    if (ui.spotlightDragActive && ui.spotlightDragPointerId != null && e.pointerId !== ui.spotlightDragPointerId) return;

    ui.spotlightDragActive = true;
    ui.spotlightDragPointerId = e.pointerId;
    ui.spotlightDragLastKey = hit.rowKind + ':' + hit.bell;
    try { spotlightCanvas.setPointerCapture(e.pointerId); } catch (_) {}

    ui.spotlightTapFlash = { rowKind: hit.rowKind, bell: hit.bell, untilMs: perfNow() + 150 };

    // Ring audibly (and score via the existing input path when applicable).
    if (!tryCaptureAnyInput(perfNow(), 'tap', e, null)) { markRunInputUsed('tap'); ringBell(hit.bell); }

    // Ensure the flash is rendered promptly under the existing perf loop.
    markDirty();

    // Prevent tap highlight / selection only while actively tracking a Spotlight gesture.
    e.preventDefault();
  });

  spotlightCanvas.addEventListener('pointermove', (e) => {
    if (!ui.spotlightDragActive) return;
    if (ui.spotlightDragPointerId != null && e.pointerId !== ui.spotlightDragPointerId) return;

    const hit = hitTestSpotlight(e);
    if (!hit) {
      // Keep the last key so jitter off-grid doesn't cause repeat rings on re-entry.
      e.preventDefault();
      return;
    }

    const key = hit.rowKind + ':' + hit.bell;
    if (key === ui.spotlightDragLastKey) {
      e.preventDefault();
      return;
    }
    ui.spotlightDragLastKey = key;

    ui.spotlightTapFlash = { rowKind: hit.rowKind, bell: hit.bell, untilMs: perfNow() + 150 };
    if (!tryCaptureAnyInput(perfNow(), 'tap', e, null)) { markRunInputUsed('tap'); ringBell(hit.bell); }
    markDirty();

    e.preventDefault();
  });

  spotlightCanvas.addEventListener('pointerup', endSpotlightDrag);
  spotlightCanvas.addEventListener('pointercancel', endSpotlightDrag);

  // Safety net: if capture fails, still end the gesture when the pointer finishes elsewhere.
  window.addEventListener('pointerup', endSpotlightDrag);
  window.addEventListener('pointercancel', endSpotlightDrag);

  // Prompt 6: Play settings changes restart (stop current run first).
  function ensureIdleForPlayChange() {
    if (state.phase === 'idle') return;
    if (state.phase === 'paused') {
      cancelScheduledBellAudioNow();
      state.schedBeatIndex = state.execBeatIndex;
      state.countSched = state.countExec;
    }
    stopPressed('play_change');
  }




  // v018_p07_restore_defaults_buttons: category-scoped restore to factory defaults (no stats history / saved runs wipe)
  function restoreSetupDefaults() {
    // Setup changes can invalidate the active run; follow the same stop-first behavior as normal Setup edits.
    try { ensureIdleForPlayChange(); } catch (_) {}

    // Clear any capture UI states (best-effort).
    try { state.keybindCaptureBell = null; } catch (_) {}
    try { state.glyphCaptureBell = null; } catch (_) {}
    try { state.glyphPickerBell = null; } catch (_) {}

    // Method / bells / tempo via existing UI handlers when possible.
    try {
      if (methodSelect) {
        methodSelect.value = 'plainhunt';
        methodSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
    try {
      if (bellCountSelect) {
        bellCountSelect.value = '6';
        bellCountSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
    try {
      if (liveCountSelect) {
        liveCountSelect.value = '1';
        liveCountSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}
    try {
      if (bpmInput) {
        bpmInput.value = '120';
        bpmInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (_) {}

    // Keybindings: reset and persist.
    try {
      safeDelLS(LS_KEYBINDS);
      try { resetKeyBindingsToDefaults(); } catch (_) {
        // Fallback if defaults helper is unavailable.
        state.keyBindings = {};
        for (let b = 1; b <= 12; b++) state.keyBindings[b] = defaultBindKeyForBell(b);
        saveKeyBindings();
      }
      // Factory pristine convenience (v10_p01): Space -> bell 1, Enter -> bell 2.
      state.keyBindings[1] = 'Space';
      state.keyBindings[2] = 'Enter';
      saveKeyBindings();
      try { rebuildKeybindPanel(); } catch (_) {}
    } catch (_) {}

    // Glyph bindings + style: reset and persist by clearing localStorage.
    try { safeDelLS(LS_GLYPHBINDS); } catch (_) {}
    try { safeDelLS(LS_GLYPHSTYLE); } catch (_) {}
    try { loadGlyphBindings(); } catch (_) {}
    try { loadGlyphStyle(); } catch (_) {}
    try { rebuildKeybindPanel(); } catch (_) {}

    // Mic prefs: reset to defaults without breaking UI; stop capture if active.
    try { setMicEnabled(false); } catch (_) {}
    try {
      safeDelLS(LS_MIC_ENABLED);
      safeDelLS(LS_MIC_THRESHOLD);
      try { safeDelLS(OLD_LS_MIC_THRESHOLD_DB); } catch (_) {}
      safeDelLS(LS_MIC_COOLDOWN_MS);
      safeDelLS(LS_MIC_BELLS);
    } catch (_) {}
    try { loadMicPrefs(); } catch (_) {}

    markDirty();
    kickLoop();
  }

  function restoreViewDefaults() {
    // Layout + notation layout (persisted).
    try { safeDelLS(LS_LAYOUT_PRESET); } catch (_) {}
    try { safeDelLS(LS_NOTATION_LAYOUT); } catch (_) {}

    // Spotlight + overlay toggles (persisted).
    try { safeDelLS(LS_SPOTLIGHT_SWAPS_VIEW); } catch (_) {}
    try { safeDelLS(LS_SPOTLIGHT_SHOW_N); } catch (_) {}
    try { safeDelLS(LS_SPOTLIGHT_SHOW_N1); } catch (_) {}
    try { safeDelLS(LS_SPOTLIGHT_SHOW_N2); } catch (_) {}
    try { safeDelLS(LS_NOTATION_SWAPS_OVERLAY); } catch (_) {}

    // "Display scored bell(s) only" (persisted; special default when missing).
    try { safeDelLS(LS_DISPLAY_LIVE_BELLS_ONLY); } catch (_) {}

    // Accuracy dots (persisted; pristine default keeps Spotlight dots OFF, so persist that explicitly).
    try { safeDelLS(LS_ACCURACY_DOTS); } catch (_) {}

    // Reset state to factory defaults.
    state.spotlightSwapsView = true;
    state.spotlightShowN = true;
    state.spotlightShowN1 = true;
    state.spotlightShowN2 = true;
    state.notationSwapsOverlay = true;
    state.displayLiveBellsOnly = true;

    state.accuracyDotsEnabled = true;
    state.accuracyDotsDisplay = true;
    state.accuracyDotsNotation = true;
    state.accuracyDotsSpotlight = false;
    try { saveAccuracyDotsPrefs(); } catch (_) {}

    // Sync UI checkboxes best-effort.
    try { if (spotlightSwapsView) spotlightSwapsView.checked = true; } catch (_) {}
    try { if (spotlightShowN) spotlightShowN.checked = true; } catch (_) {}
    try { if (spotlightShowN1) spotlightShowN1.checked = true; } catch (_) {}
    try { if (spotlightShowN2) spotlightShowN2.checked = true; } catch (_) {}
    try { if (notationSwapsOverlay) notationSwapsOverlay.checked = true; } catch (_) {}
    try { if (displayLiveOnly) displayLiveOnly.checked = true; } catch (_) {}

    try { syncLayoutPresetUI(); } catch (_) {}
    try { syncNotationLayoutUI(); } catch (_) {}
    try { syncSpotlightSwapRowTogglesUI(); } catch (_) {}
    try { syncAccuracyDotsUI(); } catch (_) {}

    markDirty();
    kickLoop();
  }

  function restoreSoundDefaults() {
    // Safe during an active run: stop/cancel non-base audio only (poly test + drone), leave scoring unchanged.
    try { stopPolyrhythmTest(); } catch (_) {}
    try { cancelScheduledPolyAudioNow(); } catch (_) {}
    try { stopDrone(); } catch (_) {}

    // Clear persisted Sound prefs.
    try {
      safeDelLS(LS_BELL_HZ_OVERRIDE);
      safeDelLS(LS_BELL_VOL_OVERRIDE);
      safeDelLS(LS_BELL_KEY_OVERRIDE);
      safeDelLS(LS_BELL_OCT_OVERRIDE);
      safeDelLS(LS_BELL_TIMBRE_OVERRIDES);
      safeDelLS(LS_BELL_CHORD_OVERRIDES);
      safeDelLS(LS_BELL_TIMBRE_GLOBAL);
      safeDelLS(LS_BELL_PAN);
      safeDelLS(LS_BELL_DEPTH);
      safeDelLS(LS_SPATIAL_DEPTH_MODE);
      safeDelLS(LS_GLOBAL_CHORD);
      safeDelLS(LS_MASTER_FX);
      safeDelLS(LS_DRONE_ON);
      safeDelLS(LS_DRONE_OCTAVE_C);
      safeDelLS(LS_DRONE_VARIANTS);
      safeDelLS(LS_DRONE_LAYERS);
      safeDelLS(LS_POLYRHYTHM);
      // Legacy drone inference keys (boot migration). Clear so "Off" is truly default.
      safeDelLS('rg_drone_type_v1');
      safeDelLS('rg_drone_type');
    } catch (_) {}

    // Pitch + bell master defaults.
    try {
      state.scaleKey = 'Fs_major';
      state.octaveC = 4;
      state.bellCustomHz = 440;
      state.bellPitchFamily = 'diatonic';
      state.bellPitchSpan = 'compact';
      state.bellPitchSpanUser = false;
      state.bellPitchPentVariant = 'major_pent';
      state.bellPitchChromaticDirection = 'descending';
      state.bellPitchFifthsType = 'fifths';
      state.bellPitchFifthsShape = 'folded';
      state.bellPitchPartialsShape = 'ladder';
      state.bellVolume = 100;

      // Global bell timbre defaults.
      state.bellRingLength = 0.5;
      state.bellBrightness = 0.5;
      state.bellStrikeHardness = 0.0;
      try { saveBellTimbreToLS(); } catch (_) {}

      // Spatial defaults.
      state.spatialDepthMode = 'normal';
      state.bellPan = new Array(13).fill(0);
      state.bellDepth = new Array(13).fill(0);
    } catch (_) {}

    // Per-bell overrides defaults (hz/vol/key/oct + chord + timbre).
    try { resetAllBellOverrides(); } catch (_) {}

    // Global chords defaults.
    try {
      state.globalChord = sanitizeGlobalChordConfig(globalChordDefaults());
      try { saveGlobalChordToLS(); } catch (_) {}
      try { syncGlobalChordControlsUI(); } catch (_) {}
    } catch (_) {}

    // Master FX defaults (also persists via load->save when missing).
    try { loadMasterFxFromLS(); } catch (_) {}
    try { syncMasterFxUI(); } catch (_) {}

    // Drone defaults.
    try {
      state.droneOn = false;
      state.droneType = 'single';
      state.droneScaleKey = 'Fs_major';
      state.droneOctaveC = 3;
      state.droneCustomHz = 440;
      state.droneVolume = 50;
      state.dronePaused = false;

      state.droneNormalize = true;
      state.droneDensity = 3;
      state.droneDensityByType = {};
      state.droneDriftCents = 0;
      state.droneMotionRate = 0;
      state.droneClusterWidth = 3;
      state.droneNoiseTilt = 0;
      state.droneNoiseQ = 1;

      state.droneOwner = 'run';
      state.dronesEnabled = false;
      state.dronesPaused = false;
      state.dronesMasterVolume = 50;
      state.droneLayers = null;

      loadDroneVariantsFromLS();
      if (!loadDroneLayersFromLS()) {
        ensureDroneLayersState();
        saveDroneLayersToLS();
      }

      syncDroneOnOffUI();
      syncDroneVariantsUI();
      rebuildDroneLayersUI();
      syncDronePauseBtnUI();
    } catch (_) {}

    // Polyrhythm defaults.
    try {
      state.polyEnabledForRuns = false;
      state.polyMasterVolume = 80;
      state.polyLayers = [];
      try { savePolyrhythmToLS(); } catch (_) {}
      try { rebuildPolyrhythmUI(); } catch (_) {}
      try { syncPolyrhythmUI(); } catch (_) {}
    } catch (_) {}

    // Update key UI controls + audio engine (best-effort).
    try { if (scaleSelect) scaleSelect.value = state.scaleKey; } catch (_) {}
    try { if (octaveSelect) octaveSelect.value = String(state.octaveC); } catch (_) {}
    try { syncBellCustomHzUI(); } catch (_) {}
    try { if (bellVolume) bellVolume.value = String(state.bellVolume); } catch (_) {}
    try { syncBellTimbreUI(); } catch (_) {}
    try { syncBellPitchFamilyUI(); } catch (_) {}
    try { syncBellPitchSummaryUI(); } catch (_) {}
    try { syncSpatialDepthModeUI(); } catch (_) {}

    try { applyBellMasterGain(); } catch (_) {}
    try { rebuildBellFrequencies(); } catch (_) {}
    try { onBellTuningChanged(); } catch (_) {}

    try { rebuildSoundTestInstrumentRow(); } catch (_) {}
    try { rebuildSoundQuickBellRow(); } catch (_) {}

    markDirty();
    kickLoop();
  }

  if (restoreSetupDefaultsBtn) restoreSetupDefaultsBtn.addEventListener('click', () => {
    markUserTouchedConfig();
    restoreSetupDefaults();
  });

  methodSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    const v = methodSelect.value;

    // Dynamic display-only options should never be treated as a selection action.
    if (v === '__from_library' || v === '__from_file') {
      syncGameHeaderMeta();
      return;
    }

    state.method = v;

    if (v !== 'custom') {
      state.customRows = null;
      state.methodSource = 'built_in';
      state.methodMeta = null;
    } else {
      // Selecting "Custom" from the dropdown is not a library claim.
      // Preserve existing attribution/file metadata when already in that mode.
      if (state.methodSource !== 'library' && state.methodSource !== 'custom_rows') {
        state.methodSource = 'custom_rows';
        state.methodMeta = null;
      }
    }

    computeRows(); resetStats();
    syncGameHeaderMeta();
  });

  bellCountSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    state.stage = clamp(parseInt(bellCountSelect.value,10)||6, 4, 12);
    if (state.method === 'custom') { state.method = 'plainhunt'; methodSelect.value='plainhunt'; state.customRows=null; state.methodSource='built_in'; state.methodMeta=null; }
    rebuildLiveCountOptions(); ensureLiveBells(); rebuildBellPicker();
    ensurePathBells(); rebuildPathPicker(); computeRows(); resetStats(); maybeApplyDefaultBellPitchSpanForStage(state.stage); rebuildBellFrequencies(); rebuildBellOverridesUI();
    syncGameHeaderMeta();
    renderScoringExplanation();
  });

  liveCountSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    state.liveCount = clamp(parseInt(liveCountSelect.value,10)||1, 1, state.stage);
    ensureLiveBells(); rebuildBellPicker(); resetStats();
  });

  // v012_p04_setup_tempo_slider_tap: slider + tap tempo UI (Setup → Tempo block).
  function syncBpmSliderFromInput() {
    if (!bpmSlider || !bpmInput) return;
    const v = parseInt(bpmInput.value, 10);
    if (!Number.isFinite(v)) return;
    const min = parseInt(bpmSlider.min, 10) || 1;
    const max = parseInt(bpmSlider.max, 10) || 240;
    bpmSlider.value = String(clamp(v, min, max));
  }

  bpmInput.addEventListener('input', () => {
    syncBpmSliderFromInput();
  });

  bpmInput.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    state.bpm = clamp(parseInt(bpmInput.value,10)||80, 1, 240);
    bpmInput.value = String(state.bpm);
    if (bpmSlider) bpmSlider.value = String(state.bpm);
    syncGameHeaderMeta();
  });

  if (bpmSlider) {
    bpmSlider.addEventListener('input', () => {
      if (bpmInput) bpmInput.value = String(bpmSlider.value);
      // Trigger the same stop-first behavior as typing BPM.
      if (bpmInput) bpmInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  if (bpmTapBtn) {
    let tapLast = 0;
    let tapIntervals = [];
    const TAP_RESET_MS = 2500;
    const TAP_MAX_INTERVALS = 6;

    bpmTapBtn.addEventListener('click', () => {
      const now = performance.now();

      // Long pause: restart the sequence.
      if (tapLast && (now - tapLast) > TAP_RESET_MS) {
        tapIntervals = [];
        tapLast = 0;
      }

      if (tapLast) {
        const dt = now - tapLast;
        if (dt > TAP_RESET_MS) {
          tapIntervals = [];
        } else if (dt > 0) {
          tapIntervals.push(dt);
          if (tapIntervals.length > TAP_MAX_INTERVALS) tapIntervals.shift();
        }
      }
      tapLast = now;

      // Need at least a few taps for a stable estimate.
      if (tapIntervals.length < 2) return;

      // Average recent intervals, ignoring outliers.
      const recent = tapIntervals.slice(-TAP_MAX_INTERVALS).filter(x => x > 0 && x <= TAP_RESET_MS);
      if (recent.length < 2) return;

      const sorted = recent.slice().sort((a,b)=>a-b);
      const mid = Math.floor(sorted.length / 2);
      const median = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const tol = median * 0.20; // +/- 20%
      let good = recent.filter(x => Math.abs(x - median) <= tol);
      if (good.length < Math.min(2, recent.length)) good = recent.slice();

      let goodSorted = good.slice().sort((a,b)=>a-b);
      if (goodSorted.length >= 4) goodSorted = goodSorted.slice(1, -1);

      const avg = goodSorted.reduce((s,x)=>s+x,0) / goodSorted.length;
      if (!Number.isFinite(avg) || avg <= 0) return;

      let bpm = Math.round(60000 / avg);
      bpm = clamp(bpm, 1, 240);

      if (bpmInput) bpmInput.value = String(bpm);
      syncBpmSliderFromInput();
      // Trigger the same stop-first behavior as typing BPM.
      if (bpmInput) bpmInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Mic controls
  if (micToggleBtn) {
    micToggleBtn.addEventListener('click', () => {
      if (state.mode === 'demo') { setMicUiStatus('Mic disabled in Demo'); return; }
      markUserTouchedConfig();
      if (state.micEnabled) {
        if (state.micActive) setMicEnabled(false);
        else startMicCapture();
      } else {
        setMicEnabled(true);
        startMicCapture();
      }
    });
  }
  if (micCalibrateBtn) {
    micCalibrateBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      calibrateMicThreshold();
    });
  }
  if (micCooldown) {
    micCooldown.addEventListener('input', () => {
      markUserTouchedConfig();
      state.micCooldownMs = clamp(parseFloat(micCooldown.value), 100, 400);
      safeSetLS(LS_MIC_COOLDOWN_MS, String(state.micCooldownMs));
      syncMicSlidersUI();
    });
  }

  [viewDisplay, viewSpotlight, viewNotation, viewStats, viewMic].forEach(cb => cb.addEventListener('change', () => {
    markUserTouchedConfig();
    syncViewLayout();
  }));

  // v09_p07b_notation_spotlight_accuracy_dots
  [accuracyDotsEnabled, accuracyDotsDisplay, accuracyDotsNotation, accuracyDotsSpotlight].forEach(cb => {
    if (!cb) return;
    cb.addEventListener('change', () => {
      markUserTouchedConfig();
      syncAccuracyDotsPrefsFromUI();
    });
  });

  // Layout preset selector (persisted)
  if (restoreViewDefaultsBtn) restoreViewDefaultsBtn.addEventListener('click', () => {
    markUserTouchedConfig();
    restoreViewDefaults();
  });

  if (layoutPresetSelect) {
    layoutPresetSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      const v = String(layoutPresetSelect.value || 'auto');
      safeSetLS(LS_LAYOUT_PRESET, v);
      applyLayoutPreset(v);
    });
  }

  // v06_p15_notation_single_page_mode: notation layout selector (persisted)
  if (notationLayoutSelect) {
    notationLayoutSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      let v = String(notationLayoutSelect.value || 'two_page');
      if (!(v === 'two_page' || v === 'one_page')) v = isMobileLikely() ? 'one_page' : 'two_page';
      safeSetLS(LS_NOTATION_LAYOUT, v);
      ui.notationLayout = v;
      syncNotationPagingUI();
      markDirty();
      kickLoop();
    });
  }

  // Auto preset responsiveness: re-evaluate on resize (throttled)
  {
    let layoutAutoResizeQueued = false;
    window.addEventListener('resize', () => {
      if (!layoutPresetSelect || layoutPresetSelect.value !== 'auto') return;
      if (layoutAutoResizeQueued) return;
      layoutAutoResizeQueued = true;
      window.requestAnimationFrame(() => {
        layoutAutoResizeQueued = false;
        if (layoutPresetSelect && layoutPresetSelect.value === 'auto') applyLayoutPreset('auto');
      });
    });
  }

  // Display live bells only toggle (persisted)
  if (displayLiveOnly) {
    displayLiveOnly.addEventListener('change', () => {
      markUserTouchedConfig();
      state.displayLiveBellsOnly = !!displayLiveOnly.checked;
      safeSetBoolLS(LS_DISPLAY_LIVE_BELLS_ONLY, state.displayLiveBellsOnly);
      syncViewMenuSelectedUI();
    });
  }

  // Spotlight swaps view + row controls
  if (spotlightSwapsView) {
    spotlightSwapsView.addEventListener('change', () => {
      markUserTouchedConfig();
      state.spotlightSwapsView = spotlightSwapsView.checked;
      safeSetBoolLS(LS_SPOTLIGHT_SWAPS_VIEW, state.spotlightSwapsView);
      syncSpotlightSwapRowTogglesUI();
    });
  }

  function syncSpotlightRowPrefsFromUI() {
    if (spotlightShowN) state.spotlightShowN = !!spotlightShowN.checked;
    if (spotlightShowN1) state.spotlightShowN1 = !!spotlightShowN1.checked;
    if (spotlightShowN2) state.spotlightShowN2 = !!spotlightShowN2.checked;

    if (!state.spotlightShowN && !state.spotlightShowN1 && !state.spotlightShowN2) {
      state.spotlightShowN = true;
      if (spotlightShowN) spotlightShowN.checked = true;
    }

    safeSetBoolLS(LS_SPOTLIGHT_SHOW_N, state.spotlightShowN);
    safeSetBoolLS(LS_SPOTLIGHT_SHOW_N1, state.spotlightShowN1);
    safeSetBoolLS(LS_SPOTLIGHT_SHOW_N2, state.spotlightShowN2);
    syncViewMenuSelectedUI();
    markDirty();
  }

  if (spotlightShowN) spotlightShowN.addEventListener('change', () => { markUserTouchedConfig(); syncSpotlightRowPrefsFromUI(); });
  if (spotlightShowN1) spotlightShowN1.addEventListener('change', () => { markUserTouchedConfig(); syncSpotlightRowPrefsFromUI(); });
  if (spotlightShowN2) spotlightShowN2.addEventListener('change', () => { markUserTouchedConfig(); syncSpotlightRowPrefsFromUI(); });

  // Notation swaps overlay
  if (notationSwapsOverlay) {
    notationSwapsOverlay.addEventListener('change', () => {
      markUserTouchedConfig();
      state.notationSwapsOverlay = notationSwapsOverlay.checked;
      safeSetBoolLS(LS_NOTATION_SWAPS_OVERLAY, state.notationSwapsOverlay);
      syncViewMenuSelectedUI();
      markDirty();
    });
  }


  pathNoneBtn.addEventListener('click', () => { markUserTouchedConfig(); setPathNone(); });
  pathAllBtn.addEventListener('click', () => { markUserTouchedConfig(); setPathAll(); });

  // Prompt 6: Sound changes apply without restart; reschedule auto-bells quickly if active.
  function onBellTuningChanged() {
    if (state.phase === 'running' || state.phase === 'countdown' || state.phase === 'paused') {
      cancelScheduledBellAudioNow();
      state.schedBeatIndex = state.execBeatIndex;
      state.countSched = state.countExec;
    }
    markDirty();
    kickLoop();
  }

  // v08_p05_sound_per_bell_overrides: per-bell editor wiring
  if (bellOverridesResetBtn) {
    bellOverridesResetBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      resetAllBellOverrides();
      onBellTuningChanged();
    });
  }

  if (bellOverridesList) {

    // v10_p06_sound_per_bell_piano_keypicker: tap/drag piano keys to preview + assign
    const bellPianoPicker = {
      active: false,
      pointerId: null,
      pianoEl: null,
      bell: 0,
      lastNote: null,
      activeEl: null,
      ignoreClickUntilMs: 0
    };

    function bellPianoPickerSetActive(el) {
      const prev = bellPianoPicker.activeEl;
      if (prev && prev !== el) {
        try { prev.classList.remove('is-active'); } catch (_) {}
      }
      bellPianoPicker.activeEl = el || null;
      if (el) {
        try { el.classList.add('is-active'); } catch (_) {}
      }
    }

    function bellPianoPickerReset() {
      bellPianoPicker.active = false;
      bellPianoPicker.pointerId = null;
      bellPianoPicker.pianoEl = null;
      bellPianoPicker.bell = 0;
      bellPianoPicker.lastNote = null;
      bellPianoPickerSetActive(null);
    }

    function bellPianoHitTest(e, pianoEl) {
      const piano = pianoEl || bellPianoPicker.pianoEl;
      if (!piano) return null;
      const x = (e && typeof e.clientX === 'number') ? e.clientX : 0;
      const y = (e && typeof e.clientY === 'number') ? e.clientY : 0;
      const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
      const key = (el && el.closest) ? el.closest('.rg-piano-key[data-note]') : null;
      if (!key || !piano.contains(key)) return null;
      const note = key.dataset && key.dataset.note ? String(key.dataset.note) : '';
      if (!note) return null;
      return { note, el: key, piano };
    }

    function applyBellPianoKey(bell, note) {
      const b = clamp(parseInt(bell, 10) || 0, 1, 12);
      if (b < 1 || b > state.stage) return;
      const n = String(note || '').trim();
      if (!n) return;
      ensureBellOverridesArrays();

      // Stop any continuous Hz-slider preview so strikes don't overlap.
      cancelHzSliderPreviewGesture();
      stopHzPreviewTone();

      // Keep the bell's existing major/minor mode (or fall back to global).
      const baseKey = effectiveBellScaleKeyForPiano(b);
      const mode = scaleModeFromScaleKey(baseKey);
      const key = scaleKeyFromPianoNote(n, mode);
      if (!key) return;

      markUserTouchedConfig();
      state.bellKeyOverride[b] = key;
      saveBellKeyOverridesToLS();

      const oct = effectiveBellOctaveForPiano(b);
      const hz = getBellFrequencyFromKeyOct(b, key, oct);
      playBellStrikePreviewAtHz(b, hz, perfNow());

      syncBellOverridesEffectiveUI();
      onBellTuningChanged();
    }

    bellOverridesList.addEventListener('input', (e) => {
      const el = e && e.target ? e.target : null;
      if (!el || !el.id) return;
      ensureBellOverridesArrays();

      if (el.id.startsWith('bellHzOverride_')) {
        const b = parseInt(el.id.slice('bellHzOverride_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const raw = String(el.value || '').trim();
        if (!raw) state.bellHzOverride[b] = null;
        else {
          const v = parseFloat(raw);
          state.bellHzOverride[b] = Number.isFinite(v) ? clamp(v, 20, 5000) : null;
        }
        const slider = document.getElementById('bellHzSlider_' + b);
        if (slider) slider.value = String(clamp(getBellHz(b), PER_BELL_HZ_SLIDER_MIN, PER_BELL_HZ_SLIDER_MAX));
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellHzSlider_')) {
        const b = parseInt(el.id.slice('bellHzSlider_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = parseFloat(String(el.value || '').trim());
        state.bellHzOverride[b] = Number.isFinite(v) ? clamp(v, 20, 5000) : null;
        const input = document.getElementById('bellHzOverride_' + b);
        if (input) input.value = (state.bellHzOverride[b] != null) ? String(state.bellHzOverride[b]) : '';
        if (Number.isFinite(v)) updateHzPreviewTone(b, v);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellVolOverride_')) {
        const b = parseInt(el.id.slice('bellVolOverride_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const raw = String(el.value || '').trim();
        if (!raw) state.bellVolOverride[b] = null;
        else {
          const v = parseFloat(raw);
          state.bellVolOverride[b] = Number.isFinite(v) ? clamp(v, 0, 100) : null;
        }
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellPan_')) {
        const b = parseInt(el.id.slice('bellPan_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = parseFloat(String(el.value || '').trim());
        state.bellPan[b] = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
        const ro = document.getElementById('bellPanReadout_' + b);
        if (ro) ro.textContent = fmtPan1(state.bellPan[b]);
        try { applyBellPanToAudio(b); } catch (_) {}
      } else if (el.id.startsWith('bellDepth_')) {
        const b = parseInt(el.id.slice('bellDepth_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = parseFloat(String(el.value || '').trim());
        state.bellDepth[b] = Number.isFinite(v) ? clamp(v, 0, 1) : 0;
        const ro = document.getElementById('bellDepthReadout_' + b);
        if (ro) ro.textContent = fmtDepth2(state.bellDepth[b]);
        try { applyBellDepthToAudio(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreRingLength_')) {
        const b = parseInt(el.id.slice('bellTimbreRingLength_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellTimbreOverridesArray();
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        cfg.bellRingLength = Number.isFinite(v) ? clamp(v, 0, 1) : cfg.bellRingLength;
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        const ro = document.getElementById('bellTimbreRingLengthValue_' + b);
        if (ro) ro.textContent = fmtDepth2(state.bellTimbreOverrides[b].bellRingLength);
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreBrightness_')) {
        const b = parseInt(el.id.slice('bellTimbreBrightness_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellTimbreOverridesArray();
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        cfg.bellBrightness = Number.isFinite(v) ? clamp(v, 0, 1) : cfg.bellBrightness;
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        const ro = document.getElementById('bellTimbreBrightnessValue_' + b);
        if (ro) ro.textContent = fmtDepth2(state.bellTimbreOverrides[b].bellBrightness);
        try { rampActiveBellTimbreBrightness(b); } catch (_) {}
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreHardness_')) {
        const b = parseInt(el.id.slice('bellTimbreHardness_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellTimbreOverridesArray();
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        cfg.bellStrikeHardness = Number.isFinite(v) ? clamp(v, 0, 1) : cfg.bellStrikeHardness;
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        const ro = document.getElementById('bellTimbreHardnessValue_' + b);
        if (ro) ro.textContent = fmtDepth2(state.bellTimbreOverrides[b].bellStrikeHardness);
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellChordStepMs_')) {
        const b = parseInt(el.id.slice('bellChordStepMs_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.splitStepMs = clamp(parseInt(String(el.value || '0'), 10) || 0, 0, 15);
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellChordMaxMs_')) {
        const b = parseInt(el.id.slice('bellChordMaxMs_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.splitMaxMs = clamp(parseInt(String(el.value || '0'), 10) || 0, 0, 18);
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellChordIntervals_')) {
        const b = parseInt(el.id.slice('bellChordIntervals_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customIntervals = String(el.value || '');
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellChordSplitOffsets_')) {
        const b = parseInt(el.id.slice('bellChordSplitOffsets_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customSplitOffsetsMs = String(el.value || '');
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellChordDetune_')) {
        const b = parseInt(el.id.slice('bellChordDetune_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customDetuneCents = String(el.value || '');
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      } else if (el.id.startsWith('bellChordLevels_')) {
        const b = parseInt(el.id.slice('bellChordLevels_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        ensureBellChordOverridesArray();
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customLevelGains = String(el.value || '');
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        syncBellOverridesEffectiveUI();
      }
    });

    bellOverridesList.addEventListener('change', (e) => {
      const el = e && e.target ? e.target : null;
      if (!el || !el.id) return;
      let did = false;

      if (el.id.startsWith('bellHzOverride_')) {
        did = true;
        markUserTouchedConfig();
        saveBellHzOverridesToLS();
      } else if (el.id.startsWith('bellHzSlider_')) {
        did = true;
        markUserTouchedConfig();
        saveBellHzOverridesToLS();
      } else if (el.id.startsWith('bellVolOverride_')) {
        did = true;
        markUserTouchedConfig();
        saveBellVolOverridesToLS();
      } else if (el.id.startsWith('bellPan_')) {
        did = true;
        markUserTouchedConfig();
        saveBellPanToLS();
      } else if (el.id.startsWith('bellDepth_')) {
        did = true;
        markUserTouchedConfig();
        saveBellDepthToLS();
      } else if (el.id.startsWith('bellTimbreMode_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellTimbreOverridesArray();
        const b = parseInt(el.id.slice('bellTimbreMode_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const newMode = (String(el.value || 'inherit') === 'override') ? 'override' : 'inherit';
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());

        if (newMode === 'override') {
          // Seed from current global timbre so enabling override does not change sound.
          if (!cfg._fromLS && cfg.mode !== 'override') {
            cfg.bellRingLength = clamp(Number(state.bellRingLength), 0, 1);
            cfg.bellBrightness = clamp(Number(state.bellBrightness), 0, 1);
            cfg.bellStrikeHardness = clamp(Number(state.bellStrikeHardness), 0, 1);
          }
          cfg.mode = 'override';
          cfg._fromLS = true;
        } else {
          cfg.mode = 'inherit';
        }

        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        saveBellTimbreOverridesToLS();
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
        try { rampActiveBellTimbreBrightness(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreRingLength_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellTimbreOverridesArray();
        const b = parseInt(el.id.slice('bellTimbreRingLength_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        if (Number.isFinite(v)) cfg.bellRingLength = clamp(v, 0, 1);
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        saveBellTimbreOverridesToLS();
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreBrightness_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellTimbreOverridesArray();
        const b = parseInt(el.id.slice('bellTimbreBrightness_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        if (Number.isFinite(v)) cfg.bellBrightness = clamp(v, 0, 1);
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        saveBellTimbreOverridesToLS();
        try { rampActiveBellTimbreBrightness(b); } catch (_) {}
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellTimbreHardness_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellTimbreOverridesArray();
        const b = parseInt(el.id.slice('bellTimbreHardness_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellTimbreOverride(state.bellTimbreOverrides[b] || bellTimbreOverrideDefaults());
        cfg.mode = 'override';
        cfg._fromLS = true;
        const v = parseFloat(String(el.value || '').trim());
        if (Number.isFinite(v)) cfg.bellStrikeHardness = clamp(v, 0, 1);
        state.bellTimbreOverrides[b] = sanitizeBellTimbreOverride(cfg);
        saveBellTimbreOverridesToLS();
        try { syncBellTimbreOverrideRowUI(b); } catch (_) {}
      } else if (el.id.startsWith('bellKeyOverride_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellOverridesArrays();
        const b = parseInt(el.id.slice('bellKeyOverride_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const raw = String(el.value || '').trim();
        if (!raw) state.bellKeyOverride[b] = null;
        else if (raw !== 'custom_hz' && SCALE_LIBRARY.some(s => s.key === raw)) state.bellKeyOverride[b] = raw;
        else state.bellKeyOverride[b] = null;
        saveBellKeyOverridesToLS();
      } else if (el.id.startsWith('bellOctOverride_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellOverridesArrays();
        const b = parseInt(el.id.slice('bellOctOverride_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const raw = String(el.value || '').trim();
        if (!raw) state.bellOctaveOverride[b] = null;
        else {
          const v = parseInt(raw, 10);
          state.bellOctaveOverride[b] = Number.isFinite(v) ? clamp(v, 1, 6) : null;
        }
        saveBellOctOverridesToLS();
      }

      // v10_p09_sound_per_bell_chords_overrides: per-bell chord overrides (persisted)
      else if (el.id.startsWith('bellChordMode_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordMode_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const newMode = (String(el.value || '') === 'override') ? 'override' : 'inherit';
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        if (newMode === 'override' && cfg.mode !== 'override') {
          const g = state.globalChord ? sanitizeGlobalChordConfig(state.globalChord) : globalChordDefaults();
          cfg.mode = 'override';
          cfg.enabled = !!(g && g.enabled);
          cfg.preset = (g && g.preset && GLOBAL_CHORD_PRESETS[g.preset]) ? String(g.preset) : 'unison';
          cfg.inversion = String((g && g.inversion) || 'root');
          cfg.spread = String((g && g.spread) || 'close');
          cfg.splitStrikeMode = 'inherit';
          cfg.splitStepMs = clamp(parseInt(String(g && g.stepMs), 10) || 0, 0, 15);
          cfg.splitMaxMs = clamp(parseInt(String(g && g.maxMs), 10) || 0, 0, 18);
        } else {
          cfg.mode = newMode;
        }
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordEnabled_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordEnabled_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.enabled = !!el.checked;
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordPreset_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordPreset_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = String(el.value || 'unison');
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.preset = GLOBAL_CHORD_PRESETS[v] ? v : 'unison';
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordSplit_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordSplit_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = String(el.value || 'inherit');
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.splitStrikeMode = (v === 'belllike' || v === 'simultaneous') ? v : 'inherit';
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordInversion_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordInversion_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = String(el.value || 'root');
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.inversion = GLOBAL_CHORD_INVERSION_ORDER.includes(v) ? v : 'root';
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordSpread_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordSpread_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const v = String(el.value || 'close');
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.spread = GLOBAL_CHORD_SPREAD_ORDER.includes(v) ? v : 'close';
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordStepMs_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordStepMs_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.splitStepMs = clamp(parseInt(String(el.value || '0'), 10) || 0, 0, 15);
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordMaxMs_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordMaxMs_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.splitMaxMs = clamp(parseInt(String(el.value || '0'), 10) || 0, 0, 18);
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordIntervals_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordIntervals_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customIntervals = String(el.value || '');
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordSplitOffsets_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordSplitOffsets_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customSplitOffsetsMs = String(el.value || '');
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordDetune_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordDetune_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customDetuneCents = String(el.value || '');
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      } else if (el.id.startsWith('bellChordLevels_')) {
        did = true;
        markUserTouchedConfig();
        ensureBellChordOverridesArray();
        const b = parseInt(el.id.slice('bellChordLevels_'.length), 10) || 0;
        if (b < 1 || b > 12) return;
        const cfg = sanitizeBellChordOverride(state.bellChordOverrides[b] || bellChordOverrideDefaults());
        cfg.customLevelGains = String(el.value || '');
        cfg.mode = 'override';
        state.bellChordOverrides[b] = sanitizeBellChordOverride(cfg);
        saveBellChordOverridesToLS();
      }

      if (did) {
        syncBellOverridesEffectiveUI();
        onBellTuningChanged();
      }
    });

    bellOverridesList.addEventListener('click', (e) => {
      const bellEl = (e && e.target && e.target.closest) ? e.target.closest('.rg-bell-override-bell[data-bell]') : null;
      if (bellEl && bellEl.dataset && bellEl.dataset.bell) {
        const b = parseInt(bellEl.dataset.bell, 10) || 0;
        ringBellTestPad(b);
        return;
      }


      const pianoKey = (e && e.target && e.target.closest) ? e.target.closest('.rg-piano-key[data-note]') : null;
      if (pianoKey) {
        const now = perfNow();
        if (bellPianoPicker && bellPianoPicker.ignoreClickUntilMs && now < bellPianoPicker.ignoreClickUntilMs) return;
        const piano = pianoKey.closest ? pianoKey.closest('.rg-piano[data-bell]') : null;
        const bRaw = piano && piano.dataset && piano.dataset.bell ? parseInt(piano.dataset.bell, 10) : 0;
        const b = clamp(bRaw || 0, 1, 12);
        const note = pianoKey.dataset && pianoKey.dataset.note ? String(pianoKey.dataset.note) : '';
        if (note) {
          applyBellPianoKey(b, note);
          return;
        }
      }

      const btn = (e && e.target && e.target.closest) ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset && btn.dataset.act ? String(btn.dataset.act) : '';
      const b = clamp(parseInt((btn.dataset && btn.dataset.bell) || '0', 10) || 0, 1, 12);

      // v10_p09_sound_per_bell_chords_overrides: toggle Advanced expander
      if (act === 'toggleChordAdv') {
        const adv = document.getElementById('bellChordAdv_' + b);
        if (adv) {
          const willOpen = adv.classList.contains('hidden');
          adv.classList.toggle('hidden', !willOpen);
          try { btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); } catch (_) {}
        }
        return;
      }

      if (act === 'clearHz') {
        markUserTouchedConfig();
        clearBellHzOverride(b);
        onBellTuningChanged();
      } else if (act === 'clearVol') {
        markUserTouchedConfig();
        clearBellVolOverride(b);
        onBellTuningChanged();
      } else if (act === 'clearKey') {
        markUserTouchedConfig();
        clearBellKeyOverride(b);
        onBellTuningChanged();
      } else if (act === 'clearOct') {
        markUserTouchedConfig();
        clearBellOctOverride(b);
        onBellTuningChanged();
      }
    });



    // v10_p06_sound_per_bell_piano_keypicker: tap + drag across keys (Spotlight-like semantics)
    function handleBellPianoPointerDown(e) {
      const key = (e && e.target && e.target.closest) ? e.target.closest('.rg-piano-key[data-note]') : null;
      if (!key) return;
      const piano = key.closest ? key.closest('.rg-piano[data-bell]') : null;
      if (!piano || !bellOverridesList.contains(piano)) return;
      const bRaw = piano.dataset && piano.dataset.bell ? parseInt(piano.dataset.bell, 10) : 0;
      const b = clamp(bRaw || 0, 1, 12);
      if (b < 1 || b > state.stage) return;

      // If another pointer is already dragging, ignore additional touches.
      if (bellPianoPicker.active && bellPianoPicker.pointerId != null && e && typeof e.pointerId === 'number' && e.pointerId !== bellPianoPicker.pointerId) return;

      // Supersede any existing piano gesture immediately.
      bellPianoPickerReset();

      bellPianoPicker.active = true;
      bellPianoPicker.pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
      bellPianoPicker.pianoEl = piano;
      bellPianoPicker.bell = b;
      bellPianoPicker.lastNote = null;
      bellPianoPicker.ignoreClickUntilMs = perfNow() + 350;

      try { if (typeof piano.setPointerCapture === 'function' && bellPianoPicker.pointerId != null) piano.setPointerCapture(bellPianoPicker.pointerId); } catch (_) {}

      const note = key.dataset && key.dataset.note ? String(key.dataset.note) : '';
      if (note) {
        bellPianoPicker.lastNote = note;
        bellPianoPickerSetActive(key);
        applyBellPianoKey(b, note);
      }

      if (e && e.cancelable) {
        try { e.preventDefault(); } catch (_) {}
      }
    }

    function handleBellPianoPointerMove(e) {
      if (!bellPianoPicker.active) return;
      if (bellPianoPicker.pointerId != null && e && typeof e.pointerId === 'number' && e.pointerId !== bellPianoPicker.pointerId) return;

      const hit = bellPianoHitTest(e);
      if (!hit) {
        // Leaving the keyboard clears the last note so re-entry can ring again.
        bellPianoPicker.lastNote = null;
        bellPianoPickerSetActive(null);
        if (e && e.cancelable) {
          try { e.preventDefault(); } catch (_) {}
        }
        return;
      }

      bellPianoPickerSetActive(hit.el);

      const note = hit.note;
      if (note && note === bellPianoPicker.lastNote) {
        if (e && e.cancelable) {
          try { e.preventDefault(); } catch (_) {}
        }
        return;
      }

      bellPianoPicker.lastNote = note || null;
      if (note) applyBellPianoKey(bellPianoPicker.bell, note);

      if (e && e.cancelable) {
        try { e.preventDefault(); } catch (_) {}
      }
    }

    function handleBellPianoPointerUp(e) {
      if (!bellPianoPicker.active) return;
      if (bellPianoPicker.pointerId != null && e && typeof e.pointerId === 'number' && e.pointerId !== bellPianoPicker.pointerId) return;
      bellPianoPickerReset();
    }

    function handleBellPianoPointerCancel(e) {
      if (!bellPianoPicker.active) return;
      if (bellPianoPicker.pointerId != null && e && typeof e.pointerId === 'number' && e.pointerId !== bellPianoPicker.pointerId) return;
      bellPianoPickerReset();
    }

    bellOverridesList.addEventListener('pointerdown', handleBellPianoPointerDown, { passive: false });
    bellOverridesList.addEventListener('pointermove', handleBellPianoPointerMove, { passive: false });
    bellOverridesList.addEventListener('pointerup', handleBellPianoPointerUp);
    bellOverridesList.addEventListener('pointercancel', handleBellPianoPointerCancel);
    window.addEventListener('pointerup', handleBellPianoPointerUp);
    window.addEventListener('pointercancel', handleBellPianoPointerCancel);

    // v10_p05_sound_per_bell_hz_slider_preview: Option B slider preview (tap=strike, hold/drag=continuous tone)
    // Uses shared hzSliderPreview + HZ_SLIDER_* constants declared in the audio section.

    function hzSliderPreviewClearTimer() {
      if (!hzSliderPreview.holdTimer) return;
      try { window.clearTimeout(hzSliderPreview.holdTimer); } catch (_) {}
      hzSliderPreview.holdTimer = null;
    }

    function hzSliderPreviewReset() {
      hzSliderPreviewClearTimer();
      hzSliderPreview.active = false;
      hzSliderPreview.pointerId = null;
      hzSliderPreview.el = null;
      hzSliderPreview.bell = 0;
      hzSliderPreview.didStartTone = false;
      hzSliderPreview.downX = 0;
      hzSliderPreview.downY = 0;
    }

    function endHzSliderPreviewInteraction(e, cancelled) {
      if (!hzSliderPreview.active) return;
      const el = hzSliderPreview.el;
      const b = hzSliderPreview.bell;
      const didTone = !!hzSliderPreview.didStartTone;
      hzSliderPreviewReset();

      if (didTone) {
        stopHzPreviewTone();
        return;
      }
      if (cancelled) return;
      if (!el) return;
      const f = parseFloat(String(el.value || '').trim());
      if (!Number.isFinite(f)) return;
      stopHzPreviewTone();
      playBellStrikePreviewAtHz(b, f, perfNow());
    }

    function handleHzSliderPointerDown(e) {
      const el = e && e.target ? e.target : null;
      if (!el || !el.id || !el.id.startsWith('bellHzSlider_')) return;
      const b = parseInt(el.id.slice('bellHzSlider_'.length), 10) || 0;
      if (b < 1 || b > 12) return;

      // Supersede any existing preview immediately.
      stopHzPreviewTone();
      hzSliderPreviewReset();

      hzSliderPreview.active = true;
      hzSliderPreview.pointerId = (typeof e.pointerId === 'number') ? e.pointerId : null;
      hzSliderPreview.el = el;
      hzSliderPreview.bell = b;
      hzSliderPreview.didStartTone = false;
      hzSliderPreview.downX = (typeof e.clientX === 'number') ? e.clientX : 0;
      hzSliderPreview.downY = (typeof e.clientY === 'number') ? e.clientY : 0;

      try { if (typeof el.setPointerCapture === 'function' && hzSliderPreview.pointerId != null) el.setPointerCapture(hzSliderPreview.pointerId); } catch (_) {}

      hzSliderPreview.holdTimer = window.setTimeout(() => {
        if (!hzSliderPreview.active || hzSliderPreview.didStartTone || hzSliderPreview.el !== el) return;
        const f = parseFloat(String(el.value || '').trim());
        if (!Number.isFinite(f)) return;
        hzSliderPreview.didStartTone = true;
        startHzPreviewTone(b, f);
      }, HZ_SLIDER_HOLD_MS);
    }

    function handleHzSliderPointerMove(e) {
      if (!hzSliderPreview.active) return;
      if (hzSliderPreview.pointerId != null && typeof e.pointerId === 'number' && e.pointerId !== hzSliderPreview.pointerId) return;
      const el = hzSliderPreview.el;
      if (!el) return;

      const x = (typeof e.clientX === 'number') ? e.clientX : hzSliderPreview.downX;
      const y = (typeof e.clientY === 'number') ? e.clientY : hzSliderPreview.downY;
      const dx = x - hzSliderPreview.downX;
      const dy = y - hzSliderPreview.downY;
      const dist2 = dx * dx + dy * dy;

      if (!hzSliderPreview.didStartTone && dist2 >= HZ_SLIDER_MOVE_PX2) {
        hzSliderPreviewClearTimer();
        const b = hzSliderPreview.bell;
        const f = parseFloat(String(el.value || '').trim());
        if (Number.isFinite(f)) {
          hzSliderPreview.didStartTone = true;
          startHzPreviewTone(b, f);
        }
      }

      if (hzSliderPreview.didStartTone) {
        const b = hzSliderPreview.bell;
        const f = parseFloat(String(el.value || '').trim());
        if (Number.isFinite(f)) updateHzPreviewTone(b, f);
      }

      if (hzSliderPreview.didStartTone && e && e.cancelable) {
        try { e.preventDefault(); } catch (_) {}
      }
    }

    function handleHzSliderPointerUp(e) {
      if (!hzSliderPreview.active) return;
      if (hzSliderPreview.pointerId != null && typeof e.pointerId === 'number' && e.pointerId !== hzSliderPreview.pointerId) return;
      endHzSliderPreviewInteraction(e, false);
    }

    function handleHzSliderPointerCancel(e) {
      if (!hzSliderPreview.active) return;
      if (hzSliderPreview.pointerId != null && typeof e.pointerId === 'number' && e.pointerId !== hzSliderPreview.pointerId) return;
      endHzSliderPreviewInteraction(e, true);
    }

    bellOverridesList.addEventListener('pointerdown', handleHzSliderPointerDown);
    bellOverridesList.addEventListener('pointermove', handleHzSliderPointerMove);
    bellOverridesList.addEventListener('pointerup', handleHzSliderPointerUp);
    bellOverridesList.addEventListener('pointercancel', handleHzSliderPointerCancel);
    window.addEventListener('pointerup', handleHzSliderPointerUp);
    window.addEventListener('pointercancel', handleHzSliderPointerCancel);
  }

  // v011_p02_sound_test_instrument_row: Spotlight-style tap/drag to ring (Sound menu)
  function soundTestRowSetActive(el) {
    const prev = ui.soundTestRowActiveEl;
    if (prev && prev !== el) {
      try { prev.classList.remove('is-active'); } catch (_) {}
    }
    ui.soundTestRowActiveEl = el || null;
    if (el) {
      try { el.classList.add('is-active'); } catch (_) {}
    }
  }

  function hitTestSoundTestRow(e) {
    if (!soundTestInstrumentRow) return null;
    const x = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const y = (e && typeof e.clientY === 'number') ? e.clientY : 0;
    const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    const btn = (el && el.closest) ? el.closest('.rg-sound-test-btn[data-bell]') : null;
    if (!btn || !soundTestInstrumentRow.contains(btn)) return null;
    const b = parseInt(btn.dataset && btn.dataset.bell ? btn.dataset.bell : '0', 10) || 0;
    if (b < 1 || b > state.stage) return null;
    return { bell: b, el: btn };
  }

  function endSoundTestRowDrag(e) {
    if (!ui.soundTestRowDragActive) return;
    if (ui.soundTestRowDragPointerId != null && e && e.pointerId != null && e.pointerId !== ui.soundTestRowDragPointerId) return;
    ui.soundTestRowDragActive = false;
    ui.soundTestRowDragPointerId = null;
    ui.soundTestRowDragLastBell = null;
    soundTestRowSetActive(null);
  }

  if (soundTestInstrumentRow) {
    // v011_p02a_sound_test_row_spotlight_style: brief active flash for keyboard/click activation (visual only)
    let soundTestRowClickFlashTimer = null;
    function soundTestRowFlashActive(btn) {
      if (!btn) return;
      soundTestRowSetActive(btn);
      if (soundTestRowClickFlashTimer) {
        try { window.clearTimeout(soundTestRowClickFlashTimer); } catch (_) {}
        soundTestRowClickFlashTimer = null;
      }
      soundTestRowClickFlashTimer = window.setTimeout(() => {
        // Don't fight with an in-progress drag highlight.
        if (!ui.soundTestRowDragActive) soundTestRowSetActive(null);
      }, 160);
    }

    soundTestInstrumentRow.addEventListener('pointerdown', (e) => {
      const hit = hitTestSoundTestRow(e);
      if (!hit) return;

      // If another pointer is already dragging, ignore additional touches.
      if (ui.soundTestRowDragActive && ui.soundTestRowDragPointerId != null && e.pointerId !== ui.soundTestRowDragPointerId) return;

      ui.soundTestRowDragActive = true;
      ui.soundTestRowDragPointerId = e.pointerId;
      ui.soundTestRowDragLastBell = hit.bell;
      ui.soundTestRowIgnoreClickUntilMs = perfNow() + 350;
      soundTestRowSetActive(hit.el);
      try { soundTestInstrumentRow.setPointerCapture(e.pointerId); } catch (_) {}

      ringBellTestPad(hit.bell);
      e.preventDefault();
    }, { passive: false });

    soundTestInstrumentRow.addEventListener('pointermove', (e) => {
      if (!ui.soundTestRowDragActive) return;
      if (ui.soundTestRowDragPointerId != null && e.pointerId !== ui.soundTestRowDragPointerId) return;

      const hit = hitTestSoundTestRow(e);
      if (!hit) {
        // Leaving the row clears the last bell so re-entry can ring again.
        ui.soundTestRowDragLastBell = null;
        soundTestRowSetActive(null);
        e.preventDefault();
        return;
      }

      if (hit.bell === ui.soundTestRowDragLastBell) {
        e.preventDefault();
        return;
      }

      ui.soundTestRowDragLastBell = hit.bell;
      soundTestRowSetActive(hit.el);
      ringBellTestPad(hit.bell);
      e.preventDefault();
    }, { passive: false });

    soundTestInstrumentRow.addEventListener('pointerup', endSoundTestRowDrag);
    soundTestInstrumentRow.addEventListener('pointercancel', endSoundTestRowDrag);
    window.addEventListener('pointerup', endSoundTestRowDrag);
    window.addEventListener('pointercancel', endSoundTestRowDrag);

    // Fallback: keyboard activation / click when pointer events are not used.
    soundTestInstrumentRow.addEventListener('click', (e) => {
      const btn = (e && e.target && e.target.closest) ? e.target.closest('.rg-sound-test-btn[data-bell]') : null;
      if (!btn) return;
      const now = perfNow();
      if (ui.soundTestRowIgnoreClickUntilMs && now < ui.soundTestRowIgnoreClickUntilMs) return;
      const b = parseInt(btn.dataset && btn.dataset.bell ? btn.dataset.bell : '0', 10) || 0;
      ringBellTestPad(b);
      soundTestRowFlashActive(btn);
    });
  }

  // v10_p04_sound_quick_bell_row: Spotlight-style quick tap/drag to ring (Sound menu)
  function soundQuickRowSetActive(el) {
    const prev = ui.soundQuickRowActiveEl;
    if (prev && prev !== el) {
      try { prev.classList.remove('is-active'); } catch (_) {}
    }
    ui.soundQuickRowActiveEl = el || null;
    if (el) {
      try { el.classList.add('is-active'); } catch (_) {}
    }
  }

  function hitTestSoundQuickRow(e) {
    if (!soundQuickBellRow) return null;
    const x = (e && typeof e.clientX === 'number') ? e.clientX : 0;
    const y = (e && typeof e.clientY === 'number') ? e.clientY : 0;
    const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    const btn = (el && el.closest) ? el.closest('.rg-quick-bell-btn[data-bell]') : null;
    if (!btn || !soundQuickBellRow.contains(btn)) return null;
    const b = parseInt(btn.dataset && btn.dataset.bell ? btn.dataset.bell : '0', 10) || 0;
    if (b < 1 || b > state.stage) return null;
    return { bell: b, el: btn };
  }

  function endSoundQuickRowDrag(e) {
    if (!ui.soundQuickRowDragActive) return;
    if (ui.soundQuickRowDragPointerId != null && e && e.pointerId != null && e.pointerId !== ui.soundQuickRowDragPointerId) return;
    ui.soundQuickRowDragActive = false;
    ui.soundQuickRowDragPointerId = null;
    ui.soundQuickRowDragLastBell = null;
    soundQuickRowSetActive(null);
  }

  if (soundQuickBellRow) {
    soundQuickBellRow.addEventListener('pointerdown', (e) => {
      const hit = hitTestSoundQuickRow(e);
      if (!hit) return;

      // If another pointer is already dragging, ignore additional touches.
      if (ui.soundQuickRowDragActive && ui.soundQuickRowDragPointerId != null && e.pointerId !== ui.soundQuickRowDragPointerId) return;

      ui.soundQuickRowDragActive = true;
      ui.soundQuickRowDragPointerId = e.pointerId;
      ui.soundQuickRowDragLastBell = hit.bell;
      ui.soundQuickRowIgnoreClickUntilMs = perfNow() + 350;
      soundQuickRowSetActive(hit.el);
      try { soundQuickBellRow.setPointerCapture(e.pointerId); } catch (_) {}

      ringBellTestPad(hit.bell);
      e.preventDefault();
    }, { passive: false });

    soundQuickBellRow.addEventListener('pointermove', (e) => {
      if (!ui.soundQuickRowDragActive) return;
      if (ui.soundQuickRowDragPointerId != null && e.pointerId !== ui.soundQuickRowDragPointerId) return;

      const hit = hitTestSoundQuickRow(e);
      if (!hit) {
        // Leaving the row clears the last bell so re-entry can ring again.
        ui.soundQuickRowDragLastBell = null;
        soundQuickRowSetActive(null);
        e.preventDefault();
        return;
      }

      if (hit.bell === ui.soundQuickRowDragLastBell) {
        e.preventDefault();
        return;
      }

      ui.soundQuickRowDragLastBell = hit.bell;
      soundQuickRowSetActive(hit.el);
      ringBellTestPad(hit.bell);
      e.preventDefault();
    }, { passive: false });

    soundQuickBellRow.addEventListener('pointerup', endSoundQuickRowDrag);
    soundQuickBellRow.addEventListener('pointercancel', endSoundQuickRowDrag);
    window.addEventListener('pointerup', endSoundQuickRowDrag);
    window.addEventListener('pointercancel', endSoundQuickRowDrag);

    // Fallback: keyboard activation / click when pointer events are not used.
    soundQuickBellRow.addEventListener('click', (e) => {
      const btn = (e && e.target && e.target.closest) ? e.target.closest('.rg-quick-bell-btn[data-bell]') : null;
      if (!btn) return;
      const now = perfNow();
      if (ui.soundQuickRowIgnoreClickUntilMs && now < ui.soundQuickRowIgnoreClickUntilMs) return;
      const b = parseInt(btn.dataset && btn.dataset.bell ? btn.dataset.bell : '0', 10) || 0;
      ringBellTestPad(b);
    });
  }


  if (restoreSoundDefaultsBtn) restoreSoundDefaultsBtn.addEventListener('click', () => {
    markUserTouchedConfig();
    restoreSoundDefaults();
  });

  scaleSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.scaleKey = scaleSelect.value;
    syncBellCustomHzUI();
    rebuildBellFrequencies();
    onBellTuningChanged();
    syncBellPitchSummaryUI();

    // v014_p04_multi_drone_layers: refresh any drone layers that follow the bell key.
    if (state.droneOn) refreshDrone();
  });

  octaveSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.octaveC = parseInt(octaveSelect.value, 10) || 3;
    rebuildBellFrequencies();
    onBellTuningChanged();
    syncBellPitchSummaryUI();
  });


  // Bell Custom (Hz) root controls
  if (bellCustomHzInput) {
    bellCustomHzInput.addEventListener('input', () => {
      markUserTouchedConfig();
      setBellCustomHzFromUI(bellCustomHzInput.value, false);
    });

    const commitBellCustomHz = () => {
      markUserTouchedConfig();
      setBellCustomHzFromUI(bellCustomHzInput.value, true);
      syncBellCustomHzUI();
    };
    bellCustomHzInput.addEventListener('change', commitBellCustomHz);
    bellCustomHzInput.addEventListener('blur', commitBellCustomHz);
  }

  if (bellCustomHzSlider) {
    bellCustomHzSlider.addEventListener('input', () => {
      markUserTouchedConfig();
      setBellCustomHzFromUI(bellCustomHzSlider.value, true);
      syncBellCustomHzUI();
    });
  }

  bellVolume.addEventListener('input', () => {
    markUserTouchedConfig();
    state.bellVolume = clamp(parseInt(bellVolume.value, 10) || 0, 0, 100);
    applyBellMasterGain();
    try { syncBellOverridesEffectiveUI(); } catch (_) {}
  });

  // v014_p05a_bell_timbre_global (Sound → Bells: global bell timbre)
  if (bellRingLength) {
    bellRingLength.addEventListener('input', () => {
      markUserTouchedConfig();
      state.bellRingLength = clamp(Number(bellRingLength.value) || 0, 0, 1);
      if (bellRingLengthValue) bellRingLengthValue.textContent = fmtDepth2(state.bellRingLength);
      saveBellTimbreToLS();
    });
  }

  if (bellBrightness) {
    bellBrightness.addEventListener('input', () => {
      markUserTouchedConfig();
      state.bellBrightness = clamp(Number(bellBrightness.value) || 0, 0, 1);
      if (bellBrightnessValue) bellBrightnessValue.textContent = fmtDepth2(state.bellBrightness);
      saveBellTimbreToLS();
      try { for (let bb = 1; bb <= state.stage; bb++) rampActiveBellTimbreBrightness(bb); } catch (_) {}
    });
  }

  if (bellStrikeHardness) {
    bellStrikeHardness.addEventListener('input', () => {
      markUserTouchedConfig();
      state.bellStrikeHardness = clamp(Number(bellStrikeHardness.value) || 0, 0, 1);
      if (bellStrikeHardnessValue) bellStrikeHardnessValue.textContent = fmtDepth2(state.bellStrikeHardness);
      saveBellTimbreToLS();
    });
  }


// v014_p03_master_fx_limiter_reverb: Master / Output controls (FX routing is handled in ensureMasterFxGraph)
if (masterLimiterToggle) {
  masterLimiterToggle.addEventListener('click', () => {
    markUserTouchedConfig();
    state.fxLimiterEnabled = !state.fxLimiterEnabled;
    saveMasterFxToLS();
    syncMasterFxUI();
    applyMasterLimiterEnabled(false);
  });
}
if (masterLimiterStrength) {
  masterLimiterStrength.addEventListener('input', () => {
    markUserTouchedConfig();
    state.fxLimiterAmount = clamp(parseFloat(masterLimiterStrength.value) || 0, 0, 1);
    applyMasterLimiterParams(false);
  });
  masterLimiterStrength.addEventListener('change', () => {
    saveMasterFxToLS();
  });
}

if (masterReverbToggle) {
  masterReverbToggle.addEventListener('click', () => {
    markUserTouchedConfig();
    state.fxReverbEnabled = !state.fxReverbEnabled;
    saveMasterFxToLS();
    syncMasterFxUI();
    applyMasterReverbHighCut(false);
    applyMasterReverbSend(false);
  });
}
if (masterReverbSize) {
  masterReverbSize.addEventListener('input', () => {
    markUserTouchedConfig();
    state.fxReverbSize = clamp(parseFloat(masterReverbSize.value) || 0, 0, 1);
  });
  masterReverbSize.addEventListener('change', () => {
    saveMasterFxToLS();
    queueMasterReverbImpulseRebuild();
  });
}
if (masterReverbMix) {
  masterReverbMix.addEventListener('input', () => {
    markUserTouchedConfig();
    state.fxReverbMix = clamp(parseFloat(masterReverbMix.value) || 0, 0, 1);
    applyMasterReverbSend(false);
  });
  masterReverbMix.addEventListener('change', () => {
    saveMasterFxToLS();
  });
}
if (masterReverbHighCut) {
  masterReverbHighCut.addEventListener('input', () => {
    markUserTouchedConfig();
    state.fxReverbHighCutHz = clamp(parseFloat(masterReverbHighCut.value) || 6000, 500, 20000);
    applyMasterReverbHighCut(false);
  });
  masterReverbHighCut.addEventListener('change', () => {
    saveMasterFxToLS();
  });
}

// v014_p045b_spatial_depth_and_send
if (spatialDepthModeSelect) {
  spatialDepthModeSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.spatialDepthMode = sanitizeSpatialDepthMode(spatialDepthModeSelect.value);
    saveSpatialDepthModeToLS();
    syncSpatialDepthModeUI();
    try { applySpatialDepthModeToAudio(); } catch (_) {}
  });
}


  // v10_p08_sound_global_chords_splitstrike: global chord controls
  if (globalChordOnOffBtn) {
    globalChordOnOffBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.enabled = !state.globalChord.enabled;
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordPresetSelect) {
    globalChordPresetSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.preset = String(globalChordPresetSelect.value || 'unison');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordSplitSelect) {
    globalChordSplitSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.splitStrike = String(globalChordSplitSelect.value || 'simultaneous');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordInversionSelect) {
    globalChordInversionSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.inversion = String(globalChordInversionSelect.value || 'root');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordSpreadSelect) {
    globalChordSpreadSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.spread = String(globalChordSpreadSelect.value || 'close');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  const commitGlobalChordSplitParamsFromUI = () => {
    if (!state.globalChord) state.globalChord = globalChordDefaults();
    if (globalChordStepMs) state.globalChord.stepMs = clamp(parseInt(globalChordStepMs.value, 10) || 0, 0, 15);
    if (globalChordMaxMs) state.globalChord.maxMs = clamp(parseInt(globalChordMaxMs.value, 10) || 0, 0, 18);
    state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
    saveGlobalChordToLS();
    syncGlobalChordControlsUI();
  };

  if (globalChordStepMs) {
    globalChordStepMs.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.stepMs = clamp(parseInt(globalChordStepMs.value, 10) || 0, 0, 15);
    });
    globalChordStepMs.addEventListener('change', () => { markUserTouchedConfig(); commitGlobalChordSplitParamsFromUI(); });
    globalChordStepMs.addEventListener('blur', () => { commitGlobalChordSplitParamsFromUI(); });
  }

  if (globalChordMaxMs) {
    globalChordMaxMs.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.maxMs = clamp(parseInt(globalChordMaxMs.value, 10) || 0, 0, 18);
    });
    globalChordMaxMs.addEventListener('change', () => { markUserTouchedConfig(); commitGlobalChordSplitParamsFromUI(); });
    globalChordMaxMs.addEventListener('blur', () => { commitGlobalChordSplitParamsFromUI(); });
  }


  // v014_p01_global_custom_chords_advanced: global chord Custom + Advanced controls
  if (globalChordCustomIntervalsInput) {
    globalChordCustomIntervalsInput.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.customIntervals = String(globalChordCustomIntervalsInput.value || '');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordDetuneCents) {
    globalChordDetuneCents.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.globalDetuneCents = clamp(parseInt(globalChordDetuneCents.value, 10) || 0, -20, 20);
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordLevelModeSelect) {
    globalChordLevelModeSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.globalLevelMode = String(globalChordLevelModeSelect.value || 'equal');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordLevelGainsInput) {
    globalChordLevelGainsInput.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.globalLevelGains = String(globalChordLevelGainsInput.value || '');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordSplitOffsetModeSelect) {
    globalChordSplitOffsetModeSelect.addEventListener('change', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.globalSplitOffsetMode = String(globalChordSplitOffsetModeSelect.value || 'auto');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (globalChordSplitOffsetsInput) {
    globalChordSplitOffsetsInput.addEventListener('input', () => {
      markUserTouchedConfig();
      if (!state.globalChord) state.globalChord = globalChordDefaults();
      state.globalChord.globalSplitOffsetsMs = String(globalChordSplitOffsetsInput.value || '');
      state.globalChord = sanitizeGlobalChordConfig(state.globalChord);
      saveGlobalChordToLS();
      syncGlobalChordControlsUI();
    });
  }

  if (droneOnOffBtn) {
    droneOnOffBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      setDroneOn(!state.droneOn);
    });
  }

  droneTypeSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneType = droneTypeSelect.value;
    syncDroneVariantsForType(state.droneType);
    // v014_p04_multi_drone_layers: keep Layer 1 + layers persistence in sync.
    syncLayer1FromLegacyDroneState();
    syncDroneVariantsUI();
    saveDroneLayersToLS();
    rebuildDroneLayersUI();

    if (state.droneOn) refreshAllDroneLayers();
    syncDronePauseBtnUI();
  });

  droneScaleSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneScaleKey = droneScaleSelect.value;
    syncDroneCustomHzUI();

    // v014_p04_multi_drone_layers: keep Layer 1 + layers persistence in sync.
    syncLayer1FromLegacyDroneState();
    saveDroneLayersToLS();
    rebuildDroneLayersUI();

    if (state.droneOn) refreshDrone();
  });

  droneOctaveSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneOctaveC = clamp(parseInt(droneOctaveSelect.value, 10) || 3, 1, 6);
    safeSetLS(LS_DRONE_OCTAVE_C, String(state.droneOctaveC));

    // v014_p04_multi_drone_layers: keep Layer 1 + layers persistence in sync.
    syncLayer1FromLegacyDroneState();
    saveDroneLayersToLS();
    rebuildDroneLayersUI();

    if (state.droneOn) refreshDrone();
  });


  // Drone Custom (Hz) root controls
  if (droneCustomHzInput) {
    droneCustomHzInput.addEventListener('input', () => {
      markUserTouchedConfig();
      setDroneCustomHzFromUI(droneCustomHzInput.value, false);
    });

    const commitDroneCustomHz = () => {
      markUserTouchedConfig();
      setDroneCustomHzFromUI(droneCustomHzInput.value, true);
      syncDroneCustomHzUI();
    };
    droneCustomHzInput.addEventListener('change', commitDroneCustomHz);
    droneCustomHzInput.addEventListener('blur', commitDroneCustomHz);
  }

  if (droneCustomHzSlider) {
    droneCustomHzSlider.addEventListener('input', () => {
      markUserTouchedConfig();
      setDroneCustomHzFromUI(droneCustomHzSlider.value, true);
      syncDroneCustomHzUI();
    });
  }

  droneVolume.addEventListener('input', () => {
    markUserTouchedConfig();
    state.droneVolume = clamp(parseInt(droneVolume.value, 10) || 0, 0, 100);
    state.dronesMasterVolume = state.droneVolume;
    applyDroneMasterGain();
    saveDroneLayersToLS();
  });

  // v014_p02_drone_variant_knobs: Drone Variants controls
  if (droneNormalizeBtn) {
    droneNormalizeBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      state.droneNormalize = !state.droneNormalize;
      syncDroneNormalizeBtnUI();
      saveDroneVariantsToLS();
      refreshDrone();
    });
  }

  if (droneDensity) {
    droneDensity.addEventListener('input', () => {
      markUserTouchedConfig();
      const next = clampDroneDensityForType(state.droneType, droneDensity.value);
      state.droneDensity = next;
      if (state.droneDensityByType && typeof state.droneDensityByType === 'object') state.droneDensityByType[state.droneType] = next;
      droneDensity.value = String(next);
      saveDroneVariantsToLS();
      refreshDrone();
    });
  }

  if (droneDriftCents) {
    droneDriftCents.addEventListener('input', () => {
      markUserTouchedConfig();
      state.droneDriftCents = clamp(Number(droneDriftCents.value) || 0, 0, 20);
      droneDriftCents.value = String(state.droneDriftCents);
      saveDroneVariantsToLS();
      syncDroneModTimer();
    });
  }

  if (droneMotionRate) {
    droneMotionRate.addEventListener('input', () => {
      markUserTouchedConfig();
      state.droneMotionRate = clamp(Number(droneMotionRate.value) || 0, 0, 10);
      droneMotionRate.value = String(state.droneMotionRate);
      saveDroneVariantsToLS();
      syncDroneModTimer();
    });
  }

  if (droneClusterWidth) {
    droneClusterWidth.addEventListener('change', () => {
      markUserTouchedConfig();
      state.droneClusterWidth = coerceDroneClusterWidth(droneClusterWidth.value);
      droneClusterWidth.value = String(state.droneClusterWidth);
      syncDroneVariantsUI();
      saveDroneVariantsToLS();
      refreshDrone();
    });
  }

  if (droneNoiseTilt) {
    droneNoiseTilt.addEventListener('input', () => {
      markUserTouchedConfig();
      state.droneNoiseTilt = clamp(Number(droneNoiseTilt.value) || 0, -1, 1);
      droneNoiseTilt.value = String(state.droneNoiseTilt);
      saveDroneVariantsToLS();
      refreshDrone();
    });
  }

  if (droneNoiseQ) {
    droneNoiseQ.addEventListener('input', () => {
      markUserTouchedConfig();
      state.droneNoiseQ = clamp(Number(droneNoiseQ.value) || 1, 0.5, 10);
      droneNoiseQ.value = String(state.droneNoiseQ);
      saveDroneVariantsToLS();
      refreshDrone();
    });
  }

  fileInput.addEventListener('change', () => {
    if (state.phase !== 'idle') return;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const name = (file && file.name) ? String(file.name) : '';
    const lower = name.toLowerCase();
    const isXml = lower.endsWith('.xml');

    markUserTouchedConfig();

    const reader = new FileReader();
    reader.onload = (ev) => {
      if (isXml) {
        // XML: attempt to parse a single CCCBR-style method.
        try {
          const m = parseCCCBRSingleMethod(String(ev.target.result), name);
          const rows = cccbRowsFromPn(m.stage, m.pn, 5);
          if (!rows || !rows.length) throw new Error('Could not generate rows from place notation.');

          state.method = 'custom';
          methodSelect.value = 'custom';
          state.customRows = rows.slice();
          state.stage = clamp(m.stage, 4, 12);

          state.methodSource = 'custom_rows';
          state.methodMeta = { fileName: name || '', title: m.title || '' };

          if (bellCountSelect) bellCountSelect.value = String(state.stage);

          rebuildLiveCountOptions();
          ensureLiveBells();
          rebuildBellPicker();
          ensurePathBells();
          rebuildPathPicker();
          computeRows();
          resetStats();
          rebuildBellFrequencies();
          rebuildBellOverridesUI();

          syncGameHeaderMeta();
          renderScoringExplanation();

          alert('Method loaded from XML: ' + (m.title || 'Untitled') + ' on ' + m.stage + ' bells.');
        } catch (err) {
          const msg = err && err.message ? String(err.message) : String(err);
          alert('Could not load method from XML: ' + msg);
        }
        return;
      }

      // TXT: existing behavior.
      try {
        const parsed = parseCustom(String(ev.target.result));
        state.method = 'custom';
        methodSelect.value = 'custom';
        state.customRows = parsed.rows.slice();
        state.stage = clamp(parsed.stage, 4, 12);

        state.methodSource = 'custom_rows';
        state.methodMeta = { fileName: file.name || '' };

        if (bellCountSelect) bellCountSelect.value = String(state.stage);

        rebuildLiveCountOptions();
        ensureLiveBells();
        rebuildBellPicker();
        ensurePathBells();
        rebuildPathPicker();
        computeRows();
        resetStats();
        rebuildBellFrequencies();
        rebuildBellOverridesUI();

        syncGameHeaderMeta();
        renderScoringExplanation();

        alert('Custom method loaded: ' + parsed.rows.length + ' rows on ' + parsed.stage + ' bells.');
      } catch (err) {
        alert('Could not load custom method: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  if (xmlInput) {
    xmlInput.addEventListener('change', async (e) => {
      if (state.phase !== 'idle') return;

      const files = e.target && e.target.files ? Array.from(e.target.files) : [];
      if (files.length) markUserTouchedConfig();
      for (const file of files) {
        const name = file && file.name ? String(file.name) : '';
        const lower = name.toLowerCase();
        const before = RG.methods.length;
        try {
          if (lower.endsWith('.zip')) {
            await parseZipArchive(file);
          } else if (lower.endsWith('.xml')) {
            const text = await file.text();
            parseCCCBR(text, name);
            const added = RG.methods.length - before;
          }
        } catch (err) {
          console.error('CCCBR load failed', err);
          alert('Could not load ' + name + ': ' + (err && err.message ? err.message : err));
        }

        const libAdded = RG.methods.length - before;
        if (libAdded > 0) {
          state.libraryLoaded = true;
          state.libraryFileName = name;
        } else if (!RG.methods || !RG.methods.length) {
          state.libraryLoaded = false;
          state.libraryFileName = '';
        }
      }

      // v06_p12d_library_browser: rebuild grouped browse index after load
      if (state.libraryLoaded) {
        try { buildLibraryIndex(); } catch (_) {}
      }

      // v06_p12d_library_browser: refresh the Setup summary (filename + counts)
      try { refreshMethodList(); } catch (_) {}

      syncLibraryEntryUI();
      syncLibraryScreenUI();

      try { e.target.value = ''; } catch (_) {}
    });
  }

  if (notationPrevBtn) notationPrevBtn.addEventListener('click', notationPrevPressed);
  if (notationNextBtn) notationNextBtn.addEventListener('click', notationNextPressed);

  startBtn.addEventListener('click', () => startPressed('play'));
  if (pauseBtn) pauseBtn.addEventListener('click', togglePause);
  if (demoBtn) demoBtn.addEventListener('click', () => startDemoFromUi());
  stopBtn.addEventListener('click', () => stopPressed('stopped'));
  if (dronePauseBtn) dronePauseBtn.addEventListener('click', toggleDronePaused);

  if (keybindResetBtn) {
    keybindResetBtn.addEventListener('click', () => {
      if (state.phase !== 'idle') return;
      markUserTouchedConfig();
      state.keybindCaptureBell = null;
      resetKeyBindingsToDefaults();
      rebuildKeybindPanel();
    });
  }


  // === Boot ===

  // v07_p02_privacy_footer_policy_friendly_banner
  function setPrivacyPolicyText() {
    // v07_p02_privacy_footer_policy_friendly_banner: policy content is now semantic HTML in index.html
  }

  function showConsentBanner(show) {
    if (!consentBanner) return;
    consentBanner.classList.toggle('hidden', !show);
    consentBanner.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function syncAudienceConsentUI() {
    const on = (getAudienceConsent() === '1');
    if (privacyAudienceCheckbox) privacyAudienceCheckbox.checked = on;

    const lblP = privacyAudienceCheckbox ? privacyAudienceCheckbox.closest('label.toggle') : null;
    if (lblP) lblP.classList.toggle('is-selected', on);
  }

  function showPrivacyRefreshNotice(show) {
    if (!privacyRefreshNotice) return;
    privacyRefreshNotice.classList.toggle('hidden', !show);
    privacyRefreshNotice.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function syncPrivacyRefreshNoticeUI() {
    // Show only when opted out and GA was loaded earlier in this tab session.
    const show = (!isAudienceMeasurementEnabled() && gaNeedsRefreshNotice);
    showPrivacyRefreshNotice(show);
  }



  function syncPrivacyToggleUI() { syncAudienceConsentUI(); }

  function enableAudienceMeasurement() {
    setAudienceConsent('1');
    syncAudienceConsentUI();
    syncPrivacyRefreshNoticeUI();
  }

  function disableAudienceMeasurement() {
    setAudienceConsent('0');
    syncAudienceConsentUI();
    syncPrivacyRefreshNoticeUI();
  }

  function initPrivacyConsentUI() {
    setPrivacyPolicyText();

    const c = getAudienceConsent();
    if (c === '') {
      showConsentBanner(true);
    } else {
      showConsentBanner(false);
    }

    syncAudienceConsentUI();
    syncPrivacyRefreshNoticeUI();
    applyGADisableFlagFromStoredChoice();

    if (c === '1') {
      analytics.configure();
    }

    if (consentAllowBtn) consentAllowBtn.addEventListener('click', enableAudienceMeasurement);
    if (consentDenyBtn) consentDenyBtn.addEventListener('click', disableAudienceMeasurement);

    if (consentPrivacyLink) consentPrivacyLink.addEventListener('click', () => setScreen('privacy'));

    if (footerPrivacyLink) footerPrivacyLink.addEventListener('click', () => setScreen('privacy'));

        if (privacyAudienceCheckbox) {
          privacyAudienceCheckbox.addEventListener('change', () => {
            setAudienceConsent(privacyAudienceCheckbox.checked ? '1' : '0');
            syncAudienceConsentUI();
            syncPrivacyRefreshNoticeUI();
          });
        }

  }

  function boot() {
    // v08_p04_demo_profile_defaults: ignore config-change tracking during boot.
    ui.isBooting = true;

    mountMenuControls();

    // v10_p01_polish_defaults_privacy_home_buttons: pristine means no prior localStorage.
    const pristineLS = (() => { try { return (localStorage.length === 0); } catch (_) { return true; } })();


    // Play defaults (non-persisted)
    state.method = 'plainhunt';
    if (methodSelect) methodSelect.value = 'plainhunt';

    state.methodSource = 'built_in';
    state.methodMeta = null;

    state.stage = 6;
    if (bellCountSelect) bellCountSelect.value = '6';

    state.liveCount = pristineLS ? 2 : 1;
    state.liveBells = pristineLS ? [1, 2] : [1];

    state.bpm = 120;
    if (bpmInput) bpmInput.value = String(state.bpm);
    if (bpmSlider) bpmSlider.value = String(state.bpm);

    loadKeyBindings();
    loadGlyphBindings();

    
    loadGlyphStyle();
// v10_p01_polish_defaults_privacy_home_buttons: pristine Play key defaults
    // Space rings bell 1; Enter rings bell 2 (only when no saved keybinds exist).
    if (pristineLS && safeGetLS(LS_KEYBINDS) == null) {
      state.keyBindings[1] = 'Space';
      state.keyBindings[2] = 'Enter';
    }


    // swaps view settings (persisted)
    state.spotlightSwapsView = safeGetBoolLS(LS_SPOTLIGHT_SWAPS_VIEW, true);
    state.spotlightShowN = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N, true);
    // v08_p08_defaults_and_ui_fixes: Play default (pristine) shows N, N+1, N+2.
    // Only used when the preference is missing.
    state.spotlightShowN1 = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N1, true);
    state.spotlightShowN2 = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N2, true);
    state.notationSwapsOverlay = safeGetBoolLS(LS_NOTATION_SWAPS_OVERLAY, true);
    // v10_p02_play_scored_only_display_default: In Play, default to "Display scored bell(s) only" when no saved preference exists.
    // Do NOT overwrite an existing localStorage preference.
    state.displayLiveBellsOnly = (safeGetLS(LS_DISPLAY_LIVE_BELLS_ONLY) == null)
      ? true
      : safeGetBoolLS(LS_DISPLAY_LIVE_BELLS_ONLY, isMobileLikely());

    loadMicPrefs();

    loadBellOverridesFromLS();
    loadBellChordOverridesFromLS();
    loadBellTimbreOverridesFromLS();
    loadSpatialDepthModeFromLS();
    // v014_p05a_bell_timbre_global
    {
      const bt = loadBellTimbreFromLS();
      state.bellRingLength = bt.bellRingLength;
      state.bellBrightness = bt.bellBrightness;
      state.bellStrikeHardness = bt.bellStrikeHardness;
      try { syncBellTimbreUI(); } catch (_) {}
    }

    // v10_p08_sound_global_chords_splitstrike
    state.globalChord = loadGlobalChordFromLS();
    try { buildGlobalChordControlsUI(); } catch (_) {}

    if (!state.spotlightShowN && !state.spotlightShowN1 && !state.spotlightShowN2) state.spotlightShowN = true;

    if (spotlightSwapsView) spotlightSwapsView.checked = state.spotlightSwapsView;
    if (spotlightShowN) spotlightShowN.checked = state.spotlightShowN;
    if (spotlightShowN1) spotlightShowN1.checked = state.spotlightShowN1;
    if (spotlightShowN2) spotlightShowN2.checked = state.spotlightShowN2;
    if (notationSwapsOverlay) notationSwapsOverlay.checked = state.notationSwapsOverlay;
    if (displayLiveOnly) displayLiveOnly.checked = state.displayLiveBellsOnly;

    // v10_p01_polish_defaults_privacy_home_buttons: pristine default keeps Spotlight accuracy dots OFF.
    if (pristineLS && safeGetLS(LS_ACCURACY_DOTS) == null) state.accuracyDotsSpotlight = false;

    loadAccuracyDotsPrefs();
    syncAccuracyDotsUI();


    syncSpotlightSwapRowTogglesUI();
    syncSpotlightRowPrefsFromUI();

    scaleSelect.innerHTML = '';
    {
      const opt = document.createElement('option');
      opt.value = 'custom_hz';
      opt.textContent = 'Custom (Hz)';
      scaleSelect.appendChild(opt);
    }
    for (const s of SCALE_LIBRARY) {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      scaleSelect.appendChild(opt);
    }
    // Sound defaults (non-persisted)
    state.scaleKey = (SCALE_LIBRARY.find(s => s.key === 'Fs_major') ? 'Fs_major' : SCALE_LIBRARY[0].key);
    scaleSelect.value = state.scaleKey;

    // Drone scale (same option set as bells)
    droneScaleSelect.innerHTML = '';
    {
      const opt = document.createElement('option');
      opt.value = 'custom_hz';
      opt.textContent = 'Custom (Hz)';
      droneScaleSelect.appendChild(opt);
    }
    for (const s of SCALE_LIBRARY) {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = s.label;
      droneScaleSelect.appendChild(opt);
    }
    state.droneScaleKey = (SCALE_LIBRARY.find(s => s.key === 'Fs_major') ? 'Fs_major' : state.scaleKey);
    droneScaleSelect.value = state.droneScaleKey;

    octaveSelect.innerHTML = '';
    for (let o = 1; o <= 6; o++) {
      const opt = document.createElement('option');
      opt.value = String(o);
      opt.textContent = 'C' + String(o);
      octaveSelect.appendChild(opt);
    }
    state.octaveC = 4;
    octaveSelect.value = String(state.octaveC);

    // Drone octave (same option set as bells)
    droneOctaveSelect.innerHTML = '';
    for (let o = 1; o <= 6; o++) {
      const opt = document.createElement('option');
      opt.value = String(o);
      opt.textContent = 'C' + String(o);
      droneOctaveSelect.appendChild(opt);
    }
    {
      const raw = safeGetLS(LS_DRONE_OCTAVE_C);
      let v = parseInt(raw || '', 10);
      // v08_p08_defaults_and_ui_fixes: default Drone register to C3 on first run.
      if (!Number.isFinite(v)) v = 3;
      state.droneOctaveC = clamp(v, 1, 6);
    }
    droneOctaveSelect.value = String(state.droneOctaveC);

    // v08_p07_drone_on_off_button: restore Drone On/Off (separate from drone type).
    // Drone type is always a real pattern (never "off").
    const defaultDroneType = (() => {
      try {
        if (droneTypeSelect && droneTypeSelect.options && droneTypeSelect.options.length) {
          return String(droneTypeSelect.options[0].value || 'single');
        }
      } catch (_) {}
      return 'single';
    })();

    if (!state.droneType || state.droneType === 'off') state.droneType = defaultDroneType;
    try {
      if (droneTypeSelect && !Array.from(droneTypeSelect.options).some(o => o.value === state.droneType)) {
        state.droneType = defaultDroneType;
      }
    } catch (_) {
      if (!state.droneType) state.droneType = defaultDroneType;
    }

    // Load persisted on/off. If unset, try to infer from a legacy stored drone type.
    {
      const rawOn = safeGetLS(LS_DRONE_ON);
      if (rawOn != null) {
        state.droneOn = safeGetBoolLS(LS_DRONE_ON, false);
      } else {
        const legacyType = safeGetLS('rg_drone_type_v1') || safeGetLS('rg_drone_type') || '';
        if (legacyType === 'off') {
          state.droneOn = false;
          state.droneType = defaultDroneType;
        } else if (legacyType) {
          try {
            if (droneTypeSelect && Array.from(droneTypeSelect.options).some(o => o.value === legacyType)) {
              state.droneType = legacyType;
              state.droneOn = true;
            }
          } catch (_) {}
        } else {
          state.droneOn = false;
        }
      }
    }

    if (!state.droneOn) state.dronePaused = false;

    // v014_p02_drone_variant_knobs: restore Drone Variants
    loadDroneVariantsFromLS();

    // v014_p04_multi_drone_layers: restore layered drones (if present), else migrate from legacy.
    if (!loadDroneLayersFromLS()) {
      ensureDroneLayersState();
      saveDroneLayersToLS();
    }

    syncDroneVariantsUI();
    loadMasterFxFromLS();
    syncMasterFxUI();
    // v017_p01_polyrhythm_core
    loadPolyrhythmFromLS();
    rebuildPolyrhythmUI();
    syncPolyrhythmUI();

    try { syncSpatialDepthModeUI(); } catch (_) {}


    // Sliders/defaults
    bellVolume.value = String(state.bellVolume);
    droneTypeSelect.value = state.droneType;
    droneVolume.value = String(state.droneVolume);

    // Custom Hz controls
    syncBellCustomHzUI();
    syncDroneCustomHzUI();
    rebuildDroneLayersUI();

    // Start/stop drone based on current preference (no gameplay side effects).
    if (state.droneOn) {
      try { startDrone(); } catch (_) {}
    } else {
      stopDrone();
    }
    syncDroneOnOffUI();

    rebuildLiveCountOptions();
    ensureLiveBells();
    rebuildBellPicker();

    // View default: line (blue line) = none on pristine sessions
    state.pathBells = pristineLS ? [] : [1];
    rebuildPathPicker();

    computeRows();
    resetStats();
    rebuildBellFrequencies();
    rebuildBellOverridesUI();
    syncViewLayout();

    initPrivacyConsentUI();

    // v07_p02b_privacy_checkbox_sync
    syncAudienceConsentUI();

    window.addEventListener('pagehide', stopMicCapture);
    window.addEventListener('beforeunload', stopMicCapture);
    window.addEventListener('pagehide', stopDrone);
    window.addEventListener('beforeunload', stopDrone);
    window.addEventListener('blur', () => {
      // v10_p05_sound_per_bell_hz_slider_preview: best-effort safety stop.
      try { cancelHzSliderPreviewGesture(); } catch (_) {}
      try { stopHzPreviewTone(); } catch (_) {}
    });


    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        try { cancelHzSliderPreviewGesture(); } catch (_) {}
        try { stopHzPreviewTone(); } catch (_) {}
        // Interactive-only: do not auto-stop runs on desktop tab switches.
        // Browsers may release wake locks while hidden; we re-request on return.
        syncWakeLockForRun();
      } else {
        syncWakeLockForRun();
        if (state.phase !== 'idle' && state.mode === 'demo') {
          const nowMs = perfNow();
          resyncDemoToNow(nowMs);
          scheduleCountdown(nowMs);
          scheduleMethod(nowMs);
        }
        markDirty();
      }
    });

    window.addEventListener('resize', () => {
      markDirty();
      try { if (hamburgerIsOpen()) rgHamburgerPositionDropdownPortal(); } catch (_) {}
    });

    syncGameHeaderMeta();
    renderScoringExplanation();
    syncDroneOnOffUI();

    // Default to Home screen; game initializes normally in the background.
    setScreen('home');

    loop();

    // View: layout presets (persisted; safe after loop has started)
    syncLayoutPresetUI();

    // v06_p15_notation_single_page_mode
    syncNotationLayoutUI();

    syncNotationPagingUI();

    syncLibraryEntryUI();
    syncLibraryScreenUI();

    // Bell Pitch: keep collapsed header summary in sync.
    try { maybeApplyDefaultBellPitchSpanForStage(state.stage); } catch (_) {}
    try { syncBellPitchSpanUI(); } catch (_) {}
    try { syncBellPitchFamilyUI(); } catch (_) {}
    try { syncBellPitchSummaryUI(); } catch (_) {}

    ui.isBooting = false;
  }

  boot();
})();

// === PWA: service worker registration ===
// Needed for offline caching + install prompt on supporting browsers.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Registration failures should not break gameplay.
    });
  });
}
