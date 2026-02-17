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

// --- Auth Token Storage (JWT) ---
window.Auth = {
    keyToken: 'akwadra_token',
    getToken() {
        return SafeStorage.getItem(this.keyToken);
    },
    setToken(token) {
        if (!token) return;
        SafeStorage.setItem(this.keyToken, String(token));
    },
    clearToken() {
        SafeStorage.removeItem(this.keyToken);
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
    updateDriverPanelCollapseUI();

    // Realtime trip sync (Socket.io) - no manual refresh
    initRealtimeSocket();

    // Pickup hub preference -> refresh suggestions
    const pref = document.getElementById('pickup-hub-preference');
    if (pref) {
        pref.addEventListener('change', () => {
            try { refreshPickupHubSuggestions(); } catch (e) {}
        });
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
let activePassengerTripId = null;
let passengerMatchInterval = null;
let passengerMatchTripId = null;
let lastTripEstimate = null;
let lastCompletedTrip = null;
let driverDemoRequestAt = 0;
let driverForceRequestAt = 0;
let driverTripStarted = false;
let driverStartReady = false;
let driverAwaitingPayment = false;
let passengerTripStartedAt = null;
let driverTripStartedAt = null;
let lastDriverLocationUpdateAt = 0;
let nearestDriverPreview = null;

// Passenger live tracking (real trip mode)
let passengerLiveTrackingInterval = null;
let passengerLiveTrackingTripId = null;
let passengerLiveTrackingDriverId = null;
let passengerLastTripStatus = null;
let passengerArrivalToastShown = false;
let passengerOngoingToastShown = false;

// Realtime (Socket.io) state
let realtimeSocket = null;
let realtimeConnected = false;
let realtimeSubscribedTripIds = new Set();

let driverTripLocationInterval = null;
let lastDriverSocketEmitAt = 0;

let passengerRealtimeActive = false;
let passengerTripCenteredOnce = false;
let passengerDriverAnimRaf = null;
let passengerDriverAnimFrom = null;
let passengerDriverAnimTo = null;
let passengerDriverAnimStart = 0;
let passengerDriverAnimDuration = 650;

// Trip ETA cache (driver-updated ETA + delay reason)
const tripEtaCache = new Map();

// Pickup suggestion cache (latest pending suggestion per trip)
const tripPickupSuggestionCache = new Map();

// Ride options (Passenger)
let activePriceLock = null; // { id, price, expires_at }

function isPriceLockValid(lock) {
    if (!lock || !lock.expires_at) return false;
    const t = new Date(lock.expires_at).getTime();
    return Number.isFinite(t) && t > Date.now();
}

function getPriceLockPrice(lock) {
    if (!lock) return null;
    const p = lock.price !== undefined && lock.price !== null ? Number(lock.price) : null;
    return Number.isFinite(p) ? p : null;
}

function updatePriceLockUI() {
    const btn = document.getElementById('price-lock-btn');
    const statusEl = document.getElementById('price-lock-status');

    const canLock = currentUserRole === 'passenger' && !!currentCarType && !!currentPickup && !!currentDestination;
    if (btn) btn.disabled = !canLock;

    if (!statusEl) return;
    if (activePriceLock && isPriceLockValid(activePriceLock)) {
        const price = getPriceLockPrice(activePriceLock);
        const exp = new Date(activePriceLock.expires_at);
        const expText = Number.isFinite(exp.getTime())
            ? exp.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
            : '';
        statusEl.textContent = price !== null
            ? `✅ تم تثبيت السعر: ${price} ر.س (حتى ${expText})`
            : '✅ تم تثبيت السعر';
    } else {
        statusEl.textContent = '';
    }
}

function refreshRideSelectPriceUI() {
    if (currentUserRole !== 'passenger') return;
    if (!currentCarType) {
        updatePriceLockUI();
        return;
    }

    const est = computeTripEstimates();
    let nextPrice = computePrice(currentCarType, est.distanceKm);
    if (activePriceLock && isPriceLockValid(activePriceLock)) {
        const locked = getPriceLockPrice(activePriceLock);
        if (locked !== null) nextPrice = locked;
    }
    currentTripPrice = nextPrice;

    const priceSummary = document.getElementById('ride-price-summary');
    if (priceSummary) {
        priceSummary.classList.remove('hidden');
        priceSummary.innerText = `السعر: ${currentTripPrice} ر.س`;
    }

    const selectedEl = document.querySelector('.car-select.selected');
    if (selectedEl) {
        const priceEl = selectedEl.querySelector('.text-xl');
        if (priceEl) priceEl.innerText = `${currentTripPrice} ر.س`;
    }

    const reqBtn = document.getElementById('request-btn');
    if (reqBtn) {
        const names = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
        reqBtn.querySelector('span').innerText = `اطلب ${names[currentCarType] || 'سيارة'} — ${currentTripPrice} ر.س`;
    }

    updatePriceLockUI();
}

window.createPriceLock = async function() {
    if (currentUserRole !== 'passenger') {
        showToast('الميزة للراكب فقط');
        return;
    }
    if (!currentPickup || !currentDestination || !currentCarType) {
        showToast('اختر الالتقاط والوجهة ونوع السيارة أولاً');
        return;
    }

    const btn = document.getElementById('price-lock-btn');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-70', 'cursor-not-allowed');
    }

    try {
        const res = await ApiService.pricing.lock({
            pickup_lat: Number(currentPickup.lat),
            pickup_lng: Number(currentPickup.lng),
            dropoff_lat: Number(currentDestination.lat),
            dropoff_lng: Number(currentDestination.lng),
            car_type: String(currentCarType),
            ttl_seconds: 120
        });

        const d = res?.data || null;
        if (!d?.id) throw new Error('Invalid price lock response');

        activePriceLock = {
            id: Number(d.id),
            price: Number(d.price),
            expires_at: d.expires_at
        };

        showToast('✅ تم تثبيت السعر');
        refreshRideSelectPriceUI();
    } catch (e) {
        console.error('Price lock failed:', e);
        showToast('❌ تعذر تثبيت السعر');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-70', 'cursor-not-allowed');
        }
        updatePriceLockUI();
    }
};

// Multi-stop (MVP numeric lat/lng)
let stopRowSeq = 0;

window.addStopRow = function() {
    const list = document.getElementById('ride-stops-list');
    if (!list) return;
    stopRowSeq += 1;
    const rowId = `stop-${stopRowSeq}`;

    const html = `
        <div class="bg-gray-50 border border-gray-200 rounded-2xl p-3" data-stop-row="1" data-stop-row-id="${rowId}">
            <div class="flex items-center justify-between mb-2">
                <p class="text-xs font-extrabold text-gray-700">محطة</p>
                <button type="button" class="text-xs font-bold text-red-600 hover:text-red-700" onclick="removeStopRow('${rowId}')">حذف</button>
            </div>
            <input type="text" class="w-full px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" placeholder="عنوان (اختياري)" data-stop-label>
            <div class="grid grid-cols-2 gap-2 mt-2">
                <input type="number" inputmode="decimal" class="px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" placeholder="lat" data-stop-lat>
                <input type="number" inputmode="decimal" class="px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" placeholder="lng" data-stop-lng>
            </div>
        </div>
    `;
    list.insertAdjacentHTML('beforeend', html);
};

window.removeStopRow = function(rowId) {
    const list = document.getElementById('ride-stops-list');
    if (!list) return;
    const row = list.querySelector(`[data-stop-row-id="${CSS.escape(String(rowId))}"]`);
    if (row) row.remove();
};

function collectStopsFromUI() {
    const list = document.getElementById('ride-stops-list');
    if (!list) return [];
    const rows = Array.from(list.querySelectorAll('[data-stop-row="1"]'));
    const stops = [];
    for (const row of rows) {
        const label = row.querySelector('[data-stop-label]')?.value?.trim() || '';
        const latRaw = row.querySelector('[data-stop-lat]')?.value;
        const lngRaw = row.querySelector('[data-stop-lng]')?.value;
        if (latRaw === '' || lngRaw === '' || latRaw === undefined || lngRaw === undefined) continue;
        const lat = Number(latRaw);
        const lng = Number(lngRaw);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw new Error('Invalid stop coordinates');
        }
        stops.push({ label, lat, lng });
    }
    return stops;
}

// Split fare (MVP user_id based)
let splitRowSeq = 0;

function renderSplitFareRow(rowId, defaults = {}) {
    const userId = defaults.user_id !== undefined && defaults.user_id !== null ? String(defaults.user_id) : '';
    const amount = defaults.amount !== undefined && defaults.amount !== null ? String(defaults.amount) : '';
    const method = defaults.method ? String(defaults.method) : 'wallet';

    return `
        <div class="bg-gray-50 border border-gray-200 rounded-2xl p-3" data-split-row="1" data-split-row-id="${rowId}">
            <div class="grid grid-cols-3 gap-2">
                <input type="number" inputmode="numeric" class="px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" placeholder="user_id" value="${escapeHtml(userId)}" data-split-user-id>
                <input type="number" inputmode="decimal" class="px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" placeholder="المبلغ" value="${escapeHtml(amount)}" data-split-amount>
                <select class="px-3 py-2 rounded-xl border border-gray-200 bg-white font-bold text-gray-800 outline-none" data-split-method>
                    <option value="wallet" ${method === 'wallet' ? 'selected' : ''}>محفظة</option>
                    <option value="cash" ${method === 'cash' ? 'selected' : ''}>كاش</option>
                </select>
            </div>
            <div class="mt-2 flex justify-end">
                <button type="button" class="text-xs font-bold text-red-600 hover:text-red-700" onclick="removeSplitFareRow('${rowId}')">حذف</button>
            </div>
        </div>
    `;
}

window.toggleSplitFareUI = function() {
    const check = document.getElementById('split-fare-check');
    const wrap = document.getElementById('split-fare-wrap');
    if (!check || !wrap) return;
    wrap.classList.toggle('hidden', !check.checked);
    if (check.checked) {
        const list = document.getElementById('split-fare-list');
        if (list && !list.querySelector('[data-split-row="1"]')) {
            window.resetSplitFareRows();
        }
    }
};

window.resetSplitFareRows = function() {
    const list = document.getElementById('split-fare-list');
    if (!list) return;
    list.innerHTML = '';
    splitRowSeq = 0;

    const user = DB.getUser();
    const meId = user?.id ? Number(user.id) : '';

    splitRowSeq += 1;
    list.insertAdjacentHTML('beforeend', renderSplitFareRow(`split-${splitRowSeq}`, { user_id: meId, method: 'wallet' }));
    splitRowSeq += 1;
    list.insertAdjacentHTML('beforeend', renderSplitFareRow(`split-${splitRowSeq}`, { method: 'wallet' }));
};

window.addSplitFareRow = function() {
    const list = document.getElementById('split-fare-list');
    if (!list) return;
    splitRowSeq += 1;
    list.insertAdjacentHTML('beforeend', renderSplitFareRow(`split-${splitRowSeq}`, { method: 'wallet' }));
};

window.removeSplitFareRow = function(rowId) {
    const list = document.getElementById('split-fare-list');
    if (!list) return;
    const row = list.querySelector(`[data-split-row-id="${CSS.escape(String(rowId))}"]`);
    if (row) row.remove();
};

function collectSplitFareFromUI() {
    const check = document.getElementById('split-fare-check');
    if (!check || !check.checked) return null;
    const list = document.getElementById('split-fare-list');
    if (!list) return null;
    const rows = Array.from(list.querySelectorAll('[data-split-row="1"]'));
    const splits = [];
    for (const row of rows) {
        const userIdRaw = row.querySelector('[data-split-user-id]')?.value;
        const amountRaw = row.querySelector('[data-split-amount]')?.value;
        const method = row.querySelector('[data-split-method]')?.value || 'wallet';
        if (!userIdRaw || !amountRaw) continue;
        const userId = Number(userIdRaw);
        const amount = Number(amountRaw);
        if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(amount) || amount <= 0) {
            throw new Error('Invalid split row');
        }
        splits.push({ user_id: userId, amount, method });
    }
    if (splits.length < 2) {
        throw new Error('Split must have at least 2 participants');
    }
    return splits;
}

// Wallet UI (Real Wallet: balance + transactions)
window.refreshWalletUI = async function() {
    if (currentUserRole !== 'passenger') return;

    const list = document.getElementById('wallet-tx-list');
    if (list) {
        list.innerHTML = '<p class="text-gray-500 text-center py-6">جاري التحميل...</p>';
    }

    try {
        const bal = await ApiService.wallet.getMyBalance();
        const balance = Number(bal?.data?.balance || 0);

        const profileBal = document.getElementById('profile-balance');
        if (profileBal) profileBal.textContent = String(balance);
        const walletBal = document.getElementById('wallet-balance');
        if (walletBal) walletBal.textContent = String(balance);

        try {
            if (typeof DB.updateUser === 'function') {
                DB.updateUser({ balance });
            }
        } catch (e) {
            // ignore
        }

        const tx = await ApiService.wallet.getMyTransactions({ limit: 20 });
        const rows = Array.isArray(tx?.data) ? tx.data : [];

        if (!list) return;

        if (!rows.length) {
            list.innerHTML = '<p class="text-gray-500 text-center py-6">لا توجد معاملات</p>';
            return;
        }

        list.innerHTML = rows.map((r) => {
            const amount = Number(r.amount || 0);
            const isDebit = amount < 0;
            const title = r.reason || (isDebit ? 'خصم' : 'إضافة');
            const ref = r.reference_type && r.reference_id ? `${r.reference_type}:${r.reference_id}` : '';
            const date = r.created_at ? new Date(r.created_at) : null;
            const dateText = date && Number.isFinite(date.getTime()) ? date.toLocaleString('ar-EG') : '';
            return `
                <div class="bg-white border border-gray-200 rounded-2xl p-4">
                    <div class="flex items-start justify-between gap-3">
                        <div class="flex-1">
                            <p class="text-sm font-extrabold text-gray-800">${escapeHtml(title)}</p>
                            <p class="text-[11px] text-gray-500 mt-1">${escapeHtml(ref)} ${escapeHtml(dateText)}</p>
                        </div>
                        <div class="text-left font-extrabold ${isDebit ? 'text-red-600' : 'text-emerald-600'}">${amount.toFixed(2)} ر.س</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('refreshWalletUI failed:', e);
        if (list) list.innerHTML = '<p class="text-gray-500 text-center py-6">تعذر تحميل المحفظة</p>';
    }
};

// Family UI
window.refreshFamilyUI = async function() {
    if (currentUserRole !== 'passenger') return;

    const list = document.getElementById('family-list');
    const select = document.getElementById('ride-family-member');
    if (list) list.innerHTML = '<p class="text-gray-500 text-center py-4">جاري التحميل...</p>';

    try {
        const res = await ApiService.passenger.getFamily();
        const rows = Array.isArray(res?.data) ? res.data : [];

        if (select) {
            select.innerHTML = '<option value="">(حجز لنفسي)</option>';
            rows.forEach((m) => {
                select.insertAdjacentHTML('beforeend', `<option value="${String(m.id)}">${escapeHtml(m.name || 'فرد')}</option>`);
            });

            if (!select.dataset.budgetBound) {
                select.addEventListener('change', () => {
                    try { window.updateFamilyBudgetHint && window.updateFamilyBudgetHint(); } catch (e) {}
                });
                select.dataset.budgetBound = '1';
            }
        }

        if (!list) return;
        if (!rows.length) {
            list.innerHTML = '<p class="text-gray-500 text-center py-4">لا يوجد أفراد</p>';
            return;
        }

        list.innerHTML = rows.map((m) => {
            const phone = m.phone ? String(m.phone) : '';
            return `
                <div class="bg-white border border-gray-200 rounded-2xl p-4 flex items-center justify-between gap-3">
                    <div class="flex-1">
                        <p class="font-extrabold text-gray-800">${escapeHtml(m.name || 'فرد')}</p>
                        <p class="text-[11px] text-gray-500 mt-1">${escapeHtml(phone)}</p>
                    </div>
                    <button type="button" class="px-3 py-2 rounded-xl bg-red-50 text-red-600 font-extrabold hover:bg-red-100" onclick="deleteFamilyMember('${String(m.id)}')">حذف</button>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('refreshFamilyUI failed:', e);
        if (list) list.innerHTML = '<p class="text-gray-500 text-center py-4">تعذر تحميل العائلة</p>';
    }
};

window.updateFamilyBudgetHint = async function() {
    if (currentUserRole !== 'passenger') return;
    const select = document.getElementById('ride-family-member');
    const hint = document.getElementById('family-budget-hint');
    if (!hint) return;

    const memberId = select && select.value ? Number(select.value) : null;
    if (!Number.isFinite(memberId) || memberId <= 0) {
        hint.textContent = '';
        return;
    }

    hint.textContent = 'جاري حساب حدود الإنفاق...';
    try {
        const res = await ApiService.passenger.getFamilyBudget(memberId);
        const d = res?.data || null;
        if (!d) {
            hint.textContent = '';
            return;
        }

        const daily = d.daily_remaining !== null && d.daily_remaining !== undefined ? Number(d.daily_remaining) : null;
        const weekly = d.weekly_remaining !== null && d.weekly_remaining !== undefined ? Number(d.weekly_remaining) : null;
        const parts = [];
        if (daily !== null && Number.isFinite(daily)) parts.push(`المتبقي اليوم: ${daily.toFixed(2)} ر.س`);
        if (weekly !== null && Number.isFinite(weekly)) parts.push(`المتبقي الأسبوع: ${weekly.toFixed(2)} ر.س`);
        hint.textContent = parts.length ? parts.join(' • ') : '';
    } catch (e) {
        hint.textContent = '';
    }
};

window.addFamilyMemberFromUI = async function() {
    const nameEl = document.getElementById('family-add-name');
    const phoneEl = document.getElementById('family-add-phone');
    const name = nameEl ? String(nameEl.value || '').trim() : '';
    const phone = phoneEl ? String(phoneEl.value || '').trim() : '';
    if (!name) {
        showToast('اكتب اسم الفرد');
        return;
    }

    try {
        await ApiService.passenger.addFamilyMember({ name, phone: phone || null });
        if (nameEl) nameEl.value = '';
        if (phoneEl) phoneEl.value = '';
        showToast('✅ تم إضافة فرد');
        await window.refreshFamilyUI();
    } catch (e) {
        console.error('Add family member failed:', e);
        const msg = e && e.message ? String(e.message) : '';
        showToast(`❌ تعذر إضافة فرد${msg ? `: ${msg}` : ''}`);
    }
};

window.deleteFamilyMember = async function(id) {
    try {
        await ApiService.passenger.deleteFamilyMember(id);
        showToast('تم الحذف');
        await window.refreshFamilyUI();
    } catch (e) {
        console.error('Delete family member failed:', e);
        showToast('❌ تعذر الحذف');
    }
};

// Note templates UI
window.refreshNoteTemplatesUI = async function() {
    if (currentUserRole !== 'passenger') return;

    const list = document.getElementById('note-templates-list');
    const select = document.getElementById('ride-note-template');
    if (list) list.innerHTML = '<p class="text-gray-500 text-center py-4">جاري التحميل...</p>';

    try {
        const res = await ApiService.passenger.getNoteTemplates();
        const rows = Array.isArray(res?.data) ? res.data : [];

        if (select) {
            select.innerHTML = '<option value="">(بدون قالب)</option>';
            rows.forEach((t) => {
                const title = t.title ? String(t.title) : (t.note ? String(t.note).slice(0, 22) : 'قالب');
                select.insertAdjacentHTML('beforeend', `<option value="${String(t.id)}">${escapeHtml(title)}</option>`);
            });
        }

        if (!list) return;
        if (!rows.length) {
            list.innerHTML = '<p class="text-gray-500 text-center py-4">لا توجد قوالب</p>';
            return;
        }

        list.innerHTML = rows.map((t) => {
            const title = t.title ? String(t.title) : 'بدون عنوان';
            const note = t.note ? String(t.note) : '';
            return `
                <div class="bg-white border border-gray-200 rounded-2xl p-4 flex items-start justify-between gap-3">
                    <div class="flex-1">
                        <p class="font-extrabold text-gray-800">${escapeHtml(title)}</p>
                        <p class="text-[11px] text-gray-600 mt-1">${escapeHtml(note)}</p>
                    </div>
                    <button type="button" class="px-3 py-2 rounded-xl bg-red-50 text-red-600 font-extrabold hover:bg-red-100" onclick="deleteNoteTemplate('${String(t.id)}')">حذف</button>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('refreshNoteTemplatesUI failed:', e);
        if (list) list.innerHTML = '<p class="text-gray-500 text-center py-4">تعذر تحميل القوالب</p>';
    }
};

window.addNoteTemplateFromUI = async function() {
    const titleEl = document.getElementById('note-tpl-title');
    const noteEl = document.getElementById('note-tpl-note');
    const title = titleEl ? String(titleEl.value || '').trim() : '';
    const note = noteEl ? String(noteEl.value || '').trim() : '';
    if (!note) {
        showToast('اكتب الملاحظة');
        return;
    }
    try {
        await ApiService.passenger.addNoteTemplate(note, title || null);
        if (titleEl) titleEl.value = '';
        if (noteEl) noteEl.value = '';
        showToast('✅ تم إضافة قالب');
        await window.refreshNoteTemplatesUI();
    } catch (e) {
        console.error('Add note template failed:', e);
        showToast('❌ تعذر إضافة قالب');
    }
};

window.deleteNoteTemplate = async function(id) {
    try {
        await ApiService.passenger.deleteNoteTemplate(id);
        showToast('تم الحذف');
        await window.refreshNoteTemplatesUI();
    } catch (e) {
        console.error('Delete note template failed:', e);
        showToast('❌ تعذر الحذف');
    }
};

function normalizeSuggestionRow(row) {
    if (!row) return null;
    const s = { ...row };
    s.id = s.id !== undefined && s.id !== null ? Number(s.id) : s.id;
    s.hub_id = s.hub_id !== undefined && s.hub_id !== null ? Number(s.hub_id) : s.hub_id;
    s.suggested_lat = s.suggested_lat !== undefined && s.suggested_lat !== null ? Number(s.suggested_lat) : s.suggested_lat;
    s.suggested_lng = s.suggested_lng !== undefined && s.suggested_lng !== null ? Number(s.suggested_lng) : s.suggested_lng;
    s.status = s.status ? String(s.status) : s.status;
    s.suggested_title = s.suggested_title ? String(s.suggested_title) : s.suggested_title;
    return s;
}

function setTripPickupSuggestion(tripId, suggestion) {
    if (!tripId) return;
    const key = String(tripId);
    const s = normalizeSuggestionRow(suggestion);
    if (!s) return;
    tripPickupSuggestionCache.set(key, s);
}

function getTripPickupSuggestion(tripId) {
    if (!tripId) return null;
    return tripPickupSuggestionCache.get(String(tripId)) || null;
}

function renderPassengerPickupSuggestionCard() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;

    const card = document.getElementById('passenger-pickup-suggestion-card');
    if (!card) return;

    const suggestion = getTripPickupSuggestion(activePassengerTripId);
    const isPending = suggestion && String(suggestion.status || '').toLowerCase() === 'pending';

    card.classList.toggle('hidden', !isPending);
    if (!isPending) return;

    const titleEl = document.getElementById('passenger-pickup-suggestion-title');
    const metaEl = document.getElementById('passenger-pickup-suggestion-meta');
    const statusEl = document.getElementById('passenger-pickup-suggestion-status');
    const acceptBtn = document.getElementById('passenger-pickup-suggestion-accept');
    const rejectBtn = document.getElementById('passenger-pickup-suggestion-reject');

    const title = suggestion.suggested_title || suggestion.hub_title || 'نقطة تجمع مقترحة';
    if (titleEl) titleEl.textContent = title;
    if (metaEl) {
        const parts = [];
        if (suggestion.hub_category) parts.push(String(suggestion.hub_category));
        if (Number.isFinite(suggestion.suggested_lat) && Number.isFinite(suggestion.suggested_lng)) {
            parts.push(`${suggestion.suggested_lat.toFixed(5)}, ${suggestion.suggested_lng.toFixed(5)}`);
        }
        metaEl.textContent = parts.join(' • ');
    }
    if (statusEl) statusEl.textContent = 'هل توافق على تعديل نقطة الالتقاط؟';

    if (acceptBtn) acceptBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
}

function renderDriverPickupSuggestionStatus() {
    if (currentUserRole !== 'driver') return;
    if (!activeDriverTripId) return;

    const el = document.getElementById('driver-pickup-suggestion-current');
    if (!el) return;

    const s = getTripPickupSuggestion(activeDriverTripId);
    if (!s) {
        el.textContent = '';
        return;
    }

    const title = s.suggested_title || s.hub_title || 'اقتراح';
    const status = String(s.status || '').toLowerCase();
    if (status === 'pending') {
        el.textContent = `آخر اقتراح: ${title} • في انتظار رد الراكب`;
        return;
    }
    if (status === 'accepted') {
        el.textContent = `آخر اقتراح: ${title} • تم القبول`;
        return;
    }
    if (status === 'rejected') {
        el.textContent = `آخر اقتراح: ${title} • تم الرفض`;
        return;
    }
    el.textContent = `آخر اقتراح: ${title}`;
}

async function loadTripPickupSuggestions(tripId) {
    if (!tripId) return;
    try {
        const res = await ApiService.trips.getPickupSuggestions(tripId);
        const rows = Array.isArray(res?.data) ? res.data : [];
        const pending = rows.find((r) => String(r?.status || '').toLowerCase() === 'pending') || null;
        if (pending) {
            setTripPickupSuggestion(tripId, pending);
        }

        if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
            renderPassengerPickupSuggestionCard();
        }
        if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
            renderDriverPickupSuggestionStatus();
        }
    } catch (e) {
        // ignore
    }
}

function applyPickupFromTripUpdate(trip) {
    if (!trip) return;
    const lat = trip.pickup_lat !== undefined && trip.pickup_lat !== null ? Number(trip.pickup_lat) : null;
    const lng = trip.pickup_lng !== undefined && trip.pickup_lng !== null ? Number(trip.pickup_lng) : null;
    const label = trip.pickup_location ? String(trip.pickup_location) : null;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    try {
        // Update local state used by passenger live tracking + routing
        setPickup({ lat, lng }, label || 'نقطة الالتقاط');
        if (trip.pickup_hub_id !== undefined && trip.pickup_hub_id !== null) {
            currentPickupHubId = Number(trip.pickup_hub_id);
        }
        if (leafletMap) {
            leafletMap.panTo([lat, lng]);
        }
    } catch (e) {
        // ignore
    }
}

function setTripEtaCache(tripId, etaMinutes, etaReason, etaUpdatedAt) {
    if (!tripId) return;
    const key = String(tripId);
    const eta = etaMinutes !== undefined && etaMinutes !== null ? Number(etaMinutes) : null;
    tripEtaCache.set(key, {
        eta_minutes: Number.isFinite(eta) ? eta : null,
        eta_reason: etaReason !== undefined && etaReason !== null && String(etaReason).trim() ? String(etaReason).trim() : null,
        eta_updated_at: etaUpdatedAt || null
    });
}

function getTripEtaCache(tripId) {
    if (!tripId) return null;
    return tripEtaCache.get(String(tripId)) || null;
}

function formatEtaMetaText(meta) {
    if (!meta) return '';
    const parts = [];
    if (meta.eta_minutes !== null && meta.eta_minutes !== undefined) {
        const mins = Number(meta.eta_minutes);
        if (Number.isFinite(mins)) parts.push(`ETA: ${Math.max(0, Math.round(mins))} دقيقة`);
    }
    if (meta.eta_reason) parts.push(`السبب: ${meta.eta_reason}`);
    return parts.join(' • ');
}

function renderPassengerEtaMeta() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;
    const meta = getTripEtaCache(activePassengerTripId);
    const text = formatEtaMetaText(meta);

    const elPickup = document.getElementById('eta-reason-display');
    if (elPickup) {
        elPickup.textContent = text;
        elPickup.classList.toggle('hidden', !text);
    }

    const elRide = document.getElementById('ride-eta-reason-display');
    if (elRide) {
        elRide.textContent = text;
        elRide.classList.toggle('hidden', !text);
    }
}

function renderDriverEtaMeta() {
    if (currentUserRole !== 'driver') return;
    if (!activeDriverTripId) return;
    const meta = getTripEtaCache(activeDriverTripId);

    const currentEl = document.getElementById('driver-eta-current');
    if (currentEl) {
        const text = formatEtaMetaText(meta);
        currentEl.textContent = text ? `آخر تحديث: ${text}` : '';
    }

    const updatedAtEl = document.getElementById('driver-eta-last-updated');
    if (updatedAtEl) {
        if (meta?.eta_updated_at) {
            const d = new Date(meta.eta_updated_at);
            updatedAtEl.textContent = Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
        } else {
            updatedAtEl.textContent = '';
        }
    }
}

async function loadTripEtaMeta(tripId) {
    if (!tripId) return;
    try {
        const res = await ApiService.trips.getEta(tripId);
        const d = res?.data || null;
        if (!d) return;
        setTripEtaCache(tripId, d.eta_minutes, d.eta_reason, d.eta_updated_at);
        if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
            renderPassengerEtaMeta();
        }
        if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
            renderDriverEtaMeta();
        }
    } catch (e) {
        // ignore
    }
}

function subscribeUserRealtime() {
    try {
        if (!realtimeSocket || !realtimeSocket.connected) return;
        const token = (window.ApiService && typeof window.ApiService.getToken === 'function')
            ? window.ApiService.getToken()
            : (window.Auth && typeof window.Auth.getToken === 'function' ? window.Auth.getToken() : null);
        if (!token) return;
        realtimeSocket.emit('subscribe_user', { token: String(token) });
    } catch (e) {
        // ignore
    }
}

function clearMatchTimelineUI() {
    const items = document.getElementById('match-timeline-items');
    if (items) items.innerHTML = '';
}

function appendMatchTimelineUI(text) {
    const items = document.getElementById('match-timeline-items');
    if (!items) return;
    const t = String(text || '').trim();
    if (!t) return;
    const el = document.createElement('div');
    el.className = 'flex items-start gap-2';
    el.innerHTML = `<span class="text-indigo-600">•</span><span class="flex-1">${escapeHtml(t)}</span>`;
    items.appendChild(el);
}

function resetMatchTimelineUI() {
    clearMatchTimelineUI();
    appendMatchTimelineUI('تم إرسال الطلب للسائقين القريبين');
}

function isActivePassengerTrip(tripId) {
    return currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId);
}

function initRealtimeSocket() {
    if (realtimeSocket || typeof io !== 'function') return;
    try {
        realtimeSocket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            timeout: 10000
        });

        realtimeSocket.on('connect', () => {
            realtimeConnected = true;

            // Subscribe to user room (match timeline updates)
            subscribeUserRealtime();

            // Re-join rooms after reconnect
            realtimeSubscribedTripIds.forEach((tripId) => {
                realtimeSocket.emit('subscribe_trip', { trip_id: String(tripId) });
            });
        });

        realtimeSocket.on('disconnect', () => {
            realtimeConnected = false;
        });

        realtimeSocket.on('trip_started', (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            handleTripStartedRealtime(String(tripId));
        });

        realtimeSocket.on('trip_completed', (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            handleTripCompletedRealtime({
                trip_id: String(tripId),
                duration: payload?.duration,
                distance: payload?.distance,
                price: payload?.price
            });
        });

        realtimeSocket.on('trip_rated', (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            handleTripRatedRealtime(String(tripId));
        });

        realtimeSocket.on('driver_live_location', (payload) => {
            const tripId = payload?.trip_id;
            const lat = payload?.driver_lat !== undefined && payload?.driver_lat !== null ? Number(payload.driver_lat) : null;
            const lng = payload?.driver_lng !== undefined && payload?.driver_lng !== null ? Number(payload.driver_lng) : null;
            if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
            handleDriverLiveLocationRealtime(String(tripId), { lat, lng });
        });

        realtimeSocket.on('trip_eta_update', (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            setTripEtaCache(String(tripId), payload?.eta_minutes, payload?.eta_reason, payload?.eta_updated_at);

            if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
                renderPassengerEtaMeta();
            }
            if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
                renderDriverEtaMeta();
            }
        });

        realtimeSocket.on('pickup_suggestion_created', (payload) => {
            const tripId = payload?.trip_id;
            const suggestion = payload?.suggestion;
            if (!tripId || !suggestion) return;

            setTripPickupSuggestion(String(tripId), suggestion);

            if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
                renderPassengerPickupSuggestionCard();
                showToast('📍 السائق اقترح نقطة تجمع جديدة');
            }
            if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
                renderDriverPickupSuggestionStatus();
                showToast('✅ تم إرسال اقتراح نقطة التجمع');
            }
        });

        realtimeSocket.on('pickup_suggestion_decided', (payload) => {
            const tripId = payload?.trip_id;
            const decision = String(payload?.decision || '').toLowerCase();
            const trip = payload?.trip;
            if (!tripId) return;

            const existing = getTripPickupSuggestion(tripId);
            if (existing) {
                setTripPickupSuggestion(tripId, { ...existing, status: decision });
            }

            if (decision === 'accepted' && trip) {
                applyPickupFromTripUpdate(trip);
            }

            if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
                const card = document.getElementById('passenger-pickup-suggestion-card');
                if (card) card.classList.add('hidden');
                showToast(decision === 'accepted' ? '✅ تم قبول نقطة التجمع' : 'تم رفض نقطة التجمع');
            }

            if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
                renderDriverPickupSuggestionStatus();
                showToast(decision === 'accepted' ? '✅ الراكب وافق على نقطة التجمع' : '❌ الراكب رفض نقطة التجمع');
            }
        });

        realtimeSocket.on('safety_event', (payload) => {
            const tripId = payload?.trip_id;
            const event = payload?.event;
            if (!tripId || !event) return;
            handleSafetyEventRealtime(String(tripId), event);
        });

        realtimeSocket.on('pending_request_update', (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            if (!isActivePassengerTrip(tripId)) return;
            const msg = payload?.message ? String(payload.message) : null;
            if (msg) appendMatchTimelineUI(msg);
        });

        realtimeSocket.on('trip_assigned', async (payload) => {
            const tripId = payload?.trip_id;
            if (!tripId) return;
            if (!isActivePassengerTrip(tripId)) return;

            appendMatchTimelineUI('تم إسناد الرحلة');

            try {
                stopPassengerMatchPolling();
                stopPassengerPickupLiveUpdates();
            } catch (e) {
                // ignore
            }

            const trip = payload?.trip || null;
            if (trip && trip.driver_id) {
                await handlePassengerAssignedTrip(trip);
                return;
            }

            try {
                const res = await ApiService.trips.getById(tripId);
                if (res?.data?.driver_id) {
                    await handlePassengerAssignedTrip(res.data);
                }
            } catch (e) {
                // ignore
            }
        });
    } catch (err) {
        console.warn('⚠️ Realtime socket init failed:', err.message || err);
        realtimeSocket = null;
        realtimeConnected = false;
    }
}

function showPassengerSafetyBanner(text) {
    const banner = document.getElementById('passenger-safety-banner');
    const t = document.getElementById('passenger-safety-banner-text');
    if (t) t.textContent = text || 'تم رصد سلوك غير طبيعي في المسار.';
    if (banner) banner.classList.remove('hidden');
}

window.hidePassengerSafetyBanner = function() {
    const banner = document.getElementById('passenger-safety-banner');
    if (banner) banner.classList.add('hidden');
};

function handleSafetyEventRealtime(tripId, event) {
    if (!tripId || !event) return;
    const type = String(event.event_type || '').toLowerCase();

    // Passenger-only banner for the active trip
    if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
        if (type === 'route_deviation_detected') {
            showPassengerSafetyBanner('⚠️ تم رصد انحراف محتمل عن المسار. هل كل شيء تمام؟');
            showToast('🛡️ تنبيه أمان: انحراف مسار');
            return;
        }
        if (type === 'unexpected_stop_detected') {
            showPassengerSafetyBanner('⚠️ تم رصد توقف غير طبيعي. هل كل شيء تمام؟');
            showToast('🛡️ تنبيه أمان: توقف غير طبيعي');
            return;
        }
        if (type === 'rider_ok_confirmed') {
            window.hidePassengerSafetyBanner();
            return;
        }
        if (type === 'rider_help_requested') {
            showToast('✅ تم تسجيل طلب المساعدة');
            return;
        }
    }
}

window.passengerSafetyOk = async function() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;
    try {
        await ApiService.trips.safetyOk(activePassengerTripId);
        window.hidePassengerSafetyBanner();
        showToast('✅ تمام');
    } catch (e) {
        showToast('❌ تعذر إرسال التأكيد');
    }
};

window.passengerSafetyHelp = async function() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;
    try {
        const res = await ApiService.trips.safetyHelp(activePassengerTripId);
        window.hidePassengerSafetyBanner();
        if (res?.message) {
            try {
                await navigator.clipboard.writeText(String(res.message));
                showToast('📋 تم نسخ رسالة المساعدة');
            } catch (e) {
                showToast('✅ تم تجهيز رسالة المساعدة');
            }
        } else {
            showToast('✅ تم تسجيل طلب المساعدة');
        }
    } catch (e) {
        showToast('❌ تعذر طلب المساعدة');
    }
};

window.refreshPickupHandshake = async function() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;
    try {
        const res = await ApiService.trips.getPickupHandshake(activePassengerTripId);
        const d = res?.data || null;
        if (!d) return;
        const card = document.getElementById('passenger-pickup-handshake-card');
        const codeEl = document.getElementById('passenger-pickup-handshake-code');
        const expEl = document.getElementById('passenger-pickup-handshake-expires');
        const qrEl = document.getElementById('passenger-pickup-handshake-qr');

        if (codeEl) codeEl.textContent = String(d.pickup_phrase || '------');
        if (expEl) {
            const dt = d.expires_at ? new Date(d.expires_at) : null;
            expEl.textContent = dt && Number.isFinite(dt.getTime())
                ? dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
                : '--:--';
        }
        if (card) card.classList.remove('hidden');

        if (qrEl) {
            const url = d.qr_png_data_url ? String(d.qr_png_data_url) : '';
            if (url && url.startsWith('data:image')) {
                qrEl.src = url;
                qrEl.classList.remove('hidden');
            } else {
                qrEl.removeAttribute('src');
                qrEl.classList.add('hidden');
            }
        }
    } catch (e) {
        // non-blocking
    }
};

window.scheduleGuardianCheckin = async function() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) {
        showToast('لا توجد رحلة نشطة');
        return;
    }
    const minsEl = document.getElementById('guardian-minutes');
    const mins = minsEl ? Number(minsEl.value) : 15;
    const statusEl = document.getElementById('guardian-status');
    try {
        const res = await ApiService.trips.scheduleGuardianCheckin(activePassengerTripId, { minutes_from_now: mins });
        if (statusEl) {
            const due = res?.data?.due_at ? new Date(res.data.due_at) : null;
            statusEl.textContent = due && Number.isFinite(due.getTime())
                ? `✅ تم الجدولة: ${due.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`
                : '✅ تم الجدولة';
            statusEl.classList.remove('hidden');
        }
        showToast('✅ تم جدولة Guardian');
    } catch (e) {
        showToast('❌ تعذر جدولة Guardian');
    }
};

window.confirmGuardianCheckin = async function() {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) return;
    const statusEl = document.getElementById('guardian-status');
    try {
        await ApiService.trips.confirmGuardianCheckin(activePassengerTripId);
        if (statusEl) {
            statusEl.textContent = '✅ تم التأكيد: أنا بخير';
            statusEl.classList.remove('hidden');
        }
        showToast('✅ تم التأكيد');
    } catch (e) {
        showToast('❌ تعذر التأكيد');
    }
};

window.hidePassengerPickupSuggestion = function() {
    const card = document.getElementById('passenger-pickup-suggestion-card');
    if (card) card.classList.add('hidden');
};

async function passengerDecidePickupSuggestion(decision) {
    if (currentUserRole !== 'passenger') return;
    if (!activePassengerTripId) {
        showToast('لا توجد رحلة نشطة');
        return;
    }

    const suggestion = getTripPickupSuggestion(activePassengerTripId);
    if (!suggestion || !suggestion.id) {
        showToast('لا يوجد اقتراح صالح');
        return;
    }

    const acceptBtn = document.getElementById('passenger-pickup-suggestion-accept');
    const rejectBtn = document.getElementById('passenger-pickup-suggestion-reject');
    if (acceptBtn) acceptBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;

    try {
        const res = await ApiService.trips.decidePickupSuggestion(activePassengerTripId, suggestion.id, decision);
        const updatedSug = res?.data || null;
        const updatedTrip = res?.trip || null;

        if (updatedSug) {
            setTripPickupSuggestion(activePassengerTripId, updatedSug);
        } else {
            setTripPickupSuggestion(activePassengerTripId, { ...suggestion, status: decision });
        }

        if (decision === 'accepted' && updatedTrip) {
            applyPickupFromTripUpdate(updatedTrip);
        }

        const card = document.getElementById('passenger-pickup-suggestion-card');
        if (card) card.classList.add('hidden');
        showToast(decision === 'accepted' ? '✅ تم قبول نقطة التجمع' : 'تم رفض نقطة التجمع');
    } catch (e) {
        console.error('Pickup suggestion decision failed:', e);
        showToast('❌ تعذر إرسال قرارك');
    } finally {
        if (acceptBtn) acceptBtn.disabled = false;
        if (rejectBtn) rejectBtn.disabled = false;
    }
}

window.passengerAcceptPickupSuggestion = function() {
    passengerDecidePickupSuggestion('accepted');
};

window.passengerRejectPickupSuggestion = function() {
    passengerDecidePickupSuggestion('rejected');
};

window.driverFetchPickupHubsForSuggestion = async function() {
    if (currentUserRole !== 'driver') {
        showToast('هذه الميزة للسائق فقط');
        return;
    }
    if (!activeDriverTripId) {
        showToast('لا توجد رحلة نشطة');
        return;
    }

    const selectEl = document.getElementById('driver-pickup-hub-select');
    if (!selectEl) return;

    const base = passengerPickup && Number.isFinite(Number(passengerPickup.lat)) && Number.isFinite(Number(passengerPickup.lng))
        ? { lat: Number(passengerPickup.lat), lng: Number(passengerPickup.lng) }
        : (currentIncomingTrip && Number.isFinite(Number(currentIncomingTrip.pickup_lat)) && Number.isFinite(Number(currentIncomingTrip.pickup_lng))
            ? { lat: Number(currentIncomingTrip.pickup_lat), lng: Number(currentIncomingTrip.pickup_lng) }
            : null);

    if (!base) {
        showToast('❌ لا توجد إحداثيات لموقع الراكب');
        return;
    }

    try {
        selectEl.innerHTML = '<option value="">جاري التحميل...</option>';
        const res = await ApiService.pickupHubs.suggest(base.lat, base.lng, 8);
        const hubs = Array.isArray(res?.data) ? res.data : [];
        if (!hubs.length) {
            selectEl.innerHTML = '<option value="">لا توجد نقاط قريبة</option>';
            return;
        }
        selectEl.innerHTML = hubs
            .map((h) => {
                const id = h.id;
                const title = h.title || 'نقطة تجمع';
                const km = h.distance_km !== undefined && h.distance_km !== null ? Number(h.distance_km) : null;
                const label = Number.isFinite(km) ? `${title} • ${(km).toFixed(1)} كم` : title;
                return `<option value="${String(id)}">${escapeHtml(label)}</option>`;
            })
            .join('');
        showToast('✅ تم تحميل نقاط التجمع');
    } catch (e) {
        console.error('Fetch pickup hubs failed:', e);
        selectEl.innerHTML = '<option value="">تعذر تحميل النقاط</option>';
        showToast('❌ تعذر تحميل نقاط التجمع');
    }
};

window.driverSendPickupSuggestion = async function() {
    if (currentUserRole !== 'driver') {
        showToast('هذه الميزة للسائق فقط');
        return;
    }
    if (!activeDriverTripId) {
        showToast('لا توجد رحلة نشطة');
        return;
    }

    const btn = document.getElementById('driver-pickup-suggest-btn');
    const selectEl = document.getElementById('driver-pickup-hub-select');
    if (!btn || !selectEl) return;

    const hubId = selectEl.value ? Number(selectEl.value) : null;
    if (!Number.isFinite(hubId) || hubId <= 0) {
        showToast('اختر نقطة تجمع أولاً');
        return;
    }

    btn.disabled = true;
    btn.classList.add('opacity-70', 'cursor-not-allowed');

    try {
        const res = await ApiService.trips.createPickupSuggestion(activeDriverTripId, { hub_id: hubId });
        const suggestion = res?.data || null;
        if (suggestion) {
            setTripPickupSuggestion(activeDriverTripId, suggestion);
            renderDriverPickupSuggestionStatus();
        }
        showToast('✅ تم إرسال الاقتراح للراكب');
    } catch (e) {
        console.error('Send pickup suggestion failed:', e);
        showToast('❌ تعذر إرسال الاقتراح');
    } finally {
        btn.disabled = false;
        btn.classList.remove('opacity-70', 'cursor-not-allowed');
    }
};

window.driverEtaReasonChanged = function() {
    const reasonEl = document.getElementById('driver-eta-reason');
    const wrap = document.getElementById('driver-eta-reason-custom-wrap');
    if (!reasonEl || !wrap) return;
    wrap.classList.toggle('hidden', String(reasonEl.value) !== 'custom');
};

window.driverUpdateEta = async function() {
    if (currentUserRole !== 'driver') {
        showToast('هذه الميزة للسائق فقط');
        return;
    }
    if (!activeDriverTripId) {
        showToast('لا توجد رحلة نشطة');
        return;
    }

    const btn = document.getElementById('driver-eta-update-btn');
    const minsEl = document.getElementById('driver-eta-minutes');
    const reasonEl = document.getElementById('driver-eta-reason');
    const customEl = document.getElementById('driver-eta-reason-custom');

    const etaMinutesRaw = minsEl ? minsEl.value : '';
    const etaMinutes = etaMinutesRaw !== '' && etaMinutesRaw !== null && etaMinutesRaw !== undefined
        ? Number(etaMinutesRaw)
        : null;

    if (etaMinutes !== null && (!Number.isFinite(etaMinutes) || etaMinutes < 0 || etaMinutes > 360)) {
        showToast('❌ الوقت لازم يكون بين 0 و 360 دقيقة');
        return;
    }

    let reason = reasonEl ? String(reasonEl.value || '') : '';
    if (reason === 'custom') {
        reason = customEl ? String(customEl.value || '') : '';
    }
    reason = reason.trim();

    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-70', 'cursor-not-allowed');
    }

    try {
        const res = await ApiService.trips.updateEta(activeDriverTripId, {
            eta_minutes: etaMinutes,
            eta_reason: reason
        });
        const d = res?.data || null;
        if (d) {
            setTripEtaCache(activeDriverTripId, d.eta_minutes, d.eta_reason, d.eta_updated_at);
            renderDriverEtaMeta();
        }
        showToast('✅ تم تحديث ETA');
    } catch (e) {
        console.error('ETA update failed:', e);
        showToast('❌ تعذر تحديث ETA');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-70', 'cursor-not-allowed');
        }
    }
};

function subscribeTripRealtime(tripId) {
    if (!tripId) return;
    realtimeSubscribedTripIds.add(String(tripId));
    if (realtimeSocket && realtimeConnected) {
        realtimeSocket.emit('subscribe_trip', { trip_id: String(tripId) });
    }
}

function unsubscribeTripRealtime(tripId) {
    if (!tripId) return;
    realtimeSubscribedTripIds.delete(String(tripId));
    if (realtimeSocket && realtimeConnected) {
        realtimeSocket.emit('unsubscribe_trip', { trip_id: String(tripId) });
    }
}

function startDriverTripSocketLocationUpdates() {
    stopDriverTripSocketLocationUpdates();
    driverTripLocationInterval = setInterval(() => {
        if (!realtimeSocket || !realtimeConnected) return;
        if (currentUserRole !== 'driver') return;
        if (!driverTripStarted) return;
        if (!activeDriverTripId) return;
        if (!lastGeoCoords || !Number.isFinite(Number(lastGeoCoords.lat)) || !Number.isFinite(Number(lastGeoCoords.lng))) return;

        const now = Date.now();
        if (now - lastDriverSocketEmitAt < 2800) return;
        lastDriverSocketEmitAt = now;

        realtimeSocket.emit('driver_location_update', {
            trip_id: String(activeDriverTripId),
            driver_lat: Number(lastGeoCoords.lat),
            driver_lng: Number(lastGeoCoords.lng),
            timestamp: now
        });
    }, 3000);
}

function stopDriverTripSocketLocationUpdates() {
    if (driverTripLocationInterval) {
        clearInterval(driverTripLocationInterval);
        driverTripLocationInterval = null;
    }
}

function smoothMoveDriverMarker(to) {
    if (!driverMarkerL || !to) return;
    const fromLatLng = driverMarkerL.getLatLng();
    if (!fromLatLng) {
        driverMarkerL.setLatLng([to.lat, to.lng]);
        return;
    }

    passengerDriverAnimFrom = { lat: fromLatLng.lat, lng: fromLatLng.lng };
    passengerDriverAnimTo = { lat: to.lat, lng: to.lng };
    passengerDriverAnimStart = performance.now();

    if (passengerDriverAnimRaf) {
        cancelAnimationFrame(passengerDriverAnimRaf);
        passengerDriverAnimRaf = null;
    }

    const step = (now) => {
        const t = Math.min(1, (now - passengerDriverAnimStart) / passengerDriverAnimDuration);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const lat = passengerDriverAnimFrom.lat + (passengerDriverAnimTo.lat - passengerDriverAnimFrom.lat) * eased;
        const lng = passengerDriverAnimFrom.lng + (passengerDriverAnimTo.lng - passengerDriverAnimFrom.lng) * eased;
        driverMarkerL.setLatLng([lat, lng]);
        if (t < 1) {
            passengerDriverAnimRaf = requestAnimationFrame(step);
        } else {
            passengerDriverAnimRaf = null;
        }
    };

    passengerDriverAnimRaf = requestAnimationFrame(step);
}

function handleDriverLiveLocationRealtime(tripId, coords) {
    // Passenger live tracking
    if (currentUserRole !== 'passenger') return;
    if (!passengerRealtimeActive) return;
    if (!activePassengerTripId || String(activePassengerTripId) !== String(tripId)) return;

    driverLocation = { ...coords };

    // Ensure marker exists, update smoothly
    ensurePassengerDriverMarker(coords);
    smoothMoveDriverMarker(coords);

    // Update route target (pickup before start, destination after start)
    const target = passengerLastTripStatus === 'ongoing'
        ? (currentDestination ? { lat: Number(currentDestination.lat), lng: Number(currentDestination.lng) } : null)
        : (currentPickup ? { lat: Number(currentPickup.lat), lng: Number(currentPickup.lng) } : null);

    if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
        updatePassengerDriverRoute(coords, target);

        const distanceMeters = calculateDistance(coords.lat, coords.lng, target.lat, target.lng);
        updateDriverDistance(distanceMeters);
        const speedMps = passengerLastTripStatus === 'ongoing' ? 10 : 9;
        const etaSecondsLive = Math.round(distanceMeters / speedMps);
        if (passengerLastTripStatus === 'ongoing') {
            updatePassengerEtaUI(etaSecondsLive, 'ride');
        } else {
            updatePassengerEtaUI(etaSecondsLive, 'pickup');
        }
    }
}

function handleTripStartedRealtime(tripId) {
    if (!tripId) return;

    // Passenger: transition immediately
    if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
        passengerLastTripStatus = 'ongoing';
        passengerRealtimeActive = true;
        passengerTripCenteredOnce = false;
        passengerTripStartedAt = Date.now();

        if (typeof window.switchSection === 'function') {
            window.switchSection('inRide');
        }
        preparePassengerDriverMapView();

        const destTextEl = document.getElementById('ride-dest-text');
        if (destTextEl) destTextEl.innerText = currentDestination?.label || 'الوجهة';

        // Center map once on trip start (driver + destination)
        if (!passengerTripCenteredOnce && leafletMap && driverLocation && currentDestination) {
            const bounds = L.latLngBounds([
                [driverLocation.lat, driverLocation.lng],
                [Number(currentDestination.lat), Number(currentDestination.lng)]
            ]);
            leafletMap.fitBounds(bounds, { padding: [50, 50] });
            passengerTripCenteredOnce = true;
        }

        showToast('🚗 بدأت الرحلة');
        return;
    }

    // Driver: start sending GPS updates
    if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
        startDriverTripSocketLocationUpdates();
    }
}

function showPassengerTripSummaryAndRating(tripId, details = {}) {
    // Stop tracking (polling + socket) but keep last marker position
    stopPassengerLiveTripTracking();
    passengerRealtimeActive = false;

    // Stop receiving live location updates for this trip
    unsubscribeTripRealtime(tripId);

    const distance = details?.distance !== undefined && details?.distance !== null ? Number(details.distance) : (tripDetails?.distance || 0);
    const duration = details?.duration !== undefined && details?.duration !== null ? Number(details.duration) : (tripDetails?.duration || 0);
    const price = details?.price !== undefined && details?.price !== null ? Number(details.price) : Number(currentTripPrice || 0);

    // Save lastCompletedTrip for rating flow
    lastCompletedTrip = {
        id: tripId,
        distance: Number.isFinite(distance) ? distance : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        cost: Number.isFinite(price) ? price : 0,
        pickup: currentPickup?.label || 'موقعك الحالي',
        dropoff: currentDestination?.label || 'الوجهة'
    };

    // Populate existing summary UI (payment-success)
    const amountEl = document.getElementById('payment-success-amount');
    const methodEl = document.getElementById('payment-success-method');
    const timeEl = document.getElementById('payment-success-time');
    if (amountEl) amountEl.innerText = `${Number.isFinite(price) ? price : 0} ر.س`;
    if (methodEl) methodEl.innerText = 'كاش';
    if (timeEl) timeEl.innerText = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    const tripIdEl = document.getElementById('payment-success-trip-id');
    const pickupEl = document.getElementById('payment-success-pickup');
    const dropoffEl = document.getElementById('payment-success-dropoff');
    const distanceEl = document.getElementById('payment-success-distance');
    const durationEl = document.getElementById('payment-success-duration');
    if (tripIdEl) tripIdEl.innerText = tripId || '--';
    if (pickupEl) pickupEl.innerText = currentPickup?.label || '--';
    if (dropoffEl) dropoffEl.innerText = currentDestination?.label || '--';
    if (distanceEl) distanceEl.innerText = `${Number.isFinite(distance) ? distance : 0} كم`;
    if (durationEl) durationEl.innerText = `${Number.isFinite(duration) ? duration : 0} دقيقة`;

    if (typeof window.switchSection === 'function') {
        window.switchSection('payment-success');
    }

    // Refresh trip history cache so My Trips updates instantly
    try {
        const user = DB.getUser();
        if (user?.id) {
            DB.fetchTrips({ userId: user.id, role: user.role || 'passenger' }).then(() => {
                try {
                    // Profile "آخر الرحلات"
                    renderTripHistory('trip-history-container', 3);
                    // Full history screen if present
                    const all = document.getElementById('all-trips-container');
                    if (all && !document.getElementById('state-trip-history')?.classList.contains('hidden')) {
                        window.renderAllTrips && window.renderAllTrips();
                    }
                } catch (e) {
                    // ignore
                }
            });
        }
    } catch (e) {
        // ignore
    }
}

function handleTripCompletedRealtime(payload) {
    const tripId = payload?.trip_id;
    if (!tripId) return;

    // Passenger
    if (currentUserRole === 'passenger' && activePassengerTripId && String(activePassengerTripId) === String(tripId)) {
        showToast('✅ تم إنهاء الرحلة');
        showPassengerTripSummaryAndRating(String(tripId), {
            distance: payload?.distance,
            duration: payload?.duration,
            price: payload?.price
        });
        return;
    }

    // Driver
    if (currentUserRole === 'driver' && activeDriverTripId && String(activeDriverTripId) === String(tripId)) {
        stopDriverTripSocketLocationUpdates();
    }
}

function handleTripRatedRealtime(tripId) {
    if (!tripId) return;
    if (currentUserRole !== 'driver') return;

    // Driver gets notified rating submitted
    showToast('⭐ تم تقييم الرحلة');

    try {
        if (typeof window.closeDriverTripSummary === 'function') {
            window.closeDriverTripSummary();
        }
    } catch (e) {
        // ignore
    }
}

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
let currentPickupHubId = null;
let currentDestination = null; // {lat, lng, label}
let driverLocation = null; // {lat, lng}
let passengerPickup = null; // {lat, lng, label}
let etaCountdown = null;
let etaSeconds = 0;
let driverToPassengerAnim = null;
let driverToDestinationAnim = null;
let passengerToDestinationAnim = null;
let mapSelectionMode = 'destination';
let isDriverInfoCollapsed = false;
let isDriverPanelCollapsed = false;
let isPassengerPanelHidden = false;
let locationWatchId = null;
let lastGeoCoords = null;
let lastGeoAccuracy = null;
let lastGeoTimestamp = null;
let lastGeoLabel = null;
let lastReverseGeocodeAt = 0;
let lastGeoToastAt = 0;
let hasCenteredOnGeo = false;
let geoPermissionDenied = false;

let passengerPickupUpdateInterval = null;
let driverIncomingTripUpdateInterval = null;

let pickupHubSuggestRequestAt = 0;

function setSelectedPickupHub(hub) {
    if (!hub || !hub.id) {
        currentPickupHubId = null;
        return;
    }
    currentPickupHubId = Number(hub.id);
}

function clearSelectedPickupHub() {
    currentPickupHubId = null;
}

function renderPickupHubSuggestions(hubs) {
    const box = document.getElementById('pickup-hubs-suggestions');
    const list = document.getElementById('pickup-hubs-list');
    if (!box || !list) return;

    const rows = Array.isArray(hubs) ? hubs : [];
    if (!rows.length) {
        box.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    list.innerHTML = rows.map((h) => {
        const title = (h.title || '').toString();
        const category = (h.category || '').toString();
        const dist = Number.isFinite(Number(h.distance_km)) ? `${Number(h.distance_km).toFixed(1)} كم` : '';
        const sub = [category, dist].filter(Boolean).join(' • ');
        return `
            <button type="button" data-hub-id="${String(h.id)}" class="w-full text-right px-3 py-2 rounded-xl bg-gray-50 hover:bg-indigo-50 border border-gray-100 hover:border-indigo-100 transition-colors">
                <div class="font-extrabold text-gray-800 text-sm">${escapeHtml(title)}</div>
                ${sub ? `<div class="text-xs font-bold text-gray-500 mt-0.5">${escapeHtml(sub)}</div>` : ''}
            </button>
        `;
    }).join('');

    box.classList.remove('hidden');

    list.querySelectorAll('button[data-hub-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const hubId = Number(btn.getAttribute('data-hub-id'));
            const hub = rows.find((h) => Number(h.id) === hubId);
            if (!hub) return;
            setSelectedPickupHub(hub);
            setPickup({ lat: Number(hub.lat), lng: Number(hub.lng) }, hub.title || 'نقطة تجمع', { keepHub: true });
            showToast('✅ تم اختيار نقطة تجمع');
        });
    });
}

function escapeHtml(str) {
    return String(str || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

async function refreshPickupHubSuggestions() {
    if (currentUserRole !== 'passenger') return;
    if (!currentPickup || !Number.isFinite(currentPickup.lat) || !Number.isFinite(currentPickup.lng)) return;
    if (!window.ApiService || !ApiService.pickupHubs || typeof ApiService.pickupHubs.suggest !== 'function') return;

    const now = Date.now();
    if (now - pickupHubSuggestRequestAt < 1500) return;
    pickupHubSuggestRequestAt = now;

    try {
        const prefEl = document.getElementById('pickup-hub-preference');
        const preference = prefEl && prefEl.value ? String(prefEl.value) : 'clear';
        const resp = await ApiService.pickupHubs.suggest(currentPickup.lat, currentPickup.lng, 6, preference);
        renderPickupHubSuggestions(resp?.data || []);
    } catch (e) {
        // Hide on error
        renderPickupHubSuggestions([]);
    }
}

function formatStreetLabel(label) {
    if (!label) return 'موقع محدد';
    const parts = label.split(',').map(part => part.trim()).filter(Boolean);
    return parts.slice(0, 2).join('، ') || label;
}

function bindStreetLabel(marker, label) {
    if (!marker) return;
    const text = formatStreetLabel(label);
    if (marker.unbindTooltip) marker.unbindTooltip();
    marker.bindTooltip(text, {
        permanent: true,
        direction: 'top',
        offset: [0, -18],
        className: 'map-street-label'
    }).openTooltip();
}

function resetDriverInfoPanel() {
    const infoSection = document.getElementById('driver-info-section');
    const mapSection = document.getElementById('driver-map-section');
    const toggleBtn = document.getElementById('driver-info-toggle');
    if (!infoSection || !mapSection || !toggleBtn) return;

    infoSection.classList.remove('hidden');
    mapSection.classList.remove('driver-map-expanded');
    toggleBtn.textContent = 'إخفاء التفاصيل';
    isDriverInfoCollapsed = false;

    if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 100);
    }
}

function toggleDriverInfoPanel() {
    const infoSection = document.getElementById('driver-info-section');
    const mapSection = document.getElementById('driver-map-section');
    const toggleBtn = document.getElementById('driver-info-toggle');
    if (!infoSection || !mapSection || !toggleBtn) return;

    isDriverInfoCollapsed = !isDriverInfoCollapsed;
    infoSection.classList.toggle('hidden', isDriverInfoCollapsed);
    mapSection.classList.toggle('driver-map-expanded', isDriverInfoCollapsed);
    toggleBtn.textContent = isDriverInfoCollapsed ? 'إظهار التفاصيل' : 'إخفاء التفاصيل';

    if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 100);
    }
}

window.toggleDriverInfoPanel = toggleDriverInfoPanel;

function updateDriverPanelCollapseUI() {
    const collapseBtn = document.getElementById('driver-panel-collapse');
    const expandFloatingBtn = document.getElementById('driver-panel-expand-floating');
    if (collapseBtn) {
        collapseBtn.disabled = isDriverPanelCollapsed;
        collapseBtn.classList.toggle('opacity-50', isDriverPanelCollapsed);
        collapseBtn.classList.toggle('cursor-not-allowed', isDriverPanelCollapsed);
    }
    if (expandFloatingBtn) {
        if (isDriverPanelCollapsed) {
            expandFloatingBtn.classList.remove('hidden');
        } else {
            expandFloatingBtn.classList.add('hidden');
        }
    }
}

function setDriverPanelCollapsed(collapsed) {
    const panelCard = document.getElementById('driver-panel-card');
    if (!panelCard) return;
    isDriverPanelCollapsed = collapsed;
    panelCard.classList.toggle('driver-panel-collapsed', collapsed);
    updateDriverPanelCollapseUI();
    if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 350);
    }
}

window.collapseDriverPanel = function() {
    setDriverPanelCollapsed(true);
};

window.expandDriverPanel = function() {
    setDriverPanelCollapsed(false);
};

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
    
    const alexandriaCenter = [31.2001, 29.9187];
    const egyptCenter = [26.8206, 30.8025];
    const isDriver = currentUserRole === 'driver';
    const initialCenter = alexandriaCenter;
    leafletMap = L.map('leaflet-map', { 
        zoomControl: false,
        attributionControl: true
    }).setView(initialCenter, 12);
    
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

    // Keep Alexandria as the default location for all roles
    setPickup({ lat: alexandriaCenter[0], lng: alexandriaCenter[1] }, 'الإسكندرية، مصر');
    leafletMap.setView(alexandriaCenter, 12);

    // Destination/Pickup select by click
    leafletMap.on('click', e => {
        if (!isPassengerMapSelectionEnabled()) return;
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
        destInput.addEventListener('blur', () => {
            const q = destInput.value.trim();
            if (shouldGeocodeInput(q, currentDestination?.label)) {
                searchDestinationByName(q);
            }
        });
        destInput.addEventListener('change', () => {
            const q = destInput.value.trim();
            if (shouldGeocodeInput(q, currentDestination?.label)) {
                searchDestinationByName(q);
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
        pickupInput.addEventListener('blur', () => {
            const q = pickupInput.value.trim();
            if (shouldGeocodeInput(q, currentPickup?.label)) {
                searchPickupByName(q);
            }
        });
        pickupInput.addEventListener('change', () => {
            const q = pickupInput.value.trim();
            if (shouldGeocodeInput(q, currentPickup?.label)) {
                searchPickupByName(q);
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

function setPickup(coords, label, options = {}) {
    const keepHub = !!options.keepHub;
    if (!keepHub) {
        clearSelectedPickupHub();
    }

    currentPickup = { ...coords, label: label || 'نقطة الالتقاط' };
    if (!leafletMap) return;
    if (pickupMarkerL) pickupMarkerL.remove();
    pickupMarkerL = L.marker([coords.lat, coords.lng], { draggable: true }).addTo(leafletMap);
    pickupMarkerL.bindPopup(currentPickup.label).openPopup();
    bindStreetLabel(pickupMarkerL, currentPickup.label);
    
    // Update current location input
    updateCurrentLocationInput(currentPickup.label);
    
    pickupMarkerL.on('dragend', () => {
        clearSelectedPickupHub();
        const p = pickupMarkerL.getLatLng();
        currentPickup.lat = p.lat;
        currentPickup.lng = p.lng;
        // Reverse geocode to get address
        reverseGeocode(p.lat, p.lng, (address) => {
            currentPickup.label = address;
            pickupMarkerL.setPopupContent(address).openPopup();
            bindStreetLabel(pickupMarkerL, address);
            updateCurrentLocationInput(address);
            showToast('تم تعديل موقع الالتقاط');
            refreshPickupHubSuggestions();
        });
    });

    refreshPickupHubSuggestions();
}

function setDestination(coords, label) {
    if (currentUserRole !== 'passenger') return;
    currentDestination = { ...coords, label: label || 'الوجهة' };
    if (!leafletMap) return;
    if (destMarkerL) destMarkerL.remove();
    destMarkerL = L.marker([coords.lat, coords.lng], { draggable: false, opacity: 0.9 }).addTo(leafletMap);
    destMarkerL.bindPopup(currentDestination.label).openPopup();
    bindStreetLabel(destMarkerL, currentDestination.label);
    document.getElementById('ride-dest-text') && (document.getElementById('ride-dest-text').innerText = currentDestination.label);
    confirmDestination(currentDestination.label);
}

function searchDestinationByName(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=eg&q=${encodeURIComponent(q)}`;
    return fetch(url, { headers: { 'Accept': 'application/json' }})
        .then(r => r.json())
        .then(arr => {
            if (!arr || !arr.length) {
                showToast('لم يتم العثور على نتائج');
                return false;
            }
            const best = arr[0];
            const lat = parseFloat(best.lat), lon = parseFloat(best.lon);
            setDestination({ lat, lng: lon }, best.display_name);
            leafletMap.setView([lat, lon], 15);
            return true;
        })
        .catch(() => {
            showToast('حدث خطأ في البحث');
            return false;
        });
}

function searchPickupByName(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=eg&q=${encodeURIComponent(q)}`;
    return fetch(url, { headers: { 'Accept': 'application/json' }})
        .then(r => r.json())
        .then(arr => {
            if (!arr || !arr.length) {
                showToast('لم يتم العثور على نتائج');
                return false;
            }
            const best = arr[0];
            const lat = parseFloat(best.lat), lon = parseFloat(best.lon);
            setPickup({ lat, lng: lon }, best.display_name);
            leafletMap.setView([lat, lon], 15);
            showToast('تم تحديد موقع الالتقاط');
            return true;
        })
        .catch(() => {
            showToast('حدث خطأ في البحث');
            return false;
        });
}

function shouldGeocodeInput(value, currentLabel) {
    const v = (value || '').trim();
    if (!v || v.length < 3) return false;
    if (!currentLabel) return true;
    return v !== currentLabel.trim();
}

async function ensureDestinationFromInput() {
    const destInput = document.getElementById('dest-input');
    const value = destInput?.value?.trim();
    if (!value || currentDestination) return !!currentDestination;
    return searchDestinationByName(value);
}

async function ensurePickupFromInput() {
    const pickupInput = document.getElementById('current-loc-input');
    const value = pickupInput?.value?.trim();
    if (!value || currentPickup) return !!currentPickup;
    return searchPickupByName(value);
}

function ensurePickupFallback() {
    if (currentPickup) return true;
    if (lastGeoCoords) {
        applyPassengerLocation(lastGeoCoords, true);
        return true;
    }
    if (leafletMap) {
        const center = leafletMap.getCenter();
        setPickup({ lat: center.lat, lng: center.lng }, lastGeoLabel || 'موقعك الحالي');
        return true;
    }
    return false;
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

function isPassengerMapSelectionEnabled() {
    if (currentUserRole !== 'passenger') return false;
    const passengerUI = document.getElementById('passenger-ui-container');
    const driverUI = document.getElementById('driver-ui-container');
    if (!passengerUI || passengerUI.classList.contains('hidden')) return false;
    if (driverUI && !driverUI.classList.contains('hidden')) return false;
    const destinationState = document.getElementById('state-destination');
    const rideSelectState = document.getElementById('state-ride-select');
    const isDestinationVisible = destinationState && !destinationState.classList.contains('hidden');
    const isRideSelectVisible = rideSelectState && !rideSelectState.classList.contains('hidden');
    return isDestinationVisible || isRideSelectVisible;
}

function startMapSelection(mode) {
    if (!isPassengerMapSelectionEnabled()) return;
    mapSelectionMode = mode === 'pickup' ? 'pickup' : 'destination';
    updateMapSelectionButtons();
    if (mapSelectionMode === 'pickup') {
        showToast('اضغط على الخريطة لتحديد موقعك الحالي');
    } else {
        showToast('اضغط على الخريطة لتحديد الوجهة');
    }
}

function canUseGeolocation() {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

function shouldShowGeoToast() {
    const now = Date.now();
    if (now - lastGeoToastAt < 8000) return false;
    lastGeoToastAt = now;
    return true;
}

function applyPassengerLocation(coords, shouldCenter) {
    const label = lastGeoLabel || 'موقعك الحالي';
    setPickup(coords, label);
    if (leafletMap && shouldCenter) {
        leafletMap.setView([coords.lat, coords.lng], Math.max(leafletMap.getZoom(), 14));
    }
}

function applyDriverLocation(coords, shouldCenter) {
    driverLocation = { ...coords };
    ensureDriverMarker(driverLocation);
    if (leafletMap && shouldCenter) {
        leafletMap.setView([coords.lat, coords.lng], Math.max(leafletMap.getZoom(), 14));
    }
    updateDriverLiveLocation(coords);
}

async function updateDriverLiveLocation(coords) {
    if (!currentDriverProfile?.id || !coords) return;
    const now = Date.now();
    const throttleMs = driverTripStarted ? 3000 : 5000;
    if (now - lastDriverLocationUpdateAt < throttleMs) return;
    lastDriverLocationUpdateAt = now;

    try {
        await ApiService.drivers.updateLocation(currentDriverProfile.id, coords.lat, coords.lng);
    } catch (error) {
        console.error('Failed to update driver location:', error);
    }
}

function maybeReverseGeocodePickup(coords) {
    const now = Date.now();
    if (now - lastReverseGeocodeAt < 60000 && lastGeoLabel) return;
    lastReverseGeocodeAt = now;
    reverseGeocode(coords.lat, coords.lng, (address) => {
        lastGeoLabel = address;
        if (currentUserRole === 'passenger') {
            if (currentPickup) {
                currentPickup.label = address;
            }
            if (pickupMarkerL) {
                pickupMarkerL.setPopupContent(address).openPopup();
                bindStreetLabel(pickupMarkerL, address);
            }
            updateCurrentLocationInput(address);
        }
    });
}

function handleGeoSuccess(position) {
    const coords = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
    };
    lastGeoCoords = coords;
    lastGeoAccuracy = Number.isFinite(Number(position?.coords?.accuracy)) ? Number(position.coords.accuracy) : null;
    lastGeoTimestamp = Number.isFinite(Number(position?.timestamp)) ? Number(position.timestamp) : Date.now();
    geoPermissionDenied = false;

    if (currentUserRole === 'passenger') {
        applyPassengerLocation(coords, !hasCenteredOnGeo);
        maybeReverseGeocodePickup(coords);
    } else if (currentUserRole === 'driver') {
        applyDriverLocation(coords, !hasCenteredOnGeo);
        updateDriverRealTripProgress(coords);
        updateDriverActiveRouteFromGps(coords);
    }

    if (!hasCenteredOnGeo) {
        hasCenteredOnGeo = true;
    }
}

function getHighAccuracyPickupFix() {
    return new Promise((resolve, reject) => {
        if (!canUseGeolocation()) {
            reject(new Error('Geolocation not available'));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = Number(position?.coords?.latitude);
                const lng = Number(position?.coords?.longitude);
                const accuracy = Number.isFinite(Number(position?.coords?.accuracy)) ? Number(position.coords.accuracy) : null;
                const timestamp = Number.isFinite(Number(position?.timestamp)) ? Number(position.timestamp) : Date.now();
                resolve({ lat, lng, accuracy, timestamp });
            },
            (err) => reject(err || new Error('Failed to get location')),
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 15000
            }
        );
    });
}

function stopPassengerPickupLiveUpdates() {
    if (passengerPickupUpdateInterval) {
        clearInterval(passengerPickupUpdateInterval);
        passengerPickupUpdateInterval = null;
    }
}

function startPassengerPickupLiveUpdates(tripId) {
    stopPassengerPickupLiveUpdates();
    if (!tripId) return;

    let lastSent = null;
    passengerPickupUpdateInterval = setInterval(async () => {
        if (!activePassengerTripId || String(activePassengerTripId) !== String(tripId)) return;
        if (!lastGeoCoords || !Number.isFinite(Number(lastGeoCoords.lat)) || !Number.isFinite(Number(lastGeoCoords.lng))) return;

        const payload = {
            pickup_lat: Number(lastGeoCoords.lat),
            pickup_lng: Number(lastGeoCoords.lng),
            pickup_accuracy: Number.isFinite(Number(lastGeoAccuracy)) ? Number(lastGeoAccuracy) : null,
            pickup_timestamp: Number.isFinite(Number(lastGeoTimestamp)) ? Number(lastGeoTimestamp) : Date.now(),
            source: 'passenger_gps_watch'
        };

        const sameAsLast = lastSent &&
            Math.abs(lastSent.pickup_lat - payload.pickup_lat) < 0.000001 &&
            Math.abs(lastSent.pickup_lng - payload.pickup_lng) < 0.000001;

        if (sameAsLast) return;
        lastSent = { pickup_lat: payload.pickup_lat, pickup_lng: payload.pickup_lng };

        console.log('📡 Rider pickup live update (before send):', payload);
        try {
            await ApiService.trips.updatePickupLocation(tripId, payload);
        } catch (error) {
            console.warn('⚠️ Failed to send pickup live update:', error?.message || error);
        }
    }, 5000);
}

function getDriverActiveTargetCoords() {
    if (!currentIncomingTrip) return null;

    if (driverTripStarted) {
        const dropoffLat = currentIncomingTrip.dropoff_lat;
        const dropoffLng = currentIncomingTrip.dropoff_lng;
        const lat = dropoffLat !== undefined && dropoffLat !== null ? Number(dropoffLat) : null;
        const lng = dropoffLng !== undefined && dropoffLng !== null ? Number(dropoffLng) : null;
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    if (passengerPickup?.lat && passengerPickup?.lng) {
        return { lat: Number(passengerPickup.lat), lng: Number(passengerPickup.lng) };
    }

    const pickupLat = currentIncomingTrip.pickup_lat;
    const pickupLng = currentIncomingTrip.pickup_lng;
    const lat = pickupLat !== undefined && pickupLat !== null ? Number(pickupLat) : null;
    const lng = pickupLng !== undefined && pickupLng !== null ? Number(pickupLng) : null;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function updateDriverActiveRouteFromGps(coords) {
    if (currentUserRole !== 'driver') return;
    if (!routePolyline) return;
    if (!coords) return;

    const target = getDriverActiveTargetCoords();
    if (!target) return;

    routePolyline.setLatLngs([
        [coords.lat, coords.lng],
        [target.lat, target.lng]
    ]);
}

function updateDriverRealTripProgress(coords) {
    if (currentUserRole !== 'driver') return;
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;
    if (!activeDriverTripId) return;

    // Arrive to passenger pickup
    if (!driverTripStarted && !driverStartReady) {
        const pickup = passengerPickup || (currentIncomingTrip ? {
            lat: Number(currentIncomingTrip.pickup_lat),
            lng: Number(currentIncomingTrip.pickup_lng)
        } : null);
        if (pickup && Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng)) {
            const distToPickup = calculateDistance(coords.lat, coords.lng, pickup.lat, pickup.lng);
            if (distToPickup <= 80) {
                setDriverStartReady(true);
                showToast('✅ وصلت إلى موقع الراكب');
            }
        }
    }

    // Arrive to destination
    if (driverTripStarted && !driverAwaitingPayment) {
        const dest = currentIncomingTrip ? {
            lat: Number(currentIncomingTrip.dropoff_lat),
            lng: Number(currentIncomingTrip.dropoff_lng)
        } : null;
        if (dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lng)) {
            const distToDest = calculateDistance(coords.lat, coords.lng, dest.lat, dest.lng);
            if (distToDest <= 90) {
                setDriverAwaitingPayment(true);
                showToast('✅ وصلت إلى الوجهة - في انتظار الدفع');
            }
        }
    }
}

function handleGeoError(error) {
    if (error && error.code === 1) {
        geoPermissionDenied = true;
    }

    if (shouldShowGeoToast()) {
        showToast('⚠️ يرجى تفعيل الموقع لاستخدام الخريطة بدقة');
    }

    if (!lastGeoCoords) {
        const alexandriaCenter = { lat: 31.2001, lng: 29.9187 };
        if (currentUserRole === 'passenger') {
            applyPassengerLocation(alexandriaCenter, true);
        } else if (currentUserRole === 'driver') {
            applyDriverLocation(alexandriaCenter, true);
        }
    }
}

function startLocationTracking() {
    if (!canUseGeolocation()) {
        handleGeoError();
        return;
    }

    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }

    hasCenteredOnGeo = false;

    locationWatchId = navigator.geolocation.watchPosition(
        handleGeoSuccess,
        handleGeoError,
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 15000
        }
    );
}

function stopLocationTracking() {
    if (locationWatchId !== null && canUseGeolocation()) {
        navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
}

function requestSingleLocationFix() {
    if (lastGeoCoords) {
        if (currentUserRole === 'passenger') {
            applyPassengerLocation(lastGeoCoords, true);
        } else if (currentUserRole === 'driver') {
            applyDriverLocation(lastGeoCoords, true);
        }
        return;
    }
    if (!canUseGeolocation()) {
        handleGeoError();
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (position) => {
            hasCenteredOnGeo = false;
            handleGeoSuccess(position);
        },
        handleGeoError,
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 15000
        }
    );
}

function useCurrentLocation() {
    startLocationTracking();
    requestSingleLocationFix();
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
    
    if (!driverLocation || !Number.isFinite(driverLocation.lat) || !Number.isFinite(driverLocation.lng)) {
        // Initial driver location: offset from pickup when no live location is available
        const offsetLat = 0.04; // ~4km for realistic timing
        const offsetLng = 0.04;
        driverLocation = {
            lat: currentPickup.lat + offsetLat,
            lng: currentPickup.lng + offsetLng
        };
    }
    
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

function stopPassengerLiveTripTracking() {
    if (passengerLiveTrackingInterval) {
        clearInterval(passengerLiveTrackingInterval);
        passengerLiveTrackingInterval = null;
    }
    passengerLiveTrackingTripId = null;
    passengerLiveTrackingDriverId = null;
    passengerLastTripStatus = null;
    passengerArrivalToastShown = false;
    passengerOngoingToastShown = false;
}

function preparePassengerDriverMapView() {
    if (!leafletMap) return;

    const mapWorld = document.getElementById('map-world');
    if (mapWorld) mapWorld.style.display = 'none';

    const leafletMapEl = document.getElementById('leaflet-map');
    const driverMapView = document.getElementById('driver-map-view');
    if (leafletMapEl && driverMapView) {
        driverMapView.appendChild(leafletMapEl);
        leafletMapEl.style.display = 'block';
        leafletMapEl.style.position = 'absolute';
        leafletMapEl.style.inset = '0';
        leafletMapEl.style.zIndex = '1';
        leafletMapEl.style.width = '100%';
        leafletMapEl.style.height = '100%';
    }

    setTimeout(() => {
        if (leafletMap) leafletMap.invalidateSize();
    }, 100);
}

function ensurePassengerDriverMarker(location) {
    if (!leafletMap || !location) return;
    const carIcon = L.divIcon({
        className: 'driver-car-marker',
        html: '<div style="font-size: 32px; transform: rotate(0deg);"><i class="fas fa-car" style="color: #4f46e5;"></i></div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    if (driverMarkerL) {
        driverMarkerL.setLatLng([location.lat, location.lng]);
        return;
    }

    driverMarkerL = L.marker([location.lat, location.lng], { icon: carIcon }).addTo(leafletMap);
    driverMarkerL.bindPopup('🚗 الكابتن').openPopup();
}

function updatePassengerDriverRoute(driverCoords, targetCoords) {
    if (!leafletMap || !driverCoords || !targetCoords) return;
    const linePoints = [
        [driverCoords.lat, driverCoords.lng],
        [targetCoords.lat, targetCoords.lng]
    ];

    if (!routePolyline) {
        routePolyline = L.polyline(linePoints, { color: '#4f46e5', weight: 4, opacity: 0.75, dashArray: '10, 10' }).addTo(leafletMap);
        const bounds = L.latLngBounds(linePoints);
        leafletMap.fitBounds(bounds, { padding: [50, 50] });
        return;
    }

    routePolyline.setLatLngs(linePoints);
}

function updateDriverDistance(distanceMeters) {
    const el = document.getElementById('driver-distance');
    if (!el) return;
    const meters = Number(distanceMeters);
    if (!Number.isFinite(meters) || meters < 0) {
        el.innerText = 'على بُعد -- متر';
        return;
    }
    if (meters >= 1000) {
        el.innerText = `على بُعد ${(meters / 1000).toFixed(1)} كم`;
        return;
    }
    el.innerText = `على بُعد ${Math.round(meters)} متر`;
}

function updatePassengerEtaUI(seconds, target = 'pickup') {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (target === 'ride') {
        const rideEtaEl = document.getElementById('ride-eta-display');
        if (rideEtaEl) {
            const mins = Math.max(1, Math.round(s / 60));
            rideEtaEl.innerText = `${mins} دقيقة`;
        }
        return;
    }
    const etaEl = document.getElementById('eta-display');
    if (etaEl) etaEl.innerText = formatETA(s);
}

async function refreshPassengerLiveTripTracking() {
    const tripId = passengerLiveTrackingTripId;
    if (!tripId) return;

    try {
        const response = await ApiService.trips.getLive(tripId);
        const trip = response?.data || null;
        if (!trip) return;

        if (trip.status === 'cancelled') {
            stopPassengerLiveTripTracking();
            showToast('تم إلغاء الرحلة');
            resetApp();
            return;
        }

        if (trip.status === 'completed') {
            stopPassengerLiveTripTracking();
            showToast('✅ تم إنهاء الرحلة');
            showPassengerTripSummaryAndRating(String(tripId), {
                distance: trip.distance,
                duration: trip.duration,
                price: trip.cost
            });
            return;
        }

        const driverId = trip.driver_id || passengerLiveTrackingDriverId;
        passengerLiveTrackingDriverId = driverId;

        // Keep ETA meta (driver-updated) in sync with polling snapshot
        if (trip.eta_minutes !== undefined || trip.eta_reason !== undefined || trip.eta_updated_at !== undefined) {
            setTripEtaCache(tripId, trip.eta_minutes, trip.eta_reason, trip.eta_updated_at);
            renderPassengerEtaMeta();
        }

        // Update UI labels
        const driverName = trip.driver_name || trip.driver_live_name || 'الكابتن';
        const driverLabelText = document.getElementById('driver-label-text');
        if (driverLabelText) {
            if (trip.status === 'ongoing') {
                driverLabelText.innerText = `${driverName} في الطريق إلى الوجهة`;
            } else {
                driverLabelText.innerText = `${driverName} قادم إليك`;
            }
        }

        // Resolve coordinates
        const driverLat = trip.driver_last_lat !== null && trip.driver_last_lat !== undefined ? Number(trip.driver_last_lat) : null;
        const driverLng = trip.driver_last_lng !== null && trip.driver_last_lng !== undefined ? Number(trip.driver_last_lng) : null;
        const hasDriverCoords = Number.isFinite(driverLat) && Number.isFinite(driverLng);

        const pickupLat = trip.pickup_lat !== null && trip.pickup_lat !== undefined ? Number(trip.pickup_lat) : (currentPickup ? Number(currentPickup.lat) : null);
        const pickupLng = trip.pickup_lng !== null && trip.pickup_lng !== undefined ? Number(trip.pickup_lng) : (currentPickup ? Number(currentPickup.lng) : null);
        const dropoffLat = trip.dropoff_lat !== null && trip.dropoff_lat !== undefined ? Number(trip.dropoff_lat) : (currentDestination ? Number(currentDestination.lat) : null);
        const dropoffLng = trip.dropoff_lng !== null && trip.dropoff_lng !== undefined ? Number(trip.dropoff_lng) : (currentDestination ? Number(currentDestination.lng) : null);

        const targetCoords = trip.status === 'ongoing'
            ? (Number.isFinite(dropoffLat) && Number.isFinite(dropoffLng) ? { lat: dropoffLat, lng: dropoffLng } : null)
            : (Number.isFinite(pickupLat) && Number.isFinite(pickupLng) ? { lat: pickupLat, lng: pickupLng } : null);

        // Enter correct passenger state
        if (passengerLastTripStatus !== trip.status) {
            passengerLastTripStatus = trip.status;
            if (trip.status === 'assigned') {
                switchSection('driver');
                preparePassengerDriverMapView();
                // Show pickup handshake code for the driver
                try { window.refreshPickupHandshake(); } catch (e) {}
            }
            if (trip.status === 'ongoing') {
                if (!passengerOngoingToastShown) {
                    passengerOngoingToastShown = true;
                    showToast('🚗 بدأت الرحلة');
                }
                switchSection('in-ride');
                // Hide handshake card once ride starts
                try {
                    const card = document.getElementById('passenger-pickup-handshake-card');
                    if (card) card.classList.add('hidden');
                } catch (e) {}
                const destTextEl = document.getElementById('ride-dest-text');
                if (destTextEl) destTextEl.innerText = trip.dropoff_location || currentDestination?.label || 'الوجهة';
            }
        }

        if (!hasDriverCoords || !targetCoords) {
            return;
        }

        // Update map marker + route (assigned + ongoing)
        const newDriverCoords = { lat: driverLat, lng: driverLng };
        driverLocation = { ...newDriverCoords };

        preparePassengerDriverMapView();
        ensurePassengerDriverMarker(newDriverCoords);
        updatePassengerDriverRoute(newDriverCoords, targetCoords);

        // Center once when trip starts (ongoing)
        if (trip.status === 'ongoing' && !passengerTripCenteredOnce && leafletMap) {
            try {
                const bounds = L.latLngBounds([
                    [newDriverCoords.lat, newDriverCoords.lng],
                    [targetCoords.lat, targetCoords.lng]
                ]);
                leafletMap.fitBounds(bounds, { padding: [50, 50] });
                passengerTripCenteredOnce = true;
            } catch (e) {
                // ignore
            }
        }

        // Update distance + ETA
        const distanceMeters = calculateDistance(newDriverCoords.lat, newDriverCoords.lng, targetCoords.lat, targetCoords.lng);
        updateDriverDistance(distanceMeters);

        // Rough ETA based on live distance
        const speedMps = trip.status === 'ongoing' ? 10 : 9; // ~32-36 km/h
        const etaSecondsLive = Math.round(distanceMeters / speedMps);
        if (trip.status === 'ongoing') {
            updatePassengerEtaUI(etaSecondsLive, 'ride');
        } else {
            updatePassengerEtaUI(etaSecondsLive, 'pickup');
        }

        // Arrival toast near pickup
        if (trip.status !== 'ongoing' && !passengerArrivalToastShown && distanceMeters <= 80) {
            passengerArrivalToastShown = true;
            showToast('🎉 الكابتن وصل قريب منك');
        }
    } catch (error) {
        console.error('Failed to refresh live trip tracking:', error);
    }
}

function startPassengerLiveTripTracking(tripId, driverId) {
    if (!tripId) return;
    stopPassengerLiveTripTracking();
    passengerLiveTrackingTripId = tripId;
    passengerLiveTrackingDriverId = driverId || null;
    passengerLastTripStatus = null;
    passengerArrivalToastShown = false;
    passengerOngoingToastShown = false;

    refreshPassengerLiveTripTracking();
    const intervalMs = realtimeSocket && realtimeConnected ? 9000 : 3000;
    passengerLiveTrackingInterval = setInterval(refreshPassengerLiveTripTracking, intervalMs);
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
    if (driverToDestinationAnim) {
        cancelAnimationFrame(driverToDestinationAnim);
        driverToDestinationAnim = null;
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
    return { lat: 31.2001, lng: 29.9187 };
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

window.focusCaptainOnMap = function() {
    if (!leafletMap) {
        initLeafletMap();
    }
    moveLeafletMapToContainer('map-container');

    const mapWorld = document.getElementById('map-world');
    if (mapWorld) mapWorld.style.display = 'none';

    const baseLocation = driverLocation || currentPickup || getDriverBaseLocation();
    if (!baseLocation) {
        showToast('لا يوجد موقع للكابتن حالياً');
        return;
    }

    ensureDriverMarker(baseLocation);

    if (leafletMap) {
        const points = [baseLocation];
        if (currentDestination) {
            points.push(currentDestination);
        }
        if (points.length > 1) {
            const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
            leafletMap.fitBounds(bounds, { padding: [50, 50] });
        } else {
            leafletMap.setView([baseLocation.lat, baseLocation.lng], Math.max(leafletMap.getZoom(), 14));
        }
    }

    showToast('📍 تم عرض الكابتن على الخريطة');
};

function setPassengerPickup(coords, label) {
    passengerPickup = { ...coords, label: label || 'موقع الراكب' };
    console.log('📌 Driver rendering pickup marker from coords:', {
        pickup_lat: Number(coords?.lat),
        pickup_lng: Number(coords?.lng),
        label: passengerPickup.label,
        request_id: currentIncomingTrip?.request_id || null,
        trip_id: currentIncomingTrip?.trip_id || currentIncomingTrip?.id || null
    });
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
    bindStreetLabel(passengerMarkerL, passengerPickup.label);
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

    // Real mode: do not animate marker; it moves with GPS updates.
}

function startDriverToDestinationRoute() {
    if (!leafletMap || !currentIncomingTrip) return;
    const dropoffLat = currentIncomingTrip.dropoff_lat;
    const dropoffLng = currentIncomingTrip.dropoff_lng;
    if (dropoffLat === undefined || dropoffLat === null || dropoffLng === undefined || dropoffLng === null) {
        return;
    }

    moveLeafletMapToContainer('map-container');
    if (routePolyline) {
        routePolyline.remove();
        routePolyline = null;
    }

    const start = driverLocation || getDriverBaseLocation();
    ensureDriverMarker(start);

    const target = { lat: Number(dropoffLat), lng: Number(dropoffLng) };
    routePolyline = L.polyline([
        [start.lat, start.lng],
        [target.lat, target.lng]
    ], { color: '#2563eb', weight: 4, opacity: 0.8, dashArray: '8, 6' }).addTo(leafletMap);

    const bounds = L.latLngBounds([
        [start.lat, start.lng],
        [target.lat, target.lng]
    ]);
    leafletMap.fitBounds(bounds, { padding: [50, 50] });

    // Real mode: do not animate marker; it moves with GPS updates.
}

function animateDriverToDestination(start, target) {
    if (!driverMarkerL) return;
    if (driverToDestinationAnim) {
        cancelAnimationFrame(driverToDestinationAnim);
        driverToDestinationAnim = null;
    }

    const distanceMeters = calculateDistance(start.lat, start.lng, target.lat, target.lng);
    const speedMps = 11; // ~40 km/h
    const duration = Math.max(25000, Math.min(220000, Math.round(distanceMeters / speedMps) * 1000));
    const startTime = Date.now();

    function moveStep() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

        const currentLat = start.lat + (target.lat - start.lat) * eased;
        const currentLng = start.lng + (target.lng - start.lng) * eased;
        driverLocation = { lat: currentLat, lng: currentLng };

        driverMarkerL.setLatLng([currentLat, currentLng]);
        if (routePolyline) {
            routePolyline.setLatLngs([
                [currentLat, currentLng],
                [target.lat, target.lng]
            ]);
        }

        const bearing = calculateBearing(currentLat, currentLng, target.lat, target.lng);
        const carEl = driverMarkerL.getElement();
        if (carEl) {
            const iconDiv = carEl.querySelector('div');
            if (iconDiv) iconDiv.style.transform = `rotate(${bearing}deg)`;
        }

        if (progress < 1) {
            driverToDestinationAnim = requestAnimationFrame(moveStep);
        } else {
            driverToDestinationAnim = null;
            showToast('✅ وصلت إلى الوجهة - في انتظار الدفع');
            setDriverAwaitingPayment(true);
        }
    }

    driverToDestinationAnim = requestAnimationFrame(moveStep);
}

function startPassengerToDestinationRoute() {
    if (!leafletMap || !currentDestination) return;

    if (passengerToDestinationAnim) {
        cancelAnimationFrame(passengerToDestinationAnim);
        passengerToDestinationAnim = null;
    }

    if (routePolyline) {
        routePolyline.remove();
        routePolyline = null;
    }

    const start = driverLocation || currentPickup || getDriverBaseLocation();
    const target = { lat: Number(currentDestination.lat), lng: Number(currentDestination.lng) };

    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return;

    ensureDriverMarker(start);

    routePolyline = L.polyline(
        [
            [start.lat, start.lng],
            [target.lat, target.lng]
        ],
        { color: '#f59e0b', weight: 4, opacity: 0.85, dashArray: '6, 6' }
    ).addTo(leafletMap);

    const bounds = L.latLngBounds([
        [start.lat, start.lng],
        [target.lat, target.lng]
    ]);
    leafletMap.fitBounds(bounds, { padding: [50, 50] });

    animatePassengerToDestination(start, target);
}

function animatePassengerToDestination(start, target) {
    if (!driverMarkerL) return;
    if (passengerToDestinationAnim) {
        cancelAnimationFrame(passengerToDestinationAnim);
        passengerToDestinationAnim = null;
    }

    const distanceMeters = calculateDistance(start.lat, start.lng, target.lat, target.lng);
    const speedMps = 11; // ~40 km/h
    const duration = Math.max(25000, Math.min(220000, Math.round(distanceMeters / speedMps) * 1000));
    const startTime = Date.now();

    function moveStep() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

        const currentLat = start.lat + (target.lat - start.lat) * eased;
        const currentLng = start.lng + (target.lng - start.lng) * eased;
        driverLocation = { lat: currentLat, lng: currentLng };

        driverMarkerL.setLatLng([currentLat, currentLng]);
        if (routePolyline) {
            routePolyline.setLatLngs([
                [currentLat, currentLng],
                [target.lat, target.lng]
            ]);
        }

        const bearing = calculateBearing(currentLat, currentLng, target.lat, target.lng);
        const carEl = driverMarkerL.getElement();
        if (carEl) {
            const iconDiv = carEl.querySelector('div');
            if (iconDiv) iconDiv.style.transform = `rotate(${bearing}deg)`;
        }

        if (progress < 1) {
            passengerToDestinationAnim = requestAnimationFrame(moveStep);
        } else {
            passengerToDestinationAnim = null;
            showToast('✅ وصلت إلى الوجهة - يمكنك إنهاء الرحلة');
        }
    }

    passengerToDestinationAnim = requestAnimationFrame(moveStep);
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
            setDriverStartReady(true);
            setDriverPanelVisible(true);
            setDriverPanelCollapsed(false);
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

    if (activePassengerTripId) {
        ApiService.trips.updateStatus(activePassengerTripId, 'ongoing').catch(error => {
            console.error('Failed to mark trip ongoing:', error);
        });
    }
    passengerTripStartedAt = Date.now();

    startPassengerToDestinationRoute();
    
    const estimateMinutes = lastTripEstimate?.etaMin || 10;
    const tripDurationSeconds = Math.max(60, Math.round(estimateMinutes * 60));
    let remainingSeconds = tripDurationSeconds;
    
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
            showToast('✅ وصلت للوجهة - اضغط إنهاء الرحلة');
        }
    }, 1000);
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
    stopPassengerLiveTripTracking();
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
            createdAt: apiTrip.created_at || null,
            startedAt: apiTrip.started_at || null,
            completedAt: apiTrip.completed_at || null,
            pickup: apiTrip.pickup_location,
            dropoff: apiTrip.dropoff_location,
            cost: Number(apiTrip.cost || 0),
            distance: Number(apiTrip.distance || 0),
            duration: Number(apiTrip.duration || 0),
            status: apiTrip.status,
            car: apiTrip.car_type || 'economy',
            driver: apiTrip.driver_name || 'غير محدد',
            passenger: passengerName || 'غير محدد',
            paymentMethod: apiTrip.payment_method || 'cash',
            rating: apiTrip.passenger_rating || apiTrip.rating || 0,
            passengerRating: apiTrip.passenger_rating || apiTrip.rating || 0,
            driverRating: apiTrip.driver_rating || 0,
            passengerReview: apiTrip.passenger_review || apiTrip.review || '',
            driverReview: apiTrip.driver_review || ''
        };
    },

    async fetchTrips({ userId, role } = {}) {
        try {
            let url = '/api/trips?';
            if (role === 'passenger' && userId) {
                url = `/api/rider/trips?rider_id=${encodeURIComponent(String(userId))}`;
            } else if (role === 'driver') {
                const driverId = currentDriverProfile?.id;
                if (driverId) {
                    url = `/api/driver/trips?driver_id=${encodeURIComponent(String(driverId))}`;
                }
            } else {
                const params = new URLSearchParams();
                params.set('limit', '200');
                params.set('source', 'passenger_app');
                url = `/api/trips?${params.toString()}`;
            }

            const response = await fetch(url);
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Failed to fetch trips');
            }

            const tripsData = result.data || [];

            const user = this.getUser();
            const passengerName = user?.name;
            const mapped = tripsData.map(trip => this.normalizeTrip(trip, passengerName));
            this.setTrips(mapped);
            return mapped;
        } catch (error) {
            console.error('Failed to fetch trips:', error);
            this.setTrips([]);
            return [];
        }
    },

    addTrip(trip) {
        const trips = this.getTrips();
        trips.unshift(trip);
        SafeStorage.setItem(this.keyTrips, JSON.stringify(trips));
    },

    upsertTrip(trip) {
        if (!trip || !trip.id) return;
        const trips = this.getTrips();
        const index = trips.findIndex(item => item.id === trip.id);
        if (index >= 0) {
            trips[index] = { ...trips[index], ...trip };
        } else {
            trips.unshift(trip);
        }
        this.setTrips(trips);
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

function updatePhoneCountryUI() {
    const select = document.getElementById('phone-country');
    const dial = document.getElementById('phone-dial-code');
    const flag = document.getElementById('phone-flag');
    if (!select || !dial || !flag) return;
    const option = select.options[select.selectedIndex];
    const dialCode = (option && option.dataset && option.dataset.dial) ? option.dataset.dial : '+966';
    const flagCode = (option && option.dataset && option.dataset.flag) ? option.dataset.flag : 'sa';

    dial.textContent = dialCode;
    flag.src = `https://flagcdn.com/w20/${flagCode}.png`;
    flag.alt = flagCode.toUpperCase();
}

function getSelectedDialCode() {
    const select = document.getElementById('phone-country');
    if (!select) return '+966';
    const option = select.options[select.selectedIndex];
    return (option && option.dataset && option.dataset.dial) ? option.dataset.dial : '+966';
}


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
    const countrySelect = document.getElementById('phone-country');
    if (countrySelect) {
        countrySelect.value = 'sa';
        updatePhoneCountryUI();
    }
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

        if (result.token) {
            window.Auth.setToken(result.token);
        }
        
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
    const phoneRaw = document.getElementById('phone-input').value;
    const phoneDigits = phoneRaw.replace(/\D/g, '');
    if (!phoneDigits || phoneDigits.length < 9) {
        showToast('يرجى إدخال رقم هاتف صحيح');
        return;
    }

    const dialCode = getSelectedDialCode();
    const displayPhone = `${dialCode} ${phoneDigits}`;

    const btn = document.getElementById('send-otp-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري الإرسال...';
    btn.disabled = true;

    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
        
        document.getElementById('auth-phone-form').classList.add('hidden');
        document.getElementById('auth-otp-section').classList.remove('hidden');
        document.getElementById('otp-phone-display').innerText = displayPhone;
        
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
        const dialCode = getSelectedDialCode();
        const fullPhone = phoneDigits ? `${dialCode}${phoneDigits}` : phoneRaw;
        const emailFallback = phoneDigits ? `passenger_${phoneDigits}@ubar.sa` : `passenger_${Date.now()}@ubar.sa`;
        const payload = {
            phone: fullPhone,
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

        if (result.token) {
            window.Auth.setToken(result.token);
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

        if (result.token) {
            window.Auth.setToken(result.token);
        }

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

let lastOauthPopup = null;

function getApiOriginForOAuth() {
    try {
        const host = window.location.hostname;
        const proto = window.location.protocol;
        const isLocal = host === 'localhost' || proto === 'file:' || !host;
        return isLocal ? 'http://localhost:3000' : '';
    } catch (e) {
        return '';
    }
}

function buildOAuthApiUrl(path) {
    const origin = getApiOriginForOAuth();
    return `${origin}${path}`;
}

function openOauthPopup(url) {
    try {
        const w = 520;
        const h = 720;
        const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
        const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
        const features = `popup=yes,width=${w},height=${h},left=${left},top=${top}`;
        lastOauthPopup = window.open(url, 'oauth_popup', features);
        if (!lastOauthPopup) {
            const join = String(url).includes('?') ? '&' : '?';
            window.location.href = `${url}${join}flow=redirect`;
        }
        return lastOauthPopup;
    } catch (e) {
        const join = String(url).includes('?') ? '&' : '?';
        window.location.href = `${url}${join}flow=redirect`;
        return null;
    }
}

function writePopupMessage(popup, title, body) {
    if (!popup) return;
    try {
        const doc = popup.document;
        doc.open();
        doc.write(`<!doctype html>
<html lang="ar">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${String(title || 'OAuth')}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 16px; direction: rtl;">
    <h3 style="margin: 0 0 8px;">${String(title || '')}</h3>
    <p style="margin: 0; white-space: pre-wrap;">${String(body || '')}</p>
  </body>
</html>`);
        doc.close();
    } catch (e) {
        // ignore
    }
}

window.oauthLogin = function(provider) {
    const p = String(provider || '').toLowerCase();
    if (!p) return;
    showToast('⏳ جاري فتح تسجيل OAuth...');

    // IMPORTANT: open popup synchronously (before any await) to avoid popup blockers.
    // We start with a blank window, then navigate after we confirm configuration.
    const popup = openOauthPopup('about:blank');
    if (popup) writePopupMessage(popup, 'تسجيل الدخول', '⏳ جاري تجهيز تسجيل OAuth...');

    const loginUrl = buildOAuthApiUrl(`/api/oauth/${encodeURIComponent(p)}/login`);
    const statusUrl = buildOAuthApiUrl(`/api/oauth/${encodeURIComponent(p)}/status`);

    (async () => {
        try {
            const statusRes = await fetch(statusUrl, { method: 'GET' });
            const statusData = await statusRes.json().catch(() => ({}));

            if (!statusRes.ok || !statusData.success) {
                if (popup) writePopupMessage(popup, 'فشل OAuth', '❌ تعذر التحقق من إعدادات OAuth.');
                return;
            }

            if (!statusData.configured) {
                const missing = Array.isArray(statusData.missing) ? statusData.missing : [];
                const msg = missing.length ? `⚠️ OAuth غير مُعد:\n${missing.join('\n')}` : '⚠️ OAuth غير مُعد';
                showToast(missing.length ? `⚠️ OAuth غير مُعد: ${missing.join(' , ')}` : '⚠️ OAuth غير مُعد', 7000);
                if (popup) writePopupMessage(popup, 'OAuth غير مُعد', msg);
                return;
            }

            // Navigate to provider login (popup flow).
            if (popup && !popup.closed) {
                popup.location.href = loginUrl;
                return;
            }

            // Popup blocked or closed: fallback to redirect flow.
            const join = String(loginUrl).includes('?') ? '&' : '?';
            window.location.href = `${loginUrl}${join}flow=redirect`;
        } catch (e) {
            if (popup) writePopupMessage(popup, 'فشل OAuth', '❌ حدث خطأ أثناء بدء OAuth.');
        }
    })();
};

window.oauthLink = async function(provider) {
    const p = String(provider || '').toLowerCase();
    if (!p) return;
    const token = window.Auth.getToken();
    if (!token) {
        showToast('⚠️ سجّل دخولك أولاً');
        return;
    }
    try {
        const linkUrl = buildOAuthApiUrl(`/api/oauth/${encodeURIComponent(p)}/link`);
        const res = await fetch(linkUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.url) {
            showToast('❌ تعذر بدء الربط');
            return;
        }
        showToast('⏳ جاري فتح صفحة الربط...');
        openOauthPopup(data.url);
    } catch (e) {
        showToast('❌ تعذر بدء الربط');
    }
};

window.addEventListener('message', (event) => {
    const msg = event?.data;
    if (!msg || msg.type !== 'oauth_result') return;

    const payload = msg.payload || null;
    if (!payload || !payload.success) {
        const provider = payload?.provider ? String(payload.provider) : '';
        const err = payload?.error ? String(payload.error) : '';
        const label = provider ? ` (${provider})` : '';
        showToast(`❌ فشل OAuth${label}${err ? `: ${err}` : ''}`);
        return;
    }

    const token = payload.token;
    const user = payload.data;
    if (!token || !user) {
        showToast('❌ OAuth: بيانات ناقصة');
        return;
    }

    window.Auth.setToken(token);
    DB.currentUser = user;
    DB.setUser(user);
    DB.saveSession();
    showToast('✅ تم تسجيل الدخول عبر OAuth');
    try { if (lastOauthPopup && !lastOauthPopup.closed) lastOauthPopup.close(); } catch (e) {}

    if (String(user.role || '').toLowerCase() === 'passenger') {
        loginSuccess();
    } else {
        // Keep current behavior: only passenger OAuth is supported
        showToast('⚠️ OAuth للراكب فقط');
    }
});

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

    // Enable price lock button + apply lock price if any
    refreshRideSelectPriceUI();
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

function setPassengerPanelHidden(hidden) {
    const panel = document.getElementById('main-panel');
    const toggleBtn = document.getElementById('passenger-panel-toggle');
    const toggleText = document.getElementById('passenger-panel-toggle-text');
    const toggleIcon = document.getElementById('passenger-panel-toggle-icon');

    if (!panel || !toggleBtn) return;

    isPassengerPanelHidden = hidden;
    panel.classList.toggle('hidden', hidden);
    panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    toggleBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false');

    if (toggleText) {
        toggleText.innerText = hidden ? 'إظهار خيارات الرحلة' : 'إخفاء خيارات الرحلة';
    }
    if (toggleIcon) {
        toggleIcon.classList.toggle('fa-chevron-down', hidden);
        toggleIcon.classList.toggle('fa-chevron-up', !hidden);
    }
}

window.togglePassengerPanel = function() {
    setPassengerPanelHidden(!isPassengerPanelHidden);
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
    
    stopPassengerMatchPolling();
    stopDriverTracking();
    stopDriverTrackingLive();
    if (passengerToDestinationAnim) {
        cancelAnimationFrame(passengerToDestinationAnim);
        passengerToDestinationAnim = null;
    }
    if (routePolyline) {
        routePolyline.remove();
        routePolyline = null;
    }
    driverLocation = null;
    nearestDriverPreview = null;
    passengerTripStartedAt = null;
    
    // Reset payment
    selectedPaymentMethod = null;
    appliedPromo = null;
    promoDiscount = 0;

    // Reset passenger feature selections
    activePriceLock = null;
    try {
        const statusEl = document.getElementById('price-lock-status');
        if (statusEl) statusEl.textContent = '';
        const familySelect = document.getElementById('ride-family-member');
        if (familySelect) familySelect.value = '';
        const noteTpl = document.getElementById('ride-note-template');
        if (noteTpl) noteTpl.value = '';
        const noteCustom = document.getElementById('ride-note-custom');
        if (noteCustom) noteCustom.value = '';
        const stopsList = document.getElementById('ride-stops-list');
        if (stopsList) stopsList.innerHTML = '';
        const splitCheck = document.getElementById('split-fare-check');
        if (splitCheck) splitCheck.checked = false;
        const splitWrap = document.getElementById('split-fare-wrap');
        if (splitWrap) splitWrap.classList.add('hidden');
        const splitList = document.getElementById('split-fare-list');
        if (splitList) splitList.innerHTML = '';
    } catch (e) {
        // ignore
    }
    
    switchSection('destination');
};

window.confirmDestination = function(destination) {
    if (currentUserRole !== 'passenger') return;
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

    try {
        configurePassengerMainPanelForSection(name);
    } catch (e) {
        // ignore
    }
    
    if(name === 'profile') {
        updateUIWithUserData();
        renderTripHistory();
        loadPassengerProfileEditDefaults();
        setPassengerProfileEditMode(false);

        // Load passenger feature data (real wallet / family / notes)
        try { window.refreshWalletUI && window.refreshWalletUI(); } catch (e) { /* ignore */ }
        try { window.refreshFamilyUI && window.refreshFamilyUI(); } catch (e) { /* ignore */ }
        try { window.refreshNoteTemplatesUI && window.refreshNoteTemplatesUI(); } catch (e) { /* ignore */ }
    }

    if (name === 'rideSelect') {
        try { window.refreshFamilyUI && window.refreshFamilyUI(); } catch (e) { /* ignore */ }
        try { window.refreshNoteTemplatesUI && window.refreshNoteTemplatesUI(); } catch (e) { /* ignore */ }
        try { updatePriceLockUI(); } catch (e) { /* ignore */ }
    }
};

window.cancelRide = function() {
    if (!confirm('هل أنت متأكد من إلغاء الرحلة؟\nقد يتم فرض رسوم إلغاء.')) return;

    if (activePassengerTripId) {
        unsubscribeTripRealtime(activePassengerTripId);
        passengerRealtimeActive = false;
        ApiService.trips.updateStatus(activePassengerTripId, 'cancelled').catch(err => {
            console.error('Failed to cancel trip:', err);
        });
        activePassengerTripId = null;
    }

    stopPassengerPickupLiveUpdates();

    stopPassengerLiveTripTracking();
    
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
        const requestId = currentIncomingTrip?.request_id;
        if (requestId && currentDriverProfile?.id) {
            await ApiService.pendingRides.reject(requestId, currentDriverProfile.id);
        } else {
            const tripId = currentIncomingTrip?.id;
            if (tripId) {
                await ApiService.trips.reject(tripId);
            }
        }
    } catch (error) {
        console.error('Reject trip failed:', error);
        showToast('❌ تعذر رفض الطلب الآن');
    }

    stopDriverIncomingTripLiveUpdates();
    currentIncomingTrip = null;
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    setDriverPanelVisible(true);
    clearDriverPassengerRoute();
    setDriverAwaitingPayment(false);
    setDriverStartReady(false);
    setDriverTripStarted(false);
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

        const tripId = currentIncomingTrip.id;
        if (!tripId) {
            showToast('لا توجد رحلة صالحة للقبول');
            return;
        }

        let assignResponse = null;
        if (currentIncomingTrip.request_id) {
            const acceptResponse = await ApiService.pendingRides.accept(
                currentIncomingTrip.request_id,
                currentDriverProfile.id
            );
            assignResponse = {
                success: !!acceptResponse?.success,
                data: {
                    ...currentIncomingTrip,
                    status: 'assigned',
                    driver_id: currentDriverProfile.id,
                    id: currentIncomingTrip.trip_id || tripId
                }
            };
        } else if (currentIncomingTrip.status === 'assigned') {
            if (String(currentIncomingTrip.driver_id) !== String(currentDriverProfile.id)) {
                showToast('هذا الطلب تم إسناده لكابتن آخر');
                return;
            }
            assignResponse = { success: true, data: currentIncomingTrip };
        } else {
            try {
                assignResponse = await ApiService.trips.assignDriver(
                    tripId,
                    currentDriverProfile.id,
                    currentDriverProfile.name
                );
            } catch (error) {
                console.error('Assign trip failed:', error);
            }
        }

        if (!assignResponse?.success) {
            showToast('تعذر قبول الطلب، حاول مرة أخرى');
            return;
        }

        activeDriverTripId = assignResponse.data?.id || tripId;

        if (activeDriverTripId) {
            subscribeTripRealtime(activeDriverTripId);
            loadTripEtaMeta(activeDriverTripId);
            loadTripPickupSuggestions(activeDriverTripId);
        }

        const waiting = document.getElementById('driver-status-waiting');
        if (waiting) waiting.classList.add('hidden');
        const incoming = document.getElementById('driver-incoming-request');
        if (incoming) incoming.classList.add('hidden');
        document.getElementById('driver-active-trip').classList.remove('hidden');
        setDriverPanelVisible(true);
        setDriverAwaitingPayment(false);
        setDriverStartReady(false);
        setDriverTripStarted(false);

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

function setDriverTripStarted(started) {
    driverTripStarted = started;
    const startBtn = document.getElementById('driver-start-btn');
    const endBtn = document.getElementById('driver-end-btn');

    if (startBtn) {
        startBtn.disabled = started || !driverStartReady;
        startBtn.classList.toggle('opacity-60', started || !driverStartReady);
        startBtn.classList.toggle('cursor-not-allowed', started || !driverStartReady);
        startBtn.classList.toggle('hidden', !driverStartReady || started);
    }
    if (endBtn) {
        endBtn.disabled = !driverAwaitingPayment;
        endBtn.classList.toggle('opacity-60', !driverAwaitingPayment);
        endBtn.classList.toggle('cursor-not-allowed', !driverAwaitingPayment);
    }

    updateDriverActiveStatusBadge();
}

function setDriverStartReady(ready) {
    driverStartReady = ready;
    setDriverTripStarted(driverTripStarted);
}

function setDriverAwaitingPayment(ready) {
    driverAwaitingPayment = ready;
    const endBtn = document.getElementById('driver-end-btn');
    if (endBtn) {
        endBtn.textContent = ready ? 'تم الدفع وإنهاء الرحلة' : 'إنهاء الرحلة';
    }
    setDriverTripStarted(driverTripStarted);
}

function updateDriverActiveStatusBadge() {
    const statusEl = document.getElementById('driver-active-status');
    if (!statusEl) return;

    if (driverAwaitingPayment) {
        statusEl.textContent = 'في انتظار الدفع';
        statusEl.className = 'text-xs font-bold text-amber-700 bg-amber-50 px-3 py-1 rounded-full';
        return;
    }

    if (driverTripStarted) {
        statusEl.textContent = 'الرحلة جارية';
        statusEl.className = 'text-xs font-bold text-blue-700 bg-blue-50 px-3 py-1 rounded-full';
        return;
    }

    if (driverStartReady) {
        statusEl.textContent = 'وصلت للراكب - ابدأ الرحلة';
        statusEl.className = 'text-xs font-bold text-amber-700 bg-amber-50 px-3 py-1 rounded-full';
        return;
    }

    statusEl.textContent = 'في الطريق للراكب';
    statusEl.className = 'text-xs font-bold text-emerald-700 bg-emerald-50 px-3 py-1 rounded-full';
}

window.driverStartTrip = async function() {
    if (driverTripStarted) return;
    if (!driverStartReady) {
        showToast('لسه ما وصلتش لموقع الراكب');
        return;
    }
    if (!activeDriverTripId) {
        showToast('لا توجد رحلة نشطة لبدئها');
        return;
    }

    // Pickup Handshake required before starting
    const code = window.prompt('🔐 أدخل كود الاستلام من الراكب');
    if (!code) {
        showToast('تم إلغاء بدء الرحلة');
        return;
    }

    try {
        await ApiService.trips.verifyPickupHandshake(activeDriverTripId, String(code).trim());
    } catch (e) {
        console.error('Pickup handshake verify failed:', e);
        showToast('❌ كود الاستلام غير صحيح');
        return;
    }

    try {
        await ApiService.trips.updateStatus(activeDriverTripId, 'ongoing', {
            trip_status: 'started'
        });
    } catch (error) {
        console.error('Failed to start trip:', error);
        showToast('تعذر بدء الرحلة حالياً');
        return;
    }

    driverTripStartedAt = Date.now();

    setDriverStartReady(false);
    setDriverAwaitingPayment(false);
    setDriverTripStarted(true);
    startDriverTripSocketLocationUpdates();
    startDriverToDestinationRoute();
    showToast('🚗 تم بدء الرحلة');
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

function formatTripDateTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('ar-EG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function buildDriverSummaryTrip(rawTrip) {
    if (!rawTrip) return null;

    const isApiTrip = rawTrip.pickup_location !== undefined || rawTrip.dropoff_location !== undefined;
    const normalized = isApiTrip
        ? DB.normalizeTrip(rawTrip, rawTrip.passenger_name)
        : { ...rawTrip };

    return {
        ...normalized,
        pickup: normalized.pickup || rawTrip.pickup_location || rawTrip.pickup || '--',
        dropoff: normalized.dropoff || rawTrip.dropoff_location || rawTrip.dropoff || '--',
        paymentMethod: normalized.paymentMethod || rawTrip.payment_method || rawTrip.paymentMethod || 'cash',
        cost: Number(normalized.cost ?? rawTrip.cost ?? 0),
        distance: Number(normalized.distance ?? rawTrip.distance ?? 0),
        duration: Number(normalized.duration ?? rawTrip.duration ?? 0),
        startedAt: rawTrip.started_at || normalized.startedAt || null,
        createdAt: rawTrip.created_at || normalized.createdAt || rawTrip.date || null,
        completedAt: rawTrip.completed_at || normalized.completedAt || null,
        cancelledAt: rawTrip.cancelled_at || normalized.cancelledAt || null,
        passengerRating: rawTrip.passenger_rating || normalized.passengerRating || normalized.rating || 0,
        driverRating: rawTrip.driver_rating || normalized.driverRating || 0
    };
}

function openDriverTripSummary(rawTrip) {
    const trip = buildDriverSummaryTrip(rawTrip);
    if (!trip) return;

    const paymentLabels = {
        cash: 'كاش',
        card: 'بطاقة بنكية',
        wallet: 'محفظة إلكترونية'
    };

    const modal = document.getElementById('driver-trip-summary-modal');
    const tripIdEl = document.getElementById('driver-summary-trip-id');
    const startEl = document.getElementById('driver-summary-start');
    const endEl = document.getElementById('driver-summary-end');
    const pickupEl = document.getElementById('driver-summary-pickup');
    const dropoffEl = document.getElementById('driver-summary-dropoff');
    const distanceEl = document.getElementById('driver-summary-distance');
    const durationEl = document.getElementById('driver-summary-duration');
    const paymentEl = document.getElementById('driver-summary-payment');
    const amountEl = document.getElementById('driver-summary-amount');
    const totalEl = document.getElementById('driver-summary-total');

    if (tripIdEl) tripIdEl.textContent = trip.id || '--';
    if (startEl) startEl.textContent = formatTripDateTime(trip.startedAt || trip.createdAt || trip.date);
    if (endEl) endEl.textContent = formatTripDateTime(trip.completedAt || trip.cancelledAt);
    if (pickupEl) pickupEl.textContent = trip.pickup || '--';
    if (dropoffEl) dropoffEl.textContent = trip.dropoff || '--';
    if (distanceEl) distanceEl.textContent = `${Number(trip.distance || 0)} كم`;
    if (durationEl) durationEl.textContent = `${Number(trip.duration || 0)} دقيقة`;
    if (paymentEl) paymentEl.textContent = paymentLabels[trip.paymentMethod] || trip.paymentMethod || '--';
    if (amountEl) amountEl.textContent = `${Number(trip.cost || 0)} ر.س`;
    if (totalEl) totalEl.textContent = `${Number(trip.cost || 0)} ر.س`;

    driverRatingValue = 0;
    document.querySelectorAll('.driver-star-btn').forEach(b => {
        b.classList.remove('text-yellow-400');
        b.classList.add('text-gray-300');
    });

    const commentInput = document.getElementById('driver-rating-comment');
    if (commentInput) commentInput.value = '';

    if (modal) modal.classList.remove('hidden');
}

function closeDriverTripSummary() {
    const modal = document.getElementById('driver-trip-summary-modal');
    if (modal) modal.classList.add('hidden');
}

window.closeDriverTripSummary = closeDriverTripSummary;

window.driverEndTrip = async function() {
    stopDriverTripSocketLocationUpdates();

    document.getElementById('driver-active-trip').classList.add('hidden');
    document.getElementById('driver-status-waiting').classList.remove('hidden');
    clearDriverPassengerRoute();
    setDriverAwaitingPayment(false);
    setDriverStartReady(false);
    setDriverTripStarted(false);
    showToast('تم إنهاء الرحلة بنجاح');
    triggerConfetti();

    const tripId = activeDriverTripId;
    const incomingSnapshot = currentIncomingTrip ? { ...currentIncomingTrip } : null;

    if (tripId) {
        const driverSummary = incomingSnapshot ? {
            cost: incomingSnapshot.cost,
            distance: incomingSnapshot.distance,
            payment_method: incomingSnapshot.payment_method || 'cash'
        } : null;

        let summaryTrip = null;

        try {
            const response = await ApiService.trips.updateStatus(tripId, 'completed', {
                ...(driverSummary || {}),
                trip_status: 'completed'
            });
            if (response?.data) {
                summaryTrip = buildDriverSummaryTrip(response.data);
            }
        } catch (err) {
            console.error('Failed to update trip status:', err);
        }

        if (!summaryTrip) {
            try {
                const response = await ApiService.trips.getById(tripId);
                if (response?.data) {
                    summaryTrip = buildDriverSummaryTrip(response.data);
                }
            } catch (err) {
                console.error('Failed to fetch trip summary:', err);
            }
        }

        if (summaryTrip) {
            lastCompletedTrip = summaryTrip;
            if (currentUserRole === 'driver') {
                openDriverTripSummary(summaryTrip);
            }
        }

        // Refresh driver trip history cache so it appears instantly
        try {
            const user = DB.getUser();
            await DB.fetchTrips({ userId: user?.id, role: 'driver' });
        } catch (e) {
            // ignore
        }
    }

    activeDriverTripId = null;
    currentIncomingTrip = null;
    if (tripId) {
        unsubscribeTripRealtime(tripId);
    }
    triggerDriverRequestPolling();
};

window.logoutUser = function() {
    stopPassengerMatchPolling();
    stopDriverRequestPolling();
    stopLocationTracking();
    driverLocation = null;
    nearestDriverPreview = null;
    DB.clearSession();
    if (window.Auth && typeof window.Auth.clearToken === 'function') {
        window.Auth.clearToken();
    }
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

    // Keep extras in sync (price lock button, locked price override)
    refreshRideSelectPriceUI();
}

function stopPassengerMatchPolling() {
    if (passengerMatchInterval) {
        clearInterval(passengerMatchInterval);
        passengerMatchInterval = null;
    }
    passengerMatchTripId = null;
}

async function checkPassengerMatch(tripId) {
    if (!tripId) return;

    try {
        const response = await ApiService.trips.getById(tripId);
        const trip = response?.data || null;
        if (!trip) return;

        if (trip.status === 'cancelled') {
            stopPassengerMatchPolling();
            stopPassengerPickupLiveUpdates();
            showToast('تم إلغاء الرحلة');
            resetApp();
            return;
        }

        if (trip.driver_id) {
            stopPassengerMatchPolling();
            stopPassengerPickupLiveUpdates();
            await handlePassengerAssignedTrip(trip);
        }
    } catch (error) {
        console.error('Failed to check trip assignment:', error);
    }
}

function startPassengerMatchPolling(tripId) {
    if (!tripId) return;
    stopPassengerMatchPolling();
    passengerMatchTripId = tripId;
    checkPassengerMatch(tripId);
    passengerMatchInterval = setInterval(() => checkPassengerMatch(tripId), 4000);
}

async function loadAssignedDriverLocation(driverId) {
    if (!driverId) return null;
    try {
        const response = await ApiService.drivers.getLocation(driverId);
        if (response?.success && response?.data?.last_lat && response?.data?.last_lng) {
            return {
                lat: Number(response.data.last_lat),
                lng: Number(response.data.last_lng),
                name: response.data.name || null
            };
        }
    } catch (error) {
        console.error('Failed to fetch assigned driver location:', error);
    }
    return null;
}

async function fetchNearestDriverPreview(pickup, carType) {
    if (!pickup?.lat || !pickup?.lng) return null;
    try {
        const response = await ApiService.drivers.getNearest(pickup.lat, pickup.lng, carType);
        if (response?.success && response?.data) {
            const nearest = response.data;
            if (nearest.last_lat && nearest.last_lng) {
                nearestDriverPreview = {
                    lat: Number(nearest.last_lat),
                    lng: Number(nearest.last_lng),
                    name: nearest.name || null
                };
                return nearestDriverPreview;
            }
        }
    } catch (error) {
        console.error('Failed to fetch nearest driver:', error);
    }
    return null;
}

async function handlePassengerAssignedTrip(trip) {
    activePassengerTripId = trip.id || activePassengerTripId;

    // Realtime subscribe for trip state + live driver location
    if (activePassengerTripId) {
        subscribeTripRealtime(activePassengerTripId);
        loadTripEtaMeta(activePassengerTripId);
        loadTripPickupSuggestions(activePassengerTripId);
        passengerRealtimeActive = true;
        passengerLastTripStatus = 'assigned';
        passengerTripCenteredOnce = false;
    }

    const driverName = trip.driver_name || 'كابتن قريب';
    const driverLabelText = document.getElementById('driver-label-text');
    if (driverLabelText) driverLabelText.innerText = `${driverName} قادم إليك`;

    const assignedLocation = await loadAssignedDriverLocation(trip.driver_id);
    if (assignedLocation) {
        driverLocation = { lat: assignedLocation.lat, lng: assignedLocation.lng };
    } else if (nearestDriverPreview) {
        driverLocation = { lat: nearestDriverPreview.lat, lng: nearestDriverPreview.lng };
    }

    const est = lastTripEstimate || computeTripEstimates();
    const etaMin = est.etaMin || 10;
    const minETA = 10 * 60;
    const maxETA = 15 * 60;
    etaSeconds = Math.max(minETA, Math.min(maxETA, Math.round(etaMin * 60)));

    const carTypeNames = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
    const carType = trip.car_type || currentCarType;
    const price = currentTripPrice || trip.cost || 0;
    const carTypeEl = document.getElementById('trip-car-type');
    if (carTypeEl) carTypeEl.innerText = carTypeNames[carType] || carType || 'اقتصادي';
    const priceEl = document.getElementById('trip-price-display');
    if (priceEl) priceEl.innerText = `${price} ر.س`;

    const etaEl = document.getElementById('eta-display');
    if (etaEl) etaEl.innerText = formatETA(etaSeconds);

    if (etaCountdown) {
        clearInterval(etaCountdown);
        etaCountdown = null;
    }

    switchSection('driver');
    preparePassengerDriverMapView();
    startPassengerLiveTripTracking(activePassengerTripId, trip.driver_id);
    showToast('✅ تم قبول الرحلة بواسطة كابتن حقيقي', 4000);
}

window.requestRide = async function() {
    if (!currentPickup) {
        const picked = ensurePickupFallback();
        if (!picked) {
            await ensurePickupFromInput();
        }
    }
    if (!currentDestination) {
        await ensureDestinationFromInput();
    }
    if (!currentPickup || !currentDestination) {
        showToast('حدد الالتقاط والوجهة أولاً');
        return;
    }
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
    lastTripEstimate = { distanceKm: est.distanceKm, etaMin: est.etaMin };
    currentTripPrice = computePrice(currentCarType, est.distanceKm);
    
    if (scheduledTime) {
        try {
            const payload = {
                pickup_location: currentPickup.label || 'نقطة الالتقاط',
                dropoff_location: currentDestination.label || 'الوجهة',
                pickup_lat: currentPickup.lat,
                pickup_lng: currentPickup.lng,
                dropoff_lat: currentDestination.lat,
                dropoff_lng: currentDestination.lng,
                car_type: currentCarType,
                payment_method: 'cash',
                scheduled_at: scheduledTime.toISOString()
            };
            await ApiService.scheduledRides.create(payload);
            showToast(`✅ تم جدولة الرحلة في ${scheduledTime.toLocaleString('ar-EG')}`);
            setTimeout(() => resetApp(), 2000);
            return;
        } catch (e) {
            showToast('❌ تعذر جدولة الرحلة، حاول مرة أخرى');
            return;
        }
    }
    
    try {
        const user = DB.getUser();

        // Collect extra options from UI (before we create trip)
        const familySelect = document.getElementById('ride-family-member');
        const familyMemberId = familySelect && familySelect.value ? Number(familySelect.value) : null;

        const noteTplEl = document.getElementById('ride-note-template');
        const noteTplId = noteTplEl && noteTplEl.value ? Number(noteTplEl.value) : null;

        const noteCustomEl = document.getElementById('ride-note-custom');
        const noteCustom = noteCustomEl ? String(noteCustomEl.value || '').trim() : '';

        const quietEl = document.getElementById('ride-quiet-mode');
        const quietMode = quietEl ? Boolean(quietEl.checked) : false;

        const priceLockId = activePriceLock && isPriceLockValid(activePriceLock) ? Number(activePriceLock.id) : null;

        let pendingStops = [];
        try {
            pendingStops = collectStopsFromUI();
        } catch (e) {
            showToast('❌ تأكد من إحداثيات المحطات (lat/lng)');
            return;
        }

        let pendingSplits = null;
        try {
            pendingSplits = collectSplitFareFromUI();
        } catch (e) {
            showToast('❌ بيانات تقسيم الأجرة غير صحيحة');
            return;
        }

        // GPS ONLY (high accuracy) for pickup coordinates
        const fix = await getHighAccuracyPickupFix();
        if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lng)) {
            showToast('⚠️ تعذر تحديد موقعك بدقة، حاول مرة أخرى');
            return;
        }

        // Update local pickup marker/state to match what will be sent
        // If a pickup hub was selected, keep hub coords (do not overwrite with GPS fix)
        if (!currentPickupHubId) {
            const gpsPickupCoords = { lat: fix.lat, lng: fix.lng };
            applyPassengerLocation(gpsPickupCoords, false);
            maybeReverseGeocodePickup(gpsPickupCoords);
        }

        console.log('📍 Rider pickup before sending trip:', {
            pickup_lat: fix.lat,
            pickup_lng: fix.lng,
            pickup_accuracy: fix.accuracy,
            pickup_timestamp: fix.timestamp
        });

        const tripPayload = {
            user_id: user?.id || 1,
            pickup_location: currentPickup.label || 'نقطة الالتقاط',
            dropoff_location: currentDestination.label || 'الوجهة',
            pickup_lat: currentPickupHubId ? currentPickup.lat : fix.lat,
            pickup_lng: currentPickupHubId ? currentPickup.lng : fix.lng,
            pickup_accuracy: fix.accuracy,
            pickup_timestamp: fix.timestamp,
            dropoff_lat: currentDestination.lat,
            dropoff_lng: currentDestination.lng,
            pickup_hub_id: currentPickupHubId || null,
            passenger_note: noteCustom ? noteCustom : null,
            passenger_note_template_id: !noteCustom && Number.isFinite(noteTplId) && noteTplId > 0 ? noteTplId : null,
            booked_for_family_member_id: Number.isFinite(familyMemberId) && familyMemberId > 0 ? familyMemberId : null,
            price_lock_id: Number.isFinite(priceLockId) && priceLockId > 0 ? priceLockId : null,
            quiet_mode: quietMode,
            car_type: currentCarType,
            cost: currentTripPrice,
            distance: est.distanceKm,
            duration: est.etaMin,
            payment_method: pendingSplits ? 'split' : 'cash',
            status: 'pending',
            source: 'passenger_app'
        };

        const created = await ApiService.trips.create(tripPayload);
        activePassengerTripId = created?.data?.id || null;
        if (activePassengerTripId) {
            // Apply multi-stops (reprices server-side)
            if (pendingStops.length) {
                try {
                    const stopsRes = await ApiService.trips.setStops(activePassengerTripId, pendingStops);
                    const updatedTrip = stopsRes?.trip || null;
                    if (updatedTrip && (updatedTrip.price !== undefined || updatedTrip.cost !== undefined)) {
                        const newPrice = updatedTrip.price !== undefined && updatedTrip.price !== null ? Number(updatedTrip.price) : Number(updatedTrip.cost || currentTripPrice);
                        if (Number.isFinite(newPrice)) {
                            currentTripPrice = newPrice;
                            refreshRideSelectPriceUI();
                        }
                    }
                    showToast('✅ تم حفظ المحطات');
                } catch (e) {
                    console.error('setStops failed:', e);
                    showToast('⚠️ تعذر حفظ المحطات');
                }
            }

            // Apply split fare (must match trip price)
            if (pendingSplits) {
                try {
                    const total = pendingSplits.reduce((acc, s) => acc + Number(s.amount || 0), 0);
                    const rounded = Math.round(total * 100) / 100;
                    const priceRounded = Math.round(Number(currentTripPrice || 0) * 100) / 100;
                    if (Math.abs(rounded - priceRounded) > 0.5) {
                        showToast('⚠️ مجموع التقسيم لازم يساوي سعر الرحلة');
                    } else {
                        await ApiService.trips.setSplitFare(activePassengerTripId, pendingSplits);
                        showToast('✅ تم تفعيل تقسيم الأجرة');
                    }
                } catch (e) {
                    console.error('setSplitFare failed:', e);
                    showToast('⚠️ تعذر تفعيل تقسيم الأجرة');
                }
            }

            startPassengerPickupLiveUpdates(activePassengerTripId);
        }
    } catch (error) {
        console.error('Failed to create trip:', error);
        showToast('❌ تعذر إرسال الطلب، حاول مرة أخرى');
        return;
    }

    // Show loading (searching for driver)
    switchSection('loading');
    resetMatchTimelineUI();
    if (activePassengerTripId) {
        fetchNearestDriverPreview(currentPickup, currentCarType);
        startPassengerMatchPolling(activePassengerTripId);
    }
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
    // JWT is now available -> subscribe for match timeline updates
    subscribeUserRealtime();
    document.body.classList.add('role-passenger');
    document.body.classList.remove('role-driver');
    document.getElementById('passenger-ui-container').classList.remove('hidden');
    document.getElementById('passenger-top-bar').classList.remove('hidden');
    const passengerPanelToggle = document.getElementById('passenger-panel-toggle');
    if (passengerPanelToggle) passengerPanelToggle.classList.remove('hidden');
    setPassengerPanelHidden(false);
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

    startLocationTracking();
    requestSingleLocationFix();
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
    setDriverAwaitingPayment(false);
    setDriverStartReady(false);
    setDriverTripStarted(false);
    const passengerUi = document.getElementById('passenger-ui-container');
    if (passengerUi) passengerUi.classList.add('hidden');
    const passengerTopBar = document.getElementById('passenger-top-bar');
    if (passengerTopBar) passengerTopBar.classList.add('hidden');
    setPassengerPanelHidden(true);
    const rideSelectState = document.getElementById('state-ride-select');
    if (rideSelectState) rideSelectState.classList.add('hidden');
    const carOptionsToggle = document.getElementById('car-options-toggle');
    if (carOptionsToggle) carOptionsToggle.classList.add('hidden');
    const carOptionsList = document.getElementById('car-options-list');
    if (carOptionsList) carOptionsList.classList.add('hidden');
    const passengerMenu = document.getElementById('side-menu');
    const passengerOverlay = document.getElementById('menu-overlay');
    if (passengerMenu) passengerMenu.classList.remove('sidebar-open');
    if (passengerOverlay) passengerOverlay.classList.remove('overlay-open');
    const driverTopBar = document.getElementById('driver-top-bar');
    if (driverTopBar) driverTopBar.classList.remove('hidden');
    const passengerPanelToggle = document.getElementById('passenger-panel-toggle');
    if (passengerPanelToggle) passengerPanelToggle.classList.add('hidden');
    const um = document.getElementById('user-marker');
    if(um) um.classList.remove('hidden');
    const world = document.getElementById('map-world');
    if (world) world.classList.add('hidden');
    initLeafletMap();
    moveLeafletMapToContainer('map-container');
    showDriverWaitingState();
    updateDriverMenuData();
    startLocationTracking();
    requestSingleLocationFix();
    resolveDriverProfile().then(() => {
        showDriverWaitingState();
        startDriverRequestPolling();
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
            const {
                total_trips,
                total_revenue,
                total_drivers_earnings,
                total_distance,
                trips_today,
                trips_this_month
            } = response.data;

            const totalTripsEl = document.getElementById('admin-total-trips');
            if (totalTripsEl) totalTripsEl.textContent = Number(total_trips || 0).toLocaleString('ar-EG');

            const totalRevenueEl = document.getElementById('admin-total-revenue');
            if (totalRevenueEl) {
                totalRevenueEl.innerHTML = `${Number(total_revenue || 0).toLocaleString('ar-EG')} <span class="text-sm text-gray-400">ر.س</span>`;
            }

            const driversEarningsEl = document.getElementById('admin-total-drivers-earnings');
            if (driversEarningsEl) {
                driversEarningsEl.innerHTML = `${Number(total_drivers_earnings || 0).toLocaleString('ar-EG')} <span class="text-sm text-gray-400">ر.س</span>`;
            }

            const distanceEl = document.getElementById('admin-total-distance');
            if (distanceEl) {
                distanceEl.innerHTML = `${Number(total_distance || 0).toLocaleString('ar-EG')} <span class="text-sm text-gray-400">كم</span>`;
            }

            const tripsTodayEl = document.getElementById('admin-trips-today');
            if (tripsTodayEl) tripsTodayEl.textContent = Number(trips_today || 0).toLocaleString('ar-EG');

            const tripsMonthEl = document.getElementById('admin-trips-this-month');
            if (tripsMonthEl) tripsMonthEl.textContent = Number(trips_this_month || 0).toLocaleString('ar-EG');
            
            console.log('✅ Admin dashboard stats loaded from database');
        }
    } catch (error) {
        console.error('Failed to load admin dashboard stats:', error);
        // Keep default values (0) if API fails
    }
}

// ==================== DRIVER TRIPS SCREEN ====================

window.openDriverTrips = async function() {
    const screen = document.getElementById('driver-trips-screen');
    const container = document.getElementById('driver-trips-container');
    if (!screen || !container) return;

    const driverId = currentDriverProfile?.id;
    if (!driverId) {
        showToast('تعذر تحديد ملف السائق');
        return;
    }

    screen.classList.remove('hidden');
    container.innerHTML = '<p class="text-gray-500 text-center py-8">جاري تحميل الرحلات...</p>';

    try {
        const resp = await fetch(`/api/driver/trips?driver_id=${encodeURIComponent(String(driverId))}`);
        const data = await resp.json();
        if (!resp.ok || !data?.success) throw new Error(data?.error || 'Failed');

        const trips = Array.isArray(data.data) ? data.data : [];
        container.innerHTML = '';
        if (!trips.length) {
            container.innerHTML = '<p class="text-gray-500 text-center py-8">لا توجد رحلات</p>';
            return;
        }

        trips.forEach((t) => {
            const dateStr = new Date(t.completed_at || t.cancelled_at || t.created_at).toLocaleString('ar-EG', {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const riderName = t.passenger_name || 'راكب';
            const earnings = Number(t.cost || 0);
            const distance = Number(t.distance || 0);
            const duration = Number(t.duration || 0);
            const riderRating = Number(t.driver_rating || 0);
            const ratingStars = '⭐'.repeat(Math.max(0, Math.min(5, riderRating)));

            const html = `
                <div class="bg-white border-2 border-gray-200 rounded-2xl p-4">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <p class="text-xs text-gray-500 font-bold">${dateStr}</p>
                            <p class="font-extrabold text-gray-800">${riderName}</p>
                        </div>
                        <div class="text-left font-extrabold text-emerald-700">${earnings} ر.س</div>
                    </div>
                    <div class="flex justify-between text-sm font-bold text-gray-700">
                        <span>المسافة: ${distance} كم</span>
                        <span>المدة: ${duration} دقيقة</span>
                    </div>
                    <div class="mt-2 text-sm font-bold text-gray-700">
                        تقييم الراكب: <span class="text-yellow-500">${ratingStars || '—'}</span>
                    </div>
                </div>
            `;
            container.insertAdjacentHTML('beforeend', html);
        });
    } catch (e) {
        console.error('Failed to load driver trips:', e);
        container.innerHTML = '<p class="text-gray-500 text-center py-8">تعذر تحميل الرحلات</p>';
    }
};

window.closeDriverTrips = function() {
    const screen = document.getElementById('driver-trips-screen');
    if (screen) screen.classList.add('hidden');
};

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

function normalizeDriverIncomingRequest(rawRequest) {
    if (!rawRequest) return null;
    const tripRef = rawRequest.trip_ref || rawRequest.trip_id || rawRequest.id || null;
    return {
        ...rawRequest,
        id: tripRef || rawRequest.request_id,
        trip_id: tripRef,
        request_id: rawRequest.request_id || null,
        cost: rawRequest.estimated_cost ?? rawRequest.cost ?? 0,
        distance: rawRequest.estimated_distance ?? rawRequest.distance ?? '-',
        passenger_name: rawRequest.passenger_name || rawRequest.user_name || 'راكب جديد',
        passenger_phone: rawRequest.passenger_phone || rawRequest.user_phone || null,
        passenger_verified_level: rawRequest.passenger_verified_level || rawRequest.verified_level || 'none'
    };
}

function stopDriverIncomingTripLiveUpdates() {
    if (driverIncomingTripUpdateInterval) {
        clearInterval(driverIncomingTripUpdateInterval);
        driverIncomingTripUpdateInterval = null;
    }
}

function startDriverIncomingTripLiveUpdates(requestId) {
    stopDriverIncomingTripLiveUpdates();
    if (!requestId) return;

    driverIncomingTripUpdateInterval = setInterval(async () => {
        if (currentUserRole !== 'driver') return;
        if (!currentIncomingTrip?.request_id) return;
        if (String(currentIncomingTrip.request_id) !== String(requestId)) return;

        try {
            const response = await ApiService.pendingRides.getById(requestId);
            const raw = response?.data || null;
            const updated = normalizeDriverIncomingRequest(raw);
            if (!updated) return;

            const prevLat = currentIncomingTrip.pickup_lat;
            const prevLng = currentIncomingTrip.pickup_lng;
            currentIncomingTrip = { ...currentIncomingTrip, ...updated };

            const nextLat = updated.pickup_lat;
            const nextLng = updated.pickup_lng;
            const lat = nextLat !== undefined && nextLat !== null ? Number(nextLat) : null;
            const lng = nextLng !== undefined && nextLng !== null ? Number(nextLng) : null;

            const changed =
                String(prevLat ?? '') !== String(nextLat ?? '') ||
                String(prevLng ?? '') !== String(nextLng ?? '');

            if (changed) {
                console.log('🔄 Driver received updated pickup coords (poll):', {
                    prev: { pickup_lat: prevLat, pickup_lng: prevLng },
                    next: { pickup_lat: nextLat, pickup_lng: nextLng },
                    request_id: requestId
                });
            }

            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                setPassengerPickup({
                    lat,
                    lng,
                    phone: updated.passenger_phone || currentIncomingTrip.passenger_phone
                }, updated.pickup_location || currentIncomingTrip.pickup_location);

                // If route is shown, keep it aligned to latest pickup coords.
                if (driverLocation) {
                    updateDriverActiveRouteFromGps(driverLocation);
                }
            }
        } catch (error) {
            // Silent-ish: polling should not spam user
            console.warn('⚠️ Driver incoming request refresh failed:', error?.message || error);
        }
    }, 3000);
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
        const response = await ApiService.pendingRides.getForDriver(currentDriverProfile.id, {
            maxDistance: 30
        });
        const requests = Array.isArray(response?.data) ? response.data : [];
        const trips = requests.map(normalizeDriverIncomingRequest).filter(Boolean);

        if (!trips.length) {
            showDriverWaitingState();
            return;
        }

        const trip = trips[0];
        currentIncomingTrip = trip;
        renderDriverIncomingTrip(trip, trips.length);
    } catch (error) {
        console.error('Failed to fetch pending trips:', error);
        showDriverWaitingState();
    }
}

function showDriverWaitingState() {
    stopDriverIncomingTripLiveUpdates();
    const waiting = document.getElementById('driver-status-waiting');
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.add('hidden');
    if (waiting) waiting.classList.remove('hidden');
    setDriverPanelVisible(true);
    setDriverAwaitingPayment(false);
    setDriverStartReady(false);
    setDriverTripStarted(false);
}

function renderDriverIncomingTrip(trip, nearbyCount = 0) {
    const waiting = document.getElementById('driver-status-waiting');
    if (waiting) waiting.classList.add('hidden');
    const incoming = document.getElementById('driver-incoming-request');
    if (incoming) incoming.classList.remove('hidden');

    const pickupEl = document.getElementById('driver-request-pickup');
    const dropoffEl = document.getElementById('driver-request-dropoff');
    const priceEl = document.getElementById('driver-request-price');
    const distanceEl = document.getElementById('driver-request-distance');
    const passengerEl = document.getElementById('driver-request-passenger');
    const passengerVerifiedEl = document.getElementById('driver-request-passenger-verified');
    const carTypeEl = document.getElementById('driver-request-car-type');
    const tripIdEl = document.getElementById('driver-request-trip-id');
    const countEl = document.getElementById('driver-request-nearby-count');

    if (tripIdEl) tripIdEl.innerText = trip.id || '-';
    if (pickupEl) pickupEl.innerText = trip.pickup_location || 'موقع الراكب';
    if (dropoffEl) dropoffEl.innerText = trip.dropoff_location || 'الوجهة';
    if (priceEl) priceEl.innerText = trip.cost || '0';
    if (distanceEl) distanceEl.innerText = trip.distance || '-';
    if (passengerEl) passengerEl.innerText = trip.passenger_name || 'راكب جديد';

    if (passengerVerifiedEl) {
        const lvl = String(trip.passenger_verified_level || 'none').toLowerCase();
        if (lvl === 'strong') {
            passengerVerifiedEl.textContent = 'Strong ✅';
            passengerVerifiedEl.className = 'text-[11px] font-extrabold px-2 py-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700';
            passengerVerifiedEl.classList.remove('hidden');
        } else if (lvl === 'basic') {
            passengerVerifiedEl.textContent = 'Basic ✅';
            passengerVerifiedEl.className = 'text-[11px] font-extrabold px-2 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700';
            passengerVerifiedEl.classList.remove('hidden');
        } else {
            passengerVerifiedEl.textContent = '';
            passengerVerifiedEl.classList.add('hidden');
        }
    }
    if (carTypeEl) carTypeEl.innerText = trip.car_type || 'اقتصادي';
    if (countEl) {
        countEl.innerText = nearbyCount > 1 ? `طلبات قريبة: ${nearbyCount}` : '';
    }

    if (trip.pickup_lat !== undefined && trip.pickup_lat !== null && trip.pickup_lng !== undefined && trip.pickup_lng !== null) {
        setPassengerPickup({
            lat: Number(trip.pickup_lat),
            lng: Number(trip.pickup_lng),
            phone: trip.passenger_phone
        }, trip.pickup_location);
        passengerPickup.phone = trip.passenger_phone;
    }

    if (trip.request_id) {
        startDriverIncomingTripLiveUpdates(trip.request_id);
    }
    setDriverPanelVisible(true);
}

async function renderAdminTrips() {
    const table = document.getElementById('admin-trips-table');
    if (!table) return;
    table.innerHTML = '<tr><td class="px-6 py-6 text-gray-500" colspan="9">جاري تحميل الرحلات...</td></tr>';

    const user = DB.getUser();
    await DB.fetchTrips({ role: user?.role || 'admin' });
    const trips = DB.getTrips();

    table.innerHTML = '';
    if (!trips.length) {
        table.innerHTML = '<tr><td class="px-6 py-6 text-gray-500" colspan="9">لا توجد رحلات</td></tr>';
        return;
    }

    const statusLabels = {
        completed: 'مكتملة',
        cancelled: 'ملغية',
        ongoing: 'جارية',
        pending: 'قيد الانتظار',
        assigned: 'تم الإسناد'
    };
    const statusClasses = {
        completed: 'bg-green-100 text-green-700',
        cancelled: 'bg-red-100 text-red-700',
        ongoing: 'bg-blue-100 text-blue-700',
        pending: 'bg-amber-100 text-amber-700',
        assigned: 'bg-indigo-100 text-indigo-700'
    };

    trips.forEach(trip => {
        const createdAt = formatTripDateTime(trip.createdAt || trip.date);
        const completedAt = formatTripDateTime(trip.completedAt || trip.cancelledAt);
        const statusLabel = statusLabels[trip.status] || trip.status || 'غير محدد';
        const statusClass = statusClasses[trip.status] || 'bg-gray-100 text-gray-700';

        const html = `
        <tr class="hover:bg-indigo-50/30 transition-colors">
            <td class="px-6 py-4 font-bold">${trip.id}</td>
            <td class="px-6 py-4">${trip.driver || 'غير محدد'}</td>
            <td class="px-6 py-4">${createdAt}</td>
            <td class="px-6 py-4">${completedAt}</td>
            <td class="px-6 py-4">${trip.pickup || '--'}</td>
            <td class="px-6 py-4">${trip.dropoff || '--'}</td>
            <td class="px-6 py-4">${Number(trip.duration || 0)} دقيقة</td>
            <td class="px-6 py-4 font-bold text-indigo-600">${Number(trip.cost || 0)} ر.س</td>
            <td class="px-6 py-4">
                <span class="${statusClass} px-2 py-1 rounded-full text-xs font-bold">${statusLabel}</span>
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

            <div class="mt-2 text-xs font-bold text-gray-600 flex justify-between">
                <span>المسافة: ${Number(trip.distance || 0)} كم</span>
                <span>المدة: ${Number(trip.duration || 0)} دقيقة</span>
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
let cachedOffers = [];

async function fetchOffersFromApi() {
    try {
        const response = await fetch('/api/offers?active=1');
        if (!response.ok) throw new Error('Failed to fetch offers');
        const data = await response.json();
        return Array.isArray(data.data) ? data.data : [];
    } catch (err) {
        return [];
    }
}

function normalizeOffer(offer) {
    return {
        title: offer.title,
        description: offer.description,
        badge: offer.badge || 'عرض',
        code: (offer.code || '').toUpperCase(),
        discount_type: offer.discount_type,
        discount_value: Number(offer.discount_value || 0)
    };
}

window.getOfferByCode = function(code) {
    const normalized = (code || '').toUpperCase();
    return cachedOffers.find(offer => (offer.code || '').toUpperCase() === normalized) || null;
};

window.renderOffers = async function() {
    const container = document.getElementById('offers-container');
    const emptyState = document.getElementById('empty-offers-state');
    if (!container || !emptyState) return;

    container.innerHTML = '<p class="text-gray-500 text-center py-8">جاري تحميل العروض...</p>';
    emptyState.classList.add('hidden');

    const apiOffers = await fetchOffersFromApi();
    const fallbackOffers = [
        {
            title: '🎉 خصم 20% على أول رحلة',
            description: 'استخدم الكود WELCOME20 على أول طلب لك واحصل على خصم فوري.',
            badge: 'جديد',
            code: 'WELCOME20',
            discount_type: 'percent',
            discount_value: 20
        },
        {
            title: '🚗 رحلتان بسعر 1',
            description: 'رحلتك الثانية مجاناً عند الدفع بالبطاقة خلال هذا الأسبوع.',
            badge: 'محدود',
            code: '2FOR1',
            discount_type: 'percent',
            discount_value: 50
        },
        {
            title: '⭐ نقاط مضاعفة',
            description: 'اكسب ضعف النقاط على الرحلات المكتملة في عطلة نهاية الأسبوع.',
            badge: 'نقاط',
            code: 'DOUBLEPTS',
            discount_type: 'points',
            discount_value: 2
        }
    ];

    const offers = (apiOffers.length ? apiOffers : fallbackOffers).map(normalizeOffer);
    cachedOffers = offers;

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
    const normalized = (code || '').toUpperCase();
    if (!normalized) {
        showToast('⚠️ هذا العرض غير متاح حالياً');
        return;
    }

    SafeStorage.setItem('akwadra_active_offer', normalized);

    const hasPriceContext = (currentTripPrice || tripDetails.basePrice || 0) > 0;

    const promoInput = document.getElementById('promo-code-input');
    const paymentSection = document.getElementById('state-payment-method');
    const invoiceSection = document.getElementById('state-payment-invoice');
    const isPaymentVisible = (paymentSection && !paymentSection.classList.contains('hidden'))
        || (invoiceSection && !invoiceSection.classList.contains('hidden'));

    if (promoInput && isPaymentVisible && hasPriceContext) {
        promoInput.value = normalized;
        window.applyPromoCode();
        return;
    }

    if (hasPriceContext) {
        window.switchSection('payment-method');
        setTimeout(() => {
            const input = document.getElementById('promo-code-input');
            if (input) {
                input.value = normalized;
                window.applyPromoCode();
            }
        }, 150);
        return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(normalized).then(() => {
            showToast(`✅ تم نسخ كود العرض: ${normalized}`);
        }).catch(() => {
            showToast(`✅ تم اختيار العرض: ${normalized} — استخدمه عند الدفع`);
        });
    } else {
        showToast(`✅ تم اختيار العرض: ${normalized} — استخدمه عند الدفع`);
    }
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

function resetSafetyCapsuleUI() {
    const err = document.getElementById('safety-capsule-error');
    const share = document.getElementById('safety-capsule-share');
    const shareUrl = document.getElementById('safety-capsule-share-url');
    const tl = document.getElementById('safety-capsule-timeline');
    const items = document.getElementById('safety-capsule-timeline-items');

    if (err) {
        err.classList.add('hidden');
        err.textContent = '';
    }
    if (share) share.classList.add('hidden');
    if (shareUrl) {
        shareUrl.textContent = '';
        shareUrl.setAttribute('href', '#');
    }
    if (tl) tl.classList.add('hidden');
    if (items) items.innerHTML = '';
}

function setSafetyCapsuleError(message) {
    const err = document.getElementById('safety-capsule-error');
    if (!err) return;
    const msg = String(message || '').trim();
    if (!msg) {
        err.classList.add('hidden');
        err.textContent = '';
        return;
    }
    err.textContent = msg;
    err.classList.remove('hidden');
}

function renderSafetyCapsuleTimeline(timeline) {
    const tl = document.getElementById('safety-capsule-timeline');
    const items = document.getElementById('safety-capsule-timeline-items');
    if (!tl || !items) return;

    const arr = Array.isArray(timeline) ? timeline : [];
    if (arr.length === 0) {
        tl.classList.add('hidden');
        items.innerHTML = '';
        return;
    }

    items.innerHTML = '';
    for (const it of arr) {
        const type = String(it?.type || '').toLowerCase();
        let label = '';
        if (type === 'safety_event') {
            label = it?.event_type ? `حدث: ${String(it.event_type)}` : 'حدث أمان';
            if (it?.message) label += ` — ${String(it.message)}`;
        } else if (type === 'guardian_checkin') {
            const st = it?.status ? String(it.status) : 'scheduled';
            const due = it?.due_at ? new Date(it.due_at) : null;
            const dueText = due && Number.isFinite(due.getTime()) ? due.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
            label = `Guardian: ${st}${dueText ? ` (موعد ${dueText})` : ''}`;
        } else {
            label = 'Timeline item';
        }

        const row = document.createElement('div');
        row.className = 'flex items-start gap-2';
        row.innerHTML = `<span class="text-indigo-600">•</span><span class="flex-1">${escapeHtml(label)}</span>`;
        items.appendChild(row);
    }

    tl.classList.remove('hidden');
}

window.loadSafetyCapsuleForTripDetails = async function() {
    const btn = document.getElementById('safety-capsule-btn');
    const tripId = (document.getElementById('trip-detail-id')?.innerText || '').trim();
    if (!tripId) return;

    resetSafetyCapsuleUI();
    setSafetyCapsuleError('');
    if (btn) btn.disabled = true;

    try {
        const res = await ApiService.trips.getSafetyCapsule(tripId);
        const data = res?.data || null;
        if (!data) throw new Error('No data');

        // Share link
        const share = data.share || null;
        const shareWrap = document.getElementById('safety-capsule-share');
        const shareUrl = document.getElementById('safety-capsule-share-url');
        if (share && share.url && shareWrap && shareUrl) {
            shareUrl.textContent = String(share.url);
            shareUrl.setAttribute('href', String(share.url));
            shareWrap.classList.remove('hidden');
        }

        renderSafetyCapsuleTimeline(data.timeline || []);
    } catch (e) {
        setSafetyCapsuleError('❌ تعذر تحميل تقرير الأمان');
    } finally {
        if (btn) btn.disabled = false;
    }
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
    const distanceEl = document.getElementById('trip-detail-distance');
    const durationEl = document.getElementById('trip-detail-duration');
    if (distanceEl) distanceEl.innerText = `${Number(trip.distance || 0)} كم`;
    if (durationEl) durationEl.innerText = `${Number(trip.duration || 0)} دقيقة`;
    
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

    const phoneLabel = document.getElementById('profile-phone');
    if (phoneLabel) phoneLabel.innerText = user.phone || 'غير محدد';

    const emailLabel = document.getElementById('profile-email');
    if (emailLabel) emailLabel.innerText = user.email || 'غير محدد';

    if (!passengerProfileEdit.editing) {
        const nameInput = document.getElementById('profile-name-input');
        if (nameInput) nameInput.value = user.name || '';
        const phoneInput = document.getElementById('profile-phone-input');
        if (phoneInput) phoneInput.value = user.phone || '';
        const emailInput = document.getElementById('profile-email-input');
        if (emailInput) emailInput.value = user.email || '';
    }
}

const passengerProfileEdit = {
    editing: false,
    originalName: '',
    originalPhone: '',
    originalEmail: '',
    originalAvatar: '',
    pendingAvatar: null
};

function setPassengerProfileEditMode(enabled) {
    passengerProfileEdit.editing = enabled;
    const nameLabel = document.getElementById('profile-name');
    const nameInput = document.getElementById('profile-name-input');
    const phoneLabel = document.getElementById('profile-phone');
    const phoneInput = document.getElementById('profile-phone-input');
    const emailLabel = document.getElementById('profile-email');
    const emailInput = document.getElementById('profile-email-input');
    const passwordMask = document.getElementById('profile-password-mask');
    const passwordWrap = document.getElementById('profile-password-wrap');
    const editBtn = document.getElementById('profile-edit-btn');
    const saveBtn = document.getElementById('profile-save-btn');
    const cancelBtn = document.getElementById('profile-cancel-btn');

    if (nameLabel) nameLabel.classList.toggle('hidden', enabled);
    if (nameInput) nameInput.classList.toggle('hidden', !enabled);
    if (phoneLabel) phoneLabel.classList.toggle('hidden', enabled);
    if (phoneInput) phoneInput.classList.toggle('hidden', !enabled);
    if (emailLabel) emailLabel.classList.toggle('hidden', enabled);
    if (emailInput) emailInput.classList.toggle('hidden', !enabled);
    if (passwordMask) passwordMask.classList.toggle('hidden', enabled);
    if (passwordWrap) passwordWrap.classList.toggle('hidden', !enabled);
    if (editBtn) editBtn.classList.toggle('hidden', enabled);
    if (saveBtn) saveBtn.classList.toggle('hidden', !enabled);
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !enabled);
}

function loadPassengerProfileEditDefaults() {
    const user = DB.getUser();
    if (!user) return;
    passengerProfileEdit.originalName = user.name || '';
    passengerProfileEdit.originalPhone = user.phone || '';
    passengerProfileEdit.originalEmail = user.email || '';
    passengerProfileEdit.originalAvatar = user.avatar || '';
    passengerProfileEdit.pendingAvatar = null;

    const nameInput = document.getElementById('profile-name-input');
    if (nameInput) nameInput.value = passengerProfileEdit.originalName;
    const phoneInput = document.getElementById('profile-phone-input');
    if (phoneInput) phoneInput.value = passengerProfileEdit.originalPhone;
    const emailInput = document.getElementById('profile-email-input');
    if (emailInput) emailInput.value = passengerProfileEdit.originalEmail;
    const passwordInput = document.getElementById('profile-password-input');
    if (passwordInput) passwordInput.value = '';
}

window.editPassengerProfile = function() {
    const user = DB.getUser();
    if (!user) {
        showToast('⚠️ يرجى تسجيل الدخول أولاً');
        return;
    }
    loadPassengerProfileEditDefaults();
    setPassengerProfileEditMode(true);
};

window.savePassengerProfile = async function() {
    const user = DB.getUser();
    if (!user) {
        showToast('⚠️ يرجى تسجيل الدخول أولاً');
        return;
    }

    const nameInput = document.getElementById('profile-name-input');
    const newName = nameInput ? nameInput.value.trim() : '';
    const phoneInput = document.getElementById('profile-phone-input');
    const newPhone = phoneInput ? phoneInput.value.trim() : '';
    const emailInput = document.getElementById('profile-email-input');
    const newEmail = emailInput ? emailInput.value.trim() : '';
    const passwordInput = document.getElementById('profile-password-input');
    const newPassword = passwordInput ? passwordInput.value.trim() : '';
    if (!newName || newName.length < 2) {
        showToast('⚠️ أدخل اسم صحيح');
        if (nameInput) nameInput.focus();
        return;
    }
    if (!newPhone) {
        showToast('⚠️ أدخل رقم الهاتف');
        if (phoneInput) phoneInput.focus();
        return;
    }
    if (!newEmail) {
        showToast('⚠️ أدخل البريد الإلكتروني');
        if (emailInput) emailInput.focus();
        return;
    }
    if (!newEmail.includes('@')) {
        showToast('⚠️ البريد الإلكتروني غير صحيح');
        if (emailInput) emailInput.focus();
        return;
    }
    if (newPassword && newPassword.length < 6) {
        showToast('⚠️ كلمة المرور يجب أن تكون 6 أحرف على الأقل');
        if (passwordInput) passwordInput.focus();
        return;
    }

    const updates = {
        name: newName,
        phone: newPhone,
        email: newEmail
    };
    if (newPassword) {
        updates.password = newPassword;
    }

    try {
        showToast('⏳ جاري الحفظ...');
        const response = await fetch(`/api/passengers/${user.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updates)
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'فشل حفظ البيانات');
        }

        const mergedUser = { ...user, ...result.data };
        if (passengerProfileEdit.pendingAvatar) {
            mergedUser.avatar = passengerProfileEdit.pendingAvatar;
        }

        DB.setUser(mergedUser);
        setPassengerProfileEditMode(false);
        passengerProfileEdit.pendingAvatar = null;
        if (passwordInput) passwordInput.value = '';
        showToast('✅ تم حفظ البيانات');
    } catch (error) {
        console.error('Passenger profile save error:', error);
        const fallbackUpdates = {
            name: newName,
            phone: newPhone,
            email: newEmail
        };
        if (passengerProfileEdit.pendingAvatar) {
            fallbackUpdates.avatar = passengerProfileEdit.pendingAvatar;
        }
        DB.updateUser(fallbackUpdates);
        setPassengerProfileEditMode(false);
        passengerProfileEdit.pendingAvatar = null;
        if (passwordInput) passwordInput.value = '';
        showToast('⚠️ تم حفظ البيانات محلياً');
    }
};

window.cancelPassengerProfile = function() {
    const nameInput = document.getElementById('profile-name-input');
    if (nameInput) nameInput.value = passengerProfileEdit.originalName || '';
    const phoneInput = document.getElementById('profile-phone-input');
    if (phoneInput) phoneInput.value = passengerProfileEdit.originalPhone || '';
    const emailInput = document.getElementById('profile-email-input');
    if (emailInput) emailInput.value = passengerProfileEdit.originalEmail || '';
    const passwordInput = document.getElementById('profile-password-input');
    if (passwordInput) passwordInput.value = '';

    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl && passengerProfileEdit.originalAvatar) {
        avatarEl.src = passengerProfileEdit.originalAvatar;
    }

    passengerProfileEdit.pendingAvatar = null;
    setPassengerProfileEditMode(false);
};

function handlePassengerAvatarSelection(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
        showToast('⚠️ اختر صورة صحيحة');
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target?.result;
        if (!dataUrl) return;
        passengerProfileEdit.pendingAvatar = dataUrl;
        const avatarEl = document.getElementById('profile-avatar');
        if (avatarEl) avatarEl.src = dataUrl;
    };
    reader.readAsDataURL(file);
}

async function updateDriverMenuData() {
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

    const homeNameEl = document.getElementById('driver-home-name');
    if (homeNameEl) homeNameEl.innerText = `أهلاً، ${firstName}`;
    const homeRatingEl = document.getElementById('driver-home-rating');
    if (homeRatingEl) homeRatingEl.innerText = user.rating || '4.8';
    const homeCarTypeEl = document.getElementById('driver-home-car-type');
    if (homeCarTypeEl) homeCarTypeEl.innerText = driverCarLabel;

    // Fetch real-time driver earnings from API (same as profile.html)
    if (user.id) {
        try {
            const response = await ApiService.users.getById(user.id);
            if (response?.success && response?.data) {
                const userData = response.data;
                // Update today's trips and earnings from database
                const homeTodayTripsEl = document.getElementById('driver-home-today-trips');
                if (homeTodayTripsEl) homeTodayTripsEl.innerText = userData.today_trips || 0;
                
                const homeTodayEarningsEl = document.getElementById('driver-home-today-earnings');
                if (homeTodayEarningsEl) {
                    const todayEarnings = parseFloat(userData.today_earnings || 0).toFixed(2);
                    homeTodayEarningsEl.innerText = todayEarnings;
                }
                
                console.log('✅ Driver panel updated with database data:', {
                    today_trips: userData.today_trips,
                    today_earnings: userData.today_earnings
                });
            }
        } catch (error) {
            console.error('⚠️ Failed to fetch driver earnings:', error);
            // Fallback to 0 values
            const homeTodayTripsEl = document.getElementById('driver-home-today-trips');
            if (homeTodayTripsEl) homeTodayTripsEl.innerText = 0;
            const homeTodayEarningsEl = document.getElementById('driver-home-today-earnings');
            if (homeTodayEarningsEl) homeTodayEarningsEl.innerText = '0.00';
        }
    }

    const avatarIds = ['driver-sidebar-avatar', 'driver-nav-avatar'];
    avatarIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.src = user.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=AhmedDriver';
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

function ensurePassengerSession() {
    if (typeof DB !== 'undefined' && DB.hasSession && DB.hasSession()) return true;
    if (typeof window.openAuthModal === 'function') {
        window.openAuthModal();
    }
    return false;
}

function togglePassengerSettings() {
    const panel = document.getElementById('passenger-settings-panel');
    const icon = document.getElementById('passenger-settings-icon');
    const button = document.getElementById('passenger-settings-btn');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isHidden);
    if (icon) icon.classList.toggle('rotate-180', isHidden);
    if (button) button.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
}

function openPassengerSettingsLink(url) {
    if (!ensurePassengerSession()) return false;
    if (url) window.location.href = url;
    return false;
}

window.togglePassengerSettings = togglePassengerSettings;
window.openPassengerSettingsLink = openPassengerSettingsLink;

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

async function finishTrip() {
    if (!activePassengerTripId) {
        showToast('لا توجد رحلة نشطة لإنهائها');
        return;
    }

    const rideDestText = document.getElementById('ride-dest-text');
    const fallbackEstimate = computeTripEstimates();
    const user = DB.getUser();
    const amount = Number(currentTripPrice || 0);

    try {
        const response = await ApiService.trips.updateStatus(activePassengerTripId, 'completed', {
            cost: amount,
            distance: Number(fallbackEstimate.distanceKm || 0),
            duration: Number(fallbackEstimate.etaMin || 0),
            payment_method: 'cash',
            dropoff_location: rideDestText ? rideDestText.innerText : undefined
        });

        if (response?.data) {
            lastCompletedTrip = DB.normalizeTrip(response.data, user?.name);
            DB.upsertTrip(lastCompletedTrip);
        }

        activePassengerTripId = null;
        showToast('تم إنهاء الرحلة');
    } catch (error) {
        console.error('Failed to finish trip:', error);
        showToast('تعذر إنهاء الرحلة حالياً');
    }
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

        const phoneCountrySelect = document.getElementById('phone-country');
        if (phoneCountrySelect) {
            updatePhoneCountryUI();
            phoneCountrySelect.addEventListener('change', updatePhoneCountryUI);
        }
        
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

    const passengerSettingsBtn = document.getElementById('passenger-settings-btn');
    if (passengerSettingsBtn) passengerSettingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        togglePassengerSettings();
    });

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

    const profileEditBtn = document.getElementById('profile-edit-btn');
    if (profileEditBtn) profileEditBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.editPassengerProfile();
    });

    const profileSaveBtn = document.getElementById('profile-save-btn');
    if (profileSaveBtn) profileSaveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.savePassengerProfile();
    });

    const profileCancelBtn = document.getElementById('profile-cancel-btn');
    if (profileCancelBtn) profileCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.cancelPassengerProfile();
    });

    const profileAvatarBtn = document.getElementById('profile-avatar-btn');
    const profileAvatarInput = document.getElementById('profile-avatar-input');
    if (profileAvatarBtn && profileAvatarInput) {
        profileAvatarBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (!passengerProfileEdit.editing) {
                window.editPassengerProfile();
            }
            profileAvatarInput.click();
        });
        profileAvatarInput.addEventListener('change', () => {
            const file = profileAvatarInput.files && profileAvatarInput.files[0];
            handlePassengerAvatarSelection(file);
            profileAvatarInput.value = '';
        });
    }

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
        btn.addEventListener('click', () => {
            const rating = parseInt(btn.dataset.rating);
            passengerRatingValue = rating;

            const scope = btn.closest('[data-rating-scope]') || document;
            scope.querySelectorAll('.star-btn').forEach(b => {
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

    document.querySelectorAll('.driver-star-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const rating = parseInt(btn.dataset.rating);
            driverRatingValue = rating;
            document.querySelectorAll('.driver-star-btn').forEach(b => {
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

window.submitPassengerRating = async function() {
    if (!passengerRatingValue) {
        showToast('يرجى اختيار تقييم أولاً');
        return;
    }

    const tripId = lastCompletedTrip?.id || activePassengerTripId;
    if (!tripId) {
        showToast('تعذر تحديد الرحلة للتقييم');
        resetApp();
        return;
    }

    const commentInput = document.getElementById('passenger-rating-comment');
    const comment = commentInput ? commentInput.value.trim() : '';

    try {
        await ApiService.trips.updateStatus(tripId, 'completed', {
            passenger_rating: passengerRatingValue,
            passenger_review: comment || undefined,
            trip_status: 'rated'
        });
        if (lastCompletedTrip) {
            lastCompletedTrip.rating = passengerRatingValue;
            lastCompletedTrip.passengerRating = passengerRatingValue;
            if (comment) {
                lastCompletedTrip.passengerReview = comment;
            }
        }
        showToast('شكراً لتقييمك!');
    } catch (error) {
        console.error('Failed to submit passenger rating:', error);
        showToast('تعذر إرسال التقييم حالياً');
    } finally {
        passengerRatingValue = 0;
        if (commentInput) commentInput.value = '';

        if (activePassengerTripId) {
            unsubscribeTripRealtime(activePassengerTripId);
        }
        activePassengerTripId = null;
        passengerRealtimeActive = false;

        resetApp();
    }
};

window.submitTripCompletionDone = async function() {
    if (!passengerRatingValue) {
        showToast('يرجى اختيار تقييم أولاً');
        return;
    }

    const tripId = lastCompletedTrip?.id || activePassengerTripId;
    if (!tripId) {
        showToast('تعذر تحديد الرحلة للتقييم');
        resetApp();
        return;
    }

    const commentInput = document.getElementById('payment-success-rating-comment');
    const comment = commentInput ? commentInput.value.trim() : '';

    const btn = document.querySelector('#state-payment-success button[onclick="submitTripCompletionDone()"]');
    if (btn) btn.disabled = true;

    try {
        const resp = await fetch('/rate-driver', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trip_id: String(tripId),
                rating: Number(passengerRatingValue),
                comment: comment || ''
            })
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.success) {
            throw new Error(data?.error || 'Request failed');
        }

        showToast('شكراً لتقييمك!');
    } catch (error) {
        console.error('Failed to rate driver:', error);
        showToast('تعذر إرسال التقييم حالياً');
        if (btn) btn.disabled = false;
        return;
    } finally {
        passengerRatingValue = 0;
        if (commentInput) commentInput.value = '';

        try {
            document.querySelectorAll('[data-rating-scope="passenger"] .star-btn').forEach(b => {
                b.classList.remove('text-yellow-400');
                b.classList.add('text-gray-300');
            });
        } catch (e) {
            // ignore
        }
    }

    if (activePassengerTripId) {
        unsubscribeTripRealtime(activePassengerTripId);
    }
    activePassengerTripId = null;
    passengerRealtimeActive = false;
    lastCompletedTrip = null;

    if (btn) btn.disabled = false;
    resetApp();
};

window.submitDriverPassengerRating = async function() {
    if (!driverRatingValue) {
        showToast('يرجى اختيار تقييم أولاً');
        return;
    }

    const tripId = lastCompletedTrip?.id || activeDriverTripId;
    if (!tripId) {
        showToast('تعذر تحديد الرحلة للتقييم');
        closeDriverTripSummary();
        return;
    }

    const commentInput = document.getElementById('driver-rating-comment');
    const comment = commentInput ? commentInput.value.trim() : '';

    try {
        await ApiService.trips.updateStatus(tripId, 'completed', {
            driver_rating: driverRatingValue,
            driver_review: comment || undefined
        });
        if (lastCompletedTrip) {
            lastCompletedTrip.driverRating = driverRatingValue;
            if (comment) {
                lastCompletedTrip.driverReview = comment;
            }
        }
        showToast('تم إرسال تقييم الراكب');
        closeDriverTripSummary();
    } catch (error) {
        console.error('Failed to submit driver rating:', error);
        showToast('تعذر إرسال التقييم حالياً');
    } finally {
        driverRatingValue = 0;
        if (commentInput) commentInput.value = '';
    }
};

// ========================================
// PAYMENT SYSTEM
// ========================================

let selectedPaymentMethod = null;
let tripDetails = {};
let appliedPromo = null;
let promoDiscount = 0;
let passengerRatingValue = 0;
let driverRatingValue = 0;

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

        // Budget envelope (if configured): if exceeded, block wallet selection
        try {
            const amount = (tripDetails.basePrice || currentTripPrice || 0) - promoDiscount;
            if (amount > 0 && ApiService?.passenger?.checkBudgetEnvelope) {
                ApiService.passenger.checkBudgetEnvelope(amount).then((resp) => {
                    if (resp && resp.success && resp.allowed === false && resp.force_method === 'cash') {
                        showToast('⚠️ الميزانية غير كافية للمحفظة — اختر كاش');
                        selectedPaymentMethod = null;
                        if (confirmBtn) {
                            confirmBtn.disabled = true;
                            confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
                        }
                        document.querySelectorAll('.payment-method-btn').forEach(btn => {
                            const radio = btn.querySelector('.w-5');
                            if (!radio) return;
                            radio.classList.remove('bg-indigo-600', 'border-indigo-600');
                            radio.classList.add('border-gray-300');
                        });
                    }
                }).catch(() => {});
            }
        } catch (e) {
            // ignore
        }
    }
    
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
};

window.applyPromoCode = async function() {
    const promoInput = document.getElementById('promo-code-input');
    const promoResult = document.getElementById('promo-result');
    const code = promoInput.value.trim().toUpperCase();
    
    if (!code) {
        showToast('يرجى إدخال رمز خصم');
        return;
    }
    
    let resolvedOffer = window.getOfferByCode ? window.getOfferByCode(code) : null;

    if (!resolvedOffer) {
        try {
            const data = await ApiService.request(`/offers/validate?code=${encodeURIComponent(code)}`);
            resolvedOffer = data.data ? normalizeOffer(data.data) : null;
        } catch (err) {
            resolvedOffer = null;
        }
    }

    // Mock promo codes (fallback)
    const validPromos = {
        'WELCOME20': 0.20,
        'CITY20': 0.20,
        'SAVE50': 50,
        'SUMMER15': 0.15,
        'FIRST10': 10
    };

    const priceForDiscount = tripDetails.basePrice || currentTripPrice || 0;

    if (resolvedOffer) {
        if (resolvedOffer.discount_type === 'percent') {
            promoDiscount = Math.floor(priceForDiscount * (resolvedOffer.discount_value / 100));
        } else if (resolvedOffer.discount_type === 'fixed') {
            promoDiscount = Math.min(resolvedOffer.discount_value, priceForDiscount);
        } else if (resolvedOffer.discount_type === 'points') {
            promoDiscount = 0;
        } else {
            promoDiscount = 0;
        }

        appliedPromo = code;
        promoResult.classList.remove('hidden');
        if (resolvedOffer.discount_type === 'points') {
            promoResult.innerHTML = `✅ تم تطبيق الكود: ${code} - نقاط مضاعفة`;
        } else {
            promoResult.innerHTML = `✅ تم تطبيق الكود: ${code} - خصم ${promoDiscount} ر.س`;
        }
        promoInput.disabled = true;

        updatePaymentSummary();
        showToast('تم تطبيق الرمز بنجاح!');
        return;
    }

    if (validPromos[code]) {
        const discountValue = validPromos[code];
        if (discountValue < 1) {
            promoDiscount = Math.floor(priceForDiscount * discountValue);
        } else {
            promoDiscount = Math.min(discountValue, priceForDiscount);
        }

        appliedPromo = code;
        promoResult.classList.remove('hidden');
        promoResult.innerHTML = `✅ تم تطبيق الكود: ${code} - خصم ${promoDiscount} ر.س`;
        promoInput.disabled = true;

        updatePaymentSummary();
        showToast('تم تطبيق الرمز بنجاح!');
    } else {
        promoResult.classList.remove('hidden');
        promoResult.innerHTML = '❌ الرمز غير صحيح أو منتهي الصلاحية';
        showToast('رمز خصم غير صحيح');
    }
};

// City tour promo modal
window.openCityTourOffer = function() {
    const modal = document.getElementById('city-tour-modal');
    if (modal) modal.classList.remove('hidden');
};

window.closeCityTourOffer = function() {
    const modal = document.getElementById('city-tour-modal');
    if (modal) modal.classList.add('hidden');
};

window.copyCityTourCode = function() {
    const code = 'CITY20';
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
            showToast('✅ تم نسخ كود الخصم');
        }).catch(() => {
            showToast('انسخ الكود: CITY20');
        });
    } else {
        showToast('انسخ الكود: CITY20');
    }
};

window.goToPaymentPromo = function() {
    closeCityTourOffer();
    const promoInput = document.getElementById('promo-code-input');
    if (promoInput) {
        promoInput.value = 'CITY20';
        showToast('✅ تم إدخال كود الخصم');
        const promoResult = document.getElementById('promo-result');
        if (promoResult) promoResult.classList.add('hidden');
        return;
    }
    showToast('استخدم الكود CITY20 عند الدفع');
};

window.updatePaymentSummary = function() {
    const fallbackEstimate = computeTripEstimates();
    const rawDistance = currentIncomingTrip?.distance ?? lastTripEstimate?.distanceKm ?? fallbackEstimate.distanceKm ?? 0;
    const rawDuration = currentIncomingTrip?.duration ?? lastTripEstimate?.etaMin ?? fallbackEstimate.etaMin ?? 0;
    const distance = Math.max(0, Math.round(Number(rawDistance) * 10) / 10);
    const duration = Math.max(0, Math.round(Number(rawDuration)));
    const carType = currentCarType || currentIncomingTrip?.car_type || 'economy';
    const carTypes = { economy: 'اقتصادي', family: 'عائلي', luxury: 'فاخر', delivery: 'توصيل' };
    
    tripDetails = {
        distance: distance,
        carType: carType,
        duration: duration,
        basePrice: Number(currentTripPrice || currentIncomingTrip?.cost || 25)
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

function getPassengerTripDurationMinutes() {
    if (passengerTripStartedAt) {
        const elapsedMs = Date.now() - passengerTripStartedAt;
        if (elapsedMs > 0) {
            return Math.max(1, Math.round(elapsedMs / 60000));
        }
    }

    const fallbackEstimate = computeTripEstimates();
    const fallback = tripDetails.duration
        || lastTripEstimate?.etaMin
        || fallbackEstimate.etaMin
        || 0;

    return Math.max(1, Math.round(Number(fallback) || 0));
}

function updatePaymentSuccessTripSummary(trip) {
    if (!trip) return;
    const distanceEl = document.getElementById('payment-success-distance');
    const durationEl = document.getElementById('payment-success-duration');
    const tripIdEl = document.getElementById('payment-success-trip-id');
    const pickupEl = document.getElementById('payment-success-pickup');
    const dropoffEl = document.getElementById('payment-success-dropoff');

    if (tripIdEl) tripIdEl.innerText = trip.id || '--';
    if (distanceEl) distanceEl.innerText = `${Number(trip.distance || 0)} كم`;
    if (durationEl) durationEl.innerText = `${Number(trip.duration || 0)} دقيقة`;
    if (pickupEl) pickupEl.innerText = trip.pickup || currentPickup?.label || '--';
    if (dropoffEl) dropoffEl.innerText = trip.dropoff || currentDestination?.label || '--';
}

window.showLastTripDetails = function() {
    if (!lastCompletedTrip?.id) {
        showToast('لا توجد رحلة لعرضها');
        return;
    }
    window.showTripDetails(lastCompletedTrip.id);
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
    let paymentMethod = selectedPaymentMethod;
    const amount = (tripDetails.basePrice || 25) - promoDiscount;
    
    // Simulate payment processing
    const btn = event.target;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> جاري معالجة الدفع...';
    
    setTimeout(async () => {
        const user = DB.getUser();
        if (!activePassengerTripId) {
            showToast('لا توجد رحلة نشطة لإتمام الدفع');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check-circle ml-2"></i> تم - تأكيد الدفع';
            return;
        }
        const actualDuration = getPassengerTripDurationMinutes();

        tripDetails.duration = actualDuration;
        
        // Budget envelope enforcement: auto-switch to cash when exceeded
        if (paymentMethod === 'wallet') {
            try {
                if (ApiService?.passenger?.checkBudgetEnvelope) {
                    const chk = await ApiService.passenger.checkBudgetEnvelope(amount);
                    if (chk && chk.success && chk.allowed === false && chk.force_method === 'cash') {
                        paymentMethod = 'cash';
                        showToast('⚠️ الميزانية غير كافية للمحفظة — تم التحويل إلى كاش');
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        if (user) {
            const newBalance = paymentMethod === 'wallet' 
                ? user.balance - amount
                : user.balance;
            let pointsEarned = Math.floor(amount / 5);
            if (appliedPromo === 'DOUBLEPTS') {
                pointsEarned *= 2;
            }
            DB.updateUser({
                balance: newBalance,
                points: user.points + pointsEarned
            });
        }

        try {
            const response = await ApiService.trips.updateStatus(activePassengerTripId, 'completed', {
                cost: amount,
                distance: tripDetails.distance,
                duration: actualDuration,
                payment_method: paymentMethod
            });
            if (response?.data) {
                lastCompletedTrip = DB.normalizeTrip(response.data, user?.name);
                DB.upsertTrip(lastCompletedTrip);
                updatePaymentSuccessTripSummary(lastCompletedTrip);
                activePassengerTripId = null;
            } else {
                showToast('تعذر تأكيد الدفع حالياً');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-check-circle ml-2"></i> تم - تأكيد الدفع';
                return;
            }
        } catch (err) {
            console.error('Failed to finalize trip:', err);
            showToast('تعذر إتمام الدفع الآن، حاول مرة أخرى');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check-circle ml-2"></i> تم - تأكيد الدفع';
            return;
        }
        
        const paymentLabels = { cash: 'دفع كاش', card: 'بطاقة بنكية', wallet: 'محفظة إلكترونية' };
        showToast(`تم الدفع: ${amount} ر.س عبر ${paymentMethod === 'cash' ? 'كاش' : paymentMethod === 'card' ? 'بطاقة' : 'محفظة'}`);
        
        // Reset payment data
        selectedPaymentMethod = null;
        appliedPromo = null;
        promoDiscount = 0;
        SafeStorage.removeItem('akwadra_active_offer');
        passengerTripStartedAt = null;
        
        // Show payment confirmation
        const amountEl = document.getElementById('payment-success-amount');
        const methodEl = document.getElementById('payment-success-method');
        const timeEl = document.getElementById('payment-success-time');
        if (amountEl) amountEl.innerText = `${amount} ر.س`;
        if (methodEl) methodEl.innerText = paymentLabels[paymentMethod] || 'دفع كاش';
        if (timeEl) timeEl.innerText = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        updatePaymentSuccessTripSummary(lastCompletedTrip);

        window.switchSection('payment-success');
        if (typeof window.driverEndTrip === 'function') {
            window.driverEndTrip();
        }

        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle ml-2"></i> تم - تأكيد الدفع';
    }, 2000);
};

window.applyStoredOfferToPayment = function() {
    const storedOffer = SafeStorage.getItem('akwadra_active_offer');
    if (storedOffer) {
        const promoInput = document.getElementById('promo-code-input');
        if (promoInput) {
            promoInput.value = storedOffer;
            window.applyPromoCode();
        }
    }
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
    window.applyStoredOfferToPayment();
};

// ========================================
// PANEL DRAG CONTROL (Swipe to minimize/maximize)
// ========================================

let panelDragStartY = 0;
let panelCurrentHeight = 85; // in vh
let isDraggingPanel = false;

let panelMinHeight = 10;
let panelMidHeight = 50;
let panelMaxHeight = 85;
let panelDragPreset = 'default';

function applyPanelHeightVh(vh, animate = true) {
    const panel = document.getElementById('main-panel');
    if (!panel) return;
    panel.style.transition = animate ? 'max-height 0.3s ease-in-out' : 'none';
    panel.style.maxHeight = `${vh}vh`;
    panelCurrentHeight = vh;
}

function setPanelDragPreset(preset) {
    if (preset === 'trip-completion') {
        panelDragPreset = 'trip-completion';
        panelMinHeight = 60;
        panelMidHeight = 60;
        panelMaxHeight = 95;
        applyPanelHeightVh(60, true);
        return;
    }

    panelDragPreset = 'default';
    panelMinHeight = 10;
    panelMidHeight = 50;
    panelMaxHeight = 85;

    const next = Math.max(panelMinHeight, Math.min(panelMaxHeight, Number(panelCurrentHeight) || panelMaxHeight));
    applyPanelHeightVh(next, true);
}

function configurePassengerMainPanelForSection(name) {
    const panel = document.getElementById('main-panel');
    if (!panel) return;

    if (name === 'payment-success') {
        setPanelDragPreset('trip-completion');
        return;
    }

    if (panelDragPreset === 'trip-completion') {
        setPanelDragPreset('default');
    }
}

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
    
    // Constrain based on current preset
    const constrainedHeight = Math.max(panelMinHeight, Math.min(panelMaxHeight, newHeightVh));
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
        if (panelDragPreset === 'trip-completion') {
            const midpoint = (panelMinHeight + panelMaxHeight) / 2;
            if (currentMaxHeight < midpoint) {
                panel.style.maxHeight = `${panelMinHeight}vh`;
                panelCurrentHeight = panelMinHeight;
            } else {
                panel.style.maxHeight = `${panelMaxHeight}vh`;
                panelCurrentHeight = panelMaxHeight;
            }
        } else {
            if (currentMaxHeight < 30) {
                panel.style.maxHeight = `${panelMinHeight}vh`;
                panelCurrentHeight = panelMinHeight;
            } else if (currentMaxHeight < 60) {
                panel.style.maxHeight = `${panelMidHeight}vh`;
                panelCurrentHeight = panelMidHeight;
            } else {
                panel.style.maxHeight = `${panelMaxHeight}vh`;
                panelCurrentHeight = panelMaxHeight;
            }
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
    resetSafetyCapsuleUI();
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
    const distanceEl = document.getElementById('trip-detail-distance');
    const durationEl = document.getElementById('trip-detail-duration');
    if (distanceEl) distanceEl.innerText = `${Number(trip.distance || 0)} كم`;
    if (durationEl) durationEl.innerText = `${Number(trip.duration || 0)} دقيقة`;
    
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

    if (section === 'driver') {
        resetDriverInfoPanel();
    }
    
    const user = DB.getUser();
    if (section === 'profile' && user && user.role === 'passenger') {
        renderTripHistory('trip-history-container', 3);
    } else if (section === 'trip-history') {
        renderAllTrips();
    } else if (section === 'offers') {
        renderOffers();
    } else if (section === 'payment-method') {
        initPaymentFlow();
    } else if (section === 'payment-invoice') {
        window.applyStoredOfferToPayment();
    }
};