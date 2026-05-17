package com.movix.app.download

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistance des entries via SharedPreferences. Source de vérité native :
 * la liste des téléchargements survit aux redémarrages du process et à un
 * rechargement complet du WebView.
 *
 * La couche JS conserve sa propre copie pour l'affichage immédiat ; elle
 * resync via `list()` à l'ouverture de la page Downloads.
 */
class DownloadStore(context: Context) {

    private val prefs: SharedPreferences = context.applicationContext
        .getSharedPreferences("movix_downloads", Context.MODE_PRIVATE)

    @Synchronized
    fun all(): List<DownloadEntry> {
        val raw = prefs.getString(KEY_ENTRIES, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                runCatching { DownloadEntry.fromJson(arr.getJSONObject(i)) }.getOrNull()
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun get(id: String): DownloadEntry? = all().firstOrNull { it.id == id }

    @Synchronized
    fun upsert(entry: DownloadEntry) {
        val list = all().toMutableList()
        val idx = list.indexOfFirst { it.id == entry.id }
        if (idx >= 0) list[idx] = entry else list.add(entry)
        persist(list)
    }

    @Synchronized
    fun remove(id: String) {
        val list = all().toMutableList()
        list.removeAll { it.id == id }
        persist(list)
    }

    private fun persist(list: List<DownloadEntry>) {
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        prefs.edit().putString(KEY_ENTRIES, arr.toString()).apply()
    }

    companion object {
        private const val KEY_ENTRIES = "entries"
    }
}
