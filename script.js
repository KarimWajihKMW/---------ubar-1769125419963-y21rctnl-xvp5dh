console.log('Akwadra Super Builder Initialized - Multi-Role System with Auth');

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

// Demo role accounts for gated access per role
const roleAccounts = {
    passenger: {
        email: 'abdullah@example.com',
        phone: '+201000000001',
        password: 'P@ssw0rd123'
    },
    driver: {
        email: 'driver@example.com',
        phone: '+201000000002',
        password: 'P@ssw0rd123'
    },
    admin: {
        email: 'admin@example.com',
        phone: '+201000000003',
        password: 'P@ssw0rd123'
    }
};

// Leaflet map state
let leafletMap = null;
let pickupMarkerL = null;
let destMarkerL = null;
let currentPickup = null; // {lat, lng}
let currentDestination = null; // {lat, lng, label}

function initLeafletMap() {
    const mapDiv = document.getElementById('leaflet-map');
    if (!mapDiv) return;
    if (leafletMap) {
        leafletMap.invalidateSize();
        return;
    }
    // Egypt center fallback
    const egyptCenter = [26.8206, 30.8025];
    leafletMap = L.map('leaflet-map', { zoomControl: false }).setView(egyptCenter, 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(leafletMap);

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
            setPickup({ lat: latitude, lng: longitude }, 'موقعك الحالي');
            leafletMap.setView([latitude, longitude], 14);
        }, () => {
            // Fallback to Cairo
            setPickup({ lat: 30.0444, lng: 31.2357 }, 'القاهرة');
            leafletMap.setView([30.0444, 31.2357], 12);
        }, { enableHighAccuracy: true, timeout: 6000 });
    } else {
        setPickup({ lat: 30.0444, lng: 31.2357 }, 'القاهرة');
        leafletMap.setView([30.0444, 31.2357], 12);
    }

    // Destination select by click
    leafletMap.on('click', e => {
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
}

function setPickup(coords, label) {
    currentPickup = { ...coords, label: label || 'نقطة الالتقاط' };
    if (!leafletMap) return;
    if (pickupMarkerL) pickupMarkerL.remove();
    pickupMarkerL = L.marker([coords.lat, coords.lng], { draggable: true }).addTo(leafletMap);
    pickupMarkerL.bindPopup(currentPickup.label).openPopup();
    pickupMarkerL.on('dragend', () => {
        const p = pickupMarkerL.getLatLng();
        currentPickup.lat = p.lat;
        currentPickup.lng = p.lng;
        showToast('تم تعديل موقع الالتقاط');
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

// --- DATABASE SIMULATION SERVICE ---
const DB = {
    keyUser: 'akwadra_user',
    keyTrips: 'akwadra_trips',
    keySession: 'akwadra_session_active',

    init() {
        // Seed User Data if not exists
        if (!SafeStorage.getItem(this.keyUser)) {
            const defaultUser = {
                name: "عبد الله أحمد",
                balance: 150,
                points: 450,
                rating: 4.85,
                status: "عضو ذهبي",
                avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Abdullah"
            };
            SafeStorage.setItem(this.keyUser, JSON.stringify(defaultUser));
        }

        // Seed Trip History if not exists
        if (!SafeStorage.getItem(this.keyTrips)) {
            const defaultTrips = [
                {
                    id: 'TR-8854',
                    date: new Date(Date.now() - 86400000).toISOString(),
                    pickup: "العمل",
                    dropoff: "المنزل",
                    cost: 25,
                    status: "completed",
                    car: "economy",
                    driver: "أحمد محمد",
                    passenger: "عبد الله أحمد"
                },
                {
                    id: 'TR-1290',
                    date: new Date(Date.now() - 172800000).toISOString(),
                    pickup: "المطار",
                    dropoff: "فندق النرجس",
                    cost: 80,
                    status: "completed",
                    car: "luxury",
                    driver: "سالم العلي",
                    passenger: "سارة خالد"
                }
            ];
            SafeStorage.setItem(this.keyTrips, JSON.stringify(defaultTrips));
        }
    },

    getUser() {
        const data = SafeStorage.getItem(this.keyUser);
        return data ? JSON.parse(data) : null;
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
// Defined immediately to avoid ReferenceErrors in HTML

window.selectRole = function(role) {
    currentUserRole = role;
    
    const roleModal = document.getElementById('role-selection-modal');
    // Animate out role selection
    if(roleModal) {
        roleModal.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => roleModal.classList.add('hidden'), 500);
    }

    if (role === 'passenger') {
        // Check for existing session (Auto Login)
        if (DB.hasSession()) {
            initPassengerMode();
        } else {
            // Show Auth Modal
            openAuthModal();
        }
    } else if (role === 'driver' || role === 'admin') {
        openRoleLoginModal(role);
    }
};

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
    const modal = document.getElementById('role-login-modal');
    if (!modal) return;
    modal.dataset.role = role;
    const titles = { driver: 'تسجيل دخول الكابتن', admin: 'تسجيل دخول الإدارة', passenger: 'تسجيل الدخول' };
    const hints = {
        driver: 'استخدم بيانات الكابتن: driver@example.com / P@ssw0rd123',
        admin: 'استخدم بيانات الإدارة: admin@example.com / P@ssw0rd123'
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

window.submitRoleLogin = function() {
    const modal = document.getElementById('role-login-modal');
    if (!modal) return;
    const role = modal.dataset.role || 'driver';
    const emailInput = document.getElementById('role-login-email');
    const passInput = document.getElementById('role-login-password');
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passInput ? passInput.value.trim() : '';
    const account = roleAccounts[role];

    if (!email || !password) {
        showToast('يرجى إدخال البريد وكلمة المرور');
        return;
    }
    if (!account || email.toLowerCase() !== account.email.toLowerCase() || password !== account.password) {
        showToast('بيانات الدخول غير صحيحة لهذا الدور');
        return;
    }

    DB.saveSession();
    closeRoleLoginModal();
    if (role === 'driver') {
        initDriverMode();
    } else if (role === 'admin') {
        initAdminMode();
    } else {
        initPassengerMode();
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

window.verifyOTP = function() {
    let otpCode = '';
    document.querySelectorAll('.otp-input').forEach(input => otpCode += input.value);
    
    if (otpCode.length < 4) {
        showToast('يرجى إدخال الرمز كاملاً');
        return;
    }

    const btn = document.querySelector('#auth-otp-section button');
    const originalText = btn.innerText;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري التحقق...';
    
    setTimeout(() => {
        btn.innerText = originalText;
        loginSuccess();
    }, 1500);
};

window.loginWithEmail = function() {
    const email = document.getElementById('email-input').value;
    const password = document.getElementById('password-input').value;
    if (!email || !email.includes('@')) {
        showToast('يرجى إدخال بريد إلكتروني صحيح');
        return;
    }
    if (!password) {
        showToast('أدخل كلمة المرور');
        return;
    }

    // Passenger login only via this modal
    const account = roleAccounts.passenger;
    if (!account || email.toLowerCase() !== account.email.toLowerCase() || password !== account.password) {
        showToast('بيانات الراكب غير صحيحة');
        return;
    }

    loginSuccess();
};

window.selectCar = function(element, type) {
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected', 'ring-2', 'ring-indigo-500');
    });
    element.classList.add('selected');
    currentCarType = type;
    
    const est = computeTripEstimates();
    currentTripPrice = computePrice(type, est.distanceKm);

    const reqBtn = document.getElementById('request-btn');
    const priceSummary = document.getElementById('ride-price-summary');
    if (priceSummary) {
        priceSummary.classList.remove('hidden');
        priceSummary.innerText = `السعر: ${currentTripPrice} ر.س`;
    }
    if (reqBtn) {
        reqBtn.disabled = false;
        const names = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر' };
        reqBtn.querySelector('span').innerText = `اطلب ${names[type]} — ${currentTripPrice} ر.س`;
        reqBtn.classList.add('animate-pulse');
        setTimeout(() => reqBtn.classList.remove('animate-pulse'), 500);
    }
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
        rating: document.getElementById('state-rating'),
        profile: document.getElementById('state-profile'),
        chat: document.getElementById('state-chat')
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

window.driverRejectRequest = function() {
    document.getElementById('driver-incoming-request').classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    showToast('تم رفض الطلب');
    scheduleMockRequest();
};

window.driverAcceptRequest = function() {
    document.getElementById('driver-incoming-request').classList.add('hidden');
    document.getElementById('driver-active-trip').classList.remove('hidden');
    showToast('تم قبول الطلب! اذهب للراكب');
};

window.driverEndTrip = function() {
    document.getElementById('driver-active-trip').classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    showToast('تم إنهاء الرحلة بنجاح! +25 ر.س');
    triggerConfetti();
    
    DB.addTrip({
        id: `TR-${Math.floor(Math.random() * 9000) + 1000}`,
        date: new Date().toISOString(),
        pickup: "موقع الراكب",
        dropoff: "وجهة محددة",
        cost: 25,
        status: "completed",
        car: "economy",
        driver: "الكابتن أحمد",
        passenger: "راكب تجريبي"
    });
    scheduleMockRequest();
};

window.logoutUser = function() {
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
    const distanceKm = Math.round(haversineKm(currentPickup, currentDestination) * 10) / 10; // 0.1 km precision
    const avgSpeedKmh = 30; // urban estimate
    const etaMin = Math.max(1, Math.round((distanceKm / avgSpeedKmh) * 60));
    return { distanceKm, etaMin };
}

function computePrice(type, distanceKm) {
    const base = { economy: 10, family: 15, luxury: 25 };
    const perKm = { economy: 4, family: 6, luxury: 9 };
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

window.requestRide = function() {
    if (!currentPickup || !currentDestination) { showToast('حدد الالتقاط والوجهة أولاً'); return; }
    if (!currentCarType) { showToast('اختر نوع السيارة'); return; }
    const est = computeTripEstimates();
    currentTripPrice = computePrice(currentCarType, est.distanceKm);
    // Show loading (searching for driver)
    switchSection('loading');
    // After a short delay, show driver found
    setTimeout(() => {
        document.getElementById('eta-display') && (document.getElementById('eta-display').innerText = `${est.etaMin} دقائق`);
        switchSection('driver');
        startDriverTracking();
    }, 2000);
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
    document.getElementById('passenger-ui-container').classList.remove('hidden');
    document.getElementById('passenger-top-bar').classList.remove('hidden');
    const world = document.getElementById('map-world');
    if (world) world.classList.add('hidden');
    initLeafletMap();
    updateUIWithUserData();
}

function initDriverMode() {
    document.getElementById('driver-ui-container').classList.remove('hidden');
    const um = document.getElementById('user-marker');
    if(um) um.classList.add('hidden');
    const world = document.getElementById('map-world');
    if (world) world.classList.remove('hidden');
    scheduleMockRequest();
}

function initAdminMode() {
    document.getElementById('admin-ui-container').classList.remove('hidden');
    renderAdminTrips();
}

function scheduleMockRequest() {
    if (driverRequestTimeout) clearTimeout(driverRequestTimeout);
    driverRequestTimeout = setTimeout(() => {
        const waiting = document.getElementById('driver-status-waiting');
        if (currentUserRole === 'driver' && waiting && !waiting.classList.contains('hidden')) {
            waiting.classList.add('hidden');
            document.getElementById('driver-incoming-request').classList.remove('hidden');
        }
    }, 5000);
}

function renderAdminTrips() {
    const table = document.getElementById('admin-trips-table');
    if (!table) return;
    const trips = DB.getTrips();
    table.innerHTML = '';
    
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

function showToast(message) {
    const toastNotification = document.getElementById('toast-notification');
    const toastMessage = document.getElementById('toast-message');
    if(toastNotification && toastMessage) {
        toastMessage.innerText = message;
        toastNotification.style.transform = 'translate(-50%, 120px)';
        toastNotification.style.opacity = '1';
        setTimeout(() => {
            toastNotification.style.transform = 'translate(-50%, 0)';
            toastNotification.style.opacity = '0';
        }, 3000);
    }
}

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

// --- Map Drag Logic ---
function startDrag(e) {
    if (e.target.closest('.pointer-events-auto')) return;
    const mapContainer = document.getElementById('map-container');
    
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
}

function drag(e) {
    if (!mapState.isDragging) return;
    e.preventDefault();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    mapState.x = clientX - mapState.startX;
    mapState.y = clientY - mapState.startY;
    
    updateMapTransform();
    
    const currentLocInput = document.getElementById('current-loc-input');
    if (currentUserRole === 'passenger' && Math.random() > 0.9 && currentLocInput) {
        currentLocInput.value = "جاري تحديد الموقع...";
    }
}

function endDrag(e) {
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
                finishTrip();
                window.switchSection('rating');
                stopDriverTracking();
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
        pickup: "موقعك الحالي",
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
        mapState.scale = Math.min(mapState.scale + 0.2, 2.5);
        updateMapTransform();
    });

    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
        mapState.scale = Math.max(mapState.scale - 0.2, 0.5);
        updateMapTransform();
    });

    if (centerMapBtn) centerMapBtn.addEventListener('click', () => {
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

    const destInput = document.getElementById('dest-input');
    if (destInput) {
        destInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && destInput.value.trim() !== '') window.confirmDestination(destInput.value);
        });
        destInput.addEventListener('change', () => {
            if (destInput.value.trim() !== '') window.confirmDestination(destInput.value);
        });
    }

    const requestBtn = document.getElementById('request-btn');
    if (requestBtn) requestBtn.addEventListener('click', () => {
        if (!currentCarType) return;
        window.switchSection('loading');
        setTimeout(() => {
            window.switchSection('driver');
            startDriverTracking();
        }, 3000);
    });

    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.addEventListener('click', window.resetApp);

    const profileBtn = document.getElementById('profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', () => {
        window.switchSection('profile');
        if(backBtn) backBtn.classList.remove('hidden');
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