/* useCurrentLocation + helpers before it */
ue = addr;
      })
      .catch(() => { /* offline / rate-limited — address stays hand-typed */ });
  }
}

/** GPS button — locate the device, pin it on the map and reverse-geocode it. */
function useCurrentLocation() {
  hideLocError();
  const btn = $id('loc-gps-btn');
  const label = $id('loc-gps-label');
  if (!btn || !label) return;

  // Geolocation only exists on secure origins (HTTPS / localhost) and is
  // frequently blocked inside Messenger's in-app browser — the map below is
  // the guaranteed fallback there.
  if (!navigator.geolocation || !window.isSecureContext) {
    showLocError('Location services aren\u2019t available here — tap your spot on the map below instead.');
    return;
  }

  btn.disabled = true;
  label.textContent = 'Getting your location…';
  const resetBtn = () => { btn.disabled = false; label.textContent = 'Use my current location'; };

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (mapAvailable()) {
      setMapPin(coords, true);
      locMap.setView([coords.lat, coords.lng], 16);
    } else {
      pendingCoords = coords;
      updateLocConfirmState();
    }
    try {
      const address = await reverseGeocode(coords.lat, coords.lng);
      $id('loc-address').value = address;
      updateLocConfirmState();
      showToast('📍 Location found — check it and confirm');
    } catch (e) {
      console.warn('[webview] reverse geocode failed:', e && e.message);
      // GPS worked but naming the address didn't — keep the pin/coords and
      // let the customer complete the address manually.
      showLocError('We got your position but couldn\u2019t name the address — please complete it below.');
      $id('loc-address').focus();
    }
    resetBtn();
  }, (err) => {
    resetBtn();
    console.warn('[webview] geolocation failed:', err && err.code, err && err.message);
    if (err && err.code === 1) showLocError('Location permission was denied — tap your spot on the map below instead.');
    else if (err && err.code === 3) showLocError('Getting your location timed out — try again or tap the map below.');
    else showLocError('Could not get your location — tap your spot on the map below instead.');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/** Reverse-geocode coordinates into a readable address (OpenStreetMap). */
async function reverseGeocode(lat, lng) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1'
    + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('reverse geocode HTTP ' + res.status);
  const data = await res.json();
  const a = data.address || {};
  const parts = [
    a.house_number, a.road,
    a.neighbourhood || a.suburb || a.quarter,
    a.barangay || a.village || a.city_district,
    a.city || a.municipality || a.town,
    a.province,
  ].filter(Boolean);
  const text = parts.join(', ');
  if (!text) throw new Error('reverse geocode returned no address');
  return text;
}

/** Live guidance under the map: exactly what's still missing before confirming. */
function updateLocConfirmState() {
  const status = $id('loc-status');
  if (!status) return;
  if (!mapAvailable()) { status.textContent = ''; return; }
  const address = (($id('loc-address') && $id('loc-address').value) || '').trim();
  const hasAddress = address.length >= 5;
  status.classList.toggle('loc-status-ok', !!pendingCoords && hasAddress);
  if (!pendingCoords) {
    status.textContent = '📍 Tap the map to drop your pin — or use "Use my current location"';
  } else if (!hasAddress) {
    status.textContent = '✓ Pin saved — now complete your address below';
  } else {
    status.textContent = '✓ Location set — ready to confirm!';
  }
}

/** Confirm button — validate and persist the delivery location, then unlock home. */
function confirmLocation() {
  hideLocError();
  const address = (($id('loc-address') && $id('loc-address').value) || '').trim();
  if (address.length < 5) {
    showLocError('Please enter your complete address (house #, street, barangay, city).');
    return;
  }
  if (mapAvailable() && !pendingCoords) {
    showLocError('Please set your location first — tap the map or use "Use my current location".');
    return;
  }
  const landmark = (($id('loc-landmark') && $id('loc-landmark').value) || '').trim();
  saveLocation({
    address,
    landmark: landmark || null,
    lat: pendingCoords ? pendingCoords.lat : null,
    lng: pendingCoords ? pendingCoords.lng : null,
    source: pendingCoords ? pinSource : 'manual',
    savedAt: new Date().toISOString(),
  });
  // When source is 'manual' (customer typed an address without GPS / map pin),
  // lat/lng are null. The future delivery-fee engine should handle this by:
  //   1. Using a default/flat delivery fee, or
  //   2. Parsing the address (barangay, city) for zone-based pricing, or
  //   3. Geocoding the address server-side (Google Maps / OpenStreetMap) to
  //      recover coordinates and compute a distance-based fee.
  // For now the location is stored as-is and the checkout delivery line stays
  // "To be decided" until the fee logic is wired up.
  pendingCoords = null;
  pinSource = null;
  hideLocationGate();
  showToast('📍 Location saved!');
}

// ---------- Init ----------
/**
 * Ask MessengerExtensions for the current user's PSID (waits up to ~2.5s for the SDK).
 * Used when the webview is opened without the ?psid= parameter so the cart and
 * orders still bind to the Messenger customer account.
 */
function resolveMessengerUser() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let tries = 0;
    (function attempt() {
      const ext = window.MessengerExtensions;
      if (ext && typeof ext.getUserID === 'function') {
        try {
          ext.getUserID(
            (uids) => finish(uids && uids.psid ? String(uids.psid) : null),
            () => finish(null),
          );
          return;
        } catch { finish(null); return; }
      }
      if (++tries < 15) setTimeout(attempt, 200);
      else finish(null);
    })();
    setTimeout(() => finish(null), 3000);
  });
}

let initStarted = false;
async function init() {
  if (initStarted) return;
  initStarted = true;
  showLoading('Loading menu...');

  // Detect Messenger in parallel — never let the SDK poll block catalog loading.
  const messengerDetection = detectMessenger();

  // Check if webview is enabled (assume enabled when the check itself fails).
  let enabled = true;
  try {
    const enabledData = await api('/enabled');
    enabled = enabledData && enabledData.enabled !== false;
  } catch (e) {
    console.warn('[webview] /enabled check failed — assuming enabled:', e && e.message);
  }

  const mainContent = $id('main-content');
  const nav = $id('bottom-nav');

  if (!enabled) {
    hideLoading();
    const disabled = $id('disabled-msg');
    if (disabled) disabled.classList.remove('hidden');
    if (mainContent) mainContent.classList.add('hidden');
    if (nav) nav.style.display = 'none';
    return;
  }

  // When opened without ?psid (shared URL), resolve the PSID from the Messenger
  // SDK BEFORE loading the cart so the local cart + orders bind to the customer.
  if (!psidFromMessenger) {
    const msgrPsid = await resolveMessengerUser();
    if (msgrPsid && msgrPsid !== sessionId) {
      console.log('[webview] PSID resolved from MessengerExtensions');
      sessionId = msgrPsid;
      storageSet('webview_session', sessionId);
    }
  }

  // Load everything; set
/* END */
