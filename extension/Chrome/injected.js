window.hasMovixExtension = true;
window.hasMovixNexusExtractor = true; // Signals that M3U8 extraction is available locally
window.dispatchEvent(new CustomEvent('movix-extension-loaded'));
console.log("Movix Extension loaded in page context (with Nexus M3U8 extractors)");

window.movixKisskhFallback = function(request) {
    return new Promise((resolve) => {
        const messageId = 'kisskh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        let settled = false;
        let timeoutId;

        const cleanup = () => {
            window.removeEventListener('message', handler);
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        };
        const finish = (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const handler = (event) => {
            if (event.data && event.data.source === 'MOVIX_EXTENSION' && event.data.messageId === messageId) {
                finish(event.data.success
                    ? event.data.data
                    : { success: false, code: 'unsupported_transport' });
            }
        };

        window.addEventListener('message', handler);
        timeoutId = setTimeout(() => {
            finish({ success: false, code: 'timeout' });
        }, 15000);
        window.postMessage({
            source: 'MOVIX_WEB',
            type: 'EXTENSION_REQUEST',
            action: 'KISSKH_FALLBACK',
            messageId,
            payload: request
        }, '*');
    });
};

/**
 * Helper: Extract M3U8 from a single embed URL via the extension
 * Usage: const result = await window.movixExtractM3u8('voe', 'https://voe.sx/xxx');
 *        or: const result = await window.movixExtractM3u8(null, 'https://vidzy.org/xxx'); // auto-detect
 * Returns: { success, hlsUrl?, m3u8Url?, source?, error? }
 */
window.movixExtractM3u8 = function(type, url) {
    return new Promise((resolve, reject) => {
        const messageId = 'nexus_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const handler = (event) => {
            if (event.data && event.data.source === 'MOVIX_EXTENSION' && event.data.messageId === messageId) {
                window.removeEventListener('message', handler);
                if (event.data.success) {
                    resolve(event.data.data);
                } else {
                    resolve({ success: false, error: event.data.error });
                }
            }
        };

        window.addEventListener('message', handler);

        // Timeout after 15s
        setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve({ success: false, error: 'Extraction timeout' });
        }, 15000);

        window.postMessage({
            source: 'MOVIX_WEB',
            type: 'EXTENSION_REQUEST',
            action: 'EXTRACT_M3U8',
            messageId,
            payload: { type, url }
        }, window.location.origin);
    });
};

/**
 * Helper: Extract all M3U8 from a list of embed sources in parallel
 * Usage: const results = await window.movixExtractAllM3u8(['https://voe.sx/x', 'https://vidzy.org/y']);
 *        or with player info: await window.movixExtractAllM3u8([{link:'url', player:'voe'}]);
 * Returns: { success, total, successCount, results: [...] }
 */
window.movixExtractAllM3u8 = function(sources) {
    return new Promise((resolve, reject) => {
        const messageId = 'nexus_all_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const handler = (event) => {
            if (event.data && event.data.source === 'MOVIX_EXTENSION' && event.data.messageId === messageId) {
                window.removeEventListener('message', handler);
                if (event.data.success) {
                    resolve(event.data.data);
                } else {
                    resolve({ success: false, error: event.data.error, results: [] });
                }
            }
        };

        window.addEventListener('message', handler);

        // Timeout after 30s for batch extraction
        setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve({ success: false, error: 'Bulk extraction timeout', results: [] });
        }, 30000);

        window.postMessage({
            source: 'MOVIX_WEB',
            type: 'EXTENSION_REQUEST',
            action: 'EXTRACT_ALL_M3U8',
            messageId,
            payload: { sources }
        }, window.location.origin);
    });
};

/**
 * Helper: Detect supported embed types from a list of URLs
 * Usage: const embeds = await window.movixDetectEmbeds(['url1', 'url2']);
 * Returns: { embeds: [{type, url, priority}, ...] }
 */
window.movixDetectEmbeds = function(sources) {
    return new Promise((resolve) => {
        const messageId = 'nexus_detect_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const handler = (event) => {
            if (event.data && event.data.source === 'MOVIX_EXTENSION' && event.data.messageId === messageId) {
                window.removeEventListener('message', handler);
                resolve(event.data.success ? event.data.data : { embeds: [] });
            }
        };

        window.addEventListener('message', handler);
        setTimeout(() => { window.removeEventListener('message', handler); resolve({ embeds: [] }); }, 5000);

        window.postMessage({
            source: 'MOVIX_WEB',
            type: 'EXTENSION_REQUEST',
            action: 'DETECT_EMBEDS',
            messageId,
            payload: { sources }
        }, window.location.origin);
    });
};

/**
 * Helper: Setup DNR headers for a service URL (e.g. cinep for PurStream)
 * Usage: await window.movixSetupHeaders('cinep', 'https://zebi.xalaflix.design/...');
 */
window.movixSetupHeaders = function(type, url) {
    return new Promise((resolve) => {
        const messageId = 'nexus_headers_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const handler = (event) => {
            if (event.data && event.data.source === 'MOVIX_EXTENSION' && event.data.messageId === messageId) {
                window.removeEventListener('message', handler);
                resolve(event.data.success ? event.data.data : { success: false, error: event.data.error });
            }
        };

        window.addEventListener('message', handler);
        setTimeout(() => { window.removeEventListener('message', handler); resolve({ success: false, error: 'Timeout' }); }, 3000);

        window.postMessage({
            source: 'MOVIX_WEB',
            type: 'EXTENSION_REQUEST',
            action: 'SETUP_HEADERS',
            messageId,
            payload: { type, url }
        }, window.location.origin);
    });
};
