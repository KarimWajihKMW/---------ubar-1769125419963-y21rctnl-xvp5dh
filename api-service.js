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

    async requestForm(endpoint, formData, options = {}) {
        try {
            const token = ApiService.getToken();
            const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: options.method || 'POST',
                headers: {
                    ...authHeader,
                    ...(options.headers || {})
                },
                body: formData
            });

            const raw = await response.text();
            let data = {};
            if (raw) {
                try { data = JSON.parse(raw); } catch (e) { data = { error: raw }; }
            }

            if (!response.ok) {
                if (response.status === 401) {
                    try { window.Auth && typeof window.Auth.clearToken === 'function' && window.Auth.clearToken(); } catch (e) {}
                    try { window.DB && typeof window.DB.clearSession === 'function' && window.DB.clearSession(); } catch (e) {}
                }
                const msg = (data && data.error) ? String(data.error) : (response.statusText || 'Request failed');
                throw new Error(`HTTP ${response.status}: ${msg}`);
            }
            return data;
        } catch (error) {
            console.error('API Form Request Error:', error);
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

        // Driving Coach (privacy-first): save aggregated summary counts/score
        async saveDrivingSummary(tripId, summary = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/driving-summary`, {
                method: 'POST',
                body: JSON.stringify(summary)
            });
        },

        async getDrivingSummary(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/driving-summary`);
        },

        // Incident / Dispute Package
        async createIncidentPackage(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/incidents`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async listIncidentPackages(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/incidents`);
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

        // --- Trip Messaging Board (v2) ---
        async getMessages(tripId, params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/messages${queryString ? `?${queryString}` : ''}`);
        },

        async sendMessage(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/messages`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // --- Driver Accessibility Acknowledgement (v2) ---
        async accessibilityAck(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/accessibility-ack`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // --- Accessibility Feedback (v2) ---
        async submitAccessibilityFeedback(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/accessibility-feedback`, {
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

        async getSafetyCapsule(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/safety/capsule`);
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

        // --- Meet Code (Captain -> Passenger, v4) ---
        async getMeetCode(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/meet-code`);
        },

        async verifyMeetCode(tripId, code) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/meet-code/verify`, {
                method: 'POST',
                body: JSON.stringify({ code })
            });
        },

        // --- Expectation Handshake (v4) ---
        async getExpectations(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/expectations`);
        },

        async setExpectations(tripId, expectations = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/expectations`, {
                method: 'PATCH',
                body: JSON.stringify({ expectations })
            });
        },

        // --- Justified auto-messages ACK (v4) ---
        async ackMessage(tripId, messageId, decision) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/messages/${encodeURIComponent(String(messageId))}/ack`, {
                method: 'POST',
                body: JSON.stringify({ decision })
            });
        },

        // --- 2-step arrival (v4) ---
        async arrivalStep1(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/arrival/step1`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async arrivalStep2(tripId, seen) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/arrival/step2`, {
                method: 'POST',
                body: JSON.stringify({ seen: !!seen })
            });
        },

        async getArrival(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/arrival`);
        },

        // --- Tamper-evident Trip Timeline (v4) ---
        async getTimeline(tripId, params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/timeline${queryString ? `?${queryString}` : ''}`);
        },

        async verifyTimeline(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/timeline/verify`);
        },

        // --- Captain Boundaries ACK (v4) ---
        async ackBoundaries(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/boundaries/ack`, {
                method: 'POST'
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

    // Passenger profile endpoints (v2)
    passengers: {
        async getMyAccessibilityProfile(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/passengers/me/accessibility${queryString ? `?${queryString}` : ''}`);
        },

        async updateMyAccessibilityProfile(payload = {}) {
            return ApiService.request('/passengers/me/accessibility', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async getMyEmergencyProfile(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/passengers/me/emergency-profile${queryString ? `?${queryString}` : ''}`);
        },

        async updateMyEmergencyProfile(payload = {}) {
            return ApiService.request('/passengers/me/emergency-profile', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        }
    },

    pickupHubs: {
        async suggest(lat, lng, limit = null, preference = null, accessibility = null) {
            const params = new URLSearchParams();
            params.set('lat', lat);
            params.set('lng', lng);
            if (Number.isFinite(limit)) params.set('limit', limit);
            if (preference) params.set('preference', preference);
            if (accessibility === true) params.set('accessibility', '1');
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

        async getFamilyBudget(memberId) {
            return ApiService.request(`/passengers/me/family/${encodeURIComponent(memberId)}/budget`);
        },

        async getBudgetEnvelope() {
            return ApiService.request('/passengers/me/budget-envelope');
        },

        async setBudgetEnvelope(payload = {}) {
            return ApiService.request('/passengers/me/budget-envelope', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async checkBudgetEnvelope(amount) {
            return ApiService.request('/passengers/me/budget-envelope/check', {
                method: 'POST',
                body: JSON.stringify({ amount })
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

    // Captain-only (Driver) tools
    captain: {
        async getAcceptanceRules(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/acceptance-rules`);
        },
        async setAcceptanceRules(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/acceptance-rules`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async getGoHome(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/go-home`);
        },
        async setGoHome(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/go-home`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async getGoals(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/goals`);
        },
        async setGoals(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/goals`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async getEarningsAssistant(driverId, options = {}) {
            const params = new URLSearchParams();
            if (Number.isFinite(options.windowDays)) params.set('window_days', options.windowDays);
            const q = params.toString();
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/earnings-assistant${q ? `?${q}` : ''}`);
        },

        async addExpense(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/expenses`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async listExpenses(driverId, options = {}) {
            const params = new URLSearchParams();
            if (options.from) params.set('from', options.from);
            if (options.to) params.set('to', options.to);
            const q = params.toString();
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/expenses${q ? `?${q}` : ''}`);
        },
        async getNetProfitToday(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/net-profit/today`);
        },

        async getFatigueToday(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/fatigue/today`);
        },
        async setFatigueSettings(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/fatigue/settings`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async listFavorites(driverId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/favorites`);
        },
        async addFavorite(driverId, userId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/favorites`, {
                method: 'POST',
                body: JSON.stringify({ user_id: userId })
            });
        },
        async removeFavorite(driverId, userId) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/favorites/${encodeURIComponent(userId)}` , {
                method: 'DELETE'
            });
        },

        async getEmergencyProfile() {
            return ApiService.request('/drivers/me/emergency-profile');
        },
        async setEmergencyProfile(payload = {}) {
            return ApiService.request('/drivers/me/emergency-profile', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        async sos(payload = {}) {
            return ApiService.request('/drivers/me/sos', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async stopReceiving() {
            return ApiService.request('/drivers/me/stop-receiving', {
                method: 'POST'
            });
        },

        async createRoadReport(payload = {}) {
            return ApiService.request('/drivers/me/road-reports', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async voteRoadReport(reportId, vote) {
            return ApiService.request(`/drivers/me/road-reports/${encodeURIComponent(String(reportId))}/vote`, {
                method: 'POST',
                body: JSON.stringify({ vote })
            });
        },
        async listRoadReportsNearby(options = {}) {
            const params = new URLSearchParams();
            if (Number.isFinite(options.lat)) params.set('lat', options.lat);
            if (Number.isFinite(options.lng)) params.set('lng', options.lng);
            if (Number.isFinite(options.radiusKm)) params.set('radius_km', options.radiusKm);
            const q = params.toString();
            return ApiService.request(`/drivers/me/road-reports/nearby${q ? `?${q}` : ''}`);
        },

        async createMapError(payload = {}) {
            return ApiService.request('/drivers/me/map-errors', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async waitingArrive(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/waiting/arrive`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async waitingEnd(tripId) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/waiting/end`, {
                method: 'POST'
            });
        },

        async nextTripSuggestion(driverId, options = {}) {
            const params = new URLSearchParams();
            if (Number.isFinite(options.radiusKm)) params.set('radius_km', options.radiusKm);
            const q = params.toString();
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/next-trip-suggestion${q ? `?${q}` : ''}`);
        },

        // Reposition Coach (Captain)
        async getRepositionSuggestions(driverId, options = {}) {
            const params = new URLSearchParams();
            if (Number.isFinite(options.windowDays)) params.set('window_days', options.windowDays);
            if (Number.isFinite(options.gridDeg)) params.set('grid_deg', options.gridDeg);
            if (Number.isFinite(options.limit)) params.set('limit', options.limit);
            const q = params.toString();
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/reposition/suggestions${q ? `?${q}` : ''}`);
        },
        async repositionFeedback(driverId, payload = {}) {
            return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/captain/reposition/feedback`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // Trip Swap Market (Captain)
        async tripSwapOffer(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/swap/offer`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async tripSwapAccept(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/swap/accept`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async tripSwapReject(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/swap/reject`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },
        async tripSwapCancel(tripId, payload = {}) {
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/swap/cancel`, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async uploadTripAudio(tripId, blob, mimeType = null) {
            const fd = new FormData();
            const type = mimeType || (blob && blob.type ? blob.type : 'audio/webm');
            fd.append('audio', blob, `audio-${Date.now()}.webm`);
            return ApiService.requestForm(`/trips/${encodeURIComponent(tripId)}/driver-audio`, fd, {
                method: 'POST',
                headers: type ? { } : {}
            });
        },

        // --- Captain Boundaries (v4) ---
        async getBoundaries(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/drivers/me/boundaries${queryString ? `?${queryString}` : ''}`);
        },

        async setBoundaries(payload = {}) {
            return ApiService.request('/drivers/me/boundaries', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        },

        // --- Quick Car Check (v4) ---
        async uploadCarCheck(formData) {
            return ApiService.requestForm('/drivers/me/car-checks', formData, { method: 'POST' });
        },

        async listCarChecks(params = {}) {
            const queryString = new URLSearchParams(params).toString();
            return ApiService.request(`/drivers/me/car-checks${queryString ? `?${queryString}` : ''}`);
        },

        // --- Trip Witness Note (v4) ---
        async uploadWitnessNote(tripId, blob, durationSeconds = null) {
            const fd = new FormData();
            fd.append('audio', blob, `witness-${Date.now()}.webm`);
            if (Number.isFinite(durationSeconds)) fd.append('duration_seconds', String(durationSeconds));
            return ApiService.requestForm(`/trips/${encodeURIComponent(tripId)}/witness-notes`, fd, { method: 'POST' });
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
            },

            // Driving Coach trend (last N days)
            async getDrivingCoachTrend(driverId, days = 7) {
                const params = new URLSearchParams();
                if (Number.isFinite(Number(days))) params.set('days', String(days));
                const qs = params.toString();
                return ApiService.request(`/drivers/${encodeURIComponent(driverId)}/driving-coach/trend${qs ? `?${qs}` : ''}`);
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

        async getAudit(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/audit${qs ? `?${qs}` : ''}`);
        },

        // U9: Crisis mode
        async getCrisisMode() {
            return ApiService.request('/admin/crisis-mode');
        },

        async updateCrisisMode(payload = {}) {
            return ApiService.request('/admin/crisis-mode', {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        // U7: Sensitive access
        async createSensitiveAccessGrant(payload = {}) {
            return ApiService.request('/admin/sensitive-access/grant', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getCaseSensitive(caseType, caseId, grantId) {
            return ApiService.request(`/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/sensitive`, {
                headers: grantId ? { 'X-Sensitive-Access-Grant': String(grantId) } : {}
            });
        },

        // Unified admin case inbox
        async getCases(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/cases${qs ? `?${qs}` : ''}`);
        },

        // U1: Case Time-Machine
        async getCaseTimeline(caseType, caseId) {
            return ApiService.request(`/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/timeline`);
        },

        async addCaseNote(caseType, caseId, note) {
            return ApiService.request(`/admin/cases/${encodeURIComponent(caseType)}/${encodeURIComponent(caseId)}/notes`, {
                method: 'POST',
                body: JSON.stringify({ note })
            });
        },

        // U2: Remedy packs
        async getRemedyPacks(caseType) {
            const qs = caseType ? `?case_type=${encodeURIComponent(caseType)}` : '';
            return ApiService.request(`/admin/remedy-packs${qs}`);
        },

        async previewRemedyPack(payload = {}) {
            return ApiService.request('/admin/remedy-packs/preview', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async executeRemedyPack(payload = {}) {
            return ApiService.request('/admin/remedy-packs/execute', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // U3: Payment truth ledger
        async getTripPaymentLedger(tripId) {
            return ApiService.request(`/admin/trips/${encodeURIComponent(tripId)}/payment-ledger`);
        },

        async cancelTrip(tripId, note = '') {
            const payload = { status: 'cancelled' };
            const normalizedNote = note !== undefined && note !== null ? String(note).trim() : '';
            if (normalizedNote) {
                payload.review = normalizedNote;
            }
            return ApiService.request(`/trips/${encodeURIComponent(tripId)}/status`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        async getTripEvidenceBundle(tripId, params = {}, grantId = null) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/trips/${encodeURIComponent(tripId)}/evidence-bundle${qs ? `?${qs}` : ''}`, {
                headers: grantId ? { 'X-Sensitive-Access-Grant': String(grantId) } : {}
            });
        },

        // U4: Reconciliation
        async getDailyReconciliation(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/reconciliation/daily${qs ? `?${qs}` : ''}`);
        },

        async openReconciliationCase(payload = {}) {
            return ApiService.request('/admin/reconciliation/open-case', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // U5: Dispute mediation
        async getDisputeSession(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/disputes/session${qs ? `?${qs}` : ''}`);
        },

        async upsertDisputeSession(payload = {}) {
            return ApiService.request('/admin/disputes/session', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async closeDisputeSession(payload = {}) {
            return ApiService.request('/admin/disputes/session/close', {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        // U6: QA sampling + reviews
        async getQaReviews(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/qa/reviews${qs ? `?${qs}` : ''}`);
        },

        async createQaReview(payload = {}) {
            return ApiService.request('/admin/qa/reviews', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getQaSample(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/qa/sample${qs ? `?${qs}` : ''}`);
        },

        // U8: Policy sandbox
        async runPolicySandboxRefundCap(payload = {}) {
            return ApiService.request('/admin/policy-sandbox/refund-cap', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // U10: Root cause reporting
        async getRootCausesTop(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/root-causes/top${qs ? `?${qs}` : ''}`);
        },

        // Ops / existing admin modules
        async getOpsSnapshot() {
            return ApiService.request('/admin/ops/snapshot');
        },

        async createExecutiveDecision(payload = {}) {
            return ApiService.request('/admin/executive/decisions', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getExecutiveDecisionImpact(id) {
            return ApiService.request(`/admin/executive/decision-impact/${encodeURIComponent(id)}`);
        },

        async simulateExecutive(payload = {}) {
            return ApiService.request('/admin/executive/simulate', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getExecutiveTrustIndex(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/executive/trust-index${qs ? `?${qs}` : ''}`);
        },

        async triggerExecutivePlaybook(payload = {}) {
            return ApiService.request('/admin/executive/playbook/trigger', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async getExecutiveBriefing(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/executive/briefing${qs ? `?${qs}` : ''}`);
        },

        async listPickupHubs(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/pickup-hubs${qs ? `?${qs}` : ''}`);
        },

        async createPickupHub(payload = {}) {
            return ApiService.request('/admin/pickup-hubs', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async updatePickupHub(id, payload = {}) {
            return ApiService.request(`/admin/pickup-hubs/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        async getPickupHubMetrics(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/pickup-hubs/metrics${qs ? `?${qs}` : ''}`);
        },

        async createWalletTransaction(payload) {
            return ApiService.request('/admin/wallet/transaction', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        async listSupportTickets(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/support/tickets${qs ? `?${qs}` : ''}`);
        },

        async updateSupportTicket(id, payload = {}) {
            return ApiService.request(`/admin/support/tickets/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        async listLostItems(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/lost-items${qs ? `?${qs}` : ''}`);
        },

        async updateLostItem(id, payload = {}) {
            return ApiService.request(`/admin/lost-items/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        async listRefundRequests(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/refund-requests${qs ? `?${qs}` : ''}`);
        },

        async updateRefundRequest(id, payload = {}) {
            return ApiService.request(`/admin/refund-requests/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        },

        // Incident / Dispute review
        async listIncidents(params = {}) {
            const qs = new URLSearchParams(params).toString();
            return ApiService.request(`/admin/incidents${qs ? `?${qs}` : ''}`);
        },

        async getIncident(id) {
            return ApiService.request(`/admin/incidents/${encodeURIComponent(id)}`);
        },

        async resolveIncident(id, payload = {}) {
            return ApiService.request(`/admin/incidents/${encodeURIComponent(id)}/resolve`, {
                method: 'PATCH',
                body: JSON.stringify(payload)
            });
        }
    }
};

// Make it globally available
window.ApiService = ApiService;

console.log('✅ API Service initialized');
