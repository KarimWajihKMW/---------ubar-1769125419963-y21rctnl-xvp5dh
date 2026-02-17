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
});
