/**
 * Session management routes.
 * Extracted from server.js -- user session listing and deletion.
 * Mount point: app.use('/api/sessions', router)
 */

const express = require('express');
const router = express.Router();

const { getAuthIfValid } = require('../middleware/auth');
const { getPool } = require('../mysqlPool');
const { getSessionDeviceInfo, parseStoredSessionDeviceInfo } = require('../utils/sessionDeviceInfo');

// === Routes ===

// GET / - Get user sessions (JWT required, MySQL)
router.get('/', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { userType, userId } = auth;

    // Only allow sessions for oauth, bip39 users
    if (!['oauth', 'bip39'].includes(userType)) {
      return res.status(400).json({ success: false, error: 'Type d\'utilisateur non supporté pour les sessions' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible' });
    }

    // Get sessions from MySQL
    const [rows] = await pool.execute(
      'SELECT id, device, user_agent as userAgent, created_at as createdAt, accessed_at as accessedAt FROM user_sessions WHERE user_id = ? AND user_type = ? ORDER BY accessed_at DESC',
      [userId, userType]
    );

    const sessions = rows.map(row => ({
      id: row.id,
      userId: userId,
      userAgent: row.userAgent,
      deviceInfo: parseStoredSessionDeviceInfo(row.device) || getSessionDeviceInfo({ userAgent: row.userAgent }),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      accessedAt: row.accessedAt ? new Date(row.accessedAt).toISOString() : null
    }));

    res.status(200).json({ success: true, data: { count: sessions.length, items: sessions } });
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération des sessions' });
  }
});

// POST /delete - Delete a specific session (JWT required; user can only delete own session, MySQL)
router.post('/delete', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { userType, userId } = auth;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'ID de session requis' });
    }

    if (!['oauth', 'bip39'].includes(userType)) {
      return res.status(400).json({ success: false, error: 'Type d\'utilisateur non supporté pour les sessions' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible' });
    }

    // Delete session from MySQL
    const [result] = await pool.execute(
      'DELETE FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Session non trouvée' });
    }

    res.status(200).json({ success: true, message: 'Session supprimée avec succès' });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la suppression de la session' });
  }
});

module.exports = router;
