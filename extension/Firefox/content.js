// Firefox-compatible content script for Movix Extension
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Inject a flag so the page knows the extension is active
const script = document.createElement('script');
script.src = browserAPI.runtime.getURL('injected.js');
script.onload = function () {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

// Listen for messages from the web page
window.addEventListener("message", async (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.source !== "MOVIX_WEB") {
        return;
    }

    const { type, action, payload, messageId } = event.data;

    if (type === "EXTENSION_REQUEST") {
        try {
            // Forward to background
            const response = await browserAPI.runtime.sendMessage({ action, payload });

            if (response && response.error) {
                window.postMessage({
                    source: "MOVIX_EXTENSION",
                    messageId,
                    success: false,
                    error: response.error
                }, window.location.origin);
            } else {
                window.postMessage({
                    source: "MOVIX_EXTENSION",
                    messageId,
                    success: true,
                    data: response
                }, window.location.origin);
            }
        } catch (error) {
            window.postMessage({
                source: "MOVIX_EXTENSION",
                messageId,
                success: false,
                error: error.message
            }, window.location.origin);
        }
    }
});

// Also listen for messages from the background script
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Forward extraction results back to the page if needed
    if (message.type === 'EXTRACTION_RESULT') {
        window.postMessage({
            source: 'MOVIX_EXTENSION',
            type: 'EXTRACTION_RESULT',
            data: message.data
        }, window.location.origin);
    }
});
