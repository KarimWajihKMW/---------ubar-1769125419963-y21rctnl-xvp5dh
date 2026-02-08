// Enhanced Trips Manager with API Integration
const TripsManager = {
    currentUserId: 1, // Default user ID
    currentFilter: 'all',
    useAPI: true, // Flag to switch between API and LocalStorage
    
    // Initialize the manager
    async init() {
        console.log('🔄 Initializing Trips Manager...');
        
        // Check if API is available
        try {
            const response = await fetch('/api/health');
            if (response.ok) {
                this.useAPI = true;
                console.log('✅ Using API backend');
            }
        } catch (error) {
            this.useAPI = false;
            console.log('⚠️ API not available, using LocalStorage');
        }
    },
    
    // Load all trips with filtering
    async loadTrips(filter = 'all') {
        this.currentFilter = filter;
        const container = document.getElementById('all-trips-container');
        const emptyState = document.getElementById('empty-trips-state');
        
        if (!container) return;
        
        try {
            let trips = [];
            
            if (this.useAPI) {
                // Fetch from API
                const params = { status: filter !== 'all' ? filter : undefined };
                const response = await ApiService.trips.getAll(params);
                trips = response.data || [];
            } else {
                // Fallback to LocalStorage
                trips = DB.getTrips() || [];
                if (filter !== 'all') {
                    trips = trips.filter(t => t.status === filter);
                }
            }
            
            if (trips.length === 0) {
                container.classList.add('hidden');
                if (emptyState) emptyState.classList.remove('hidden');
                return;
            }
            
            container.classList.remove('hidden');
            if (emptyState) emptyState.classList.add('hidden');
            
            // Render trips
            container.innerHTML = trips.map(trip => this.createTripCard(trip)).join('');
            
            // Update statistics
            await this.updateStats();
            
        } catch (error) {
            console.error('Error loading trips:', error);
            showToast('❌ خطأ في تحميل الرحلات');
        }
    },
    
    // Load completed trips only
    async loadCompletedTrips() {
        const container = document.getElementById('all-trips-container');
        if (!container) return;
        
        try {
            let trips = [];
            
            if (this.useAPI) {
                const response = await ApiService.trips.getCompleted();
                trips = response.data || [];
            } else {
                trips = (DB.getTrips() || []).filter(t => t.status === 'completed');
            }
            
            container.innerHTML = trips.length > 0 
                ? trips.map(trip => this.createTripCard(trip)).join('')
                : '<div class="text-center text-gray-400 py-8">لا توجد رحلات مكتملة</div>';
                
        } catch (error) {
            console.error('Error loading completed trips:', error);
        }
    },
    
    // Load cancelled trips only
    async loadCancelledTrips() {
        const container = document.getElementById('all-trips-container');
        if (!container) return;
        
        try {
            let trips = [];
            
            if (this.useAPI) {
                const response = await ApiService.trips.getCancelled();
                trips = response.data || [];
            } else {
                trips = (DB.getTrips() || []).filter(t => t.status === 'cancelled');
            }
            
            container.innerHTML = trips.length > 0 
                ? trips.map(trip => this.createTripCard(trip)).join('')
                : '<div class="text-center text-gray-400 py-8">لا توجد رحلات ملغية</div>';
                
        } catch (error) {
            console.error('Error loading cancelled trips:', error);
        }
    },
    
    // Create trip card HTML
    createTripCard(trip) {
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
        
        const date = new Date(trip.created_at || trip.date);
        const formattedDate = date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
        const formattedTime = date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        
        const pickup = trip.pickup_location || trip.pickup || 'موقعك الحالي';
        const dropoff = trip.dropoff_location || trip.dropoff || 'الوجهة';
        const driverName = trip.driver_name || trip.driver || 'السائق';
        
        return `
            <div class="bg-white border border-gray-200 rounded-2xl p-4 hover:shadow-md transition-shadow cursor-pointer" onclick="TripsManager.showTripDetails('${trip.id}')">
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
                        <p class="text-xs text-gray-500 font-bold">${paymentLabels[trip.payment_method || trip.paymentMethod] || 'كاش'}</p>
                    </div>
                </div>
                
                <div class="bg-gray-50 rounded-xl p-3 mb-3">
                    <div class="flex items-start gap-2 mb-2">
                        <i class="fas fa-circle text-indigo-600 text-xs mt-1"></i>
                        <p class="text-sm text-gray-700 font-bold flex-1">${pickup}</p>
                    </div>
                    <div class="border-r-2 border-dashed border-gray-300 h-3 mr-1"></div>
                    <div class="flex items-start gap-2">
                        <i class="fas fa-map-marker-alt text-red-500 text-xs mt-1"></i>
                        <p class="text-sm text-gray-700 font-bold flex-1">${dropoff}</p>
                    </div>
                </div>
                
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${driverName}" class="w-8 h-8 rounded-full bg-gray-100 border border-gray-200">
                        <div>
                            <p class="text-xs font-bold text-gray-800">${driverName}</p>
                            <p class="text-xs text-gray-500">${carTypeLabels[trip.car_type || trip.car] || 'اقتصادي'}</p>
                        </div>
                    </div>
                    <button class="text-indigo-600 hover:text-indigo-700 font-bold text-sm">
                        التفاصيل <i class="fas fa-chevron-left mr-1"></i>
                    </button>
                </div>
            </div>
        `;
    },
    
    // Update statistics
    async updateStats() {
        try {
            let stats;
            
            if (this.useAPI) {
                const response = await ApiService.trips.getStats();
                stats = response.data;
                
                const totalTripsEl = document.getElementById('total-trips-count');
                const totalSpentEl = document.getElementById('total-spent');
                const avgRatingEl = document.getElementById('avg-rating');
                
                if (totalTripsEl) totalTripsEl.innerText = stats.total_trips || 0;
                if (totalSpentEl) totalSpentEl.innerText = Math.round(stats.total_spent || 0);
                if (avgRatingEl) avgRatingEl.innerText = parseFloat(stats.avg_rating || 0).toFixed(1);
            } else {
                // Fallback to LocalStorage calculation
                const trips = DB.getTrips() || [];
                const totalTrips = trips.length;
                const totalSpent = trips.reduce((sum, trip) => sum + (trip.cost || 0), 0);
                const avgRating = trips.length > 0 
                    ? trips.reduce((sum, trip) => sum + (trip.rating || 5), 0) / trips.length 
                    : 0;
                
                const totalTripsEl = document.getElementById('total-trips-count');
                const totalSpentEl = document.getElementById('total-spent');
                const avgRatingEl = document.getElementById('avg-rating');
                
                if (totalTripsEl) totalTripsEl.innerText = totalTrips;
                if (totalSpentEl) totalSpentEl.innerText = Math.round(totalSpent);
                if (avgRatingEl) avgRatingEl.innerText = avgRating.toFixed(1);
            }
        } catch (error) {
            console.error('Error updating stats:', error);
        }
    },
    
    // Show trip details
    async showTripDetails(tripId) {
        try {
            let trip;
            
            if (this.useAPI) {
                const response = await ApiService.trips.getById(tripId);
                trip = response.data;
            } else {
                const trips = DB.getTrips() || [];
                trip = trips.find(t => t.id === tripId);
            }
            
            if (!trip) {
                showToast('❌ الرحلة غير موجودة');
                return;
            }
            
            // Populate trip details modal
            const statusColors = {
                completed: 'bg-green-100 text-green-700',
                cancelled: 'bg-red-100 text-red-700'
            };
            
            const statusIcons = {
                completed: 'fa-check-circle',
                cancelled: 'fa-times-circle'
            };
            
            const statusLabels = {
                completed: 'مكتملة',
                cancelled: 'ملغية'
            };
            
            const statusEl = document.getElementById('trip-detail-status');
            if (statusEl) {
                statusEl.className = `inline-block px-4 py-2 rounded-full font-bold text-sm ${statusColors[trip.status]}`;
                statusEl.innerHTML = `<i class="fas ${statusIcons[trip.status]} ml-1"></i> ${statusLabels[trip.status]}`;
            }
            
            document.getElementById('trip-detail-id').innerText = trip.id;
            document.getElementById('trip-detail-date').innerText = new Date(trip.created_at || trip.date).toLocaleDateString('ar-EG');
            document.getElementById('trip-detail-pickup').innerText = trip.pickup_location || trip.pickup;
            document.getElementById('trip-detail-dropoff').innerText = trip.dropoff_location || trip.dropoff;
            const distanceEl = document.getElementById('trip-detail-distance');
            const durationEl = document.getElementById('trip-detail-duration');
            if (distanceEl) distanceEl.innerText = `${Number(trip.distance || 0)} كم`;
            if (durationEl) durationEl.innerText = `${Number(trip.duration || 0)} دقيقة`;
            
            // Switch to trip details section
            if (typeof switchSection === 'function') {
                switchSection('trip-details');
            }
            
        } catch (error) {
            console.error('Error showing trip details:', error);
            showToast('❌ خطأ في عرض تفاصيل الرحلة');
        }
    },
    
    // Create new trip
    async createTrip(tripData) {
        try {
            if (this.useAPI) {
                const response = await ApiService.trips.create(tripData);
                showToast('✅ تم إنشاء الرحلة بنجاح');
                return response.data;
            } else {
                DB.addTrip(tripData);
                showToast('✅ تم إنشاء الرحلة بنجاح');
                return tripData;
            }
        } catch (error) {
            console.error('Error creating trip:', error);
            showToast('❌ خطأ في إنشاء الرحلة');
            throw error;
        }
    },
    
    // Update trip status
    async updateTripStatus(tripId, status, rating = null) {
        try {
            if (this.useAPI) {
                await ApiService.trips.updateStatus(tripId, status, rating);
            } else {
                // Update in LocalStorage
                const trips = DB.getTrips() || [];
                const tripIndex = trips.findIndex(t => t.id === tripId);
                if (tripIndex !== -1) {
                    trips[tripIndex].status = status;
                    if (rating) trips[tripIndex].rating = rating;
                    SafeStorage.setItem(DB.keyTrips, JSON.stringify(trips));
                }
            }
            
            await this.loadTrips(this.currentFilter);
            showToast(`✅ تم تحديث حالة الرحلة`);
        } catch (error) {
            console.error('Error updating trip status:', error);
            showToast('❌ خطأ في تحديث الرحلة');
        }
    }
};

// Override global functions to use TripsManager
window.filterTrips = async function(filter) {
    // Update active filter button
    document.querySelectorAll('.trip-filter-btn').forEach(btn => {
        btn.classList.remove('active', 'bg-indigo-600', 'text-white');
        btn.classList.add('bg-gray-100', 'text-gray-600');
    });
    const activeBtn = document.querySelector(`[data-filter="${filter}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-indigo-600', 'text-white');
        activeBtn.classList.remove('bg-gray-100', 'text-gray-600');
    }
    
    // Load trips with filter
    await TripsManager.loadTrips(filter);
};

window.showTripDetails = function(tripId) {
    TripsManager.showTripDetails(tripId);
};

window.loadAllTrips = async function() {
    await TripsManager.loadTrips(TripsManager.currentFilter);
};

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    TripsManager.init();
});

console.log('✅ Trips Manager initialized');
