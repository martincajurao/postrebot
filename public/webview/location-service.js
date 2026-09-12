/**
 * Location Service Module — Production-grade geolocation handling
 * 
 * IMPORTANT DESIGN DECISIONS:
 * - IP geolocation returns ISP location, NOT user location. It's ONLY used for
 *   approximate branch detection at startup (for menu filtering).
 * - The GPS button ("Use my current location") uses REAL GPS ONLY - no IP fallback.
 *   If GPS fails, user must drop a pin on the map. This ensures accurate delivery.
 * - The map pin is the ONLY reliable way for users to confirm their actual location.
 * 
 * State Machine:
 * 'unknown' → 'checking' → 'granted' | 'denied' | 'unavailable' | 'timeout'
 */

const LocationService = (() => {
  'use strict';

  // Configuration — tuned for phones: a cold GPS fix indoors on cellular
  // routinely takes 20-30s, while desktop (WiFi-based) answers in ~1s.
  const CONFIG = {
    GPS_TIMEOUT_MS: 10000,          // legacy alias (kept for compat)
    QUICK_TIMEOUT_MS: 10000,         // stage 1: one-shot low-accuracy (cell/WiFi) fix — fast indoors
    WATCH_WINDOW_MS: 25000,            // stage 2: persistent watch window (provider accumulates fix)
    WATCH_ACCEPTABLE_M: 2500,          // mid-window coarse fix this good (or better) is usable
    MAX_CACHED_AGE_MS: 120000,         // accept a cached fix up to 2 min old (fast re-taps)
    MAX_ACCURACY_METERS: 3000,
    MAX_POSITION_AGE_MS: 60000,
    IP_GEOCODE_TIMEOUT_MS: 8000,
    // A POSITION_UNAVAILABLE or fast PERMISSION_DENIED that arrives this fast
    // almost always means the phone's master Location switch is OFF (no
    // provider to even query), not a real "couldn't fix" — surface it as
    // GPS_DISABLED. There is no API that reads that switch directly, so
    // timing is the only signal browsers give us. 5s covers both the
    // instant-fail (switch off) and the fast-denied (OS-level block) cases.
    GPS_OFF_FAST_FAIL_MS: 5000,
  };

  // Internal state
  let _permissionState = 'unknown';
  let _lastGPSPosition = null;  // Only GPS positions are stored as "last known"
  let _isRequestInProgress = false;

  // Error codes for clear error handling
  const ErrorCodes = {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    POSITION_UNAVAILABLE: 'POSITION_UNAVAILABLE',
    TIMEOUT: 'TIMEOUT',
    SECURE_CONTEXT_REQUIRED: 'SECURE_CONTEXT_REQUIRED',
    API_UNSUPPORTED: 'API_UNSUPPORTED',
    ACCURACY_TOO_LOW: 'ACCURACY_TOO_LOW',
    GPS_DISABLED: 'GPS_DISABLED',  // Phone location services are off
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  };

  // Check if geolocation API is available
  function isGeolocationSupported() {
    return typeof navigator !== 'undefined' && 
           navigator.geolocation && 
           typeof navigator.geolocation.getCurrentPosition === 'function';
  }

  // Check if secure context (but don't block on this alone)
  function isSecureContext() {
    try {
      return window.isSecureContext === true || 
             location.protocol === 'https:' || 
             location.hostname === 'localhost' ||
             location.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }

  // Query the permission state using Permissions API
  function queryPermissionState() {
    return new Promise((resolve) => {
      if (!navigator.permissions || !navigator.permissions.query) {
        resolve('unknown');
        return;
      }
      navigator.permissions.query({ name: 'geolocation' })
        .then((result) => {
          if (result.onchange) {
            result.onchange = () => {
              _permissionState = result.state === 'granted' ? 'granted' : 
                                result.state === 'denied' ? 'denied' : 'unknown';
            };
          }
          resolve(result.state);
        })
        .catch(() => resolve('unknown'));
    });
  }

  // Get the current permission state (cached or queried)
  async function getPermissionState() {
    if (_permissionState === 'unknown') {
      const state = await queryPermissionState();
      _permissionState = state === 'granted' ? 'granted' : 
                        state === 'denied' ? 'denied' : 'unknown';
    }
    return _permissionState;
  }

  // Handle geolocation API errors with specific error codes
  function handleGeolocationError(error) {
    const code = error.code;
    const message = error.message || '';
    switch (code) {
      case 1: // PERMISSION_DENIED
        return {
          code: ErrorCodes.PERMISSION_DENIED,
          message: 'Location access was denied. Please allow location access, or tap the map below to set your location.',
          canRetry: true,
          action: 'ENABLE_PERMISSION',
        };
      case 2: // POSITION_UNAVAILABLE
        return {
          code: ErrorCodes.POSITION_UNAVAILABLE,
          message: 'Your location could not be determined. Please check your connection or tap the map below.',
          canRetry: true,
          action: 'RETRY_OR_MAP',
        };
      case 3: // TIMEOUT
        return {
          code: ErrorCodes.TIMEOUT,
          message: 'Getting your location timed out. Please try again or tap your location on the map below.',
          canRetry: true,
          action: 'RETRY_OR_MAP',
        };
      default:
        return {
          code: ErrorCodes.UNKNOWN_ERROR,
          message: `Location error: ${message || 'Unknown error'}. Please try again or tap the map.`,
          canRetry: true,
          action: 'RETRY_OR_MAP',
        };
    }
  }

  // Get current position using REAL GPS — two staged attempts:
  //   1. enableHighAccuracy:true  (real satellite fix, slow but precise)
  //   2. enableHighAccuracy:false (cell/WiFi fix, fast but coarse)
  // Either stage may succeed; only if both fail do we surface the error.
  // A POSITION_UNAVAILABLE that arrives suspiciously fast (under
  // GPS_OFF_FAST_FAIL_MS) is reported as GPS_DISABLED — the phone's master
  // Location switch is almost certainly OFF. There is no API that reads
  // that switch directly, so timing is the only signal browsers give us.
function getGPSPosition() {
    return new Promise((resolve, reject) => {
      if (!isGeolocationSupported()) {
        reject({ code: ErrorCodes.API_UNSUPPORTED, message: 'Geolocation is not supported on this device.', canRetry: false });
        return;
      }
      if (!isSecureContext()) {
        reject({ code: ErrorCodes.SECURE_CONTEXT_REQUIRED, message: 'Location requires a secure (HTTPS) connection.', canRetry: false });
        return;
      }
      const startedAt = Date.now();
      let settled = false;
      let watchId = null;
      let best = null;
      const log = (m, c) => { try { if (window.__gpsLog) window.__gpsLog(m, c, 'WATCH'); } catch (e) {} };
      const ok = (coords, why) => {
        if (settled) return;
        settled = true;
        try { if (watchId !== null) navigator.geolocation.clearWatch(watchId); } catch (e) {}
        clearTimeout(tm);
        _permissionState = 'granted';
        _lastGPSPosition = coords;
        log('GPS fix OK lat=' + coords.lat + ' lng=' + coords.lng + ' acc=~' + Math.round(coords.accuracy) + 'm elapsed=' + (Date.now() - startedAt) + 'ms (' + why + ')', 'dbg-ok');
        resolve(coords);
      };
      const bad = (err) => {
        if (settled) return;
        settled = true;
        try { if (watchId !== null) navigator.geolocation.clearWatch(watchId); } catch (e) {}
        clearTimeout(tm);
        err._elapsedMs = Date.now() - startedAt;
        _permissionState = err.code === ErrorCodes.PERMISSION_DENIED ? 'denied' : err.code === ErrorCodes.TIMEOUT ? 'timeout' : 'unavailable';
        log('FAILED code=' + err.code + ' raw=' + (err._rawCode || '-') + ' fastFail=' + (err._fastFail || '-') + ' elapsed=' + err._elapsedMs + 'ms | ' + err.message, 'dbg-err');
        reject(err);
      };
      const classify = (raw, elapsed) => {
        const e = handleGeolocationError(raw);
        const fast = elapsed < CONFIG.GPS_OFF_FAST_FAIL_MS;
        e._rawCode = raw && raw.code;
        e._fastFail = fast;
        if (fast && (e.code === ErrorCodes.POSITION_UNAVAILABLE || e.code === ErrorCodes.PERMISSION_DENIED)) {
          e.code = ErrorCodes.GPS_DISABLED;
          e.message = 'Phone location looks OFF - turn on Location Services, then tap Retry. Or tap the map below.';
          e.action = 'ENABLE_GPS';
        }
        return e;
      };
      _permissionState = 'checking';
      log('GPS stage 1/2: one-shot low-accuracy');
      navigator.geolocation.getCurrentPosition(
        function (position) {
          var c = position.coords;
          var atMs = Date.now() - startedAt;
          log('GPS stage 1 OK acc=~' + Math.round(c.accuracy) + 'm elapsed=' + atMs + 'ms', 'dbg-ok');
          ok(toCoords(position), 'quick');
        },
        function (raw) {
          var atMs = Date.now() - startedAt;
          log('GPS stage 1 ERR rawCode=' + (raw && raw.code) + ' elapsed=' + atMs + 'ms', 'dbg-err');
          if (raw && raw.code === 1) { bad(classify(raw, atMs)); return; }
          startWatch();
        },
        { enableHighAccuracy: false, timeout: CONFIG.QUICK_TIMEOUT_MS, maximumAge: CONFIG.MAX_CACHED_AGE_MS }
      );
      function startWatch() {
      log('GPS stage 2/2: watch window=' + CONFIG.WATCH_WINDOW_MS + 'ms');
      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const el = Date.now() - startedAt;
            const la = pos.coords.latitude, ln = pos.coords.longitude, ac = pos.coords.accuracy;
            if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
            const c = { lat: la, lng: ln, accuracy: ac, timestamp: pos.timestamp, source: 'gps' };
            log('fix update acc=~' + Math.round(ac) + 'm elapsed=' + el + 'ms');
            if (Number.isFinite(ac) && ac <= 60) ok(c, 'precise');
            else if (Number.isFinite(ac) && ac <= CONFIG.WATCH_ACCEPTABLE_M) {
              if (!best || ac < best.accuracy) best = c;
              log('coarse fix held acc=~' + Math.round(ac) + 'm (waiting for better or window end)', 'dbg-warn');
            } else log('fix too coarse acc=~' + Math.round(ac) + 'm (ignored)', 'dbg-warn');
          },
          (raw) => {
            const el = Date.now() - startedAt;
            log('provider ERR rawCode=' + (raw && raw.code) + ' msg=' + (raw && raw.message) + ' elapsed=' + el + 'ms', 'dbg-err');
            if (raw && raw.code === 1) bad(classify(raw, el));
          },
          { enableHighAccuracy: true, timeout: CONFIG.WATCH_WINDOW_MS, maximumAge: CONFIG.MAX_CACHED_AGE_MS }
        );
      } catch (e) { bad(classify({ code: 2, message: String((e && e.message) || e) }, 0)); return; }
      const tm = setTimeout(() => {
        if (best) { log('window ended - using best coarse fix acc=~' + Math.round(best.accuracy) + 'm', 'dbg-warn'); ok(best, 'best-coarse'); }
        else bad({ code: ErrorCodes.TIMEOUT, message: 'Getting your location took too long. Make sure Location is ON with a clear sky view, then try again - or tap your location on the map below.', canRetry: true, _rawCode: 3, _fastFail: false });
      }, CONFIG.WATCH_WINDOW_MS);
    });
  }
  // Get approximate location via IP geolocation (fallback)
  async function getIPBasedLocation() {
    const services = [
      {
        url: 'https://ipapi.co/json/',
        parse: (data) => ({
          lat: parseFloat(data.latitude),
          lng: parseFloat(data.longitude),
          city: data.city,
          region: data.region,
        }),
      },
      {
        url: 'http://ip-api.com/json/',
        parse: (data) => ({
          lat: parseFloat(data.lat),
          lng: parseFloat(data.lon),
          city: data.city,
          region: data.region,
        }),
      },
    ];

    for (const service of services) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.IP_GEOCODE_TIMEOUT_MS);
        
        const response = await fetch(service.url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) continue;
        
        const data = await response.json();
        const coords = service.parse(data);
        
        if (Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
          return {
            lat: coords.lat,
            lng: coords.lng,
            accuracy: 'approximate',
            source: 'ip',
            city: coords.city,
            region: coords.region,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // Get GPS position ONLY - no IP fallback
  // This is used by the "Use my current location" button
  // If GPS fails, the user must drop a pin on the map.
  // Manual taps pass { force: true } so a stale cached 'denied' state can
  // never short-circuit Retry — the user may have just enabled Location in
  // Settings and come back. The permission is always re-queried fresh.
  async function getCurrentPosition(options) {
    if (_isRequestInProgress) {
      throw {
        code: ErrorCodes.UNKNOWN_ERROR,
        message: 'A location request is already in progress.',
        canRetry: true,
      };
    }

    _isRequestInProgress = true;

    try {
      // Re-query the live permission state on every call (the Permissions
      // API result can go stale the moment the user flips the OS switch).
      let permState = 'unknown';
      try {
        permState = await queryPermissionState();
        _permissionState = permState === 'granted' ? 'granted' :
                           permState === 'denied' ? 'denied' : 'unknown';
      } catch {
        permState = _permissionState;
      }

      // Only the quiet automatic attempt respects a cached 'denied' (to
      // avoid popping a prompt on gate-open). A manual "locate me" / Retry
      // tap ALWAYS attempts real GPS — that is the whole point of Retry.
      const isManual = !!(options && options.force);
      if (permState === 'denied' && !isManual) {
        throw {
          code: ErrorCodes.PERMISSION_DENIED,
          message: 'Phone location is off or access is blocked. Please enable Location Services on your phone, or tap the map below to set your location manually.',
          canRetry: true,
          action: 'ENABLE_PERMISSION',
        };
      }

      // Try GPS only - NO IP fallback for delivery location
      return await getGPSPosition();

    } finally {
      _isRequestInProgress = false;
    }
  }

  // Get last known GPS position (only real GPS, never IP)
  function getLastKnownPosition() {
    return _lastGPSPosition;
  }

  // Check if a location was obtained via GPS (high accuracy)
  function isHighAccuracyLocation(position) {
    return position && position.source === 'gps' && 
           Number.isFinite(position.accuracy) && 
           position.accuracy <= CONFIG.MAX_ACCURACY_METERS;
  }

  // Check if a location is valid for delivery
  function isValidLocation(location) {
    return location && 
           Number.isFinite(location.lat) && 
           Number.isFinite(location.lng);
  }

  // Get user-friendly permission guidance based on browser
  function getPermissionGuidance() {
    const ua = navigator.userAgent || '';
    if (ua.includes('Android')) {
      return {
        title: 'Enable Location on Android',
        steps: [
          'Open your phone Settings',
          'Tap "Location" or "Privacy"',
          'Turn on "Location Services"',
          'Find your browser in app permissions',
          'Set location to "Allow"',
        ],
      };
    }
    if (ua.includes('iPhone') || ua.includes('iPad')) {
      return {
        title: 'Enable Location on iOS',
        steps: [
          'Open Settings',
          'Tap "Privacy & Security"',
          'Tap "Location Services"',
          'Turn on "Location Services"',
          'Find your browser and set to "While Using"',
        ],
      };
    }
    return {
      title: 'Enable Location in Browser',
      steps: [
        'Click the lock/info icon in your browser address bar',
        'Find "Location" permissions',
        'Set to "Allow"',
        'Refresh the page',
      ],
    };
  }

  // Reset the service state
  function reset() {
    _permissionState = 'unknown';
    _lastGPSPosition = null;
    _isRequestInProgress = false;
  }

  // Public API
  return {
    get permissionState() { return _permissionState; },
    set permissionState(state) { 
      const validStates = ['unknown', 'checking', 'granted', 'denied', 'unavailable', 'timeout'];
      if (validStates.includes(state)) _permissionState = state;
    },
    getCurrentPosition,      // GPS only - for "Use my current location" button
    getGPSPosition,          // GPS only - raw access
    getIPBasedLocation,      // IP only - for approximate branch detection (startup only!)
    getPermissionState,
    queryPermissionState,
    getLastKnownPosition,    // Returns last GPS position only
    isHighAccuracyLocation,
    isValidLocation,
    isGeolocationSupported,
    getPermissionGuidance,
    reset,
    ErrorCodes,
    CONFIG,
  };
})();

if (typeof window !== 'undefined') window.LocationService = LocationService;
if (typeof module !== 'undefined' && module.exports) module.exports = LocationService;
