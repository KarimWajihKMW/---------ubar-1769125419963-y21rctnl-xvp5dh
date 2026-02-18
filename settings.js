const DARK_MODE_KEY = 'akwadra_dark_mode';

function getRole() {
    const params = new URLSearchParams(window.location.search);
    const role = params.get('role');
    if (role === 'driver' || role === 'admin') return role;
    return 'passenger';
}

const ROLE = getRole();
const PREF_KEY = ROLE === 'driver'
    ? 'akwadra_driver_prefs'
    : ROLE === 'admin'
        ? 'akwadra_admin_prefs'
        : 'akwadra_passenger_prefs';

const BASE_PREF_DEFAULTS = {
    trips: true,
    marketing: false,
    location: true,
    language: 'ar'
};

const DRIVER_PREF_DEFAULTS = {
    ...BASE_PREF_DEFAULTS,
    autoAccept: false,
    soundAlerts: true,
    shareLocation: true,
    breakReminder: true
};

const PASSENGER_PREF_DEFAULTS = BASE_PREF_DEFAULTS;

const LANGUAGES = [
    'aa','ab','ae','af','ak','am','an','ar','as','av','ay','az','ba','be','bg','bh','bi','bm','bn','bo','br','bs','ca','ce','ch','co','cr','cs','cu','cv','cy','da','de','dv','dz','ee','el','en','eo','es','et','eu','fa','ff','fi','fj','fo','fr','fy','ga','gd','gl','gn','gu','gv','ha','he','hi','ho','hr','ht','hu','hy','hz','ia','id','ie','ig','ii','ik','io','is','it','iu','ja','jv','ka','kg','ki','kj','kk','kl','km','kn','ko','kr','ks','ku','kv','kw','ky','la','lb','lg','li','ln','lo','lt','lu','lv','mg','mh','mi','mk','ml','mn','mr','ms','mt','my','na','nb','nd','ne','ng','nl','nn','no','nr','nv','ny','oc','oj','om','or','os','pa','pi','pl','ps','pt','qu','rm','rn','ro','ru','rw','sa','sc','sd','se','sg','si','sk','sl','sm','sn','so','sq','sr','ss','st','su','sv','sw','ta','te','tg','th','ti','tk','tl','tn','to','tr','ts','tt','tw','ty','ug','uk','ur','uz','ve','vi','vo','wa','wo','xh','yi','yo','za','zh','zu'
];

const RTL_LANGS = new Set(['ar','fa','he','ur','ps','sd','ug','dv','ku','yi']);

function applyLanguage(code) {
    if (!code) return;
    document.documentElement.lang = code;
    document.documentElement.dir = RTL_LANGS.has(code) ? 'rtl' : 'ltr';
}

function populateLanguages() {
    const select = document.getElementById('pref-language');
    if (!select) return;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'اختر اللغة';
    select.appendChild(placeholder);

    let displayNames = null;
    try {
        displayNames = new Intl.DisplayNames(['ar'], { type: 'language' });
    } catch (e) {
        displayNames = null;
    }

    LANGUAGES.forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        const label = displayNames ? displayNames.of(code) : null;
        opt.textContent = label ? `${label} (${code})` : code;
        select.appendChild(opt);
    });
}

function updateDarkModeToggleUI() {
    const isDark = document.body.classList.contains('dark-mode');
    const label = document.getElementById('settings-dark-label');
    const icon = document.getElementById('settings-dark-icon');
    if (label) label.textContent = isDark ? 'مفعل' : 'غير مفعل';
    if (icon) {
        icon.classList.toggle('fa-moon', !isDark);
        icon.classList.toggle('fa-sun', isDark);
    }
}

function applyRoleUI() {
    const isDriver = ROLE === 'driver';
    document.querySelectorAll('.role-driver-only').forEach(el => {
        el.style.display = isDriver ? '' : 'none';
    });
    const title = document.getElementById('settings-title');
    const subtitle = document.getElementById('settings-subtitle');
    if (title) {
        title.textContent = isDriver
            ? '⚙️ إعدادات الكابتن'
            : ROLE === 'admin'
                ? '⚙️ إعدادات الإدارة'
                : '⚙️ إعدادات الراكب';
    }
    if (subtitle) {
        subtitle.textContent = isDriver
            ? 'اضبط تفضيلاتك أثناء القيادة'
            : ROLE === 'admin'
                ? 'اضبط تفضيلات لوحة الإدارة'
                : 'اضبط تفضيلاتك بسهولة';
    }
    document.title = isDriver
        ? 'إعدادات الكابتن - أكوادرا'
        : ROLE === 'admin'
            ? 'إعدادات الإدارة - أكوادرا'
            : 'إعدادات الراكب - أكوادرا';
}

function setDarkMode(enabled) {
    document.body.classList.toggle('dark-mode', enabled);
    try { localStorage.setItem(DARK_MODE_KEY, enabled ? '1' : '0'); } catch (e) {}
    updateDarkModeToggleUI();
}

function toggleDarkMode() {
    const isDark = document.body.classList.contains('dark-mode');
    setDarkMode(!isDark);
}

function getReturnTo() {
    const params = new URLSearchParams(window.location.search);
    return params.get('returnTo');
}

function goBack() {
    const returnTo = getReturnTo();
    if (returnTo) {
        window.location.href = returnTo;
        return;
    }
    window.location.href = 'index.html';
}

function loadUser() {
    try {
        const raw = localStorage.getItem('akwadra_user');
        if (!raw) return;
        const user = JSON.parse(raw);
        const nameEl = document.getElementById('settings-user-name');
        const emailEl = document.getElementById('settings-user-email');
        const phoneEl = document.getElementById('settings-user-phone');
        if (nameEl) nameEl.textContent = user.name || '—';
        if (emailEl) emailEl.textContent = user.email || '—';
        if (phoneEl) phoneEl.textContent = user.phone || '—';
    } catch (e) {
        // ignore
    }
}

function getToken() {
    try { return localStorage.getItem('akwadra_token'); } catch (e) { return null; }
}

async function apiJson(path, options = {}) {
    const token = getToken();
    const headers = {
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data };
}

// ==================== Captain-only (Driver) Settings ====================

let cachedAuthMe = null;
async function getAuthMe() {
    if (cachedAuthMe) return cachedAuthMe;
    if (!getToken()) return null;
    const { res, data } = await apiJson('/api/auth/me');
    if (!res.ok || !data.success) return null;
    cachedAuthMe = data;
    return cachedAuthMe;
}

async function getDriverIdFromAuth() {
    const me = await getAuthMe();
    const driverId = me?.auth?.driver_id;
    const n = driverId !== undefined && driverId !== null ? Number(driverId) : null;
    return Number.isFinite(n) && n > 0 ? n : null;
}

function setStatus(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '';
}

function parseJsonTextarea(id) {
    const el = document.getElementById(id);
    if (!el) return { ok: true, value: null };
    const raw = String(el.value || '').trim();
    if (!raw) return { ok: true, value: null };
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (e) {
        return { ok: false, value: null, error: 'invalid_json' };
    }
}

function setJsonTextarea(id, obj) {
    const el = document.getElementById(id);
    if (!el) return;
    if (obj === undefined || obj === null || obj === '') {
        el.value = '';
        return;
    }
    try {
        el.value = JSON.stringify(obj);
    } catch (e) {
        el.value = '';
    }
}

async function loadCaptainAcceptanceRules() {
    const statusId = 'cap-rules-status';
    const minFareEl = document.getElementById('cap-min-fare');
    const maxPickupEl = document.getElementById('cap-max-pickup-km');
    if (!minFareEl || !maxPickupEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول ككابتن لعرض/حفظ القواعد.');
        return;
    }

    setStatus(statusId, 'جاري التحميل...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/acceptance-rules`);
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر تحميل القواعد.');
        return;
    }

    const row = data.data || null;
    minFareEl.value = row && row.min_fare !== null && row.min_fare !== undefined ? String(row.min_fare) : '';
    maxPickupEl.value = row && row.max_pickup_distance_km !== null && row.max_pickup_distance_km !== undefined ? String(row.max_pickup_distance_km) : '';
    setJsonTextarea('cap-excluded-zones', row ? row.excluded_zones_json : null);
    setJsonTextarea('cap-preferred-axis', row ? row.preferred_axis_json : null);
    setStatus(statusId, 'تم تحميل القواعد.');
}

async function saveCaptainAcceptanceRules() {
    const statusId = 'cap-rules-status';
    const minFareEl = document.getElementById('cap-min-fare');
    const maxPickupEl = document.getElementById('cap-max-pickup-km');
    if (!minFareEl || !maxPickupEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول أولاً.');
        return;
    }

    const minFare = minFareEl.value !== '' ? Number(minFareEl.value) : null;
    const maxPickup = maxPickupEl.value !== '' ? Number(maxPickupEl.value) : null;
    const excluded = parseJsonTextarea('cap-excluded-zones');
    if (!excluded.ok) {
        setStatus(statusId, 'صيغة JSON لاستبعاد المناطق غير صحيحة.');
        return;
    }
    const axis = parseJsonTextarea('cap-preferred-axis');
    if (!axis.ok) {
        setStatus(statusId, 'صيغة JSON لتفضيل الاتجاه غير صحيحة.');
        return;
    }

    const payload = {
        min_fare: Number.isFinite(minFare) ? minFare : null,
        max_pickup_distance_km: Number.isFinite(maxPickup) ? maxPickup : null,
        excluded_zones_json: excluded.value,
        preferred_axis_json: axis.value
    };

    setStatus(statusId, 'جاري الحفظ...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/acceptance-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر حفظ القواعد.');
        return;
    }
    setStatus(statusId, '✅ تم حفظ القواعد.');
}

async function loadCaptainGoHome() {
    const statusId = 'cap-gohome-status';
    const enabledEl = document.getElementById('cap-gohome-enabled');
    const latEl = document.getElementById('cap-home-lat');
    const lngEl = document.getElementById('cap-home-lng');
    const detourEl = document.getElementById('cap-gohome-detour');
    if (!enabledEl || !latEl || !lngEl || !detourEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول ككابتن لعرض/حفظ راجع البيت.');
        return;
    }

    setStatus(statusId, 'جاري التحميل...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/go-home`);
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر تحميل راجع البيت.');
        return;
    }

    const row = data.data || null;
    enabledEl.checked = row ? !!row.enabled : false;
    latEl.value = row && row.home_lat !== null && row.home_lat !== undefined ? String(row.home_lat) : '';
    lngEl.value = row && row.home_lng !== null && row.home_lng !== undefined ? String(row.home_lng) : '';
    detourEl.value = row && row.max_detour_km !== null && row.max_detour_km !== undefined ? String(row.max_detour_km) : '2';
    setStatus(statusId, 'تم تحميل راجع البيت.');
}

async function saveCaptainGoHome() {
    const statusId = 'cap-gohome-status';
    const enabledEl = document.getElementById('cap-gohome-enabled');
    const latEl = document.getElementById('cap-home-lat');
    const lngEl = document.getElementById('cap-home-lng');
    const detourEl = document.getElementById('cap-gohome-detour');
    if (!enabledEl || !latEl || !lngEl || !detourEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول أولاً.');
        return;
    }

    const payload = {
        enabled: !!enabledEl.checked,
        home_lat: latEl.value !== '' ? Number(latEl.value) : null,
        home_lng: lngEl.value !== '' ? Number(lngEl.value) : null,
        max_detour_km: detourEl.value !== '' ? Number(detourEl.value) : null
    };

    setStatus(statusId, 'جاري الحفظ...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/go-home`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر حفظ راجع البيت.');
        return;
    }
    setStatus(statusId, '✅ تم حفظ راجع البيت.');
}

async function loadCaptainGoals() {
    const statusId = 'cap-goals-status';
    const dailyEl = document.getElementById('cap-goal-daily');
    const weeklyEl = document.getElementById('cap-goal-weekly');
    if (!dailyEl || !weeklyEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول ككابتن لعرض/حفظ الأهداف.');
        return;
    }

    setStatus(statusId, 'جاري التحميل...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/goals`);
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر تحميل الأهداف.');
        return;
    }

    const row = data.data || null;
    dailyEl.value = row && row.daily_target !== null && row.daily_target !== undefined ? String(row.daily_target) : '';
    weeklyEl.value = row && row.weekly_target !== null && row.weekly_target !== undefined ? String(row.weekly_target) : '';
    setStatus(statusId, 'تم تحميل الأهداف.');
}

async function saveCaptainGoals() {
    const statusId = 'cap-goals-status';
    const dailyEl = document.getElementById('cap-goal-daily');
    const weeklyEl = document.getElementById('cap-goal-weekly');
    if (!dailyEl || !weeklyEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول أولاً.');
        return;
    }

    const payload = {
        daily_target: dailyEl.value !== '' ? Number(dailyEl.value) : null,
        weekly_target: weeklyEl.value !== '' ? Number(weeklyEl.value) : null
    };

    setStatus(statusId, 'جاري الحفظ...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/goals`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر حفظ الأهداف.');
        return;
    }
    setStatus(statusId, '✅ تم حفظ الأهداف.');
}

async function loadCaptainFatigue() {
    const statusId = 'cap-fatigue-status';
    const enabledEl = document.getElementById('cap-fatigue-enabled');
    const limitEl = document.getElementById('cap-fatigue-limit');
    if (!enabledEl || !limitEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول ككابتن لعرض/حفظ مدير الإرهاق.');
        return;
    }

    setStatus(statusId, 'جاري التحميل...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/fatigue/today`);
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر تحميل مدير الإرهاق.');
        return;
    }

    const row = data.data || null;
    enabledEl.checked = row ? !!row.enabled : true;
    limitEl.value = row && row.safe_limit_minutes !== null && row.safe_limit_minutes !== undefined ? String(row.safe_limit_minutes) : '480';
    setStatus(statusId, 'تم تحميل مدير الإرهاق.');
}

async function saveCaptainFatigue() {
    const statusId = 'cap-fatigue-status';
    const enabledEl = document.getElementById('cap-fatigue-enabled');
    const limitEl = document.getElementById('cap-fatigue-limit');
    if (!enabledEl || !limitEl) return;

    const driverId = await getDriverIdFromAuth();
    if (!driverId) {
        setStatus(statusId, 'سجّل الدخول أولاً.');
        return;
    }

    const payload = {
        enabled: !!enabledEl.checked,
        safe_limit_minutes: limitEl.value !== '' ? Number(limitEl.value) : null
    };

    setStatus(statusId, 'جاري الحفظ...');
    const { res, data } = await apiJson(`/api/drivers/${encodeURIComponent(String(driverId))}/captain/fatigue/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر حفظ مدير الإرهاق.');
        return;
    }
    setStatus(statusId, '✅ تم حفظ مدير الإرهاق.');
}

function setDriverEmergencyInputsEnabled(enabled) {
    const ids = ['cap-em-name', 'cap-em-channel', 'cap-em-value', 'cap-em-med'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
}

async function loadDriverEmergencyProfile() {
    const statusId = 'cap-emergency-status';
    const optEl = document.getElementById('cap-em-opt-in');
    const nameEl = document.getElementById('cap-em-name');
    const chanEl = document.getElementById('cap-em-channel');
    const valEl = document.getElementById('cap-em-value');
    const medEl = document.getElementById('cap-em-med');
    if (!optEl || !nameEl || !chanEl || !valEl || !medEl) return;

    if (!getToken()) {
        setDriverEmergencyInputsEnabled(false);
        setStatus(statusId, 'سجّل الدخول ككابتن لعرض/حفظ جهة الطوارئ.');
        return;
    }

    setStatus(statusId, 'جاري التحميل...');
    const { res, data } = await apiJson('/api/drivers/me/emergency-profile');
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر تحميل جهة الطوارئ.');
        return;
    }

    const row = data.data || null;
    optEl.checked = row ? !!row.opt_in : false;
    nameEl.value = row?.contact_name ? String(row.contact_name) : '';
    chanEl.value = row?.contact_channel ? String(row.contact_channel) : 'phone';
    valEl.value = row?.contact_value ? String(row.contact_value) : '';
    medEl.value = row?.medical_note ? String(row.medical_note) : '';
    setDriverEmergencyInputsEnabled(!!optEl.checked);
    setStatus(statusId, 'تم تحميل جهة الطوارئ.');
}

async function saveDriverEmergencyProfile() {
    const statusId = 'cap-emergency-status';
    const optEl = document.getElementById('cap-em-opt-in');
    const nameEl = document.getElementById('cap-em-name');
    const chanEl = document.getElementById('cap-em-channel');
    const valEl = document.getElementById('cap-em-value');
    const medEl = document.getElementById('cap-em-med');
    if (!optEl || !nameEl || !chanEl || !valEl || !medEl) return;

    if (!getToken()) {
        setStatus(statusId, 'سجّل الدخول أولاً.');
        return;
    }

    const payload = {
        opt_in: !!optEl.checked,
        contact_name: nameEl.value ? String(nameEl.value) : null,
        contact_channel: chanEl.value ? String(chanEl.value) : 'phone',
        contact_value: valEl.value ? String(valEl.value) : null,
        medical_note: medEl.value ? String(medEl.value) : null
    };

    setStatus(statusId, 'جاري الحفظ...');
    const { res, data } = await apiJson('/api/drivers/me/emergency-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setStatus(statusId, 'تعذر حفظ جهة الطوارئ.');
        return;
    }
    setDriverEmergencyInputsEnabled(!!optEl.checked);
    setStatus(statusId, '✅ تم حفظ جهة الطوارئ.');
}

async function loadBudgetEnvelope() {
    const enabledEl = document.getElementById('budget-enabled');
    const dailyEl = document.getElementById('budget-daily');
    const weeklyEl = document.getElementById('budget-weekly');
    const statusEl = document.getElementById('budget-status');
    if (!enabledEl || !dailyEl || !weeklyEl) return;

    if (!getToken()) {
        if (statusEl) statusEl.textContent = 'سجّل الدخول لعرض/حفظ الميزانية.';
        return;
    }

    if (statusEl) statusEl.textContent = 'جاري التحميل...';
    const { res, data } = await apiJson('/api/passengers/me/budget-envelope');
    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر تحميل الميزانية.';
        return;
    }

    const row = data.data || null;
    enabledEl.checked = row ? !!row.enabled : false;
    dailyEl.value = row && row.daily_limit !== null && row.daily_limit !== undefined ? String(row.daily_limit) : '';
    weeklyEl.value = row && row.weekly_limit !== null && row.weekly_limit !== undefined ? String(row.weekly_limit) : '';
    if (statusEl) statusEl.textContent = 'تم تحميل الميزانية.';
}

async function saveBudgetEnvelope() {
    const enabledEl = document.getElementById('budget-enabled');
    const dailyEl = document.getElementById('budget-daily');
    const weeklyEl = document.getElementById('budget-weekly');
    const statusEl = document.getElementById('budget-status');
    if (!enabledEl || !dailyEl || !weeklyEl) return;

    if (!getToken()) {
        if (statusEl) statusEl.textContent = 'سجّل الدخول أولاً.';
        return;
    }

    const daily = dailyEl.value !== '' ? Number(dailyEl.value) : null;
    const weekly = weeklyEl.value !== '' ? Number(weeklyEl.value) : null;
    const payload = {
        enabled: !!enabledEl.checked,
        daily_limit: daily,
        weekly_limit: weekly
    };

    if (statusEl) statusEl.textContent = 'جاري الحفظ...';
    const { res, data } = await apiJson('/api/passengers/me/budget-envelope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر حفظ الميزانية.';
        return;
    }
    if (statusEl) statusEl.textContent = '✅ تم حفظ الميزانية.';
}

async function loadAccessibilityProfile() {
    const statusEl = document.getElementById('acc-status');
    const voiceEl = document.getElementById('acc-voice-prompts');
    const textEl = document.getElementById('acc-text-first');
    const noCallsEl = document.getElementById('acc-no-calls');
    const wheelEl = document.getElementById('acc-wheelchair');
    const extraEl = document.getElementById('acc-extra-time');
    const simpleEl = document.getElementById('acc-simple-language');
    const notesEl = document.getElementById('acc-notes');
    if (!voiceEl || !textEl || !noCallsEl || !wheelEl || !extraEl || !simpleEl || !notesEl) return;

    if (!getToken()) {
        if (statusEl) statusEl.textContent = 'سجّل الدخول لعرض/حفظ ملف الإتاحة.';
        return;
    }

    if (statusEl) statusEl.textContent = 'جاري التحميل...';
    const { res, data } = await apiJson('/api/passengers/me/accessibility');
    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر تحميل ملف الإتاحة.';
        return;
    }

    const row = data.data || {};
    voiceEl.checked = !!row.voice_prompts;
    textEl.checked = !!row.text_first;
    noCallsEl.checked = !!row.no_calls;
    wheelEl.checked = !!row.wheelchair;
    extraEl.checked = !!row.extra_time;
    simpleEl.checked = !!row.simple_language;
    notesEl.value = row.notes ? String(row.notes) : '';
    if (statusEl) statusEl.textContent = 'تم تحميل ملف الإتاحة.';
}

async function saveAccessibilityProfile() {
    const statusEl = document.getElementById('acc-status');
    const voiceEl = document.getElementById('acc-voice-prompts');
    const textEl = document.getElementById('acc-text-first');
    const noCallsEl = document.getElementById('acc-no-calls');
    const wheelEl = document.getElementById('acc-wheelchair');
    const extraEl = document.getElementById('acc-extra-time');
    const simpleEl = document.getElementById('acc-simple-language');
    const notesEl = document.getElementById('acc-notes');
    if (!voiceEl || !textEl || !noCallsEl || !wheelEl || !extraEl || !simpleEl || !notesEl) return;

    if (!getToken()) {
        if (statusEl) statusEl.textContent = 'سجّل الدخول أولاً.';
        return;
    }

    const payload = {
        voice_prompts: !!voiceEl.checked,
        text_first: !!textEl.checked,
        no_calls: !!noCallsEl.checked,
        wheelchair: !!wheelEl.checked,
        extra_time: !!extraEl.checked,
        simple_language: !!simpleEl.checked,
        notes: notesEl.value ? String(notesEl.value) : null
    };

    if (statusEl) statusEl.textContent = 'جاري الحفظ...';
    const { res, data } = await apiJson('/api/passengers/me/accessibility', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر حفظ ملف الإتاحة.';
        return;
    }
    if (statusEl) statusEl.textContent = '✅ تم حفظ ملف الإتاحة.';
}

function setEmergencyInputsEnabled(enabled) {
    const ids = ['em-contact-name', 'em-contact-channel', 'em-contact-value', 'em-medical-note'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
}

async function loadEmergencyProfile() {
    const statusEl = document.getElementById('em-status');
    const optEl = document.getElementById('em-opt-in');
    const nameEl = document.getElementById('em-contact-name');
    const chanEl = document.getElementById('em-contact-channel');
    const valEl = document.getElementById('em-contact-value');
    const medEl = document.getElementById('em-medical-note');
    if (!optEl || !nameEl || !chanEl || !valEl || !medEl) return;

    if (!getToken()) {
        setEmergencyInputsEnabled(false);
        if (statusEl) statusEl.textContent = 'سجّل الدخول لعرض/حفظ بطاقة الطوارئ.';
        return;
    }

    if (statusEl) statusEl.textContent = 'جاري التحميل...';
    const { res, data } = await apiJson('/api/passengers/me/emergency-profile');
    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر تحميل بطاقة الطوارئ.';
        return;
    }

    const row = data.data || {};
    optEl.checked = !!row.opt_in;
    nameEl.value = row.contact_name ? String(row.contact_name) : '';
    chanEl.value = row.contact_channel ? String(row.contact_channel) : 'phone';
    valEl.value = row.contact_value ? String(row.contact_value) : '';
    medEl.value = row.medical_note ? String(row.medical_note) : '';
    setEmergencyInputsEnabled(!!optEl.checked);
    if (statusEl) statusEl.textContent = 'تم تحميل بطاقة الطوارئ.';
}

async function saveEmergencyProfile() {
    const statusEl = document.getElementById('em-status');
    const optEl = document.getElementById('em-opt-in');
    const nameEl = document.getElementById('em-contact-name');
    const chanEl = document.getElementById('em-contact-channel');
    const valEl = document.getElementById('em-contact-value');
    const medEl = document.getElementById('em-medical-note');
    if (!optEl || !nameEl || !chanEl || !valEl || !medEl) return;

    if (!getToken()) {
        if (statusEl) statusEl.textContent = 'سجّل الدخول أولاً.';
        return;
    }

    const payload = {
        opt_in: !!optEl.checked,
        contact_name: nameEl.value ? String(nameEl.value) : null,
        contact_channel: chanEl.value ? String(chanEl.value) : 'phone',
        contact_value: valEl.value ? String(valEl.value) : null,
        medical_note: medEl.value ? String(medEl.value) : null
    };

    if (statusEl) statusEl.textContent = 'جاري الحفظ...';
    const { res, data } = await apiJson('/api/passengers/me/emergency-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok || !data.success) {
        if (statusEl) statusEl.textContent = 'تعذر حفظ بطاقة الطوارئ.';
        return;
    }
    setEmergencyInputsEnabled(!!optEl.checked);
    if (statusEl) statusEl.textContent = '✅ تم حفظ بطاقة الطوارئ.';
}

// ==================== Passenger Features (v3) ====================

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '';
}

function renderSavedPlaces(rows) {
    const list = document.getElementById('sp-list');
    if (!list) return;
    const items = Array.isArray(rows) ? rows : [];
    if (!items.length) {
        list.innerHTML = '<div class="text-xs text-gray-500 font-bold">لا توجد أماكن محفوظة.</div>';
        return;
    }

    const labelMap = { home: 'البيت', work: 'الشغل', custom: 'محفوظ' };
    list.innerHTML = items.map((p) => {
        const label = labelMap[String(p.label || '').toLowerCase()] || (p.label || 'place');
        const name = p.name || '—';
        const coords = (p.lat !== null && p.lng !== null) ? `${p.lat}, ${p.lng}` : '';
        return `
            <div class="bg-white rounded-xl border border-gray-200 px-3 py-2 flex items-center justify-between">
                <div class="text-right">
                    <div class="text-xs text-gray-500 font-bold">${label}</div>
                    <div class="text-sm text-gray-800 font-extrabold">${name}</div>
                    <div class="text-[11px] text-gray-500 font-bold">${coords}</div>
                </div>
                <button type="button" class="sp-del text-xs font-extrabold text-red-600 hover:text-red-700" data-id="${String(p.id)}">حذف</button>
            </div>
        `;
    }).join('');

    list.querySelectorAll('button.sp-del[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = Number(btn.getAttribute('data-id'));
            if (!Number.isFinite(id) || id <= 0) return;
            deleteSavedPlace(id).catch(() => {});
        });
    });
}

async function loadSavedPlacesUI() {
    if (!getToken()) {
        setText('sp-status', 'سجّل الدخول لإدارة الأماكن المحفوظة.');
        renderSavedPlaces([]);
        return;
    }
    setText('sp-status', 'جاري التحميل...');
    const { res, data } = await apiJson('/api/passengers/me/places');
    if (!res.ok || !data.success) {
        setText('sp-status', 'تعذر تحميل الأماكن.');
        renderSavedPlaces([]);
        return;
    }
    setText('sp-status', '');
    renderSavedPlaces(data.data || []);
}

async function saveSavedPlaceUI() {
    if (!getToken()) {
        setText('sp-status', 'سجّل الدخول أولاً.');
        return;
    }

    const label = document.getElementById('sp-label')?.value || 'custom';
    const name = document.getElementById('sp-name')?.value?.trim() || '';
    const lat = document.getElementById('sp-lat')?.value !== '' ? Number(document.getElementById('sp-lat').value) : null;
    const lng = document.getElementById('sp-lng')?.value !== '' ? Number(document.getElementById('sp-lng').value) : null;
    const notes = document.getElementById('sp-notes')?.value?.trim() || '';

    if (!name) {
        setText('sp-status', 'اكتب الاسم.');
        return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setText('sp-status', 'إحداثيات غير صحيحة.');
        return;
    }

    setText('sp-status', 'جاري الحفظ...');
    const { res, data } = await apiJson('/api/passengers/me/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, name, lat, lng, notes })
    });
    if (!res.ok || !data.success) {
        setText('sp-status', 'تعذر حفظ المكان.');
        return;
    }
    setText('sp-status', '✅ تم الحفظ.');
    await loadSavedPlacesUI();
}

async function deleteSavedPlace(id) {
    if (!getToken()) return;
    setText('sp-status', 'جاري الحذف...');
    const { res, data } = await apiJson(`/api/passengers/me/places/${encodeURIComponent(String(id))}`, {
        method: 'DELETE'
    });
    if (!res.ok || !data.success) {
        setText('sp-status', 'تعذر حذف المكان.');
        return;
    }
    setText('sp-status', '✅ تم الحذف.');
    await loadSavedPlacesUI();
}

function renderPasses(rows) {
    const list = document.getElementById('pass-list');
    if (!list) return;
    const items = Array.isArray(rows) ? rows : [];
    if (!items.length) {
        list.innerHTML = '<div class="text-xs text-gray-500 font-bold">لا توجد باقات نشطة.</div>';
        return;
    }

    list.innerHTML = items.map((p) => {
        const type = p.type || 'pass';
        const validTo = p.valid_to ? new Date(p.valid_to).toLocaleString('ar-EG') : 'غير محدد';
        const rules = p.rules_json && typeof p.rules_json === 'object' ? p.rules_json : null;
        const desc = rules && rules.value ? `${rules.discount_type === 'fixed' ? rules.value + ' ر.س' : rules.value + '%'} خصم` : '—';
        return `
            <div class="bg-white rounded-xl border border-gray-200 px-3 py-2">
                <div class="flex items-center justify-between">
                    <div class="text-sm text-gray-800 font-extrabold">${type}</div>
                    <div class="text-xs text-gray-500 font-bold">${desc}</div>
                </div>
                <div class="text-[11px] text-gray-500 font-bold mt-1">ينتهي: ${validTo}</div>
            </div>
        `;
    }).join('');
}

async function loadPassesUI() {
    if (!getToken()) {
        setText('pass-status', 'سجّل الدخول لعرض الباقات.');
        renderPasses([]);
        return;
    }
    setText('pass-status', 'جاري التحميل...');
    const { res, data } = await apiJson('/api/passengers/me/passes');
    if (!res.ok || !data.success) {
        setText('pass-status', 'تعذر تحميل الباقات.');
        renderPasses([]);
        return;
    }
    setText('pass-status', '');
    renderPasses(data.data || []);
}

async function buyPassUI() {
    if (!getToken()) {
        setText('pass-status', 'سجّل الدخول أولاً.');
        return;
    }

    const type = document.getElementById('pass-type')?.value?.trim() || '';
    const discount = document.getElementById('pass-discount')?.value !== '' ? Number(document.getElementById('pass-discount').value) : null;
    const validToRaw = document.getElementById('pass-valid-to')?.value || '';

    if (!type) {
        setText('pass-status', 'اكتب اسم/نوع الباقة.');
        return;
    }
    if (!Number.isFinite(discount) || discount <= 0) {
        setText('pass-status', 'اكتب نسبة خصم صحيحة.');
        return;
    }

    const valid_to = validToRaw ? new Date(validToRaw) : null;
    const payload = {
        type,
        rules_json: { discount_type: 'percent', value: discount },
        valid_to: valid_to && Number.isFinite(valid_to.getTime()) ? valid_to.toISOString() : null,
        status: 'active'
    };

    setText('pass-status', 'جاري التفعيل...');
    const { res, data } = await apiJson('/api/passengers/me/passes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok || !data.success) {
        setText('pass-status', 'تعذر تفعيل الباقة.');
        return;
    }
    setText('pass-status', '✅ تم تفعيل الباقة.');
    await loadPassesUI();
}

function loadPrefs() {
    const defaults = ROLE === 'driver' ? DRIVER_PREF_DEFAULTS : PASSENGER_PREF_DEFAULTS;
    try {
        const raw = localStorage.getItem(PREF_KEY);
        const prefs = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
        const trips = document.getElementById('pref-notify-trips');
        const marketing = document.getElementById('pref-notify-marketing');
        const location = document.getElementById('pref-location');
        const language = document.getElementById('pref-language');
        const autoAccept = document.getElementById('pref-driver-auto-accept');
        const sound = document.getElementById('pref-driver-sound');
        const shareLocation = document.getElementById('pref-driver-share-location');
        const breakReminder = document.getElementById('pref-driver-break-reminder');
        if (trips) trips.checked = !!prefs.trips;
        if (marketing) marketing.checked = !!prefs.marketing;
        if (location) location.checked = !!prefs.location;
        if (language) language.value = prefs.language || 'ar';
        if (autoAccept) autoAccept.checked = !!prefs.autoAccept;
        if (sound) sound.checked = !!prefs.soundAlerts;
        if (shareLocation) shareLocation.checked = !!prefs.shareLocation;
        if (breakReminder) breakReminder.checked = !!prefs.breakReminder;
        applyLanguage(prefs.language || 'ar');
    } catch (e) {
        // ignore
    }
}

let prefsTimer = null;

function savePrefs() {
    const prefs = {
        trips: !!document.getElementById('pref-notify-trips')?.checked,
        marketing: !!document.getElementById('pref-notify-marketing')?.checked,
        location: !!document.getElementById('pref-location')?.checked,
        language: document.getElementById('pref-language')?.value || 'ar'
    };
    if (ROLE === 'driver') {
        prefs.autoAccept = !!document.getElementById('pref-driver-auto-accept')?.checked;
        prefs.soundAlerts = !!document.getElementById('pref-driver-sound')?.checked;
        prefs.shareLocation = !!document.getElementById('pref-driver-share-location')?.checked;
        prefs.breakReminder = !!document.getElementById('pref-driver-break-reminder')?.checked;
    }
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
    applyLanguage(prefs.language || 'ar');
    const status = document.getElementById('prefs-status');
    if (status) {
        status.textContent = 'تم حفظ التفضيلات';
        if (prefsTimer) clearTimeout(prefsTimer);
        prefsTimer = setTimeout(() => { status.textContent = ''; }, 1500);
    }
}

function setupAccordions() {
    document.querySelectorAll('[data-accordion-target]').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-accordion-target');
            if (!targetId) return;
            const panel = document.getElementById(targetId);
            if (!panel) return;
            const isOpen = panel.classList.contains('open');
            panel.classList.toggle('open', !isOpen);
            btn.querySelectorAll('[data-accordion-icon]').forEach(icon => {
                icon.classList.toggle('rotate-180', !isOpen);
            });
        });
    });
}

function openTranslatedPage() {
    const code = document.getElementById('pref-language')?.value || 'ar';
    const url = window.location.href.split('#')[0];
    const translateUrl = `https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(code)}&u=${encodeURIComponent(url)}`;
    window.open(translateUrl, '_blank');
}

window.addEventListener('DOMContentLoaded', () => {
    try {
        if (localStorage.getItem(DARK_MODE_KEY) === '1') {
            document.body.classList.add('dark-mode');
        }
    } catch (e) {}
    updateDarkModeToggleUI();
    applyRoleUI();
    loadUser();
    populateLanguages();
    loadPrefs();

    const toggle = document.getElementById('settings-dark-toggle');
    if (toggle) toggle.addEventListener('click', toggleDarkMode);

    ['pref-notify-trips', 'pref-notify-marketing', 'pref-location', 'pref-language',
        'pref-driver-auto-accept', 'pref-driver-sound', 'pref-driver-share-location', 'pref-driver-break-reminder'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', savePrefs);
    });

    const backBtn = document.getElementById('settings-back-btn');
    if (backBtn) backBtn.addEventListener('click', goBack);

    const translateBtn = document.getElementById('translate-page-btn');
    if (translateBtn) translateBtn.addEventListener('click', openTranslatedPage);

    setupAccordions();

    loadBudgetEnvelope().catch(() => {});
    const budgetSave = document.getElementById('budget-save');
    if (budgetSave) budgetSave.addEventListener('click', () => {
        saveBudgetEnvelope().catch(() => {});
    });

    loadAccessibilityProfile().catch(() => {});
    const accSave = document.getElementById('acc-save');
    if (accSave) accSave.addEventListener('click', () => {
        saveAccessibilityProfile().catch(() => {});
    });

    loadEmergencyProfile().catch(() => {});
    const emSave = document.getElementById('em-save');
    if (emSave) emSave.addEventListener('click', () => {
        saveEmergencyProfile().catch(() => {});
    });
    const emOpt = document.getElementById('em-opt-in');
    if (emOpt) emOpt.addEventListener('change', () => {
        setEmergencyInputsEnabled(!!emOpt.checked);
    });

    // Captain-only (Driver) settings
    if (ROLE === 'driver') {
        loadCaptainAcceptanceRules().catch(() => {});
        loadCaptainGoHome().catch(() => {});
        loadCaptainGoals().catch(() => {});
        loadCaptainFatigue().catch(() => {});
        loadDriverEmergencyProfile().catch(() => {});

        const saveRules = document.getElementById('cap-save-rules');
        if (saveRules) saveRules.addEventListener('click', () => { saveCaptainAcceptanceRules().catch(() => {}); });
        const saveGoHome = document.getElementById('cap-save-gohome');
        if (saveGoHome) saveGoHome.addEventListener('click', () => { saveCaptainGoHome().catch(() => {}); });
        const saveGoals = document.getElementById('cap-save-goals');
        if (saveGoals) saveGoals.addEventListener('click', () => { saveCaptainGoals().catch(() => {}); });
        const saveFatigue = document.getElementById('cap-save-fatigue');
        if (saveFatigue) saveFatigue.addEventListener('click', () => { saveCaptainFatigue().catch(() => {}); });
        const saveEm = document.getElementById('cap-save-emergency');
        if (saveEm) saveEm.addEventListener('click', () => { saveDriverEmergencyProfile().catch(() => {}); });
        const opt = document.getElementById('cap-em-opt-in');
        if (opt) opt.addEventListener('change', () => { setDriverEmergencyInputsEnabled(!!opt.checked); });
    }

    // v3 Saved Places
    loadSavedPlacesUI().catch(() => {});
    const spSave = document.getElementById('sp-save');
    if (spSave) spSave.addEventListener('click', () => {
        saveSavedPlaceUI().catch(() => {});
    });
    const spRefresh = document.getElementById('sp-refresh');
    if (spRefresh) spRefresh.addEventListener('click', () => {
        loadSavedPlacesUI().catch(() => {});
    });

    // v3 Ride Pass
    loadPassesUI().catch(() => {});
    const passBuy = document.getElementById('pass-buy');
    if (passBuy) passBuy.addEventListener('click', () => {
        buyPassUI().catch(() => {});
    });
    const passRefresh = document.getElementById('pass-refresh');
    if (passRefresh) passRefresh.addEventListener('click', () => {
        loadPassesUI().catch(() => {});
    });
});
