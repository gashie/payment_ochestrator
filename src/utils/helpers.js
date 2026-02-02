const crypto = require('crypto');

/**
 * Format timestamp to YYMMDDHHMMSS format
 */
const formatDateTime = (date = new Date()) => {
    const d = date instanceof Date ? date : new Date(date);
    const year = String(d.getFullYear()).slice(-2);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

/**
 * Parse YYMMDDHHMMSS format to Date
 */
const parseDateTime = (dateStr) => {
    if (!dateStr || dateStr.length !== 12) return null;
    const year = 2000 + parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1;
    const day = parseInt(dateStr.substring(4, 6));
    const hours = parseInt(dateStr.substring(6, 8));
    const minutes = parseInt(dateStr.substring(8, 10));
    const seconds = parseInt(dateStr.substring(10, 12));
    return new Date(year, month, day, hours, minutes, seconds);
};

/**
 * Format amount to specified length with leading zeros
 */
const formatAmount = (amount, length = 12) => {
    const numAmount = Math.round(parseFloat(amount) * 100);
    return String(numAmount).padStart(length, '0');
};

/**
 * Parse formatted amount string to number
 */
const parseAmount = (amountStr) => {
    return parseInt(amountStr, 10) / 100;
};

/**
 * Deep clone an object
 */
const deepClone = (obj) => {
    return JSON.parse(JSON.stringify(obj));
};

/**
 * Safely parse JSON
 */
const safeJsonParse = (str, defaultValue = null) => {
    try {
        return typeof str === 'string' ? JSON.parse(str) : str;
    } catch {
        return defaultValue;
    }
};

/**
 * Generate unique ID
 */
const generateUniqueId = (prefix = '') => {
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomBytes(4).toString('hex');
    return prefix ? `${prefix}_${timestamp}${randomPart}` : `${timestamp}${randomPart}`;
};

/**
 * Retry function with exponential backoff
 */
const retry = async (fn, options = {}) => {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 30000,
        onRetry = null
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;

            if (attempt === maxRetries) {
                throw error;
            }

            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            
            if (onRetry) {
                onRetry(error, attempt, delay);
            }

            await sleep(delay);
        }
    }

    throw lastError;
};

/**
 * Sleep for specified milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Evaluate a condition expression against data
 */
const evaluateCondition = (condition, data) => {
    if (!condition) return true;
    
    try {
        const conditionObj = typeof condition === 'string' ? JSON.parse(condition) : condition;
        
        // Simple condition: { field: value } or { field: { operator: value } }
        for (const [field, expected] of Object.entries(conditionObj)) {
            const actualValue = getNestedValue(data, field);
            
            if (typeof expected === 'object' && expected !== null) {
                // Complex condition with operator
                for (const [operator, value] of Object.entries(expected)) {
                    if (!evaluateOperator(actualValue, operator, value)) {
                        return false;
                    }
                }
            } else {
                // Simple equality check
                if (actualValue !== expected) {
                    return false;
                }
            }
        }
        
        return true;
    } catch (error) {
        return false;
    }
};

/**
 * Evaluate operator
 */
const evaluateOperator = (actual, operator, expected) => {
    switch (operator) {
        case '$eq': return actual === expected;
        case '$ne': return actual !== expected;
        case '$gt': return actual > expected;
        case '$gte': return actual >= expected;
        case '$lt': return actual < expected;
        case '$lte': return actual <= expected;
        case '$in': return Array.isArray(expected) && expected.includes(actual);
        case '$nin': return Array.isArray(expected) && !expected.includes(actual);
        case '$exists': return expected ? actual !== undefined : actual === undefined;
        case '$regex': return new RegExp(expected).test(actual);
        case '$startsWith': return typeof actual === 'string' && actual.startsWith(expected);
        case '$endsWith': return typeof actual === 'string' && actual.endsWith(expected);
        case '$contains': return typeof actual === 'string' && actual.includes(expected);
        default: return actual === expected;
    }
};

/**
 * Get nested value from object using dot notation
 */
const getNestedValue = (obj, path) => {
    if (!obj || !path) return undefined;
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
        if (value === null || value === undefined) return undefined;
        value = value[key];
    }
    return value;
};

/**
 * Set nested value in object using dot notation
 */
const setNestedValue = (obj, path, value) => {
    if (!obj || !path) return;
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!current[key] || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
};

/**
 * Apply field mappings to transform data
 */
const applyFieldMappings = (data, mappings, swapConfig = null) => {
    const result = {};

    for (const mapping of mappings) {
        // Support both naming conventions (source/target and source_field/target_field)
        const source_field = mapping.source_field || mapping.source;
        const target_field = mapping.target_field || mapping.target;
        const transform_type = mapping.transform_type || mapping.transform;
        const default_value = mapping.default_value;

        let value;

        // Handle null/undefined source - for generated fields like dateTime
        if (source_field === null || source_field === undefined) {
            // If there's a transform that generates values, pass null to trigger generation
            if (transform_type === 'formatDateTime' || transform_type === 'toDateTime') {
                value = applyTransformation(null, transform_type, mapping.transform_config);
            } else if (default_value !== undefined) {
                value = default_value;
            }
        } else {
            value = getNestedValue(data, source_field);

            // Apply swap if configured
            if (swapConfig && swapConfig[source_field]) {
                const swapField = swapConfig[source_field];
                value = getNestedValue(data, swapField);
            }

            // Apply default if value is undefined
            if (value === undefined && default_value !== undefined) {
                value = default_value;
            }

            // Apply transformation
            if (transform_type && value !== undefined) {
                value = applyTransformation(value, transform_type, mapping.transform_config);
            }
        }

        if (value !== undefined) {
            setNestedValue(result, target_field, value);
        }
    }

    return result;
};

/**
 * Apply transformation to a value
 */
const applyTransformation = (value, transformType, config = {}) => {
    switch (transformType) {
        case 'uppercase':
            return String(value).toUpperCase();
        case 'lowercase':
            return String(value).toLowerCase();
        case 'trim':
            return String(value).trim();
        case 'padStart':
            return String(value).padStart(config.length || 12, config.char || '0');
        case 'padEnd':
            return String(value).padEnd(config.length || 12, config.char || '0');
        case 'substring':
            return String(value).substring(config.start || 0, config.end);
        case 'replace':
            return String(value).replace(new RegExp(config.pattern, 'g'), config.replacement || '');
        case 'toNumber':
            return parseFloat(value) || 0;
        case 'toString':
            return String(value);
        case 'toAmount':
        case 'formatAmount':
            // Format amount: 1000 → "000000100000" (12 digits, value * 100)
            return formatAmount(value, config.length || 12);
        case 'fromAmount':
            return parseAmount(value);
        case 'toDateTime':
        case 'formatDateTime':
            // Generate current datetime in YYMMDDhhmmss format
            return formatDateTime(value ? new Date(value) : new Date());
        case 'default':
            return value === undefined || value === null ? config.defaultValue : value;
        default:
            return value;
    }
};

/**
 * Mask sensitive data in object
 */
const maskSensitiveData = (obj, sensitiveFields = []) => {
    const defaultSensitive = ['password', 'apiKey', 'secret', 'token', 'authorization'];
    const allSensitive = [...defaultSensitive, ...sensitiveFields];
    
    const mask = (data) => {
        if (!data || typeof data !== 'object') return data;
        
        const result = Array.isArray(data) ? [...data] : { ...data };
        
        for (const key of Object.keys(result)) {
            if (allSensitive.some(s => key.toLowerCase().includes(s.toLowerCase()))) {
                result[key] = '***MASKED***';
            } else if (typeof result[key] === 'object') {
                result[key] = mask(result[key]);
            }
        }
        
        return result;
    };
    
    return mask(obj);
};

/**
 * Calculate hash of object for comparison
 */
const calculateHash = (obj) => {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.createHash('sha256').update(str).digest('hex');
};

/**
 * Response code mappings
 */
const RESPONSE_CODES = {
    SUCCESS: '000',
    PENDING: '001',
    NOT_FOUND: '381',
    VALIDATION_ERROR: '999',
    SYSTEM_ERROR: '909',
    TIMEOUT: '912',
    INDETERMINATE: '990'
};

/**
 * Check if response code indicates TSQ should be triggered
 */
const shouldTriggerTsq = (actionCode) => {
    const tsqTriggerCodes = ['909', '912', '990', '108'];
    return !actionCode || 
           tsqTriggerCodes.includes(actionCode) || 
           (actionCode.startsWith('9') && actionCode !== '999');
};

/**
 * Check if response indicates success
 */
const isSuccessResponse = (actionCode) => {
    return actionCode === '000';
};

/**
 * Check if response indicates pending
 */
const isPendingResponse = (actionCode) => {
    return actionCode === '001' || actionCode === '990';
};

module.exports = {
    formatDateTime,
    parseDateTime,
    formatAmount,
    parseAmount,
    deepClone,
    safeJsonParse,
    generateUniqueId,
    retry,
    sleep,
    evaluateCondition,
    evaluateOperator,
    getNestedValue,
    setNestedValue,
    applyFieldMappings,
    applyTransformation,
    maskSensitiveData,
    calculateHash,
    RESPONSE_CODES,
    shouldTriggerTsq,
    isSuccessResponse,
    isPendingResponse
};
