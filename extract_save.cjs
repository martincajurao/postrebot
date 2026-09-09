/* getSavedLocation/saveLocation region */


/** Saved delivery location for this session (or null when not set yet). */
function getSavedLocation() {
  try {
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
    // the custom
/* END */
