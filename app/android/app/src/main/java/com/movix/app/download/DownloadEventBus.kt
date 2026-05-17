package com.movix.app.download

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Event bus singleton entre `DownloadService` (émetteur) et `DownloadModule`
 * (consommateur). On est dans le même process : pas besoin de LocalBroadcastManager.
 */
object DownloadEventBus {

    interface Listener {
        fun onProgress(id: String, bytesDownloaded: Long, bytesTotal: Long, speedBytesPerSec: Long)
        fun onStateChanged(entry: DownloadEntry)
    }

    private val listeners = CopyOnWriteArrayList<Listener>()

    fun subscribe(listener: Listener) {
        if (!listeners.contains(listener)) listeners.add(listener)
    }

    fun unsubscribe(listener: Listener) {
        listeners.remove(listener)
    }

    fun emitProgress(id: String, bytesDownloaded: Long, bytesTotal: Long, speedBytesPerSec: Long) {
        listeners.forEach {
            runCatching { it.onProgress(id, bytesDownloaded, bytesTotal, speedBytesPerSec) }
        }
    }

    fun emitStateChanged(entry: DownloadEntry) {
        listeners.forEach { runCatching { it.onStateChanged(entry) } }
    }
}
