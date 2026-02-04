console.log('Akwadra Super Builder Initialized - Multi-Role System with Auth');

// ==================== CRITICAL: Define window functions FIRST ====================
// These must be available immediately for onclick handlers in HTML
const selectRoleImpl = function(role) {
    console.log('✅ selectRole called with:', role);
    if (typeof currentUserRole === 'undefined') {
        console.warn('⚠️ currentUserRole not yet defined, defining now');
        window.currentUserRole = role;
    } else {
        currentUserRole = role;
    }
    
    const roleModal = document.getElementById('role-selection-modal');
    // Animate out role selection
    if(roleModal) {
        roleModal.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => roleModal.classList.add('hidden'), 500);
    }

    if (role === 'passenger') {
        console.log('🧑 Passenger selected');
        // Check for existing session (Auto Login)
        if (typeof DB !== 'undefined' && DB.hasSession()) {
            console.log('📱 Has session, init passenger mode');
            initPassengerMode();
        } else {
            console.log('🔐 No session, show auth modal');
            // Show Auth Modal
            if (typeof openAuthModal === 'function') {
                openAuthModal();
            } else {
                setTimeout(() => window.openAuthModal && window.openAuthModal(), 100);
            }
        }
    } else if (role === 'driver' || role === 'admin') {
        console.log('🚗/📊 Driver or Admin selected:', role);
        if (typeof openRoleLoginModal === 'function') {
            openRoleLoginModal(role);
        } else {
            setTimeout(() => window.openRoleLoginModal && window.openRoleLoginModal(role), 100);
        }
    }
};

// Assign real implementation and flush any queued calls from stub (index head)
window.selectRole = selectRoleImpl;
if (window.__pendingRoleQueue && Array.isArray(window.__pendingRoleQueue)) {
    while (window.__pendingRoleQueue.length) {
        const r = window.__pendingRoleQueue.shift();
        try {
            selectRoleImpl(r);
        } catch (e) {
            console.error('Error processing queued role', r, e);
        }
    }
}

console.log('✅ window.selectRole defined');

// --- Safe Storage Wrapper (Fixes SecurityError in Sandboxed Iframes) ---
const SafeStorage = {
    _memory: {},
    _isAvailable: null,
    _checkAvailability() {
        if (this._isAvailable !== null) return this._isAvailable;
        try {
            // Try to touch localStorage to see if it throws SecurityError
            const x = '__storage_test__';
            window.localStorage.setItem(x, x);
            window.localStorage.removeItem(x);
            this._isAvailable = true;
        } catch (e) {
            console.warn('LocalStorage is not available (Sandboxed). Using memory fallback.');
            this._isAvailable = false;
        }
        return this._isAvailable;
    },
    getItem(key) {
        if (this._checkAvailability()) {
            return window.localStorage.getItem(key);
        }
        return this._memory[key] || null;
    },
    setItem(key, value) {
        if (this._checkAvailability()) {
            window.localStorage.setItem(key, value);
        } else {
            this._memory[key] = value;
        }
    },
    removeItem(key) {
        if (this._checkAvailability()) {
            window.localStorage.removeItem(key);
        } else {
            delete this._memory[key];
        }
    }
};

// --- Dark Mode ---
const DARK_MODE_KEY = 'akwadra_dark_mode';

function updateDarkModeToggleUI() {
    const isDark = document.body.classList.contains('dark-mode');
    document.querySelectorAll('[data-dark-toggle-label]').forEach((el) => {
        el.textContent = isDark ? 'مفعل' : 'غير مفعل';
    });
    document.querySelectorAll('[data-dark-toggle-icon]').forEach((el) => {
        el.classList.toggle('fa-moon', !isDark);
        el.classList.toggle('fa-sun', isDark);
    });
}

function setDarkMode(enabled) {
    document.body.classList.toggle('dark-mode', enabled);
    SafeStorage.setItem(DARK_MODE_KEY, enabled ? '1' : '0');
    updateDarkModeToggleUI();
}

function toggleDarkMode() {
    const isDark = document.body.classList.contains('dark-mode');
    setDarkMode(!isDark);
}

window.toggleDarkMode = toggleDarkMode;

document.addEventListener('DOMContentLoaded', () => {
    const saved = SafeStorage.getItem(DARK_MODE_KEY);
    if (saved === '1') {
        setDarkMode(true);
    } else {
        updateDarkModeToggleUI();
    }
});

// --- Global State ---
let currentUserRole = null; // 'passenger', 'driver', 'admin'
let currentCarType = null;
let currentTripPrice = 0;
let previousState = 'driver';
let mapState = {
    x: -1500 + (window.innerWidth / 2),
    y: -1500 + (window.innerHeight / 2),
    scale: 1,
    isDragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    clickStartX: 0,
    clickStartY: 0
};

let driverAnimationId = null;
let driverRequestTimeout = null;
let loginAttempts = 0; // Track failed login attempts
let driverPollingInterval = null;
let currentDriverProfile = null;
let currentIncomingTrip = null;
let activeDriverTripId = null;
let driverDemoRequestAt = 0;
let driverForceRequestAt = 0;

function isMapWorldActive() {
    const mapWorld = document.getElementById('map-world');
    return mapWorld && !mapWorld.classList.contains('hidden');
}

// No hardcoded demo accounts - use database authentication

// Saved places storage
const savedPlaces = {
    home: null,
    work: null,
    favorite: null,
    _storageKey: 'akwadra_saved_places',
    
    load() {
        try {
            const data = SafeStorage.getItem(this._storageKey);
            if (data) {
                const parsed = JSON.parse(data);
                this.home = parsed.home || null;
                this.work = parsed.work || null;
                this.favorite = parsed.favorite || null;
                this.updateIndicators();
            }
        } catch (e) {
            console.warn('Failed to load saved places', e);
        }
    },
    
    save() {
        const data = { home: this.home, work: this.work, favorite: this.favorite };
        SafeStorage.setItem(this._storageKey, JSON.stringify(data));
        this.updateIndicators();
    },
    
    set(type, location) {
        if (!['home', 'work', 'favorite'].includes(type)) return;
        this[type] = location;
        this.save();
    },
    
    get(type) {
        return this[type];
    },
    
    updateIndicators() {
        ['home', 'work', 'favorite'].forEach(type => {
            const indicator = document.getElementById(`${type}-set-indicator`);
            if (indicator) {
                if (this[type]) {
                    indicator.classList.remove('hidden');
                } else {
                    indicator.classList.add('hidden');
                }
            }
        });
    }
};

// Leaflet map state
let leafletMap = null;
let pickupMarkerL = null;
let destMarkerL = null;
let driverMarkerL = null;
let passengerMarkerL = null;
let routePolyline = null;
let currentPickup = null; // {lat, lng}
let currentDestination = null; // {lat, lng, label}
let driverLocation = null; // {lat, lng}
let passengerPickup = null; // {lat, lng, label}
let etaCountdown = null;
let etaSeconds = 0;
let driverToPassengerAnim = null;
let mapSelectionMode = 'destination';

function initLeafletMap() {
    const mapDiv = document.getElementById('leaflet-map');
    if (!mapDiv) {
        console.error('Leaflet map div not found!');
        return;
    }
    if (leafletMap) {
        leafletMap.invalidateSize();
        console.log('Leaflet map already initialized, resizing...');
        return;
    }
    
    console.log('Initializing Leaflet map...');
    
    // Egypt center fallback
    const egyptCenter = [26.8206, 30.8025];
    leafletMap = L.map('leaflet-map', { 
        zoomControl: false,
        attributionControl: true
    }).setView(egyptCenter, 6);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(leafletMap);
    
    console.log('✅ Leaflet map initialized successfully');

    // Custom controls hookup
    const zi = document.getElementById('zoom-in');
    const zo = document.getElementById('zoom-out');
    const cm = document.getElementById('center-map');
    if (zi) zi.onclick = () => leafletMap.zoomIn();
    if (zo) zo.onclick = () => leafletMap.zoomOut();
    if (cm) cm.onclick = () => {
        if (currentPickup) leafletMap.setView([currentPickup.lat, currentPickup.lng], Math.max(leafletMap.getZoom(), 14));
    };

    // Geolocate user
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude, longitude } = pos.coords;
            // Reverse geocode to get readable address
            reverseGeocode(latitude, longitude, (address) => {
                setPickup({ lat: latitude, lng: longitude }, address);
                leafletMap.setView([latitude, longitude], 14);
            });
        }, () => {
            // Fallback to Cairo
            setPickup({ lat: 30.0444, lng: 31.2357 }, 'القاهرة، مصر');
            leafletMap.setView([30.0444, 31.2357], 12);
        }, { enableHighAccuracy: true, timeout: 6000 });
    } else {
        setPickup({ lat: 30.0444, lng: 31.2357 }, 'القاهرة، مصر');
        leafletMap.setView([30.0444, 31.2357], 12);
    }

    // Destination/Pickup select by click
    leafletMap.on('click', e => {
        if (mapSelectionMode === 'pickup') {
            reverseGeocode(e.latlng.lat, e.latlng.lng, (address) => {
                setPickup({ lat: e.latlng.lat, lng: e.latlng.lng }, address);
                leafletMap.setView([e.latlng.lat, e.latlng.lng], Math.max(leafletMap.getZoom(), 14));
                showToast('تم تحديد موقع الالتقاط');
            });
            mapSelectionMode = 'destination';
            updateMapSelectionButtons();
            return;
        }

        setDestination({ lat: e.latlng.lat, lng: e.latlng.lng }, 'وجهة محددة');
    });

    // Hook destination search input
    const destInput = document.getElementById('dest-input');
    if (destInput) {
        destInput.addEventListener('keydown', evt => {
            if (evt.key === 'Enter') {
                const q = destInput.value.trim();
                if (q) searchDestinationByName(q);
            }
        });
    }

    // Hook pickup search input
    const pickupInput = document.getElementById('current-loc-input');
    if (pickupInput) {
        pickupInput.addEventListener('keydown', evt => {
            if (evt.key === 'Enter') {
                const q = pickupInput.value.trim();
                if (q) searchPickupByName(q);
            }
        });
    }
}

function moveLeafletMapToContainer(containerId) {
    const mapEl = document.getElementById('leaflet-map');
    const container = document.getElementById(containerId);
    if (!mapEl || !container) return;

    if (mapEl.parentElement !== container) {
        container.appendChild(mapEl);
    }

    mapEl.style.display = 'block';
    mapEl.style.position = 'absolute';
    mapEl.style.inset = '0';
    mapEl.style.zIndex = '1';
    mapEl.style.width = '100%';
    mapEl.style.height = '100%';

    if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 100);
    }
}

function setPickup(coords, label) {
    currentPickup = { ...coords, label: label || 'نقطة الالتقاط' };
    if (!leafletMap) return;
    if (pickupMarkerL) pickupMarkerL.remove();
    pickupMarkerL = L.marker([coords.lat, coords.lng], { draggable: true }).addTo(leafletMap);
    pickupMarkerL.bindPopup(currentPickup.label).openPopup();
    
    // Update current location input
    updateCurrentLocationInput(currentPickup.label);
    
    pickupMarkerL.on('dragend', () => {
        const p = pickupMarkerL.getLatLng();
        currentPickup.lat = p.lat;
        currentPickup.lng = p.lng;
        // Reverse geocode to get address
        reverseGeocode(p.lat, p.lng, (address) => {
            currentPickup.label = address;
            pickupMarkerL.setPopupContent(address).openPopup();
            updateCurrentLocationInput(address);
            showToast('تم تعديل موقع الالتقاط');
        });
    });
}

function setDestination(coords, label) {
    currentDestination = { ...coords, label: label || 'الوجهة' };
    if (!leafletMap) return;
    if (destMarkerL) destMarkerL.remove();
    destMarkerL = L.marker([coords.lat, coords.lng], { draggable: false, opacity: 0.9 }).addTo(leafletMap);
    destMarkerL.bindPopup(currentDestination.label).openPopup();
    document.getElementById('ride-dest-text') && (document.getElementById('ride-dest-text').innerText = currentDestination.label);
    confirmDestination(currentDestination.label);
}

function searchDestinationByName(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=eg&q=${encodeURIComponent(q)}`;
    fetch(url, { headers: { 'Accept': 'application/json' }})
        .then(r => r.json())
        .then(arr => {
            if (!arr || !arr.length) { showToast('لم يتم العثور على نتائج'); return; }
            const best = arr[0];
            const lat = parseFloat(best.lat), lon = parseFloat(best.lon);
            setDestination({ lat, lng: lon }, best.display_name);
            leafletMap.setView([lat, lon], 15);
        })
        .catch(() => showToast('حدث خطأ في البحث'));
}

function searchPickupByName(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=eg&q=${encodeURIComponent(q)}`;
    fetch(url, { headers: { 'Accept': 'application/json' }})
        .then(r => r.json())
        .then(arr => {
            if (!arr || !arr.length) { showToast('لم يتم العثور على نتائج'); return; }
            const best = arr[0];
            const lat = parseFloat(best.lat), lon = parseFloat(best.lon);
            setPickup({ lat, lng: lon }, best.display_name);
            leafletMap.setView([lat, lon], 15);
            showToast('تم تحديد موقع الالتقاط');
        })
        .catch(() => showToast('حدث خطأ في البحث'));
}

function reverseGeocode(lat, lng, callback) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ar`;
    fetch(url, { headers: { 'Accept': 'application/json' }})
        .then(r => r.json())
        .then(data => {
            const address = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            callback(address);
        })
        .catch(() => {
            callback(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        });
}

function updateCurrentLocationInput(text) {
    const inp = document.getElementById('current-loc-input');
    if (inp) inp.value = text || 'حدد موقعك';
}

function updateMapSelectionButtons() {
    const pickupBtn = document.getElementById('pickup-map-btn');
    const destBtn = document.getElementById('dest-map-btn');

    if (pickupBtn) {
        pickupBtn.classList.toggle('ring-2', mapSelectionMode === 'pickup');
        pickupBtn.classList.toggle('ring-indigo-500', mapSelectionMode === 'pickup');
    }
    if (destBtn) {
        destBtn.classList.toggle('ring-2', mapSelectionMode === 'destination');
        destBtn.classList.toggle('ring-indigo-500', mapSelectionMode === 'destination');
    }
}

function startMapSelection(mode) {
    mapSelectionMode = mode === 'pickup' ? 'pickup' : 'destination';
    updateMapSelectionButtons();
    if (mapSelectionMode === 'pickup') {
        showToast('اضغط على الخريطة لتحديد موقعك الحالي');
    } else {
        showToast('اضغط على الخريطة لتحديد الوجهة');
    }
}

function useCurrentLocation() {
    if (!navigator.geolocation) {
        showToast('المتصفح لا يدعم تحديد الموقع');
        return;
    }
    navigator.geolocation.getCurrentPosition(pos => {
        const { latitude, longitude } = pos.coords;
        reverseGeocode(latitude, longitude, (address) => {
            setPickup({ lat: latitude, lng: longitude }, address);
            if (leafletMap) leafletMap.setView([latitude, longitude], Math.max(leafletMap.getZoom(), 14));
            showToast('تم تحديث موقعك الحالي');
        });
    }, () => {
        showToast('تعذر تحديد موقعك');
    }, { enableHighAccuracy: true, timeout: 6000 });
}

window.startMapSelection = startMapSelection;
window.useCurrentLocation = useCurrentLocation;

// Saved places functionality
window.selectSavedPlace = function(type) {
    const place = savedPlaces.get(type);
    if (!place) {
        const labels = { home: 'المنزل', work: 'العمل', favorite: 'المفضلة' };
        showToast(`لم يتم حفظ عنوان ${labels[type]} بعد. اضغط مطولاً للحفظ`);
        return;
    }
    
    // Set as destination
    setDestination(place, place.label);
    if (leafletMap) {
        leafletMap.setView([place.lat, place.lng], 15);
    }
    
    // Update destination input
    const destInput = document.getElementById('dest-input');
    if (destInput) destInput.value = place.label;
};

window.savePlaceAs = function(event, type) {
    event.preventDefault();
    if (!currentPickup && !currentDestination) {
        showToast('لا يوجد موقع محدد للحفظ');
        return;
    }
    
    // Prefer destination if set, else pickup
    const location = currentDestination || currentPickup;
    savedPlaces.set(type, location);
    
    const labels = { home: 'المنزل', work: 'العمل', favorite: 'المفضلة' };
    showToast(`تم حفظ الموقع كـ ${labels[type]}`);
};

// Live driver tracking on Leaflet map
function startDriverTrackingLive() {
    if (!leafletMap || !currentPickup) return;
    
    // Hide the decorative map-world layer
    const mapWorld = document.getElementById('map-world');
    if (mapWorld) mapWorld.style.display = 'none';
    
    // Move Leaflet map to driver view container
    const leafletMapEl = document.getElementById('leaflet-map');
    const driverMapView = document.getElementById('driver-map-view');
    
    if (leafletMapEl && driverMapView) {
        // Temporarily detach and reattach to new container
        driverMapView.appendChild(leafletMapEl);
        leafletMapEl.style.display = 'block';
        leafletMapEl.style.position = 'absolute';
        leafletMapEl.style.inset = '0';
        leafletMapEl.style.zIndex = '1';
        leafletMapEl.style.width = '100%';
        leafletMapEl.style.height = '100%';
    }
    
    // Invalidate map size after moving
    setTimeout(() => {
        if (leafletMap) leafletMap.invalidateSize();
    }, 100);
    
    // Clear any existing driver marker
    if (driverMarkerL) driverMarkerL.remove();
    if (routePolyline) routePolyline.remove();
    
    // Invalidate map size to ensure proper rendering
    leafletMap.invalidateSize();
    
    // Create driver marker with custom icon (car)
    const carIcon = L.divIcon({
        className: 'driver-car-marker',
        html: '<div style="font-size: 32px; transform: rotate(0deg);"><i class="fas fa-car" style="color: #4f46e5;"></i></div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    
    // Initial driver location: offset from pickup
    const offsetLat = 0.04; // ~4km for realistic timing
    const offsetLng = 0.04;
    driverLocation = {
        lat: currentPickup.lat + offsetLat,
        lng: currentPickup.lng + offsetLng
    };
    
    driverMarkerL = L.marker([driverLocation.lat, driverLocation.lng], { icon: carIcon }).addTo(leafletMap);
    driverMarkerL.bindPopup('🚗 السيارة قادمة إليك').openPopup();
    
    console.log('✅ Driver marker added at:', driverLocation);
    
    // Draw route line
    routePolyline = L.polyline([
        [driverLocation.lat, driverLocation.lng],
        [currentPickup.lat, currentPickup.lng]
    ], { color: '#4f46e5', weight: 4, opacity: 0.7, dashArray: '10, 10' }).addTo(leafletMap);
    
    console.log('✅ Route line drawn');
    
    // Fit map to show both driver and pickup
    const bounds = L.latLngBounds([
        [driverLocation.lat, driverLocation.lng],
        [currentPickup.lat, currentPickup.lng]
    ]);
    leafletMap.fitBounds(bounds, { padding: [50, 50] });
    
    console.log('✅ Map fitted to bounds, starting animation...');
    
    // Animate driver moving to pickup
    animateDriverToPickup();
}

function animateDriverToPickup() {
    if (!driverMarkerL || !currentPickup) return;
    
    const startLat = driverLocation.lat;
    const startLng = driverLocation.lng;
    const endLat = currentPickup.lat;
    const endLng = currentPickup.lng;
    const duration = etaSeconds * 1000; // ms
    const startTime = Date.now();
    
    function moveStep() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease-in-out
        const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
        
        const currentLat = startLat + (endLat - startLat) * eased;
        const currentLng = startLng + (endLng - startLng) * eased;
        
        driverLocation = { lat: currentLat, lng: currentLng };
        driverMarkerL.setLatLng([currentLat, currentLng]);
        
        // Update route line
        if (routePolyline) {
            routePolyline.setLatLngs([
                [currentLat, currentLng],
                [endLat, endLng]
            ]);
        }
        
        // Calculate distance remaining
        const distanceMeters = calculateDistance(currentLat, currentLng, endLat, endLng);
        updateDriverDistance(distanceMeters);
        
        // Calculate bearing for car rotation
        const bearing = calculateBearing(currentLat, currentLng, endLat, endLng);
        const carEl = driverMarkerL.getElement();
        if (carEl) {
            const iconDiv = carEl.querySelector('div');
            if (iconDiv) iconDiv.style.transform = `rotate(${bearing}deg)`;
        }
        
        if (progress < 1) {
            requestAnimationFrame(moveStep);
        } else {
            // Driver arrived
            showToast('🎉 وصل الكابتن! استعد للركوب');
            if (routePolyline) routePolyline.remove();
            switchSection('in-ride');
            
            // Start trip to destination
            startTripToDestination();
        }
    }
    
    requestAnimationFrame(moveStep);
}

function clearDriverPassengerRoute() {
    if (driverToPassengerAnim) {
        cancelAnimationFrame(driverToPassengerAnim);
        driverToPassengerAnim = null;
    }
    if (passengerMarkerL) {
        passengerMarkerL.remove();
        passengerMarkerL = null;
    }
    if (routePolyline) {
        routePolyline.remove();
        routePolyline = null;
    }
    passengerPickup = null;
}

function getDriverBaseLocation() {
    if (driverLocation) return { ...driverLocation };
    if (currentPickup) return { ...currentPickup };
    if (leafletMap) {
        const center = leafletMap.getCenter();
        return { lat: center.lat, lng: center.lng };
    }
    return { lat: 30.0444, lng: 31.2357 };
}

function ensureDriverMarker(location) {
    if (!leafletMap) return;
    const carIcon = L.divIcon({
        className: 'driver-car-marker',
        html: '<div style="font-size: 32px; transform: rotate(0deg);"><i class="fas fa-car" style="color: #10b981;"></i></div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    if (driverMarkerL) {
        driverMarkerL.setLatLng([location.lat, location.lng]);
        return;
    }
    driverMarkerL = L.marker([location.lat, location.lng], { icon: carIcon }).addTo(leafletMap);
    driverMarkerL.bindPopup('🚗 موقعك الحالي').openPopup();
}

function setPassengerPickup(coords, label) {
    passengerPickup = { ...coords, label: label || 'موقع الراكب' };
    if (!leafletMap) return;
    if (passengerMarkerL) passengerMarkerL.remove();

    const riderIcon = L.divIcon({
        className: 'passenger-marker',
        html: '<div style="font-size: 26px;"><i class="fas fa-user" style="color: #0f172a;"></i></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });

    passengerMarkerL = L.marker([coords.lat, coords.lng], { icon: riderIcon }).addTo(leafletMap);
    passengerMarkerL.bindPopup(passengerPickup.label).openPopup();
}

function generatePassengerPickup(base) {
    const offsetLat = (Math.random() > 0.5 ? 1 : -1) * (0.01 + Math.random() * 0.02);
    const offsetLng = (Math.random() > 0.5 ? 1 : -1) * (0.01 + Math.random() * 0.02);
    return {
        lat: base.lat + offsetLat,
        lng: base.lng + offsetLng,
        label: 'موقع الراكب'
    };
}

function startDriverToPassengerRoute() {
    if (!leafletMap) return;
    moveLeafletMapToContainer('map-container');
    clearDriverPassengerRoute();

    const driverStart = getDriverBaseLocation();
    ensureDriverMarker(driverStart);

    if (pickupMarkerL) {
        pickupMarkerL.remove();
        pickupMarkerL = null;
    }

    const passenger = passengerPickup || generatePassengerPickup(driverStart);
    setPassengerPickup(passenger, passenger.label);

    routePolyline = L.polyline([
        [driverStart.lat, driverStart.lng],
        [passenger.lat, passenger.lng]
    ], { color: '#10b981', weight: 4, opacity: 0.8, dashArray: '8, 8' }).addTo(leafletMap);

    const bounds = L.latLngBounds([
        [driverStart.lat, driverStart.lng],
        [passenger.lat, passenger.lng]
    ]);
    leafletMap.fitBounds(bounds, { padding: [50, 50] });

    animateDriverToPassenger(driverStart, passenger);
}

function animateDriverToPassenger(start, target) {
    const distanceMeters = calculateDistance(start.lat, start.lng, target.lat, target.lng);
    const speedMps = 9; // ~32 km/h
    const duration = Math.max(20000, Math.min(180000, Math.round(distanceMeters / speedMps) * 1000));
    const startTime = Date.now();

    function moveStep() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

        const currentLat = start.lat + (target.lat - start.lat) * eased;
        const currentLng = start.lng + (target.lng - start.lng) * eased;
        driverLocation = { lat: currentLat, lng: currentLng };

        if (driverMarkerL) driverMarkerL.setLatLng([currentLat, currentLng]);
        if (routePolyline) {
            routePolyline.setLatLngs([
                [currentLat, currentLng],
                [target.lat, target.lng]
            ]);
        }

        const bearing = calculateBearing(currentLat, currentLng, target.lat, target.lng);
        const carEl = driverMarkerL && driverMarkerL.getElement();
        if (carEl) {
            const iconDiv = carEl.querySelector('div');
            if (iconDiv) iconDiv.style.transform = `rotate(${bearing}deg)`;
        }

        if (progress < 1) {
            driverToPassengerAnim = requestAnimationFrame(moveStep);
        } else {
            driverToPassengerAnim = null;
            showToast('✅ وصلت إلى موقع الراكب');
        }
    }

    driverToPassengerAnim = requestAnimationFrame(moveStep);
}

function calculateBearing(lat1, lng1, lat2, lng2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;
    
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    const bearing = toDeg(Math.atan2(y, x));
    return (bearing + 360) % 360;
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const toRad = deg => deg * Math.PI / 180;
    
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in meters
}

// Simulate trip from pickup to destination
function startTripToDestination() {
    showToast('🚗 بدأت الرحلة إلى الوجهة');
    
    // Simulate trip duration (30-60 seconds for demo)
    const tripDuration = 45000; // 45 seconds
    let remainingSeconds = Math.floor(tripDuration / 1000);
    
    // Update ETA countdown
    const etaDisplay = document.getElementById('ride-eta-display');
    if (etaDisplay) {
        etaDisplay.innerText = `${Math.floor(remainingSeconds / 60)} د ${remainingSeconds % 60} ث`;
    }
    
    const countdown = setInterval(() => {
        remainingSeconds--;
        if (etaDisplay && remainingSeconds > 0) {
            const mins = Math.floor(remainingSeconds / 60);
            const secs = remainingSeconds % 60;
            etaDisplay.innerText = `${mins} د ${secs} ث`;
        }
        
        if (remainingSeconds <= 0) {
            clearInterval(countdown);
        }
    }, 1000);
    
    // When trip ends, show payment
    setTimeout(() => {
        clearInterval(countdown);
        showToast('✅ وصلت إلى وجهتك!', 3000);
        
        // Prepare payment screen
        updatePaymentSummary();
        
        // Show payment method selection
        setTimeout(() => {
            window.switchSection('payment-method');
            showToast('💳 اختر طريقة الدفع لإنهاء الرحلة');
        }, 2000);
    }, tripDuration);
}

// End trip manually
window.endTripEarly = function() {
    showToast('✅ تم إنهاء الرحلة');
    updatePaymentSummary();
    setTimeout(() => {
        window.switchSection('payment-method');
        showToast('💳 اختر طريقة الدفع');
    }, 500);
};

// Share ride details
window.shareRide = function() {
    const rideDetails = `
🚗 تفاصيل رحلتي مع أكوادرا تاكسي
من: ${document.getElementById('current-loc-input').value || 'حدد موقعك'}
إلى: ${document.getElementById('dest-input').value || 'الوجهة'}
السائق: أحمد محمد ⭐ 4.9
    `.trim();
    
    if (navigator.share) {
        navigator.share({
            title: 'رحلتي مع أكوادرا',
            text: rideDetails
        }).catch(err => console.log('Error sharing', err));
    } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(rideDetails).then(() => {
            showToast('✅ تم نسخ التفاصيل');
        });
    }
}

function startETACountdown() {
    if (etaCountdown) clearInterval(etaCountdown);
    
    etaCountdown = setInterval(() => {
        if (etaSeconds > 0) {
            etaSeconds--;
            const etaEl = document.getElementById('eta-display');
            if (etaEl) etaEl.innerText = formatETA(etaSeconds);
        } else {
            clearInterval(etaCountdown);
        }
    }, 1000);
}

function formatETA(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
        return `${mins} د ${secs} ث`;
    }
    return `${secs} ث`;
}

function stopDriverTrackingLive() {
    if (etaCountdown) clearInterval(etaCountdown);
    if (driverMarkerL) driverMarkerL.remove();
    if (routePolyline) routePolyline.remove();
}


// --- DATABASE SIMULATION SERVICE ---
const DB = {
    keyUser: 'akwadra_user',
    keyTrips: 'akwadra_trips',
    keySession: 'akwadra_session_active',

    init() {
        // No local seeding; rely on API data
    },

    getUser() {
        const data = SafeStorage.getItem(this.keyUser);
        return data ? JSON.parse(data) : null;
    },

    setUser(userData) {
        if (!userData) return null;
        const normalized = {
            id: userData.id,
            name: userData.name || 'مستخدم',
            email: userData.email,
            phone: userData.phone,
            role: userData.role || 'passenger',
            balance: userData.balance ?? 0,
            points: userData.points ?? 0,
            rating: userData.rating ?? 5,
            status: userData.status || 'عضو جديد',
            avatar: userData.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(userData.name || 'User')}`
        };
        SafeStorage.setItem(this.keyUser, JSON.stringify(normalized));
        updateUIWithUserData();
        return normalized;
    },

    updateUser(updates) {
        const user = this.getUser();
        if (!user) return;
        const updatedUser = { ...user, ...updates };
        SafeStorage.setItem(this.keyUser, JSON.stringify(updatedUser));
        updateUIWithUserData();
        return updatedUser;
    },

    getTrips() {
        const data = SafeStorage.getItem(this.keyTrips);
        return data ? JSON.parse(data) : [];
    },

    setTrips(trips) {
        SafeStorage.setItem(this.keyTrips, JSON.stringify(trips || []));
    },

    normalizeTrip(apiTrip, passengerName) {
        return {
            id: apiTrip.id,
            date: apiTrip.completed_at || apiTrip.cancelled_at || apiTrip.created_at,
            pickup: apiTrip.pickup_location,
            dropoff: apiTrip.dropoff_location,
            cost: Number(apiTrip.cost || 0),
            status: apiTrip.status,
            car: apiTrip.car_type || 'economy',
            driver: apiTrip.driver_name || 'غير محدد',
            passenger: passengerName || 'غير محدد',
            paymentMethod: apiTrip.payment_method || 'cash',
            rating: apiTrip.rating || 0
        };
    },

    async fetchTrips({ userId, role } = {}) {
        try {
            const params = new URLSearchParams();
            params.set('limit', '200');
            if (role === 'passenger' && userId) {
                params.set('user_id', String(userId));
            }

            const response = await fetch(`/api/trips?${params.toString()}`);
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Failed to fetch trips');
            }

            let tripsData = result.data || [];

            if (role === 'passenger' && userId && tripsData.length === 0) {
                const fallbackResponse = await fetch('/api/trips?limit=200');
                const fallbackResult = await fallbackResponse.json();
                if (fallbackResponse.ok && fallbackResult.success) {
                    tripsData = fallbackResult.data || [];
                }
            }

            const user = this.getUser();
            const passengerName = user?.name;
            const mapped = tripsData.map(trip => this.normalizeTrip(trip, passengerName));
            this.setTrips(mapped);
            return mapped;
        } catch (error) {
            console.error('Failed to fetch trips:', error);
            return this.getTrips();
        }
    },

    addTrip(trip) {
        const trips = this.getTrips();
        trips.unshift(trip);
        SafeStorage.setItem(this.keyTrips, JSON.stringify(trips));
    },

    saveSession() {
        SafeStorage.setItem(this.keySession, 'true');
    },

    hasSession() {
        return SafeStorage.getItem(this.keySession) === 'true';
    },

    clearSession() {
        SafeStorage.removeItem(this.keySession);
    }
};

// --- GLOBAL FUNCTIONS (EXPOSED TO WINDOW) ---
// REMOVED: window.selectRole is now defined at top of file for immediate availability

// Other window functions defined here


window.openAuthModal = function() {
    const am = document.getElementById('auth-modal');
    if(!am) return;
    am.classList.remove('hidden');
    setTimeout(() => {
        am.classList.remove('opacity-0', 'pointer-events-none');
    }, 50);
    
    switchAuthTab('phone');
    document.getElementById('auth-otp-section').classList.add('hidden');
    document.getElementById('auth-phone-form').classList.remove('hidden');
    document.getElementById('phone-input').value = '';
};

window.closeAuthModal = function() {
    const am = document.getElementById('auth-modal');
    if(!am) return;
    am.classList.add('opacity-0', 'pointer-events-none');
    setTimeout(() => {
        am.classList.add('hidden');
        if (!DB.hasSession()) {
            const rs = document.getElementById('role-selection-modal');
            if(rs) {
                rs.classList.remove('hidden');
                setTimeout(() => rs.classList.remove('opacity-0', 'pointer-events-none'), 50);
            }
        }
    }, 300);
};

// Role-specific login modal (driver/admin)
function openRoleLoginModal(role) {
    console.log('🔑 openRoleLoginModal called for:', role);
    const modal = document.getElementById('role-login-modal');
    if (!modal) {
        console.error('❌ role-login-modal not found!');
        return;
    }
    console.log('✅ Modal found, setting up...');
    modal.dataset.role = role;
    const titles = { driver: 'تسجيل دخول الكابتن', admin: 'تسجيل دخول الإدارة', passenger: 'تسجيل الدخول' };
    const hints = {
        driver: 'استخدم بيانات الكابتن - كلمة المرور: 12345678',
        admin: 'استخدم بيانات الإدارة - كلمة المرور: 12345678',
        passenger: 'استخدم بيانات الراكب - كلمة المرور: 12345678'
    };
    const titleEl = document.getElementById('role-login-title');
    const hintEl = document.getElementById('role-login-hint');
    if (titleEl) titleEl.innerText = titles[role] || titles.passenger;
    if (hintEl) hintEl.innerText = hints[role] || 'اكتب بيانات الدخول الخاصة بهذا الدور';

    const emailInput = document.getElementById('role-login-email');
    const passInput = document.getElementById('role-login-password');
    if (emailInput) emailInput.value = '';
    if (passInput) passInput.value = '';

    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0', 'pointer-events-none'), 30);
    setTimeout(() => emailInput && emailInput.focus(), 120);
}

function closeRoleLoginModal() {
    const modal = document.getElementById('role-login-modal');
    if (!modal) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    setTimeout(() => {
        modal.classList.add('hidden');
        // If user backed out, show role selector again
        const rs = document.getElementById('role-selection-modal');
        if (rs && !DB.hasSession()) {
            rs.classList.remove('hidden');
            setTimeout(() => rs.classList.remove('opacity-0', 'pointer-events-none'), 50);
        }
    }, 250);
}

window.submitRoleLogin = async function() {
    const modal = document.getElementById('role-login-modal');
    if (!modal) return;
    const role = modal.dataset.role || 'driver';
    const emailInput = document.getElementById('role-login-email');
    const passInput = document.getElementById('role-login-password');
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!email) {
        showToast('⚠️ يرجى إدخال البريد الإلكتروني');
        emailInput.focus();
        return;
    }
    if (!password) {
        showToast('⚠️ يرجى إدخال كلمة المرور');
        passInput.focus();
        return;
    }
    
    // Show loading
    showToast('⏳ جاري تسجيل الدخول...');
    
    try {
        // Call API to authenticate
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password, role })
        });
        
        const result = await response.json();
        
        if (!response.ok || !result.success) {
            loginAttempts++;
            showToast('❌ ' + (result.error || 'خطأ في تسجيل الدخول'));
            const parent = passInput.parentElement;
            if (parent) {
                parent.style.backgroundColor = '#fee';
                parent.style.borderColor = 'red';
                setTimeout(() => {
                    parent.style.backgroundColor = '';
                    parent.style.borderColor = '';
                }, 2000);
            }
            passInput.focus();
            
            // Show hint after 3 failed attempts
            if (loginAttempts >= 3) {
                setTimeout(() => {
                    showToast(`💡 تلميح: جميع كلمات المرور هي 12345678`, 8000);
                    loginAttempts = 0;
                }, 1000);
            }
            return;
        }
        
        // Check if user role matches requested role
        const userData = result.data;
        if (userData.role !== role) {
            showToast(`❌ هذا الحساب ليس حساب ${role === 'driver' ? 'كابتن' : role === 'admin' ? 'إدارة' : 'راكب'}`);
            return;
        }
        
        // Reset attempts on successful login
        loginAttempts = 0;
        
        // Save user data
        DB.currentUser = userData;
        DB.setUser(userData);
        DB.saveSession();
        
        showToast(`✅ مرحباً ${userData.name}`);
        closeRoleLoginModal();
        
        if (role === 'driver') {
            initDriverMode();
        } else if (role === 'admin') {
            initAdminMode();
        } else {
            initPassengerMode();
        }
    } catch (error) {
        console.error('Login error:', error);
        showToast('❌ خطأ في الاتصال بالخادم');
    }
};

window.switchAuthTab = function(type) {
    const bg = document.getElementById('auth-tab-bg');
    const tPhone = document.getElementById('tab-phone');
    const tEmail = document.getElementById('tab-email');
    const fPhone = document.getElementById('auth-phone-form');
    const fEmail = document.getElementById('auth-email-form');
    const fOtp = document.getElementById('auth-otp-section');

    if (type === 'phone') {
        bg.style.transform = 'translateX(0)';
        tPhone.classList.replace('text-gray-500', 'text-indigo-600');
        tEmail.classList.replace('text-indigo-600', 'text-gray-500');
        fPhone.classList.remove('hidden');
        fEmail.classList.add('hidden');
        fOtp.classList.add('hidden');
    } else {
        bg.style.transform = 'translateX(-100%)';
        tPhone.classList.replace('text-indigo-600', 'text-gray-500');
        tEmail.classList.replace('text-gray-500', 'text-indigo-600');
        fPhone.classList.add('hidden');
        fEmail.classList.remove('hidden');
        fOtp.classList.add('hidden');
    }
};

window.sendOTP = function() {
    const phone = document.getElementById('phone-input').value;
    if (!phone || phone.length < 9) {
        showToast('يرجى إدخال رقم هاتف صحيح');
        return;
    }

    const btn = document.getElementById('send-otp-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري الإرسال...';
    btn.disabled = true;

    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
        
        document.getElementById('auth-phone-form').classList.add('hidden');
        document.getElementById('auth-otp-section').classList.remove('hidden');
        document.getElementById('otp-phone-display').innerText = "+966 " + phone;
        
        const firstOtp = document.querySelector('.otp-input');
        if(firstOtp) firstOtp.focus();
        
        showToast('تم إرسال رمز التحقق: 1234');
    }, 1500);
};

window.verifyOTP = async function() {
    let otpCode = '';
    document.querySelectorAll('.otp-input').forEach(input => otpCode += input.value);
    
    if (otpCode.length < 4) {
        showToast('يرجى إدخال الرمز كاملاً');
        return;
    }

    const btn = document.querySelector('#auth-otp-section button');
    const originalText = btn.innerText;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري التحقق...';
    btn.disabled = true;

    try {
        const phoneRaw = document.getElementById('phone-input')?.value || '';
        const phoneDigits = phoneRaw.replace(/\D/g, '');
        const emailFallback = phoneDigits ? `passenger_${phoneDigits}@ubar.sa` : `passenger_${Date.now()}@ubar.sa`;
        const payload = {
            phone: phoneDigits || phoneRaw,
            name: 'راكب جديد',
            email: emailFallback
        };

        const response = await fetch('/api/users/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            showToast('❌ ' + (result.error || 'خطأ في تسجيل الدخول'));
            return;
        }

        DB.currentUser = result.data;
        DB.setUser(result.data);
        loginSuccess();
    } catch (error) {
        console.error('OTP login error:', error);
        showToast('❌ خطأ في الاتصال بالخادم');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

window.loginWithEmail = async function() {
    const emailInput = document.getElementById('email-input');
    const passwordInput = document.getElementById('password-input');
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    
    if (!email) {
        showToast('⚠️ يرجى إدخال البريد الإلكتروني');
        emailInput.focus();
        return;
    }
    if (!email.includes('@')) {
        showToast('⚠️ البريد الإلكتروني غير صحيح (يجب أن يحتوي على @)');
        const parent = emailInput.parentElement;
        if (parent) {
            parent.style.backgroundColor = '#fef3cd';
            parent.style.borderColor = '#ff9800';
            setTimeout(() => {
                parent.style.backgroundColor = '';
                parent.style.borderColor = '';
            }, 2000);
        }
        emailInput.focus();
        return;
    }
    if (!password) {
        showToast('⚠️ يرجى إدخال كلمة المرور');
        passwordInput.focus();
        return;
    }

    // Show loading
    showToast('⏳ جاري تسجيل الدخول...');
    
    try {
        const inferredName = email.split('@')[0] || 'راكب';
        // Call API to authenticate
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password, role: 'passenger', name: inferredName })
        });
        
        const result = await response.json();
        
        if (!response.ok || !result.success) {
            loginAttempts++;
            showToast('❌ ' + (result.error || 'خطأ في تسجيل الدخول'));
            const parent = passwordInput.parentElement;
            if (parent) {
                parent.style.backgroundColor = '#fee';
                parent.style.borderColor = 'red';
                setTimeout(() => {
                    parent.style.backgroundColor = '';
                    parent.style.borderColor = '';
                }, 2000);
            }
            passwordInput.focus();
            
            // Show hint after 3 failed attempts
            if (loginAttempts >= 3) {
                setTimeout(() => {
                    showToast(`💡 تلميح: جميع كلمات المرور هي 12345678`, 8000);
                    loginAttempts = 0;
                }, 1000);
            }
            return;
        }
        
        const userData = result.data;

        // Reset attempts on successful login
        loginAttempts = 0;

        // Save user data
        DB.currentUser = userData;
        DB.setUser(userData);
        DB.saveSession();

        showToast(`✅ مرحباً ${userData.name}`);

        if (userData.role === 'admin') {
            window.closeAuthModal();
            initAdminMode();
            return;
        }

        if (userData.role === 'driver') {
            window.closeAuthModal();
            initDriverMode();
            return;
        }

        if (userData.role !== 'passenger') {
            showToast(`❌ هذا الحساب ليس حساب راكب`);
            return;
        }

        loginSuccess();
    } catch (error) {
        console.error('Login error:', error);
        showToast('❌ خطأ في الاتصال بالخادم');
    }
};

window.selectCar = function(element, type) {
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected', 'ring-2', 'ring-indigo-500');
    });
    element.classList.add('selected');
    currentCarType = type;
    
    const est = computeTripEstimates();
    currentTripPrice = computePrice(type, est.distanceKm);

    // Update selected car price display in the card
    const priceEl = element.querySelector('.text-xl');
    if (priceEl) priceEl.innerText = `${currentTripPrice} ر.س`;

    const reqBtn = document.getElementById('request-btn');
    const priceSummary = document.getElementById('ride-price-summary');
    if (priceSummary) {
        priceSummary.classList.remove('hidden');
        priceSummary.innerText = `السعر: ${currentTripPrice} ر.س`;
    }
    if (reqBtn) {
        reqBtn.disabled = false;
        const names = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر', 'delivery': 'توصيل' };
        reqBtn.querySelector('span').innerText = `اطلب ${names[type]} — ${currentTripPrice} ر.س`;
        reqBtn.classList.add('animate-pulse');
        setTimeout(() => reqBtn.classList.remove('animate-pulse'), 500);
    }
};

window.toggleCarOptions = function() {
    const list = document.getElementById('car-options-list');
    const toggleBtn = document.getElementById('car-options-toggle');
    const toggleText = document.getElementById('car-options-toggle-text');
    const toggleIcon = document.getElementById('car-options-toggle-icon');

    if (!list || !toggleBtn) return;

    const isNowHidden = list.classList.toggle('hidden');
    if (toggleText) {
        toggleText.innerText = isNowHidden ? 'إظهار أنواع السيارات' : 'إخفاء أنواع السيارات';
    }
    if (toggleIcon) {
        toggleIcon.classList.toggle('fa-chevron-down', isNowHidden);
        toggleIcon.classList.toggle('fa-chevron-up', !isNowHidden);
    }
    toggleBtn.setAttribute('aria-expanded', (!isNowHidden).toString());
};

window.resetApp = function() {
    if (currentUserRole !== 'passenger') return;

    const destInput = document.getElementById('dest-input');
    if (destInput) destInput.value = '';
    currentCarType = null;
    
    const reqBtn = document.getElementById('request-btn');
    if (reqBtn) {
        reqBtn.disabled = true;
        reqBtn.querySelector('span').innerText = 'اطلب سيارة';
    }
    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.classList.add('hidden');
    
    document.querySelectorAll('.car-select').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.star-btn').forEach(b => { b.classList.remove('text-yellow-400'); b.classList.add('text-gray-300'); });

    const userMarker = document.getElementById('user-marker');
    const destMarker = document.getElementById('dest-marker');
    if (userMarker) userMarker.classList.remove('opacity-0');
    if (destMarker) destMarker.classList.add('hidden');
    
    stopDriverTracking(); 
    stopDriverTrackingLive();
    
    // Reset payment
    selectedPaymentMethod = null;
    appliedPromo = null;
    promoDiscount = 0;
    
    switchSection('destination');
};

window.confirmDestination = function(destination) {
    const userMarker = document.getElementById('user-marker');
    const backBtn = document.getElementById('back-btn');
    const reqBtn = document.getElementById('request-btn');

    if (userMarker) userMarker.classList.add('opacity-0'); 
    if (backBtn) backBtn.classList.remove('hidden');
    switchSection('rideSelect');

    // Update distance/time based on pickup/destination
    updateTripEstimatesUI();
    if (reqBtn) {
        reqBtn.disabled = true;
        reqBtn.querySelector('span').innerText = 'اختر نوع السيارة';
    }
};

window.switchSection = function(name) {
    const sections = {
        destination: document.getElementById('state-destination'),
        rideSelect: document.getElementById('state-ride-select'),
        loading: document.getElementById('state-loading'),
        driver: document.getElementById('state-driver'),
        inRide: document.getElementById('state-in-ride'),
        'payment-method': document.getElementById('state-payment-method'),
        'payment-invoice': document.getElementById('state-payment-invoice'),
        'payment-success': document.getElementById('state-payment-success'),
        rating: document.getElementById('state-rating'),
        profile: document.getElementById('state-profile'),
        chat: document.getElementById('state-chat'),
        'trip-history': document.getElementById('state-trip-history'),
        'trip-details': document.getElementById('state-trip-details'),
        offers: document.getElementById('state-offers')
    };

    const currentVisible = Object.keys(sections).find(key => sections[key] && !sections[key].classList.contains('hidden'));
    if(currentVisible && name === 'chat') {
        previousState = currentVisible;
    }

    Object.values(sections).forEach(sec => {
        if(sec) {
            sec.classList.add('hidden');
            sec.classList.remove('slide-up-enter-active');
        }
    });
    const target = sections[name];
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('slide-up-enter');
        // Force reflow
        void target.offsetWidth;
        target.classList.add('slide-up-enter-active');
        target.classList.remove('slide-up-enter');
    }
    
    if(name === 'profile') {
        updateUIWithUserData();
        renderTripHistory();
    }
};

window.cancelRide = function() {
    if (!confirm('هل أنت متأكد من إلغاء الرحلة؟\nقد يتم فرض رسوم إلغاء.')) return;
    
    // Clear driver marker and route
    if (driverMarkerL) driverMarkerL.remove();
    if (routePolyline) routePolyline.remove();
    if (etaCountdown) clearInterval(etaCountdown);
    
    showToast('⚠️ تم إلغاء الرحلة');
    
    setTimeout(() => {
        switchSection('destination');
    }, 1000);
};

window.callDriver = function() {
    showToast('📞 جاري الاتصال بالكابتن...');
    // In real app, would initiate phone call
    setTimeout(() => {
        showToast('☎️ رقم الكابتن: 0501234567', 5000);
    }, 1000);
};

window.openChat = function() {
    switchSection('chat');
    const msgs = document.getElementById('chat-messages');
    const inp = document.getElementById('chat-input');
    if(msgs) msgs.scrollTop = msgs.scrollHeight;
    if(inp) setTimeout(() => inp.focus(), 300);
};

window.closeChat = function() {
    switchSection(previousState);
};

window.openDriverProfile = function() {
    window.location.href = 'profile.html';
};

window.sendChatMessage = function() {
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');
    const text = chatInput.value.trim();
    if(!text) return;

    const msgHtml = `
    <div class="flex items-start justify-end msg-enter">
        <div class="bg-indigo-600 text-white rounded-2xl rounded-tl-none px-4 py-2.5 shadow-md text-sm max-w-[85%]">
            ${text}
            <div class="text-[10px] text-indigo-200 mt-1 text-left flex items-center justify-end gap-1">
                ${new Date().toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'})} <i class="fas fa-check-double"></i>
            </div>
        </div>
    </div>`;
    
    chatMessages.insertAdjacentHTML('beforeend', msgHtml);
    chatInput.value = '';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    simulateDriverResponse(text);
};

window.driverRejectRequest = async function() {
    try {
        const tripId = currentIncomingTrip?.id;
        const isLocalDemo = tripId && typeof tripId === 'string' && tripId.startsWith('DEMO-');
        if (tripId && !isLocalDemo) {
            await ApiService.trips.reject(currentIncomingTrip.id);
        }
    } catch (error) {
        console.error('Reject trip failed:', error);
        showToast('❌ تعذر رفض الطلب الآن');
    }

    currentIncomingTrip = null;
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    setDriverPanelVisible(true);
    clearDriverPassengerRoute();
    showToast('تم رفض الطلب');
    triggerDriverRequestPolling();
};

window.driverAcceptRequest = async function() {
    const acceptBtn = document.getElementById('driver-accept-btn');
    if (acceptBtn) acceptBtn.disabled = true;
    try {
        if (!currentIncomingTrip || !currentDriverProfile) {
            showToast('لا يوجد طلب صالح حالياً');
            return;
        }

        let tripId = currentIncomingTrip.id;
        const isLocalDemo = tripId && typeof tripId === 'string' && tripId.startsWith('DEMO-');

        if (!tripId || isLocalDemo) {
            try {
                const created = await ApiService.trips.create({
                    user_id: currentIncomingTrip.user_id || 1,
                    pickup_location: currentIncomingTrip.pickup_location,
                    dropoff_location: currentIncomingTrip.dropoff_location,
                    pickup_lat: currentIncomingTrip.pickup_lat ?? null,
                    pickup_lng: currentIncomingTrip.pickup_lng ?? null,
                    dropoff_lat: currentIncomingTrip.dropoff_lat ?? null,
                    dropoff_lng: currentIncomingTrip.dropoff_lng ?? null,
                    car_type: currentIncomingTrip.car_type || currentDriverProfile?.car_type || 'economy',
                    cost: currentIncomingTrip.cost || 0,
                    distance: currentIncomingTrip.distance || null,
                    duration: currentIncomingTrip.duration || null,
                    payment_method: currentIncomingTrip.payment_method || 'cash',
                    status: 'pending'
                });

                if (created?.data?.id) {
                    tripId = created.data.id;
                    currentIncomingTrip = { ...currentIncomingTrip, id: tripId };
                }
            } catch (error) {
                console.error('Failed to create trip before assign:', error);
            }
        }

        if (!tripId) {
            showToast('تعذر تجهيز الطلب، حاول مرة أخرى');
            return;
        }

        let assignResponse = null;
        try {
            assignResponse = await ApiService.trips.assignDriver(
                tripId,
                currentDriverProfile.id,
                currentDriverProfile.name
            );
        } catch (error) {
            console.error('Assign trip failed:', error);
        }

        if (!assignResponse?.success) {
            showToast('تم قبول الطلب محلياً');
            activeDriverTripId = tripId;
        } else {
            activeDriverTripId = assignResponse.data?.id || tripId;
        }

        const waiting = document.getElementById('driver-status-waiting');
        if (waiting) waiting.classList.add('hidden');
        const incoming = document.getElementById('driver-incoming-request');
        if (incoming) incoming.classList.add('hidden');
        document.getElementById('driver-active-trip').classList.remove('hidden');
        setDriverPanelVisible(true);

        const pickupLat = currentIncomingTrip.pickup_lat;
        const pickupLng = currentIncomingTrip.pickup_lng;
        if (pickupLat !== undefined && pickupLat !== null && pickupLng !== undefined && pickupLng !== null) {
            setPassengerPickup({ lat: Number(pickupLat), lng: Number(pickupLng), phone: currentIncomingTrip.passenger_phone }, currentIncomingTrip.pickup_location);
            passengerPickup.phone = currentIncomingTrip.passenger_phone;
        }

        startDriverToPassengerRoute();
        showToast('تم قبول الطلب! اذهب للراكب');
    } catch (error) {
        console.error('Error accepting driver request:', error);
        showToast('❌ خطأ أثناء قبول الطلب');
    } finally {
        if (acceptBtn) acceptBtn.disabled = false;
    }
};

function setDriverPanelVisible(visible) {
    const panel = document.getElementById('driver-ui-container');
    const toggleBtn = document.getElementById('driver-panel-toggle');
    if (!panel || !toggleBtn) return;

    const isDriver = currentUserRole === 'driver';
    if (!isDriver) {
        panel.classList.add('hidden');
        toggleBtn.classList.add('hidden');
        return;
    }

    if (visible) {
        panel.classList.remove('hidden');
        toggleBtn.classList.add('hidden');
    } else {
        panel.classList.add('hidden');
        toggleBtn.classList.remove('hidden');
    }
}

window.toggleDriverPanel = function() {
    const panel = document.getElementById('driver-ui-container');
    if (!panel) return;
    const isDriver = currentUserRole === 'driver';
    if (!isDriver) {
        panel.classList.add('hidden');
        const toggleBtn = document.getElementById('driver-panel-toggle');
        if (toggleBtn) toggleBtn.classList.add('hidden');
        return;
    }
    const isHidden = panel.classList.contains('hidden');
    setDriverPanelVisible(isHidden);
};

window.toggleDriverRequestPanel = function() {
    const panel = document.getElementById('driver-incoming-request');
    if (!panel) return;
    panel.classList.toggle('collapsed');
};

window.driverOpenNavigation = function() {
    if (!leafletMap) {
        showToast('الخريطة غير جاهزة');
        return;
    }

    const origin = driverLocation || getDriverBaseLocation();
    const target = passengerPickup || currentPickup || currentDestination;
    if (!target) {
        showToast('لا يوجد هدف للملاحة');
        return;
    }

    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${target.lat},${target.lng}`;
    const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originStr)}&destination=${encodeURIComponent(destStr)}&travelmode=driving`;
    window.open(url, '_blank');
};

window.driverCallPassenger = function() {
    const phone = passengerPickup?.phone || '01000000000';
    showToast('جاري الاتصال بالراكب');
    window.location.href = `tel:${phone}`;
};

window.driverEndTrip = function() {
    document.getElementById('driver-active-trip').classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    clearDriverPassengerRoute();
    showToast('تم إنهاء الرحلة بنجاح! +25 ر.س');
    triggerConfetti();

    if (activeDriverTripId) {
        ApiService.trips.updateStatus(activeDriverTripId, 'completed').catch(err => {
            console.error('Failed to update trip status:', err);
        });
    }
    activeDriverTripId = null;
    currentIncomingTrip = null;
    triggerDriverRequestPolling();
};

window.logoutUser = function() {
    stopDriverRequestPolling();
    DB.clearSession();
    window.location.reload();
};

// --- Helper Functions ---

// --- Trip estimation helpers ---
function haversineKm(a, b) {
    const R = 6371; // km
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const c = 2 * Math.asin(Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng));
    return Math.max(0, R * c);
}

function computeTripEstimates() {
    if (!currentPickup || !currentDestination) return { distanceKm: 0, etaMin: 0 };
    const distanceKm = Math.round(haversineKm(currentPickup, currentDestination) * 10) / 10;
    const avgSpeedKmh = 25; // slower for realistic 10-15 min ETA
    const etaMin = Math.max(10, Math.min(15, Math.round((distanceKm / avgSpeedKmh) * 60)));
    return { distanceKm, etaMin };
}

function computePrice(type, distanceKm) {
    const base = { economy: 10, family: 15, luxury: 25, delivery: 8 };
    const perKm = { economy: 4, family: 6, luxury: 9, delivery: 3 };
    const b = base[type] || 10;
    const p = perKm[type] || 4;
    return Math.round((b + p * distanceKm) * 10) / 10; // 0.1 SAR precision
}

function updateTripEstimatesUI() {
    const { distanceKm, etaMin } = computeTripEstimates();
    const dEl = document.getElementById('ride-distance-badge');
    const tEl = document.getElementById('ride-time-badge');
    if (dEl) dEl.innerText = `${distanceKm} كم`;
    if (tEl) tEl.innerText = `~${etaMin} دقيقة`;
}

window.requestRide = async function() {
    if (!currentPickup || !currentDestination) { showToast('حدد الالتقاط والوجهة أولاً'); return; }
    if (!currentCarType) { showToast('اختر نوع السيارة'); return; }
    
    const scheduleCheck = document.getElementById('schedule-later-check');
    const scheduleDatetime = document.getElementById('schedule-datetime');
    let scheduledTime = null;
    
    if (scheduleCheck && scheduleCheck.checked) {
        if (!scheduleDatetime || !scheduleDatetime.value) {
            showToast('حدد موعد الرحلة المجدولة');
            return;
        }
        scheduledTime = new Date(scheduleDatetime.value);
        if (scheduledTime <= new Date()) {
            showToast('الموعد يجب أن يكون في المستقبل');
            return;
        }
    }
    
    const est = computeTripEstimates();
    currentTripPrice = computePrice(currentCarType, est.distanceKm);
    
    if (scheduledTime) {
        showToast(`تم جدولة الرحلة في ${scheduledTime.toLocaleString('ar-EG')}`);
        setTimeout(() => resetApp(), 2000);
        return;
    }
    
    try {
        const user = DB.getUser();
        const tripPayload = {
            user_id: user?.id || 1,
            pickup_location: currentPickup.label || 'نقطة الالتقاط',
            dropoff_location: currentDestination.label || 'الوجهة',
            pickup_lat: currentPickup.lat,
            pickup_lng: currentPickup.lng,
            dropoff_lat: currentDestination.lat,
            dropoff_lng: currentDestination.lng,
            car_type: currentCarType,
            cost: currentTripPrice,
            distance: est.distanceKm,
            duration: est.etaMin,
            payment_method: 'cash',
            status: 'pending'
        };

        await ApiService.trips.create(tripPayload);
    } catch (error) {
        console.error('Failed to create trip:', error);
        showToast('❌ تعذر إرسال الطلب، حاول مرة أخرى');
        return;
    }

    // Show loading (searching for driver)
    switchSection('loading');
    // After a short delay, show driver found
    setTimeout(() => {
        // Realistic ETA between 10-15 minutes
        const minETA = 10 * 60; // 10 minutes
        const maxETA = 15 * 60; // 15 minutes
        const calculatedETA = est.etaMin * 60;
        etaSeconds = Math.max(minETA, Math.min(maxETA, calculatedETA));
        
        // Update trip info in driver section
        const carTypeNames = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر', 'delivery': 'توصيل' };
        document.getElementById('trip-car-type') && (document.getElementById('trip-car-type').innerText = carTypeNames[currentCarType] || currentCarType);
        document.getElementById('trip-price-display') && (document.getElementById('trip-price-display').innerText = `${currentTripPrice} ر.س`);
        document.getElementById('eta-display') && (document.getElementById('eta-display').innerText = formatETA(etaSeconds));
        
        switchSection('driver');
        startDriverTrackingLive();
        startETACountdown();
        
        // Show helpful message
        showToast('✅ تم العثور على كابتن! شاهد السيارة على الخريطة', 4000);
    }, 500);
};

function loginSuccess() {
    window.closeAuthModal();
    DB.saveSession(); 
    showToast('تم تسجيل الدخول بنجاح');
    setTimeout(() => {
        initPassengerMode();
    }, 500);
}

function initPassengerMode() {
    currentUserRole = 'passenger';
    window.currentUserRole = 'passenger';
    document.body.classList.add('role-passenger');
    document.body.classList.remove('role-driver');
    document.getElementById('passenger-ui-container').classList.remove('hidden');
    document.getElementById('passenger-top-bar').classList.remove('hidden');
    const driverUi = document.getElementById('driver-ui-container');
    if (driverUi) driverUi.classList.add('hidden');
    const driverPanelToggle = document.getElementById('driver-panel-toggle');
    if (driverPanelToggle) driverPanelToggle.classList.add('hidden');
    const driverIncoming = document.getElementById('driver-incoming-request');
    if (driverIncoming) driverIncoming.classList.add('hidden');
    const driverWaiting = document.getElementById('driver-status-waiting');
    if (driverWaiting) driverWaiting.classList.add('hidden');
    const driverActive = document.getElementById('driver-active-trip');
    if (driverActive) driverActive.classList.add('hidden');
    if (driverRequestTimeout) {
        clearTimeout(driverRequestTimeout);
        driverRequestTimeout = null;
    }
    stopDriverRequestPolling();
    currentIncomingTrip = null;
    activeDriverTripId = null;
    const driverTopBar = document.getElementById('driver-top-bar');
    if (driverTopBar) driverTopBar.classList.add('hidden');
    const driverMenu = document.getElementById('driver-side-menu');
    const driverOverlay = document.getElementById('driver-menu-overlay');
    if (driverMenu) driverMenu.classList.remove('sidebar-open');
    if (driverOverlay) driverOverlay.classList.remove('overlay-open');
    const world = document.getElementById('map-world');
    if (world) world.classList.add('hidden');
    initLeafletMap();
    updateUIWithUserData();
    
    // Load saved places
    savedPlaces.load();
    
    // Schedule later toggle handler
    const scheduleCheck = document.getElementById('schedule-later-check');
    const schedulePicker = document.getElementById('schedule-time-picker');
    if (scheduleCheck && schedulePicker) {
        scheduleCheck.addEventListener('change', () => {
            if (scheduleCheck.checked) {
                schedulePicker.classList.remove('hidden');
                // Set min time to current + 15 min
                const minTime = new Date(Date.now() + 15 * 60 * 1000);
                const dateInput = document.getElementById('schedule-datetime');
                if (dateInput) {
                    dateInput.min = minTime.toISOString().slice(0, 16);
                }
            } else {
                schedulePicker.classList.add('hidden');
            }
        });
    }
}

window.switchToPassengerMode = function() {
    const roleModal = document.getElementById('role-selection-modal');
    if (roleModal) {
        roleModal.classList.add('hidden', 'opacity-0', 'pointer-events-none');
    }
    initPassengerMode();
    showToast('تم التحويل لوضع الراكب');
};

function initDriverMode() {
    currentUserRole = 'driver';
    window.currentUserRole = 'driver';
    document.body.classList.add('role-driver');
    document.body.classList.remove('role-passenger');
    document.getElementById('driver-ui-container').classList.remove('hidden');
    setDriverPanelVisible(true);
    currentIncomingTrip = null;
    activeDriverTripId = null;
    const passengerUi = document.getElementById('passenger-ui-container');
    if (passengerUi) passengerUi.classList.add('hidden');
    const passengerTopBar = document.getElementById('passenger-top-bar');
    if (passengerTopBar) passengerTopBar.classList.add('hidden');
    const passengerMenu = document.getElementById('side-menu');
    const passengerOverlay = document.getElementById('menu-overlay');
    if (passengerMenu) passengerMenu.classList.remove('sidebar-open');
    if (passengerOverlay) passengerOverlay.classList.remove('overlay-open');
    const driverTopBar = document.getElementById('driver-top-bar');
    if (driverTopBar) driverTopBar.classList.remove('hidden');
    const um = document.getElementById('user-marker');
    if(um) um.classList.remove('hidden');
    const world = document.getElementById('map-world');
    if (world) world.classList.add('hidden');
    initLeafletMap();
    moveLeafletMapToContainer('map-container');
    showDriverWaitingState();
    updateDriverMenuData();
    resolveDriverProfile().then(() => {
        showDriverWaitingState();
        startDriverRequestPolling();
        setTimeout(() => {
            forceDriverIncomingRequest();
        }, 600);
    });
}

function initAdminMode() {
    document.getElementById('admin-ui-container').classList.remove('hidden');
    renderAdminTrips();
    loadAdminDashboardStats();
}

// Load admin dashboard statistics from database
async function loadAdminDashboardStats() {
    try {
        const response = await ApiService.admin.getDashboardStats();
        if (response?.success && response?.data) {
            const { today_trips, active_drivers, total_passengers, total_earnings, avg_rating } = response.data;
            
            // Update today's trips
            const todayTripsEl = document.getElementById('admin-today-trips');
            if (todayTripsEl) {
                todayTripsEl.textContent = today_trips.toLocaleString('ar-EG');
            }
            
            // Update active drivers
            const activeDriversEl = document.getElementById('admin-active-drivers');
            if (activeDriversEl) {
                activeDriversEl.textContent = active_drivers.toLocaleString('ar-EG');
            }
            
            // Update total passengers
            const passengersEl = document.getElementById('admin-total-passengers');
            if (passengersEl) {
                passengersEl.textContent = total_passengers.toLocaleString('ar-EG');
            }
            
            // Update total earnings
            const earningsEl = document.getElementById('admin-total-earnings');
            if (earningsEl) {
                earningsEl.innerHTML = `${parseFloat(total_earnings).toLocaleString('ar-EG')} <span class="text-sm text-gray-400">ر.س</span>`;
            }
            
            // Update average rating
            const ratingEl = document.getElementById('admin-avg-rating');
            if (ratingEl) {
                ratingEl.textContent = avg_rating;
            }
            
            console.log('✅ Admin dashboard stats loaded from database');
        }
    } catch (error) {
        console.error('Failed to load admin dashboard stats:', error);
        // Keep default values (0) if API fails
    }
}

function getGuestDriverIdentity() {
    const key = 'akwadra_guest_driver_identity';
    try {
        const cached = SafeStorage.getItem(key);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed?.email || parsed?.phone) return parsed;
        }
    } catch (error) {
        console.warn('Failed to read guest driver identity:', error);
    }

    const stamp = Date.now().toString().slice(-8);
    const phone = `05${stamp}`;
    const email = `guest_driver_${Date.now()}@ubar.sa`;
    const identity = { phone, email };
    SafeStorage.setItem(key, JSON.stringify(identity));
    return identity;
}

async function resolveDriverProfile() {
    try {
        const user = DB.getUser();
        let email = user?.email;
        let phone = user?.phone;

        if (!email && !phone) {
            const guest = getGuestDriverIdentity();
            email = guest.email;
            phone = guest.phone;
        }

        if (!email && !phone) return null;

        const response = await ApiService.drivers.resolve(email, phone, true);
        if (response?.success) {
            currentDriverProfile = response.data;
            return currentDriverProfile;
        }
    } catch (error) {
        console.error('Failed to resolve driver profile:', error);
        showToast('تعذر تحميل بيانات الكابتن');
    }
    return null;
}

async function createDriverDemoTrip() {
    const now = Date.now();
    if (now - driverDemoRequestAt < 15000) return null;
    driverDemoRequestAt = now;

    const demoTrips = [
        {
            pickup: 'شارع طلعت حرب، القاهرة',
            dropoff: 'ميدان التحرير، القاهرة',
            pickup_lat: 30.0522,
            pickup_lng: 31.2437,
            dropoff_lat: 30.0444,
            dropoff_lng: 31.2357,
            cost: 38.5,
            distance: 6.4,
            duration: 14
        },
        {
            pickup: 'مدينة نصر، القاهرة',
            dropoff: 'العباسية، القاهرة',
            pickup_lat: 30.0561,
            pickup_lng: 31.3301,
            dropoff_lat: 30.0664,
            dropoff_lng: 31.2775,
            cost: 42.0,
            distance: 7.9,
            duration: 18
        },
        {
            pickup: 'المعادي، القاهرة',
            dropoff: 'كورنيش المعادي',
            pickup_lat: 29.9602,
            pickup_lng: 31.2569,
            dropoff_lat: 29.9506,
            dropoff_lng: 31.2623,
            cost: 26.0,
            distance: 4.1,
            duration: 10
        }
    ];

    const demo = demoTrips[Math.floor(Math.random() * demoTrips.length)];
    const user = DB.getUser();
    const payload = {
        user_id: user?.id || 1,
        pickup_location: demo.pickup,
        dropoff_location: demo.dropoff,
        pickup_lat: demo.pickup_lat,
        pickup_lng: demo.pickup_lng,
        dropoff_lat: demo.dropoff_lat,
        dropoff_lng: demo.dropoff_lng,
        car_type: currentDriverProfile?.car_type || 'economy',
        cost: demo.cost,
        distance: demo.distance,
        duration: demo.duration,
        payment_method: 'cash',
        status: 'pending'
    };

    try {
        const created = await ApiService.trips.create(payload);
        return created?.data || null;
    } catch (error) {
        console.error('Failed to create demo trip:', error);
        return null;
    }
}

function buildLocalDemoTrip() {
    const demoTrips = [
        {
            pickup_location: 'شارع طلعت حرب، القاهرة',
            dropoff_location: 'ميدان التحرير، القاهرة',
            pickup_lat: 30.0522,
            pickup_lng: 31.2437,
            dropoff_lat: 30.0444,
            dropoff_lng: 31.2357,
            cost: 38.5,
            distance: 6.4,
            duration: 14,
            passenger_name: 'راكب جديد',
            passenger_phone: '01000000000'
        },
        {
            pickup_location: 'مدينة نصر، القاهرة',
            dropoff_location: 'العباسية، القاهرة',
            pickup_lat: 30.0561,
            pickup_lng: 31.3301,
            dropoff_lat: 30.0664,
            dropoff_lng: 31.2775,
            cost: 42.0,
            distance: 7.9,
            duration: 18,
            passenger_name: 'راكب جديد',
            passenger_phone: '01000000000'
        },
        {
            pickup_location: 'المعادي، القاهرة',
            dropoff_location: 'كورنيش المعادي',
            pickup_lat: 29.9602,
            pickup_lng: 31.2569,
            dropoff_lat: 29.9506,
            dropoff_lng: 31.2623,
            cost: 26.0,
            distance: 4.1,
            duration: 10,
            passenger_name: 'راكب جديد',
            passenger_phone: '01000000000'
        }
    ];

    const demo = demoTrips[Math.floor(Math.random() * demoTrips.length)];
    return {
        id: `DEMO-${Date.now()}`,
        user_id: 1,
        driver_id: null,
        car_type: currentDriverProfile?.car_type || 'economy',
        status: 'pending',
        payment_method: 'cash',
        created_at: new Date().toISOString(),
        ...demo
    };
}

async function forceDriverIncomingRequest() {
    const now = Date.now();
    if (now - driverForceRequestAt < 5000) return;
    driverForceRequestAt = now;

    if (!currentDriverProfile) {
        await resolveDriverProfile();
    }

    try {
        await createDriverDemoTrip();
        const response = await ApiService.trips.getPendingNext(currentDriverProfile?.car_type, true);
        const trip = response?.data || null;
        if (trip) {
            currentIncomingTrip = trip;
            renderDriverIncomingTrip(trip);
            return;
        }
    } catch (error) {
        console.error('Force request failed:', error);
    }

    const localTrip = buildLocalDemoTrip();
    currentIncomingTrip = localTrip;
    renderDriverIncomingTrip(localTrip);
}

function startDriverRequestPolling() {
    stopDriverRequestPolling();
    triggerDriverRequestPolling();
    driverPollingInterval = setInterval(triggerDriverRequestPolling, 6000);
}

function stopDriverRequestPolling() {
    if (driverPollingInterval) {
        clearInterval(driverPollingInterval);
        driverPollingInterval = null;
    }
}

async function triggerDriverRequestPolling() {
    if (currentUserRole !== 'driver') return;
    if (!currentDriverProfile) {
        await resolveDriverProfile();
        if (!currentDriverProfile) return;
    }

    const incomingPanel = document.getElementById('driver-incoming-request');
    const activePanel = document.getElementById('driver-active-trip');
    if (activePanel && !activePanel.classList.contains('hidden')) return;
    if (incomingPanel && !incomingPanel.classList.contains('hidden')) return;

    try {
        let response = await ApiService.trips.getPendingNext(currentDriverProfile.car_type, true);
        let trip = response?.data || null;
        if (!trip) {
            await createDriverDemoTrip();
            response = await ApiService.trips.getPendingNext(currentDriverProfile.car_type, true);
            trip = response?.data || null;
        }

        if (!trip) {
            showDriverWaitingState();
            return;
        }

        currentIncomingTrip = trip;
        renderDriverIncomingTrip(trip);
    } catch (error) {
        console.error('Failed to fetch pending trips:', error);
        await createDriverDemoTrip();
        try {
            const retry = await ApiService.trips.getPendingNext(currentDriverProfile.car_type, true);
            const trip = retry?.data || null;
            if (trip) {
                currentIncomingTrip = trip;
                renderDriverIncomingTrip(trip);
                return;
            }
        } catch (retryError) {
            console.error('Retry pending trips failed:', retryError);
        }
        showDriverWaitingState();
    }
}

function showDriverWaitingState() {
    const waiting = document.getElementById('driver-status-waiting');
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.add('hidden');
    if (waiting) waiting.classList.remove('hidden');
    setDriverPanelVisible(true);
}

function renderDriverIncomingTrip(trip) {
    const waiting = document.getElementById('driver-status-waiting');
    if (waiting) waiting.classList.add('hidden');
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.remove('hidden');

    const pickupEl = document.getElementById('driver-request-pickup');
    const dropoffEl = document.getElementById('driver-request-dropoff');
    const priceEl = document.getElementById('driver-request-price');
    const distanceEl = document.getElementById('driver-request-distance');
    const passengerEl = document.getElementById('driver-request-passenger');
    const carTypeEl = document.getElementById('driver-request-car-type');
    const tripIdEl = document.getElementById('driver-request-trip-id');

    if (tripIdEl) tripIdEl.innerText = trip.id || '-';
    if (pickupEl) pickupEl.innerText = trip.pickup_location || 'موقع الراكب';
    if (dropoffEl) dropoffEl.innerText = trip.dropoff_location || 'الوجهة';
    if (priceEl) priceEl.innerText = trip.cost || '0';
    if (distanceEl) distanceEl.innerText = trip.distance || '-';
    if (passengerEl) passengerEl.innerText = trip.passenger_name || 'راكب جديد';
    if (carTypeEl) carTypeEl.innerText = trip.car_type || 'اقتصادي';

    if (trip.pickup_lat !== undefined && trip.pickup_lat !== null && trip.pickup_lng !== undefined && trip.pickup_lng !== null) {
        setPassengerPickup({
            lat: Number(trip.pickup_lat),
            lng: Number(trip.pickup_lng),
            phone: trip.passenger_phone
        }, trip.pickup_location);
        passengerPickup.phone = trip.passenger_phone;
    }
    setDriverPanelVisible(true);
}

async function renderAdminTrips() {
    const table = document.getElementById('admin-trips-table');
    if (!table) return;
    table.innerHTML = '<tr><td class="px-6 py-6 text-gray-500" colspan="5">جاري تحميل الرحلات...</td></tr>';

    const user = DB.getUser();
    await DB.fetchTrips({ role: user?.role || 'admin' });
    const trips = DB.getTrips();

    table.innerHTML = '';
    if (!trips.length) {
        table.innerHTML = '<tr><td class="px-6 py-6 text-gray-500" colspan="5">لا توجد رحلات</td></tr>';
        return;
    }
    
    trips.forEach(trip => {
        const html = `
        <tr class="hover:bg-indigo-50/30 transition-colors">
            <td class="px-6 py-4 font-bold">${trip.id}</td>
            <td class="px-6 py-4">${trip.driver || 'غير محدد'}</td>
            <td class="px-6 py-4">${trip.passenger || 'غير محدد'}</td>
            <td class="px-6 py-4 font-bold text-indigo-600">${trip.cost} ر.س</td>
            <td class="px-6 py-4">
                <span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs font-bold">${trip.status}</span>
            </td>
        </tr>`;
        table.insertAdjacentHTML('beforeend', html);
    });
}

// Render trip history (for profile and full history pages)
async function renderTripHistory(containerId = 'trip-history-container', limit = 3) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<p class="text-gray-500 text-center py-8">جاري تحميل الرحلات...</p>';

    const user = DB.getUser();
    if (!user) {
        container.innerHTML = '<p class="text-gray-500 text-center py-8">يرجى تسجيل الدخول لعرض الرحلات</p>';
        return;
    }

    await DB.fetchTrips({ userId: user.id, role: user.role });
    const trips = DB.getTrips();
    const displayTrips = limit ? trips.slice(0, limit) : trips;

    container.innerHTML = '';
    
    if (displayTrips.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-8">لا توجد رحلات</p>';
        return;
    }
    
    displayTrips.forEach(trip => {
        const tripDate = new Date(trip.date);
        const day = tripDate.getDate();
        const monthNames = ['يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
        const month = monthNames[tripDate.getMonth()];
        const year = tripDate.getFullYear();
        const hours = tripDate.getHours().toString().padStart(2, '0');
        const minutes = tripDate.getMinutes().toString().padStart(2, '0');
        const formattedDate = `${day} ${month} ${year}`;
        const formattedTime = `${hours}:${minutes}`;
        
        const statusClasses = trip.status === 'completed' 
            ? 'bg-green-100 text-green-700' 
            : 'bg-red-100 text-red-700';
        const statusText = trip.status === 'completed' ? 'مكتملة' : 'ملغية';
        
        const stars = '⭐'.repeat(trip.rating || 0);
        
        const html = `
        <div class="bg-white border-2 border-gray-200 rounded-2xl p-4 hover:shadow-lg transition-all cursor-pointer" onclick="showTripDetails('${trip.id}')">
            <div class="flex justify-between items-start mb-3">
                <div>
                    <p class="text-xs text-gray-500 font-bold">${formattedDate} • ${formattedTime}</p>
                    <p class="font-bold text-gray-800">${trip.id}</p>
                </div>
                <span class="${statusClasses} px-3 py-1 rounded-full text-xs font-bold">
                    ${statusText}
                </span>
            </div>
            
            <div class="flex items-start gap-3 mb-2">
                <div class="flex flex-col items-center">
                    <div class="w-2 h-2 rounded-full bg-indigo-600"></div>
                    <div class="w-0.5 h-6 bg-gray-300"></div>
                    <div class="w-2 h-2 rounded-full bg-red-500"></div>
                </div>
                <div class="flex-1">
                    <p class="text-sm text-gray-600">${trip.pickup}</p>
                    <p class="text-sm text-gray-600 mt-3">${trip.dropoff}</p>
                </div>
            </div>
            
            <div class="flex justify-between items-center mt-3 pt-3 border-t border-gray-200">
                <div class="flex items-center gap-2">
                    <i class="fas fa-user-circle text-gray-400"></i>
                    <span class="text-sm font-bold text-gray-700">${trip.driver}</span>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs text-yellow-500">${stars}</span>
                    <span class="text-lg font-extrabold text-indigo-600">${trip.cost} ر.س</span>
                </div>
            </div>
        </div>`;
        
        container.insertAdjacentHTML('beforeend', html);
    });
}

// Show all trips with statistics
window.renderAllTrips = async function() {
    const container = document.getElementById('all-trips-container');
    const emptyState = document.getElementById('empty-trips-state');

    if (container) {
        container.classList.remove('hidden');
        container.innerHTML = '<p class="text-gray-500 text-center py-8">جاري تحميل الرحلات...</p>';
    }
    if (emptyState) emptyState.classList.add('hidden');

    const user = DB.getUser();
    if (!user) {
        if (container) {
            container.innerHTML = '<p class="text-gray-500 text-center py-8">يرجى تسجيل الدخول لعرض الرحلات</p>';
        }
        return;
    }

    await DB.fetchTrips({ userId: user.id, role: user.role });
    const trips = DB.getTrips();

    if (!trips.length) {
        if (container) container.classList.add('hidden');
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }

    if (container) container.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    loadAllTrips();
};

// Render offers
window.renderOffers = function() {
    const container = document.getElementById('offers-container');
    const emptyState = document.getElementById('empty-offers-state');
    if (!container || !emptyState) return;

    const offers = [
        {
            title: '🎉 خصم 20% على أول رحلة',
            description: 'استخدم الكود WELCOME20 على أول طلب لك واحصل على خصم فوري.',
            badge: 'جديد',
            code: 'WELCOME20'
        },
        {
            title: '🚗 رحلتان بسعر 1',
            description: 'رحلتك الثانية مجاناً عند الدفع بالبطاقة خلال هذا الأسبوع.',
            badge: 'محدود',
            code: '2FOR1'
        },
        {
            title: '⭐ نقاط مضاعفة',
            description: 'اكسب ضعف النقاط على الرحلات المكتملة في عطلة نهاية الأسبوع.',
            badge: 'نقاط',
            code: 'DOUBLEPTS'
        }
    ];

    container.innerHTML = '';
    if (!offers.length) {
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    offers.forEach(offer => {
        const html = `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm cursor-pointer hover:shadow-md transition" onclick="window.applyOffer('${offer.code}')">
            <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-gray-800">${offer.title}</h3>
                <span class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-bold">${offer.badge}</span>
            </div>
            <p class="text-sm text-gray-600">${offer.description}</p>
            <div class="mt-3 flex justify-end">
                <button type="button" class="text-xs font-bold text-indigo-600 hover:text-indigo-700" onclick="event.stopPropagation(); window.applyOffer('${offer.code}')">استخدام العرض</button>
            </div>
        </div>`;
        container.insertAdjacentHTML('beforeend', html);
    });
};

window.applyOffer = function(code) {
    if (!code) {
        showToast('⚠️ هذا العرض غير متاح حالياً');
        return;
    }
    SafeStorage.setItem('akwadra_active_offer', code);
    showToast(`✅ تم اختيار العرض: ${code}`);
};

// Filter trips
window.filterTrips = function(filter) {
    const trips = DB.getTrips();
    const container = document.getElementById('all-trips-container');
    
    // Update filter buttons
    document.querySelectorAll('.trip-filter-btn').forEach(btn => {
        if (btn.dataset.filter === filter) {
            btn.classList.remove('bg-gray-100', 'text-gray-600');
            btn.classList.add('bg-indigo-600', 'text-white', 'active');
        } else {
            btn.classList.remove('bg-indigo-600', 'text-white', 'active');
            btn.classList.add('bg-gray-100', 'text-gray-600');
        }
    });
    
    // Filter trips
    const filteredTrips = filter === 'all' 
        ? trips 
        : trips.filter(t => t.status === filter);
    
    // Re-render
    container.innerHTML = '';
    filteredTrips.forEach(trip => {
        const tripDate = new Date(trip.date);
        const day = tripDate.getDate();
        const monthNames = ['يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
        const month = monthNames[tripDate.getMonth()];
        const hours = tripDate.getHours().toString().padStart(2, '0');
        const minutes = tripDate.getMinutes().toString().padStart(2, '0');
        const formattedDate = `${day} ${month} ${hours}:${minutes}`;
        
        const statusClasses = trip.status === 'completed' 
            ? 'bg-green-100 text-green-700' 
            : 'bg-red-100 text-red-700';
        const statusText = trip.status === 'completed' ? 'مكتملة' : 'ملغية';
        const stars = '⭐'.repeat(trip.rating || 0);
        
        const html = `
        <div class="bg-white border-2 border-gray-200 rounded-2xl p-4 hover:shadow-lg transition-all cursor-pointer" onclick="showTripDetails('${trip.id}')">
            <div class="flex justify-between items-start mb-3">
                <div>
                    <p class="text-xs text-gray-500 font-bold">${formattedDate}</p>
                    <p class="font-bold text-gray-800">${trip.id}</p>
                </div>
                <span class="${statusClasses} px-3 py-1 rounded-full text-xs font-bold">${statusText}</span>
            </div>
            <div class="flex items-start gap-3 mb-2">
                <div class="flex flex-col items-center">
                    <div class="w-2 h-2 rounded-full bg-indigo-600"></div>
                    <div class="w-0.5 h-6 bg-gray-300"></div>
                    <div class="w-2 h-2 rounded-full bg-red-500"></div>
                </div>
                <div class="flex-1">
                    <p class="text-sm text-gray-600">${trip.pickup}</p>
                    <p class="text-sm text-gray-600 mt-3">${trip.dropoff}</p>
                </div>
            </div>
            <div class="flex justify-between items-center mt-3 pt-3 border-t border-gray-200">
                <div class="flex items-center gap-2">
                    <i class="fas fa-user-circle text-gray-400"></i>
                    <span class="text-sm font-bold text-gray-700">${trip.driver}</span>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs text-yellow-500">${stars}</span>
                    <span class="text-lg font-extrabold text-indigo-600">${trip.cost} ر.س</span>
                </div>
            </div>
        </div>`;
        
        container.insertAdjacentHTML('beforeend', html);
    });
};

// Show trip details
window.showTripDetails = function(tripId) {
    const trips = DB.getTrips();
    const trip = trips.find(t => t.id === tripId);
    
    if (!trip) return;
    
    // Fill in details
    const tripDate = new Date(trip.date);
    const day = tripDate.getDate();
    const monthNames = ['يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const month = monthNames[tripDate.getMonth()];
    const year = tripDate.getFullYear();
    const hours = tripDate.getHours().toString().padStart(2, '0');
    const minutes = tripDate.getMinutes().toString().padStart(2, '0');
    const formattedDate = `${day} ${month} ${year} - ${hours}:${minutes}`;
    
    document.getElementById('trip-detail-id').innerText = trip.id;
    document.getElementById('trip-detail-date').innerText = formattedDate;
    document.getElementById('trip-detail-pickup').innerText = trip.pickup;
    document.getElementById('trip-detail-dropoff').innerText = trip.dropoff;
    document.getElementById('trip-detail-driver-name').innerText = trip.driver;
    document.getElementById('trip-detail-cost').innerText = `${trip.cost} ر.س`;
    
    const carTypes = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر', 'delivery': 'توصيل' };
    document.getElementById('trip-detail-car-info').innerText = `تويوتا كامري • ${carTypes[trip.car] || trip.car}`;
    
    const paymentMethods = { 'wallet': 'محفظة إلكترونية', 'cash': 'نقداً', 'card': 'بطاقة ائتمان' };
    document.getElementById('trip-detail-payment-method').innerText = paymentMethods[trip.paymentMethod] || trip.paymentMethod;
    
    // Status badge
    const statusBadge = document.getElementById('trip-detail-status');
    if (trip.status === 'completed') {
        statusBadge.className = 'inline-block px-4 py-2 rounded-full bg-green-100 text-green-700 font-bold text-sm';
        statusBadge.innerHTML = '<i class="fas fa-check-circle ml-1"></i> مكتملة';
    } else {
        statusBadge.className = 'inline-block px-4 py-2 rounded-full bg-red-100 text-red-700 font-bold text-sm';
        statusBadge.innerHTML = '<i class="fas fa-times-circle ml-1"></i> ملغية';
    }
    
    // Rating stars
    const ratingContainer = document.getElementById('trip-detail-user-rating');
    ratingContainer.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const starClass = i <= (trip.rating || 0) ? 'fas fa-star text-yellow-400' : 'fas fa-star text-gray-300';
        ratingContainer.innerHTML += `<i class="${starClass} text-lg"></i>`;
    }
    
    // Switch to details view
    switchSection('trip-details');
};

function simulateDriverResponse(userText) {
    const chatMessages = document.getElementById('chat-messages');
    const typingId = 'typing-' + Date.now();
    const typingHtml = `
    <div id="${typingId}" class="flex items-start msg-enter">
        <div class="bg-white border border-gray-100 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm flex items-center gap-1">
            <div class="w-2 h-2 bg-gray-400 rounded-full typing-dot"></div>
            <div class="w-2 h-2 bg-gray-400 rounded-full typing-dot"></div>
            <div class="w-2 h-2 bg-gray-400 rounded-full typing-dot"></div>
        </div>
    </div>`;
    
    setTimeout(() => {
        chatMessages.insertAdjacentHTML('beforeend', typingHtml);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 600);

    let responseText = "حسناً، فهمت!";
    if (userText.includes("وينك") || userText.includes("متى")) responseText = "أنا قريب جداً، الطريق مزدحم قليلاً.";
    else if (userText.includes("بسرعة") || userText.includes("مستعجل")) responseText = "سأبذل قصارى جهدي للوصول سريعاً!";
    else if (userText.includes("شكرا")) responseText = "على الرحب والسعة يا غالي! 🌹";
    else if (userText.includes("انتظرني")) responseText = "لا تقلق، أنا بانتظارك.";

    setTimeout(() => {
        const typingEl = document.getElementById(typingId);
        if(typingEl) typingEl.remove();

        const respHtml = `
        <div class="flex items-start msg-enter">
             <div class="bg-white border border-gray-100 rounded-2xl rounded-tr-none px-4 py-2.5 shadow-sm text-sm text-gray-700 max-w-[85%]">
                 ${responseText}
                 <div class="text-[10px] text-gray-400 mt-1 text-left">الآن</div>
             </div>
        </div>`;
        chatMessages.insertAdjacentHTML('beforeend', respHtml);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 2500);
}

function showToast(message, duration = 3000) {
    const toastNotification = document.getElementById('toast-notification');
    const toastMessage = document.getElementById('toast-message');
    if(toastNotification && toastMessage) {
        toastMessage.innerText = message;
        toastNotification.style.transform = 'translate(-50%, 120px)';
        toastNotification.style.opacity = '1';
        setTimeout(() => {
            toastNotification.style.transform = 'translate(-50%, 0)';
            toastNotification.style.opacity = '0';
        }, duration);
    }
}

window.toggleFieldVisibility = function(inputId, buttonEl) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const currentType = input.getAttribute('type') || 'text';
    if (!input.dataset.originalType) {
        input.dataset.originalType = currentType;
    }

    const originalType = input.dataset.originalType || 'text';
    const showType = originalType === 'password' ? 'text' : originalType;
    const hideType = 'password';
    const isVisible = input.dataset.visible === 'true';
    const nextType = isVisible ? hideType : showType;
    input.setAttribute('type', nextType);
    input.dataset.visible = String(!isVisible);

    if (buttonEl) {
        const icon = buttonEl.querySelector('i');
        if (icon) {
            const nowVisible = !isVisible;
            const isHidden = !nowVisible;
            icon.classList.toggle('fa-eye', isHidden);
            icon.classList.toggle('fa-eye-slash', !isHidden);
        }
        const nowVisible = !isVisible;
        buttonEl.setAttribute('aria-label', nowVisible ? 'إخفاء' : 'إظهار');
        buttonEl.setAttribute('title', nowVisible ? 'إخفاء' : 'إظهار');
    }
};

function updateUIWithUserData() {
    const user = DB.getUser();
    if (!user) return;

    ['sidebar-name', 'profile-name'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.innerText = id.includes('sidebar') ? `أهلاً، ${user.name.split(' ')[0]}` : user.name;
    });
    ['sidebar-rating', 'profile-rating'].forEach(id => { const el = document.getElementById(id); if(el) el.innerText = user.rating; });
    ['sidebar-balance', 'profile-balance'].forEach(id => { const el = document.getElementById(id); if(el) el.innerText = id.includes('sidebar') ? `${user.balance} ر.س` : user.balance; });
    ['sidebar-avatar', 'nav-avatar', 'profile-avatar'].forEach(id => { const el = document.getElementById(id); if(el) el.src = user.avatar; });
    
    const pp = document.getElementById('profile-points');
    if(pp) pp.innerText = user.points;
}

function updateDriverMenuData() {
    const user = DB.getUser() || {
        name: 'الكابتن',
        rating: '4.8',
        balance: 0,
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=AhmedDriver'
    };

    const trips = DB.getTrips() || [];
    const todayKey = new Date().toDateString();
    const todayTrips = trips.filter(trip => {
        if (!trip.date) return false;
        return new Date(trip.date).toDateString() === todayKey;
    });
    const completedTrips = trips.filter(trip => String(trip.status).toLowerCase() === 'completed' || trip.status === 'مكتملة');
    const earnings = completedTrips.reduce((sum, trip) => sum + Number(trip.cost || 0), 0);

    const driverName = user.name && user.name.trim() ? user.name : 'الكابتن';
    const firstName = driverName.split(' ')[0];
    const carTypeNames = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
    const driverCarType = currentDriverProfile?.car_type || user.car_type || 'economy';
    const driverCarLabel = carTypeNames[driverCarType] || driverCarType;

    const nameEl = document.getElementById('driver-sidebar-name');
    if (nameEl) nameEl.innerText = `أهلاً، ${firstName}`;

    const ratingEl = document.getElementById('driver-sidebar-rating');
    if (ratingEl) ratingEl.innerText = user.rating || '4.8';

    const balanceEl = document.getElementById('driver-stats-balance');
    if (balanceEl) balanceEl.innerText = `${user.balance || 0} ر.س`;

    const earningsEl = document.getElementById('driver-stats-earnings');
    if (earningsEl) earningsEl.innerText = `${earnings} ر.س`;

    const totalEl = document.getElementById('driver-stats-total');
    if (totalEl) totalEl.innerText = trips.length;

    const todayEl = document.getElementById('driver-stats-today');
    if (todayEl) todayEl.innerText = todayTrips.length;

    const homeNameEl = document.getElementById('driver-home-name');
    if (homeNameEl) homeNameEl.innerText = `أهلاً، ${firstName}`;
    const homeRatingEl = document.getElementById('driver-home-rating');
    if (homeRatingEl) homeRatingEl.innerText = user.rating || '4.8';
    const homeTodayEl = document.getElementById('driver-home-today');
    if (homeTodayEl) homeTodayEl.innerText = todayTrips.length;
    const homeTotalEl = document.getElementById('driver-home-total');
    if (homeTotalEl) homeTotalEl.innerText = trips.length;
    const homeEarningsEl = document.getElementById('driver-home-earnings');
    if (homeEarningsEl) homeEarningsEl.innerText = `${earnings} ر.س`;
    const homeCarTypeEl = document.getElementById('driver-home-car-type');
    if (homeCarTypeEl) homeCarTypeEl.innerText = driverCarLabel;

    const avatarIds = ['driver-sidebar-avatar', 'driver-nav-avatar'];
    avatarIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.src = user.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=AhmedDriver';
    });
}

function renderTripHistory() {
    const container = document.getElementById('trip-history-container');
    if (!container) return;
    const trips = DB.getTrips();
    container.innerHTML = '';

    if (trips.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-400 py-4">لا توجد رحلات سابقة</div>';
        return;
    }

    trips.forEach(trip => {
        const date = new Date(trip.date);
        const formattedDate = date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
        const formattedTime = date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        const html = `
        <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-indigo-100 transition-all cursor-pointer group">
             <div class="flex items-center">
                 <div class="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-all">
                     <i class="fas fa-car"></i>
                 </div>
                 <div class="mr-4">
                     <h4 class="font-bold text-gray-800">من ${trip.pickup} إلى ${trip.dropoff}</h4>
                     <p class="text-xs text-gray-400 mt-1 font-medium">${formattedDate} • ${formattedTime}</p>
                 </div>
             </div>
             <div class="text-left">
                 <div class="font-bold text-gray-800">${trip.cost} ر.س</div>
                 <span class="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-bold">مكتملة</span>
             </div>
        </div>`;
        container.insertAdjacentHTML('beforeend', html);
    });
}

function centerMap() {
    mapState.x = -1500 + (window.innerWidth / 2);
    mapState.y = -1500 + (window.innerHeight / 2);
    mapState.scale = 1;
    updateMapTransform();
}

function updateMapTransform() {
    const mapWorld = document.getElementById('map-world');
    if (mapWorld) mapWorld.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
}

function toggleMenu() {
    const sideMenu = document.getElementById('side-menu');
    const menuOverlay = document.getElementById('menu-overlay');
    if (!sideMenu || !menuOverlay) return;
    
    const isOpen = sideMenu.classList.contains('sidebar-open');
    if (isOpen) {
        sideMenu.classList.remove('sidebar-open');
        menuOverlay.classList.remove('overlay-open');
    } else {
        sideMenu.classList.add('sidebar-open');
        menuOverlay.classList.add('overlay-open');
        updateUIWithUserData();
    }
}

function toggleDriverMenu() {
    const sideMenu = document.getElementById('driver-side-menu');
    const menuOverlay = document.getElementById('driver-menu-overlay');
    if (!sideMenu || !menuOverlay) return;

    const isOpen = sideMenu.classList.contains('sidebar-open');
    if (isOpen) {
        sideMenu.classList.remove('sidebar-open');
        menuOverlay.classList.remove('overlay-open');
    } else {
        sideMenu.classList.add('sidebar-open');
        menuOverlay.classList.add('overlay-open');
        updateDriverMenuData();
    }
}

function toggleAdminMenu() {
    const sideMenu = document.getElementById('admin-side-menu');
    const menuOverlay = document.getElementById('admin-menu-overlay');
    if (!sideMenu || !menuOverlay) return;

    const isOpen = sideMenu.classList.contains('sidebar-open');
    if (isOpen) {
        sideMenu.classList.remove('sidebar-open');
        menuOverlay.classList.remove('overlay-open');
    } else {
        sideMenu.classList.add('sidebar-open');
        menuOverlay.classList.add('overlay-open');
    }
}

// --- Map Drag Logic (Enhanced for Mobile Touch) ---
function startDrag(e) {
    if (!isMapWorldActive()) return;
    if (e.target.closest('.pointer-events-auto')) return;
    const mapContainer = document.getElementById('map-container');
    
    // Prevent default touch behavior to avoid scrolling
    if (e.touches) {
        e.preventDefault();
    }
    
    mapState.isDragging = true;
    if(mapContainer) {
        mapContainer.classList.add('grabbing-cursor');
        mapContainer.classList.remove('grab-cursor');
    }
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    mapState.startX = clientX - mapState.x;
    mapState.startY = clientY - mapState.y;
    
    mapState.clickStartX = clientX;
    mapState.clickStartY = clientY;
    
    // Store the last position for momentum
    mapState.lastX = clientX;
    mapState.lastY = clientY;
}

function drag(e) {
    if (!isMapWorldActive()) return;
    if (!mapState.isDragging) return;
    
    // Prevent scrolling on mobile while dragging
    if (e.touches) {
        e.preventDefault();
    }
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    mapState.x = clientX - mapState.startX;
    mapState.y = clientY - mapState.startY;
    
    updateMapTransform();
    
    // Update last position for momentum
    mapState.lastX = clientX;
    mapState.lastY = clientY;
    
    const currentLocInput = document.getElementById('current-loc-input');
    if (currentUserRole === 'passenger' && Math.random() > 0.9 && currentLocInput) {
        currentLocInput.value = "جاري تحديد الموقع...";
    }
}

function endDrag(e) {
    if (!isMapWorldActive()) return;
    if (!mapState.isDragging) return;
    const mapContainer = document.getElementById('map-container');
    
    mapState.isDragging = false;
    if(mapContainer) {
        mapContainer.classList.remove('grabbing-cursor');
        mapContainer.classList.add('grab-cursor');
    }
    
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    
    const dist = Math.hypot(clientX - mapState.clickStartX, clientY - mapState.clickStartY);
    
    if (dist < 5) {
        handleMapClick(clientX, clientY);
    } else if (currentUserRole === 'passenger') {
        const currentLocInput = document.getElementById('current-loc-input');
        if(currentLocInput) currentLocInput.value = "شارع الملك عبدالله، حي النخيل";
    }
}

function handleMapClick(cx, cy) {
    // Only handle click for destination setting in Passenger Mode
    if (currentUserRole !== 'passenger') return;
    if (!isMapWorldActive()) return;

    const mapWorld = document.getElementById('map-world');
    const destMarker = document.getElementById('dest-marker');
    const destInput = document.getElementById('dest-input');
    
    const rect = mapWorld.getBoundingClientRect();
    const relX = (cx - rect.left) / mapState.scale;
    const relY = (cy - rect.top) / mapState.scale;
    
    if (destMarker) {
        destMarker.style.left = `${relX}px`;
        destMarker.style.top = `${relY}px`;
        destMarker.classList.remove('hidden');
    }
    
    if (destInput) destInput.value = "تم تحديد موقع على الخريطة";
    window.confirmDestination("Map Point");
}

// --- Driver Tracking Logic (Visuals) ---
function startDriverTracking() {
    const activeDriverMarker = document.getElementById('active-driver');
    const driverRouteLine = document.getElementById('driver-route-line');
    const etaDisplay = document.getElementById('eta-display');
    const driverLabelText = document.getElementById('driver-label-text');
    
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    
    const userMapX = (viewportCenterX - mapState.x) / mapState.scale;
    const userMapY = (viewportCenterY - mapState.y) / mapState.scale;
    
    let driverX = userMapX + 400;
    let driverY = userMapY - 300;
    
    activeDriverMarker.classList.remove('hidden');
    activeDriverMarker.style.left = `${driverX}px`;
    activeDriverMarker.style.top = `${driverY}px`;
    driverLabelText.innerText = 'أحمد قادم إليك';
    
    driverRouteLine.classList.remove('opacity-0');

    const startTime = Date.now();
    const duration = 8000;
    
    function animate() {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        const currentViewportCenterX = window.innerWidth / 2;
        const currentViewportCenterY = window.innerHeight / 2;
        const targetX = (currentViewportCenterX - mapState.x) / mapState.scale;
        const targetY = (currentViewportCenterY - mapState.y) / mapState.scale;

        const currentX = driverX + (targetX - driverX) * progress;
        const currentY = driverY + (targetY - driverY) * progress;
        
        const dx = targetX - currentX;
        const dy = targetY - currentY;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        activeDriverMarker.style.transform = `translate(-50%, -50%) rotate(${angle + 90}deg)`;
        activeDriverMarker.style.left = `${currentX}px`;
        activeDriverMarker.style.top = `${currentY}px`;
        
        const midX = (currentX + targetX) / 2;
        const midY = (currentY + targetY) / 2;
        driverRouteLine.setAttribute('d', `M${currentX},${currentY} Q${midX + 50},${midY - 50} ${targetX},${targetY}`);
        
        if (elapsed % 1000 < 20) {
             const remainingSec = Math.ceil((1 - progress) * 15);
             if (remainingSec > 60) etaDisplay.innerText = Math.ceil(remainingSec/60) + " دقائق";
             else etaDisplay.innerText = remainingSec + " ثانية";
        }

        if (progress < 1) {
            driverAnimationId = requestAnimationFrame(animate);
        } else {
            etaDisplay.innerText = "وصل";
            driverLabelText.innerText = 'وصل الكابتن';
            setTimeout(() => {
                startRide(currentX, currentY);
            }, 2000);
        }
    }
    
    driverAnimationId = requestAnimationFrame(animate);
}

function startRide(startX, startY) {
    window.switchSection('inRide');
    
    const rideDestText = document.getElementById('ride-dest-text');
    const destInput = document.getElementById('dest-input');
    const activeDriverMarker = document.getElementById('active-driver');
    const driverRouteLine = document.getElementById('driver-route-line');
    const rideEtaDisplay = document.getElementById('ride-eta-display');
    const driverLabelText = document.getElementById('driver-label-text');

    if(rideDestText && destInput) {
        rideDestText.innerText = destInput.value.includes("خريطة") ? "وجهة محددة" : (destInput.value || "فندق الريتز كارلتون");
    }

    let destX, destY;
    const destMarker = document.getElementById('dest-marker');
    if (destMarker && !destMarker.classList.contains('hidden')) {
        destX = parseFloat(destMarker.style.left);
        destY = parseFloat(destMarker.style.top);
    }
    if (!destX) {
        destX = startX - 800;
        destY = startY + 600;
    }

    const startTime = Date.now();
    const duration = 10000;
    
    driverLabelText.innerText = 'جاري الرحلة';

    function animateRide() {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);

        const currentX = startX + (destX - startX) * progress;
        const currentY = startY + (destY - startY) * progress;
        
        const dx = destX - currentX;
        const dy = destY - currentY;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        activeDriverMarker.style.transform = `translate(-50%, -50%) rotate(${angle + 90}deg)`;
        activeDriverMarker.style.left = `${currentX}px`;
        activeDriverMarker.style.top = `${currentY}px`;

        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
        mapState.x = viewportCenterX - (currentX * mapState.scale);
        mapState.y = viewportCenterY - (currentY * mapState.scale);
        updateMapTransform();
        
        driverRouteLine.setAttribute('d', `M${currentX},${currentY} L${destX},${destY}`);

        if (elapsed % 1000 < 20) {
             const remainingSec = Math.ceil((1 - progress) * 12);
             rideEtaDisplay.innerText = remainingSec + " دقيقة";
        }

        if (progress < 1) {
            driverAnimationId = requestAnimationFrame(animateRide);
        } else {
            setTimeout(() => {
                triggerConfetti();
                stopDriverTracking();
                // Start payment flow
                initPaymentFlow();
                window.switchSection('payment-method');
            }, 1000);
        }
    }
    
    driverAnimationId = requestAnimationFrame(animateRide);
}

function finishTrip() {
    const rideDestText = document.getElementById('ride-dest-text');
    const newTrip = {
        id: `TR-${Math.floor(Math.random() * 9000) + 1000}`,
        date: new Date().toISOString(),
        pickup: "حدد موقعك",
        dropoff: rideDestText ? rideDestText.innerText : "وجهة محددة",
        cost: currentTripPrice || 25,
        status: "completed",
        car: currentCarType || "economy",
        driver: "أحمد محمد",
        passenger: "المستخدم"
    };

    DB.addTrip(newTrip);

    const user = DB.getUser();
    if(user) {
        DB.updateUser({
            balance: user.balance - (currentTripPrice || 25),
            points: user.points + 25
        });
    }

    showToast('تم حفظ الرحلة وخصم المبلغ من المحفظة');
}

function stopDriverTracking() {
    if (driverAnimationId) cancelAnimationFrame(driverAnimationId);
    const activeDriverMarker = document.getElementById('active-driver');
    const driverRouteLine = document.getElementById('driver-route-line');
    if(activeDriverMarker) activeDriverMarker.classList.add('hidden');
    if(driverRouteLine) driverRouteLine.classList.add('opacity-0');
}

function triggerConfetti() {
    for(let i=0; i<50; i++) {
        const confetti = document.createElement('div');
        confetti.classList.add('confetti');
        confetti.style.left = Math.random() * 100 + 'vw';
        confetti.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
        confetti.style.animationDuration = (Math.random() * 2 + 2) + 's';
        document.body.appendChild(confetti);
        setTimeout(() => confetti.remove(), 4000);
    }
}

function animateAmbientCars() {
    const cars = ['car-1', 'car-2', 'car-3'];
    cars.forEach(id => {
        const car = document.getElementById(id);
        if(!car) return;
        setInterval(() => {
            const rx = Math.random() * 200 - 100;
            const ry = Math.random() * 200 - 100;
            car.style.transform = `translate(${rx}px, ${ry}px) scaleX(${Math.random() > 0.5 ? -1 : 1})`;
        }, 4000 + Math.random() * 2000);
    });
}

// --- Initialization & Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Ready');
    try {
        DB.init();
        centerMap();
        animateAmbientCars();
        
        const roleModal = document.getElementById('role-selection-modal');
        const params = new URLSearchParams(window.location.search);
        const requestedRole = (params.get('role') || params.get('mode') || '').toLowerCase();
        const allowedRoles = ['passenger', 'driver', 'admin'];
        const forcedRole = allowedRoles.includes(requestedRole) ? requestedRole : null;

        const hasSession = DB.hasSession();
        const user = hasSession ? DB.getUser() : null;
        const savedRole = user?.role || 'passenger';

        const shouldAutoInit = forcedRole || (hasSession && savedRole === 'passenger');

        if (shouldAutoInit) {
            if (roleModal) {
                roleModal.classList.add('hidden', 'opacity-0', 'pointer-events-none');
            }
            const role = forcedRole || savedRole;
            currentUserRole = role;
            if (role === 'driver') {
                initDriverMode();
            } else if (role === 'admin') {
                initAdminMode();
            } else {
                initPassengerMode();
            }
        } else if (roleModal) {
            roleModal.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
            document.body.classList.remove('role-driver', 'role-passenger');
        }

        // Open auth modal directly when URL hash requests it
        const hash = window.location.hash;
        if (hash === '#auth-admin' || hash === '#auth-driver') {
            if (roleModal) {
                roleModal.classList.add('hidden', 'opacity-0', 'pointer-events-none');
            }
            const targetRole = hash === '#auth-admin' ? 'admin' : 'driver';
            setTimeout(() => {
                if (typeof window.openRoleLoginModal === 'function') {
                    window.openRoleLoginModal(targetRole);
                }
            }, 100);
        } else if (hash === '#auth' || hash === '#auth-modal' || hash === '#auth-passenger') {
            if (roleModal) {
                roleModal.classList.add('hidden', 'opacity-0', 'pointer-events-none');
            }
            setTimeout(() => {
                if (typeof window.openAuthModal === 'function') {
                    window.openAuthModal();
                }
            }, 100);
        } else if (hash === '#auth-role') {
            if (roleModal) {
                roleModal.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
            }
        }

        // Bind role buttons even if inline onclick is blocked by CSP
        document.querySelectorAll('.role-card').forEach(btn => {
            const role = btn.dataset.role;
            if (!role) return;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof window.selectRole === 'function') {
                    window.selectRole(role);
                }
            });
        });

        // Bind driver accept/reject buttons even if inline onclick is blocked by CSP
        const driverAcceptBtn = document.getElementById('driver-accept-btn');
        if (driverAcceptBtn) {
            driverAcceptBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof window.driverAcceptRequest === 'function') {
                    window.driverAcceptRequest();
                }
            });
        }

        const driverRejectBtn = document.getElementById('driver-reject-btn');
        if (driverRejectBtn) {
            driverRejectBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof window.driverRejectRequest === 'function') {
                    window.driverRejectRequest();
                }
            });
        }
    } catch (e) {
        console.error('Initialization error:', e);
    }
    
    // Map Interactions
    const mapContainer = document.getElementById('map-container');
    if (mapContainer) {
        mapContainer.addEventListener('mousedown', startDrag);
        mapContainer.addEventListener('touchstart', startDrag, { passive: false });
    }
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', drag, { passive: false });
    
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // Zoom Controls
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const centerMapBtn = document.getElementById('center-map');

    if (zoomInBtn) zoomInBtn.addEventListener('click', () => {
        if (!isMapWorldActive() && leafletMap) {
            leafletMap.zoomIn();
            return;
        }
        mapState.scale = Math.min(mapState.scale + 0.2, 2.5);
        updateMapTransform();
    });

    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
        if (!isMapWorldActive() && leafletMap) {
            leafletMap.zoomOut();
            return;
        }
        mapState.scale = Math.max(mapState.scale - 0.2, 0.5);
        updateMapTransform();
    });

    if (centerMapBtn) centerMapBtn.addEventListener('click', () => {
        if (!isMapWorldActive() && leafletMap) {
            if (currentPickup) {
                leafletMap.setView([currentPickup.lat, currentPickup.lng], Math.max(leafletMap.getZoom(), 13));
            } else {
                leafletMap.setView([26.8206, 30.8025], 6);
            }
            return;
        }
        centerMap();
        if (currentUserRole === 'passenger') {
            const userMarker = document.getElementById('user-marker');
            const destMarker = document.getElementById('dest-marker');
            if(userMarker) userMarker.classList.remove('hidden');
            if(destMarker) destMarker.classList.add('hidden');
            window.resetApp();
        }
    });

    // UI Controls
    const menuBtn = document.getElementById('menu-btn');
    const closeMenuBtn = document.getElementById('close-menu-btn');
    const menuOverlay = document.getElementById('menu-overlay');
    
    if (menuBtn) menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    if (closeMenuBtn) closeMenuBtn.addEventListener('click', toggleMenu);
    if (menuOverlay) menuOverlay.addEventListener('click', toggleMenu);
    document.querySelectorAll('#side-menu a').forEach(link => link.addEventListener('click', toggleMenu));

    const driverMenuBtn = document.getElementById('driver-menu-btn');
    const driverCloseMenuBtn = document.getElementById('driver-close-menu-btn');
    const driverMenuOverlay = document.getElementById('driver-menu-overlay');

    if (driverMenuBtn) driverMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDriverMenu(); });
    if (driverCloseMenuBtn) driverCloseMenuBtn.addEventListener('click', toggleDriverMenu);
    if (driverMenuOverlay) driverMenuOverlay.addEventListener('click', toggleDriverMenu);
    document.querySelectorAll('#driver-side-menu a').forEach(link => link.addEventListener('click', toggleDriverMenu));

    const adminMenuBtn = document.getElementById('admin-menu-btn');
    const adminCloseMenuBtn = document.getElementById('admin-close-menu-btn');
    const adminMenuOverlay = document.getElementById('admin-menu-overlay');

    if (adminMenuBtn) adminMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleAdminMenu(); });
    if (adminCloseMenuBtn) adminCloseMenuBtn.addEventListener('click', toggleAdminMenu);
    if (adminMenuOverlay) adminMenuOverlay.addEventListener('click', toggleAdminMenu);
    document.querySelectorAll('#admin-side-menu a').forEach(link => link.addEventListener('click', toggleAdminMenu));

    const destInput = document.getElementById('dest-input');
    if (destInput) {
        destInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && destInput.value.trim() !== '') window.confirmDestination(destInput.value);
        });
        destInput.addEventListener('change', () => {
            if (destInput.value.trim() !== '') window.confirmDestination(destInput.value);
        });
    }

    // request button handled by inline onclick="requestRide()"; avoid double-binding here

    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.addEventListener('click', window.resetApp);

    const profileBtn = document.getElementById('profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', () => {
        window.switchSection('profile');
        if(backBtn) backBtn.classList.remove('hidden');
    });

    const driverProfileBtn = document.getElementById('driver-profile-btn');
    if (driverProfileBtn) driverProfileBtn.addEventListener('click', () => {
        if (window.openDriverProfile) window.openDriverProfile();
    });

    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
             if (e.key === 'Enter') window.sendChatMessage();
        });
    }
    
    const otpInputs = document.querySelectorAll('.otp-input');
    otpInputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            if (input.value.length === 1) {
                if (index < otpInputs.length - 1) {
                    otpInputs[index + 1].focus();
                }
            }
        });
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && input.value.length === 0) {
                if (index > 0) {
                    otpInputs[index - 1].focus();
                }
            }
        });
    });

    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const rating = parseInt(btn.dataset.rating);
            document.querySelectorAll('.star-btn').forEach(b => {
                if (parseInt(b.dataset.rating) <= rating) {
                    b.classList.add('text-yellow-400');
                    b.classList.remove('text-gray-300');
                } else {
                    b.classList.remove('text-yellow-400');
                    b.classList.add('text-gray-300');
                }
            });
        });
    });
});

// ========================================
// PAYMENT SYSTEM
// ========================================

let selectedPaymentMethod = null;
let tripDetails = {};
let appliedPromo = null;
let promoDiscount = 0;

window.selectPaymentMethod = function(method) {
    selectedPaymentMethod = method;
    const confirmBtn = document.getElementById('confirm-payment-btn');
    
    // Update UI
    document.querySelectorAll('.payment-method-btn').forEach(btn => {
        const radio = btn.querySelector('.w-5');
        if (btn.dataset.method === method) {
            radio.classList.add('bg-indigo-600', 'border-indigo-600');
            radio.classList.remove('border-gray-300');
        } else {
            radio.classList.remove('bg-indigo-600', 'border-indigo-600');
            radio.classList.add('border-gray-300');
        }
    });
    
    // Check wallet balance for wallet payment
    if (method === 'wallet') {
        const user = DB.getUser();
        if (user && user.balance < (currentTripPrice || 0)) {
            showToast('رصيدك غير كافي للدفع عبر المحفظة');
            selectedPaymentMethod = null;
            return;
        }
    }
    
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
};

window.applyPromoCode = function() {
    const promoInput = document.getElementById('promo-code-input');
    const promoResult = document.getElementById('promo-result');
    const code = promoInput.value.trim().toUpperCase();
    
    if (!code) {
        showToast('يرجى إدخال رمز خصم');
        return;
    }
    
    // Mock promo codes (in real app, validate from server)
    const validPromos = {
        'WELCOME20': 0.20,  // 20% off
        'SAVE50': 50,       // 50 SAR off
        'SUMMER15': 0.15,   // 15% off
        'FIRST10': 10       // 10 SAR off
    };
    
    if (validPromos[code]) {
        const discountValue = validPromos[code];
        if (discountValue < 1) {
            // Percentage discount
            promoDiscount = Math.floor(currentTripPrice * discountValue);
        } else {
            // Fixed discount
            promoDiscount = Math.min(discountValue, currentTripPrice);
        }
        
        appliedPromo = code;
        promoResult.classList.remove('hidden');
        promoResult.innerHTML = `✅ تم تطبيق الكود: ${code} - خصم ${promoDiscount} ر.س`;
        promoInput.disabled = true;
        
        // Update price display
        updatePaymentSummary();
        showToast('تم تطبيق الرمز بنجاح!');
    } else {
        promoResult.classList.remove('hidden');
        promoResult.innerHTML = '❌ الرمز غير صحيح أو منتهي الصلاحية';
        showToast('رمز خصم غير صحيح');
    }
};

window.updatePaymentSummary = function() {
    const distance = Math.floor(Math.random() * 8) + 2; // 2-10 km for demo
    const carType = currentCarType || 'economy';
    const carTypes = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
    
    tripDetails = {
        distance: distance,
        carType: carType,
        duration: Math.ceil(distance / 0.5), // rough estimate
        basePrice: currentTripPrice || 25
    };
    
    const finalPrice = tripDetails.basePrice - promoDiscount;
    
    // Update payment method selection screen
    document.getElementById('payment-amount').innerText = finalPrice + ' ر.س';
    document.getElementById('payment-distance').innerText = distance + ' كم';
    document.getElementById('payment-car-type').innerText = carTypes[carType] || 'اقتصادي';
    document.getElementById('payment-duration').innerText = tripDetails.duration + ' دقيقة';
    
    // Update wallet balance display
    const user = DB.getUser();
    if (user) {
        document.getElementById('wallet-balance').innerText = user.balance;
    }
};

window.confirmPayment = function() {
    if (!selectedPaymentMethod) {
        showToast('يرجى اختيار طريقة دفع');
        return;
    }
    
    // Show invoice/summary
    showInvoice();
    window.switchSection('payment-invoice');
};

window.showInvoice = function() {
    const carTypes = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
    const paymentMethodNames = { cash: 'دفع كاش', card: 'بطاقة بنكية', wallet: 'محفظة إلكترونية' };
    const basePriceMap = { economy: 10, family: 15, luxury: 25, delivery: 8 };
    const pricePerKmMap = { economy: 4, family: 6, luxury: 9, delivery: 3 };
    
    const carType = currentCarType || 'economy';
    const basePrice = basePriceMap[carType];
    const pricePerKm = pricePerKmMap[carType];
    const distance = tripDetails.distance || 5;
    const distanceCost = distance * pricePerKm;
    const subtotal = basePrice + distanceCost;
    const finalPrice = subtotal - promoDiscount;
    
    // Populate invoice
    document.getElementById('inv-from').innerText = document.getElementById('current-loc-input').value || 'حدد موقعك';
    document.getElementById('inv-to').innerText = document.getElementById('dest-input').value || 'الوجهة المختارة';
    document.getElementById('inv-date').innerText = new Date().toLocaleDateString('ar-EG');
    document.getElementById('inv-car').innerText = carTypes[carType];
    document.getElementById('inv-base').innerText = basePrice + ' ر.س';
    document.getElementById('inv-distance-label').innerText = `المسافة (${distance} كم × ${pricePerKm} ر.س)`;
    document.getElementById('inv-distance-cost').innerText = distanceCost + ' ر.س';
    document.getElementById('inv-total').innerText = finalPrice + ' ر.س';
    document.getElementById('inv-payment-method').innerText = paymentMethodNames[selectedPaymentMethod];
    
    // Show discount row if applicable
    if (promoDiscount > 0) {
        document.getElementById('inv-discount-row').classList.remove('hidden');
        document.getElementById('inv-discount').innerText = '- ' + promoDiscount + ' ر.س';
    } else {
        document.getElementById('inv-discount-row').classList.add('hidden');
    }
};

window.proceedToPayment = function() {
    const paymentMethod = selectedPaymentMethod;
    const amount = (tripDetails.basePrice || 25) - promoDiscount;
    
    // Simulate payment processing
    const btn = event.target;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري معالجة الدفع...';
    
    setTimeout(() => {
        // Mark trip as paid
        const rideDestText = document.getElementById('ride-dest-text');
        const user = DB.getUser();
        
        const newTrip = {
            id: `TR-${Math.floor(Math.random() * 9000) + 1000}`,
            date: new Date().toISOString(),
            pickup: document.getElementById('current-loc-input').value || 'حدد موقعك',
            dropoff: rideDestText ? rideDestText.innerText : 'وجهة محددة',
            cost: amount,
            status: 'completed',
            car: currentCarType || 'economy',
            driver: 'أحمد محمد',
            passenger: user?.name || 'المستخدم',
            paymentMethod: paymentMethod,
            promoApplied: appliedPromo || null
        };
        
        DB.addTrip(newTrip);
        
        if (user) {
            const newBalance = paymentMethod === 'wallet' 
                ? user.balance - amount
                : user.balance;
            DB.updateUser({
                balance: newBalance,
                points: user.points + Math.floor(amount / 5) // 1 point per 5 SAR
            });
        }
        
        const paymentLabels = { cash: 'دفع كاش', card: 'بطاقة بنكية', wallet: 'محفظة إلكترونية' };
        showToast(`تم الدفع: ${amount} ر.س عبر ${paymentMethod === 'cash' ? 'كاش' : paymentMethod === 'card' ? 'بطاقة' : 'محفظة'}`);
        
        // Reset payment data
        selectedPaymentMethod = null;
        appliedPromo = null;
        promoDiscount = 0;
        
        // Show payment confirmation
        const amountEl = document.getElementById('payment-success-amount');
        const methodEl = document.getElementById('payment-success-method');
        const timeEl = document.getElementById('payment-success-time');
        if (amountEl) amountEl.innerText = `${amount} ر.س`;
        if (methodEl) methodEl.innerText = paymentLabels[paymentMethod] || 'دفع كاش';
        if (timeEl) timeEl.innerText = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        window.switchSection('payment-success');
        
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle ml-2"></i> تم - تأكيد الدفع';
    }, 2000);
};

window.initPaymentFlow = function() {
    selectedPaymentMethod = null;
    appliedPromo = null;
    promoDiscount = 0;
    document.getElementById('promo-code-input').value = '';
    document.getElementById('promo-code-input').disabled = false;
    document.getElementById('promo-result').classList.add('hidden');
    document.querySelectorAll('.payment-method-btn .w-5').forEach(radio => {
        radio.classList.remove('bg-indigo-600', 'border-indigo-600');
        radio.classList.add('border-gray-300');
    });
    document.getElementById('confirm-payment-btn').disabled = true;
    updatePaymentSummary();
};

// ========================================
// PANEL DRAG CONTROL (Swipe to minimize/maximize)
// ========================================

let panelDragStartY = 0;
let panelCurrentHeight = 85; // in vh
let isDraggingPanel = false;

window.startDragPanel = function(e) {
    isDraggingPanel = true;
    panelDragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    const panel = document.getElementById('main-panel');
    if (panel) {
        panel.style.transition = 'none';
    }
    
    document.addEventListener('mousemove', dragPanel);
    document.addEventListener('touchmove', dragPanel);
    document.addEventListener('mouseup', endDragPanel);
    document.addEventListener('touchend', endDragPanel);
};

function dragPanel(e) {
    if (!isDraggingPanel) return;
    
    const currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const deltaY = currentY - panelDragStartY;
    const panel = document.getElementById('main-panel');
    
    if (!panel) return;
    
    // Calculate new height (dragging down decreases height)
    const windowHeight = window.innerHeight;
    const newHeightPx = (panelCurrentHeight / 100 * windowHeight) - deltaY;
    const newHeightVh = (newHeightPx / windowHeight) * 100;
    
    // Constrain between 10vh and 85vh
    const constrainedHeight = Math.max(10, Math.min(85, newHeightVh));
    panel.style.maxHeight = constrainedHeight + 'vh';
}

function endDragPanel(e) {
    if (!isDraggingPanel) return;
    
    isDraggingPanel = false;
    const panel = document.getElementById('main-panel');
    
    if (panel) {
        panel.style.transition = 'max-height 0.3s ease-in-out';
        
        // Get current height
        const currentMaxHeight = parseFloat(panel.style.maxHeight);
        
        // Snap to position based on current height
        if (currentMaxHeight < 30) {
            // Minimize to 10vh
            panel.style.maxHeight = '10vh';
            panelCurrentHeight = 10;
        } else if (currentMaxHeight < 60) {
            // Medium size 50vh
            panel.style.maxHeight = '50vh';
            panelCurrentHeight = 50;
        } else {
            // Maximize to 85vh
            panel.style.maxHeight = '85vh';
            panelCurrentHeight = 85;
        }
    }
    
    document.removeEventListener('mousemove', dragPanel);
    document.removeEventListener('touchmove', dragPanel);
    document.removeEventListener('mouseup', endDragPanel);
    document.removeEventListener('touchend', endDragPanel);
}

// ========================================
// TRIP HISTORY SYSTEM
// ========================================

let currentTripFilter = 'all';

window.loadTripHistory = function() {
    const trips = DB.getTrips() || [];
    const container = document.getElementById('trip-history-container');
    
    if (!container) return;
    
    // Show only last 3 trips in profile
    const recentTrips = trips.slice(0, 3);
    
    if (recentTrips.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-gray-400">
                <i class="fas fa-inbox text-3xl mb-2"></i>
                <p class="text-sm">لا توجد رحلات سابقة</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = recentTrips.map(trip => createTripCard(trip, false)).join('');
};

window.loadAllTrips = function() {
    const trips = DB.getTrips() || [];
    const container = document.getElementById('all-trips-container');
    const emptyState = document.getElementById('empty-trips-state');
    
    if (!container) return;
    
    // Filter trips based on current filter
    let filteredTrips = trips;
    if (currentTripFilter !== 'all') {
        filteredTrips = trips.filter(t => t.status === currentTripFilter);
    }
    
    if (filteredTrips.length === 0) {
        container.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }
    
    container.classList.remove('hidden');
    emptyState.classList.add('hidden');
    
    container.innerHTML = filteredTrips.map(trip => createTripCard(trip, true)).join('');
    
    // Update stats
    updateTripStats(trips);
};

function createTripCard(trip, showDetailsButton = false) {
    const statusColors = {
        completed: 'bg-green-100 text-green-700',
        cancelled: 'bg-red-100 text-red-700',
        ongoing: 'bg-blue-100 text-blue-700'
    };
    
    const statusIcons = {
        completed: 'fa-check-circle',
        cancelled: 'fa-times-circle',
        ongoing: 'fa-clock'
    };
    
    const statusLabels = {
        completed: 'مكتملة',
        cancelled: 'ملغية',
        ongoing: 'جارية'
    };
    
    const carTypeLabels = {
        economy: 'اقتصادي',
        family: 'عائلي',
        luxury: 'فاخر',
        delivery: 'توصيل'
    };
    
    const paymentLabels = {
        cash: 'كاش',
        card: 'بطاقة',
        wallet: 'محفظة'
    };
    
    const date = new Date(trip.date);
    const formattedDate = date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
    const formattedTime = date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    
    const detailsBtn = showDetailsButton 
        ? `<button onclick="showTripDetails('${trip.id}')" class="text-indigo-600 hover:text-indigo-700 font-bold text-sm">التفاصيل <i class="fas fa-chevron-left mr-1"></i></button>`
        : '';
    
    return `
        <div class="bg-white border border-gray-200 rounded-2xl p-4 hover:shadow-md transition-shadow">
            <div class="flex justify-between items-start mb-3">
                <div class="flex-1">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="px-2 py-1 rounded-full text-xs font-bold ${statusColors[trip.status] || statusColors.completed}">
                            <i class="fas ${statusIcons[trip.status] || statusIcons.completed} mr-1"></i>
                            ${statusLabels[trip.status] || statusLabels.completed}
                        </span>
                        <span class="text-xs text-gray-500 font-bold">${trip.id}</span>
                    </div>
                    <p class="text-xs text-gray-500 font-bold mb-1">${formattedDate} • ${formattedTime}</p>
                </div>
                <div class="text-left">
                    <p class="text-2xl font-extrabold text-gray-800">${trip.cost} <span class="text-sm text-gray-500">ر.س</span></p>
                    <p class="text-xs text-gray-500 font-bold">${paymentLabels[trip.paymentMethod] || 'كاش'}</p>
                </div>
            </div>
            
            <div class="bg-gray-50 rounded-xl p-3 mb-3">
                <div class="flex items-start gap-2 mb-2">
                    <i class="fas fa-circle text-indigo-600 text-xs mt-1"></i>
                    <p class="text-sm text-gray-700 font-bold flex-1">${trip.pickup || 'حدد موقعك'}</p>
                </div>
                <div class="border-r-2 border-dashed border-gray-300 h-3 mr-1"></div>
                <div class="flex items-start gap-2">
                    <i class="fas fa-map-marker-alt text-red-500 text-xs mt-1"></i>
                    <p class="text-sm text-gray-700 font-bold flex-1">${trip.dropoff || 'الوجهة'}</p>
                </div>
            </div>
            
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${trip.driver}" class="w-8 h-8 rounded-full bg-gray-100 border border-gray-200">
                    <div>
                        <p class="text-xs font-bold text-gray-800">${trip.driver || 'السائق'}</p>
                        <p class="text-xs text-gray-500">${carTypeLabels[trip.car] || 'اقتصادي'}</p>
                    </div>
                </div>
                ${detailsBtn}
            </div>
        </div>
    `;
}

function updateTripStats(trips) {
    const totalTrips = trips.length;
    const totalSpent = trips.reduce((sum, trip) => sum + (trip.cost || 0), 0);
    const completedTrips = trips.filter(t => t.status === 'completed');
    const avgRating = completedTrips.length > 0 
        ? (completedTrips.reduce((sum, trip) => sum + (trip.rating || 5), 0) / completedTrips.length).toFixed(1)
        : 0;
    
    document.getElementById('total-trips-count').innerText = totalTrips;
    document.getElementById('total-spent').innerText = totalSpent;
    document.getElementById('avg-rating').innerText = avgRating;
}

window.filterTrips = function(filter) {
    currentTripFilter = filter;
    
    // Update button styles
    document.querySelectorAll('.trip-filter-btn').forEach(btn => {
        if (btn.dataset.filter === filter) {
            btn.classList.remove('bg-gray-100', 'text-gray-600');
            btn.classList.add('bg-indigo-600', 'text-white', 'active');
        } else {
            btn.classList.remove('bg-indigo-600', 'text-white', 'active');
            btn.classList.add('bg-gray-100', 'text-gray-600');
        }
    });
    
    loadAllTrips();
};

window.showTripDetails = function(tripId) {
    const trips = DB.getTrips() || [];
    const trip = trips.find(t => t.id === tripId);
    
    if (!trip) {
        showToast('الرحلة غير موجودة');
        return;
    }
    
    // Populate trip details
    const statusColors = {
        completed: 'bg-green-100 text-green-700',
        cancelled: 'bg-red-100 text-red-700'
    };
    
    const statusLabels = {
        completed: 'مكتملة',
        cancelled: 'ملغية'
    };
    
    const carTypeLabels = {
        economy: 'اقتصادي',
        family: 'عائلي',
        luxury: 'فاخر',
        delivery: 'توصيل'
    };
    
    const paymentLabels = {
        cash: 'دفع كاش',
        card: 'بطاقة بنكية',
        wallet: 'محفظة إلكترونية'
    };
    
    const date = new Date(trip.date);
    const formattedDateTime = date.toLocaleDateString('ar-EG') + ' • ' + date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    
    document.getElementById('trip-detail-status').className = `inline-block px-4 py-2 rounded-full font-bold text-sm ${statusColors[trip.status] || statusColors.completed}`;
    document.getElementById('trip-detail-status').innerHTML = `<i class="fas fa-check-circle ml-1"></i> ${statusLabels[trip.status] || statusLabels.completed}`;
    document.getElementById('trip-detail-id').innerText = trip.id;
    document.getElementById('trip-detail-date').innerText = formattedDateTime;
    document.getElementById('trip-detail-pickup').innerText = trip.pickup || 'حدد موقعك';
    document.getElementById('trip-detail-dropoff').innerText = trip.dropoff || 'الوجهة';
    document.getElementById('trip-detail-driver-name').innerText = trip.driver || 'أحمد محمد';
    document.getElementById('trip-detail-driver-avatar').src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${trip.driver}`;
    document.getElementById('trip-detail-car-info').innerText = `تويوتا كامري • ${carTypeLabels[trip.car] || 'اقتصادي'}`;
    document.getElementById('trip-detail-payment-method').innerText = paymentLabels[trip.paymentMethod] || 'كاش';
    document.getElementById('trip-detail-cost').innerText = trip.cost + ' ر.س';
    
    // Show rating
    const rating = trip.rating || 5;
    const ratingContainer = document.getElementById('trip-detail-user-rating');
    ratingContainer.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('i');
        star.className = i <= rating ? 'fas fa-star text-yellow-400 text-lg' : 'fas fa-star text-gray-300 text-lg';
        ratingContainer.appendChild(star);
    }
    ratingContainer.nextElementSibling.innerText = `(${rating} نجوم)`;
    
    window.switchSection('trip-details');
};

// Initialize trip history when profile is opened + keep section history
const originalSwitchSection = window.switchSection;
const sectionHistory = [];

function getVisibleSectionName() {
    const sectionIds = {
        destination: 'state-destination',
        rideSelect: 'state-ride-select',
        loading: 'state-loading',
        driver: 'state-driver',
        inRide: 'state-in-ride',
        'payment-method': 'state-payment-method',
        'payment-invoice': 'state-payment-invoice',
        'payment-success': 'state-payment-success',
        rating: 'state-rating',
        profile: 'state-profile',
        chat: 'state-chat',
        'trip-history': 'state-trip-history',
        'trip-details': 'state-trip-details',
        offers: 'state-offers'
    };

    return Object.keys(sectionIds).find(key => {
        const el = document.getElementById(sectionIds[key]);
        return el && !el.classList.contains('hidden');
    }) || null;
}

window.goBackOneStep = function() {
    if (sectionHistory.length === 0) {
        window.switchSection('destination');
        return;
    }

    const last = sectionHistory.pop();
    if (last) {
        originalSwitchSection(last);
    } else {
        window.switchSection('destination');
    }
};

window.switchSection = function(section) {
    const currentSection = getVisibleSectionName();
    if (currentSection && currentSection !== section) {
        sectionHistory.push(currentSection);
        if (sectionHistory.length > 20) sectionHistory.shift();
    }

    originalSwitchSection(section);
    
    const user = DB.getUser();
    if (section === 'profile' && user && user.role === 'passenger') {
        renderTripHistory('trip-history-container', 3);
    } else if (section === 'trip-history') {
        renderAllTrips();
    } else if (section === 'offers') {
        renderOffers();
    }
};