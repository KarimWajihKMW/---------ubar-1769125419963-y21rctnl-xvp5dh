const DARK_MODE_KEY = 'akwadra_dark_mode';
const PREF_KEY = 'akwadra_passenger_prefs';

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

function loadPrefs() {
    const defaults = { trips: true, marketing: false, location: true, language: 'ar' };
    try {
        const raw = localStorage.getItem(PREF_KEY);
        const prefs = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
        const trips = document.getElementById('pref-notify-trips');
        const marketing = document.getElementById('pref-notify-marketing');
        const location = document.getElementById('pref-location');
        const language = document.getElementById('pref-language');
        if (trips) trips.checked = !!prefs.trips;
        if (marketing) marketing.checked = !!prefs.marketing;
        if (location) location.checked = !!prefs.location;
        if (language) language.value = prefs.language || 'ar';
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
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
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

window.addEventListener('DOMContentLoaded', () => {
    try {
        if (localStorage.getItem(DARK_MODE_KEY) === '1') {
            document.body.classList.add('dark-mode');
        }
    } catch (e) {}
    updateDarkModeToggleUI();
    loadUser();
    loadPrefs();

    const toggle = document.getElementById('settings-dark-toggle');
    if (toggle) toggle.addEventListener('click', toggleDarkMode);

    ['pref-notify-trips', 'pref-notify-marketing', 'pref-location', 'pref-language'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', savePrefs);
    });

    const backBtn = document.querySelector('button[onclick="goBack()"]');
    if (backBtn) backBtn.addEventListener('click', goBack);

    setupAccordions();
});
