/**
 * Orchestrator Service - Main Application Entry Point
 * Dynamic workflow orchestration engine for payment processing
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const routes = require('./routes');
const logger = require('./utils/logger');
const pool = require('./config/database');
const jobs = require('./jobs');

const app = express();

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
// When credentials: true, origin cannot be '*', must be specific origins
const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            logger.warn('CORS blocked request from origin:', { origin });
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Session-ID'],
    credentials: true
}));

// Compression
app.use(compression());

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request ID middleware (must be first)
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || require('uuid').v4();
    res.setHeader('X-Request-ID', req.requestId);
    next();
});

// Request timing and logging middleware
app.use((req, res, next) => {
    req.startTime = Date.now();
    
    // Log incoming request
    const queryObj = req.query && Object.keys(req.query).length ? req.query : null;
    logger.incoming(req.method, req.path, queryObj, req.requestId);
    
    // Log request body for POST/PUT/PATCH (excluding sensitive fields)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
        const bodyLog = { ...req.body };
        // Mask sensitive fields
        ['password', 'token', 'apiKey', 'secret', 'pin'].forEach(field => {
            if (bodyLog[field]) bodyLog[field] = '***REDACTED***';
        });
        logger.debug('Request body', {
            requestId: req.requestId,
            body: bodyLog
        });
    }
    
    // Intercept response to log it
    const originalJson = res.json.bind(res);
    res.json = function(data) {
        const duration = Date.now() - req.startTime;
        const statusCode = res.statusCode;
        
        // Log response
        logger.response(statusCode, 
            statusCode >= 400 ? 'ERROR' : 'SUCCESS', 
            duration, 
            req.requestId
        );
        
        // Log response body if not success (for debugging)
        if (statusCode >= 400) {
            logger.debug('Response error details', {
                requestId: req.requestId,
                response: data
            });
        }
        
        return originalJson(data);
    };
    
    next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        logger.database('QUERY', 'ping', { requestId: req.requestId });
        res.json({
            status: 'healthy',
            service: 'orchestrator',
            version: process.env.npm_package_version || '1.0.0',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    } catch (error) {
        logger.error('Health check failed', error, { requestId: req.requestId });
        res.status(503).json({
            status: 'unhealthy',
            service: 'orchestrator',
            error: error.message
        });
    }
});

// Readiness check
app.get('/ready', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        logger.database('QUERY', 'ping', { requestId: req.requestId });
        res.json({ ready: true, timestamp: new Date().toISOString() });
    } catch (error) {
        logger.error('Readiness check failed', error, { requestId: req.requestId });
        res.status(503).json({ ready: false, error: error.message });
    }
});

// Metrics endpoint (basic)
app.get('/metrics', (req, res) => {
    logger.info('Metrics requested', { requestId: req.requestId });
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        timestamp: new Date().toISOString()
    });
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use((req, res) => {
    logger.warn(`Route not found: ${req.method} ${req.originalUrl}`, {
        requestId: req.requestId
    });
    res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Route ${req.method} ${req.originalUrl} not found`,
        requestId: req.requestId
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    const duration = Date.now() - (req.startTime || Date.now());
    const requestId = req.requestId || 'unknown';
    
    // Log error with full context
    logger.error(`${err.status || 500} - ${err.message}`, err, {
        requestId,
        method: req.method,
        url: req.originalUrl,
        statusCode: err.status || 500,
        responseTimeMs: duration
    });

    // Don't leak error details in production
    const isProduction = process.env.NODE_ENV === 'production';
    
    res.status(err.status || 500).json({
        success: false,
        error: isProduction ? 'Internal Server Error' : err.message,
        requestId,
        ...(isProduction ? {} : { stack: err.stack })
    });
});

// Server initialization
const PORT = process.env.PORT || 3002;
let server;

const startServer = async () => {
    try {
        // Test database connection
        await pool.query('SELECT 1');
        logger.info('✓ Database connection established');

        // Start background jobs
        jobs.initializeJobs();
        logger.job('System', 'Jobs initialized', { status: 'success' });

        // Start HTTP server
        server = app.listen(PORT, () => {
            logger.info('✓ Orchestrator service started', {
                port: PORT,
                environment: process.env.NODE_ENV || 'development',
                nodeVersion: process.version,
                uptime: 0
            });
        });

        // Handle server errors
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                logger.error(`Port ${PORT} is already in use`, error, {
                    port: PORT,
                    code: 'EADDRINUSE'
                });
                process.exit(1);
            }
            throw error;
        });

    } catch (error) {
        logger.error('✗ Failed to start server', error, {
            phase: 'startup'
        });
        process.exit(1);
    }
};

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received, starting graceful shutdown`);

    // Stop accepting new requests
    if (server) {
        server.close(async () => {
            logger.info('HTTP server closed');

            try {
                // Stop background jobs
                jobs.stop();
                logger.info('Background jobs stopped');

                // Close database pool
                await pool.end();
                logger.info('Database connections closed');

                logger.info('Graceful shutdown completed');
                process.exit(0);
            } catch (error) {
                logger.error('Error during shutdown', { error: error.message });
                process.exit(1);
            }
        });

        // Force shutdown after timeout
        setTimeout(() => {
            logger.error('Forced shutdown due to timeout');
            process.exit(1);
        }, 30000);
    }
};

// Process signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', { reason, promise });
});

// Start the server
startServer();

module.exports = app;
