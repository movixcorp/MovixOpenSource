package com.movix.app.download

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Façade RN du système de téléchargement custom.
 *
 * Surface exposée à JS :
 * - `start(opts)` → id (string). opts = { url, filename, subFolder?, headers?, metadata? }
 * - `pause(id)` / `resume(id)` / `cancel(id)` / `delete(id)`
 * - `list()` → array d'entries (forme miroir de DownloadEntry.toJson)
 * - `get(id)` → entry ou null
 *
 * Events JS :
 * - `MovixDownloadProgress` : { id, bytesDownloaded, bytesTotal, speedBytesPerSec }
 * - `MovixDownloadState`    : entry complète (avec status à jour)
 *
 * Le module relaie depuis le `DownloadService` via `LocalBroadcastManager`.
 */
class DownloadModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    private val store = DownloadStore(reactContext)
    private var subscribed = false

    private val busListener = object : DownloadEventBus.Listener {
        override fun onProgress(id: String, bytesDownloaded: Long, bytesTotal: Long, speedBytesPerSec: Long) {
            val payload = Arguments.createMap().apply {
                putString("id", id)
                putDouble("bytesDownloaded", bytesDownloaded.toDouble())
                putDouble("bytesTotal", bytesTotal.toDouble())
                putDouble("speedBytesPerSec", speedBytesPerSec.toDouble())
            }
            emit("MovixDownloadProgress", payload)
        }

        override fun onStateChanged(entry: DownloadEntry) {
            emit("MovixDownloadState", entryToMap(entry))
        }
    }

    init {
        reactContext.addLifecycleEventListener(this)
        subscribe()
    }

    override fun getName(): String = "MovixDownloadModule"

    // --- RN methods ------------------------------------------------------

    @ReactMethod
    fun start(opts: ReadableMap, promise: Promise) {
        try {
            val url = opts.getString("url") ?: run {
                promise.reject("INVALID_URL", "Missing url")
                return
            }
            val parsed = Uri.parse(url)
            if (parsed.scheme?.lowercase() !in listOf("http", "https")) {
                promise.reject("INVALID_URL", "Only http(s) URLs are allowed")
                return
            }

            val rawFilename = opts.getString("filename")?.takeIf { it.isNotBlank() } ?: "download.bin"
            val filename = sanitizeFilename(rawFilename)
            val subFolder = opts.getString("subFolder")?.let { sanitizeSubFolder(it) } ?: ""

            val dir = reactContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: throw IllegalStateException("External files dir unavailable")
            val targetDir = if (subFolder.isEmpty()) dir else File(dir, subFolder)
            if (!targetDir.exists()) targetDir.mkdirs()
            val target = uniquifyTarget(targetDir, filename)

            val headersJson = opts.getMap("headers")?.let { readableMapToJson(it) }?.toString() ?: "{}"
            val metadataJson = opts.getMap("metadata")?.let { readableMapToJson(it) }?.toString() ?: "{}"

            val id = UUID.randomUUID().toString()
            val now = System.currentTimeMillis()
            val entry = DownloadEntry(
                id = id,
                url = url,
                filename = target.name,
                targetPath = target.absolutePath,
                totalBytes = -1L,
                downloadedBytes = 0L,
                status = DownloadEntry.STATUS_QUEUED,
                errorMessage = null,
                createdAt = now,
                updatedAt = now,
                metadataJson = metadataJson,
                headersJson = headersJson,
            )
            store.upsert(entry)

            startService(DownloadService.ACTION_START, id)

            val result = Arguments.createMap().apply {
                putString("id", id)
                putString("targetPath", target.absolutePath)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("START_ERROR", e.message ?: "unknown", e)
        }
    }

    @ReactMethod
    fun pause(id: String, promise: Promise) {
        startService(DownloadService.ACTION_PAUSE, id)
        promise.resolve(null)
    }

    @ReactMethod
    fun resume(id: String, promise: Promise) {
        val entry = store.get(id)
        if (entry == null) {
            promise.reject("NOT_FOUND", "Unknown download id")
            return
        }
        startService(DownloadService.ACTION_RESUME, id)
        promise.resolve(null)
    }

    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        startService(DownloadService.ACTION_CANCEL, id)
        promise.resolve(null)
    }

    @ReactMethod
    fun delete(id: String, promise: Promise) {
        val entry = store.get(id)
        if (entry == null) {
            promise.resolve(null)
            return
        }
        // Annule d'abord (no-op si pas en cours) puis purge fichier + store.
        startService(DownloadService.ACTION_CANCEL, id)
        try {
            File(entry.targetPath).delete()
        } catch (_: Exception) { /* best effort */ }
        store.remove(id)
        promise.resolve(null)
    }

    @ReactMethod
    fun launch(id: String, promise: Promise) {
        val entry = store.get(id)
        if (entry == null) {
            promise.reject("NOT_FOUND", "Download not found")
            return
        }
        if (entry.status != DownloadEntry.STATUS_DONE) {
            promise.reject("NOT_DONE", "Download is not complete")
            return
        }
        try {
            val file = java.io.File(entry.targetPath)
            if (!file.exists()) {
                promise.reject("FILE_NOT_FOUND", "File not found on disk")
                return
            }
            val uri = FileProvider.getUriForFile(
                reactContext,
                "${reactContext.packageName}.updateprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "video/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("LAUNCH_ERROR", e.message ?: "unknown", e)
        }
    }

    @ReactMethod
    fun list(promise: Promise) {
        try {
            val arr: WritableArray = Arguments.createArray()
            store.all().forEach { arr.pushMap(entryToMap(it)) }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("LIST_ERROR", e.message ?: "unknown", e)
        }
    }

    @ReactMethod
    fun get(id: String, promise: Promise) {
        val entry = store.get(id)
        if (entry == null) promise.resolve(null) else promise.resolve(entryToMap(entry))
    }

    // Requis par NativeEventEmitter pour éviter le warning RN.
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) { /* no-op */ }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) { /* no-op */ }

    // --- Helpers ---------------------------------------------------------

    private fun startService(action: String, id: String) {
        val intent = Intent(reactContext, DownloadService::class.java).apply {
            this.action = action
            putExtra(DownloadService.EXTRA_ID, id)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
        } catch (e: Exception) {
            // Si l'app est entièrement en background sur Android 12+, startForegroundService
            // peut throw. On laisse l'erreur remonter en log mais on ne crash pas le pont.
            android.util.Log.w("MovixDownloadModule", "startService failed for $action", e)
        }
    }

    private fun subscribe() {
        if (subscribed) return
        DownloadEventBus.subscribe(busListener)
        subscribed = true
    }

    private fun unsubscribe() {
        if (!subscribed) return
        DownloadEventBus.unsubscribe(busListener)
        subscribed = false
    }

    private fun emit(event: String, payload: WritableMap) {
        if (!reactContext.hasActiveReactInstance()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, payload)
        } catch (e: Exception) {
            android.util.Log.w("MovixDownloadModule", "emit $event failed", e)
        }
    }

    private fun entryToMap(entry: DownloadEntry): WritableMap {
        // Le plus simple : passer par le JSON natif puis convertir.
        val json = entry.toJson()
        return jsonObjectToWritableMap(json)
    }

    private fun jsonObjectToWritableMap(obj: JSONObject): WritableMap {
        val map = Arguments.createMap()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            when (val value = obj.opt(key)) {
                null, JSONObject.NULL -> map.putNull(key)
                is Boolean -> map.putBoolean(key, value)
                is Int -> map.putInt(key, value)
                is Long -> map.putDouble(key, value.toDouble())
                is Double -> map.putDouble(key, value)
                is String -> map.putString(key, value)
                is JSONObject -> map.putMap(key, jsonObjectToWritableMap(value))
                else -> map.putString(key, value.toString())
            }
        }
        return map
    }

    private fun readableMapToJson(map: ReadableMap): JSONObject {
        val obj = JSONObject()
        val iter = map.keySetIterator()
        while (iter.hasNextKey()) {
            val key = iter.nextKey()
            when (map.getType(key)) {
                com.facebook.react.bridge.ReadableType.Null -> obj.put(key, JSONObject.NULL)
                com.facebook.react.bridge.ReadableType.Boolean -> obj.put(key, map.getBoolean(key))
                com.facebook.react.bridge.ReadableType.Number -> obj.put(key, map.getDouble(key))
                com.facebook.react.bridge.ReadableType.String -> obj.put(key, map.getString(key))
                com.facebook.react.bridge.ReadableType.Map -> obj.put(key, readableMapToJson(map.getMap(key)!!))
                com.facebook.react.bridge.ReadableType.Array -> obj.put(key, readableArrayToJson(map.getArray(key)!!))
            }
        }
        return obj
    }

    private fun readableArrayToJson(arr: ReadableArray): org.json.JSONArray {
        val out = org.json.JSONArray()
        for (i in 0 until arr.size()) {
            when (arr.getType(i)) {
                com.facebook.react.bridge.ReadableType.Null -> out.put(JSONObject.NULL)
                com.facebook.react.bridge.ReadableType.Boolean -> out.put(arr.getBoolean(i))
                com.facebook.react.bridge.ReadableType.Number -> out.put(arr.getDouble(i))
                com.facebook.react.bridge.ReadableType.String -> out.put(arr.getString(i))
                com.facebook.react.bridge.ReadableType.Map -> out.put(readableMapToJson(arr.getMap(i)))
                com.facebook.react.bridge.ReadableType.Array -> out.put(readableArrayToJson(arr.getArray(i)))
            }
        }
        return out
    }

    private fun sanitizeFilename(name: String): String {
        // Retire caractères interdits FAT/ext4, garde uniquement le basename.
        val basename = name.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = basename.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim()
        return cleaned.ifBlank { "download.bin" }.take(180)
    }

    private fun sanitizeSubFolder(path: String): String {
        // Empêche le path traversal. Garde les segments alphanum + tiret/underscore.
        return path.split('/', '\\')
            .map { it.trim() }
            .filter { it.isNotEmpty() && it != "." && it != ".." }
            .map { it.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80) }
            .joinToString("/")
    }

    private fun uniquifyTarget(dir: File, filename: String): File {
        val candidate = File(dir, filename)
        if (!candidate.exists()) return candidate
        val dot = filename.lastIndexOf('.')
        val stem = if (dot > 0) filename.substring(0, dot) else filename
        val ext = if (dot > 0) filename.substring(dot) else ""
        var i = 1
        while (true) {
            val next = File(dir, "$stem ($i)$ext")
            if (!next.exists()) return next
            i++
        }
    }

    override fun onHostResume() { subscribe() }

    override fun onHostPause() { /* listener reste actif pour ne pas rater de progress */ }

    override fun onHostDestroy() { unsubscribe() }
}
