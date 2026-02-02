/**
 * Configuration Service
 * Manages system configurations with database storage and caching
 */

const { systemConfigurationsModel } = require('../models');
const logger = require('../utils/logger');

// In-memory cache for frequently accessed configs
let configCache = {};
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Get a configuration value by key
 * Checks: 1) Cache 2) Database 3) Environment variable 4) Default value
 */
const getConfig = async (key, defaultValue = null) => {
    // Check cache first (if not expired)
    if (Date.now() - cacheTimestamp < CACHE_TTL_MS && configCache[key] !== undefined) {
        return configCache[key];
    }

    try {
        // Try database
        const config = await systemConfigurationsModel.findOne({ config_key: key, is_active: true });

        if (config && config.config_value !== null) {
            // Parse based on type
            let value = config.config_value;
            if (config.config_type === 'NUMBER') {
                value = parseFloat(value);
            } else if (config.config_type === 'BOOLEAN') {
                value = value === 'true' || value === '1';
            } else if (config.config_type === 'JSON') {
                try {
                    value = JSON.parse(value);
                } catch (e) {
                    // Keep as string if parse fails
                }
            }

            configCache[key] = value;
            return value;
        }
    } catch (error) {
        logger.warn('Failed to fetch config from database', { key, error: error.message });
    }

    // Fallback to environment variable (convert key format: ORCHESTRATOR_BASE_URL)
    const envKey = key.toUpperCase().replace(/\./g, '_');
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
        configCache[key] = envValue;
        return envValue;
    }

    // Return default
    return defaultValue;
};

/**
 * Get the orchestrator base URL for callbacks
 */
const getOrchestratorBaseUrl = async () => {
    return getConfig('ORCHESTRATOR_BASE_URL', process.env.ORCHESTRATOR_BASE_URL || 'http://localhost:3002');
};

/**
 * Set a configuration value
 */
const setConfig = async (key, value, options = {}) => {
    const { configType = 'STRING', description = null, createdBy = null } = options;

    const existingConfig = await systemConfigurationsModel.findOne({ config_key: key });

    if (existingConfig) {
        await systemConfigurationsModel.update(existingConfig.id, {
            config_value: String(value),
            config_type: configType,
            description: description || existingConfig.description,
            updated_by: createdBy
        });
    } else {
        await systemConfigurationsModel.create({
            config_key: key,
            config_value: String(value),
            config_type: configType,
            description,
            created_by: createdBy
        });
    }

    // Update cache
    configCache[key] = value;

    logger.info('Configuration updated', { key, configType });
};

/**
 * Reload all configs into cache
 */
const reloadCache = async () => {
    try {
        const configs = await systemConfigurationsModel.findAll({ where: { is_active: true } });

        configCache = {};
        for (const config of configs) {
            let value = config.config_value;
            if (config.config_type === 'NUMBER') {
                value = parseFloat(value);
            } else if (config.config_type === 'BOOLEAN') {
                value = value === 'true' || value === '1';
            }
            configCache[config.config_key] = value;
        }
        cacheTimestamp = Date.now();

        logger.info('Configuration cache reloaded', { count: configs.length });
    } catch (error) {
        logger.error('Failed to reload config cache', { error: error.message });
    }
};

/**
 * Clear the config cache
 */
const clearCache = () => {
    configCache = {};
    cacheTimestamp = 0;
};

/**
 * Get all configurations (for admin UI)
 */
const getAllConfigs = async () => {
    return systemConfigurationsModel.findAll({ where: { is_active: true }, orderBy: 'config_key ASC' });
};

module.exports = {
    getConfig,
    getOrchestratorBaseUrl,
    setConfig,
    reloadCache,
    clearCache,
    getAllConfigs
};
