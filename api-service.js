// API Service for Akwadra Taxi App
const API_BASE_URL = (
    window.location.hostname === 'localhost' ||
    window.location.protocol === 'file:' ||
    !window.location.hostname
)
    ? 'http://localhost:3000/api'
    : '/api';

const ApiService = {
    getToken() {
        try {
            if (window.Auth && typeof window.Auth.getToken === 'function') {
                return window.Auth.getToken();
            }
        } catch (e) {
            // ignore
        }

        try {
            return window.localStorage.getItem('akwadra_token');
        } catch (e) {
            return null;
        }
    },

    // Helper function for making requests
    async request(endpoint, options = {}) {
        try {
            const token = ApiService.getToken();
            const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeader,
                    ...options.headers
                },
                ...options
            });

            const raw = await response.text();
            let data = {};
            if (raw) {
                try {
                    data = JSON.parse(raw);
                } catch (e) {
                    data = { error: raw };
                }
            }

            if (!response.ok) {
                // Common production issue: tokens become invalid after server restart if JWT secret changes.
                // When we detect 401, clear local auth + session so the UI can force re-login.
                if (response.status === 401) {
                    try { window.Auth && typeof window.Auth.clearToken === 'function' && window.Auth.clearToken(); } catch (e) {}
                    try { window.DB && typeof window.DB.clearSession === 'function' && window.DB.clearSession(); } catch (e) {}
                    try { window.showToast && window.showToast('⚠️ انتهت الجلسة، سجل الدخول مرة أخرى'); } catch (e) {}
                    try { window.openAuthModal && window.openAuthModal(); } catch (e) {}
                }

                const msg = (data && data.error) ? String(data.error) : (response.statusText || 'Request failed');
                throw new Error(`HTTP ${response.status}: ${msg}`);
            }

            return data;
        } catch (error) {
            console.error('API Request Error:', error);
            throw error;
        }
    },

    // Wallet endpoints
    wallet: {
        async getMyBalance() {
            return ApiService.request('/wallet/me/balance');
        },

        async getMyTransactions(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/wallet/me/transactions${queryString ? `?${queryString}` : ''}`);
        }
    },

    // Trips endpoints
    trips: {
        // Get all trips with optional filtering
        async getAll(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/trips?${queryString}`);
        },
        
        // Get completed trips
        async getCompleted(userId = null, source = null) {
            const params = new URLSearchParams();
            if (userId) params.set('user_id', userId);
            if (source) params.set('source', source);
            const query = params.toString();
            return ApiService.request(`/trips/completed${query ? `?${query}` : ''}`);
        },
        
        // Get cancelled trips
        async getCancelled(userId = null, source = null) {
            const params = new URLSearchParams();
            if (userId) params.set('user_id', userId);
            if (source) params.set('source', source);
            const query = params.toString();
            return ApiService.request(`/trips/cancelled${query ? `?${query}` : ''}`);
        },
        
        // Get single trip
        async getById(id) {
            return ApiService.request(`/trips/${id}`);
        },

        // Get live trip snapshot (trip + driver last location)
        async getLive(id) {
            return ApiService.request(`/trips/${id}/live`);
        },
        
        // Create new trip
        async create(tripData) {
            return ApiService.request('/trips', {
                method: 'POST',
                body: JSON.stringify(tripData)
            });
        },
        
        // Update trip status
        async updateStatus(id, status, ratingOrDetails = null, review = null) {
            const payload = { status };
            if (ratingOrDetails && typeof ratingOrDetails === 'object') {
                Object.assign(payload, ratingOrDetails);
            } else {
                if (ratingOrDetails !== null && ratingOrDetails !== undefined) {
                    payload.rating = ratingOrDetails;
                }
                if (review !== null && review !== undefined) {
                    payload.review = review;
                }
            }

            return ApiService.request(`/trips/${id}/status`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },
        
        // Get trip statistics
        async getStats(userId = null, source = null) {
            const params = new URLSearchParams();
            if (userId) params.set('user_id', userId);
            if (source) params.set('source', source);
            const query = params.toString();
            return ApiService.request(`/trips/stats/summary${query ? `?${query}` : ''}`);
        },

        // Get next pending trip (optionally by car type and driver location)
        async getPendingNext(options = {}) {
            const { carType = null, driverId = null, lat = null, lng = null, limit = null } = options || {};
            const params = new URLSearchParams();
            if (carType) params.set('car_type', carType);
            if (driverId) params.set('driver_id', driverId);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                params.set('lat', lat);
                params.set('lng', lng);
            }
            if (Number.isFinite(limit)) {
                params.set('limit', limit);
            }
            const query = params.toString();
            return ApiService.request(`/trips/pending/next${query ? `?${query}` : ''}`);
        },

        // Assign driver to trip
        async assignDriver(tripId, driverId, driverName = null) {
            return ApiService.request(`/trips/${tripId}/assign`, {
                method: 'PATCH',
                body: JSON.stringify({ driver_id: driverId, driver_name: driverName })
            });
        },

        // Reject trip (driver rejects)
        async reject(tripId) {
            return ApiService.request(`/trips/${tripId}/reject`, {
                method: 'PATCH'
            });
        },

        // Update trip pickup location (lat/lng are the source of truth)
        async updatePickupLocation(tripId, pickupUpdate = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup`, {
                method: 'PATCH',
                body: JSON.stringify(pickupUpdate)
            });
        },

        async getEta(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/eta`);
        },

        async updateEta(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/eta`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        async createPickupSuggestion(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup-suggestions`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getPickupSuggestions(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup-suggestions`);
        },

        async decidePickupSuggestion(tripId, suggestionId, decision) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup-suggestions/${encodeURIComponent(suggestionId)}/decision`, {
                method: 'PATCH',
                body: JSON.stringify({ decision })
            });
        },

        async getStops(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/stops`);
        },

        async setStops(tripId, stops = []) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/stops`, {
                method: 'POST',
                body: JSON.stringify({ stops })
            });
        },

        async setSplitFare(tripId, splits = []) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/split-fare`, {
                method: 'POST',
                body: JSON.stringify({ splits })
            });
        },

        async getSplitFare(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/split-fare`);
        },

        async markSplitCashCollected(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/split-fare/cash-collected`, {
                method: 'POST'
            });
        },

        async createShareLink(tripId, ttlHours = null) {
            const payload = {};
            if (Number.isFinite(ttlHours)) payload.ttl_hours = ttlHours;
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/share`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async emergency(tripId, message = null) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/emergency`, {
                method: 'POST',
                body: JSON.stringify({ message })
            });
        },

        async getSafetyEvents(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/events`);
        },

        async setRouteDeviationConfig(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/deviation-config`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async safetyOk(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/ok`, {
                method: 'POST'
            });
        },

        async safetyHelp(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/help`, {
                method: 'POST'
            });
        },

        async getPickupHandshake(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup-handshake`);
        },

        async verifyPickupHandshake(tripId, code) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/pickup-handshake/verify`, {
                method: 'POST',
                body: JSON.stringify({ code })
            });
        },

        async scheduleGuardianCheckin(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/guardian/checkin`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async confirmGuardianCheckin(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/guardian/confirm`, {
                method: 'POST'
            });
        },

        async getReceipt(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/receipt`);
        }
    },

    pickupHubs: {
        async suggest(lat, lng, limit = null) {
            const params = new URLSearchParams();
            params.set('lat', lat);
            params.set('lng', lng);
            if (Number.isFinite(limit)) params.set('limit', limit);
            return ApiService.request(`/pickup-hubs/suggest?${params.toString()}`);
        }
    },

    passenger: {
        async getFavorites() {
            return ApiService.request('/passengers/me/favorites');
        },
        async addFavorite(driverId) {
            return ApiService.request('/passengers/me/favorites', {
                method: 'POST',
                body: JSON.stringify({ driver_id: driverId })
            });
        },
        async removeFavorite(driverId) {
            return ApiService.request(`/passengers/me/favorites/${encodeURIComponent(driverId)}`, {
                method: 'DELETE'
            });
        },

        async getLoyalty() {
            return ApiService.request('/passengers/me/loyalty');
        },

        async getNoteTemplates() {
            return ApiService.request('/passengers/me/note-templates');
        },
        async addNoteTemplate(note, title = null) {
            return ApiService.request('/passengers/me/note-templates', {
                method: 'POST',
                body: JSON.stringify({ note, title })
            });
        },
        async deleteNoteTemplate(id) {
            return ApiService.request(`/passengers/me/note-templates/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            });
        },

        async getFamily() {
            return ApiService.request('/passengers/me/family');
        },
        async addFamilyMember(payload) {
            return ApiService.request('/passengers/me/family', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async deleteFamilyMember(id) {
            return ApiService.request(`/passengers/me/family/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            });
        },

        async getVerificationStatus() {
            return ApiService.request('/passengers/me/verification/status');
        },

        async requestStrongVerification(level = 'strong') {
            return ApiService.request('/passengers/me/verification/request', {
                method: 'POST',
                body: JSON.stringify({ level })
            });
        },

        async uploadStrongVerification(formData) {
            const token = ApiService.getToken();
            const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};
            const response = await fetch(`${API_BASE_URL}/passengers/me/verification/upload`, {
                method: 'POST',
                headers: {
                    ...authHeader
                },
                body: formData
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Request failed');
            return data;
        },

        async requestEmailVerification() {
            return ApiService.request('/users/me/verify/email/request', {
                method: 'POST'
            });
        },

        async confirmEmailVerification(token) {
            return ApiService.request('/users/me/verify/email/confirm', {
                method: 'POST',
                body: JSON.stringify({ token })
            });
        },

        async requestPhoneVerification() {
            return ApiService.request('/users/me/verify/phone/request', {
                method: 'POST'
            });
        },

        async confirmPhoneVerification(otp) {
            return ApiService.request('/users/me/verify/phone/confirm', {
                method: 'POST',
                body: JSON.stringify({ otp })
            });
        },

        async listTrustedContacts() {
            return ApiService.request('/passengers/me/trusted-contacts');
        },

        async addTrustedContact(payload) {
            return ApiService.request('/passengers/me/trusted-contacts', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async deleteTrustedContact(id) {
            return ApiService.request(`/passengers/me/trusted-contacts/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            });
        }
    },

    scheduledRides: {
        async create(payload) {
            return ApiService.request('/scheduled-rides', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async listMine() {
            return ApiService.request('/scheduled-rides/me');
        },
        async confirm(id) {
            return ApiService.request(`/scheduled-rides/${encodeURIComponent(id)}/confirm`, {
                method: 'POST'
            });
        }
    },

    pricing: {
        async lock(payload) {
            return ApiService.request('/pricing/lock', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }
    },

    support: {
        async listMine() {
            return ApiService.request('/support/me/tickets');
        },
        async createTicket(formData) {
            // formData should be FormData (optional attachment)
            const token = ApiService.getToken();
            const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};
            const response = await fetch(`${API_BASE_URL}/support/tickets`, {
                method: 'POST',
                headers: {
                    ...authHeader
                },
                body: formData
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Request failed');
            return data;
        }
    },

    // Pending rides endpoints (real-time nearest requests for drivers)
    pendingRides: {
        async getForDriver(driverId, options = {}) {
            const { maxDistance = null } = options || {};
            const params = new URLSearchParams();
            if (Number.isFinite(maxDistance)) {
                params.set('max_distance', maxDistance);
            }
            const query = params.toString();
            return ApiService.request(`/drivers/${driverId}/pending-rides${query ? `?${query}` : ''}`);
        },

        async getById(requestId) {
            return ApiService.request(`/pending-rides/${encodeURIComponent(requestId)}`);
        },

        async accept(requestId, driverId) {
            return ApiService.request(`/pending-rides/${requestId}/accept`, {
                method: 'POST',
                body: JSON.stringify({ driver_id: driverId })
            });
        },

        async reject(requestId, driverId) {
            return ApiService.request(`/pending-rides/${requestId}/reject`, {
                method: 'POST',
                body: JSON.stringify({ driver_id: driverId })
            });
        }
    },
    
    // Drivers endpoints
    drivers: {
        // Get all available drivers
        async getAvailable() {
            return ApiService.request('/drivers?status=online');
        },
        
        // Get all drivers
        async getAll() {
            return ApiService.request('/drivers');
        },

        // Resolve driver profile by email/phone
        async resolve(email = null, phone = null, autoCreate = true) {
            const params = new URLSearchParams();
            if (email) params.set('email', email);
            if (phone) params.set('phone', phone);
            if (autoCreate) params.set('auto_create', '1');
            const query = params.toString();
            return ApiService.request(`/drivers/resolve${query ? `?${query}` : ''}`);
        },

        // Update driver live location
        async updateLocation(driverId, lat, lng) {
            return ApiService.request(`/drivers/${driverId}/location`, {
                method: 'PATCH',
                body: JSON.stringify({ lat, lng })
            });
        },

        // Get driver last known location
        async getLocation(driverId) {
            return ApiService.request(`/drivers/${driverId}/location`);
        },

        // Get nearest driver to coordinates
        async getNearest(lat, lng, carType = null) {
            const params = new URLSearchParams();
            params.set('lat', lat);
            params.set('lng', lng);
            if (carType) params.set('car_type', carType);
            return ApiService.request(`/drivers/nearest?${params.toString()}`);
        }
    },
    
    // Users endpoints
    users: {
        // Login or create user
        async login(phone, name = null, email = null) {
            return ApiService.request('/users/login', {
                method: 'POST',
                body: JSON.stringify({ phone, name, email })
            });
        },
        
        // Get user by ID
        async getById(id) {
            return ApiService.request(`/users/${id}`);
        },
        
        // Update user
        async update(id, userData) {
            return ApiService.request(`/users/${id}`, {
                method: 'PUT',
                body: JSON.stringify(userData)
            });
        }
    },
    
    // Passengers endpoints
    passengers: {
        // Get all passengers with optional search
        async getAll(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/passengers?${queryString}`);
        },
        
        // Get single passenger by ID
        async getById(id) {
            return ApiService.request(`/passengers/${id}`);
        },
        
        // Create new passenger
        async create(passengerData) {
            return ApiService.request('/passengers', {
                method: 'POST',
                body: JSON.stringify(passengerData)
            });
        },
        
        // Update passenger
        async update(id, passengerData) {
            return ApiService.request(`/passengers/${id}`, {
                method: 'PUT',
                body: JSON.stringify(passengerData)
            });
        },
        
        // Delete passenger
        async delete(id) {
            return ApiService.request(`/passengers/${id}`, {
                method: 'DELETE'
            });
        },
        
        // Get passenger trips
        async getTrips(id, params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/passengers/${id}/trips?${queryString}`);
        }
    },
    
    // Admin endpoints
    admin: {
        // Get dashboard statistics
        async getDashboardStats() {
            return ApiService.request('/admin/dashboard/stats');
        },

        async createWalletTransaction(payload) {
            return ApiService.request('/admin/wallet/transaction', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }
    }
};

// Make it globally available
window.ApiService = ApiService;

console.log('✅ API Service initialized');
