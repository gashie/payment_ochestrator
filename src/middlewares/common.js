/**
 * Common Middlewares for Orchestrator Service
 */

const logger = require('../utils/logger');
const { auditLogsModel } = require('../models');
const { v4: uuidv4 } = require('uuid');

/**
 * Request logging middleware
 */
const requestLogger = (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    const startTime = Date.now();

    // Log request
    logger.info('Incoming request', {
        requestId,
        method: req.method,
        path: req.path,
        query: req.query,
        ip: req.ip || req.connection.remoteAddress
    });

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        logger.info('Request completed', {
            requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration}ms`
        });
    });

    next();
};

/**
 * Audit logging middleware
 */
const auditLogger = (action) => {
    return async (req, res, next) => {
        // Store original json method
        const originalJson = res.json.bind(res);
        
        res.json = async (data) => {
            try {
                // Log audit entry
                await auditLogsModel.create({
                    user_id: req.user?.id || null,
                    action,
                    resource_type: req.baseUrl.split('/').pop() || 'unknown',
                    resource_id: req.params.id || null,
                    ip_address: req.ip || req.connection.remoteAddress,
                    user_agent: req.headers['user-agent'],
                    request_body: JSON.stringify(sanitizeForAudit(req.body)),
                    response_status: res.statusCode,
                    request_id: req.requestId
                });
            } catch (error) {
                logger.error('Audit log failed', { error: error.message });
            }
            
            return originalJson(data);
        };

        next();
    };
};

/**
 * Sanitize sensitive data for audit logs
 */
const sanitizeForAudit = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    const sensitiveFields = ['password', 'secret', 'token', 'api_key', 'apiKey'];
    const sanitized = { ...obj };
    
    for (const key of Object.keys(sanitized)) {
        if (sensitiveFields.some(f => key.toLowerCase().includes(f))) {
            sanitized[key] = '***REDACTED***';
        } else if (typeof sanitized[key] === 'object') {
            sanitized[key] = sanitizeForAudit(sanitized[key]);
        }
    }
    
    return sanitized;
};

/**
 * Error handling middleware
 */
const errorHandler = (err, req, res, next) => {
    logger.error('Unhandled error', {
        requestId: req.requestId,
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path
    });

    const statusCode = err.statusCode || err.status || 500;
    const isProduction = process.env.NODE_ENV === 'production';

    res.status(statusCode).json({
        success: false,
        error: isProduction ? 'Internal server error' : err.message,
        requestId: req.requestId,
        ...(isProduction ? {} : { stack: err.stack })
    });
};

/**
 * Not found handler
 */
const notFoundHandler = (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Route ${req.method} ${req.originalUrl} not found`,
        requestId: req.requestId
    });
};

/**
 * Rate limiting middleware (simple in-memory implementation)
 */
const rateLimits = new Map();

const rateLimit = (options = {}) => {
    const windowMs = options.windowMs || 60000; // 1 minute
    const maxRequests = options.maxRequests || 100;
    const keyGenerator = options.keyGenerator || ((req) => req.ip);

    return (req, res, next) => {
        const key = keyGenerator(req);
        const now = Date.now();
        
        if (!rateLimits.has(key)) {
            rateLimits.set(key, { count: 1, resetTime: now + windowMs });
            return next();
        }

        const limit = rateLimits.get(key);

        if (now > limit.resetTime) {
            rateLimits.set(key, { count: 1, resetTime: now + windowMs });
            return next();
        }

        limit.count++;

        if (limit.count > maxRequests) {
            res.setHeader('X-RateLimit-Limit', maxRequests);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', Math.ceil(limit.resetTime / 1000));
            
            return res.status(429).json({
                success: false,
                error: 'Too many requests',
                retryAfter: Math.ceil((limit.resetTime - now) / 1000)
            });
        }

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', maxRequests - limit.count);
        res.setHeader('X-RateLimit-Reset', Math.ceil(limit.resetTime / 1000));
        
        next();
    };
};

// Clean up expired rate limits periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimits.entries()) {
        if (now > value.resetTime) {
            rateLimits.delete(key);
        }
    }
}, 60000);

/**
 * Validate request body against schema
 */
const validateBody = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(d => ({
                field: d.path.join('.'),
                message: d.message
            }));
            
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors
            });
        }

        req.body = value;
        next();
    };
};

/**
 * Validate query parameters against schema
 */
const validateQuery = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.query, {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(d => ({
                field: d.path.join('.'),
                message: d.message
            }));
            
            return res.status(400).json({
                success: false,
                error: 'Invalid query parameters',
                details: errors
            });
        }

        req.query = value;
        next();
    };
};

/**
 * Async handler wrapper
 */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

module.exports = {
    requestLogger,
    auditLogger,
    errorHandler,
    notFoundHandler,
    rateLimit,
    validateBody,
    validateQuery,
    asyncHandler,
    sanitizeForAudit
};
