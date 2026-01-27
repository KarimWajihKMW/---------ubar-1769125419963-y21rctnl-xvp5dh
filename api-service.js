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
        async getCompleted(userId = null) {
            const params = userId ? `?user_id=${userId}` : '';
            return ApiService.request(`/trips/completed${params}`);
        },
        
        // Get cancelled trips
        async getCancelled(userId = null) {
            const params = userId ? `?user_id=${userId}` : '';
            return ApiService.request(`/trips/cancelled${params}`);
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
        async updateStatus(id, status, rating = null, review = null) {
            return ApiService.request(`/trips/${id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status, rating, review })
            });
        },
        
        // Get trip statistics
        async getStats(userId = null) {
            const params = userId ? `?user_id=${userId}` : '';
            return ApiService.request(`/trips/stats/summary${params}`);
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
        }
    }
};

// Make it globally available
window.ApiService = ApiService;

console.log('✅ API Service initialized');
