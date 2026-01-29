const { 
    flowInstancesModel, 
    stepExecutionsModel, 
    expectedCallbacksModel,
    tsqRequestsModel,
    reversalRequestsModel,
    jobQueueModel,
    alertHistoryModel,
    processLogsModel,
    eventLogsModel
} = require('../models');
const logger = require('../utils/logger');

/**
 * Get dashboard statistics
 */
const getDashboardStats = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Get flow instance counts by status
        const statusCountsQuery = `
            SELECT status, COUNT(*) as count
            FROM flow_instances
            WHERE created_at >= $1
            GROUP BY status
        `;
        const statusCounts = await flowInstancesModel.raw(statusCountsQuery, [today]);
        
        // Get total transactions today
        const totalTodayQuery = `
            SELECT COUNT(*) as count FROM flow_instances WHERE created_at >= $1
        `;
        const totalToday = await flowInstancesModel.raw(totalTodayQuery, [today]);
        
        // Get pending callbacks
        const pendingCallbacks = await expectedCallbacksModel.count({ status: 'PENDING' });
        
        // Get pending TSQ requests
        const pendingTsq = await tsqRequestsModel.count({ status: 'PENDING' });
        
        // Get pending reversals
        const pendingReversals = await reversalRequestsModel.count({ status: 'PENDING' });
        
        // Get job queue stats
        const jobQueueStats = await jobQueueModel.raw(`
            SELECT status, COUNT(*) as count FROM job_queue GROUP BY status
        `);
        
        // Get success rate
        const successRateQuery = `
            SELECT 
                COUNT(*) FILTER (WHERE status = 'COMPLETED') as successful,
                COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
                COUNT(*) as total
            FROM flow_instances
            WHERE created_at >= $1
        `;
        const successRate = await flowInstancesModel.raw(successRateQuery, [today]);
        
        res.json({
            success: true,
            data: {
                statusCounts: statusCounts.reduce((acc, item) => {
                    acc[item.status] = parseInt(item.count);
                    return acc;
                }, {}),
                totalToday: parseInt(totalToday[0]?.count || 0),
                pendingCallbacks,
                pendingTsq,
                pendingReversals,
                jobQueueStats: jobQueueStats.reduce((acc, item) => {
                    acc[item.status] = parseInt(item.count);
                    return acc;
                }, {}),
                successRate: {
                    successful: parseInt(successRate[0]?.successful || 0),
                    failed: parseInt(successRate[0]?.failed || 0),
                    total: parseInt(successRate[0]?.total || 0),
                    rate: successRate[0]?.total > 0 
                        ? ((successRate[0].successful / successRate[0].total) * 100).toFixed(2)
                        : '0.00'
                }
            }
        });
    } catch (error) {
        logger.error('Get dashboard stats failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get active flow instances view
 */
const getActiveFlowInstancesView = async (req, res) => {
    try {
        const query = `SELECT * FROM v_active_flow_instances`;
        const instances = await flowInstancesModel.raw(query);
        
        res.json({
            success: true,
            data: instances
        });
    } catch (error) {
        logger.error('Get active flow instances view failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get flow statistics
 */
const getFlowStatistics = async (req, res) => {
    try {
        const { startDate, endDate, flowId, eventType } = req.query;
        
        let query = `
            SELECT 
                f.id as flow_id,
                f.name as flow_name,
                et.code as event_type,
                COUNT(fi.id) as total_instances,
                COUNT(*) FILTER (WHERE fi.status = 'COMPLETED') as completed,
                COUNT(*) FILTER (WHERE fi.status = 'FAILED') as failed,
                COUNT(*) FILTER (WHERE fi.status = 'MANUAL_INTERVENTION') as manual_intervention,
                AVG(EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))) as avg_duration_seconds
            FROM flows f
            LEFT JOIN event_types et ON f.event_type_id = et.id
            LEFT JOIN flow_instances fi ON fi.flow_id = f.id
            WHERE 1=1
        `;
        const values = [];
        let paramIndex = 1;
        
        if (startDate) {
            query += ` AND fi.created_at >= $${paramIndex++}`;
            values.push(startDate);
        }
        if (endDate) {
            query += ` AND fi.created_at <= $${paramIndex++}`;
            values.push(endDate);
        }
        if (flowId) {
            query += ` AND f.id = $${paramIndex++}`;
            values.push(flowId);
        }
        if (eventType) {
            query += ` AND et.code = $${paramIndex++}`;
            values.push(eventType);
        }
        
        query += ` GROUP BY f.id, f.name, et.code ORDER BY total_instances DESC`;
        
        const stats = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('Get flow statistics failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get pending callbacks view
 */
const getPendingCallbacksView = async (req, res) => {
    try {
        const query = `SELECT * FROM v_pending_callbacks`;
        const callbacks = await expectedCallbacksModel.raw(query);
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get pending callbacks view failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get process logs
 */
const getProcessLogs = async (req, res) => {
    try {
        const { flowInstanceId, level, startDate, endDate, limit = 100, offset = 0 } = req.query;
        
        let query = `SELECT * FROM process_logs WHERE 1=1`;
        const values = [];
        let paramIndex = 1;
        
        if (flowInstanceId) {
            query += ` AND flow_instance_id = $${paramIndex++}`;
            values.push(flowInstanceId);
        }
        if (level) {
            query += ` AND level = $${paramIndex++}`;
            values.push(level);
        }
        if (startDate) {
            query += ` AND created_at >= $${paramIndex++}`;
            values.push(startDate);
        }
        if (endDate) {
            query += ` AND created_at <= $${paramIndex++}`;
            values.push(endDate);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        values.push(parseInt(limit), parseInt(offset));
        
        const logs = await processLogsModel.raw(query, values);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (error) {
        logger.error('Get process logs failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get event logs
 */
const getEventLogs = async (req, res) => {
    try {
        const { eventType, flowInstanceId, startDate, endDate, limit = 100, offset = 0 } = req.query;
        
        let query = `SELECT * FROM event_logs WHERE 1=1`;
        const values = [];
        let paramIndex = 1;
        
        if (eventType) {
            query += ` AND event_type = $${paramIndex++}`;
            values.push(eventType);
        }
        if (flowInstanceId) {
            query += ` AND flow_instance_id = $${paramIndex++}`;
            values.push(flowInstanceId);
        }
        if (startDate) {
            query += ` AND created_at >= $${paramIndex++}`;
            values.push(startDate);
        }
        if (endDate) {
            query += ` AND created_at <= $${paramIndex++}`;
            values.push(endDate);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        values.push(parseInt(limit), parseInt(offset));
        
        const logs = await eventLogsModel.raw(query, values);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (error) {
        logger.error('Get event logs failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get job queue status
 */
const getJobQueueStatus = async (req, res) => {
    try {
        const { status, jobType, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (status) where.status = status;
        if (jobType) where.job_type = jobType;
        
        const jobs = await jobQueueModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: jobs
        });
    } catch (error) {
        logger.error('Get job queue status failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get TSQ requests
 */
const getTsqRequests = async (req, res) => {
    try {
        const { status, flowInstanceId, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (status) where.status = status;
        if (flowInstanceId) where.flow_instance_id = flowInstanceId;
        
        const requests = await tsqRequestsModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: requests
        });
    } catch (error) {
        logger.error('Get TSQ requests failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get reversal requests
 */
const getReversalRequests = async (req, res) => {
    try {
        const { status, reversalType, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (status) where.status = status;
        if (reversalType) where.reversal_type = reversalType;
        
        const requests = await reversalRequestsModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: requests
        });
    } catch (error) {
        logger.error('Get reversal requests failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get alert history
 */
const getAlertHistory = async (req, res) => {
    try {
        const { alertType, status, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (alertType) where.alert_type = alertType;
        if (status) where.status = status;
        
        const alerts = await alertHistoryModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: alerts
        });
    } catch (error) {
        logger.error('Get alert history failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get hourly transaction volume
 */
const getHourlyVolume = async (req, res) => {
    try {
        const { date, eventType } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        
        let query = `
            SELECT 
                DATE_TRUNC('hour', created_at) as hour,
                COUNT(*) as count,
                COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
                COUNT(*) FILTER (WHERE status = 'FAILED') as failed
            FROM flow_instances
            WHERE DATE(created_at) = $1
        `;
        const values = [targetDate.toISOString().split('T')[0]];
        let paramIndex = 2;
        
        if (eventType) {
            query += ` AND flow_id IN (
                SELECT f.id FROM flows f 
                JOIN event_types et ON f.event_type_id = et.id 
                WHERE et.code = $${paramIndex++}
            )`;
            values.push(eventType);
        }
        
        query += ` GROUP BY DATE_TRUNC('hour', created_at) ORDER BY hour`;
        
        const volume = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: volume
        });
    } catch (error) {
        logger.error('Get hourly volume failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get system health
 */
const getSystemHealth = async (req, res) => {
    try {
        // Check database connection
        let dbStatus = 'healthy';
        try {
            await flowInstancesModel.raw('SELECT 1');
        } catch (e) {
            dbStatus = 'unhealthy';
        }
        
        // Get queue backlog
        const queueBacklog = await jobQueueModel.count({ status: 'PENDING' });
        
        // Get oldest pending job
        const oldestPending = await jobQueueModel.findOne({
            where: { status: 'PENDING' },
            orderBy: 'created_at ASC'
        });
        
        // Get stalled callbacks
        const stalledCallbacks = await expectedCallbacksModel.raw(`
            SELECT COUNT(*) as count FROM expected_callbacks 
            WHERE status = 'PENDING' AND timeout_at < NOW()
        `);
        
        // Get failed jobs in last hour
        const failedJobs = await jobQueueModel.raw(`
            SELECT COUNT(*) as count FROM job_queue 
            WHERE status = 'FAILED' AND updated_at >= NOW() - INTERVAL '1 hour'
        `);
        
        res.json({
            success: true,
            data: {
                status: dbStatus === 'healthy' && queueBacklog < 1000 ? 'healthy' : 'degraded',
                database: dbStatus,
                queueBacklog,
                oldestPendingJob: oldestPending?.created_at || null,
                stalledCallbacks: parseInt(stalledCallbacks[0]?.count || 0),
                failedJobsLastHour: parseInt(failedJobs[0]?.count || 0),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error('Get system health failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    getDashboardStats,
    getActiveFlowInstancesView,
    getFlowStatistics,
    getPendingCallbacksView,
    getProcessLogs,
    getEventLogs,
    getJobQueueStatus,
    getTsqRequests,
    getReversalRequests,
    getAlertHistory,
    getHourlyVolume,
    getSystemHealth
};
