package com.movix.app.proxy

import android.content.Context
import android.net.Network
import android.util.Log
import com.google.android.gms.net.CronetProviderInstaller
import com.google.android.gms.tasks.Tasks
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.chromium.net.CronetEngine
import org.chromium.net.CronetException
import org.chromium.net.ExperimentalCronetEngine
import org.chromium.net.ExperimentalUrlRequest
import org.chromium.net.UrlRequest
import org.chromium.net.UrlResponseInfo

/**
 * Upstream du proxy media qui fetch via **Cronet** (le moteur reseau de
 * Chromium, charge depuis Google Play Services).
 *
 * Pourquoi : les CDN fsvid/vidzy filtrent la signature TLS/ClientHello du
 * client. okhttp est reconnu comme un scraper Android et bloque -> le CDN
 * renvoie 403 (vidzy) ou un flux leurre de ~18 s (fsvid). Cronet emet le meme
 * ClientHello que Chrome, donc le CDN sert le vrai flux, exactement comme dans
 * le navigateur avec l'extension.
 *
 * Cronet est asynchrone (callbacks) alors que [MediaProxyUpstream.execute] est
 * synchrone et rend un flux. Le pont est fait par [CronetResponseBody] : le
 * thread Cronet livre les chunks dans une file bornee (backpressure : le thread
 * de callback bloque quand le consommateur n'a pas draine), le thread appelant
 * les consomme via un InputStream classique.
 *
 * Repli : si Cronet ne peut pas s'initialiser (provider GMS absent) ou echoue
 * AVANT de recevoir les entetes (aucun octet consomme), on delegue a [fallback]
 * (okhttp) pour ne jamais degrader par rapport a l'existant.
 */
internal class CronetMediaProxyUpstream(
    private val context: Context,
    private val validateUrl: (String) -> URI = {
        MediaProxyPolicy.validatePublicHttpsUrl(it)
    },
    private val fallback: MediaProxyUpstream = OkHttpMediaProxyUpstream(),
    // Non-null pour le relay Cast : lie la requete Cronet au reseau Android qui
    // joint a la fois le Chromecast et Internet (comme le socketFactory
    // network-bound d'okhttp). Null pour la lecture in-app (egress systeme).
    private val boundNetwork: Network? = null,
) : MediaProxyUpstream {

    @Volatile
    private var engineResolved = false

    @Volatile
    private var engine: CronetEngine? = null

    private fun cronetEngine(): CronetEngine? {
        if (engineResolved) return engine
        synchronized(this) {
            if (engineResolved) return engine
            engine = runCatching {
                // Installe le provider Cronet depuis GMS puis construit le moteur.
                Tasks.await(
                    CronetProviderInstaller.installProvider(context),
                    PROVIDER_INSTALL_TIMEOUT_SEC,
                    TimeUnit.SECONDS,
                )
                // Experimental* pour acceder a bindToNetwork sur le builder de
                // requete (necessaire au relay Cast).
                ExperimentalCronetEngine.Builder(context)
                    .enableHttp2(true)
                    .enableBrotli(true)
                    // QUIC desactive : certains reseaux bloquent l'UDP 443, et le
                    // ClientHello TLS (ce que le CDN fingerprinte) reste celui de
                    // Chromium de toute facon.
                    .enableQuic(false)
                    .build()
            }.onFailure {
                Log.w(TAG, "Cronet indisponible, repli okhttp: ${it.message}")
            }.getOrNull()
            engineResolved = true
            return engine
        }
    }

    override fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse {
        val activeEngine = cronetEngine()
            ?: return fallback.execute(target, localRequestHeaders)

        // Meme fusion d'entetes que OkHttpMediaProxyUpstream.
        val mergedHeaders = linkedMapOf<String, String>()
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeRequestHeaders(target.headers))
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeLocalRequestHeaders(localRequestHeaders))
        mergedHeaders.putIfAbsent("Sec-Fetch-Site", "cross-site")
        mergedHeaders.putIfAbsent("Sec-Fetch-Mode", "cors")
        mergedHeaders.putIfAbsent("Sec-Fetch-Dest", "empty")
        mergedHeaders.putIfAbsent(
            "User-Agent",
            MediaProxyPolicy.playbackUserAgent(target.upstreamUrl),
        )

        val validated = validateUrl(target.upstreamUrl)

        // Parite SSRF avec le chemin okhttp network-bound : quand on est lie a un
        // reseau, la resolution DNS se fait dans Cronet, donc on pre-resout ici
        // sur ce meme reseau et on rejette toute adresse privee avant la requete.
        boundNetwork?.let { network ->
            val host = validated.host
                ?: throw IllegalArgumentException("Missing upstream host")
            val addresses: List<InetAddress> = try {
                network.getAllByName(host).toList()
            } catch (error: Exception) {
                throw UnknownHostException("Selected-network DNS failed").apply {
                    initCause(error)
                }
            }
            if (addresses.isEmpty() || addresses.any(MediaProxyPolicy::isForbiddenAddress)) {
                throw UnknownHostException("Private or unresolved media host")
            }
        }

        return runCronet(activeEngine, target, mergedHeaders)
            ?: fallback.execute(target, localRequestHeaders)
    }

    /**
     * Lance la requete Cronet. Rend la reponse en streaming, ou `null` si Cronet
     * echoue avant les entetes (le caller retombe alors sur okhttp — sans risque
     * puisque aucun octet du corps n'a ete consomme).
     */
    private fun runCronet(
        engine: CronetEngine,
        target: MediaProxyTarget,
        headers: Map<String, String>,
    ): MediaProxyUpstreamResponse? {
        val callbackExecutor: Executor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "MovixCronetProxy").apply { isDaemon = true }
        }
        val callback = CronetProxyCallback(validateUrl)

        val builder = engine.newUrlRequestBuilder(target.upstreamUrl, callback, callbackExecutor)
            .setHttpMethod(if (target.method == "HEAD") "HEAD" else "GET")
            .disableCache()
            .setPriority(UrlRequest.Builder.REQUEST_PRIORITY_MEDIUM)
        for ((name, value) in headers) {
            builder.addHeader(name, value)
        }
        // Relay Cast : force l'egress sur le reseau selectionne.
        boundNetwork?.let { network ->
            (builder as? ExperimentalUrlRequest.Builder)
                ?.bindToNetwork(network.networkHandle)
        }
        val request = builder.build()
        callback.attach(request)
        request.start()

        val gotHeaders = callback.awaitHeaders(HEADER_TIMEOUT_SEC, TimeUnit.SECONDS)
        if (!gotHeaders || callback.startError != null || callback.responseInfo == null) {
            runCatching { request.cancel() }
            (callbackExecutor as? java.util.concurrent.ExecutorService)?.shutdownNow()
            Log.w(
                TAG,
                "Cronet echec pre-entetes, repli okhttp: ${callback.startError?.message ?: "timeout"}",
            )
            return null
        }

        val info = callback.responseInfo!!
        val responseHeaders = linkedMapOf<String, String>()
        for (entry in info.allHeadersAsList) {
            val name = entry.key
            responseHeaders.merge(name, entry.value) { a, b -> "$a, $b" }
        }

        return MediaProxyUpstreamResponse(
            statusCode = info.httpStatusCode,
            statusMessage = info.httpStatusText ?: "",
            headers = responseHeaders,
            body = callback.body,
            finalUrl = info.url ?: target.upstreamUrl,
            onClose = {
                runCatching { request.cancel() }
                (callbackExecutor as? java.util.concurrent.ExecutorService)?.shutdownNow()
            },
        )
    }

    companion object {
        private const val TAG = "CronetMediaProxy"
        private const val PROVIDER_INSTALL_TIMEOUT_SEC = 10L
        private const val HEADER_TIMEOUT_SEC = 20L
    }
}

/**
 * Callback Cronet + pont vers un [InputStream] bloquant avec backpressure.
 * Les chunks transitent par une file bornee : quand elle est pleine, le thread
 * Cronet bloque dans `put`, ce qui met la lecture reseau en pause tant que le
 * consommateur n'a pas draine — pas d'accumulation memoire sur un gros segment.
 */
private class CronetProxyCallback(
    private val validateUrl: (String) -> URI,
) : UrlRequest.Callback() {

    private val headerLatch = CountDownLatch(1)
    private val queue = ArrayBlockingQueue<Any>(QUEUE_CAPACITY)
    private val readBuffer: ByteBuffer = ByteBuffer.allocateDirect(READ_BUFFER_BYTES)
    private var redirectCount = 0

    @Volatile
    var responseInfo: UrlResponseInfo? = null
        private set

    @Volatile
    var startError: Throwable? = null
        private set

    @Volatile
    private var request: UrlRequest? = null

    val body: InputStream = CronetResponseBody()

    fun attach(request: UrlRequest) {
        this.request = request
    }

    fun awaitHeaders(timeout: Long, unit: TimeUnit): Boolean =
        headerLatch.await(timeout, unit)

    override fun onRedirectReceived(
        request: UrlRequest,
        info: UrlResponseInfo,
        newLocationUrl: String,
    ) {
        redirectCount += 1
        if (redirectCount > MAX_REDIRECTS) {
            startError = IOException("Too many media redirects")
            request.cancel()
            return
        }
        val valid = runCatching { validateUrl(newLocationUrl) }.isSuccess
        if (!valid) {
            startError = IllegalArgumentException("Invalid media redirect")
            request.cancel()
            return
        }
        request.followRedirect()
    }

    override fun onResponseStarted(request: UrlRequest, info: UrlResponseInfo) {
        responseInfo = info
        headerLatch.countDown()
        readBuffer.clear()
        request.read(readBuffer)
    }

    override fun onReadCompleted(
        request: UrlRequest,
        info: UrlResponseInfo,
        byteBuffer: ByteBuffer,
    ) {
        byteBuffer.flip()
        val data = ByteArray(byteBuffer.remaining())
        byteBuffer.get(data)
        byteBuffer.clear()
        // Bloque si le consommateur n'a pas draine -> backpressure reseau.
        putBlocking(data)
        request.read(byteBuffer)
    }

    override fun onSucceeded(request: UrlRequest, info: UrlResponseInfo) {
        putBlocking(EndOfStream)
    }

    override fun onFailed(
        request: UrlRequest,
        info: UrlResponseInfo?,
        error: CronetException,
    ) {
        if (headerLatch.count > 0L) {
            startError = error
            headerLatch.countDown()
        } else {
            putBlocking(error)
        }
    }

    override fun onCanceled(request: UrlRequest, info: UrlResponseInfo?) {
        val cause = startError ?: IOException("Media request canceled")
        if (headerLatch.count > 0L) {
            startError = cause
            headerLatch.countDown()
        } else {
            putBlocking(cause)
        }
    }

    private fun putBlocking(item: Any) {
        try {
            queue.put(item)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private inner class CronetResponseBody : InputStream() {
        private var current: ByteArray? = null
        private var offset = 0
        private var finished = false

        override fun read(): Int {
            val one = ByteArray(1)
            val n = read(one, 0, 1)
            return if (n <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (!ensureChunk()) return -1
            val chunk = current!!
            val available = chunk.size - offset
            val n = minOf(available, len)
            System.arraycopy(chunk, offset, b, off, n)
            offset += n
            if (offset >= chunk.size) {
                current = null
                offset = 0
            }
            return n
        }

        /** Garantit qu'un chunk exploitable est dispo, ou signale la fin/erreur. */
        private fun ensureChunk(): Boolean {
            if (current != null && offset < current!!.size) return true
            if (finished) return false
            while (true) {
                val item = try {
                    queue.take()
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    finished = true
                    throw IOException("Interrupted while reading media body")
                }
                when (item) {
                    is EndOfStream -> {
                        finished = true
                        return false
                    }
                    is Throwable -> {
                        finished = true
                        throw IOException("Cronet media stream failed", item)
                    }
                    is ByteArray -> {
                        if (item.isEmpty()) continue
                        current = item
                        offset = 0
                        return true
                    }
                    else -> continue
                }
            }
        }

        override fun close() {
            finished = true
            current = null
            request?.let { runCatching { it.cancel() } }
        }
    }

    private object EndOfStream

    companion object {
        private const val MAX_REDIRECTS = 5
        private const val QUEUE_CAPACITY = 4
        private const val READ_BUFFER_BYTES = 32 * 1024
    }
}
