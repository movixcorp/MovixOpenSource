package com.movix.app.proxy

import android.net.Network
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request

internal interface NetworkBinding {
    val socketFactory: SocketFactory
    fun getAllByName(hostname: String): List<InetAddress>
}

internal class AndroidNetworkBinding(
    private val network: Network,
) : NetworkBinding {
    override val socketFactory: SocketFactory
        get() = network.socketFactory

    override fun getAllByName(hostname: String): List<InetAddress> {
        return network.getAllByName(hostname).toList()
    }
}

internal class NetworkExchangeResponse(
    val statusCode: Int,
    val statusMessage: String,
    val headers: Map<String, String>,
    val body: InputStream,
    val finalUrl: String,
    private val onClose: () -> Unit = {},
) : Closeable {
    override fun close() {
        try {
            body.close()
        } finally {
            onClose()
        }
    }
}

internal fun interface NetworkHttpExchange {
    fun execute(client: OkHttpClient, request: Request): NetworkExchangeResponse
}

internal class NetworkBoundMediaProxyUpstream(
    network: NetworkBinding,
    private val exchange: NetworkHttpExchange = NetworkHttpExchange { client, request ->
        executeOkHttp(client, request)
    },
) : MediaProxyUpstream, Closeable {
    private val networkDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val addresses = try {
                network.getAllByName(hostname)
            } catch (error: Exception) {
                throw UnknownHostException("Selected-network DNS failed").apply {
                    initCause(error)
                }
            }
            if (addresses.isEmpty() || addresses.any(MediaProxyPolicy::isForbiddenAddress)) {
                throw UnknownHostException("Private or unresolved media host")
            }
            return addresses
        }
    }
    private val client = OkHttpClient.Builder()
        .socketFactory(network.socketFactory)
        .dns(networkDns)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    constructor(
        network: Network,
        exchange: NetworkHttpExchange = NetworkHttpExchange { client, request ->
            executeOkHttp(client, request)
        },
    ) : this(AndroidNetworkBinding(network), exchange)

    override fun execute(
        target: MediaProxyTarget,
        localRequestHeaders: Map<String, String>,
    ): MediaProxyUpstreamResponse {
        if (MediaProxyPolicy.isProviderDecoyUrl(target.upstreamUrl)) {
            throw IllegalStateException("Upstream returned a decoy stream")
        }
        val headers = linkedMapOf<String, String>()
        headers.putAll(MediaProxyPolicy.sanitizeRequestHeaders(target.headers))
        headers.putAll(MediaProxyPolicy.sanitizeLocalRequestHeaders(localRequestHeaders))
        headers.putIfAbsent("Sec-Ch-Ua", MediaProxyPolicy.PLAYBACK_SEC_CH_UA)
        headers.putIfAbsent("Sec-Fetch-Site", "cross-site")
        headers.putIfAbsent("Sec-Fetch-Mode", "cors")
        headers.putIfAbsent("Sec-Fetch-Dest", "empty")
        headers.putIfAbsent(
            "User-Agent",
            MediaProxyPolicy.playbackUserAgent(target.upstreamUrl),
        )

        var currentUrl = target.upstreamUrl
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            val currentUri = MediaProxyPolicy.validateHttpsUrlSyntax(currentUrl)
            val headerBuilder = Headers.Builder()
            headers.forEach { (name, value) ->
                headerBuilder.set(name, value)
            }
            val request = Request.Builder()
                .url(currentUri.toString())
                .headers(headerBuilder.build())
                .apply {
                    if (target.method.uppercase(Locale.US) == "HEAD") head() else get()
                }
                .build()
            val response = exchange.execute(client, request)
            val location = header(response.headers, "Location")
            if (response.statusCode in 300..399 && location != null) {
                if (redirectCount >= MAX_REDIRECTS) {
                    response.close()
                    throw IllegalStateException("Too many media redirects")
                }
                val next = runCatching {
                    URI(response.finalUrl).resolve(location).toString()
                }.getOrNull()
                response.close()
                currentUrl = next
                    ?: throw IllegalArgumentException("Invalid media redirect")
                MediaProxyPolicy.validateHttpsUrlSyntax(currentUrl)
                if (MediaProxyPolicy.isProviderDecoyUrl(currentUrl)) {
                    throw IllegalStateException("Upstream returned a decoy stream")
                }
                return@repeat
            }
            return MediaProxyUpstreamResponse(
                statusCode = response.statusCode,
                statusMessage = response.statusMessage,
                headers = response.headers,
                body = response.body,
                finalUrl = response.finalUrl,
                onClose = response::close,
            )
        }
        throw IllegalStateException("Media redirect resolution failed")
    }

    override fun close() {
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        runCatching { client.cache?.close() }
    }

    companion object {
        private const val MAX_REDIRECTS = 5
        private fun executeOkHttp(
            client: OkHttpClient,
            request: Request,
        ): NetworkExchangeResponse {
            val response = client.newCall(request).execute()
            val responseHeaders = linkedMapOf<String, String>()
            response.headers.names().forEach { name ->
                responseHeaders[name] = response.headers.values(name).joinToString(", ")
            }
            return NetworkExchangeResponse(
                statusCode = response.code,
                statusMessage = response.message,
                headers = responseHeaders,
                body = response.body?.byteStream()
                    ?: ByteArrayInputStream(ByteArray(0)),
                finalUrl = response.request.url.toString(),
                onClose = response::close,
            )
        }

        private fun header(headers: Map<String, String>, name: String): String? {
            return headers.entries.firstOrNull {
                it.key.equals(name, ignoreCase = true)
            }?.value
        }
    }
}
