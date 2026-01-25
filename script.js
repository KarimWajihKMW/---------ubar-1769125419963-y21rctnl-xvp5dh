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
const rideEtaDisplay = document.getElementById('ride-eta-display');
const driverLabelText = document.getElementById('driver-label-text');

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
    inRide: document.getElementById('state-in-ride'),
    rating: document.getElementById('state-rating'),
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

// 6. Rating Stars
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

window.resetApp = function() {
    destInput.value = '';
    currentCarType = null;
    requestBtn.disabled = true;
    requestBtn.querySelector('span').innerText = 'اطلب سيارة';
    backBtn.classList.add('hidden');
    
    document.querySelectorAll('.car-select').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.star-btn').forEach(b => { b.classList.remove('text-yellow-400'); b.classList.add('text-gray-300'); });

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
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    
    // Convert viewport center to map world coordinates
    const userMapX = (viewportCenterX - mapState.x) / mapState.scale;
    const userMapY = (viewportCenterY - mapState.y) / mapState.scale;
    
    // Start Driver 400px away to the top-right
    let driverX = userMapX + 400;
    let driverY = userMapY - 300;
    
    // Show Marker
    activeDriverMarker.classList.remove('hidden');
    activeDriverMarker.style.left = `${driverX}px`;
    activeDriverMarker.style.top = `${driverY}px`;
    driverLabelText.innerText = 'أحمد قادم إليك';
    
    // Show Route Line
    driverRouteLine.classList.remove('opacity-0');

    const startTime = Date.now();
    const duration = 10000; // 10 seconds to arrive
    
    function animate() {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
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
        activeDriverMarker.style.transform = `translate(-50%, -50%) rotate(${angle + 90}deg)`;
        activeDriverMarker.style.left = `${currentX}px`;
        activeDriverMarker.style.top = `${currentY}px`;
        
        // Update Route Line
        const midX = (currentX + targetX) / 2;
        const midY = (currentY + targetY) / 2;
        driverRouteLine.setAttribute('d', `M${currentX},${currentY} Q${midX + 50},${midY - 50} ${targetX},${targetY}`);
        
        // Update ETA Text
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
            driverLabelText.innerText = 'وصل الكابتن';
            
            // Wait 2 seconds then start Ride
            setTimeout(() => {
                startRide(currentX, currentY);
            }, 2000);
        }
    }
    
    driverAnimationId = requestAnimationFrame(animate);
}

function startRide(startX, startY) {
    switchSection('inRide');
    
    // Determine destination (either marker or random point)
    let destX, destY;
    
    if (!destMarker.classList.contains('hidden')) {
        destX = parseFloat(destMarker.style.left);
        destY = parseFloat(destMarker.style.top);
    } else {
        // Random point far away
        destX = startX - 800;
        destY = startY + 600;
    }

    const startTime = Date.now();
    const duration = 12000; // 12 seconds ride
    
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

        // Move Map to follow car (Auto-Pan)
        // We want the car to stay roughly center. 
        // MapWorld transform = translate(ScreenWidth/2 - CarWorldX*Scale, ScreenHeight/2 - CarWorldY*Scale)
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
            // End Ride
            setTimeout(() => {
                triggerConfetti();
                switchSection('rating');
                stopDriverTracking();
            }, 1000);
        }
    }

    driverAnimationId = requestAnimationFrame(animateRide);
}

function stopDriverTracking() {
    if (driverAnimationId) cancelAnimationFrame(driverAnimationId);
    activeDriverMarker.classList.add('hidden');
    driverRouteLine.classList.add('opacity-0');
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
