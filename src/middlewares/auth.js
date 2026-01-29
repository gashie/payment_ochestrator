/**
 * Authentication Middleware for Orchestrator Service
 */

const jwt = require('jsonwebtoken');
const { usersModel, rolesModel } = require('../models');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret';

/**
 * Verify JWT token
 */
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Authorization header missing or invalid'
            });
        }

        const token = authHeader.substring(7);

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Fetch user
            const user = await usersModel.findById(decoded.userId);
            
            if (!user) {
                return res.status(401).json({
                    success: false,
                    error: 'User not found'
                });
            }

            if (!user.is_active) {
                return res.status(401).json({
                    success: false,
                    error: 'User account is deactivated'
                });
            }

            // Fetch role
            const role = await rolesModel.findById(user.role_id);
            
            req.user = {
                id: user.id,
                username: user.username,
                email: user.email,
                roleId: user.role_id,
                roleName: role?.name,
                permissions: role ? JSON.parse(role.permissions || '[]') : []
            };

            next();
        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    error: 'Token expired'
                });
            }
            return res.status(401).json({
                success: false,
                error: 'Invalid token'
            });
        }
    } catch (error) {
        logger.error('Token verification error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Authentication error'
        });
    }
};

/**
 * Check if user has specific permission
 */
const requirePermission = (...requiredPermissions) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }

        const userPermissions = req.user.permissions || [];
        
        // Super admin has all permissions
        if (userPermissions.includes('*')) {
            return next();
        }

        // Check if user has at least one of the required permissions
        const hasPermission = requiredPermissions.some(perm => {
            // Check exact match
            if (userPermissions.includes(perm)) return true;
            
            // Check wildcard (e.g., "flows:*" matches "flows:read")
            const [resource, action] = perm.split(':');
            return userPermissions.includes(`${resource}:*`);
        });

        if (!hasPermission) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions',
                required: requiredPermissions
            });
        }

        next();
    };
};

/**
 * Verify internal service API key
 * Used for BFS → Orchestrator communication
 */
const verifyServiceKey = (req, res, next) => {
    const apiKey = req.headers['x-service-key'] || req.headers['x-api-key'];
    const expectedKey = process.env.BFS_API_KEY || 'bfs-internal-api-key';

    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'Service API key required'
        });
    }

    if (apiKey !== expectedKey) {
        return res.status(401).json({
            success: false,
            error: 'Invalid service API key'
        });
    }

    req.isInternalService = true;
    next();
};

/**
 * Optional authentication - sets user if token provided, continues if not
 */
const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
    }

    try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await usersModel.findById(decoded.userId);
        
        if (user && user.is_active) {
            const role = await rolesModel.findById(user.role_id);
            req.user = {
                id: user.id,
                username: user.username,
                email: user.email,
                roleId: user.role_id,
                roleName: role?.name,
                permissions: role ? JSON.parse(role.permissions || '[]') : []
            };
        }
    } catch (error) {
        // Ignore auth errors for optional auth
    }
    
    next();
};

/**
 * Combined auth - accepts either JWT or service key
 */
const verifyAuth = async (req, res, next) => {
    const serviceKey = req.headers['x-service-key'] || req.headers['x-api-key'];
    const authHeader = req.headers.authorization;

    // Try service key first (for internal communication)
    if (serviceKey) {
        const expectedKey = process.env.BFS_API_KEY || 'bfs-internal-api-key';
        if (serviceKey === expectedKey) {
            req.isInternalService = true;
            return next();
        }
    }

    // Try JWT token
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return verifyToken(req, res, next);
    }

    return res.status(401).json({
        success: false,
        error: 'Authentication required (JWT token or service key)'
    });
};

module.exports = {
    verifyToken,
    requirePermission,
    verifyServiceKey,
    optionalAuth,
    verifyAuth
};
