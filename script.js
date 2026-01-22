console.log('Akwadra Super Builder Initialized - Taxi App Mode');

// --- Configuration & Elements ---
const destInput = document.getElementById('dest-input');
const backBtn = document.getElementById('back-btn');
const mainPanel = document.getElementById('main-panel');
const requestBtn = document.getElementById('request-btn');
const userMarker = document.getElementById('user-marker');
const profileBtn = document.getElementById('profile-btn');

// Sections
const sections = {
    destination: document.getElementById('state-destination'),
    rideSelect: document.getElementById('state-ride-select'),
    loading: document.getElementById('state-loading'),
    driver: document.getElementById('state-driver'),
    profile: document.getElementById('state-profile')
};

let currentCarType = null;

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Preserve existing feature: Card Event
    const card = document.querySelector('.card');
    if (card) {
        card.addEventListener('click', () => {
            console.log('تم النقر على البطاقة!');
            alert('أهلاً بك في عالم البناء بدون كود! تطبيق التاكسي جاهز للعمل.');
        });
    }

    // Start ambient car animation
    animateAmbientCars();
});

// --- Logic Flow ---

// 1. Destination Input Handler
destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && destInput.value.trim() !== '') {
        confirmDestination(destInput.value);
    }
});

// Also trigger on blur if value exists (for demo simplicity)
destInput.addEventListener('change', () => {
    if (destInput.value.trim() !== '') {
        confirmDestination(destInput.value);
    }
});

function confirmDestination(destination) {
    // Simulate map movement
    userMarker.style.transform = 'translate(-50%, -150%) scale(0.8)';
    
    // Show back button
    backBtn.classList.remove('hidden');
    
    // Switch to Ride Select
    switchSection('rideSelect');
    
    // Update button text placeholder
    requestBtn.innerText = 'اختر نوع السيارة';
}

// 2. Car Selection Logic
window.selectCar = function(element, type) {
    // Remove selected class from all
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected');
        el.classList.remove('ring-2');
        el.classList.remove('ring-indigo-500');
    });
    
    // Add to current
    element.classList.add('selected');
    element.classList.add('ring-2');
    element.classList.add('ring-indigo-500');
    
    currentCarType = type;
    
    // Update Request Button
    requestBtn.disabled = false;
    const names = { 'economy': 'أكوادرا X', 'comfort': 'راحة', 'luxury': 'فخامة' };
    requestBtn.innerText = `اطلب ${names[type]}`;
    requestBtn.classList.add('animate-pulse'); // Add some flair
    setTimeout(() => requestBtn.classList.remove('animate-pulse'), 500);
};

// 3. Request Ride Handler
requestBtn.addEventListener('click', () => {
    if (!currentCarType) return;
    
    switchSection('loading');
    
    // Simulate network API call delay
    setTimeout(() => {
        switchSection('driver');
    }, 3000);
});

// 4. Navigation/Reset Logic
backBtn.addEventListener('click', () => {
    resetApp();
});

// 5. Profile Handler
profileBtn.addEventListener('click', () => {
    switchSection('profile');
    backBtn.classList.remove('hidden');
});

window.resetApp = function() {
    // Reset UI
    destInput.value = '';
    currentCarType = null;
    requestBtn.disabled = true;
    requestBtn.innerText = 'اطلب سيارة';
    backBtn.classList.add('hidden');
    
    // Deselect cars
    document.querySelectorAll('.car-select').forEach(el => {
        el.classList.remove('selected');
        el.classList.remove('ring-2');
    });
    
    // Reset Map
    userMarker.style.transform = 'translate(-50%, -50%)';
    
    switchSection('destination');
};

// Helper to switch sections with animation
function switchSection(name) {
    // Hide all first
    Object.values(sections).forEach(sec => {
        if(sec) {
            sec.classList.add('hidden');
            sec.classList.remove('slide-up-enter-active');
        }
    });
    
    // Show target
    const target = sections[name];
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('slide-up-enter');
        
        // Trigger reflow for animation
        void target.offsetWidth;
        
        target.classList.add('slide-up-enter-active');
        target.classList.remove('slide-up-enter');
    }
}

// Ambient Animations
function animateAmbientCars() {
    const car1 = document.getElementById('car-1');
    const car2 = document.getElementById('car-2');
    
    setInterval(() => {
        // Random movement simulation using transforms
        car1.style.transform = `translate(${Math.random() * 50 - 25}px, ${Math.random() * 50 - 25}px) scaleX(-1)`;
        car2.style.transform = `translate(${Math.random() * 50 - 25}px, ${Math.random() * 50 - 25}px)`;
    }, 3000);
}