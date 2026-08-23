package com.movix.app.cast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.util.Log
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import com.movix.app.R
import com.movix.app.proxy.CastMediaPreparer
import com.movix.app.proxy.CronetMediaProxyUpstream
import com.movix.app.proxy.MediaProxyPolicy
import com.movix.app.proxy.MediaProxyServer
import com.movix.app.proxy.MediaProxyServerConfig
import com.movix.app.proxy.MediaProxySessionAccess
import com.movix.app.proxy.MediaProxySessionStore
import com.movix.app.proxy.NetworkBoundMediaProxyUpstream
import java.util.concurrent.atomic.AtomicBoolean

class CastProxyForegroundService : Service() {
    private val cleanupStarted = AtomicBoolean(false)
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var selectedNetwork: SelectedCastNetwork? = null
    private var sessionStore: MediaProxySessionStore? = null
    private var server: MediaProxyServer? = null
    private var preparer: CastMediaPreparer? = null
    private var powerLease: CastPowerLease? = null
    private var activeSessionId: String? = null

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        connectivityManager =
            getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        createNotificationChannel()
        startVisibleForeground("Chromecast")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRelay(CastRelayStopReason.NOTIFICATION_STOP)
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_START) return START_NOT_STICKY
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
        val pending = requestId?.let(CastRelayRequestRegistry.shared::takePending)
        if (pending == null) {
            stopRelay(CastRelayStopReason.LOAD_FAILED)
            return START_NOT_STICKY
        }
        startVisibleForeground(pending.request.deviceName)
        beginPreparation(pending)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun beginPreparation(pending: CastRelayPendingRequest) {
        cleanupStarted.set(false)
        val existingSelection = selectedNetwork
        if (
            existingSelection != null &&
            MediaProxyPolicy.sameSocketPeer(
                existingSelection.receiverAddress,
                pending.request.receiverAddress,
            ) &&
            preparer != null
        ) {
            prepareWith(pending, requireNotNull(preparer))
            return
        }

        val selected = CastNetworkSelector.selectAndroid(
            connectivityManager,
            pending.request.receiverAddress,
        )
        if (selected == null) {
            pending.callback(
                Result.failure(IllegalStateException("MOVIX_RELAY_WIFI_ROUTE_REQUIRED")),
            )
            stopRelay(CastRelayStopReason.NETWORK_LOST)
            return
        }

        try {
            val access = MediaProxySessionAccess.castLan(
                selected.localAddress,
                selected.receiverAddress,
            )
            val store = MediaProxySessionStore()
            // Fetch upstream via Cronet lie au reseau du Chromecast (signature TLS
            // Chrome) pour passer les CDN fsvid/vidzy qui bloquent okhttp. Repli
            // sur l'upstream okhttp network-bound si Cronet est indisponible.
            val networkUpstream = CronetMediaProxyUpstream(
                context = applicationContext,
                validateUrl = MediaProxyPolicy::validateHttpsUrlSyntax,
                fallback = NetworkBoundMediaProxyUpstream(selected.network),
                boundNetwork = selected.network,
            )
            val relayServer = MediaProxyServer(
                upstream = networkUpstream,
                validateUrl = MediaProxyPolicy::validateHttpsUrlSyntax,
                sessionStore = store,
                config = MediaProxyServerConfig.CastLan(
                    selected.localAddress,
                    selected.receiverAddress,
                ),
            )
            val port = relayServer.start()
            val relayPreparer = CastMediaPreparer(
                upstream = networkUpstream,
                sessionStore = store,
                access = access,
                port = port,
            )
            selectedNetwork = selected
            sessionStore = store
            server = relayServer
            preparer = relayPreparer
            powerLease = CastPowerLease(
                factory = AndroidPowerLeaseFactory(this),
            ).also(CastPowerLease::start)
            registerNetworkObserver(selected)
            prepareWith(pending, relayPreparer)
        } catch (_: Throwable) {
            pending.callback(
                Result.failure(IllegalStateException("MOVIX_RELAY_START_FAILED")),
            )
            stopRelay(CastRelayStopReason.LOAD_FAILED)
        }
    }

    private fun prepareWith(
        pending: CastRelayPendingRequest,
        relayPreparer: CastMediaPreparer,
    ) {
        relayPreparer.prepareAsync(pending.request.source) { result ->
            result.onSuccess {
                powerLease?.noteProxyActivity()
            }
            result.onFailure {
                Log.w(
                    "MovixCastDiag",
                    "prepare_failed code=${it.message?.take(80)} type=${it.javaClass.simpleName}",
                )
                if (activeSessionId == null) {
                    stopRelay(CastRelayStopReason.LOAD_FAILED)
                }
            }
            pending.callback(result)
        }
    }

    private fun registerNetworkObserver(selection: SelectedCastNetwork) {
        networkCallback?.let {
            runCatching { connectivityManager.unregisterNetworkCallback(it) }
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onLost(network: Network) {
                if (network == selection.network) {
                    stopRelay(CastRelayStopReason.NETWORK_LOST)
                }
            }

            override fun onLinkPropertiesChanged(
                network: Network,
                linkProperties: LinkProperties,
            ) {
                if (network != selection.network) return
                val stillValid = CastNetworkSelector.selectionStillValid(
                    CastNetworkSelection(
                        networkId = selection.network.toString(),
                        receiverAddress = selection.receiverAddress,
                        localAddress = selection.localAddress,
                    ),
                    routes = linkProperties.routes.map {
                        RouteSnapshot(
                            it.destination.address,
                            it.destination.prefixLength,
                        )
                    },
                    linkAddresses = linkProperties.linkAddresses.map { it.address },
                )
                if (!stillValid) stopRelay(CastRelayStopReason.ADDRESS_CHANGED)
            }
        }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        connectivityManager.registerNetworkCallback(request, callback)
        networkCallback = callback
    }

    internal fun updatePlaybackState(state: NativeCastPlaybackState) {
        powerLease?.updatePlaybackState(state)
    }

    internal fun noteProxyActivity() {
        powerLease?.noteProxyActivity()
    }

    internal fun replaceAcceptedSession(newSessionId: String) {
        val oldSession = activeSessionId
        if (oldSession != null && oldSession != newSessionId) {
            sessionStore?.replaceAfterAcceptedLoad(oldSession, OLD_SESSION_GRACE_MS)
        }
        activeSessionId = newSessionId
    }

    internal fun discardPreparedSession(sessionId: String) {
        sessionStore?.invalidate(sessionId)
        if (activeSessionId == null) {
            stopRelay(CastRelayStopReason.LOAD_FAILED)
        }
    }

    internal fun stopRelay(reason: CastRelayStopReason) {
        if (!cleanupStarted.compareAndSet(false, true)) return
        if (
            reason == CastRelayStopReason.NETWORK_LOST ||
            reason == CastRelayStopReason.ADDRESS_CHANGED ||
            reason == CastRelayStopReason.NOTIFICATION_STOP
        ) {
            ForegroundCastRelayClient.notifyTerminal(reason)
        }
        val callback = networkCallback
        networkCallback = null
        runCatching { callback?.let(connectivityManager::unregisterNetworkCallback) }
        runCatching { sessionStore?.invalidateAll(com.movix.app.proxy.MediaProxyMode.CAST_LAN) }
        runCatching { preparer?.close() }
        runCatching { server?.close() }
        runCatching { powerLease?.release() }
        selectedNetwork = null
        sessionStore = null
        server = null
        preparer = null
        powerLease = null
        activeSessionId = null
        CastRelayRequestRegistry.shared.clear()
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    override fun onDestroy() {
        stopRelay(CastRelayStopReason.SERVICE_DESTROYED)
        if (activeInstance === this) activeInstance = null
        super.onDestroy()
    }

    private fun startVisibleForeground(deviceName: String) {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Movix diffuse vers $deviceName")
            .setContentText("Le téléphone relaie la vidéo")
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Arrêter",
                    stopPendingIntent(this),
                ).build(),
            )
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Diffusion Chromecast",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    companion object {
        const val ACTION_START = "com.movix.app.cast.START_RELAY"
        const val ACTION_STOP = "com.movix.app.cast.STOP_RELAY"
        const val EXTRA_REQUEST_ID = "requestId"
        private const val CHANNEL_ID = "movix_cast_relay"
        private const val NOTIFICATION_ID = 25041
        private const val OLD_SESSION_GRACE_MS = 10_000L

        @Volatile
        internal var activeInstance: CastProxyForegroundService? = null

        fun startIntent(context: Context, requestId: String): Intent {
            return Intent(context, CastProxyForegroundService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_REQUEST_ID, requestId)
        }

        fun stopIntent(context: Context): Intent {
            return Intent(context, CastProxyForegroundService::class.java)
                .setAction(ACTION_STOP)
        }

        fun stopPendingIntent(context: Context): PendingIntent {
            return PendingIntent.getService(
                context,
                25042,
                stopIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
