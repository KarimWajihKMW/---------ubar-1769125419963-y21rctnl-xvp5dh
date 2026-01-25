console.log('Akwadra Super Builder Initialized - Database Connected');

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
const tripHistoryContainer = document.getElementById('trip-history-container');
const toastNotification = document.getElementById('toast-notification');
const toastMessage = document.getElementById('toast-message');

// Profile & Sidebar Elements
const profileName = document.getElementById('profile-name');
const profileAvatar = document.getElementById('profile-avatar');
const profileRating = document.getElementById('profile-rating');
const profileBalance = document.getElementById('profile-balance');
const profilePoints = document.getElementById('profile-points');
const sidebarName = document.getElementById('sidebar-name');
const sidebarAvatar = document.getElementById('sidebar-avatar');
const sidebarRating = document.getElementById('sidebar-rating');
const sidebarBalance = document.getElementById('sidebar-balance');
const navAvatar = document.getElementById('nav-avatar');
const rideDestText = document.getElementById('ride-dest-text');

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
let currentTripPrice = 0;
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

// --- DATABASE SIMULATION SERVICE ---
const DB = {
    keyUser: 'akwadra_user',
    keyTrips: 'akwadra_trips',

    init() {
        // Seed User Data if not exists
        if (!localStorage.getItem(this.keyUser)) {
            const defaultUser = {
                name: "عبد الله أحمد",
                balance: 150,
                points: 450,
                rating: 4.85,
                status: "عضو ذهبي",
                avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Abdullah"
            };
            localStorage.setItem(this.keyUser, JSON.stringify(defaultUser));
        }

        // Seed Trip History if not exists
        if (!localStorage.getItem(this.keyTrips)) {
            const defaultTrips = [
                {
                    id: 'TR-8854',
                    date: new Date(Date.now() - 86400000).toISOString(), // Yesterday
                    pickup: "العمل",
                    dropoff: "المنزل",
                    cost: 25,
                    status: "completed",
                    car: "economy"
                },
                {
                    id: 'TR-1290',
                    date: new Date(Date.now() - 172800000).toISOString(), // 2 Days ago
                    pickup: "المطار",
                    dropoff: "فندق النرجس",
                    cost: 80,
                    status: "completed",
                    car: "luxury"
                }
            ];
            localStorage.setItem(this.keyTrips, JSON.stringify(defaultTrips));
        }
    },

    getUser() {
        return JSON.parse(localStorage.getItem(this.keyUser));
    },

    updateUser(updates) {
        const user = this.getUser();
        const updatedUser = { ...user, ...updates };
        localStorage.setItem(this.keyUser, JSON.stringify(updatedUser));
        updateUIWithUserData();
        return updatedUser;
    },

    getTrips() {
        return JSON.parse(localStorage.getItem(this.keyTrips)) || [];
    },

    addTrip(trip) {
        const trips = this.getTrips();
        trips.unshift(trip); // Add to beginning
        localStorage.setItem(this.keyTrips, JSON.stringify(trips));
    }
};

// --- Function Declarations (Hoisted) ---

function showToast(message) {
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

    // Update Sidebar
    if(sidebarName) sidebarName.innerText = `أهلاً، ${user.name.split(' ')[0]}`;
    if(sidebarRating) sidebarRating.innerText = user.rating;
    if(sidebarBalance) sidebarBalance.innerText = `${user.balance} ر.س`;
    if(sidebarAvatar) sidebarAvatar.src = user.avatar;
    if(navAvatar) navAvatar.src = user.avatar;

    // Update Profile View
    if(profileName) profileName.innerText = user.name;
    if(profileAvatar) profileAvatar.src = user.avatar;
    if(profileRating) profileRating.innerText = user.rating;
    if(profileBalance) profileBalance.innerText = user.balance;
    if(profilePoints) profilePoints.innerText = user.points;
}

function renderTripHistory() {
    if (!tripHistoryContainer) return;
    const trips = DB.getTrips();
    tripHistoryContainer.innerHTML = '';

    if (trips.length === 0) {
        tripHistoryContainer.innerHTML = '<div class="text-center text-gray-400 py-4">لا توجد رحلات سابقة</div>';
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
        tripHistoryContainer.insertAdjacentHTML('beforeend', html);
    });
}

function centerMap() {
    mapState.x = -1500 + (window.innerWidth / 2);
    mapState.y = -1500 + (window.innerHeight / 2);
    mapState.scale = 1;
    updateMapTransform();
}

function updateMapTransform() {
    if (mapWorld) mapWorld.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
}

function toggleMenu() {
    if (!sideMenu || !menuOverlay) return;
    const isOpen = sideMenu.classList.contains('sidebar-open');
    if (isOpen) {
        sideMenu.classList.remove('sidebar-open');
        menuOverlay.classList.remove('overlay-open');
    } else {
        sideMenu.classList.add('sidebar-open');
        menuOverlay.classList.add('overlay-open');
        updateUIWithUserData(); // Refresh data on open
    }
}

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
    
    if(name === 'profile') {
        updateUIWithUserData();
        renderTripHistory();
    }
}

function confirmDestination(destination) {
    if (userMarker) userMarker.classList.add('opacity-0'); 
    if (backBtn) backBtn.classList.remove('hidden');
    switchSection('rideSelect');
    if (requestBtn) requestBtn.querySelector('span').innerText = 'اختر نوع السيارة';
}

// --- GLOBAL FUNCTIONS EXPOSED TO WINDOW ---

function selectCar(element, type) {
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected', 'ring-2', 'ring-indigo-500');
    });
    element.classList.add('selected');
    currentCarType = type;
    
    const prices = { 'economy': 25, 'family': 45, 'luxury': 75 };
    currentTripPrice = prices[type];

    if (requestBtn) {
        requestBtn.disabled = false;
        const names = { 'economy': 'اقتصادي', 'family': 'عائلي', 'luxury': 'فاخر' };
        requestBtn.querySelector('span').innerText = `اطلب ${names[type]}`;
        requestBtn.classList.add('animate-pulse');
        setTimeout(() => requestBtn.classList.remove('animate-pulse'), 500);
    }
}

function resetApp() {
    if (destInput) destInput.value = '';
    currentCarType = null;
    if (requestBtn) {
        requestBtn.disabled = true;
        requestBtn.querySelector('span').innerText = 'اطلب سيارة';
    }
    if (backBtn) backBtn.classList.add('hidden');
    
    document.querySelectorAll('.car-select').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.star-btn').forEach(b => { b.classList.remove('text-yellow-400'); b.classList.add('text-gray-300'); });

    if (userMarker) userMarker.classList.remove('opacity-0');
    if (destMarker) destMarker.classList.add('hidden');
    
    stopDriverTracking(); 
    
    switchSection('destination');
}

// Expose to window immediately
window.selectCar = selectCar;
window.resetApp = resetApp;
window.confirmDestination = confirmDestination;
window.switchSection = switchSection;

// --- Map Drag Logic ---

function startDrag(e) {
    if (e.target.closest('.pointer-events-auto')) return;
    
    mapState.isDragging = true;
    mapContainer.classList.add('grabbing-cursor');
    mapContainer.classList.remove('grab-cursor');
    
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
    
    if (Math.random() > 0.9 && currentLocInput) {
        currentLocInput.value = "جاري تحديد الموقع...";
    }
}

function endDrag(e) {
    if (!mapState.isDragging) return;
    
    mapState.isDragging = false;
    mapContainer.classList.remove('grabbing-cursor');
    mapContainer.classList.add('grab-cursor');
    
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    
    const dist = Math.hypot(clientX - mapState.clickStartX, clientY - mapState.clickStartY);
    
    if (dist < 5) {
        handleMapClick(clientX, clientY);
    } else if (currentLocInput) {
        currentLocInput.value = "شارع الملك عبدالله، حي النخيل";
    }
}

function handleMapClick(cx, cy) {
    const rect = mapWorld.getBoundingClientRect();
    const relX = (cx - rect.left) / mapState.scale;
    const relY = (cy - rect.top) / mapState.scale;
    
    if (destMarker) {
        destMarker.style.left = `${relX}px`;
        destMarker.style.top = `${relY}px`;
        destMarker.classList.remove('hidden');
    }
    
    if (destInput) destInput.value = "تم تحديد موقع على الخريطة";
    confirmDestination("Map Point");
}

// --- Driver Tracking Logic ---
function startDriverTracking() {
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
    const duration = 8000; // Faster for demo
    
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
    switchSection('inRide');
    
    // Set destination text based on input or default
    if(rideDestText) {
        rideDestText.innerText = destInput.value.includes("خريطة") ? "وجهة محددة" : (destInput.value || "فندق الريتز كارلتون");
    }

    let destX, destY;
    if (!destMarker.classList.contains('hidden')) {
        destX = parseFloat(destMarker.style.left);
        destY = parseFloat(destMarker.style.top);
    } else {
        destX = startX - 800;
        destY = startY + 600;
    }

    const startTime = Date.now();
    const duration = 10000; // Faster for demo
    
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

        // Auto follow car
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
                finishTrip(); // Save to DB
                switchSection('rating');
                stopDriverTracking();
            }, 1000);
        }
    }

    driverAnimationId = requestAnimationFrame(animateRide);
}

function finishTrip() {
    // Create Trip Record
    const newTrip = {
        id: `TR-${Math.floor(Math.random() * 9000) + 1000}`,
        date: new Date().toISOString(),
        pickup: "موقعك الحالي",
        dropoff: rideDestText ? rideDestText.innerText : "وجهة محددة",
        cost: currentTripPrice || 25,
        status: "completed",
        car: currentCarType || "economy"
    };

    // Save to DB
    DB.addTrip(newTrip);

    // Update Wallet/Points
    const user = DB.getUser();
    DB.updateUser({
        balance: user.balance - currentTripPrice,
        points: user.points + 25
    });

    showToast('تم حفظ الرحلة وخصم المبلغ من المحفظة');
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
    DB.init(); // Initialize Database
    updateUIWithUserData(); // Load Data
    centerMap();
    animateAmbientCars();
    
    // Map Interactions
    if (mapContainer) {
        mapContainer.addEventListener('mousedown', startDrag);
        mapContainer.addEventListener('touchstart', startDrag, { passive: false });
    }
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', drag, { passive: false });
    
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // Zoom Controls
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
        userMarker.classList.remove('hidden');
        destMarker.classList.add('hidden');
        resetApp();
    });

    // UI Controls
    if (menuBtn) menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    if (closeMenuBtn) closeMenuBtn.addEventListener('click', toggleMenu);
    if (menuOverlay) menuOverlay.addEventListener('click', toggleMenu);
    document.querySelectorAll('#side-menu a').forEach(link => link.addEventListener('click', toggleMenu));

    if (destInput) {
        destInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && destInput.value.trim() !== '') confirmDestination(destInput.value);
        });
        destInput.addEventListener('change', () => {
            if (destInput.value.trim() !== '') confirmDestination(destInput.value);
        });
    }

    if (requestBtn) requestBtn.addEventListener('click', () => {
        if (!currentCarType) return;
        switchSection('loading');
        setTimeout(() => {
            switchSection('driver');
            startDriverTracking();
        }, 3000);
    });

    if (backBtn) backBtn.addEventListener('click', resetApp);

    if (profileBtn) profileBtn.addEventListener('click', () => {
        switchSection('profile');
        backBtn.classList.remove('hidden');
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

    window.addEventListener('resize', () => {
        // Optional resize logic
    });
});