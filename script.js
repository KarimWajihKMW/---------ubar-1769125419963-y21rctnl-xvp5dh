console.log('Akwadra Super Builder Initialized - Interactive Map Mode + Real-time Tracking');

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

// Driver Tracking Elements
const activeDriverMarker = document.getElementById('active-driver');
const driverRouteLine = document.getElementById('driver-route-line');
const etaDisplay = document.getElementById('eta-display');

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

let driverAnimationId = null;

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
             // Optional: Re-center on resize if desired
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
    const rect = mapWorld.getBoundingClientRect();
    // Approximate calculation for visual placement relative to the world container
    // Note: This is a visual approximation. Real mapping requires projection libraries (Leaflet/Mapbox).
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
    requestBtn.querySelector('span').innerText = 'اختر نوع السيارة';
}

// 2. Car Selection
window.selectCar = function(element, type) {
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected', 'ring-2', 'ring-indigo-500');
    });
    element.classList.add('selected');
    currentCarType = type;
    
    requestBtn.disabled = false;
    const names = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر' };
    requestBtn.querySelector('span').innerText = `اطلب ${names[type]}`;
    requestBtn.classList.add('animate-pulse');
    setTimeout(() => requestBtn.classList.remove('animate-pulse'), 500);
};

// 3. Request Ride
requestBtn.addEventListener('click', () => {
    if (!currentCarType) return;
    switchSection('loading');
    setTimeout(() => {
        switchSection('driver');
        startDriverTracking(); // START REAL-TIME TRACKING SIMULATION
    }, 3000);
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
    requestBtn.querySelector('span').innerText = 'اطلب سيارة';
    backBtn.classList.add('hidden');
    
    document.querySelectorAll('.car-select').forEach(el => el.classList.remove('selected'));
    
    userMarker.classList.remove('opacity-0');
    destMarker.classList.add('hidden');
    
    stopDriverTracking(); // STOP TRACKING
    
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

// --- Driver Tracking Logic ---
function startDriverTracking() {
    // 1. Calculate Start Point (Screen Center on Map + Offset)
    // The User is always at screen center. We need to find that point in map coordinates.
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    
    // Convert viewport center to map world coordinates
    // Formula: WorldX = (ViewportX - TranslateX) / Scale
    const userMapX = (viewportCenterX - mapState.x) / mapState.scale;
    const userMapY = (viewportCenterY - mapState.y) / mapState.scale;
    
    // Start Driver 400px away to the top-right
    let driverX = userMapX + 400;
    let driverY = userMapY - 300;
    
    // Show Marker
    activeDriverMarker.classList.remove('hidden');
    activeDriverMarker.style.left = `${driverX}px`;
    activeDriverMarker.style.top = `${driverY}px`;
    
    // Show Route Line
    driverRouteLine.classList.remove('opacity-0');

    const startTime = Date.now();
    const duration = 15000; // 15 seconds to arrive
    
    function animate() {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Update Target (In case map moved, target is always screen center converted to world coords)
        // Actually, physically on the map div, the "User Location" is a fixed point IF the map wasn't dragged.
        // If the user drags the map, the "User Marker" stays screen center, so the "Target World Coord" changes.
        // To keep it simple: The driver drives to the coordinate where the user WAS when tracking started, OR
        // we dynamically update destination. Let's dynamically update.
        
        const currentViewportCenterX = window.innerWidth / 2;
        const currentViewportCenterY = window.innerHeight / 2;
        const targetX = (currentViewportCenterX - mapState.x) / mapState.scale;
        const targetY = (currentViewportCenterY - mapState.y) / mapState.scale;

        // Linear Interpolation
        const currentX = driverX + (targetX - driverX) * progress;
        const currentY = driverY + (targetY - driverY) * progress;
        
        // Calculate Rotation
        const dx = targetX - currentX;
        const dy = targetY - currentY;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        // Update Marker
        activeDriverMarker.style.transform = `translate(-50%, -50%) rotate(${angle + 90}deg)`; // +90 because car icon points up
        activeDriverMarker.style.left = `${currentX}px`;
        activeDriverMarker.style.top = `${currentY}px`;
        
        // Update Route Line (Curve from Driver to User)
        // Simple straight line for now, or bezier
        const midX = (currentX + targetX) / 2;
        const midY = (currentY + targetY) / 2;
        // Creating a slight curve
        driverRouteLine.setAttribute('d', `M${currentX},${currentY} Q${midX + 50},${midY - 50} ${targetX},${targetY}`);
        
        // Update ETA Text randomly
        if (elapsed % 1000 < 20) {
             const remainingSec = Math.ceil((1 - progress) * 15);
             if (remainingSec > 60) etaDisplay.innerText = Math.ceil(remainingSec/60) + " دقائق";
             else etaDisplay.innerText = remainingSec + " ثانية";
        }

        if (progress < 1) {
            driverAnimationId = requestAnimationFrame(animate);
        } else {
            // Arrived
            etaDisplay.innerText = "وصل";
        }
    }
    
    driverAnimationId = requestAnimationFrame(animate);
}

function stopDriverTracking() {
    if (driverAnimationId) cancelAnimationFrame(driverAnimationId);
    activeDriverMarker.classList.add('hidden');
    driverRouteLine.classList.add('opacity-0');
}

// Ambient Animations
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
