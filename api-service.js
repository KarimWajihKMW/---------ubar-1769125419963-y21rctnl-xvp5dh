// API Service for Akwadra Taxi App
const API_BASE_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000/api' 
    : '/api';

const ApiService = {
    // Helper function for making requests
    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Request failed');
            }
            
            return data;
        } catch (error) {
            console.error('API Request Error:', error);
            throw error;
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
            const { carType = null, driverId = null, lat = null, lng = null } = options || {};
            const params = new URLSearchParams();
            if (carType) params.set('car_type', carType);
            if (driverId) params.set('driver_id', driverId);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                params.set('lat', lat);
                params.set('lng', lng);
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
        }
    }
};

// Make it globally available
window.ApiService = ApiService;

console.log('✅ API Service initialized');
