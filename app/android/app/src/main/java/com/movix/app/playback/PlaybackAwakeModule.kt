package com.movix.app.playback

import android.app.Activity
import android.view.Window
import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Parite iOS (Playback/PlaybackAwakeModule.swift) : l'ecran reste allume tant
 * qu'au moins un proprietaire le demande. Un seul booleen ne suffisait pas —
 * la fin de la lecture locale eteignait l'ecran alors que le PiP ou le Cast
 * etaient toujours actifs.
 */
class PlaybackAwakeModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val lock = Any()
    private val owners = linkedSetOf<String>()
    private var invalidated = false
    private var appliedActive = false
    private var appliedWindow: Window? = null

    override fun getName() = "PlaybackAwake"

    @ReactMethod
    fun setLocalPlaybackAwake(active: Boolean) {
        setOwner(LOCAL_PLAYBACK_OWNER, active)
    }

    @ReactMethod
    fun setPlaybackAwakeOwner(owner: String, active: Boolean) {
        if (owner !in ALLOWED_OWNERS || !ownerPattern.matches(owner)) return
        setOwner(owner, active)
    }

    override fun invalidate() {
        val activity = currentActivity
        synchronized(lock) {
            invalidated = true
            owners.clear()
            appliedActive = false
            appliedWindow = null
        }
        activity?.runOnUiThread { clearWindowFlag(activity.window) }
        super.invalidate()
    }

    private fun setOwner(owner: String, active: Boolean) {
        val desired = synchronized(lock) {
            if (invalidated) return
            val changed = if (active) owners.add(owner) else owners.remove(owner)
            if (!changed) return
            owners.isNotEmpty()
        }
        applyAwakeState(desired)
    }

    private fun applyAwakeState(desired: Boolean) {
        val activity = currentActivity
        if (activity == null) {
            // Sans activite le flag ne peut pas etre pose : on oublie la fenetre
            // precedente pour que le prochain appel reapplique l'etat au lieu de
            // se croire deja synchronise.
            synchronized(lock) {
                appliedActive = desired
                appliedWindow = null
            }
            return
        }
        activity.runOnUiThread {
            val currentWindow = activity.window
            synchronized(lock) {
                if (invalidated) return@runOnUiThread
                if (appliedActive == desired && appliedWindow === currentWindow) {
                    return@runOnUiThread
                }
                appliedActive = desired
                appliedWindow = currentWindow
            }
            setWindowFlag(currentWindow, desired)
        }
    }

    companion object {
        internal const val LOCAL_PLAYBACK_OWNER = "local-playback"
        internal val ALLOWED_OWNERS = setOf(LOCAL_PLAYBACK_OWNER, "pip", "cast")
        private val ownerPattern = Regex("^[a-z0-9-]{1,32}$")

        internal fun setWindowFlag(window: Window, active: Boolean) {
            if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else clearWindowFlag(window)
        }

        internal fun clearWindowFlag(window: Window) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        fun clearActivityFlag(activity: Activity) = clearWindowFlag(activity.window)
    }
}
