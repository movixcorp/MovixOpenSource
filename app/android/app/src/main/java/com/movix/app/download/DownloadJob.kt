package com.movix.app.download

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Worker qui réalise effectivement le téléchargement HTTP d'une `DownloadEntry`.
 *
 * Caractéristiques :
 * - Range-aware : si le fichier cible existe déjà partiellement et que le serveur
 *   répond 206 Partial Content, on reprend là où on s'est arrêté.
 * - Pause coopérative : `requestPause()` positionne un flag ; au prochain flush
 *   de buffer (toutes les ~64KB), le thread arrête proprement, écrit l'état
 *   `paused` dans le store et émet un event. Le fichier partiel reste.
 * - Cancel : même mécanisme, mais on supprime aussi le fichier partiel.
 * - Progress throttle : on n'émet pas plus d'un event toutes les ~250ms pour
 *   éviter de saturer le bridge JS.
 */
class DownloadJob(
    private val entry: DownloadEntry,
    private val store: DownloadStore,
    private val listener: Listener,
    private val client: OkHttpClient = defaultClient(),
) : Runnable {

    interface Listener {
        fun onProgress(entry: DownloadEntry, speedBytesPerSec: Long)
        fun onStateChanged(entry: DownloadEntry)
    }

    private val pauseFlag = AtomicBoolean(false)
    private val cancelFlag = AtomicBoolean(false)

    fun requestPause() {
        pauseFlag.set(true)
    }

    fun requestCancel() {
        cancelFlag.set(true)
    }

    override fun run() {
        try {
            // Marque running
            entry.status = DownloadEntry.STATUS_RUNNING
            entry.errorMessage = null
            entry.updatedAt = System.currentTimeMillis()
            store.upsert(entry)
            listener.onStateChanged(entry)

            val target = File(entry.targetPath)
            target.parentFile?.mkdirs()

            // Resume si fichier déjà partiellement présent
            var existingBytes = if (target.exists()) target.length() else 0L
            if (existingBytes > 0L && entry.totalBytes in 1..existingBytes) {
                // Déjà complet
                entry.downloadedBytes = existingBytes
                finish(DownloadEntry.STATUS_DONE)
                return
            }

            val builder = Request.Builder().url(entry.url)
            parseHeaders(entry.headersJson).forEach { (k, v) ->
                builder.addHeader(k, v)
            }
            if (existingBytes > 0L) {
                builder.addHeader("Range", "bytes=$existingBytes-")
            }

            client.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    fail("HTTP ${response.code}")
                    return
                }

                val body = response.body ?: run {
                    fail("Empty response body")
                    return
                }

                val partialResume = response.code == 206
                if (!partialResume && existingBytes > 0L) {
                    // Serveur ne supporte pas le Range → repartir de zéro
                    target.delete()
                    existingBytes = 0L
                }

                // Total size : Content-Range > Content-Length (+ existing)
                val contentLength = body.contentLength()
                val total = when {
                    response.code == 206 -> parseContentRangeTotal(response.header("Content-Range")) ?: -1L
                    contentLength > 0L -> contentLength + existingBytes
                    else -> -1L
                }
                if (total > 0L) {
                    entry.totalBytes = total
                }

                entry.downloadedBytes = existingBytes
                store.upsert(entry)

                RandomAccessFile(target, "rw").use { raf ->
                    raf.seek(existingBytes)
                    body.byteStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        var written = existingBytes
                        var lastEmit = 0L
                        var lastBytesAtEmit = written
                        var lastTimeAtEmit = System.currentTimeMillis()

                        while (true) {
                            if (cancelFlag.get()) {
                                target.delete()
                                entry.downloadedBytes = 0L
                                finish(DownloadEntry.STATUS_CANCELLED)
                                return
                            }
                            if (pauseFlag.get()) {
                                entry.downloadedBytes = written
                                finish(DownloadEntry.STATUS_PAUSED)
                                return
                            }

                            val read = try {
                                input.read(buffer)
                            } catch (e: IOException) {
                                fail(e.message ?: "Network read error")
                                return
                            }
                            if (read <= 0) break

                            raf.write(buffer, 0, read)
                            written += read
                            entry.downloadedBytes = written

                            val now = System.currentTimeMillis()
                            if (now - lastEmit >= 250L) {
                                lastEmit = now
                                val elapsed = (now - lastTimeAtEmit).coerceAtLeast(1L)
                                val speed = ((written - lastBytesAtEmit) * 1000L) / elapsed
                                lastBytesAtEmit = written
                                lastTimeAtEmit = now
                                entry.updatedAt = now
                                store.upsert(entry)
                                listener.onProgress(entry, speed)
                            }
                        }
                    }
                }

                finish(DownloadEntry.STATUS_DONE)
            }
        } catch (e: Exception) {
            fail(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun finish(status: String) {
        entry.status = status
        entry.updatedAt = System.currentTimeMillis()
        store.upsert(entry)
        listener.onStateChanged(entry)
    }

    private fun fail(message: String) {
        entry.status = DownloadEntry.STATUS_FAILED
        entry.errorMessage = message
        entry.updatedAt = System.currentTimeMillis()
        store.upsert(entry)
        listener.onStateChanged(entry)
    }

    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            // Pas de readTimeout : un gros download lent ne doit pas être tué.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()

        private fun parseHeaders(json: String): Map<String, String> {
            if (json.isBlank()) return emptyMap()
            return try {
                val obj = JSONObject(json)
                obj.keys().asSequence().associateWith { obj.optString(it, "") }
                    .filterValues { it.isNotEmpty() }
            } catch (_: Exception) {
                emptyMap()
            }
        }

        private fun parseContentRangeTotal(header: String?): Long? {
            // Content-Range: bytes 1024-2047/4096
            if (header == null) return null
            val slash = header.lastIndexOf('/')
            if (slash < 0) return null
            val totalStr = header.substring(slash + 1).trim()
            if (totalStr == "*") return null
            return totalStr.toLongOrNull()
        }
    }
}
