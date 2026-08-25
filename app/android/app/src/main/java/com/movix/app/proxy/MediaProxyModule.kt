package com.movix.app.proxy

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import java.util.concurrent.Executors

class MediaProxyModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    // Fetch upstream via Cronet (signature TLS Chrome) pour passer les CDN
    // fsvid/vidzy qui bloquent okhttp ; repli okhttp integre dans l'upstream.
    private val server = MediaProxyServer(
        upstream = CronetMediaProxyUpstream(reactContext.applicationContext),
    )
    private val openExecutor = Executors.newFixedThreadPool(2) { task ->
        Thread(task, "MovixMediaProxy-Open").apply { isDaemon = true }
    }

    override fun getName() = "MediaProxy"

    @ReactMethod
    fun open(
        url: String,
        method: String,
        headers: ReadableMap,
        promise: Promise,
    ) {
        openExecutor.execute {
            try {
                promise.resolve(
                    server.open(
                        upstreamUrl = url,
                        method = method,
                        headers = readableMapToStrings(headers),
                    ),
                )
            } catch (_: Throwable) {
                promise.reject(
                    "MEDIA_PROXY_OPEN_FAILED",
                    "Local media proxy unavailable",
                )
            }
        }
    }

    @ReactMethod
    fun resolveForCast(localUrl: String, promise: Promise) {
        openExecutor.execute {
            try {
                val target = server.resolveLoopbackTargetForCast(localUrl)
                    ?: throw IllegalArgumentException("Unknown local media source")
                val headers = Arguments.createMap()
                target.headers.forEach(headers::putString)
                promise.resolve(
                    Arguments.createMap().apply {
                        putString("url", target.upstreamUrl)
                        putMap("headers", headers)
                        putInt("protocolVersion", 1)
                    },
                )
            } catch (_: Throwable) {
                promise.reject(
                    "MEDIA_PROXY_CAST_RESOLVE_FAILED",
                    "Local media source unavailable",
                )
            }
        }
    }

    // --- Journal réseau (diagnostic) ---
    // La requête média part du natif : sans ces trois méthodes, ni l'utilisateur
    // ni un inspecteur réseau ne voient les en-têtes réellement émis, et un 403
    // d'hébergeur reste indébogable. Tout est en mémoire, éteint par défaut.

    @ReactMethod
    fun setJournalEnabled(enabled: Boolean, promise: Promise) {
        MediaProxyJournal.setEnabled(enabled)
        promise.resolve(enabled)
    }

    @ReactMethod
    fun getJournal(promise: Promise) {
        val entries = Arguments.createArray()
        MediaProxyJournal.snapshot().forEach(entries::pushString)
        promise.resolve(entries)
    }

    @ReactMethod
    fun clearJournal(promise: Promise) {
        MediaProxyJournal.clear()
        promise.resolve(true)
    }

    @ReactMethod
    fun recordJournalEntry(
        phase: String,
        method: String,
        url: String,
        headers: ReadableMap,
        statusCode: Int,
        error: String?,
        promise: Promise,
    ) {
        MediaProxyJournal.record(
            phase = phase,
            method = method,
            url = url,
            requestHeaders = readableMapToStrings(headers),
            statusCode = statusCode.takeIf { it > 0 },
            error = error,
        )
        promise.resolve(true)
    }

    override fun invalidate() {
        openExecutor.shutdownNow()
        server.close()
        super.invalidate()
    }

    private fun readableMapToStrings(input: ReadableMap): Map<String, String> {
        val result = linkedMapOf<String, String>()
        val iterator = input.keySetIterator()
        while (iterator.hasNextKey() && result.size < MAX_HEADERS) {
            val key = iterator.nextKey()
            if (input.getType(key) != ReadableType.String) continue
            val value = input.getString(key) ?: continue
            if (
                key.length > MAX_HEADER_NAME_LENGTH ||
                value.length > MAX_HEADER_VALUE_LENGTH ||
                key.contains('\r') ||
                key.contains('\n') ||
                value.contains('\r') ||
                value.contains('\n')
            ) {
                continue
            }
            result[key] = value
        }
        return result
    }

    companion object {
        private const val MAX_HEADERS = 32
        private const val MAX_HEADER_NAME_LENGTH = 128
        private const val MAX_HEADER_VALUE_LENGTH = 8_192
    }
}
