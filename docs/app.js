
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
  const SITE_VERSION = 'v08_p07_drone_on_off_button';

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
Audience measurement is off by default. You can enable or disable it at any time from the Privacy page. When disabled, Google Analytics is not loaded.

Third party
Google Analytics is provided by Google. Their processing of data is governed by Google’s own privacy terms.`;


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
          try { window[gaDisableFlagKey()] = false; } catch (_) {}
          try { loadGA4IfConsented(); } catch (_) {}
          try { analytics.configure(); } catch (_) {}
          // Ensure the current screen is counted for SPA usage (screen views only).
          try { analytics.track('screen_view', { screen_name: analyticsScreenName(ui.screen) }); } catch (_) {}
        } else {
          // Stop sending hits best-effort, and clear GA cookies if present.
          try { window[gaDisableFlagKey()] = true; } catch (_) {}
          cleanupGACookiesBestEffort();
        }

        return v;
      }

  // GA4 dynamic loader (opt-in only)
  let gaInjected = false;
  let gaConfigured = false;
  let gaScriptEl = null;

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
          allow_ad_personalization_signals: false
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
    if (s === 'home' || s === 'view' || s === 'sound' || s === 'library' || s === 'game' || s === 'privacy') return s;
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

  // v08_p05_sound_per_bell_overrides (Sound menu per-bell editor)
  const bellOverridesResetBtn = document.getElementById('bellOverridesResetBtn');
  const bellOverridesList = document.getElementById('bellOverridesList');

  const bellCustomHzInput = document.getElementById('bellCustomHzInput');
  const bellCustomHzSlider = document.getElementById('bellCustomHzSlider');

  const droneOnOffBtn = document.getElementById('droneOnOffBtn');
  const droneTypeSelect = document.getElementById('droneTypeSelect');
  const droneScaleSelect = document.getElementById('droneScaleSelect');
  const droneOctaveSelect = document.getElementById('droneOctaveSelect');
  const droneVolume = document.getElementById('droneVolume');

  const droneCustomHzInput = document.getElementById('droneCustomHzInput');
  const droneCustomHzSlider = document.getElementById('droneCustomHzSlider');

  const liveCountSelect = document.getElementById('liveCount');
  const bellPicker = document.getElementById('bellPicker');
  const keybindPanel = document.getElementById('keybindPanel');
  const keybindResetBtn = document.getElementById('keybindResetBtn');
  const keybindNote = document.getElementById('keybindNote');
  const bpmInput = document.getElementById('bpmInput');

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

  // v06_p10_ui_home_menu_polish: Menu button routes to Home (no overlay).
  if (rgMenuOverlay) {
    // Keep overlay permanently hidden/inert (legacy DOM allowed).
    try { rgMenuOverlay.classList.add('hidden'); } catch (_) {}
    try { rgMenuOverlay.setAttribute('aria-hidden', 'true'); } catch (_) {}
  }

  if (menuToggle) {
    menuToggle.setAttribute('aria-label', 'Menu');
    menuToggle.setAttribute('title', 'Menu');
    menuToggle.addEventListener('click', () => {
      setScreen('home');
    });
  }

  const statsDiv = document.getElementById('stats');

  // === Screen scaffolding ===
  const screenHome = document.getElementById('screenHome');
  const screenPlay = document.getElementById('screenPlay');
  const screenView = document.getElementById('screenView');
  const screenSound = document.getElementById('screenSound');
  const screenLibrary = document.getElementById('screenLibrary');
  const screenGame = document.getElementById('screenGame');
  const screenPrivacy = document.getElementById('screenPrivacy');

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
    isBooting: true
  };

  // v08_p04_demo_profile_defaults
  function markUserTouchedConfig() {
    if (!ui || ui.isBooting) return;
    if (ui.userTouchedConfig) return;
    ui.userTouchedConfig = true;
  }

  function setScreen(name) {
    const n = String(name || '').toLowerCase();
    const next = (n === 'home' || n === 'play' || n === 'view' || n === 'sound' || n === 'library' || n === 'game' || n === 'privacy') ? n : 'home';

    const screens = { home: screenHome, play: screenPlay, view: screenView, sound: screenSound, library: screenLibrary, game: screenGame, privacy: screenPrivacy };
    for (const k in screens) {
      const el = screens[k];
      if (!el) continue;
      el.classList.toggle('rg-active', k === next);
      el.setAttribute('aria-hidden', k === next ? 'false' : 'true');
    }

    ui.screen = next;

    // v07_p02_privacy_footer_policy_friendly_banner: audience measurement (screen views only)
    try { analytics.track('screen_view', { screen_name: analyticsScreenName(next) }); } catch (_) {}

    if (next === 'privacy') {
      syncAudienceConsentUI();
    }

    if (next === 'view') {
      // Ensure View menu selected-state UI is correct when revisiting the screen.
      syncViewMenuSelectedUI();
    }

    if (next === 'library') {
      syncLibraryScreenUI();
    }

    if (next === 'game') {
      markDirty();
      kickLoop();
      syncDronePauseBtnUI();
    }
  }

  // v06_p12c_library_entry: enable/disable Setup entry + keep Library screen filename current
  function syncLibraryEntryUI() {
    const btn = document.getElementById('setupExploreLibraryBtn');
    if (!btn) return;

    const loaded = !!(state && state.libraryLoaded);
    btn.disabled = !loaded;
    btn.classList.toggle('is-disabled', !loaded);
    if (!loaded) {
      btn.title = 'Load a CCCBR library XML/ZIP first';
    } else {
      btn.title = '';
    }
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
      libraryPreviewLimitNote.classList.toggle('hidden', !p.capped);
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

  function libraryEnterWithSelected(mode) {
    const idx = ui.librarySelectedIdx;
    if (idx == null) return;

    if (state.phase !== 'idle') {
      alert('Stop the current game first.');
      return;
    }

    // Selecting a library method is a user configuration change.
    markUserTouchedConfig();

    const result = loadCCCBRMethod(idx);
    if (!result) return;

    setScreen('game');
    if (mode === 'demo') {
      startDemoFromUi();
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

  function mountMenuControls() {
    const playDest = document.getElementById('playMenuControls');
    const viewDest = document.getElementById('viewMenuControls');
    const soundDest = document.getElementById('soundMenuControls');

    if (!playDest && !viewDest && !soundDest) return;

    // PLAY
    moveControlByChildId('methodSelect', playDest);
    moveControlByChildId('bellCount', playDest);
    moveControlByChildId('bpmInput', playDest);
    moveControlByChildId('liveCount', playDest);
    moveControlByChildId('bellPicker', playDest);
    moveControlByChildId('keybindPanel', playDest);
    moveControlByChildId('micToggleBtn', playDest);
    moveControlByChildId('micCooldown', playDest);
    moveControlByChildId('fileInput', playDest);
    moveControlByChildId('xmlInput', playDest);

    // v06_p12d_library_browser: CCCBR web download + load control (place next to the XML/ZIP upload)
    try {
      const cccb = document.getElementById('setupCCCBRLibraryControl');
      if (cccb && playDest) {
        const xmlCtl = xmlInput ? xmlInput.closest('.control') : null;
        if (xmlCtl && xmlCtl.parentElement === playDest) {
          playDest.insertBefore(cccb, xmlCtl.nextSibling);
        } else {
          playDest.appendChild(cccb);
        }
      }
    } catch (_) {}

    moveControlByChildId('setupExploreLibraryBtn', playDest);

    // Move Method Library pane into Play screen (below controls)
    const playScreen = document.getElementById('screenPlay');
    const lib = document.getElementById('methodLibrary');
    if (playScreen && lib) {
      playScreen.appendChild(lib);
      lib.classList.add('rg-splash');
      lib.style.marginTop = '12px';
    }

    // VIEW
    moveControlByChildId('viewDisplay', viewDest);
    moveControlByChildId('displayLiveOnly', viewDest);
    moveControlByChildId('spotlightSwapsView', viewDest);
    moveControlByChildId('notationSwapsOverlay', viewDest);
    moveControlByChildId('pathNoneBtn', viewDest);

    // SOUND
    moveControlByChildId('scaleSelect', soundDest);
    moveControlByChildId('octaveSelect', soundDest);
    moveControlByChildId('bellCustomHzInput', soundDest);
    moveControlByChildId('bellVolume', soundDest);
    moveControlByChildId('droneOnOffBtn', soundDest);
    moveControlByChildId('droneTypeSelect', soundDest);
    moveControlByChildId('droneScaleSelect', soundDest);
    moveControlByChildId('droneOctaveSelect', soundDest);
    moveControlByChildId('droneCustomHzInput', soundDest);
    moveControlByChildId('droneVolume', soundDest);
  }

  // Home / placeholder navigation buttons
  const homeBtnPlay = document.getElementById('homeBtnPlay');
  const homeBtnView = document.getElementById('homeBtnView');
  const homeBtnSound = document.getElementById('homeBtnSound');
  const homeBtnDemo = document.getElementById('homeBtnDemo');
  const homeBtnBegin = document.getElementById('homeBtnBegin');

  const homeBellLogo = document.getElementById('homeBellLogo');

  const playBtnEnterGame = document.getElementById('playBtnEnterGame');
  const playBtnDemo = document.getElementById('playBtnDemo');

  const viewBtnEnterGame = document.getElementById('viewBtnEnterGame');
  const viewBtnDemo = document.getElementById('viewBtnDemo');

  const soundBtnEnterGame = document.getElementById('soundBtnEnterGame');
  const soundBtnDemo = document.getElementById('soundBtnDemo');

  const libraryBtnEnterGame = document.getElementById('libraryBtnEnterGame');
  const libraryBtnDemo = document.getElementById('libraryBtnDemo');

  const setupExploreLibraryBtn = document.getElementById('setupExploreLibraryBtn');

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
    if (libraryBtnEnterGame) libraryBtnEnterGame.addEventListener('click', () => setScreen('game'));

    // Demo buttons (idle only).
    function wireDemo(btn) {
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (state.phase !== 'idle') {
          alert('Stop the current game first.');
          return;
        }
        setScreen('game');
        startDemoFromUi();
      });
    }
    wireDemo(playBtnDemo);
    wireDemo(viewBtnDemo);
    wireDemo(soundBtnDemo);
    wireDemo(libraryBtnDemo);
  }

  if (homeBtnPlay) homeBtnPlay.addEventListener('click', () => setScreen('play'));
  if (homeBtnView) homeBtnView.addEventListener('click', () => setScreen('view'));
  if (homeBtnSound) homeBtnSound.addEventListener('click', () => setScreen('sound'));
  if (homeBtnBegin) homeBtnBegin.addEventListener('click', () => {
    setScreen('game');
    requestAnimationFrame(() => {
      try { if (startBtn) startBtn.focus(); } catch (_) {}
    });
  });
  if (homeBtnDemo) homeBtnDemo.addEventListener('click', () => {
    if (state.phase !== 'idle') {
      alert('Stop the current game first.');
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

  // Home: tapping the bell logo rings bell 1 (treble) once (UI-only).
  function ringHomeLogoBell1() {
    try {
      ensureAudio();
      playBellAt(1, perfNow());
    } catch (_) {}
  }
  if (homeBellLogo) {
    homeBellLogo.addEventListener('click', () => ringHomeLogoBell1());
    homeBellLogo.addEventListener('keydown', (e) => {
      const k = e && e.key ? String(e.key) : '';
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        try { e.preventDefault(); } catch (_) {}
        ringHomeLogoBell1();
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
  // v07_p02_privacy_footer_policy_friendly_banner
  const privacyAudienceCheckbox = document.getElementById('privacyAudienceCheckbox');
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

  // layout preset localStorage key
  const LS_LAYOUT_PRESET = 'rg_layout_preset';

  // v06_p15_notation_single_page_mode
  const LS_NOTATION_LAYOUT = 'rg_notation_layout';

  // v08_p05_sound_per_bell_overrides localStorage keys
  const LS_BELL_HZ_OVERRIDE = 'rg_bell_hz_override_v1';
  const LS_BELL_VOL_OVERRIDE = 'rg_bell_vol_override_v1';

  // v08_p07_drone_on_off_button localStorage key
  const LS_DRONE_ON = 'rg_drone_on_v1';

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

    // audio settings
    bellVolume: 100, // 0..100 master bell volume
    // v08_p07_drone_on_off_button: drone on/off is now a separate boolean; droneType is pattern only.
    droneOn: false,
    droneType: 'single',
    droneScaleKey: 'Fs_major',
    droneOctaveC: 4,
    droneCustomHz: 440, // used when droneScaleKey === 'custom_hz'
    droneVolume: 50, // 0..100
    dronePaused: false, // Prompt 7: mute/unmute drone without stopping


    bellFreq: [],

    // v08_p05_sound_per_bell_overrides
    bellHzOverride: new Array(13).fill(null),
    bellVolOverride: new Array(13).fill(null),

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
    comboCurrentGlobal: 0,
    comboBestGlobal: 0,

    currentPlay: null, // { playId, began }

    lastRingAtMs: {}, // bell -> ms (intended beat time or actual key time)

    // keybindings
    keyBindings: {}, // bell -> normalized key name
    keybindCaptureBell: null,

    // swaps view settings
    spotlightSwapsView: true,
    spotlightShowN: true,
    spotlightShowN1: false,
    spotlightShowN2: true,
    notationSwapsOverlay: true,
    notationPageSize: 16,
    displayLiveBellsOnly: false,

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
  let droneCurrent = null;
  let noiseBuffer = null;
  let noiseBufferSampleRate = 0;

  // Prompt 6: registry of scheduled bell/tick strike nodes (NOT drone nodes)
  let scheduledBellNodes = [];

  // Mic v2 threshold (linear RMS)
  const DEFAULT_MIC_THRESHOLD = 0.06;
  if (!Number.isFinite(window.micThreshold)) window.micThreshold = DEFAULT_MIC_THRESHOLD;

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
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

  function demoEffectiveHorizonMs() {
    const bpm = Math.max(1, Number(state.bpm) || 1);
    const beatMs = 60000 / bpm;
    let baseHorizonMs;
    if (document.hidden) {
      baseHorizonMs = (bpm <= DEMO_LOW_BPM_THRESHOLD) ? DEMO_LOW_BPM_AHEAD_MS : DEMO_HIDDEN_AHEAD_MS;
    } else {
      baseHorizonMs = DEMO_VISIBLE_AHEAD_MS;
    }
    const capMs = beatMs * DEMO_MAX_AHEAD_STRIKES;
    return Math.min(baseHorizonMs, capMs);
  }

  // === Audio ===
    function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();

      // Master gain for bell sounds (global bell volume slider)
      bellMasterGain = audioCtx.createGain();
      bellMasterGain.gain.value = clamp((Number(state.bellVolume) || 100) / 100, 0, 1);
      bellMasterGain.connect(audioCtx.destination);

      // Master gain for the drone (separate from bell volume)
      droneMasterGain = audioCtx.createGain();
      droneMasterGain.gain.value = clamp((Number(state.droneVolume) || 50) / 100, 0, 1);
      droneMasterGain.connect(audioCtx.destination);

      noiseBuffer = null;
      noiseBufferSampleRate = 0;
    } else {
      // Recreate master gains if needed (e.g., after an AudioContext restart)
      if (!bellMasterGain) {
        bellMasterGain = audioCtx.createGain();
        bellMasterGain.gain.value = clamp((Number(state.bellVolume) || 100) / 100, 0, 1);
        bellMasterGain.connect(audioCtx.destination);
      }
      if (!droneMasterGain) {
        droneMasterGain = audioCtx.createGain();
        droneMasterGain.gain.value = clamp((Number(state.droneVolume) || 50) / 100, 0, 1);
        droneMasterGain.connect(audioCtx.destination);
      }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function closeAudio() {
    if (audioCtx) {
      // Keep the shared AudioContext alive while mic capture, drone, or a demo run is active.
      if (state.phase !== 'idle' && state.mode === 'demo') return;
      if (state.micActive) return;
      if (state.droneOn) return;
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
      bellMasterGain = null;
      droneMasterGain = null;
      droneCurrent = null;
      noiseBuffer = null;
      noiseBufferSampleRate = 0;
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
  function getBellHz(bell) {
    const b = parseInt(bell, 10) || 0;
    const ov = (state.bellHzOverride && state.bellHzOverride[b] != null) ? Number(state.bellHzOverride[b]) : NaN;
    if (Number.isFinite(ov) && ov > 0) return ov;
    return getBellFrequencyDefault(bell);
  }

  function getBellGain(bell) {
    const b = parseInt(bell, 10) || 0;
    const ovRaw = (state.bellVolOverride && state.bellVolOverride[b] != null) ? Number(state.bellVolOverride[b]) : NaN;
    if (!Number.isFinite(ovRaw)) return 1;
    return clamp(ovRaw / 100, 0, 1);
  }

  // Back-compat name (used throughout the existing audio code)
  function getBellFrequency(bell) {
    return getBellHz(bell);
  }

  function playBellAt(bell, whenMs) {
    ensureAudio();
    const t = msToAudioTime(whenMs);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(getBellFrequency(bell), t);

    // v08_p05_sound_per_bell_overrides: per-bell volume scales on top of the global bell master volume
    const bellVol = getBellGain(bell);
    const MIN_G = 0.000001;
    let g0 = Math.max(MIN_G, 0.0001 * bellVol);
    let g1 = Math.max(MIN_G, 0.16 * bellVol);
    let g2 = Math.max(MIN_G, 0.001 * bellVol);
    if (g1 < g0) g1 = g0;

    gain.gain.setValueAtTime(g0, t);
    gain.gain.exponentialRampToValueAtTime(g1, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(g2, t + 0.28);

    osc.connect(gain).connect(bellMasterGain || audioCtx.destination);
    const tStop = t + 0.32;
    osc.start(t);
    osc.stop(tStop);

    scheduledBellNodes.push({ osc, gain, startAt: t, stopAt: tStop });
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
    }
    scheduledBellNodes.length = 0;
  }
  // === Bell master volume + Drone (background) ===
  const DRONE_FADE_SEC = 0.12;
  const DRONE_TONAL_LEVEL = 0.10;
  const DRONE_NOISE_LEVEL = 0.06;

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

  // v08_p07_drone_on_off_button: Drone On/Off UI (separate from drone type/pattern).
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
    const next = !!on;
    if (state.droneOn === next) {
      syncDroneOnOffUI();
      return;
    }

    state.droneOn = next;
    safeSetBoolLS(LS_DRONE_ON, next);

    if (next) {
      // Default behavior: turning the drone on unpauses it.
      state.dronePaused = false;
      try { startDrone(); } catch (_) {}
    } else {
      state.dronePaused = false;
      stopDrone();
    }

    syncDroneOnOffUI();
  }

  // Prompt 7: Drone Pause/Unpause (mute/unmute without stopping the drone)
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

    // Safety: if drone type is on but the drone graph doesn't exist, rebuild before resuming.
    if (!state.dronePaused && state.droneOn && !droneCurrent) {
      try { startDrone(); } catch (_) {}
    }

    applyDroneMasterGain();
    syncDronePauseBtnUI();
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
    if (!droneCurrent) return;
    const old = droneCurrent;
    droneCurrent = null;

    if (!audioCtx || !old.groupGain) {
      try { (old.nodes || []).forEach(n => { try { n.disconnect(); } catch (_) {} }); } catch (_) {}
      try { old.groupGain && old.groupGain.disconnect(); } catch (_) {}
      return;
    }

    const now = audioCtx.currentTime;
    const fade = DRONE_FADE_SEC;
    const g = old.groupGain;
    try {
      g.gain.cancelScheduledValues(now);
      const startVal = Math.max(0.0001, g.gain.value || 0.0001);
      g.gain.setValueAtTime(startVal, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + fade);
    } catch (_) {}

    const stopAt = now + fade + 0.02;
    (old.nodes || []).forEach(n => {
      try { if (n && typeof n.stop === 'function') n.stop(stopAt); } catch (_) {}
    });

    setTimeout(() => {
      try { (old.nodes || []).forEach(n => { try { n.disconnect(); } catch (_) {} }); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    }, Math.round((fade + 0.08) * 1000));
  }

  

  function computeDroneSpec(type, f, nyquist) {
    const MIN_F = 20;
    const MAX_F = Math.max(MIN_F, nyquist * 0.9);
    const clampVoiceFreq = (hz) => clamp(hz, MIN_F, MAX_F);
    const et = (semi) => Math.pow(2, semi / 12);

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
        delete out[i]._w;
      }

      return out;
    }

    function noiseSpec(opts) {
      const gain = opts && Number.isFinite(opts.gain) ? opts.gain : DRONE_NOISE_LEVEL;
      const lpFreq = clampVoiceFreq(f * 2);
      const lpQ = 0.9;

      const peakOn = !!(opts && opts.peak);
      const peak = peakOn ? {
        freq: clampVoiceFreq(f),
        Q: (opts.peak && Number.isFinite(opts.peak.Q)) ? opts.peak.Q : 4.0,
        gainDb: (opts.peak && Number.isFinite(opts.peak.gainDb)) ? opts.peak.gainDb : 6
      } : null;

      return { lpFreq, lpQ, gain, peak };
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

      case 'harm4':
        return { kind: 'tonal', voices: tonal([1, 2, 3, 4], [1.0, 0.6, 0.4, 0.3], [0, 0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'harm6':
        return { kind: 'tonal', voices: tonal([1, 2, 3, 4, 5, 6], [1.0, 0.7, 0.5, 0.4, 0.3, 0.25], [0, 0, 0, 0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'oddharm':
        return { kind: 'tonal', voices: tonal([1, 3, 5, 7], [1.0, 0.7, 0.5, 0.4], [0, 0, 0, 0], 'sine', DRONE_TONAL_LEVEL), noise: null };

      case 'shepard': {
        const ratios = [];
        const weights = [];
        const detunes = [];
        const sigma = 1.05;
        for (let k = -3; k <= 3; k++) {
          ratios.push(Math.pow(2, k));
          weights.push(Math.exp(-0.5 * (k / sigma) * (k / sigma)));
        }
        for (let i = 0; i < ratios.length; i++) detunes.push(i * 1.5 - 4.5);
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'cluster': {
        const ratios = [];
        for (let k = -3; k <= 3; k++) ratios.push(et(k));
        const weights = [0.35, 0.5, 0.75, 1.0, 0.75, 0.5, 0.35];
        const detunes = new Array(ratios.length).fill(0);
        return { kind: 'tonal', voices: tonal(ratios, weights, detunes, 'sine', DRONE_TONAL_LEVEL), noise: null };
      }

      case 'noise':
        return { kind: 'noise', voices: [], noise: noiseSpec({ gain: DRONE_NOISE_LEVEL }) };

      case 'resnoise':
        return { kind: 'noise', voices: [], noise: noiseSpec({ gain: DRONE_NOISE_LEVEL, peak: { Q: 4.0, gainDb: 6 } }) };

      case 'noisetone':
        return {
          kind: 'hybrid',
          voices: tonal([1], [1], [0], 'sine', DRONE_TONAL_LEVEL * 0.25),
          noise: noiseSpec({ gain: DRONE_NOISE_LEVEL * 0.75 })
        };

      default:
        return { kind: 'none', voices: [], noise: null };
    }
  }


  function startDrone() {
    if (!state.droneOn) { stopDrone(); return; }

    ensureAudio();
    applyDroneMasterGain();

    // Crossfade old -> new configuration
    stopDrone();

    const type = state.droneType;
    const now = audioCtx.currentTime;
    const nyquist = audioCtx.sampleRate * 0.5;
    const f = getDroneRootFrequency();
    const spec = computeDroneSpec(type, f, nyquist);

    const groupGain = audioCtx.createGain();
    groupGain.gain.setValueAtTime(0.0001, now);
    groupGain.connect(droneMasterGain || audioCtx.destination);

    const nodes = [groupGain];
    const voices = [];
    let noise = null;

    // Tonal voices
    (spec.voices || []).forEach(v => {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();

      osc.type = v.wave || 'sine';
      try { osc.frequency.setValueAtTime(Math.max(20, v.freq || 20), now); } catch (_) {}
      try { osc.detune.setValueAtTime(v.detune || 0, now); } catch (_) {}
      try { g.gain.setValueAtTime(Math.max(0, v.amp || 0), now); } catch (_) {}

      osc.connect(g);
      g.connect(groupGain);
      osc.start(now);

      nodes.push(osc, g);
      voices.push({ osc, gain: g });
    });

    // Noise path (optional)
    if (spec.noise) {
      const src = audioCtx.createBufferSource();
      src.buffer = getNoiseBuffer();
      src.loop = true;

      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      try { lp.frequency.setValueAtTime(Math.max(20, spec.noise.lpFreq || 20), now); } catch (_) {}
      try { lp.Q.setValueAtTime(spec.noise.lpQ || 0.9, now); } catch (_) {}

      let tail = lp;
      let peak = null;

      if (spec.noise.peak) {
        peak = audioCtx.createBiquadFilter();
        peak.type = 'peaking';
        try { peak.frequency.setValueAtTime(Math.max(20, spec.noise.peak.freq || 20), now); } catch (_) {}
        try { peak.Q.setValueAtTime(spec.noise.peak.Q || 4.0, now); } catch (_) {}
        try { peak.gain.setValueAtTime(spec.noise.peak.gainDb || 6, now); } catch (_) {}
        lp.connect(peak);
        tail = peak;
      }

      const ng = audioCtx.createGain();
      try { ng.gain.setValueAtTime(Math.max(0, spec.noise.gain || 0), now); } catch (_) {}

      src.connect(lp);
      tail.connect(ng);
      ng.connect(groupGain);

      src.start(now);

      nodes.push(src, lp, ng);
      if (peak) nodes.push(peak);

      noise = { src, lp, peak, gain: ng };
    }

    // Fail-safe: unknown type (shouldn't happen)
    if (spec.kind === 'none') {
      try { groupGain.disconnect(); } catch (_) {}
      return;
    }

    // Fade in
    try { groupGain.gain.exponentialRampToValueAtTime(1.0, now + DRONE_FADE_SEC); } catch (_) {}

    droneCurrent = { type, groupGain, nodes, voices, noise };
  }


  function refreshDrone() {
    if (!state.droneOn) return;

    // If structure changed, just rebuild
    if (!droneCurrent || droneCurrent.type !== state.droneType) {
      startDrone();
      return;
    }

    ensureAudio();
    applyDroneMasterGain();

    const now = audioCtx.currentTime;
    const t = now + 0.08;
    const nyquist = audioCtx.sampleRate * 0.5;
    const f = getDroneRootFrequency();
    const spec = computeDroneSpec(state.droneType, f, nyquist);

    const cur = droneCurrent;
    const curVoices = cur.voices || [];
    const newVoices = spec.voices || [];

    const curHasNoise = !!cur.noise;
    const newHasNoise = !!spec.noise;
    const curHasPeak = !!(cur.noise && cur.noise.peak);
    const newHasPeak = !!(spec.noise && spec.noise.peak);

    if (curVoices.length !== newVoices.length || curHasNoise !== newHasNoise || curHasPeak !== newHasPeak) {
      startDrone();
      return;
    }

    for (let i = 0; i < newVoices.length; i++) {
      const v = newVoices[i];
      const cv = curVoices[i];
      if (!cv || !cv.osc || !cv.gain) continue;

      const newFreq = Math.max(20, v.freq || 20);
      try {
        cv.osc.frequency.cancelScheduledValues(now);
        cv.osc.frequency.exponentialRampToValueAtTime(newFreq, t);
      } catch (_) {}

      try {
        cv.osc.detune.cancelScheduledValues(now);
        cv.osc.detune.linearRampToValueAtTime(v.detune || 0, t);
      } catch (_) {}

      try {
        cv.gain.gain.cancelScheduledValues(now);
        cv.gain.gain.linearRampToValueAtTime(Math.max(0, v.amp || 0), t);
      } catch (_) {}
    }

    if (spec.noise && cur.noise) {
      const n = spec.noise;
      const cn = cur.noise;

      try {
        cn.lp.frequency.cancelScheduledValues(now);
        cn.lp.frequency.exponentialRampToValueAtTime(Math.max(20, n.lpFreq || 20), t);
      } catch (_) {}

      try {
        cn.lp.Q.cancelScheduledValues(now);
        cn.lp.Q.linearRampToValueAtTime(n.lpQ || 0.9, t);
      } catch (_) {}

      try {
        cn.gain.gain.cancelScheduledValues(now);
        cn.gain.gain.linearRampToValueAtTime(Math.max(0, n.gain || 0), t);
      } catch (_) {}

      if (n.peak && cn.peak) {
        try {
          cn.peak.frequency.cancelScheduledValues(now);
          cn.peak.frequency.exponentialRampToValueAtTime(Math.max(20, n.peak.freq || 20), t);
        } catch (_) {}

        try {
          cn.peak.Q.cancelScheduledValues(now);
          cn.peak.Q.linearRampToValueAtTime(n.peak.Q || 4.0, t);
        } catch (_) {}

        try {
          cn.peak.gain.cancelScheduledValues(now);
          cn.peak.gain.linearRampToValueAtTime(n.peak.gainDb || 6, t);
        } catch (_) {}
      }
    }
  }


  // === Canvas helpers ===
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

      if (!stageText || !classText) {
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
          }
          if (stageText && classText) break;
          cur = cur.parentElement;
        }
      }

      let stageNum = parseInt(stageText, 10);
      if (!isFinite(stageNum)) continue;
      stageNum = clamp(stageNum, 1, 16);
      if (stageNum < 4 || stageNum > 12) continue;

      let pnNorm = pnRaw == null ? '' : String(pnRaw);
      pnNorm = pnNorm.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
      pnNorm = pnNorm.replace(/\s*,\s*/g, ',');

      const methodObj = {
        title: title,
        class: classText || '',
        stage: stageNum,
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

  function cccbParsePnTokens(pn) {
    if (pn == null) return [];
    let raw = String(pn);
    raw = raw.replace(/;/g, ' ').replace(/[\r\n]+/g, ' ').trim();
    if (!raw) return [];
    const parts = raw.split(/[.,\s]+/);
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

  function loadCCCBRMethod(i) {
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
      pnPresent: !!(m.pn && String(m.pn).trim())
    };

    state.stage = stage;
    if (bellCountSelect) bellCountSelect.value = String(stage);

    let rows = null;
    if (m.pn && String(m.pn).trim()) {
      try {
        rows = cccbRowsFromPn(stage, m.pn, 5);
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

  // Prompt 5: in-game header meta sync
  function syncGameHeaderMeta() {
    try {
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

  function rebuildBellFrequencies() {
    const def = getScaleDef();
    const rootFreq = getBellRootFrequency();
    const intervals = downsampleIntervals(def.intervals, state.stage); // ascending low->high
    const freq = [];
    for (let bell = 1; bell <= state.stage; bell++) {
      const off = intervals[state.stage - bell]; // bell 1 highest
      freq.push(rootFreq * Math.pow(2, off / 12));
    }
    state.bellFreq = freq;
    try { syncBellOverridesEffectiveUI(); } catch (_) {}
  }

  // v08_p05_sound_per_bell_overrides: per-bell sound overrides (UI + persistence)
  function ensureBellOverridesArrays() {
    if (!Array.isArray(state.bellHzOverride) || state.bellHzOverride.length < 13) state.bellHzOverride = new Array(13).fill(null);
    if (!Array.isArray(state.bellVolOverride) || state.bellVolOverride.length < 13) state.bellVolOverride = new Array(13).fill(null);
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

  function syncBellOverridesEffectiveUI() {
    if (!bellOverridesList) return;
    ensureBellOverridesArrays();
    const base = clamp(Number(state.bellVolume) || 0, 0, 100);

    for (let b = 1; b <= state.stage; b++) {
      const hzEl = document.getElementById('bellHzEffective_' + b);
      if (hzEl) {
        const hasOv = (state.bellHzOverride[b] != null) && Number.isFinite(Number(state.bellHzOverride[b]));
        hzEl.textContent = 'Eff: ' + fmtHz(getBellHz(b)) + ' Hz' + (hasOv ? ' (override)' : '');
      }

      const volEl = document.getElementById('bellVolEffective_' + b);
      if (volEl) {
        const ovRaw = (state.bellVolOverride[b] != null) ? Number(state.bellVolOverride[b]) : NaN;
        const hasOv = Number.isFinite(ovRaw);
        const factor = hasOv ? clamp(ovRaw / 100, 0, 1) : 1;
        const eff = base * factor;
        volEl.textContent = 'Eff: ' + fmtPct(eff) + '%' + (hasOv ? (' (x' + fmtPct(ovRaw) + '%)') : '');
      }
    }
  }

  function rebuildBellOverridesUI() {
    if (!bellOverridesList) return;
    ensureBellOverridesArrays();

    let html = '';
    for (let b = 1; b <= state.stage; b++) {
      const g = bellToGlyph(b);
      const hzV = (state.bellHzOverride[b] != null && Number.isFinite(Number(state.bellHzOverride[b]))) ? String(state.bellHzOverride[b]) : '';
      const volV = (state.bellVolOverride[b] != null && Number.isFinite(Number(state.bellVolOverride[b]))) ? String(state.bellVolOverride[b]) : '';
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
              '<button type="button" class="pill rg-mini" data-act="clearHz" data-bell="' + b + '">Clear</button>' +
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
        '</div>' +
      '</div>';
    }

    bellOverridesList.innerHTML = html;
    syncBellOverridesEffectiveUI();
  }

  function clearBellHzOverride(b) {
    ensureBellOverridesArrays();
    const bb = clamp(parseInt(b, 10) || 0, 1, 12);
    state.bellHzOverride[bb] = null;
    saveBellHzOverridesToLS();
    const input = document.getElementById('bellHzOverride_' + bb);
    if (input) input.value = '';
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

  function resetAllBellOverrides() {
    state.bellHzOverride = new Array(13).fill(null);
    state.bellVolOverride = new Array(13).fill(null);
    safeDelLS(LS_BELL_HZ_OVERRIDE);
    safeDelLS(LS_BELL_VOL_OVERRIDE);
    rebuildBellOverridesUI();
  }

  function currentTrebleToneLabel() { return getScaleDef().label; }
  function currentOctaveLabel() { return 'C' + String(state.octaveC); }

  // === Selection ===
  function ensureLiveBells() {
    const max = state.liveCount;
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

  function rebuildKeybindPanel() {
    if (!keybindPanel) return;
    ensureKeyBindings();

    const live = state.liveBells.slice().sort((a,b)=>a-b);
    keybindPanel.innerHTML = '';

    if (!live.length) {
      keybindPanel.textContent = 'No scored bells selected.';
      if (keybindNote) keybindNote.textContent = '';
      return;
    }

    const conflicts = getLiveKeyConflicts();

    live.forEach(b => {
      const row = document.createElement('div');
      row.className = 'keybind-row';
      if (conflicts.has(b)) row.classList.add('conflict');
      if (state.keybindCaptureBell === b) row.classList.add('capture');

      const bellLabel = document.createElement('span');
      bellLabel.className = 'keybind-bell';
      bellLabel.textContent = 'Bell ' + bellToGlyph(b);

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
        state.keybindCaptureBell = (state.keybindCaptureBell === b) ? null : b;
        rebuildKeybindPanel();
      });

      const micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'pill keybind-bind-btn keybind-mic-btn';
      micBtn.textContent = 'Mic';
      micBtn.setAttribute('data-mic-bell', String(b));
      micBtn.title = 'Toggle mic input for this bell';
      const micOn = (state.micBells || []).includes(b);
      micBtn.classList.toggle('mic-on', micOn);
      micBtn.setAttribute('aria-pressed', micOn ? 'true' : 'false');
      micBtn.setAttribute('aria-label', micOn ? `Mic on for bell ${bellToGlyph(b)}` : `Mic off for bell ${bellToGlyph(b)}`);
      micBtn.addEventListener('click', () => {
        markUserTouchedConfig();
        const set = new Set(state.micBells || []);
        if (set.has(b)) set.delete(b);
        else set.add(b);
        state.micBells = Array.from(set).sort((x, y) => x - y);
        rebuildMicBellControls();
        syncMicToggleUI();
      });

      row.appendChild(bellLabel);
      row.appendChild(keyLabel);
      row.appendChild(btn);
      row.appendChild(micBtn);

      keybindPanel.appendChild(row);
    });

    if (keybindResetBtn) keybindResetBtn.disabled = state.phase !== 'idle';

    if (keybindNote) {
      if (state.keybindCaptureBell != null) {
        keybindNote.textContent = 'Press a letter/number key, Space, or Enter (Esc to cancel).';
      } else if (live.length === 1) {
        keybindNote.textContent = 'Tip: Space and Enter also ring the only scored bell.';
      } else if (conflicts.size) {
        keybindNote.textContent = 'Fix conflicts: each key can be bound to only one scored bell.';
      } else keybindNote.textContent = '';
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
        const on = Number.isFinite(bell) && (state.micBells || []).includes(bell);
        btn.classList.toggle('mic-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? `Mic on for bell ${bellToGlyph(bell)}` : `Mic off for bell ${bellToGlyph(bell)}`);
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

  function registerMicHit(bell, timeMs) {
    if (state.mode !== 'play') return;
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
        const target = pickMicTargetInWindow(nowMs);
        if (target) {
          registerMicHit(target.bell, nowMs);
          state.micLastFireTimeMs = nowMs;
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
    releaseWakeLock();
    markRung(bell, now);
    playBellAt(bell, now);
    if (state.mode === 'play' && state.phase === 'running') scoreHit(bell, now);
    if (state.phase === 'idle') kickLoop();
  }

  // v08_p06_sound_testpad_tap_to_ring: ring bell for Sound test pad (no scoring, no run state)
  function ringBellTestPad(bell) {
    const b = parseInt(bell, 10) || 0;
    if (b < 1 || b > state.stage) return;
    const now = perfNow();
    playBellAt(b, now);
  }

  // === Stats ===
  function resetStats() {
    state.statsByBell = {};
    for (let b = 1; b <= state.stage; b++) {
      state.statsByBell[b] = { bell: b, hits: 0, misses: 0, sumAbsDelta: 0, sumSignedDelta: 0, score: 0, comboCurrent: 0, comboBest: 0 };
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

  function updateMisses(nowMs) {
    const live = new Set(state.liveBells);
    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;
    let didChange = false;
    for (const t of state.targets) {
      if (t.judged) continue;
      if (nowMs > t.timeMs + halfBeat) {
        t.judged = true;
        if (live.has(t.bell)) {
          const s = state.statsByBell[t.bell];
          s.misses += 1;
          s.comboCurrent = 0;
          state.comboCurrentGlobal = 0;
          didChange = true;
        }
      }
    }
    const cutoff = nowMs - 8000;
    while (state.targets.length && state.targets[0].timeMs < cutoff && state.targets[0].judged) state.targets.shift();
    if (didChange) markDirty();
  }

  function finalizePendingAsMisses(nowMs) {
    state.targets = state.targets.filter(t => t.timeMs <= nowMs);
    const live = new Set(state.liveBells);
    for (const t of state.targets) {
      if (t.judged) continue;
      t.judged = true;
      if (live.has(t.bell)) {
        const s = state.statsByBell[t.bell];
        s.misses += 1;
        s.comboCurrent = 0;
        state.comboCurrentGlobal = 0;
      }
    }
  }

  function scoreHit(bell, timeMs) {
    if (state.phase !== 'running') return;
    if (!state.liveBells.includes(bell)) return;

    const beatMs = 60000 / state.bpm;
    const halfBeat = beatMs / 2;

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
        const nextRow = state.rows[Math.min(rowIdx + 1, state.rows.length - 1)] || currentRow;

        const padX = 14, padY = 12, gapY = 10;
        const rowBlockH = (H - padY * 2 - gapY) / 2;
        const cellW = (W - padX * 2) / stage;

        function drawRow(row, yTop, highlightPos, faded, rowKind) {
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

            sctx.fillText(bellToGlyph(bell), x, y);
          }
          sctx.restore();
        }

        drawRow(currentRow, padY, pos, false, 'N');
        drawRow(nextRow, padY + rowBlockH + gapY, -1, true, 'N1');
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

          sctx.fillText(bellToGlyph(bell), x, y);
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
      dctx.fillText(bellToGlyph(bell), cx, cy);
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
      dctx.fillText(bellToGlyph(bell), p.x, p.y);
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
    // v08_p03_two_page_present_peek: in two-page mode, arrows turn the PRESENT page by one page.
    const delta = 1;
    ui.notationPage = (Number(ui.notationPage) || 0) - delta;
    if (ui.notationPage < 0) ui.notationPage = 0;
    syncNotationPagingUI();
  }

  function notationNextPressed() {
    ui.notationFollow = false;
    const { lastLeft, lastPage } = getNotationPagingMeta();
    const onePage = (ui.notationLayout === 'one_page');
    // v08_p03_two_page_present_peek: in two-page mode, arrows turn the PRESENT page by one page.
    const delta = 1;
    const maxP = onePage ? lastPage : lastLeft;
    ui.notationPage = (Number(ui.notationPage) || 0) + delta;
    if (ui.notationPage > maxP) ui.notationPage = maxP;
    syncNotationPagingUI();
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
    const highlightRowIdx = onePage ? activeRowIdx : (ui.notationFollow ? activeRowIdx : pageAStart);

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
          nctx.fillText(bellToGlyph(bell), x, y);
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
          nctx.fillText(bellToGlyph(bell), x, y);
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
            if (pathSet && pathSet.has(bell)) {
              const yMark = y + markerDY;
              nctx.beginPath();
              nctx.moveTo(x - markerW / 2, yMark);
              nctx.lineTo(x + markerW / 2, yMark);
              nctx.stroke();
            }
            nctx.fillStyle = isActive ? (isLive ? '#ffffff' : '#c6cbe0') : (isLive ? '#dde8ff' : 'rgba(154,162,187,0.92)');
            nctx.fillText(bellToGlyph(bell), x, y);
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

    statsDiv.innerHTML = html;
    renderScoringExplanation();
  }

  // === Engine start/stop + analytics ===
  function startPressed(mode) {
    if (!state.rows.length) { alert('No rows loaded.'); return; }
    if (state.phase !== 'idle') return;

    // v08_p04_demo_profile_defaults: any run (Play or Demo) means the session is no longer pristine.
    ui.hasRunStartedThisSession = true;

    state.mode = (mode === 'demo') ? 'demo' : 'play';
    requestWakeLock();

    state.keybindCaptureBell = null;
    rebuildKeybindPanel();

    const playId = rid('p_');
    state.currentPlay = { playId, began: false, mode: state.mode };

    const tempoBpm = clamp(parseInt(bpmInput.value, 10) || 80, 1, 240);
    state.bpm = tempoBpm;
    bpmInput.value = String(state.bpm);
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
    if (state.mode === 'play' && state.micEnabled && !state.micActive && getMicControlledBells().length) startMicCapture();

    const now = perfNow();

    state.phase = 'countdown';
    state.pausePrevPhase = '';
    state.pauseAtMs = 0;
    state.elapsedMs = 0;
    state.runStartPerfMs = 0;
    state.schedBeatIndex = 0;
    state.execBeatIndex = 0;
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
      const payload = buildPlayEndPayload(now, endReason);
      payload.mode = runMode;
      if (runMode === 'play') updateVisitorTotals(payload);
      state.currentPlay = null;
    }

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

    // Stop auto-ringing immediately by canceling already-scheduled future strikes.
    cancelScheduledBellAudioNow();

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


    function scheduleMethod(nowMs) {
    if (state.phase === 'paused') return;
    if (state.phase !== 'running' && !(state.mode === 'demo' && state.phase === 'countdown')) return;
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
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

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
      const stage = clamp(parseInt(state.stage, 10) || 0, 1, 12);
      for (let b = 1; b <= stage; b++) {
        if (state.keyBindings && state.keyBindings[b] === k) {
          if (found != null) { found = null; break; }
          found = b;
        }
      }
      if (found != null) {
        if (k === 'Space') e.preventDefault();
        ringBellTestPad(found);
      }
      return;
    }

    // Default extra keys: if exactly one live bell is selected, Space and Enter also ring it.
    if (state.liveBells.length === 1 && (k === 'Space' || k === 'Enter')) {
      e.preventDefault();
      ringBell(state.liveBells[0]);
      return;
    }

    // Keybinding match for live bells (ignore conflicts).
    let found = null;
    for (const b of state.liveBells) {
      if (state.keyBindings[b] === k) {
        if (found != null) { found = null; break; }
        found = b;
      }
    }
    if (found != null) {
      if (k === 'Space') e.preventDefault();
      ringBell(found);
      return;
    }
  });

  // Display tap: ring the tapped bell (standard touch control).
  displayCanvas.addEventListener('pointerdown', (e) => {
    const bell = displayHitTest(e.clientX, e.clientY);
    if (bell != null) { e.preventDefault(); ringBell(bell); }
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
    ringBell(hit.bell);

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
    ringBell(hit.bell);

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
    ringBell(hit.bell);

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
    ringBell(hit.bell);
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


  methodSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    const v = methodSelect.value;
    state.method = v;

    if (v !== 'custom') {
      state.customRows = null;
      state.methodSource = 'built_in';
      state.methodMeta = null;
    } else {
      // Selecting "Custom" from the dropdown is not a library claim.
      if (state.methodSource !== 'library') {
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
    ensurePathBells(); rebuildPathPicker(); computeRows(); resetStats(); rebuildBellFrequencies(); rebuildBellOverridesUI();
    syncGameHeaderMeta();
    renderScoringExplanation();
  });

  liveCountSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    state.liveCount = clamp(parseInt(liveCountSelect.value,10)||1, 1, state.stage);
    ensureLiveBells(); rebuildBellPicker(); resetStats();
  });

  bpmInput.addEventListener('change', () => {
    markUserTouchedConfig();
    ensureIdleForPlayChange();
    state.bpm = clamp(parseInt(bpmInput.value,10)||80, 1, 240);
    bpmInput.value = String(state.bpm);
    syncGameHeaderMeta();
  });

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

  // Layout preset selector (persisted)
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
      } else if (el.id.startsWith('bellVolOverride_')) {
        did = true;
        markUserTouchedConfig();
        saveBellVolOverridesToLS();
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

      const btn = (e && e.target && e.target.closest) ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset && btn.dataset.act ? String(btn.dataset.act) : '';
      const b = clamp(parseInt((btn.dataset && btn.dataset.bell) || '0', 10) || 0, 1, 12);

      if (act === 'clearHz') {
        markUserTouchedConfig();
        clearBellHzOverride(b);
        onBellTuningChanged();
      } else if (act === 'clearVol') {
        markUserTouchedConfig();
        clearBellVolOverride(b);
        onBellTuningChanged();
      }
    });
  }

  scaleSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.scaleKey = scaleSelect.value;
    syncBellCustomHzUI();
    rebuildBellFrequencies();
    onBellTuningChanged();
  });

  octaveSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.octaveC = parseInt(octaveSelect.value, 10) || 3;
    rebuildBellFrequencies();
    onBellTuningChanged();
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

  if (droneOnOffBtn) {
    droneOnOffBtn.addEventListener('click', () => {
      markUserTouchedConfig();
      setDroneOn(!state.droneOn);
    });
  }

  droneTypeSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneType = droneTypeSelect.value;
    if (state.droneOn) startDrone();
    syncDronePauseBtnUI();
  });

  droneScaleSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneScaleKey = droneScaleSelect.value;
    syncDroneCustomHzUI();
    if (state.droneOn) refreshDrone();
  });

  droneOctaveSelect.addEventListener('change', () => {
    markUserTouchedConfig();
    state.droneOctaveC = parseInt(droneOctaveSelect.value, 10) || 3;
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
    applyDroneMasterGain();
  });

  fileInput.addEventListener('change', () => {
    if (state.phase !== 'idle') return;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    markUserTouchedConfig();

    const reader = new FileReader();
    reader.onload = (ev) => {
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



  function syncPrivacyToggleUI() { syncAudienceConsentUI(); }

  function enableAudienceMeasurement() {
    setAudienceConsent('1');
    syncAudienceConsentUI();
  }

  function disableAudienceMeasurement() {
    setAudienceConsent('0');
    syncAudienceConsentUI();
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
          });
        }

  }

  function boot() {
    // v08_p04_demo_profile_defaults: ignore config-change tracking during boot.
    ui.isBooting = true;

    mountMenuControls();

    // Play defaults (non-persisted)
    state.method = 'plainhunt';
    if (methodSelect) methodSelect.value = 'plainhunt';

    state.methodSource = 'built_in';
    state.methodMeta = null;

    state.stage = 6;
    if (bellCountSelect) bellCountSelect.value = '6';

    state.liveCount = 1;
    state.liveBells = [1];

    state.bpm = 120;
    if (bpmInput) bpmInput.value = String(state.bpm);

    loadKeyBindings();

    // swaps view settings (persisted)
    state.spotlightSwapsView = safeGetBoolLS(LS_SPOTLIGHT_SWAPS_VIEW, true);
    state.spotlightShowN = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N, true);
    state.spotlightShowN1 = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N1, false);
    state.spotlightShowN2 = safeGetBoolLS(LS_SPOTLIGHT_SHOW_N2, true);
    state.notationSwapsOverlay = safeGetBoolLS(LS_NOTATION_SWAPS_OVERLAY, true);
    state.displayLiveBellsOnly = safeGetBoolLS(LS_DISPLAY_LIVE_BELLS_ONLY, isMobileLikely());

    loadMicPrefs();

    loadBellOverridesFromLS();

    if (!state.spotlightShowN && !state.spotlightShowN1 && !state.spotlightShowN2) state.spotlightShowN = true;

    if (spotlightSwapsView) spotlightSwapsView.checked = state.spotlightSwapsView;
    if (spotlightShowN) spotlightShowN.checked = state.spotlightShowN;
    if (spotlightShowN1) spotlightShowN1.checked = state.spotlightShowN1;
    if (spotlightShowN2) spotlightShowN2.checked = state.spotlightShowN2;
    if (notationSwapsOverlay) notationSwapsOverlay.checked = state.notationSwapsOverlay;
    if (displayLiveOnly) displayLiveOnly.checked = state.displayLiveBellsOnly;


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
    state.droneOctaveC = 4;
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

    // Sliders/defaults
    bellVolume.value = String(state.bellVolume);
    droneTypeSelect.value = state.droneType;
    droneVolume.value = String(state.droneVolume);

    // Custom Hz controls
    syncBellCustomHzUI();
    syncDroneCustomHzUI();

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

    // View default: line (blue line) = bell 1
    state.pathBells = [1];
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


    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseWakeLock();
        if (state.phase !== 'idle') {
          if (state.mode === 'play') {
            stopPressed('sleep');
          } else if (state.mode === 'demo') {
            const nowMs = perfNow();
            scheduleCountdown(nowMs);

            const beatMs = 60000 / state.bpm;
            const horizonMs = demoEffectiveHorizonMs();
            const totalBeats = state.rows.length * state.stage;

            let passes = 0;
            const maxPasses = Math.ceil(DEMO_MAX_AHEAD_STRIKES / DEMO_SCHED_MAX_PER_PASS) + 4;
            while (passes < maxPasses) {
              const before = state.schedBeatIndex;
              scheduleMethod(nowMs);
              passes += 1;

              if (state.schedBeatIndex === before) break;
              if (state.schedBeatIndex >= totalBeats) break;

              const nextT = state.methodStartMs + state.schedBeatIndex * beatMs;
              if (nextT > nowMs + horizonMs) break;
            }
          }
        }
      } else {
        if (state.phase !== 'idle') {
          requestWakeLock();
          if (state.mode === 'demo') {
            const nowMs = perfNow();
            resyncDemoToNow(nowMs);
            scheduleCountdown(nowMs);
            scheduleMethod(nowMs);
          }
        }
        markDirty();
      }
    });

    window.addEventListener('resize', () => { markDirty(); });

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

    ui.isBooting = false;
  }

  boot();
})();
    
