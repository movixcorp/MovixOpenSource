package com.movix.app.proxy

import java.net.InetAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaProxyPolicyTest {
    @Test
    fun rewritesRelativeAbsoluteAndQuotedPlaylistUris() {
        val input = """
            #EXTM3U
            video/720.m3u8
            https://media.example/absolute.ts
            #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
            #EXT-X-MEDIA:TYPE=SUBTITLES,URI='subs/fr.m3u8'
            #EXT-X-MAP:URI="data:application/octet-stream;base64,AA=="
        """.trimIndent()

        val output = MediaProxyPolicy.rewritePlaylist(
            input,
            "https://cdn.example/root/master.m3u8",
        ) { "LOCAL:$it" }

        assertTrue(output.contains("LOCAL:https://cdn.example/root/video/720.m3u8"))
        assertTrue(output.contains("LOCAL:https://media.example/absolute.ts"))
        assertTrue(output.contains("URI=\"LOCAL:https://cdn.example/root/key.bin\""))
        assertTrue(output.contains("URI='LOCAL:https://cdn.example/root/subs/fr.m3u8'"))
        assertTrue(output.contains("URI=\"data:application/octet-stream;base64,AA==\""))
    }

    @Test
    fun wrapsDirectSubtitleFilesInAnInlinePlaylist() {
        val input = """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs/fr.vtt"
            video/1080.m3u8
        """.trimIndent()

        val output = MediaProxyPolicy.rewritePlaylist(
            input,
            "https://cdn.example/root/master.m3u8",
        ) { "LOCAL:$it" }

        val dataUriMatch = Regex(
            """URI="(data:application/vnd\.apple\.mpegurl,[^"]+)"""",
        ).find(output)
        assertTrue("Le sous-titre direct doit devenir une playlist data:", dataUriMatch != null)

        val wrapper = URLDecoder.decode(
            dataUriMatch!!.groupValues[1].substringAfter(','),
            StandardCharsets.UTF_8.name(),
        )
        assertTrue(wrapper.startsWith("#EXTM3U\n"))
        assertTrue(wrapper.contains("LOCAL:https://cdn.example/root/subs/fr.vtt"))
        assertTrue(output.contains("LOCAL:https://cdn.example/root/video/1080.m3u8"))
        assertFalse(output.contains("URI=\"LOCAL:https://cdn.example/root/subs/fr.vtt\""))
    }

    @Test
    fun validatesOnlyPublicHttpsDestinations() {
        val publicResolver = { _: String ->
            listOf(InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34)))
        }

        val accepted = MediaProxyPolicy.validatePublicHttpsUrl(
            "https://cdn.example/video/master.m3u8",
            publicResolver,
        )
        assertEquals("https", accepted.scheme)
        assertEquals("cdn.example", accepted.host)

        for (url in listOf(
            "http://cdn.example/video.ts",
            "https://127.0.0.1/video.ts",
            "https://10.0.0.8/video.ts",
            "https://user:pass@cdn.example/video.ts",
            "https://cdn.example:8443/video.ts",
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                MediaProxyPolicy.validatePublicHttpsUrl(url, publicResolver)
            }
        }
    }

    @Test
    fun rejectsReservedLocalHostNames() {
        // Parite iOS : le chemin Cast LAN valide seulement la syntaxe (pas de
        // DNS), donc les noms reserves au reseau local doivent etre refuses ici.
        for (url in listOf(
            "https://localhost/video.ts",
            "https://box.localhost/video.ts",
            "https://nas.local/video.ts",
            "https://printer.home.arpa/video.ts",
            "https://metadata.internal/video.ts",
            "https://router.localdomain/video.ts",
            "https://NAS.LOCAL./video.ts",
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                MediaProxyPolicy.validateHttpsUrlSyntax(url)
            }
        }

        // Les CDN reels dont le nom contient ces mots restent joignables.
        for (url in listOf(
            "https://r1.fsvid.lol/video/master.m3u8",
            "https://u14.vidzy.cc/video/master.m3u8",
            "https://local.example.com/video.ts",
            "https://internal-cdn.example/video.ts",
        )) {
            assertEquals("https", MediaProxyPolicy.validateHttpsUrlSyntax(url).scheme)
        }
    }

    @Test
    fun rejectsPrivateDnsAnswers() {
        val privateResolver = { _: String ->
            listOf(InetAddress.getByAddress(byteArrayOf(192.toByte(), 168.toByte(), 1, 25)))
        }

        assertThrows(IllegalArgumentException::class.java) {
            MediaProxyPolicy.validatePublicHttpsUrl(
                "https://cdn.example/video.ts",
                privateResolver,
            )
        }
    }

    @Test
    fun rejectsDocumentationAndReservedUpstreamAddresses() {
        for (address in listOf(
            "192.0.2.1",
            "198.51.100.9",
            "203.0.113.7",
            "192.0.0.8",
            "2001:db8::1",
        )) {
            assertTrue(
                "$address must not be treated as a public upstream",
                MediaProxyPolicy.isForbiddenAddress(InetAddress.getByName(address)),
            )
        }
        assertFalse(
            MediaProxyPolicy.isForbiddenAddress(InetAddress.getByName("93.184.216.34")),
        )
        assertFalse(
            MediaProxyPolicy.isForbiddenAddress(
                InetAddress.getByName("2606:2800:220:1:248:1893:25c8:1946"),
            ),
        )
    }

    @Test
    fun detectsTheFsvidVidzyDecoyStream() {
        // Le CDN repond 302 vers ce flux quand il refuse la requete : le suivre
        // ferait lire la video troll au lieu de remonter un echec.
        assertTrue(MediaProxyPolicy.isProviderDecoyUrl("https://s1.fsvid.lol/troll/master.m3u8"))
        assertTrue(MediaProxyPolicy.isProviderDecoyUrl("https://s1.fsvid.lol/troll/seg0.ts"))
        assertTrue(MediaProxyPolicy.isProviderDecoyUrl("https://u14.vidzy.cc/troll/master.m3u8"))

        // Un vrai flux, et un hote tiers qui contient "troll", restent acceptes.
        assertFalse(
            MediaProxyPolicy.isProviderDecoyUrl(
                "https://r1.fsvid.lol/hls2/03/00005/5b1wl2a101nm_n/master.m3u8?t=x",
            ),
        )
        assertFalse(MediaProxyPolicy.isProviderDecoyUrl("https://cdn.example.com/troll/master.m3u8"))
        assertFalse(MediaProxyPolicy.isProviderDecoyUrl("https://r1.fsvid.lol/controller/master.m3u8"))
    }

    @Test
    fun sanitizesRequestHeadersWithAnAllowlist() {
        val sanitized = MediaProxyPolicy.sanitizeRequestHeaders(
            mapOf(
                "Origin" to "https://vidzy.org",
                "referer" to "https://vidzy.org/",
                "Range" to "bytes=0-1023",
                "Accept" to "*/*",
                "User-Agent" to "Movix",
                "sec-ch-ua" to "\"Chromium\";v=\"140\"",
                "sec-fetch-site" to "cross-site",
                "Sec-Fetch-Mode" to "cors",
                "SEC-FETCH-DEST" to "empty",
                "Host" to "attacker.invalid",
                "Connection" to "keep-alive",
                "Cookie" to "secret=value",
                "Authorization" to "Bearer secret",
                "X-Injected" to "bad\r\nHeader: value",
            ),
        )

        assertEquals("https://vidzy.org", sanitized["Origin"])
        assertEquals("https://vidzy.org/", sanitized["Referer"])
        assertEquals("bytes=0-1023", sanitized["Range"])
        // Sans Sec-Ch-Ua, Fsvid redirige vers son flux leurre et Vidzy repond 403.
        assertEquals("\"Chromium\";v=\"140\"", sanitized["Sec-Ch-Ua"])
        assertEquals("cross-site", sanitized["Sec-Fetch-Site"])
        assertEquals("cors", sanitized["Sec-Fetch-Mode"])
        assertEquals("empty", sanitized["Sec-Fetch-Dest"])
        assertFalse(sanitized.containsKey("Host"))
        assertFalse(sanitized.containsKey("Connection"))
        assertFalse(sanitized.containsKey("Cookie"))
        assertFalse(sanitized.containsKey("Authorization"))
        assertFalse(sanitized.containsKey("X-Injected"))
    }

    @Test
    fun usesSigningCompatibleUserAgentForEveryPlaybackHost() {
        // Chaine complete : la version majeure doit correspondre a celle
        // qu'annonce PLAYBACK_SEC_CH_UA, sans quoi Fsvid sert son flux leurre.
        val signedUserAgent =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

        for (url in listOf(
            "https://r1.fsvid.lol/video/master.m3u8",
            "https://u14.vidzy.cc/video/master.m3u8",
            "https://vidzy.org/embed-example",
            "https://fsvid.lol.attacker.example/video/master.m3u8",
            "https://media.example/video/master.m3u8",
            "not-a-url",
        )) {
            assertEquals(signedUserAgent, MediaProxyPolicy.playbackUserAgent(url))
        }
    }

    @Test
    fun buildsOpaqueLoopbackUrls() {
        val localUrl = MediaProxyPolicy.buildLoopbackUrl(
            port = 28123,
            processSecret = "process-secret",
            sessionId = "session-id",
            resourceId = "resource-id",
        )

        assertEquals(
            "http://127.0.0.1:28123/p/process-secret/session-id/resource-id",
            localUrl,
        )
        assertFalse(localUrl.contains("vidzy"))
        assertFalse(localUrl.contains("m3u8"))
    }

    @Test
    fun loopbackUrlContractCannotBeUsedAsCast() {
        val loopback = MediaProxyPolicy.buildLoopbackUrl(
            port = 28123,
            processSecret = "process-secret",
            sessionId = "session-id",
            resourceId = "resource-id",
        )

        assertTrue(loopback.startsWith("http://127.0.0.1:28123/p/"))
        assertFalse(loopback.contains("/cast/"))
    }
}
