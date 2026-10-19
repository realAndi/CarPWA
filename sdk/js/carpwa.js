/*!
 * CarPWA SDK
 * Bridges a web page running on the CarPlay screen to CarPlay itself (through
 * the CarPWA tweak) and to the on-phone server (carpwad).
 *
 * Loaded automatically from /_carpwa/sdk.js on every CarPWA app port, or bundled
 * from the `carpwa` npm package. Safe to load twice.
 */
(function (global) {
  'use strict';

  if (global.CarPWA && global.CarPWA.__sdk) return;

  var VERSION = '1.0.0';
  var CALL_TIMEOUT_MS = 15000;
  // Calls that wait for the driver, not for the system: no timeout.
  var NO_TIMEOUT = { 'ui.alert': 1 };
  var SERVER_MODULES = { storage: 1, channel: 1, net: 1, app: 1, dev: 1 };
  // Server events that are pushed without a $subscribe call.
  var SERVER_PUSHED = { 'channel.message': 1, 'storage.changed': 1, 'dev.reload': 1 };

  // ---------------------------------------------------------------- errors

  function CarPWAError(code, message, details) {
    var err = new Error(message || code);
    Object.setPrototypeOf(err, CarPWAError.prototype);
    err.name = 'CarPWAError';
    err.code = code || 'EINTERNAL';
    if (details !== undefined) err.details = details;
    return err;
  }
  CarPWAError.prototype = Object.create(Error.prototype);
  CarPWAError.prototype.constructor = CarPWAError;

  function toError(e) {
    if (e instanceof CarPWAError) return e;
    if (e && typeof e === 'object' && e.code) return CarPWAError(e.code, e.message, e.details);
    var text = String((e && e.message) || e || 'Unknown error');
    var m = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/.exec(text);
    return m ? CarPWAError(m[1], m[2]) : CarPWAError('EINTERNAL', text);
  }

  // --------------------------------------------------------------- emitter

  function Emitter() { this._l = Object.create(null); }
  Emitter.prototype.on = function (name, fn) {
    (this._l[name] || (this._l[name] = [])).push(fn);
    return this;
  };
  Emitter.prototype.off = function (name, fn) {
    var list = this._l[name];
    if (!list) return this;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete this._l[name];
    return this;
  };
  Emitter.prototype.count = function (name) { return (this._l[name] || []).length; };
  Emitter.prototype.emit = function (name, data) {
    var list = (this._l[name] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { setTimeout(function () { throw e; }); }
    }
  };

  // ------------------------------------------------------------ transports

  // Inside CarPlay: WKScriptMessageHandlerWithReply named "carpwa".
  function NativeCarTransport(handler, onEvent) {
    this.kind = 'carplay';
    this._handler = handler;
    this._id = 0;
    global.__carpwa_native_event = function (evt) {
      if (typeof evt === 'string') { try { evt = JSON.parse(evt); } catch (e) { return; } }
      if (evt && evt.type === 'event') onEvent(evt);
    };
  }
  NativeCarTransport.prototype.call = function (module, method, params) {
    var msg = { id: ++this._id, type: 'call', module: module, method: method, params: params || {} };
    var reply;
    try { reply = this._handler.postMessage(msg); } catch (e) { return Promise.reject(toError(e)); }
    if (!reply || typeof reply.then !== 'function') {
      return Promise.reject(CarPWAError('EUNAVAILABLE', 'CarPWA native bridge did not return a reply'));
    }
    return withTimeout(reply.then(function (v) { return v === undefined ? null : v; }, function (e) { throw toError(e); }),
      module + '.' + method);
  };

  // Desktop simulator (`carpwa sim`): the parent frame exposes a compatible bridge.
  function findSimulator() {
    try {
      if (global.__CARPWA_SIM__) return global.__CARPWA_SIM__;
      if (global.parent && global.parent !== global && global.parent.__CARPWA_SIM__) return global.parent.__CARPWA_SIM__;
    } catch (e) { /* cross-origin parent */ }
    return null;
  }

  function SimCarTransport(sim, onEvent) {
    this.kind = 'simulator';
    this._sim = sim;
    sim.attach(global, onEvent);
  }
  SimCarTransport.prototype.call = function (module, method, params) {
    var self = this;
    return withTimeout(Promise.resolve().then(function () {
      return self._sim.call(module, method, params || {});
    }).catch(function (e) { throw toError(e); }), module + '.' + method);
  };

  // carpwad: one WebSocket to this app's own port.
  function ServerTransport(url, onEvent, onState) {
    this.url = url;
    this._onEvent = onEvent;
    this._onState = onState;
    this._id = 0;
    this._pending = Object.create(null);
    this._queue = [];
    this._ws = null;
    this._retry = 0;
    this._closed = false;
    this.connected = false;
    this._connect();
  }
  ServerTransport.prototype._connect = function () {
    var self = this;
    var ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._scheduleReconnect(); return; }
    this._ws = ws;
    ws.onopen = function () {
      self._retry = 0;
      self.connected = true;
      var q = self._queue; self._queue = [];
      q.forEach(function (raw) { ws.send(raw); });
      self._onState(true);
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'event') { self._onEvent(msg); return; }
      var p = self._pending[msg.id];
      if (!p) return;
      delete self._pending[msg.id];
      clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(toError(msg.error || {}));
      else p.resolve(msg.result === undefined ? null : msg.result);
    };
    ws.onclose = function () {
      var wasConnected = self.connected;
      self.connected = false;
      if (wasConnected) self._onState(false);
      self._scheduleReconnect();
    };
    ws.onerror = function () { /* onclose follows */ };
  };
  ServerTransport.prototype._scheduleReconnect = function () {
    if (this._closed) return;
    var self = this;
    var delay = Math.min(10000, 250 * Math.pow(2, this._retry++));
    setTimeout(function () { self._connect(); }, delay);
  };
  ServerTransport.prototype.call = function (module, method, params) {
    var self = this;
    var id = ++this._id;
    var raw = JSON.stringify({ id: id, type: 'call', module: module, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete self._pending[id];
        reject(CarPWAError('ETIMEOUT', module + '.' + method + ' timed out'));
      }, CALL_TIMEOUT_MS);
      self._pending[id] = { resolve: resolve, reject: reject, timer: timer };
      if (self.connected && self._ws && self._ws.readyState === 1) self._ws.send(raw);
      else self._queue.push(raw);
    });
  };

  function withTimeout(promise, label) {
    if (NO_TIMEOUT[label]) return promise;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(CarPWAError('ETIMEOUT', label + ' timed out')); }, CALL_TIMEOUT_MS);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // ------------------------------------------------------------------ core

  var native = global.__CARPWA_NATIVE__ || null;
  var events = new Emitter();       // "module.event" → listeners
  var subCounts = Object.create(null);
  var joinedChannels = Object.create(null);
  var carTransport = null;
  var serverTransport = null;
  var readyResolve;
  var readyPromise = new Promise(function (r) { readyResolve = r; });

  function dispatch(evt) {
    var key = evt.module + '.' + evt.event;
    if (key === 'dev.reload') { scheduleReload(evt.data); }
    if (evt.module === 'car' || evt.module === 'screen') updateCachedState(evt);
    events.emit(key, evt.data);
    events.emit(evt.module + '.*', { event: evt.event, data: evt.data });
  }

  function scheduleReload(data) {
    if (CarPWA.config.autoReload === false) return;
    setTimeout(function () { global.location.reload(); }, (data && data.delay) || 50);
  }

  function readQueryToken() {
    try {
      var params = new URLSearchParams(global.location.search);
      var t = params.get('carpwa_devtoken');
      if (t) { global.sessionStorage.setItem('carpwa_devtoken', t); return t; }
      return global.sessionStorage.getItem('carpwa_devtoken');
    } catch (e) { return null; }
  }

  function serverURL() {
    var loc = global.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return null;
    var url = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/_carpwa/ws';
    if (native && native.sessionKey) return url + '?key=' + encodeURIComponent(native.sessionKey);
    var sim = findSimulator();
    if (sim) return url + '?sim=1';
    var token = readQueryToken();
    return token ? url + '?devtoken=' + encodeURIComponent(token) : url;
  }

  function call(module, method, params) {
    if (typeof module !== 'string' || typeof method !== 'string') {
      return Promise.reject(CarPWAError('EINVAL', 'call(module, method, params) needs two strings'));
    }
    if (SERVER_MODULES[module]) {
      if (!serverTransport) return Promise.reject(CarPWAError('EUNAVAILABLE', 'Not served by carpwad; ' + module + '.' + method + ' needs the CarPWA server'));
      return serverTransport.call(module, method, params);
    }
    if (!carTransport) {
      return Promise.reject(CarPWAError('ENOTCAR', module + '.' + method + ' is only available on the CarPlay screen (or in `carpwa sim`)'));
    }
    return carTransport.call(module, method, params);
  }

  function on(module, event, fn) {
    var key = module + '.' + event;
    events.on(key, fn);
    if (!SERVER_PUSHED[key] && !SERVER_MODULES[module]) {
      subCounts[key] = (subCounts[key] || 0) + 1;
      if (subCounts[key] === 1 && carTransport) {
        call(module, '$subscribe', { event: event }).catch(function (e) { warn('subscribe ' + key, e); });
      }
    }
    return function () { off(module, event, fn); };
  }

  function off(module, event, fn) {
    var key = module + '.' + event;
    var before = events.count(key);
    events.off(key, fn);
    if (events.count(key) === before) return;
    if (subCounts[key]) {
      subCounts[key]--;
      if (!subCounts[key]) {
        delete subCounts[key];
        if (carTransport) call(module, '$unsubscribe', { event: event }).catch(function () {});
      }
    }
  }

  function once(module, event, fn) {
    var unsub = on(module, event, function (data) { unsub(); fn(data); });
    return unsub;
  }

  function warn(what, e) {
    if (global.console && console.warn) console.warn('[CarPWA] ' + what + ' failed:', e && (e.code + ' ' + e.message));
  }

  function moduleOn(module) {
    return function (event, fn) { return on(module, event, fn); };
  }
  function moduleOff(module) {
    return function (event, fn) { off(module, event, fn); };
  }
  function bind(module, method) {
    return function (params) { return call(module, method, params || {}); };
  }

  // ------------------------------------------------------ cached car state

  var state = {
    car: native && native.initialState ? native.initialState.car || null : null,
    screen: native && native.initialState ? native.initialState.screen || null : null
  };

  function updateCachedState(evt) {
    if (evt.module === 'car' && evt.event === 'state' && evt.data) {
      state.car = evt.data.state || evt.data;
      applyTheme();
    } else if (evt.module === 'screen' && evt.event === 'change' && evt.data) {
      state.screen = evt.data;
      applyTheme();
    }
  }

  // Exposes car state to CSS so layouts can react without JavaScript:
  //   html[data-carpwa-appearance="dark"], html[data-carpwa-input="knob"],
  //   html[data-carpwa-limited], var(--carpwa-safe-top) …
  function applyTheme() {
    var doc = global.document;
    if (!doc || !doc.documentElement || CarPWA.config.theme === false) return;
    var root = doc.documentElement;
    var car = state.car || {};
    var screen = state.screen || {};
    root.setAttribute('data-carpwa', CarPWA.env.mode);
    if (car.appearance) root.setAttribute('data-carpwa-appearance', car.appearance);
    root.toggleAttribute('data-carpwa-night', !!car.nightMode);
    root.toggleAttribute('data-carpwa-limited', !!car.limitedUI);
    var primary = screen.interaction && screen.interaction.primary;
    if (primary) root.setAttribute('data-carpwa-input', primary);
    var safe = car.safeArea || screen.safeArea;
    if (safe) {
      ['top', 'left', 'bottom', 'right'].forEach(function (k) {
        root.style.setProperty('--carpwa-safe-' + k, (safe[k] || 0) + 'px');
      });
    }
    if (screen.width) root.style.setProperty('--carpwa-width', screen.width + 'px');
    if (screen.height) root.style.setProperty('--carpwa-height', screen.height + 'px');
  }

  // ------------------------------------------------------- spatial focus

  // Turns knob / touchpad / D-pad input into DOM focus movement. Elements get
  // the class `carpwa-focused`; "select" clicks the focused element.
  var focus = (function () {
    var opts = null;
    var current = null;
    var unsubs = [];
    var DEFAULT_SELECTOR = '[data-carpwa-focus], button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

    function candidates() {
      var root = (opts && opts.root) || global.document;
      return Array.prototype.filter.call(root.querySelectorAll(opts.selector), function (el) {
        if (el.closest('[data-carpwa-nofocus]')) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && global.getComputedStyle(el).visibility !== 'hidden';
      });
    }

    function set(el) {
      if (current === el) return;
      if (current) { current.classList.remove(opts.className); current.dispatchEvent(new CustomEvent('carpwa:blur', { bubbles: true })); }
      current = el || null;
      if (!current) return;
      current.classList.add(opts.className);
      try { current.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
      if (current.scrollIntoView) current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      current.dispatchEvent(new CustomEvent('carpwa:focus', { bubbles: true }));
    }

    function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    function move(direction) {
      var list = candidates();
      if (!list.length) return;
      if (!current || list.indexOf(current) < 0) { set(list[0]); return; }
      var idx = list.indexOf(current);
      if (direction === 'next' || direction === 'previous') {
        var step = direction === 'next' ? 1 : -1;
        var nextIdx = idx + step;
        if (nextIdx < 0 || nextIdx >= list.length) {
          if (!opts.wrap) return;
          nextIdx = (nextIdx + list.length) % list.length;
        }
        set(list[nextIdx]);
        return;
      }
      var from = center(current.getBoundingClientRect());
      var best = null;
      var bestScore = Infinity;
      list.forEach(function (el) {
        if (el === current) return;
        var c = center(el.getBoundingClientRect());
        var dx = c.x - from.x;
        var dy = c.y - from.y;
        var primary, secondary;
        if (direction === 'up') { primary = -dy; secondary = Math.abs(dx); }
        else if (direction === 'down') { primary = dy; secondary = Math.abs(dx); }
        else if (direction === 'left') { primary = -dx; secondary = Math.abs(dy); }
        else { primary = dx; secondary = Math.abs(dy); }
        if (primary <= 1) return;
        var score = primary + secondary * 2;
        if (score < bestScore) { bestScore = score; best = el; }
      });
      if (best) set(best);
    }

    return {
      enable: function (options) {
        this.disable();
        opts = Object.assign({ selector: DEFAULT_SELECTOR, className: 'carpwa-focused', wrap: true, root: null }, options || {});
        unsubs.push(on('input', 'move', function (e) { move(e && e.direction); }));
        unsubs.push(on('input', 'select', function (e) {
          if (e && e.phase === 'down') return;
          if (current) current.click();
        }));
        call('input', 'setCaptureMode', { mode: 'app' }).catch(function (e) { if (e.code !== 'ENOTCAR') warn('focus.enable', e); });
        if (opts.initial !== false) {
          var first = opts.initial ? global.document.querySelector(opts.initial) : null;
          setTimeout(function () { set(first || candidates()[0]); }, 0);
        }
      },
      disable: function () {
        unsubs.forEach(function (u) { u(); });
        unsubs = [];
        if (current && opts) current.classList.remove(opts.className);
        current = null;
        if (opts) call('input', 'setCaptureMode', { mode: 'native' }).catch(function () {});
        opts = null;
      },
      move: function (direction) { if (opts) move(direction); },
      set: function (el) { if (opts) set(el); },
      get current() { return current; }
    };
  })();

  // ---------------------------------------------------------------- net

  function FetchResponse(r) {
    this.ok = r.status >= 200 && r.status < 300;
    this.status = r.status;
    this.statusText = r.statusText || '';
    this.url = r.url;
    this.headers = new Headers(r.headers || {});
    this._body = r.body || '';
    this._encoding = r.bodyEncoding || 'text';
  }
  FetchResponse.prototype._bytes = function () {
    if (this._encoding !== 'base64') return new TextEncoder().encode(this._body);
    var bin = atob(this._body);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  FetchResponse.prototype.text = function () {
    return Promise.resolve(this._encoding === 'base64' ? new TextDecoder().decode(this._bytes()) : this._body);
  };
  FetchResponse.prototype.json = function () { return this.text().then(JSON.parse); };
  FetchResponse.prototype.arrayBuffer = function () { return Promise.resolve(this._bytes().buffer); };
  FetchResponse.prototype.blob = function () {
    return Promise.resolve(new Blob([this._bytes()], { type: this.headers.get('content-type') || '' }));
  };

  function serverFetch(url, init) {
    init = init || {};
    var params = { url: String(url), method: (init.method || 'GET').toUpperCase() };
    if (init.headers) {
      var h = {};
      new Headers(init.headers).forEach(function (v, k) { h[k] = v; });
      params.headers = h;
    }
    if (init.timeout) params.timeout = init.timeout;
    var body = init.body;
    var prep;
    if (body == null) prep = Promise.resolve();
    else if (typeof body === 'string') { params.body = body; prep = Promise.resolve(); }
    else if (body instanceof URLSearchParams) { params.body = body.toString(); prep = Promise.resolve(); }
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) {
      prep = new Response(body).arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        params.body = btoa(bin);
        params.bodyEncoding = 'base64';
      });
    } else { params.body = JSON.stringify(body); prep = Promise.resolve(); }
    return prep.then(function () { return call('net', 'fetch', params); })
      .then(function (r) { return new FetchResponse(r); });
  }

  // ------------------------------------------------------------- channels

  function channel(name) {
    if (!name || typeof name !== 'string') throw CarPWAError('EINVAL', 'channel name must be a non-empty string');
    return {
      name: name,
      publish: function (data) { return call('channel', 'publish', { channel: name, data: data === undefined ? null : data }); },
      subscribe: function (fn) {
        var handler = function (msg) { if (msg && msg.channel === name) fn(msg.data, msg); };
        events.on('channel.message', handler);
        joinedChannels[name] = (joinedChannels[name] || 0) + 1;
        var ready = joinedChannels[name] === 1 ? call('channel', 'join', { channel: name }) : Promise.resolve(true);
        ready.catch(function (e) { warn('channel.join ' + name, e); });
        return function () {
          events.off('channel.message', handler);
          if (joinedChannels[name] && !--joinedChannels[name]) {
            delete joinedChannels[name];
            call('channel', 'leave', { channel: name }).catch(function () {});
          }
        };
      }
    };
  }

  // -------------------------------------------------------- dev console

  // Console output is captured from the moment the SDK loads, so what a page
  // logs while it starts up is not lost: entries wait in a buffer (the newest
  // CONSOLE_BUFFER_MAX) until the server bridge connects.
  var CONSOLE_BUFFER_MAX = 200;
  var consoleBuffer = [];

  function forwardingConsole() {
    return CarPWA.config.forwardConsole && CarPWA.env.devMode;
  }

  function sendLog(entry) {
    serverTransport.call('dev', 'log', entry).catch(function () {});
  }

  function flushConsole() {
    var pending = consoleBuffer;
    consoleBuffer = [];
    if (serverTransport && forwardingConsole()) pending.forEach(sendLog);
  }

  function forwardConsole() {
    if (!global.console || forwardConsole.done) return;
    forwardConsole.done = true;
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = console[level] && console[level].bind(console);
      console[level] = function () {
        if (forwardingConsole()) {
          var entry = { level: level, args: Array.prototype.map.call(arguments, safeSerialize), ts: Date.now() };
          if (serverTransport && serverTransport.connected) sendLog(entry);
          else {
            consoleBuffer.push(entry);
            if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
          }
        }
        if (orig) orig.apply(null, arguments);
      };
    });
    global.addEventListener('error', function (e) {
      console.error('Uncaught ' + (e.error && e.error.stack || e.message) + ' at ' + e.filename + ':' + e.lineno);
    });
    global.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      console.error('Unhandled rejection: ' + (r && (r.stack || (r.code ? r.code + ' ' + r.message : r.message)) || r));
    });
  }

  function safeSerialize(v) {
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    if (typeof v === 'string') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }

  // ------------------------------------------------------------------- API

  var CarPWA = {
    __sdk: true,
    version: VERSION,
    Error: CarPWAError,
    config: { autoReload: true, theme: true, forwardConsole: true },

    env: {
      mode: 'browser',          // 'carplay' | 'simulator' | 'browser'
      isCarPlay: false,
      appId: native ? native.appId : null,
      carpwaVersion: native ? native.version : null,
      devMode: native ? !!native.devMode : false,
      server: false
    },

    get state() { return state; },

    ready: function () { return readyPromise; },
    call: call,
    on: on,
    off: off,
    once: once,
    modules: function () { return call('$registry', 'modules', {}); },

    car: {
      getInfo: bind('car', 'getInfo'),
      getState: bind('car', 'getState'),
      sendCommand: function (command, parameters) { return call('car', 'sendCommand', { command: command, parameters: parameters || {} }); },
      requestCarUI: function (url) { return call('car', 'requestCarUI', { url: url || null }); },
      get state() { return state.car; },
      on: moduleOn('car'),
      off: moduleOff('car')
    },

    screen: {
      getInfo: bind('screen', 'getInfo'),
      get info() { return state.screen; },
      on: moduleOn('screen'),
      off: moduleOff('screen')
    },

    media: {
      getNowPlaying: bind('media', 'getNowPlaying'),
      getArtwork: function (size) { return call('media', 'getArtwork', { size: size || 512 }); },
      play: bind('media', 'play'),
      pause: bind('media', 'pause'),
      togglePlayPause: bind('media', 'togglePlayPause'),
      stop: bind('media', 'stop'),
      next: bind('media', 'next'),
      previous: bind('media', 'previous'),
      seek: function (position) { return call('media', 'seek', { position: position }); },
      skip: function (seconds) { return call('media', 'skip', { seconds: seconds }); },
      on: moduleOn('media'),
      off: moduleOff('media')
    },

    nav: {
      getState: bind('nav', 'getState'),
      requestOwnership: bind('nav', 'requestOwnership'),
      releaseOwnership: bind('nav', 'releaseOwnership'),
      on: moduleOn('nav'),
      off: moduleOff('nav')
    },

    location: {
      getCurrent: function (options) { return call('location', 'getCurrent', options || {}); },
      watch: function (fn) { return on('location', 'update', fn); },
      on: moduleOn('location'),
      off: moduleOff('location')
    },

    input: {
      setCaptureMode: function (mode) { return call('input', 'setCaptureMode', { mode: mode }); },
      interceptBack: function (enabled) { return call('input', 'interceptBack', { enabled: enabled !== false }); },
      on: function (event, fn) {
        if (event === 'move' || event === 'select') {
          call('input', 'setCaptureMode', { mode: 'app' }).catch(function (e) { if (e.code !== 'ENOTCAR') warn('input capture', e); });
        }
        if (event === 'back') call('input', 'interceptBack', { enabled: true }).catch(function () {});
        return on('input', event, fn);
      },
      off: moduleOff('input')
    },

    ui: {
      close: bind('ui', 'close'),
      alert: function (options) { return call('ui', 'alert', options || {}); },
      banner: function (options) {
        return call('ui', 'banner', typeof options === 'string' ? { title: options } : (options || {}));
      },
      setBackgroundColor: function (color) { return call('ui', 'setBackgroundColor', { color: color }); },
      on: moduleOn('ui'),
      off: moduleOff('ui')
    },

    apps: {
      list: bind('apps', 'list'),
      open: function (id) { return call('apps', 'open', { id: id }); },
      openURL: function (url) { return call('apps', 'openURL', { url: url }); }
    },

    system: {
      info: bind('system', 'info'),
      log: function (message, level) { return call('system', 'log', { message: String(message), level: level || 'info' }); }
    },

    app: {
      info: bind('app', 'info'),
      list: bind('app', 'list'),
      on: function (event, fn) { return on('app', event, fn); },
      off: moduleOff('app')
    },

    storage: {
      get: function (key) { return call('storage', 'get', { key: key }); },
      set: function (key, value) { return call('storage', 'set', { key: key, value: value === undefined ? null : value }); },
      remove: function (key) { return call('storage', 'remove', { key: key }); },
      keys: bind('storage', 'keys'),
      getAll: bind('storage', 'getAll'),
      clear: bind('storage', 'clear'),
      onChange: function (fn) { return on('storage', 'changed', fn); }
    },

    channel: channel,

    net: { fetch: serverFetch },

    focus: focus
  };

  // ------------------------------------------------------------- startup

  function start() {
    var sim = null;
    if (native && global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.carpwa) {
      carTransport = new NativeCarTransport(global.webkit.messageHandlers.carpwa, dispatch);
      CarPWA.env.mode = 'carplay';
      CarPWA.env.isCarPlay = true;
    } else if ((sim = findSimulator())) {
      carTransport = new SimCarTransport(sim, dispatch);
      CarPWA.env.mode = 'simulator';
      if (sim.native) {
        native = sim.native;
        CarPWA.env.appId = native.appId;
        CarPWA.env.devMode = true;
        if (native.initialState) {
          state.car = native.initialState.car || null;
          state.screen = native.initialState.screen || null;
        }
      }
    }
    if (forwardingConsole()) forwardConsole();

    var url = serverURL();
    var serverSettled = false;
    function settleServer() {
      if (serverSettled) return;
      serverSettled = true;
      finishReady();
    }
    if (url) {
      serverTransport = new ServerTransport(url, dispatch, function (up) {
        CarPWA.env.server = up;
        if (up) {
          Object.keys(joinedChannels).forEach(function (name) {
            serverTransport.call('channel', 'join', { channel: name }).catch(function () {});
          });
          flushConsole();
          settleServer();
        }
        events.emit('app.' + (up ? 'serverConnected' : 'serverDisconnected'), null);
      });
      setTimeout(settleServer, 3000);
    } else {
      settleServer();
    }

    function finishReady() {
      // Re-establish car subscriptions made before startup finished.
      if (carTransport) {
        Object.keys(subCounts).forEach(function (key) {
          var dot = key.indexOf('.');
          carTransport.call(key.slice(0, dot), '$subscribe', { event: key.slice(dot + 1) }).catch(function () {});
        });
        // Keep cached state and CSS hooks fresh even if the page never listens.
        on('car', 'state', function () {});
        on('screen', 'change', function () {});
      }
      applyTheme();
      readyResolve(CarPWA.env);
    }
  }

  global.CarPWA = CarPWA;
  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', function () { applyTheme(); });
  }
  start();

  if (typeof module === 'object' && module.exports) module.exports = CarPWA;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
