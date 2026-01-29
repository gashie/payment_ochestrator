const { 
    flowInstancesModel, 
    auditLogsModel,
    reversalRequestsModel,
    tsqRequestsModel
} = require('../models');
const logger = require('../utils/logger');

/**
 * Generate transaction summary report
 */
const getTransactionSummaryReport = async (req, res) => {
    try {
        const { startDate, endDate, eventType, groupBy = 'day' } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        const dateFormat = groupBy === 'hour' 
            ? "DATE_TRUNC('hour', fi.created_at)" 
            : groupBy === 'month' 
                ? "DATE_TRUNC('month', fi.created_at)"
                : "DATE_TRUNC('day', fi.created_at)";
        
        let query = `
            SELECT 
                ${dateFormat} as period,
                et.code as event_type,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE fi.status = 'COMPLETED') as completed,
                COUNT(*) FILTER (WHERE fi.status = 'FAILED') as failed,
                COUNT(*) FILTER (WHERE fi.status = 'MANUAL_INTERVENTION') as manual,
                SUM(CASE WHEN fi.status = 'COMPLETED' THEN 
                    CAST((fi.initial_payload::json->>'amount') AS NUMERIC) 
                ELSE 0 END) / 100 as total_amount_completed,
                AVG(EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))) as avg_processing_time_seconds
            FROM flow_instances fi
            JOIN flows f ON fi.flow_id = f.id
            JOIN event_types et ON f.event_type_id = et.id
            WHERE fi.created_at >= $1 AND fi.created_at <= $2
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (eventType) {
            query += ` AND et.code = $${paramIndex++}`;
            values.push(eventType);
        }
        
        query += ` GROUP BY ${dateFormat}, et.code ORDER BY period, event_type`;
        
        const report = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: {
                reportType: 'TRANSACTION_SUMMARY',
                period: { startDate, endDate },
                groupBy,
                data: report
            }
        });
    } catch (error) {
        logger.error('Generate transaction summary report failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Generate flow performance report
 */
const getFlowPerformanceReport = async (req, res) => {
    try {
        const { startDate, endDate, flowId } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        let query = `
            SELECT 
                f.id as flow_id,
                f.name as flow_name,
                et.code as event_type,
                COUNT(*) as total_executions,
                COUNT(*) FILTER (WHERE fi.status = 'COMPLETED') as successful,
                COUNT(*) FILTER (WHERE fi.status = 'FAILED') as failed,
                ROUND(
                    COUNT(*) FILTER (WHERE fi.status = 'COMPLETED')::NUMERIC / 
                    NULLIF(COUNT(*), 0) * 100, 2
                ) as success_rate,
                MIN(EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))) as min_duration_seconds,
                MAX(EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))) as max_duration_seconds,
                AVG(EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))) as avg_duration_seconds,
                PERCENTILE_CONT(0.95) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (fi.completed_at - fi.created_at))
                ) as p95_duration_seconds
            FROM flows f
            JOIN event_types et ON f.event_type_id = et.id
            LEFT JOIN flow_instances fi ON fi.flow_id = f.id 
                AND fi.created_at >= $1 AND fi.created_at <= $2
            WHERE 1=1
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (flowId) {
            query += ` AND f.id = $${paramIndex++}`;
            values.push(flowId);
        }
        
        query += ` GROUP BY f.id, f.name, et.code ORDER BY total_executions DESC`;
        
        const report = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: {
                reportType: 'FLOW_PERFORMANCE',
                period: { startDate, endDate },
                data: report
            }
        });
    } catch (error) {
        logger.error('Generate flow performance report failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Generate failure analysis report
 */
const getFailureAnalysisReport = async (req, res) => {
    try {
        const { startDate, endDate, eventType } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        let query = `
            SELECT 
                et.code as event_type,
                fi.error_message,
                COUNT(*) as occurrence_count,
                MIN(fi.created_at) as first_occurrence,
                MAX(fi.created_at) as last_occurrence
            FROM flow_instances fi
            JOIN flows f ON fi.flow_id = f.id
            JOIN event_types et ON f.event_type_id = et.id
            WHERE fi.status = 'FAILED'
                AND fi.created_at >= $1 AND fi.created_at <= $2
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (eventType) {
            query += ` AND et.code = $${paramIndex++}`;
            values.push(eventType);
        }
        
        query += ` GROUP BY et.code, fi.error_message ORDER BY occurrence_count DESC LIMIT 50`;
        
        const report = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: {
                reportType: 'FAILURE_ANALYSIS',
                period: { startDate, endDate },
                data: report
            }
        });
    } catch (error) {
        logger.error('Generate failure analysis report failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Generate reversal report
 */
const getReversalReport = async (req, res) => {
    try {
        const { startDate, endDate, status, reversalType } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        let query = `
            SELECT 
                rr.reversal_type,
                rr.status,
                COUNT(*) as count,
                SUM(CASE WHEN fi.initial_payload IS NOT NULL THEN 
                    CAST((fi.initial_payload::json->>'amount') AS NUMERIC) 
                ELSE 0 END) / 100 as total_amount
            FROM reversal_requests rr
            LEFT JOIN flow_instances fi ON rr.original_instance_id = fi.id
            WHERE rr.created_at >= $1 AND rr.created_at <= $2
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (status) {
            query += ` AND rr.status = $${paramIndex++}`;
            values.push(status);
        }
        if (reversalType) {
            query += ` AND rr.reversal_type = $${paramIndex++}`;
            values.push(reversalType);
        }
        
        query += ` GROUP BY rr.reversal_type, rr.status ORDER BY count DESC`;
        
        const report = await reversalRequestsModel.raw(query, values);
        
        res.json({
            success: true,
            data: {
                reportType: 'REVERSAL_REPORT',
                period: { startDate, endDate },
                data: report
            }
        });
    } catch (error) {
        logger.error('Generate reversal report failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Generate TSQ report
 */
const getTsqReport = async (req, res) => {
    try {
        const { startDate, endDate, status } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        let query = `
            SELECT 
                tsq.status,
                tsq.trigger_reason,
                COUNT(*) as count,
                AVG(tsq.attempt_count) as avg_attempts,
                MAX(tsq.attempt_count) as max_attempts
            FROM tsq_requests tsq
            WHERE tsq.created_at >= $1 AND tsq.created_at <= $2
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (status) {
            query += ` AND tsq.status = $${paramIndex++}`;
            values.push(status);
        }
        
        query += ` GROUP BY tsq.status, tsq.trigger_reason ORDER BY count DESC`;
        
        const report = await tsqRequestsModel.raw(query, values);
        
        res.json({
            success: true,
            data: {
                reportType: 'TSQ_REPORT',
                period: { startDate, endDate },
                data: report
            }
        });
    } catch (error) {
        logger.error('Generate TSQ report failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get audit logs
 */
const getAuditLogs = async (req, res) => {
    try {
        const { entityType, entityId, actorId, action, startDate, endDate, limit = 100, offset = 0 } = req.query;
        
        let query = `SELECT * FROM audit_logs WHERE 1=1`;
        const values = [];
        let paramIndex = 1;
        
        if (entityType) {
            query += ` AND entity_type = $${paramIndex++}`;
            values.push(entityType);
        }
        if (entityId) {
            query += ` AND entity_id = $${paramIndex++}`;
            values.push(entityId);
        }
        if (actorId) {
            query += ` AND actor_id = $${paramIndex++}`;
            values.push(actorId);
        }
        if (action) {
            query += ` AND action = $${paramIndex++}`;
            values.push(action);
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
        
        const logs = await auditLogsModel.raw(query, values);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (error) {
        logger.error('Get audit logs failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Export transaction data
 */
const exportTransactions = async (req, res) => {
    try {
        const { startDate, endDate, eventType, status, format = 'json' } = req.query;
        
        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'startDate and endDate are required'
            });
        }
        
        let query = `
            SELECT 
                fi.id,
                fi.session_id,
                fi.tracking_number,
                et.code as event_type,
                f.name as flow_name,
                fi.status,
                fi.initial_payload,
                fi.current_payload,
                fi.output,
                fi.error_message,
                fi.created_at,
                fi.completed_at
            FROM flow_instances fi
            JOIN flows f ON fi.flow_id = f.id
            JOIN event_types et ON f.event_type_id = et.id
            WHERE fi.created_at >= $1 AND fi.created_at <= $2
        `;
        const values = [startDate, endDate];
        let paramIndex = 3;
        
        if (eventType) {
            query += ` AND et.code = $${paramIndex++}`;
            values.push(eventType);
        }
        if (status) {
            query += ` AND fi.status = $${paramIndex++}`;
            values.push(status);
        }
        
        query += ` ORDER BY fi.created_at DESC LIMIT 10000`;
        
        const data = await flowInstancesModel.raw(query, values);
        
        if (format === 'csv') {
            // Convert to CSV
            const headers = Object.keys(data[0] || {}).join(',');
            const rows = data.map(row => 
                Object.values(row).map(v => 
                    typeof v === 'object' ? JSON.stringify(v) : v
                ).join(',')
            ).join('\n');
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
            res.send(`${headers}\n${rows}`);
        } else {
            res.json({
                success: true,
                data: {
                    count: data.length,
                    transactions: data
                }
            });
        }
    } catch (error) {
        logger.error('Export transactions failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    getTransactionSummaryReport,
    getFlowPerformanceReport,
    getFailureAnalysisReport,
    getReversalReport,
    getTsqReport,
    getAuditLogs,
    exportTransactions
};
