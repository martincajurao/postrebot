/* init/helper/saveLocation area */
y {
    const loc = JSON.parse(storageGet(LOCATION_KEY()) || 'null');
    return loc && loc.address ? loc : null;
  } catch { return null; }
}

function saveLocation(loc) {
  try { storageSet(LOCATION_KEY(), JSON.stringify(loc)); } catch { /* non-fatal */ }
}

/** True when the Leaflet map could be set up and initialized (CDN reachable,
 * element present, and initialization succeeded). When false, the customer
 * can still confirm with address-only — delivery fee will fall back to a
 * default/zone rate instead of a distance-based one. */
function mapAvailable() {
  return typeof L !== 'undefined' && !!$id('loc-map') && !mapInitFailed;
}

/** Show the mandatory location modal. Always shown on every webview open so
 * customers can review or update their delivery location. When a location was
 * already saved this session, pre-fill the address and re-drop the pin on the
 * map so returning customers only need to re-confirm (not re-type). */
function showLocationGate() {
  const gate = $id('location-gate');
  if (!gate) return;
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.add('hidden');
  // Prefill from the address remembered at checkout so repeat customers
  // only need to drop/keep the pin and confirm.
  const remembered = loadCustomerData();
  if (remembered && remembered.address) $id('loc-address').value = remembered.address;
  // Pre-fill from a previously saved gate location too, and restore the pin
  // on the map so the customer sees their saved spot visually.
  const saved = getSavedLocation();
  if (saved && saved.address && !$id('loc-address').value) {
    $id('loc-address').value = saved.address;
  }
  gate.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // No map support (CDN blocked / very old webview) → hide it and fall back
  // to address-only confirmation so ordering never gets bricked.
  if (!mapAvailable()) {
    const wrap = document.querySelector('.loc-map-wrap');
    if (wrap) wrap.style.display = 'none';
  } else {
    // Defer to the next frame so #loc-map has real dimensions once the
    // sheet is visible — Leaflet measures the container at init time.
    requestAnimationFrame(() => initLocationMap());
    // When a location was already saved with coordinates, re-drop the pin so
    // the customer sees where they're set to receive the order.
    if (saved && saved.lat != null && saved.lng != null) {
      const coords = { lat: saved.lat, lng: saved.lng };
      // initLocationMap() may not have created locMap yet when this runs;
      // if the map isn't ready, the pin will be restored when it is (see
      // the requestAnimationFrame below). Otherwise drop it immediately.
      if (locMap) {
        setMapPin(coords, false);
        locMap.setView([coords.lat, coords.lng], 15);
      } else {
        const tryRestore = () => {
          if (locMap) {
            setMapPin(coords, false);
            locMap.setView([coords.lat, coords.lng], 15);
          } else {
            setTimeout(tryRestore, 150);
          }
        };
        setTimeout(tryRestore, 200);
      }
    }
  }

  // Re-validate the confirm button as the address is typed.
  const addrEl = $id('loc-address');
  if (addrEl && !addrEl.dataset.locBound) {
    addrEl.dataset.locBound = '1';
    addrEl.addEventListener('input', updateLocConfirmState);
  }
  updateLocConfirmState();
}

/** Create the map once, after the modal is visible. */
function initLocationMap() {
  if (locMap) {
    // Re-opened (e.g. after a retry) — Leaflet needs a size recalculation.
    setTimeout(() => { if (locMap) locMap.invalidateSize(); }, 150);
    return;
  }
  try {
    locMap = L.map('loc-map', { scrollWheelZoom: false })
      .setView([STORE_LOCATION.lat, STORE_LOCATION.lng], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(locMap);
    // Tap anywhere to drop/move the pin.
    locMap.on('click', (e) => setMapPin(e.latlng, false));
    // Re-measure once the container has settled so tiles + pin render correctly
    // even when the sheet was opened from a previously-hidden state.
    setTimeout(() => { if (locMap) locMap.invalidateSize(); }, 80);
  } catch (e) {
    console.warn('[webview] map init failed, falling back to address-only:', e && e.message);
    locMap = null;
    locMarker = null;
    mapInitFailed = true;
    const wrap = document.querySelector('.loc-map-wrap');
    if (wrap) wrap.style.display = 'none';
    showLocError('Map unavailable — please enter your address manually below.');
  }
}

/** Hide the location modal and restore page scrolling. */
function hideLocationGate() {
  const gate = $id('location-gate');
  if (gate) gate.classList.add('hidden');
  const mainContent = $id('main-content');
  if (mainContent) mainContent.classList.remove('hidden');
  document.body.style.overflow = '';
}

function showLocError(msg) {
  const el = $id('loc-gate-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLocError() {
  const el = $id('loc-gate-error');
  if (el) el.classList.add('hidden');
}

// Coordinates of the chosen delivery point — set by the GPS button or by
// dropping the pin on the map. Saved with the confirmed address and sent
// with checkout for the future delivery-fee distance calculation.
let pendingCoords = null;
// Where the point came from: 'gps' or 'pin' (map tap/drag).
let pinSource = null;
// Set true when the map couldn't be initialized (Leaflet error, container
// issue, etc.). When true, the customer can confirm with address-only
// (no coordinates required) — delivery fee falls back to a default/zone rate.
let mapInitFailed = false;

/** Drop/move the pin and remember the chosen point. */
function setMapPin(latlng, fromGps) {
  pendingCoords = { lat: latlng.lat, lng: latlng.lng };
  pinSource = fromGps ? 'gps' : 'pin';
  if (mapAvailable()) {
    if (!locMarker) {
      locMarker = L.marker(latlng, {
        draggable: true,
        icon: L.divIcon({ className: 'loc-pin', html: '📍', iconSize: [32, 32], iconAnchor: [16, 30] }),
      }).addTo(locMap);
      // Dragging fine-tunes the point (same handling as a fresh tap).
      locMarker.on('dragend', () => setMapPin(locMarker.getLatLng(), false));
    } else {
      locMarker.setLatLng(latlng);
    }
  }
  hideLocError();
  updateLocConfirmState();
  if (!fromGps) {
    // Name the picked point so the address box pre-fills — only when empty,
    // never stomping on what the customer already typed.
    reverseGeocode(latlng.lat, latlng.lng)
      .then((addr) => {
        const el = $id('loc-address');
        if (el && !el.value.trim()) el.value = addr;
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
    if (err && err
/* END */
