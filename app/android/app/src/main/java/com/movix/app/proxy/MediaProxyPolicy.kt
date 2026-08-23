package com.movix.app.proxy

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Arrays
import java.util.Locale

internal enum class MediaProxyMode {
    LOOPBACK,
    CAST_LAN,
}

internal data class MediaProxySessionAccess(
    val mode: MediaProxyMode,
    val bindAddress: InetAddress,
    val allowedClientAddress: InetAddress?,
) {
    init {
        when (mode) {
            MediaProxyMode.LOOPBACK -> {
                require(bindAddress.isLoopbackAddress) {
                    "Loopback sessions must bind loopback"
                }
                require(allowedClientAddress == null) {
                    "Loopback sessions cannot carry Cast access"
                }
            }

            MediaProxyMode.CAST_LAN -> {
                MediaProxyPolicy.requireUsableCastLanAddress(bindAddress)
                MediaProxyPolicy.requireUsableCastLanAddress(
                    requireNotNull(allowedClientAddress) {
                        "Cast receiver address required"
                    },
                )
            }
        }
    }

    override fun toString(): String = "MediaProxySessionAccess(mode=$mode, redacted=true)"

    companion object {
        fun loopback(): MediaProxySessionAccess = MediaProxySessionAccess(
            mode = MediaProxyMode.LOOPBACK,
            bindAddress = InetAddress.getLoopbackAddress(),
            allowedClientAddress = null,
        )

        fun castLan(
            bindAddress: InetAddress,
            allowedClientAddress: InetAddress,
        ): MediaProxySessionAccess = MediaProxySessionAccess(
            mode = MediaProxyMode.CAST_LAN,
            bindAddress = MediaProxyPolicy.requireUsableCastLanAddress(bindAddress),
            allowedClientAddress =
                MediaProxyPolicy.requireUsableCastLanAddress(allowedClientAddress),
        )
    }
}

object MediaProxyPolicy {
    private const val MAX_URL_LENGTH = 16_384
    private const val MAX_HEADER_VALUE_LENGTH = 8_192
    private const val PLAYBACK_USER_AGENT = "Mozilla/5.0 Chrome/140.0.0.0"
    private val tokenPattern = Regex("^[A-Za-z0-9_-]{8,128}$")
    private val numericIpv4Pattern = Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$")
    private val uriAttributePattern = Regex("""URI=(["'])(.*?)\1""", RegexOption.IGNORE_CASE)
    private val subtitleMediaPattern = Regex(
        """(?:^|[:,])\s*TYPE\s*=\s*SUBTITLES(?:\s*,|$)""",
        RegexOption.IGNORE_CASE,
    )
    private val allowedRequestHeaders = mapOf(
        "accept" to "Accept",
        "accept-language" to "Accept-Language",
        "content-type" to "Content-Type",
        "if-modified-since" to "If-Modified-Since",
        "if-none-match" to "If-None-Match",
        "origin" to "Origin",
        "range" to "Range",
        "referer" to "Referer",
        "sec-fetch-dest" to "Sec-Fetch-Dest",
        "sec-fetch-mode" to "Sec-Fetch-Mode",
        "sec-fetch-site" to "Sec-Fetch-Site",
        "user-agent" to "User-Agent",
    )
    private val allowedLocalOverrideHeaders = setOf(
        "accept",
        "accept-language",
        "if-modified-since",
        "if-none-match",
        "range",
    )

    // Parite iOS (MediaProxyPolicy.swift/isReservedLocalHost) : un upstream ne
    // doit jamais viser un nom reserve au reseau local. Bloquer uniquement
    // "localhost" laissait passer les noms mDNS/.internal qui resolvent vers le
    // LAN de l'utilisateur une fois le DNS interroge.
    private val reservedLocalHostSuffixes = listOf(
        "localhost",
        "local",
        "home.arpa",
        "internal",
        "localdomain",
    )

    @Suppress("UNUSED_PARAMETER")
    fun playbackUserAgent(rawUrl: String): String = PLAYBACK_USER_AGENT

    fun validatePublicHttpsUrl(
        rawUrl: String,
        resolver: (String) -> List<InetAddress> = {
            InetAddress.getAllByName(it).toList()
        },
    ): URI {
        val uri = validateHttpsUrlSyntax(rawUrl)
        val host = requireNotNull(uri.host).lowercase(Locale.US)
        val addresses = runCatching { resolver(host) }
            .getOrElse { throw IllegalArgumentException("Upstream DNS failed") }
        require(addresses.isNotEmpty()) { "Upstream DNS returned no address" }
        require(addresses.none(::isForbiddenAddress)) {
            "Private upstream is forbidden"
        }
        return uri
    }

    fun validateHttpsUrlSyntax(rawUrl: String): URI {
        require(rawUrl.length in 1..MAX_URL_LENGTH) { "Invalid upstream URL" }
        val uri = runCatching { URI(rawUrl) }
            .getOrElse { throw IllegalArgumentException("Invalid upstream URL") }
        require(uri.scheme?.lowercase(Locale.US) == "https") {
            "HTTPS upstream required"
        }
        require(uri.userInfo == null) { "Upstream credentials are forbidden" }
        require(uri.port == -1 || uri.port == 443) { "Unsupported upstream port" }

        val host = uri.host?.trim()?.lowercase(Locale.US)
        require(!host.isNullOrEmpty()) { "Missing upstream host" }
        require(!isReservedLocalHost(host)) {
            "Loopback upstream is forbidden"
        }

        if (numericIpv4Pattern.matches(host) || host.contains(':')) {
            val literal = runCatching { InetAddress.getByName(host) }
                .getOrElse { throw IllegalArgumentException("Invalid upstream address") }
            require(!isForbiddenAddress(literal)) { "Private upstream is forbidden" }
        }
        return uri
    }

    fun isReservedLocalHost(host: String): Boolean {
        val unqualified = host.trimEnd('.').lowercase(Locale.US)
        if (unqualified.isEmpty()) return false
        return reservedLocalHostSuffixes.any {
            unqualified == it || unqualified.endsWith(".$it")
        }
    }

    fun isForbiddenAddress(address: InetAddress): Boolean {
        if (
            address.isAnyLocalAddress ||
            address.isLoopbackAddress ||
            address.isLinkLocalAddress ||
            address.isSiteLocalAddress ||
            address.isMulticastAddress
        ) {
            return true
        }

        val bytes = address.address
        if (address is Inet4Address && bytes.size == 4) {
            val first = bytes[0].toInt() and 0xff
            val second = bytes[1].toInt() and 0xff
            val third = bytes[2].toInt() and 0xff
            if (first == 0 || first >= 224) return true
            if (first == 100 && second in 64..127) return true
            if (first == 192 && second == 0 && third == 0) return true
            if (first == 192 && second == 0 && third == 2) return true
            if (first == 192 && second == 88 && third == 99) return true
            if (first == 198 && second in 18..19) return true
            if (first == 198 && second == 51 && third == 100) return true
            if (first == 203 && second == 0 && third == 113) return true
        }
        if (address is Inet6Address && bytes.isNotEmpty()) {
            val first = bytes[0].toInt() and 0xff
            if (first and 0xfe == 0xfc) return true
            if (
                bytes.size == 16 &&
                (bytes[0].toInt() and 0xff) == 0x20 &&
                (bytes[1].toInt() and 0xff) == 0x01 &&
                (bytes[2].toInt() and 0xff) == 0x0d &&
                (bytes[3].toInt() and 0xff) == 0xb8
            ) {
                return true
            }
        }
        return false
    }

    fun sanitizeRequestHeaders(input: Map<String, String>): Map<String, String> {
        val output = linkedMapOf<String, String>()
        for ((rawName, rawValue) in input) {
            val canonicalName = allowedRequestHeaders[rawName.trim().lowercase(Locale.US)]
                ?: continue
            val value = rawValue.trim()
            if (
                value.isEmpty() ||
                value.length > MAX_HEADER_VALUE_LENGTH ||
                value.contains('\r') ||
                value.contains('\n')
            ) {
                continue
            }
            output[canonicalName] = value
        }
        return output
    }

    fun sanitizeLocalRequestHeaders(input: Map<String, String>): Map<String, String> {
        return sanitizeRequestHeaders(
            input.filterKeys {
                it.trim().lowercase(Locale.US) in allowedLocalOverrideHeaders
            },
        )
    }

    fun rewritePlaylist(
        playlist: String,
        baseUrl: String,
        wrapDirectSubtitles: Boolean = true,
        localize: (String) -> String,
    ): String {
        val baseUri = runCatching { URI(baseUrl) }
            .getOrElse { throw IllegalArgumentException("Invalid playlist base URL") }

        fun resolve(rawValue: String): String? {
            val value = rawValue.trim()
            if (
                value.isEmpty() ||
                value.startsWith("data:", ignoreCase = true) ||
                value.startsWith("blob:", ignoreCase = true)
            ) {
                return null
            }
            return runCatching { baseUri.resolve(value).toString() }.getOrNull()
        }

        fun rewrite(rawValue: String): String {
            val absolute = resolve(rawValue) ?: return rawValue
            return localize(absolute)
        }

        fun wrapDirectSubtitle(rawValue: String): String? {
            val absolute = resolve(rawValue) ?: return null
            val path = runCatching {
                URI(absolute).path.lowercase(Locale.US)
            }.getOrDefault("")
            if (!path.endsWith(".vtt") && !path.endsWith(".srt")) return null

            val wrapper = buildString {
                append("#EXTM3U\n")
                append("#EXT-X-VERSION:3\n")
                append("#EXT-X-TARGETDURATION:999999\n")
                append("#EXT-X-MEDIA-SEQUENCE:0\n")
                append("#EXTINF:999999.0,\n")
                append(localize(absolute))
                append("\n#EXT-X-ENDLIST\n")
            }
            val encoded = URLEncoder.encode(
                wrapper,
                StandardCharsets.UTF_8.name(),
            ).replace("+", "%20")
            return "data:application/vnd.apple.mpegurl,$encoded"
        }

        return playlist.lineSequence().joinToString("\n") { line ->
            if (line.isBlank()) {
                line
            } else if (!line.trimStart().startsWith("#")) {
                val leading = line.takeWhile(Char::isWhitespace)
                val trailing = line.takeLastWhile(Char::isWhitespace)
                leading + rewrite(line.trim()) + trailing
            } else {
                val directSubtitle =
                    line.trimStart().startsWith("#EXT-X-MEDIA:", ignoreCase = true) &&
                        subtitleMediaPattern.containsMatchIn(line)
                uriAttributePattern.replace(line) { match ->
                    val quote = match.groupValues[1]
                    val value = match.groupValues[2]
                    val rewritten = if (directSubtitle && wrapDirectSubtitles) {
                        wrapDirectSubtitle(value) ?: rewrite(value)
                    } else {
                        rewrite(value)
                    }
                    "URI=$quote$rewritten$quote"
                }
            }
        }
    }

    fun buildLoopbackUrl(
        port: Int,
        processSecret: String,
        sessionId: String,
        resourceId: String,
    ): String {
        require(port in 1..65_535) { "Invalid loopback port" }
        require(tokenPattern.matches(processSecret)) { "Invalid process secret" }
        require(tokenPattern.matches(sessionId)) { "Invalid session id" }
        require(tokenPattern.matches(resourceId)) { "Invalid resource id" }
        return "http://127.0.0.1:$port/p/$processSecret/$sessionId/$resourceId"
    }

    fun buildCastUrl(
        bindAddress: InetAddress,
        port: Int,
        sessionId: String,
        resourceId: String,
    ): String {
        require(port in 1..65_535) { "Invalid Cast proxy port" }
        require(tokenPattern.matches(sessionId)) { "Invalid session id" }
        require(tokenPattern.matches(resourceId)) { "Invalid resource id" }
        val address = requireUsableCastLanAddress(bindAddress)
        val literal = address.hostAddress
            ?.substringBefore('%')
            ?.takeIf(String::isNotBlank)
            ?: throw IllegalArgumentException("Invalid Cast LAN address")
        val authority = if (address is Inet6Address) "[$literal]" else literal
        return "http://$authority:$port/cast/$sessionId/$resourceId"
    }

    fun requireUsableCastLanAddress(address: InetAddress): InetAddress {
        require(
            !address.isAnyLocalAddress &&
                !address.isLoopbackAddress &&
                !address.isLinkLocalAddress &&
                !address.isMulticastAddress,
        ) {
            "Unsafe Cast LAN address"
        }
        if (address is Inet4Address) {
            val first = address.address[0].toInt() and 0xff
            require(first != 0 && first < 224) { "Unsafe Cast LAN address" }
        }
        return address
    }

    fun validateReceiverOrigin(rawOrigin: String): String {
        val uri = runCatching { URI(rawOrigin) }
            .getOrElse { throw IllegalArgumentException("Invalid receiver origin") }
        require(uri.scheme?.lowercase(Locale.US) == "https") {
            "HTTPS receiver origin required"
        }
        require(!uri.host.isNullOrBlank() && uri.userInfo == null) {
            "Invalid receiver origin"
        }
        require(uri.path.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
            "Receiver origin cannot contain a path, query, or fragment"
        }
        require(uri.port == -1 || uri.port in 1..65_535) {
            "Invalid receiver origin port"
        }
        return URI(
            "https",
            null,
            uri.host.lowercase(Locale.US),
            uri.port,
            null,
            null,
            null,
        ).toString()
    }

    fun sameSocketPeer(expected: InetAddress, actual: InetAddress): Boolean {
        if (!Arrays.equals(expected.address, actual.address)) return false
        if (expected is Inet6Address && actual is Inet6Address) {
            val expectedScope = expected.scopeId
            val actualScope = actual.scopeId
            return expectedScope == actualScope || expectedScope == 0 || actualScope == 0
        }
        return expected::class == actual::class
    }

    fun isOpaqueToken(value: String): Boolean = tokenPattern.matches(value)
}
