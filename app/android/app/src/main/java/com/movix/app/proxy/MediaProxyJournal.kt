package com.movix.app.proxy

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Journal réseau du proxy média — outil de diagnostic, jamais de télémétrie :
 * tout reste en mémoire, rien n'est écrit sur le disque ni envoyé nulle part, et
 * la capture est éteinte par défaut.
 *
 * Sans lui, les hébergeurs qui classent leurs clients (LuluStream, Veev, Fsvid…)
 * sont indébogables sur mobile : la requête qui se fait refuser part du natif,
 * hors de portée d'un inspecteur réseau, et les en-têtes réellement émis ne sont
 * visibles nulle part. Ce sont eux qui comptent — c'est un seul en-tête qui
 * sépare un 200 d'un 403.
 *
 * Chaque entrée est déjà mise en forme : l'écran de réglages n'a qu'à
 * l'afficher, et `adb logcat -s MovixNet` la donne telle quelle.
 */
internal object MediaProxyJournal {
    const val TAG = "MovixNet"
    private const val MAX_ENTRIES = 300

    // Une ligne logcat est tronquée autour de 4 000 octets : on découpe avant que
    // le système le fasse à notre place, au milieu d'un en-tête.
    private const val MAX_LOG_CHUNK = 3_000

    private val timestampFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val entries = ArrayList<String>(MAX_ENTRIES)

    @Volatile
    private var enabled = false

    fun setEnabled(value: Boolean) {
        enabled = value
        if (!value) clear()
    }

    fun isEnabled(): Boolean = enabled

    fun record(
        phase: String,
        method: String,
        url: String,
        requestHeaders: Map<String, String>,
        statusCode: Int? = null,
        responseHeaders: Map<String, String>? = null,
        bodySnippet: String? = null,
        error: String? = null,
        // Ce que le lecteur a demandé à la boucle locale. À tracer séparément :
        // `sanitizeLocalRequestHeaders` les applique APRÈS ceux du pont, donc
        // ils l'emportent — un Accept-Language qui arrive par là écrase celui
        // que le pont avait épinglé, sans que rien ne le signale.
        localRequestHeaders: Map<String, String>? = null,
    ) {
        if (!enabled) return
        val entry = buildString {
            append('[').append(timestampFormat.format(Date())).append("] ")
            append(phase).append(' ')
            append(statusCode?.toString() ?: error?.let { "ERR" } ?: "…").append(' ')
            append(method).append(' ').append(url).append('\n')
            localRequestHeaders?.forEach { (name, value) ->
                append("  ~ ").append(name).append(": ").append(value).append('\n')
            }
            for ((name, value) in requestHeaders) {
                append("  > ").append(name).append(": ").append(value).append('\n')
            }
            responseHeaders?.forEach { (name, value) ->
                append("  < ").append(name).append(": ").append(value).append('\n')
            }
            if (!bodySnippet.isNullOrBlank()) {
                append("  corps: ").append(bodySnippet.trim()).append('\n')
            }
            if (!error.isNullOrBlank()) {
                append("  erreur: ").append(error).append('\n')
            }
        }
        append(entry)
    }

    fun snapshot(): List<String> = synchronized(entries) { entries.toList() }

    fun clear() {
        synchronized(entries) { entries.clear() }
    }

    private fun append(entry: String) {
        synchronized(entries) {
            entries.add(entry)
            while (entries.size > MAX_ENTRIES) entries.removeAt(0)
        }
        var offset = 0
        while (offset < entry.length) {
            val end = minOf(offset + MAX_LOG_CHUNK, entry.length)
            Log.i(TAG, entry.substring(offset, end))
            offset = end
        }
    }
}
