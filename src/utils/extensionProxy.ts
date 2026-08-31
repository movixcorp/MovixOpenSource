
interface ExtensionResponse<T = unknown> {
    source: string;
    messageId: string;
    success: boolean;
    data?: T;
    error?: string;
}

export const isExtensionAvailable = (): boolean => {
    const w = window as Window & {
        hasMovixExtension?: boolean;
        __MOVIX_EXTENSION_INSTALLED?: boolean;
        hasMovixUserscript?: boolean;
    };
    return (
        w.hasMovixExtension === true ||
        w.__MOVIX_EXTENSION_INSTALLED === true ||
        w.hasMovixUserscript === true ||
        document.documentElement?.dataset.movixExtension === 'true'
    );
};

export const fetchFromExtension = <T = unknown>(
    action: string,
    payload: Record<string, unknown> = {}
): Promise<T> => {
    return new Promise((resolve, reject) => {
        if (!isExtensionAvailable()) {
            return reject(new Error("Extension not available"));
        }

        const accessKey = window.localStorage.getItem("access_code");
        const enrichedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
            ? { ...payload, ...(accessKey ? { accessKey } : {}) }
            : payload;

        const messageId = Math.random().toString(36).substring(7);

        const handler = (event: MessageEvent<ExtensionResponse<T>>) => {
            const response = event.data;

            // We accept messages from window, must be from extension content script
            if (event.source !== window || !response || response.source !== "MOVIX_EXTENSION") return;

            if (response.messageId === messageId) {
                window.removeEventListener("message", handler);
                if (response.success) {
                    resolve(response.data as T);
                } else {
                    reject(new Error(response.error || "Unknown extension error"));
                }
            }
        };

        window.addEventListener("message", handler);
        window.postMessage({
            source: "MOVIX_WEB",
            type: "EXTENSION_REQUEST",
            action,
            payload: enrichedPayload,
            messageId
        }, window.location.origin);

        // Timeout after 10 seconds
        setTimeout(() => {
            window.removeEventListener("message", handler);
            reject(new Error("Extension request timed out"));
        }, 10000);
    });
};
