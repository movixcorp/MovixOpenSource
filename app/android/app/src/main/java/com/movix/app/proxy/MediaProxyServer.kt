package com.movix.app.proxy

import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.io.PushbackInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URI
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request

private const val MAX_PLAYLIST_PREFIX_BYTES = 1_024
private const val MAX_RESPONSE_PUSHBACK_BYTES = PngWrappedMpegTs.MAX_PROBE_BYTES
private const val STREAM_BUFFER_BYTES = 8 * 1_024
private const val PLAYLIST_PROBE_CHUNK_BYTES = 16
private val PLAYLIST_PREFIX = "#EXTM3U".toByteArray(StandardCharsets.US_ASCII)

private enum class BinaryPayloadKind {
    PNG_TS,
    TS,
    AAC,
    FMP4,
    ID3,
    UNKNOWN,
}

internal sealed interface MediaProxyServerConfig {
    data object Loopback : MediaProxyServerConfig

    data class CastLan(
        val bindAddress: InetAddress,
        val allowedClientAddress: InetAddress,
    ) : MediaProxyServerConfig {
        init {
            MediaProxyPolicy.requireUsableCastLanAddress(bindAddress)
            MediaProxyPolicy.requireUsableCastLanAddress(allowedClientAddress)
        }
    }
}

internal data class CastRequestPath(
    val sessionId: String,
    val resourceId: String,
)

internal class CastRequestGate(
    private val config: MediaProxyServerConfig.CastLan,
) {
    fun acceptsPeer(peerAddress: InetAddress): Boolean {
        return MediaProxyPolicy.sameSocketPeer(config.allowedClientAddress, peerAddress)
    }

    fun parsePath(path: String): CastRequestPath? {
        val parts = path.split('/').filter(String::isNotEmpty)
        if (
            parts.size != 3 ||
            parts[0] != "cast" ||
            !MediaProxyPolicy.isOpaqueToken(parts[1]) ||
            !MediaProxyPolicy.isOpaqueToken(parts[2])
        ) {
            return null
        }
        return CastRequestPath(parts[1], parts[2])
    }

    fun acceptsOrigin(method: String, requestHeaders: Map<String, String>): Boolean {
        val origin = header(requestHeaders, "Origin")
        if (origin == null) return method != "OPTIONS"
        if (canonicalHttpsOrigin(origin) == null) return false
        if (method == "OPTIONS") {
            val requestedMethod = header(requestHeaders, "Access-Control-Request-Method")
                ?.uppercase(Locale.US)
            return requestedMethod in setOf("GET", "HEAD", "OPTIONS")
        }
        return true
    }

    fun corsHeaders(
        method: String,
        requestHeaders: Map<String, String>,
    ): Map<String, String> {
        val output = linkedMapOf(
            "Access-Control-Allow-Origin" to
                (header(requestHeaders, "Origin")?.let(::canonicalHttpsOrigin) ?: "*"),
            "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers" to
                "Range, Accept-Encoding, Content-Type",
            "Access-Control-Expose-Headers" to
                "Content-Length, Content-Range, Accept-Ranges, Content-Type",
            "Vary" to
                "Origin, Access-Control-Request-Method, " +
                "Access-Control-Request-Headers, " +
                "Access-Control-Request-Private-Network",
        )
        if (
            method == "OPTIONS" &&
            acceptsOrigin(method, requestHeaders) &&
            header(requestHeaders, "Access-Control-Request-Private-Network")
                ?.equals("true", ignoreCase = true) == true
        ) {
            output["Access-Control-Allow-Private-Network"] = "true"
        }
        return output
    }

    private fun header(headers: Map<String, String>, name: String): String? {
        return headers.entries.firstOrNull {
            it.key.equals(name, ignoreCase = true)
        }?.value
    }

    private fun canonicalHttpsOrigin(origin: String): String? {
        return runCatching { MediaProxyPolicy.validateReceiverOrigin(origin) }
            .getOrNull()
            ?.takeIf { it == origin }
    }
}

internal fun mediaProxyUrlValidatorFor(
    config: MediaProxyServerConfig,
): (String) -> URI = when (config) {
    MediaProxyServerConfig.Loopback -> MediaProxyPolicy::validatePublicHttpsUrl
    is MediaProxyServerConfig.CastLan -> MediaProxyPolicy::validateHttpsUrlSyntax
}

internal interface MediaProxyUpstream {
    fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse
}

internal class MediaProxyUpstreamResponse(
    val statusCode: Int,
    val statusMessage: String,
    val headers: Map<String, String>,
    body: InputStream,
    val finalUrl: String,
    private val onClose: () -> Unit = {},
) : Closeable {
    val body = PushbackInputStream(body, MAX_RESPONSE_PUSHBACK_BYTES)

    override fun close() {
        try {
            body.close()
        } finally {
            onClose()
        }
    }
}

internal data class PreparedPngTsResponse(
    val statusCode: Int,
    val statusMessage: String,
    val headers: Map<String, String>,
    val body: InputStream,
    val skipBytes: Long,
    val bodyBytes: Long?,
)

internal fun preparePngWrappedTsResponse(
    response: MediaProxyUpstreamResponse,
    rangeHeader: String?,
): PreparedPngTsResponse {
    val upstreamLength = response.headers.entries.firstOrNull {
        it.key.equals("Content-Length", ignoreCase = true)
    }?.value?.toLongOrNull()
    val payload = PngWrappedMpegTs.probeAndPosition(
        response.body,
        upstreamLength,
    ) ?: throw IllegalArgumentException("Invalid wrapped MPEG-TS segment")
    val range = if (rangeHeader == null) {
        HttpByteRange.None
    } else {
        val total = payload.payloadLength
            ?: throw IllegalArgumentException("Unknown wrapped payload length")
        HttpByteRange.parse(rangeHeader, total)
    }
    val headers = response.headers
        .filterKeys {
            it.lowercase(Locale.US) in setOf("cache-control", "expires", "last-modified")
        }
        .toMutableMap()
    headers["Content-Type"] = "video/mp2t"
    headers["Accept-Ranges"] = "bytes"

    return when (range) {
        HttpByteRange.None -> {
            payload.payloadLength?.let { headers["Content-Length"] = it.toString() }
            PreparedPngTsResponse(200, "OK", headers, response.body, 0L, payload.payloadLength)
        }

        HttpByteRange.Unsatisfiable -> {
            val total = requireNotNull(payload.payloadLength)
            headers["Content-Range"] = "bytes */$total"
            headers["Content-Length"] = "0"
            PreparedPngTsResponse(
                416,
                "Range Not Satisfiable",
                headers,
                response.body,
                0L,
                0L,
            )
        }

        is HttpByteRange.Valid -> {
            headers["Content-Range"] =
                "bytes ${range.start}-${range.endInclusive}/${range.total}"
            headers["Content-Length"] = range.length.toString()
            PreparedPngTsResponse(
                206,
                "Partial Content",
                headers,
                response.body,
                range.start,
                range.length,
            )
        }
    }
}

private fun classifyBinaryWithoutConsuming(body: PushbackInputStream): BinaryPayloadKind {
    val prefix = ByteArray(PngWrappedMpegTs.MAX_PROBE_BYTES)
    var count = 0
    try {
        while (count < prefix.size) {
            val read = body.read(prefix, count, prefix.size - count)
            if (read <= 0) break
            count += read
        }
    } finally {
        if (count > 0) body.unread(prefix, 0, count)
    }
    if (PngWrappedMpegTs.payloadOffset(prefix, count) != null) {
        return BinaryPayloadKind.PNG_TS
    }
    if (
        count >= PngWrappedMpegTs.TS_PACKET_BYTES * 3 &&
        listOf(0, 188, 376).all { (prefix[it].toInt() and 0xff) == 0x47 }
    ) return BinaryPayloadKind.TS
    if (
        count >= 2 &&
        (prefix[0].toInt() and 0xff) == 0xff &&
        (prefix[1].toInt() and 0xf6) == 0xf0
    ) return BinaryPayloadKind.AAC
    if (isIsoBmffFragmentStart(prefix, count)) return BinaryPayloadKind.FMP4
    if (
        count >= 3 &&
        prefix[0] == 'I'.code.toByte() &&
        prefix[1] == 'D'.code.toByte() &&
        prefix[2] == '3'.code.toByte()
    ) return BinaryPayloadKind.ID3
    return BinaryPayloadKind.UNKNOWN
}

internal fun isIsoBmffFragmentStart(prefix: ByteArray, count: Int): Boolean {
    if (count < 8) return false
    val boxType = String(prefix, 4, 4, StandardCharsets.US_ASCII)
    if (boxType !in setOf("ftyp", "styp", "moof", "sidx")) return false

    val size32 = (0 until 4).fold(0L) { size, index ->
        (size shl 8) or (prefix[index].toLong() and 0xffL)
    }
    val declaredSize = when (size32) {
        0L -> return true
        1L -> {
            if (count < 16) return false
            (8 until 16).fold(0UL) { size, index ->
                (size shl 8) or prefix[index].toUByte().toULong()
            }.takeIf { it >= 16UL } ?: return false
        }

        in 8L..Long.MAX_VALUE -> size32.toULong()
        else -> return false
    }
    return declaredSize <= count.toULong() || count == prefix.size
}

private fun isGenericBinaryContentType(contentType: String?): Boolean {
    return contentType == null || contentType == "application/octet-stream"
}

internal class OkHttpMediaProxyUpstream(
    private val validateUrl: (String) -> URI = {
        MediaProxyPolicy.validatePublicHttpsUrl(it)
    },
) : MediaProxyUpstream {
    private val safeDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val addresses = Dns.SYSTEM.lookup(hostname)
            if (addresses.isEmpty() || addresses.any(MediaProxyPolicy::isForbiddenAddress)) {
                throw UnknownHostException("Private or unresolved media host")
            }
            return addresses
        }
    }
    private val client = OkHttpClient.Builder()
        .dns(safeDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    override fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse {
        if (MediaProxyPolicy.isProviderDecoyUrl(target.upstreamUrl)) {
            throw IllegalStateException("Upstream returned a decoy stream")
        }
        val mergedHeaders = linkedMapOf<String, String>()
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeRequestHeaders(target.headers))
        mergedHeaders.putAll(MediaProxyPolicy.sanitizeLocalRequestHeaders(localRequestHeaders))
        mergedHeaders.putIfAbsent("Sec-Ch-Ua", MediaProxyPolicy.PLAYBACK_SEC_CH_UA)
        mergedHeaders.putIfAbsent("Sec-Fetch-Site", "cross-site")
        mergedHeaders.putIfAbsent("Sec-Fetch-Mode", "cors")
        mergedHeaders.putIfAbsent("Sec-Fetch-Dest", "empty")
        mergedHeaders.putIfAbsent(
            "User-Agent",
            MediaProxyPolicy.playbackUserAgent(target.upstreamUrl),
        )

        var currentUrl = target.upstreamUrl
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            validateUrl(currentUrl)
            val headerBuilder = Headers.Builder()
            for ((name, value) in mergedHeaders) {
                headerBuilder.set(name, value)
            }
            val requestBuilder = Request.Builder()
                .url(currentUrl)
                .headers(headerBuilder.build())
            if (target.method == "HEAD") {
                requestBuilder.head()
            } else {
                requestBuilder.get()
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val location = response.header("Location")
            if (response.code in 300..399 && location != null) {
                if (redirectCount >= MAX_REDIRECTS) {
                    response.close()
                    throw IllegalStateException("Too many media redirects")
                }
                val nextUrl = response.request.url.resolve(location)?.toString()
                response.close()
                currentUrl = nextUrl
                    ?: throw IllegalArgumentException("Invalid media redirect")
                if (MediaProxyPolicy.isProviderDecoyUrl(currentUrl)) {
                    throw IllegalStateException("Upstream returned a decoy stream")
                }
                return@repeat
            }

            val responseHeaders = linkedMapOf<String, String>()
            for (name in response.headers.names()) {
                responseHeaders[name] = response.headers.values(name).joinToString(", ")
            }
            val responseBody = response.body
            return MediaProxyUpstreamResponse(
                statusCode = response.code,
                statusMessage = response.message,
                headers = responseHeaders,
                body = responseBody?.byteStream() ?: ByteArrayInputStream(ByteArray(0)),
                finalUrl = response.request.url.toString(),
                onClose = response::close,
            )
        }
        throw IllegalStateException("Media redirect resolution failed")
    }

    companion object {
        private const val MAX_REDIRECTS = 5
    }
}

internal class MediaProxyServer(
    private val upstream: MediaProxyUpstream = OkHttpMediaProxyUpstream(),
    private val config: MediaProxyServerConfig = MediaProxyServerConfig.Loopback,
    private val validateUrl: (String) -> URI = mediaProxyUrlValidatorFor(config),
    private val validateDiscoveredUrl: (String) -> URI =
        MediaProxyPolicy::validateHttpsUrlSyntax,
    private val sessionStore: MediaProxySessionStore = MediaProxySessionStore(),
) : Closeable {
    private val castGate = (config as? MediaProxyServerConfig.CastLan)
        ?.let(::CastRequestGate)
    private val running = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private val startLock = Any()
    private val workerCounter = java.util.concurrent.atomic.AtomicInteger()
    private val workers = ThreadPoolExecutor(
        4,
        32,
        30L,
        TimeUnit.SECONDS,
        ArrayBlockingQueue(128),
        { task ->
            Thread(
                task,
                "MovixMediaProxy-${workerCounter.incrementAndGet()}",
            ).apply { isDaemon = true }
        },
        ThreadPoolExecutor.AbortPolicy(),
    )

    @Volatile
    private var serverSocket: ServerSocket? = null

    val boundAddress: InetAddress?
        get() = serverSocket?.inetAddress

    fun start(): Int = ensureStarted()

    fun open(
        upstreamUrl: String,
        method: String,
        headers: Map<String, String>,
    ): String {
        check(config == MediaProxyServerConfig.Loopback) {
            "Use Cast media preparation for a Cast LAN server"
        }
        check(!closed.get()) { "Media proxy is closed" }
        val normalizedMethod = method.uppercase(Locale.US)
        require(normalizedMethod == "GET" || normalizedMethod == "HEAD") {
            "Unsupported media proxy method"
        }
        val validated = validateUrl(upstreamUrl).toString()
        val sanitizedHeaders = MediaProxyPolicy.sanitizeRequestHeaders(headers)
        require(sanitizedHeaders.isNotEmpty()) { "Protected media headers required" }
        val port = ensureStarted()
        return sessionStore.create(
            upstreamUrl = validated,
            method = normalizedMethod,
            headers = sanitizedHeaders,
            port = port,
        )
    }

    fun resolveLoopbackTargetForCast(localUrl: String): MediaProxyTarget? {
        if (config != MediaProxyServerConfig.Loopback || closed.get()) return null
        val activePort = serverSocket
            ?.takeIf { !it.isClosed }
            ?.localPort
            ?: return null
        val uri = runCatching { URI(localUrl) }.getOrNull() ?: return null
        if (
            !uri.scheme.equals("http", ignoreCase = true) ||
            uri.host != LOOPBACK_HOST ||
            uri.userInfo != null ||
            uri.port != activePort ||
            uri.query != null ||
            uri.fragment != null
        ) {
            return null
        }
        val resolvedPath = resolveRequestPath(uri.path) ?: return null
        return sessionStore.resolveRootForCast(
            suppliedSecret = requireNotNull(resolvedPath.suppliedSecret),
            sessionId = resolvedPath.sessionId,
            resourceId = resolvedPath.resourceId,
        )
    }

    private fun ensureStarted(): Int = synchronized(startLock) {
        serverSocket?.takeIf { !it.isClosed }?.localPort?.let { return it }
        check(!closed.get()) { "Media proxy is closed" }

        val requestedAddress = when (val activeConfig = config) {
            MediaProxyServerConfig.Loopback -> InetAddress.getByName(LOOPBACK_HOST)
            is MediaProxyServerConfig.CastLan -> activeConfig.bindAddress
        }
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(requestedAddress, 0), 64)
        if (!MediaProxyPolicy.sameSocketPeer(requestedAddress, socket.inetAddress)) {
            runCatching { socket.close() }
            throw IllegalStateException("Media proxy bound the wrong local address")
        }
        serverSocket = socket
        running.set(true)
        Thread({ acceptLoop(socket) }, "MovixMediaProxy-Acceptor").apply {
            isDaemon = true
            start()
        }
        socket.localPort
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get() && !socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: SocketException) {
                break
            } catch (_: Throwable) {
                continue
            }

            val peerAllowed = when (config) {
                MediaProxyServerConfig.Loopback -> client.inetAddress.isLoopbackAddress
                is MediaProxyServerConfig.CastLan ->
                    requireNotNull(castGate).acceptsPeer(client.inetAddress)
            }
            Log.i(
                "MovixCastDiag",
                "relay_accept peer=${client.inetAddress.hostAddress} allowed=$peerAllowed " +
                    "local=${client.localAddress.hostAddress}:${client.localPort}",
            )
            if (!peerAllowed) {
                runCatching {
                    BufferedOutputStream(client.getOutputStream()).use { output ->
                        writeError(output, 404, "Not Found")
                    }
                }
                runCatching { client.close() }
                continue
            }
            try {
                workers.execute { handleClient(client) }
            } catch (_: Throwable) {
                runCatching { client.close() }
            }
        }
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 30_000
            val input = BufferedInputStream(client.getInputStream())
            val output = BufferedOutputStream(client.getOutputStream())
            var responseCommitted = false
            try {
                val requestLine = readAsciiLine(input, MAX_REQUEST_LINE)
                    ?: return
                val requestParts = requestLine.split(' ')
                if (requestParts.size != 3 || !requestParts[2].startsWith("HTTP/1.")) {
                    writeError(output, 400, "Bad Request")
                    return
                }
                val method = requestParts[0].uppercase(Locale.US)
                val path = runCatching { URI(requestParts[1]).path }
                    .getOrNull()
                    ?: run {
                        writeError(output, 400, "Bad Request")
                        return
                    }
                val requestHeaders = readHeaders(input)
                Log.i(
                    "MovixCastDiag",
                    "relay_request peer=${client.inetAddress.hostAddress} " +
                        "method=$method path=$path headers=$requestHeaders",
                )
                val resolvedPath = resolveRequestPath(path) ?: run {
                    writeError(output, 404, "Not Found")
                    return
                }
                val target = resolveTarget(resolvedPath) ?: run {
                    writeError(output, 404, "Not Found")
                    return
                }
                Log.i(
                    "MovixCastDiag",
                    "relay_target session=${resolvedPath.sessionId} " +
                        "resource=${resolvedPath.resourceId} url=${target.upstreamUrl} " +
                        "headers=${target.headers}",
                )

                if (castGate?.acceptsOrigin(method, requestHeaders) == false) {
                    writeError(output, 403, "Forbidden")
                    return
                }

                if (method == "OPTIONS") {
                    writeHeaders(
                        output,
                        204,
                        "No Content",
                        emptyMap(),
                        0L,
                        responseCorsHeaders(method, requestHeaders),
                    )
                    return
                }
                if (method != "GET" && method != "HEAD") {
                    writeError(output, 405, "Method Not Allowed")
                    return
                }

                validateUrl(target.upstreamUrl)
                val localHeaders =
                    MediaProxyPolicy.sanitizeLocalRequestHeaders(requestHeaders)
                val castProfile = sessionStore.profile(resolvedPath.sessionId)
                val targetPath = runCatching {
                    URI(target.upstreamUrl).path.lowercase(Locale.US)
                }.getOrNull()
                val resourceKind = when {
                    targetPath == null -> "invalid"
                    targetPath.endsWith(".m3u8") -> "playlist"
                    targetPath.endsWith(".image") -> "image"
                    targetPath.endsWith(".ts") -> "ts"
                    targetPath.endsWith(".m4s") -> "m4s"
                    else -> "other"
                }
                val wrappedSegment =
                    config is MediaProxyServerConfig.CastLan &&
                        castProfile?.requiresPngTsUnwrap == true &&
                        targetPath?.endsWith(".image") == true
                val requestedRange = getHeader(localHeaders, "Range")
                val upstreamLocalHeaders = if (wrappedSegment) {
                    localHeaders.filterKeys { !it.equals("Range", ignoreCase = true) }
                } else {
                    localHeaders
                }
                val prepared = if (method == "HEAD") {
                    sessionStore.peekPreparedResponse(
                        resolvedPath.sessionId,
                        resolvedPath.resourceId,
                    )
                } else {
                    sessionStore.consumePreparedResponse(
                        resolvedPath.sessionId,
                        resolvedPath.resourceId,
                    )
                }
                val upstreamTarget = if (method == "HEAD" && !wrappedSegment) {
                    MediaProxyTarget(
                        target.upstreamUrl,
                        "HEAD",
                        target.headers,
                    )
                } else if (method == "HEAD") {
                    MediaProxyTarget(
                        target.upstreamUrl,
                        "GET",
                        target.headers,
                    )
                } else {
                    target
                }
                val response = prepared?.toUpstreamResponse()
                    ?: upstream.execute(upstreamTarget, upstreamLocalHeaders)
                response.use {
                    var binaryKind: BinaryPayloadKind? = null
                    val responseType = getHeader(response.headers, "Content-Type")
                        ?.substringBefore(';')
                        ?.trim()
                        ?.lowercase(Locale.US)
                    val responseKind = when {
                        responseType?.contains("mpegurl") == true -> "playlist"
                        responseType == "image/png" -> "png"
                        responseType == "video/mp2t" -> "ts"
                        else -> "other"
                    }
                    Log.i(
                        "MovixCastDiag",
                        "relay_upstream prepared=${prepared != null} status=${response.statusCode} " +
                            "type=$responseType kind=$resourceKind finalUrl=${response.finalUrl} " +
                            "requestRange=$requestedRange headers=${response.headers}",
                    )
                    if (
                        config is MediaProxyServerConfig.CastLan &&
                        !wrappedSegment &&
                        resourceKind == "other" &&
                        responseKind != "playlist"
                    ) {
                        binaryKind = classifyBinaryWithoutConsuming(response.body)
                    }
                    val normalizeFmp4Mime =
                        config is MediaProxyServerConfig.CastLan &&
                            castProfile?.hlsSegmentFormat == "fmp4" &&
                            castProfile.hlsVideoSegmentFormat == "fmp4" &&
                            resourceKind == "other" &&
                            isGenericBinaryContentType(responseType) &&
                            binaryKind == BinaryPayloadKind.FMP4
                    val playlistResponse =
                        !wrappedSegment &&
                            method != "HEAD" &&
                            binaryKind != BinaryPayloadKind.FMP4 &&
                            isPlaylist(response)
                    if (wrappedSegment) {
                        val preparedPngTs =
                            preparePngWrappedTsResponse(response, requestedRange)
                        writePreparedPngTsResponse(
                            output = output,
                            prepared = preparedPngTs,
                            sendBody = method == "GET",
                            corsHeaders = responseCorsHeaders(method, requestHeaders),
                            onHeadersCommitting = { responseCommitted = true },
                        )
                    } else if (method == "HEAD") {
                        writeHeadResponse(
                            output = output,
                            response = response,
                            corsHeaders = responseCorsHeaders(method, requestHeaders),
                        )
                    } else if (playlistResponse) {
                        writePlaylistResponse(
                            output = output,
                            response = response,
                            sessionId = resolvedPath.sessionId,
                            port = requireNotNull(serverSocket).localPort,
                            sendBody = true,
                            corsHeaders = responseCorsHeaders(method, requestHeaders),
                        )
                    } else {
                        writeStreamingResponse(
                            output = output,
                            response = response,
                            sendBody = true,
                            corsHeaders = responseCorsHeaders(method, requestHeaders),
                            contentTypeOverride = if (normalizeFmp4Mime) "video/mp4" else null,
                            onHeadersCommitting = { responseCommitted = true },
                        )
                    }
                }
            } catch (error: Throwable) {
                Log.e(
                    "MovixCastDiag",
                    "relay_failed committed=$responseCommitted type=${error.javaClass.simpleName} " +
                        "message=${error.message}",
                    error,
                )
                if (!responseCommitted) {
                    runCatching { writeError(output, 502, "Bad Gateway") }
                }
            }
        }
    }

    private data class ResolvedRequestPath(
        val suppliedSecret: String?,
        val sessionId: String,
        val resourceId: String,
    )

    private fun resolveRequestPath(path: String): ResolvedRequestPath? {
        return when (config) {
            MediaProxyServerConfig.Loopback -> {
                val parts = path.split('/').filter(String::isNotEmpty)
                if (
                    parts.size != 4 ||
                    parts[0] != "p" ||
                    parts.drop(1).any { !MediaProxyPolicy.isOpaqueToken(it) }
                ) {
                    null
                } else {
                    ResolvedRequestPath(parts[1], parts[2], parts[3])
                }
            }

            is MediaProxyServerConfig.CastLan -> castGate?.parsePath(path)?.let {
                ResolvedRequestPath(null, it.sessionId, it.resourceId)
            }
        }
    }

    private fun resolveTarget(path: ResolvedRequestPath): MediaProxyTarget? {
        return when (val activeConfig = config) {
            MediaProxyServerConfig.Loopback -> sessionStore.resolve(
                suppliedSecret = requireNotNull(path.suppliedSecret),
                sessionId = path.sessionId,
                resourceId = path.resourceId,
            )

            is MediaProxyServerConfig.CastLan -> {
                val access = sessionStore.access(path.sessionId)
                    ?.takeIf { it.mode == MediaProxyMode.CAST_LAN }
                    ?: return null
                if (
                    !MediaProxyPolicy.sameSocketPeer(
                        access.bindAddress,
                        activeConfig.bindAddress,
                    ) ||
                    !MediaProxyPolicy.sameSocketPeer(
                        requireNotNull(access.allowedClientAddress),
                        activeConfig.allowedClientAddress,
                    )
                ) {
                    return null
                }
                sessionStore.resolveCast(path.sessionId, path.resourceId)
            }
        }
    }

    private fun MediaProxyPreparedResponse.toUpstreamResponse(): MediaProxyUpstreamResponse {
        return MediaProxyUpstreamResponse(
            statusCode = statusCode,
            statusMessage = statusMessage,
            headers = headers,
            body = ByteArrayInputStream(body),
            finalUrl = finalUrl,
        )
    }

    private fun writePlaylistResponse(
        output: BufferedOutputStream,
        response: MediaProxyUpstreamResponse,
        sessionId: String,
        port: Int,
        sendBody: Boolean,
        corsHeaders: Map<String, String>,
    ) {
        val original = readLimited(response.body, MAX_PLAYLIST_BYTES)
            .toString(StandardCharsets.UTF_8)
        val rewritten = MediaProxyPolicy.rewritePlaylist(
            playlist = original,
            baseUrl = response.finalUrl,
            wrapDirectSubtitles = config == MediaProxyServerConfig.Loopback,
        ) { discoveredUrl ->
            if (isCurrentCastResourceUrl(discoveredUrl, sessionId, port)) {
                discoveredUrl
            } else {
                val validated = validateDiscoveredUrl(discoveredUrl).toString()
                sessionStore.register(sessionId, validated, port)
            }
        }
        val bytes = rewritten.toByteArray(StandardCharsets.UTF_8)
        val headers = filteredResponseHeaders(response.headers).toMutableMap()
        headers["Content-Type"] = if (config is MediaProxyServerConfig.CastLan) {
            CastMediaProfile.CANONICAL_HLS_MIME
        } else {
            getHeader(response.headers, "Content-Type")
                ?: "application/vnd.apple.mpegurl"
        }
        headers.keys
            .filter { it.equals("Content-Length", ignoreCase = true) }
            .forEach(headers::remove)
        headers["Content-Length"] = bytes.size.toString()
        writeHeaders(
            output,
            response.statusCode,
            response.statusMessage,
            headers,
            bytes.size.toLong(),
            corsHeaders,
        )
        if (sendBody) output.write(bytes)
        output.flush()
    }

    private fun isCurrentCastResourceUrl(
        rawUrl: String,
        sessionId: String,
        port: Int,
    ): Boolean {
        val activeConfig = config as? MediaProxyServerConfig.CastLan ?: return false
        val uri = runCatching { URI(rawUrl) }.getOrNull() ?: return false
        if (
            !uri.scheme.equals("http", ignoreCase = true) ||
            uri.userInfo != null ||
            uri.host != activeConfig.bindAddress.hostAddress ||
            uri.port != port ||
            uri.query != null ||
            uri.fragment != null
        ) {
            return false
        }
        val path = castGate?.parsePath(uri.path) ?: return false
        if (path.sessionId != sessionId) return false
        return sessionStore.resolveCast(path.sessionId, path.resourceId) != null
    }

    private fun writeHeadResponse(
        output: BufferedOutputStream,
        response: MediaProxyUpstreamResponse,
        corsHeaders: Map<String, String>,
    ) {
        val headers = filteredResponseHeaders(response.headers).toMutableMap()
        if (
            config is MediaProxyServerConfig.CastLan &&
            isPlaylist(response)
        ) {
            headers["Content-Type"] = CastMediaProfile.CANONICAL_HLS_MIME
        }
        val contentLength = getHeader(response.headers, "Content-Length")?.toLongOrNull()
        writeHeaders(
            output,
            response.statusCode,
            response.statusMessage,
            headers,
            contentLength,
            corsHeaders,
        )
        output.flush()
    }

    private fun writeStreamingResponse(
        output: BufferedOutputStream,
        response: MediaProxyUpstreamResponse,
        sendBody: Boolean,
        corsHeaders: Map<String, String>,
        contentTypeOverride: String?,
        onHeadersCommitting: () -> Unit,
    ) {
        val headers = filteredResponseHeaders(response.headers).toMutableMap()
        if (contentTypeOverride != null) {
            headers.keys
                .filter { it.equals("Content-Type", ignoreCase = true) }
                .forEach(headers::remove)
            headers["Content-Type"] = contentTypeOverride
        }
        val contentLength = getHeader(response.headers, "Content-Length")?.toLongOrNull()
        onHeadersCommitting()
        writeHeaders(
            output,
            response.statusCode,
            response.statusMessage,
            headers,
            contentLength,
            corsHeaders,
        )
        if (sendBody) {
            response.body.copyTo(output, DEFAULT_BUFFER_SIZE)
        }
        output.flush()
    }

    internal fun writePreparedPngTsResponse(
        output: BufferedOutputStream,
        prepared: PreparedPngTsResponse,
        sendBody: Boolean,
        corsHeaders: Map<String, String>,
        onHeadersCommitting: () -> Unit = {},
    ) {
        if (sendBody) {
            skipFully(prepared.body, prepared.skipBytes)
        }
        onHeadersCommitting()
        writeHeaders(
            output,
            prepared.statusCode,
            prepared.statusMessage,
            prepared.headers,
            prepared.bodyBytes,
            corsHeaders,
        )
        if (sendBody) {
            val bodyBytes = prepared.bodyBytes
            if (bodyBytes == null) {
                prepared.body.copyTo(output, STREAM_BUFFER_BYTES)
            } else {
                copyExactly(prepared.body, output, bodyBytes)
            }
        }
        output.flush()
    }

    private fun skipFully(input: InputStream, byteCount: Long) {
        val buffer = ByteArray(STREAM_BUFFER_BYTES)
        var remaining = byteCount
        while (remaining > 0L) {
            val count = input.read(
                buffer,
                0,
                minOf(buffer.size.toLong(), remaining).toInt(),
            )
            check(count > 0) { "Upstream body ended before requested range" }
            remaining -= count
        }
    }

    private fun copyExactly(
        input: InputStream,
        output: BufferedOutputStream,
        byteCount: Long,
    ) {
        val buffer = ByteArray(STREAM_BUFFER_BYTES)
        var remaining = byteCount
        while (remaining > 0L) {
            val count = input.read(
                buffer,
                0,
                minOf(buffer.size.toLong(), remaining).toInt(),
            )
            check(count > 0) { "Upstream body ended before declared length" }
            output.write(buffer, 0, count)
            remaining -= count
        }
    }

    private fun writeHeaders(
        output: BufferedOutputStream,
        statusCode: Int,
        statusMessage: String,
        headers: Map<String, String>,
        contentLength: Long?,
        corsHeaders: Map<String, String> = defaultCorsHeaders(),
    ) {
        val safeMessage = statusMessage.replace(Regex("[^\\x20-\\x7E]"), "")
            .ifBlank { defaultReason(statusCode) }
        val lines = StringBuilder()
            .append("HTTP/1.1 ")
            .append(statusCode)
            .append(' ')
            .append(safeMessage)
            .append("\r\n")
        for ((name, value) in headers) {
            if (
                name.equals("Connection", ignoreCase = true) ||
                name.equals("Transfer-Encoding", ignoreCase = true) ||
                name.startsWith("Access-Control-", ignoreCase = true) ||
                name.equals("Vary", ignoreCase = true)
            ) {
                continue
            }
            if (value.contains('\r') || value.contains('\n')) continue
            lines.append(name).append(": ").append(value).append("\r\n")
        }
        if (contentLength != null && headers.keys.none {
                it.equals("Content-Length", ignoreCase = true)
            }
        ) {
            lines.append("Content-Length: ").append(contentLength).append("\r\n")
        }
        for ((name, value) in corsHeaders) {
            if (!value.contains('\r') && !value.contains('\n')) {
                lines.append(name).append(": ").append(value).append("\r\n")
            }
        }
        lines.append("Connection: close\r\n\r\n")
        output.write(lines.toString().toByteArray(StandardCharsets.ISO_8859_1))
        output.flush()
    }

    private fun responseCorsHeaders(
        method: String,
        requestHeaders: Map<String, String>,
    ): Map<String, String> {
        return castGate?.corsHeaders(method, requestHeaders) ?: defaultCorsHeaders()
    }

    private fun defaultCorsHeaders(): Map<String, String> = when (val activeConfig = config) {
        MediaProxyServerConfig.Loopback -> linkedMapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers" to "Range, Accept, Content-Type",
            "Access-Control-Expose-Headers" to
                "Content-Length, Content-Range, Accept-Ranges",
        )

        is MediaProxyServerConfig.CastLan -> CastRequestGate(activeConfig)
            .corsHeaders("GET", emptyMap())
    }

    private fun writeError(
        output: BufferedOutputStream,
        statusCode: Int,
        reason: String,
    ) {
        val body = reason.toByteArray(StandardCharsets.UTF_8)
        writeHeaders(
            output,
            statusCode,
            reason,
            mapOf(
                "Content-Type" to "text/plain; charset=utf-8",
                "Content-Length" to body.size.toString(),
            ),
            body.size.toLong(),
        )
        output.write(body)
        output.flush()
    }

    private fun readHeaders(input: BufferedInputStream): Map<String, String> {
        val headers = linkedMapOf<String, String>()
        repeat(MAX_HEADER_COUNT) {
            val line = readAsciiLine(input, MAX_HEADER_LINE)
                ?: throw IllegalArgumentException("Incomplete request headers")
            if (line.isEmpty()) return headers
            val separator = line.indexOf(':')
            if (separator <= 0) throw IllegalArgumentException("Malformed request header")
            headers[line.substring(0, separator).trim()] =
                line.substring(separator + 1).trim()
        }
        throw IllegalArgumentException("Too many request headers")
    }

    private fun readAsciiLine(input: InputStream, maxLength: Int): String? {
        val bytes = ByteArrayOutputStream()
        while (bytes.size() <= maxLength) {
            val value = input.read()
            if (value == -1) {
                return if (bytes.size() == 0) null else bytes.toString("ISO-8859-1")
            }
            if (value == '\n'.code) {
                val raw = bytes.toByteArray()
                val length = if (raw.isNotEmpty() && raw.last() == '\r'.code.toByte()) {
                    raw.size - 1
                } else {
                    raw.size
                }
                return String(raw, 0, length, StandardCharsets.ISO_8859_1)
            }
            bytes.write(value)
        }
        throw IllegalArgumentException("HTTP line too long")
    }

    private fun readLimited(input: InputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count == -1) break
            total += count
            require(total <= limit) { "Playlist exceeds size limit" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun isPlaylist(response: MediaProxyUpstreamResponse): Boolean {
        val contentType = getHeader(response.headers, "Content-Type")
            ?.lowercase(Locale.US)
            .orEmpty()
        val path = runCatching { URI(response.finalUrl).path.lowercase(Locale.US) }
            .getOrDefault("")
        if (contentType.contains("mpegurl") || path.endsWith(".m3u8")) {
            return true
        }
        if (!shouldProbePlaylistPrefix(contentType)) return false

        val prefix = ByteArray(MAX_PLAYLIST_PREFIX_BYTES)
        var count = 0
        try {
            while (count < prefix.size) {
                val read = response.body.read(
                    prefix,
                    count,
                    minOf(PLAYLIST_PROBE_CHUNK_BYTES, prefix.size - count),
                )
                if (read == -1) {
                    return playlistPrefixDecision(prefix, count) ?: false
                }
                if (read == 0) {
                    val next = response.body.read()
                    if (next == -1) {
                        return playlistPrefixDecision(prefix, count) ?: false
                    }
                    prefix[count] = next.toByte()
                    count += 1
                } else {
                    count += read
                }
                playlistPrefixDecision(prefix, count)?.let { return it }
            }
            return false
        } finally {
            if (count > 0) response.body.unread(prefix, 0, count)
        }
    }

    private fun shouldProbePlaylistPrefix(contentType: String): Boolean {
        val mimeType = contentType.substringBefore(';').trim()
        return mimeType.isEmpty() ||
            mimeType == "application/octet-stream" ||
            mimeType == "text/plain"
    }

    private fun playlistPrefixDecision(prefix: ByteArray, length: Int): Boolean? {
        if (length == 0) return null
        var index = 0
        if ((prefix[0].toInt() and 0xff) == 0xef) {
            if (length >= 2 && (prefix[1].toInt() and 0xff) != 0xbb) return false
            if (length < 3) return null
            if ((prefix[2].toInt() and 0xff) != 0xbf) return false
            index = 3
        }
        while (index < length && prefix[index] in ASCII_PLAYLIST_WHITESPACE) {
            index += 1
        }
        if (index == length) return null
        for (markerIndex in PLAYLIST_PREFIX.indices) {
            val prefixIndex = index + markerIndex
            if (prefixIndex >= length) return null
            if (prefix[prefixIndex] != PLAYLIST_PREFIX[markerIndex]) return false
        }
        return true
    }

    private fun filteredResponseHeaders(input: Map<String, String>): Map<String, String> {
        val allowed = setOf(
            "accept-ranges",
            "cache-control",
            "content-length",
            "content-range",
            "content-type",
            "etag",
            "expires",
            "last-modified",
        )
        return input.filterKeys { it.lowercase(Locale.US) in allowed }
    }

    private fun getHeader(headers: Map<String, String>, name: String): String? {
        return headers.entries.firstOrNull {
            it.key.equals(name, ignoreCase = true)
        }?.value
    }

    private fun defaultReason(statusCode: Int): String = when (statusCode) {
        200 -> "OK"
        204 -> "No Content"
        206 -> "Partial Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        416 -> "Range Not Satisfiable"
        502 -> "Bad Gateway"
        else -> "Response"
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        running.set(false)
        runCatching { serverSocket?.close() }
        workers.shutdownNow()
        runCatching { (upstream as? Closeable)?.close() }
    }

    companion object {
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val MAX_REQUEST_LINE = 8_192
        private const val MAX_HEADER_LINE = 8_192
        private const val MAX_HEADER_COUNT = 64
        private const val MAX_PLAYLIST_BYTES = 5 * 1024 * 1024
        private val ASCII_PLAYLIST_WHITESPACE = setOf(
            ' '.code.toByte(),
            '\t'.code.toByte(),
            '\r'.code.toByte(),
            '\n'.code.toByte(),
        )
    }
}
