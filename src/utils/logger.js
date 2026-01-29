const winston = require('winston');
const path = require('path');

const logLevel = process.env.LOG_LEVEL || 'info';

// Color definitions for different log levels and components
const colors = {
    timestamp: '\x1b[36m',    // Cyan
    info: '\x1b[32m',         // Green
    warn: '\x1b[33m',         // Yellow
    error: '\x1b[31m',        // Red
    debug: '\x1b[35m',        // Magenta
    trace: '\x1b[90m',        // Dark Gray
    reset: '\x1b[0m',         // Reset
    bold: '\x1b[1m',          // Bold
    dim: '\x1b[2m',           // Dim
    request: '\x1b[34m',      // Blue
    response: '\x1b[32m',     // Green
    database: '\x1b[36m',     // Cyan
    job: '\x1b[33m',          // Yellow
    service: '\x1b[35m',      // Magenta
};

const customFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, requestId, component, type, ...meta }) => {
        const colorCode = colors[level] || colors.info;
        const resetCode = colors.reset;
        
        // Build the log prefix
        let prefix = `${colors.timestamp}[${timestamp}]${resetCode}`;
        
        // Add component indicator
        if (component) {
            const componentColor = colors[component] || colors.info;
            prefix += ` ${componentColor}[${component.toUpperCase()}]${resetCode}`;
        } else {
            prefix += ` ${colors.info}[ORCHESTRATOR]${resetCode}`;
        }
        
        // Add request ID if present
        if (requestId) {
            prefix += ` ${colors.dim}[${requestId}]${resetCode}`;
        }
        
        // Add log level with color
        prefix += ` ${colorCode}${level.toUpperCase()}${resetCode}`;
        
        // Add type indicator if present (REQUEST, RESPONSE, ERROR, etc.)
        if (type) {
            let typeColor = colors.info;
            if (type === 'REQUEST' || type === 'INCOMING') typeColor = colors.request;
            if (type === 'RESPONSE' || type === 'OUTGOING') typeColor = colors.response;
            if (type === 'ERROR') typeColor = colors.error;
            if (type === 'DATABASE') typeColor = colors.database;
            if (type === 'JOB') typeColor = colors.job;
            
            prefix += ` ${typeColor}[${type}]${resetCode}`;
        }
        
        // Build metadata string
        let metaStr = '';
        if (Object.keys(meta).length > 0) {
            metaStr = ' ' + JSON.stringify(meta);
        }
        
        return `${prefix} ${colors.bold}${message}${resetCode}${metaStr}`;
    })
);

const logger = winston.createLogger({
    level: logLevel,
    format: customFormat,
    transports: [
        new winston.transports.Console({
            format: customFormat
        })
    ]
});

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
    // Plain format for files (without colors)
    const plainFormat = winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, requestId, component, type, ...meta }) => {
            let prefix = `[${timestamp}]`;
            if (component) prefix += ` [${component.toUpperCase()}]`;
            else prefix += ` [ORCHESTRATOR]`;
            if (requestId) prefix += ` [${requestId}]`;
            prefix += ` ${level.toUpperCase()}`;
            if (type) prefix += ` [${type}]`;
            
            let metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${prefix} ${message}${metaStr}`;
        })
    );
    
    logger.add(new winston.transports.File({
        filename: path.join(process.env.LOG_PATH || './logs', 'orchestrator-error.log'),
        level: 'error',
        format: plainFormat,
        maxsize: 10485760, // 10MB
        maxFiles: 5
    }));
    logger.add(new winston.transports.File({
        filename: path.join(process.env.LOG_PATH || './logs', 'orchestrator-combined.log'),
        format: plainFormat,
        maxsize: 10485760,
        maxFiles: 10
    }));
}

// Logger instance with helper methods
class Logger {
    constructor() {
        this.baseLogger = logger;
    }

    // HTTP Request/Response logging
    incoming(method, path, query = {}, requestId = '') {
        const queryObj = query && typeof query === 'object' ? query : {};
        this.baseLogger.info(`${method.toUpperCase()} ${path}`, {
            requestId,
            component: 'http',
            type: 'REQUEST',
            method,
            path,
            query: Object.keys(queryObj).length ? queryObj : undefined
        });
    }

    response(statusCode, message = '', responseTime = 0, requestId = '') {
        const status = statusCode >= 400 ? 'error' : 'info';
        const logFn = this.baseLogger[status] || this.baseLogger.info;
        logFn(`HTTP ${statusCode} ${message}`, {
            requestId,
            component: 'http',
            type: 'RESPONSE',
            statusCode,
            responseTimeMs: responseTime
        });
    }

    // Database operations
    database(operation, table, details = {}, requestId = '') {
        this.baseLogger.debug(`${operation} on ${table}`, {
            requestId,
            component: 'database',
            type: 'DATABASE',
            operation,
            table,
            ...details
        });
    }

    // Service layer
    service(serviceName, action, details = {}, requestId = '') {
        this.baseLogger.info(`${serviceName}.${action}`, {
            requestId,
            component: 'service',
            type: 'SERVICE',
            service: serviceName,
            action,
            ...details
        });
    }

    // Background jobs
    job(jobName, action, details = {}) {
        this.baseLogger.info(`${jobName} - ${action}`, {
            component: 'job',
            type: 'JOB',
            job: jobName,
            action,
            ...details
        });
    }

    // Flow execution
    flow(action, details = {}, requestId = '') {
        this.baseLogger.info(`Flow: ${action}`, {
            requestId,
            component: 'flow',
            type: 'EXECUTION',
            ...details
        });
    }

    // Callback tracking
    callback(action, details = {}, requestId = '') {
        this.baseLogger.info(`Callback: ${action}`, {
            requestId,
            component: 'callback',
            type: 'CALLBACK',
            ...details
        });
    }

    // TSQ tracking
    tsq(action, details = {}, requestId = '') {
        this.baseLogger.info(`TSQ: ${action}`, {
            requestId,
            component: 'tsq',
            type: 'TSQ',
            ...details
        });
    }

    // Generic info, warn, error
    info(message, meta = {}) {
        this.baseLogger.info(message, meta);
    }

    warn(message, meta = {}) {
        this.baseLogger.warn(message, meta);
    }

    error(message, error, meta = {}) {
        const errorMeta = {
            ...meta,
            error: error?.message || error,
            ...(error?.stack && { stack: error.stack })
        };
        this.baseLogger.error(message, errorMeta);
    }

    debug(message, meta = {}) {
        this.baseLogger.debug(message, meta);
    }
}

module.exports = new Logger();
