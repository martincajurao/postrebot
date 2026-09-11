/**
 * Location Service Module — Production-grade geolocation handling
 * 
 * Features:
 * - Proper state management with clear permission states
 * - Graceful fallbacks: GPS → IP geolocation → Map pin
 * - Specific error messages (not generic "turn on location")
 * - Timeout handling with safety nets
 * - Works in Messenger WebView, regular browsers, and insecure contexts
 * 
 * State Machine:
 * 'unknown' → 'checking' → 'granted' | 'denied' | 'unavailable' | 'timeout'
 */

const LocationService = (() => {
  'use strict';

  // Configuration
  const CONFIG = {
    GPS_TIMEOUT_MS: 10000,
    SAFETY_NET_MS: 12000,
    MAX_ACCURACY_METERS: 3000,
    MAX_POSITION_AGE_MS: 60000,
    IP_GEOCODE_TIMEOUT_MS: 8000,
  };

  // Internal state
  let _permissionState = 'unknown';
  let _lastPosition = null;
  let _isRequestInProgress = false;

  // Error codes for clear error handling
  const ErrorCodes = {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    POSITION_UNAVAILABLE: 'POSITION_UNAVAILABLE',
    TIMEOUT: 'TIMEOUT',
    SECURE_CONTEXT_REQUIRED: 'SECURE_CONTEXT_REQUIRED',
    API_UNSUPPORTED: 'API_UNSUPPORTED',
    ACCURACY_TOO_LOW: 'ACCURACY_TOO_LOW',
    IP_FALLBACK_FAILED: 'IP_FALLBACK_FAILED',
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

  // Get current position using the Geolocation API
  function getGPSPosition() {
    return new Promise((resolve, reject) => {
      if (!isGeolocationSupported()) {
        reject({
          code: ErrorCodes.API_UNSUPPORTED,
          message: 'Your browser does not support geolocation.',
          canRetry: false,
        });
        return;
      }

      let settled = false;
      let safetyNetTimer = null;

      const finish = (result, isError = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyNetTimer);
        if (isError) reject(result);
        else {
          _lastPosition = result;
          resolve(result);
        }
      };

      // Safety net: hard timeout to prevent hanging forever
      safetyNetTimer = setTimeout(() => {
        finish({
          code: ErrorCodes.TIMEOUT,
          message: 'Getting your location took too long. Please try again or tap your location on the map.',
          canRetry: true,
        }, true);
      }, CONFIG.SAFETY_NET_MS);

      _permissionState = 'checking';
      
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
            source: 'gps',
          };

          if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
            finish({
              code: ErrorCodes.POSITION_UNAVAILABLE,
              message: 'Could not determine your location. Please try again or tap the map.',
              canRetry: true,
            }, true);
            return;
          }

          // Check accuracy - if too low quality, reject
          if (Number.isFinite(coords.accuracy) && coords.accuracy > CONFIG.MAX_ACCURACY_METERS) {
            finish({
              code: ErrorCodes.ACCURACY_TOO_LOW,
              message: `Location accuracy is low (${Math.round(coords.accuracy)}m). Please try again or use the map.`,
              canRetry: true,
            }, true);
            return;
          }

          _permissionState = 'granted';
          finish(coords, false);
        },
        (error) => {
          const err = handleGeolocationError(error);
          if (err.code === ErrorCodes.PERMISSION_DENIED) {
            _permissionState = 'denied';
          } else if (err.code === ErrorCodes.TIMEOUT) {
            _permissionState = 'timeout';
          } else {
            _permissionState = 'unavailable';
          }
          finish(err, true);
        },
        {
          enableHighAccuracy: true,
          timeout: CONFIG.GPS_TIMEOUT_MS,
          maximumAge: CONFIG.MAX_POSITION_AGE_MS,
        }
      );
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

  // Main method: Get current location with automatic fallback chain
  async function getCurrentPosition(options = {}) {
    const { allowIPFallback = true, requireHighAccuracy = false } = options;

    if (_isRequestInProgress) {
      throw {
        code: ErrorCodes.UNKNOWN_ERROR,
        message: 'A location request is already in progress.',
        canRetry: true,
      };
    }

    _isRequestInProgress = true;

    try {
      // Check permission state first
      const permState = await getPermissionState();

      // If permission is explicitly denied, try IP fallback
      if (permState === 'denied') {
        if (allowIPFallback) {
          const ipLocation = await getIPBasedLocation();
          if (ipLocation) return ipLocation;
        }
        throw {
          code: ErrorCodes.PERMISSION_DENIED,
          message: 'Location access is blocked. Please enable location in your browser settings, or tap the map below to set your location manually.',
          canRetry: true,
          action: 'ENABLE_PERMISSION',
        };
      }

      // Try GPS first
      try {
        return await getGPSPosition();
      } catch (gpsError) {
        // GPS failed - if IP fallback is allowed, try it
        if (allowIPFallback && gpsError.code !== ErrorCodes.PERMISSION_DENIED) {
          const ipLocation = await getIPBasedLocation();
          if (ipLocation) return ipLocation;
        }
        throw gpsError;
      }
    } finally {
      _isRequestInProgress = false;
    }
  }

  // Get last known successful position
  function getLastKnownPosition() {
    return _lastPosition;
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
    _lastPosition = null;
    _isRequestInProgress = false;
  }

  // Public API
  return {
    get permissionState() { return _permissionState; },
    set permissionState(state) { 
      const validStates = ['unknown', 'checking', 'granted', 'denied', 'unavailable', 'timeout'];
      if (validStates.includes(state)) _permissionState = state;
    },
    getCurrentPosition,
    getGPSPosition,
    getIPBasedLocation,
    getPermissionState,
    queryPermissionState,
    getLastKnownPosition,
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
