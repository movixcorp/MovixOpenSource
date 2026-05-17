package com.movix.app.download

import org.json.JSONObject

/**
 * Snapshot persistant d'un téléchargement géré par le module.
 *
 * `metadataJson` est opaque pour le code natif : la couche JS y stocke ce
 * qu'elle veut (type, tmdbId, titre, poster, saison, épisode, ...) et le
 * relit pour reconstruire la page Downloads.
 *
 * `headersJson` est une JSON map<string, string> de headers HTTP à envoyer
 * sur la requête (auth, referer, etc.).
 */
data class DownloadEntry(
    val id: String,
    val url: String,
    val filename: String,
    val targetPath: String,
    var totalBytes: Long,
    var downloadedBytes: Long,
    var status: String,
    var errorMessage: String?,
    val createdAt: Long,
    var updatedAt: Long,
    val metadataJson: String,
    val headersJson: String,
) {
    fun toJson(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("url", url)
            put("filename", filename)
            put("targetPath", targetPath)
            put("totalBytes", totalBytes)
            put("downloadedBytes", downloadedBytes)
            put("status", status)
            put("errorMessage", errorMessage ?: JSONObject.NULL)
            put("createdAt", createdAt)
            put("updatedAt", updatedAt)
            put("metadata", if (metadataJson.isBlank()) JSONObject() else JSONObject(metadataJson))
            put("headers", if (headersJson.isBlank()) JSONObject() else JSONObject(headersJson))
        }
    }

    companion object {
        const val STATUS_QUEUED = "queued"
        const val STATUS_RUNNING = "running"
        const val STATUS_PAUSED = "paused"
        const val STATUS_DONE = "done"
        const val STATUS_FAILED = "failed"
        const val STATUS_CANCELLED = "cancelled"

        fun fromJson(obj: JSONObject): DownloadEntry {
            return DownloadEntry(
                id = obj.getString("id"),
                url = obj.getString("url"),
                filename = obj.getString("filename"),
                targetPath = obj.getString("targetPath"),
                totalBytes = obj.optLong("totalBytes", -1L),
                downloadedBytes = obj.optLong("downloadedBytes", 0L),
                status = obj.optString("status", STATUS_QUEUED),
                errorMessage = if (obj.isNull("errorMessage")) null else obj.optString("errorMessage", null),
                createdAt = obj.optLong("createdAt", System.currentTimeMillis()),
                updatedAt = obj.optLong("updatedAt", System.currentTimeMillis()),
                metadataJson = obj.optJSONObject("metadata")?.toString() ?: "{}",
                headersJson = obj.optJSONObject("headers")?.toString() ?: "{}",
            )
        }
    }
}
