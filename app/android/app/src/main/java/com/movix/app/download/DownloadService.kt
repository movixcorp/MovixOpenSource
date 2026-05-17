package com.movix.app.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Foreground service qui héberge les threads de téléchargement et empêche
 * le système d'Android de tuer le process pendant qu'un téléchargement tourne.
 *
 * Pourquoi un foreground service plutôt qu'un thread libre :
 * - Android tue agressivement les apps en background, surtout sur les OEMs
 *   chinois. Un foreground service avec notification persistante survit.
 * - Permet à l'utilisateur de quitter le WebView / l'app sans interrompre le DL.
 *
 * Communique avec `DownloadModule` via `LocalBroadcastManager` : le service
 * ne connaît pas RN, le module relaie vers JS.
 */
class DownloadService : Service() {

    private lateinit var executor: ExecutorService
    private lateinit var store: DownloadStore
    private val jobs = ConcurrentHashMap<String, DownloadJob>()
    private val futures = ConcurrentHashMap<String, Future<*>>()

    override fun onCreate() {
        super.onCreate()
        executor = Executors.newFixedThreadPool(MAX_PARALLEL)
        store = DownloadStore(this)
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                enqueue(id)
            }
            ACTION_PAUSE -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                jobs[id]?.requestPause()
            }
            ACTION_RESUME -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                enqueue(id)
            }
            ACTION_CANCEL -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                val running = jobs[id]
                if (running != null) {
                    running.requestCancel()
                } else {
                    // Pas en cours : on marque directement cancelled dans le store.
                    val entry = store.get(id)
                    if (entry != null) {
                        entry.status = DownloadEntry.STATUS_CANCELLED
                        entry.updatedAt = System.currentTimeMillis()
                        store.upsert(entry)
                        broadcastState(entry)
                        java.io.File(entry.targetPath).delete()
                    }
                }
            }
            ACTION_STOP_IF_IDLE -> {
                if (jobs.isEmpty()) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_STICKY
    }

    private fun enqueue(id: String) {
        if (jobs.containsKey(id)) return // déjà en cours
        val entry = store.get(id) ?: return
        if (entry.status == DownloadEntry.STATUS_DONE) return

        val job = DownloadJob(entry, store, object : DownloadJob.Listener {
            override fun onProgress(entry: DownloadEntry, speedBytesPerSec: Long) {
                broadcastProgress(entry, speedBytesPerSec)
            }

            override fun onStateChanged(entry: DownloadEntry) {
                broadcastState(entry)
                val terminal = entry.status == DownloadEntry.STATUS_DONE ||
                    entry.status == DownloadEntry.STATUS_FAILED ||
                    entry.status == DownloadEntry.STATUS_CANCELLED ||
                    entry.status == DownloadEntry.STATUS_PAUSED
                if (terminal) {
                    jobs.remove(entry.id)
                    futures.remove(entry.id)
                    updateNotificationOrStop()
                }
            }
        })
        jobs[id] = job
        futures[id] = executor.submit(job)
        updateNotificationOrStop()
    }

    private fun updateNotificationOrStop() {
        if (jobs.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val active = jobs.size
        val title = if (active <= 1) "Téléchargement Movix" else "$active téléchargements Movix"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText("Téléchargements en cours dans l'application")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Téléchargements Movix",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Affiche les téléchargements en cours dans l'application Movix."
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun broadcastProgress(entry: DownloadEntry, speedBytesPerSec: Long) {
        DownloadEventBus.emitProgress(entry.id, entry.downloadedBytes, entry.totalBytes, speedBytesPerSec)
    }

    private fun broadcastState(entry: DownloadEntry) {
        DownloadEventBus.emitStateChanged(entry)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        jobs.values.forEach { it.requestCancel() }
        executor.shutdownNow()
    }

    companion object {
        private const val MAX_PARALLEL = 3
        private const val CHANNEL_ID = "movix_downloads"
        private const val NOTIFICATION_ID = 4242

        const val ACTION_START = "com.movix.app.download.START"
        const val ACTION_PAUSE = "com.movix.app.download.PAUSE"
        const val ACTION_RESUME = "com.movix.app.download.RESUME"
        const val ACTION_CANCEL = "com.movix.app.download.CANCEL"
        const val ACTION_STOP_IF_IDLE = "com.movix.app.download.STOP_IF_IDLE"

        const val EXTRA_ID = "id"
    }
}
