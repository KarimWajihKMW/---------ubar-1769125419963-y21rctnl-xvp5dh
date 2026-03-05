(function bootstrapGoogleMaps() {
    function readBrowserGoogleMapsKey() {
        try {
            var qsKey = new URLSearchParams(window.location.search).get('gmap_key');
            if (qsKey && String(qsKey).trim()) return String(qsKey).trim();
        } catch (e) {}
        try {
            var stored = window.localStorage.getItem('akwadra_google_maps_key');
            if (stored && String(stored).trim()) return String(stored).trim();
        } catch (e) {}
        return '';
    }

    if (window.google && window.google.maps) {
        window.__googleMapsReadyPromise = Promise.resolve(window.google.maps);
        return;
    }

    if (window.__googleMapsReadyPromise) {
        return;
    }

    window.__googleMapsReadyPromise = fetch('/api/public-config', {
        method: 'GET',
        headers: { Accept: 'application/json' }
    })
        .then(function(response) {
            if (!response.ok) throw new Error('public-config fetch failed');
            return response.json();
        })
        .then(function(payload) {
            var cfg = payload && (payload.data || payload);
            var key = cfg && cfg.googleMapsApiKey ? String(cfg.googleMapsApiKey).trim() : '';
            if (!key) key = readBrowserGoogleMapsKey();
            if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

            return new Promise(function(resolve, reject) {
                var callbackName = '__akwadraGoogleMapsLoaderCb_' + Date.now();
                window[callbackName] = function() {
                    try { delete window[callbackName]; } catch (e) {}
                    resolve(window.google.maps);
                };

                var script = document.createElement('script');
                script.async = true;
                script.defer = true;
                script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=places&language=ar&region=EG&callback=' + encodeURIComponent(callbackName);
                script.onerror = function() {
                    try { delete window[callbackName]; } catch (e) {}
                    reject(new Error('Google Maps script load failed'));
                };
                document.head.appendChild(script);
            });
        })
        .catch(function(err) {
            console.error('Google Maps bootstrap failed:', err && err.message ? err.message : err);
            throw err;
        });
})();
