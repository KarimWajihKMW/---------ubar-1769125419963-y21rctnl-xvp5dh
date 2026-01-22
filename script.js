console.log('Akwadra Super Builder Initialized - Interactive Map Mode');

// --- Configuration & Elements ---
const destInput = document.getElementById('dest-input');
const currentLocInput = document.getElementById('current-loc-input');
const backBtn = document.getElementById('back-btn');
const mainPanel = document.getElementById('main-panel');
const requestBtn = document.getElementById('request-btn');
const userMarker = document.getElementById('user-marker');
const destMarker = document.getElementById('dest-marker');
const profileBtn = document.getElementById('profile-btn');
const menuBtn = document.getElementById('menu-btn');
const closeMenuBtn = document.getElementById('close-menu-btn');
const sideMenu = document.getElementById('side-menu');
const menuOverlay = document.getElementById('menu-overlay');

// Map Elements
const mapContainer = document.getElementById('map-container');
const mapWorld = document.getElementById('map-world');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const centerMapBtn = document.getElementById('center-map');

// Sections
const sections = {
    destination: document.getElementById('state-destination'),
    rideSelect: document.getElementById('state-ride-select'),
    loading: document.getElementById('state-loading'),
    driver: document.getElementById('state-driver'),
    profile: document.getElementById('state-profile')
};

let currentCarType = null;
let mapState = {
    x: -1500 + (window.innerWidth / 2),
    y: -1500 + (window.innerHeight / 2),
    scale: 1,
    isDragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0
};

// Update initial center based on screen size
function centerMap() {
    mapState.x = -1500 + (window.innerWidth / 2);
    mapState.y = -1500 + (window.innerHeight / 2);
    mapState.scale = 1;
    updateMapTransform();
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    centerMap(); // Center map initially
    animateAmbientCars();
    
    // Resize handler to keep centered
    window.addEventListener('resize', () => {
        if (!mapState.isDragging) {
             // Only re-center if not being manipulated
             // Or we can just let it be.
        }
    });
});

// --- Map Interaction Logic (Drag & Drop) ---

mapContainer.addEventListener('mousedown', startDrag);
mapContainer.addEventListener('touchstart', startDrag, { passive: false });

document.addEventListener('mousemove', drag);
document.addEventListener('touchmove', drag, { passive: false });

document.addEventListener('mouseup', endDrag);
document.addEventListener('touchend', endDrag);

function startDrag(e) {
    if (e.target.closest('.pointer-events-auto')) return;
    
    mapState.isDragging = true;
    mapContainer.classList.add('grabbing-cursor');
    mapContainer.classList.remove('grab-cursor');
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    mapState.startX = clientX - mapState.x;
    mapState.startY = clientY - mapState.y;
    
    // Store click start for distinguishing click vs drag
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
    
    // Simulated "Geocoding" - Update current location text while dragging
    if (Math.random() > 0.9) {
        currentLocInput.value = "جاري تحديد الموقع...";
    }
}

function endDrag(e) {
    if (!mapState.isDragging) return;
    
    mapState.isDragging = false;
    mapContainer.classList.remove('grabbing-cursor');
    mapContainer.classList.add('grab-cursor');
    
    // Check if it was a click (small movement)
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    
    const dist = Math.hypot(clientX - mapState.clickStartX, clientY - mapState.clickStartY);
    
    if (dist < 5) {
        handleMapClick(clientX, clientY);
    } else {
        // Drag ended, settle text
        currentLocInput.value = "شارع الملك عبدالله، حي النخيل";
    }
}

function updateMapTransform() {
    mapWorld.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
}

// --- Map Zoom Controls ---
zoomInBtn.addEventListener('click', () => {
    mapState.scale = Math.min(mapState.scale + 0.2, 2.5);
    updateMapTransform();
});

zoomOutBtn.addEventListener('click', () => {
    mapState.scale = Math.max(mapState.scale - 0.2, 0.5);
    updateMapTransform();
});

centerMapBtn.addEventListener('click', () => {
    centerMap();
    userMarker.classList.remove('hidden');
    destMarker.classList.add('hidden');
    resetApp();
});

// --- Map Click (Set Destination) ---
function handleMapClick(cx, cy) {
    // We need to place the pin at the CLICKED location on the MAP WORLD layer
    // Calculate world coordinates
    // mapState.x is the translation of the world
    // clickX = worldX + mapState.x
    // worldX = clickX - mapState.x
    // (Ignoring scale for simplicity in this calculation or assuming scale originates at 0,0 - CSS origin is center)
    // Actually CSS origin is center, so scale complicates math. Let's assume scale=1 for basic interactions or fix origin.
    // Since transform-origin is center of the div (1500, 1500), let's simplify by using the element offset.
    
    // Simplest approach: Put marker absolute to world using local calc
    // But since we use simple translation logic:
    
    // Let's just create a visual effect for now, converting screen to world space is tricky with scale + origin.
    // We will place the marker relative to the container for visual feedback, then snap "World" coords.
    
    // Better: Just use the fact that we can place it inside mapWorld.
    // The bounding rect of mapWorld tells us where it is.
    const rect = mapWorld.getBoundingClientRect();
    const relX = (cx - rect.left) / mapState.scale;
    const relY = (cy - rect.top) / mapState.scale;
    
    destMarker.style.left = `${relX}px`;
    destMarker.style.top = `${relY}px`;
    destMarker.classList.remove('hidden');
    
    // Simulate selecting a place
    destInput.value = "تم تحديد موقع على الخريطة";
    confirmDestination("Map Point");
}

// --- App Logic ---

function toggleMenu() {
    const isOpen = sideMenu.classList.contains('sidebar-open');
    if (isOpen) {
        sideMenu.classList.remove('sidebar-open');
        menuOverlay.classList.remove('overlay-open');
    } else {
        sideMenu.classList.add('sidebar-open');
        menuOverlay.classList.add('overlay-open');
    }
}

if (menuBtn) menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
if (closeMenuBtn) closeMenuBtn.addEventListener('click', toggleMenu);
if (menuOverlay) menuOverlay.addEventListener('click', toggleMenu);
document.querySelectorAll('#side-menu a').forEach(link => link.addEventListener('click', toggleMenu));

// 1. Destination Input
destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && destInput.value.trim() !== '') confirmDestination(destInput.value);
});
destInput.addEventListener('change', () => {
    if (destInput.value.trim() !== '') confirmDestination(destInput.value);
});

function confirmDestination(destination) {
    userMarker.classList.add('opacity-0'); // Hide pickup marker to focus on route
    backBtn.classList.remove('hidden');
    switchSection('rideSelect');
    requestBtn.innerText = 'اختر نوع السيارة';
}

// 2. Car Selection
window.selectCar = function(element, type) {
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected', 'ring-2', 'ring-indigo-500');
    });
    element.classList.add('selected', 'ring-2', 'ring-indigo-500');
    currentCarType = type;
    
    requestBtn.disabled = false;
    const names = { 'economy': 'أكوادرا X', 'comfort': 'راحة', 'luxury': 'فخامة' };
    requestBtn.innerText = `اطلب ${names[type]}`;
    requestBtn.classList.add('animate-pulse');
    setTimeout(() => requestBtn.classList.remove('animate-pulse'), 500);
};

// 3. Request Ride
requestBtn.addEventListener('click', () => {
    if (!currentCarType) return;
    switchSection('loading');
    setTimeout(() => switchSection('driver'), 3000);
});

// 4. Back/Reset
backBtn.addEventListener('click', resetApp);

// 5. Profile
profileBtn.addEventListener('click', () => {
    switchSection('profile');
    backBtn.classList.remove('hidden');
});

window.resetApp = function() {
    destInput.value = '';
    currentCarType = null;
    requestBtn.disabled = true;
    requestBtn.innerText = 'اطلب سيارة';
    backBtn.classList.add('hidden');
    
    document.querySelectorAll('.car-select').forEach(el => el.classList.remove('selected', 'ring-2'));
    
    userMarker.classList.remove('opacity-0');
    destMarker.classList.add('hidden');
    
    switchSection('destination');
};

function switchSection(name) {
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
        void target.offsetWidth;
        target.classList.add('slide-up-enter-active');
        target.classList.remove('slide-up-enter');
    }
}

// Ambient Animations
function animateAmbientCars() {
    const cars = ['car-1', 'car-2', 'car-3'];
    cars.forEach(id => {
        const car = document.getElementById(id);
        setInterval(() => {
            const rx = Math.random() * 200 - 100;
            const ry = Math.random() * 200 - 100;
            // Get current computed style left/top to add relative movement
            // For simplicity in this demo, we just transform
            car.style.transform = `translate(${rx}px, ${ry}px) scaleX(${Math.random() > 0.5 ? -1 : 1})`;
        }, 4000 + Math.random() * 2000);
    });
}
