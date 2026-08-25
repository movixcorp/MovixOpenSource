-- ============================================
-- Movix Wrapped 2026 - Database Tables
-- ============================================
-- Run this SQL file to create the required tables for Movix Wrapped data collection.
-- These tables store viewing data and page visit statistics for the annual Wrapped summary.
-- ============================================

-- ---------------------------------------------
-- Table: wrapped_viewing_data
-- Stores viewing time for movies, TV shows, anime, and live TV
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS wrapped_viewing_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255),
    content_type ENUM('movie', 'tv', 'anime', 'live-tv') NOT NULL,
    content_id VARCHAR(255) NOT NULL,
    content_title VARCHAR(255),
    season_number INT DEFAULT NULL,
    episode_number INT DEFAULT NULL,
    watch_duration INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    hour_of_day TINYINT DEFAULT NULL,
    month INT NOT NULL,
    year INT NOT NULL,
    INDEX idx_user_year (user_id, year),
    INDEX idx_content (content_type, content_id),
    INDEX idx_user_profile (user_id, profile_id),
    INDEX idx_hour (user_id, year, hour_of_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------
-- Table: wrapped_pages_data
-- Stores page visit duration and statistics
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS wrapped_pages_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255),
    page_name VARCHAR(100) NOT NULL,
    content_id VARCHAR(255) DEFAULT NULL,  -- TMDB ID for detail pages (movie-details, tv-details)
    duration INT DEFAULT 0,
    meta_data JSON,
    month INT NOT NULL,
    year INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_page_stats (user_id, page_name, year),
    INDEX idx_user_profile (user_id, profile_id),
    INDEX idx_content_page (page_name, content_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Summary of tracked data:
-- ============================================
-- 
-- wrapped_viewing_data:
--   - Viewing time for movies, TV shows, anime, live TV
--   - Tracks: content_id, content_type, season/episode for TV/anime
--   - Used to calculate: most watched content, total watch time, genre preferences
--
-- wrapped_pages_data:
--   - Page visit duration
--   - content_id for detail pages (movie-details, tv-details)
--   - Tracks: home, movies, tv-shows, movie-details, tv-details, watchparty, live-tv, wishboard
--   - Used to calculate: browsing habits, feature usage, engagement metrics
--
-- ============================================
