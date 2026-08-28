package com.movix.app.cast

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.mediarouter.app.MediaRouteChooserDialog
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.movix.app.proxy.CastPreparedSource
import com.movix.app.proxy.CastPreparedTextTrack

class CastModule internal constructor(
    private val reactContext: ReactApplicationContext,
    private val relayClient: CastRelayClient = ForegroundCastRelayClient(reactContext),
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {
    private data class PendingLoad(
        val source: CastPreparedSource,
        val metadata: CastRemoteMetadata,
        val startTimeSec: Double,
        val promise: Promise,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val userSettings = CastUserSettings(reactContext)
    private var castContext: CastContext? = null
    private var acceptedCoordinator: CastLoadCoordinator? = null
    private var pendingCoordinator: CastLoadCoordinator? = null
    private var pendingLoad: PendingLoad? = null
    private var listenerRegistered = false
    private var mediaRouter: MediaRouter? = null
    private var discoveryActive = false

    /**
     * Abonnement vide : seule son existence compte. MediaRouter ne fait tourner
     * la découverte que tant qu'au moins un callback est enregistré.
     */
    private val discoveryCallback = object : MediaRouter.Callback() {}

    private val sessionListener = object : SessionManagerListener<CastSession> {
        override fun onSessionStarted(session: CastSession, sessionId: String) {
            emitSession("CAST_SESSION_STARTED", session)
            consumePendingLoad(session)
        }

        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
            emitSession("CAST_SESSION_RESUMED", session)
            if (pendingLoad != null) {
                consumePendingLoad(session)
            } else {
                val active = acceptedCoordinator
                if (active == null) {
                    emitStatus(reloadRequiredStatus(session.castDevice?.friendlyName))
                } else {
                    active.getStatus(false) { result ->
                        emitStatus(
                            result.getOrElse {
                                reloadRequiredStatus(session.castDevice?.friendlyName)
                            },
                        )
                    }
                }
            }
        }

        override fun onSessionEnded(session: CastSession, error: Int) {
            failPending("MOVIX_CAST_SESSION_ENDED")
            clearCoordinators(CastRelayStopReason.SESSION_ENDED)
            emitStatus(CastStatusMapper.disconnected())
            emit("CAST_SESSION_ENDED", Arguments.createMap().apply {
                putString("errorCode", "MOVIX_CAST_SESSION_ENDED")
            })
        }

        override fun onSessionStartFailed(session: CastSession, error: Int) {
            failPending("MOVIX_CAST_SESSION_FAILED")
            clearCoordinators(CastRelayStopReason.LOAD_FAILED)
            emitStatus(
                CastStatusMapper.disconnected("MOVIX_CAST_SESSION_FAILED"),
            )
            emit("CAST_SESSION_FAILED", Arguments.createMap().apply {
                putString("errorCode", "MOVIX_CAST_SESSION_FAILED")
            })
        }

        override fun onSessionResumeFailed(session: CastSession, error: Int) {
            clearCoordinators(CastRelayStopReason.SESSION_ENDED)
            emitStatus(
                CastStatusMapper.disconnected("MOVIX_RELAY_RELOAD_REQUIRED"),
            )
        }

        override fun onSessionSuspended(session: CastSession, reason: Int) = Unit
        override fun onSessionStarting(session: CastSession) = Unit
        override fun onSessionEnding(session: CastSession) = Unit
        override fun onSessionResuming(session: CastSession, sessionId: String) = Unit
    }

    override fun getName(): String = "CastModule"

    override fun initialize() {
        super.initialize()
        relayClient.setTerminalListener { reason ->
            reactContext.runOnUiQueueThread {
                val pending = pendingCoordinator
                pendingCoordinator = null
                pending?.abandonPendingLoad(reason.toErrorCode())
                val accepted = acceptedCoordinator
                acceptedCoordinator = null
                accepted?.retireAfterReplacement()
                castContext?.sessionManager?.endCurrentSession(true)
                val errorCode = when (reason) {
                    CastRelayStopReason.NETWORK_LOST ->
                        "MOVIX_RELAY_NETWORK_LOST"
                    CastRelayStopReason.ADDRESS_CHANGED ->
                        "MOVIX_RELAY_ADDRESS_CHANGED"
                    CastRelayStopReason.NOTIFICATION_STOP ->
                        "MOVIX_RELAY_STOPPED"
                    else -> "MOVIX_RELAY_STOPPED"
                }
                emitStatus(CastStatusMapper.disconnected(errorCode))
            }
        }
        reactContext.addLifecycleEventListener(this)
        reactContext.runOnUiQueueThread { startRouteDiscovery() }
    }

    override fun invalidate() {
        relayClient.setTerminalListener(null)
        reactContext.removeLifecycleEventListener(this)
        reactContext.runOnUiQueueThread {
            stopRouteDiscovery()
            clearCoordinators(CastRelayStopReason.SESSION_ENDED)
            if (listenerRegistered) {
                castContext?.sessionManager?.removeSessionManagerListener(
                    sessionListener,
                    CastSession::class.java,
                )
                listenerRegistered = false
            }
        }
        super.invalidate()
    }

    override fun onHostResume() {
        reactContext.runOnUiQueueThread { startRouteDiscovery() }
    }

    override fun onHostPause() {
        reactContext.runOnUiQueueThread { stopRouteDiscovery() }
    }

    override fun onHostDestroy() {
        reactContext.runOnUiQueueThread { stopRouteDiscovery() }
    }

    /**
     * Tient la découverte Cast chaude tant que l'app est au premier plan.
     *
     * MediaRouter ne scanne que tant qu'un callback est abonné, et `CastContext`
     * n'existait qu'à partir du premier appui — `initialize()` s'exécutant avant
     * qu'une activité soit attachée, `ensureContext()` y rendait `null`. Chaque
     * ouverture du sélecteur repartait donc d'un scan à froid : la liste
     * s'affichait vide, l'utilisateur fermait, et `setOnDismissListener`
     * rejetait la lecture en MOVIX_CAST_PICKER_DISMISSED. D'où les appuis
     * répétés avant que les appareils apparaissent.
     *
     * `CALLBACK_FLAG_REQUEST_DISCOVERY` demande une découverte passive : le
     * scan actif reste réservé au sélecteur, qui l'active lui-même.
     */
    private fun startRouteDiscovery() {
        if (discoveryActive) return
        if (ensureContext() == null) return
        val router = mediaRouter
            ?: runCatching { MediaRouter.getInstance(reactContext) }
                .getOrNull()
                ?.also { mediaRouter = it }
            ?: return
        runCatching {
            router.addCallback(
                buildRouteSelector(),
                discoveryCallback,
                MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY,
            )
        }.onSuccess { discoveryActive = true }
    }

    private fun stopRouteDiscovery() {
        if (!discoveryActive) return
        runCatching { mediaRouter?.removeCallback(discoveryCallback) }
        discoveryActive = false
    }

    @ReactMethod
    fun isSupported(promise: Promise) {
        reactContext.runOnUiQueueThread {
            val available = GoogleApiAvailability.getInstance()
                    .isGooglePlayServicesAvailable(reactContext) ==
                ConnectionResult.SUCCESS
            promise.resolve(available)
        }
    }

    @ReactMethod
    fun getCapabilities(promise: Promise) {
        promise.resolve(
            Arguments.createMap().apply {
                putBoolean("configured", true)
                putInt("receiverProtocolVersion", CAST_RECEIVER_PROTOCOL_VERSION)
                putInt("castLanProxyVersion", 1)
            },
        )
    }

    @ReactMethod
    fun showPicker(promise: Promise) {
        reactContext.runOnUiQueueThread {
            val activity = currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No foreground activity")
            } else if (ensureContext() == null) {
                promise.reject("CAST_UNAVAILABLE", "Google Cast is unavailable")
            } else {
                runCatching {
                    MediaRouteChooserDialog(activity).apply {
                        routeSelector = buildRouteSelector()
                        show()
                    }
                }.fold(
                    onSuccess = { promise.resolve(true) },
                    onFailure = {
                        promise.reject("PICKER_ERROR", "Unable to show Cast picker")
                    },
                )
            }
        }
    }

    @ReactMethod
    fun loadProxiedMedia(
        source: ReadableMap,
        metadata: ReadableMap,
        startTimeSec: Double,
        promise: Promise,
    ) {
        reactContext.runOnUiQueueThread {
            val parsed = runCatching {
                require(
                    source.hasKey("protocolVersion") &&
                        source.getInt("protocolVersion") == 1,
                ) {
                    "MOVIX_CAST_PROTOCOL_MISMATCH"
                }
                PendingLoad(
                    source = parseSource(source),
                    metadata = parseMetadata(metadata),
                    startTimeSec = startTimeSec.coerceAtLeast(0.0),
                    promise = promise,
                )
            }.getOrElse {
                promise.reject("MOVIX_CAST_INVALID_SOURCE", "Invalid prepared Cast source")
                return@runOnUiQueueThread
            }
            val context = ensureContext()
            if (context == null) {
                promise.reject("CAST_UNAVAILABLE", "Google Cast is unavailable")
                return@runOnUiQueueThread
            }
            val session = context.sessionManager.currentCastSession
            if (session?.isConnected == true) {
                startLoad(session, parsed)
                return@runOnUiQueueThread
            }
            val activity = currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No foreground activity")
                return@runOnUiQueueThread
            }
            failPending("MOVIX_CAST_LOAD_REPLACED")
            pendingLoad = parsed
            runCatching {
                MediaRouteChooserDialog(activity).apply {
                    routeSelector = buildRouteSelector()
                    setOnDismissListener {
                        mainHandler.postDelayed({
                            val current = context.sessionManager.currentCastSession
                            if (current?.isConnected != true && current?.isConnecting != true) {
                                failPending("MOVIX_CAST_PICKER_DISMISSED")
                                clearCoordinators(CastRelayStopReason.EXPLICIT)
                                emit("CAST_PICKER_DISMISSED", null)
                            }
                        }, 500L)
                    }
                    show()
                }
            }.onFailure {
                failPending("MOVIX_CAST_PICKER_ERROR")
            }
        }
    }

    @ReactMethod
    fun play(promise: Promise) = withCoordinator(promise) {
        it.play { result -> promise.settle(result) }
    }

    @ReactMethod
    fun pause(promise: Promise) = withCoordinator(promise) {
        it.pause { result -> promise.settle(result) }
    }

    @ReactMethod
    fun seekTo(seconds: Double, promise: Promise) = withCoordinator(promise) {
        it.seekTo(seconds) { result -> promise.settle(result) }
    }

    @ReactMethod
    fun getStatus(refresh: Boolean, promise: Promise) {
        reactContext.runOnUiQueueThread {
            val active = acceptedCoordinator
            if (active == null) {
                val session = ensureContext()?.sessionManager?.currentCastSession
                val status = if (session?.isConnected == true) {
                    reloadRequiredStatus(session.castDevice?.friendlyName)
                } else {
                    CastStatusMapper.disconnected()
                }
                promise.resolve(status.toWritableMap())
                return@runOnUiQueueThread
            }
            active.getStatus(refresh) { result ->
                result.fold(
                    onSuccess = { promise.resolve(it.toWritableMap()) },
                    onFailure = {
                        promise.reject("MOVIX_CAST_STATUS_FAILED", "Unable to read Cast status")
                    },
                )
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        reactContext.runOnUiQueueThread {
            val pending = pendingCoordinator
            pendingCoordinator = null
            pending?.abandonPendingLoad("MOVIX_CAST_STOPPED")
            val active = acceptedCoordinator
            acceptedCoordinator = null
            if (active == null) {
                relayClient.stop(CastRelayStopReason.EXPLICIT)
                castContext?.sessionManager?.endCurrentSession(true)
                promise.resolve(true)
                return@runOnUiQueueThread
            }
            active.stop {
                castContext?.sessionManager?.endCurrentSession(true)
                promise.settle(it)
            }
        }
    }

    @ReactMethod
    fun getRelayDisclosurePreference(promise: Promise) {
        promise.resolve(userSettings.isRelayDisclosureSuppressed())
    }

    @ReactMethod
    fun setRelayDisclosureSuppressed(suppressed: Boolean, promise: Promise) {
        userSettings.setRelayDisclosureSuppressed(suppressed)
        promise.resolve(true)
    }

    @ReactMethod
    fun openBatterySettings(promise: Promise) {
        runCatching(userSettings::openBatterySettings).fold(
            onSuccess = { promise.resolve(true) },
            onFailure = {
                promise.reject("MOVIX_BATTERY_SETTINGS_UNAVAILABLE", "Settings unavailable")
            },
        )
    }

    @ReactMethod
    fun requestRelayNotificationPermission(promise: Promise) {
        reactContext.runOnUiQueueThread {
            runCatching {
                val activity = currentActivity
                if (
                    Build.VERSION.SDK_INT >= 33 &&
                    activity != null &&
                    activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
                ) {
                    activity.requestPermissions(
                        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                        NOTIFICATION_PERMISSION_REQUEST,
                    )
                }
            }
            // The request is contextual and deliberately never awaited or used as a Cast gate.
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    private fun consumePendingLoad(session: CastSession) {
        val pending = pendingLoad ?: return
        pendingLoad = null
        startLoad(session, pending)
    }

    private fun startLoad(session: CastSession, pending: PendingLoad) {
        val receiverAddress = session.castDevice?.inetAddress
        val remote = session.remoteMediaClient
        if (receiverAddress == null || remote == null) {
            pending.promise.reject(
                "MOVIX_RELAY_RECEIVER_ADDRESS_REQUIRED",
                "Receiver address unavailable",
            )
            if (acceptedCoordinator == null) {
                relayClient.stop(CastRelayStopReason.LOAD_FAILED)
                emitStatus(
                    CastStatusMapper.disconnected(
                        "MOVIX_RELAY_RECEIVER_ADDRESS_REQUIRED",
                    ),
                )
            } else {
                emitAcceptedStatusOrError("MOVIX_RELAY_RECEIVER_ADDRESS_REQUIRED")
            }
            return
        }
        val previousAccepted = acceptedCoordinator
        val supersededPending = pendingCoordinator
        pendingCoordinator = null
        supersededPending?.abandonPendingLoad("MOVIX_CAST_LOAD_REPLACED")
        val nextCoordinator = CastLoadCoordinator(
            relayClient,
            GoogleCastRemoteClient(remote, session.castDevice?.friendlyName),
            ::emitStatus,
        )
        pendingCoordinator = nextCoordinator
        nextCoordinator.load(
            CastRelayRequest(
                deviceName = session.castDevice?.friendlyName ?: "Chromecast",
                receiverAddress = receiverAddress,
                source = pending.source,
            ),
            pending.metadata,
            pending.startTimeSec,
            loadCallback@ { result ->
                val wasCurrent = pendingCoordinator === nextCoordinator
                if (!wasCurrent) {
                    pending.promise.settle(result)
                    return@loadCallback
                }
                pendingCoordinator = null
                if (result.isSuccess) {
                    previousAccepted?.retireAfterReplacement()
                    nextCoordinator.activateStatusListener()
                    acceptedCoordinator = nextCoordinator
                } else {
                    nextCoordinator.retireAfterReplacement()
                    emitAcceptedStatusOrError(
                        result.exceptionOrNull()?.message
                            ?.takeIf { it.startsWith("MOVIX_") }
                            ?: "MOVIX_CAST_LOAD_FAILED",
                    )
                }
                pending.promise.settle(result)
            },
        )
    }

    private fun parseSource(source: ReadableMap): CastPreparedSource {
        val url = source.getString("url")
            ?.takeIf(String::isNotBlank)
            ?: throw IllegalArgumentException("Missing source URL")
        val headers = parseHeaders(source, "headers")
        val tracks = if (
            source.hasKey("tracks") &&
            source.getType("tracks") == ReadableType.Array
        ) {
            parseTracks(source.getArray("tracks"))
        } else {
            emptyList()
        }
        return CastPreparedSource(
            url = url,
            headers = headers,
            contentType = source.optionalString("contentType"),
            tracks = tracks,
        )
    }

    private fun parseTracks(array: ReadableArray?): List<CastPreparedTextTrack> {
        if (array == null) return emptyList()
        return buildList {
            for (index in 0 until minOf(array.size(), 16)) {
                if (array.getType(index) != ReadableType.Map) continue
                val track = array.getMap(index) ?: continue
                val url = track.optionalString("url")
                val inlineVtt = track.optionalString("inlineVtt")
                if ((url == null) == (inlineVtt == null)) continue
                add(
                    CastPreparedTextTrack(
                        url = url,
                        language = track.optionalString("language"),
                        name = track.optionalString("name"),
                        contentType = track.optionalString("contentType") ?: "text/vtt",
                        headers = parseHeaders(track, "headers"),
                        active =
                            track.hasKey("active") &&
                                track.getType("active") == ReadableType.Boolean &&
                                track.getBoolean("active"),
                        inlineVtt = inlineVtt,
                    ),
                )
            }
        }
    }

    private fun parseMetadata(metadata: ReadableMap): CastRemoteMetadata {
        return CastRemoteMetadata(
            title = metadata.optionalString("title") ?: "Movix",
            poster = metadata.optionalString("poster"),
        )
    }

    private fun ReadableMap.optionalString(key: String): String? {
        return if (hasKey(key) && getType(key) == ReadableType.String) {
            getString(key)?.takeIf(String::isNotBlank)
        } else {
            null
        }
    }

    private fun parseHeaders(source: ReadableMap, key: String): Map<String, String> {
        if (!source.hasKey(key) || source.getType(key) != ReadableType.Map) {
            return emptyMap()
        }
        val output = linkedMapOf<String, String>()
        val map = source.getMap(key) ?: return emptyMap()
        val iterator = map.keySetIterator()
        while (iterator.hasNextKey() && output.size < 32) {
            val headerName = iterator.nextKey()
            if (map.getType(headerName) == ReadableType.String) {
                map.getString(headerName)?.let { output[headerName] = it }
            }
        }
        return output
    }

    private fun ensureContext(): CastContext? {
        castContext?.let { return it }
        val activity = currentActivity ?: return null
        if (
            GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS
        ) {
            return null
        }
        return runCatching {
            CastContext.getSharedInstance(activity).also {
                if (!listenerRegistered) {
                    it.sessionManager.addSessionManagerListener(
                        sessionListener,
                        CastSession::class.java,
                    )
                    listenerRegistered = true
                }
                castContext = it
            }
        }.getOrNull()
    }

    private fun buildRouteSelector(): MediaRouteSelector {
        return MediaRouteSelector.Builder()
            .addControlCategory(
                CastMediaControlIntent.categoryForCast(
                    CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID,
                ),
            )
            .build()
    }

    private fun withCoordinator(
        promise: Promise,
        action: (CastLoadCoordinator) -> Unit,
    ) {
        reactContext.runOnUiQueueThread {
            val active = acceptedCoordinator
            if (active == null) {
                promise.reject("MOVIX_CAST_NOT_LOADED", "No active prepared Cast media")
            } else {
                action(active)
            }
        }
    }

    private fun Promise.settle(result: Result<Unit>) {
        result.fold(
            onSuccess = { resolve(true) },
            onFailure = {
                reject(
                    it.message?.takeIf { code -> code.startsWith("MOVIX_") }
                        ?: "MOVIX_CAST_COMMAND_FAILED",
                    "Cast command failed",
                )
            },
        )
    }

    private fun failPending(code: String) {
        pendingLoad?.promise?.reject(code, "Cast request cancelled")
        pendingLoad = null
    }

    private fun clearCoordinators(reason: CastRelayStopReason) {
        val pending = pendingCoordinator
        pendingCoordinator = null
        pending?.abandonPendingLoad(reason.toErrorCode())
        val accepted = acceptedCoordinator
        acceptedCoordinator = null
        if (accepted != null) {
            accepted.cancel(reason)
        } else if (pending != null) {
            relayClient.stop(reason)
        }
    }

    private fun emitAcceptedStatusOrError(errorCode: String) {
        val accepted = acceptedCoordinator
        if (accepted == null) {
            emitStatus(CastStatusMapper.disconnected(errorCode))
            return
        }
        accepted.getStatus(false) { result ->
            emitStatus(
                result.getOrElse {
                    CastStatusMapper.disconnected(errorCode)
                },
            )
        }
    }

    private fun CastRelayStopReason.toErrorCode(): String = when (this) {
        CastRelayStopReason.NETWORK_LOST -> "MOVIX_RELAY_NETWORK_LOST"
        CastRelayStopReason.ADDRESS_CHANGED -> "MOVIX_RELAY_ADDRESS_CHANGED"
        CastRelayStopReason.NOTIFICATION_STOP -> "MOVIX_RELAY_STOPPED"
        CastRelayStopReason.SESSION_ENDED -> "MOVIX_CAST_SESSION_ENDED"
        CastRelayStopReason.LOAD_FAILED -> "MOVIX_CAST_LOAD_FAILED"
        CastRelayStopReason.SERVICE_DESTROYED -> "MOVIX_RELAY_SERVICE_STOPPED"
        CastRelayStopReason.EXPLICIT -> "MOVIX_CAST_STOPPED"
    }

    private fun reloadRequiredStatus(deviceName: String?): NativeCastStatus {
        return CastStatusMapper.map(
            CastStatusSnapshot(
                connected = true,
                deviceName = deviceName,
                playbackState = NativeCastPlaybackState.ERROR,
                errorCode = "MOVIX_RELAY_RELOAD_REQUIRED",
            ),
        )
    }

    private fun emitSession(name: String, session: CastSession) {
        emit(name, Arguments.createMap().apply {
            putString("deviceName", session.castDevice?.friendlyName)
        })
    }

    private fun emitStatus(status: NativeCastStatus) {
        emit("CAST_MEDIA_STATUS", status.toWritableMap())
    }

    private fun NativeCastStatus.toWritableMap(): WritableMap {
        return Arguments.createMap().apply {
            putBoolean("connected", connected)
            putString("deviceName", deviceName)
            mediaSessionId?.let { putInt("mediaSessionId", it) } ?: putNull("mediaSessionId")
            putString("state", state)
            putDouble("positionSec", positionSec)
            durationSec?.let { putDouble("durationSec", it) } ?: putNull("durationSec")
            putBoolean("canSeek", canSeek)
            putString("idleReason", idleReason)
            putString("errorCode", errorCode)
        }
    }

    private fun emit(name: String, params: WritableMap?) {
        runCatching {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        }
    }

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 2541
        private const val CAST_RECEIVER_PROTOCOL_VERSION = 1
    }
}
