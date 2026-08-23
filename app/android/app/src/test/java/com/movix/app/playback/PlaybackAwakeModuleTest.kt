package com.movix.app.playback

import android.app.Activity
import android.os.Looper
import android.view.WindowManager
import com.facebook.react.bridge.BridgeReactContext
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PlaybackAwakeModuleTest {
    @Test
    fun `module updates are idempotent and invalidate clears the flag`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        module.setLocalPlaybackAwake(true)
        module.setLocalPlaybackAwake(true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setLocalPlaybackAwake(false)
        module.setLocalPlaybackAwake(false)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setLocalPlaybackAwake(true)
        shadowOf(Looper.getMainLooper()).idle()
        module.invalidate()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `releasing one owner keeps the other owners awake`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        module.setPlaybackAwakeOwner("local-playback", true)
        module.setPlaybackAwakeOwner("cast", true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        // La lecture locale s'arrete mais le Cast tient toujours l'ecran.
        module.setPlaybackAwakeOwner("local-playback", false)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setPlaybackAwakeOwner("cast", false)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `setLocalPlaybackAwake shares the local-playback owner slot`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        module.setPlaybackAwakeOwner("local-playback", true)
        module.setPlaybackAwakeOwner("pip", true)
        module.setLocalPlaybackAwake(false)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setPlaybackAwakeOwner("pip", false)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `invalid owners cannot change the awake state`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        for (owner in listOf("", "CAST", "relay", "cast ", "pip\n", "a".repeat(33))) {
            module.setPlaybackAwakeOwner(owner, true)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setPlaybackAwakeOwner("cast", true)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        // Un proprietaire refuse ne doit pas non plus pouvoir eteindre l'ecran.
        module.setPlaybackAwakeOwner("CAST", false)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `invalidate drops every owner`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        val reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        reactContext.onHostResume(activity)
        val module = PlaybackAwakeModule(reactContext)

        module.setPlaybackAwakeOwner("cast", true)
        module.setPlaybackAwakeOwner("pip", true)
        shadowOf(Looper.getMainLooper()).idle()
        module.invalidate()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)

        module.setPlaybackAwakeOwner("cast", true)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }

    @Test
    fun `activity cleanup clears the flag defensively`() {
        val activityController = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = activityController.get()
        val window = activity.window
        PlaybackAwakeModule.setWindowFlag(window, true)

        PlaybackAwakeModule.clearActivityFlag(activity)
        activityController.destroy()
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    }
}
