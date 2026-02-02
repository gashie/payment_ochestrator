const { tsqRequestsModel, flowInstancesModel } = require('../models');
const tsqService = require('../services/tsqService');
const logger = require('../utils/logger');
const { safeJsonParse } = require('../utils/helpers');

/**
 * Process pending TSQ requests
 */
const processPendingTsqRequests = async () => {
    try {
        // Get TSQ requests that are due for execution
        const pending = await tsqRequestsModel.raw(`
            UPDATE tsq_requests
            SET status = 'PROCESSING'
            WHERE id IN (
                SELECT id FROM tsq_requests 
                WHERE status = 'PENDING'
                    AND next_retry_at <= NOW()
                ORDER BY next_retry_at ASC
                LIMIT 10
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `);
        
        if (pending.length === 0) {
            return;
        }
        
        logger.job('TSQScheduler', 'processPending', {
            count: pending.length,
            status: 'processing'
        });
        
        for (const tsq of pending) {
            try {
                // Execute TSQ
                const result = await tsqService.executeTsqRequest(tsq.id);
                
                logger.tsq('Executed successfully', { 
                    tsqId: tsq.id,
                    flowInstanceId: tsq.flow_instance_id,
                    result: result.status 
                });
            } catch (error) {
                logger.error(`TSQ execution failed`, error, { 
                    tsqId: tsq.id,
                    flowInstanceId: tsq.flow_instance_id
                });
                
                // Update TSQ request with error
                const attemptCount = (tsq.attempt_number || 0) + 1;
                const maxAttempts = tsq.max_attempts || 3;
                
                if (attemptCount < maxAttempts) {
                    // Schedule retry (5 minutes interval)
                    await tsqRequestsModel.update(tsq.id, {
                        status: 'PENDING',
                        attempt_number: attemptCount,
                        result_message: error.message,
                        next_retry_at: new Date(Date.now() + (tsq.retry_interval_seconds || 300) * 1000)
                    });
                    
                    logger.tsq('Scheduled retry', {
                        tsqId: tsq.id,
                        attemptCount,
                        nextRetryIn: `${tsq.retry_interval_seconds || 300}s`
                    });
                } else {
                    // Mark as failed
                    await tsqRequestsModel.update(tsq.id, {
                        status: 'FAILED',
                        attempt_number: attemptCount,
                        result_message: `Max attempts reached: ${error.message}`,
                        response_at: new Date()
                    });
                    
                    // Update flow instance
                    await flowInstancesModel.update(tsq.flow_instance_id, {
                        status: 'MANUAL_INTERVENTION',
                        error_message: `TSQ failed after ${maxAttempts} attempts`
                    });
                    
                    logger.error('TSQ max retries exceeded', error, {
                        tsqId: tsq.id,
                        maxAttempts,
                        flowInstanceId: tsq.flow_instance_id
                    });
                }
            }
        }
    } catch (error) {
        logger.error('Process pending TSQ requests failed', error, {
            job: 'TSQScheduler',
            action: 'processPending'
        });
    }
};

/**
 * Schedule TSQ for indeterminate responses
 */
const scheduleTsqForIndeterminateResponses = async () => {
    try {
        // Find flow instances with indeterminate status
        const indeterminate = await flowInstancesModel.raw(`
            SELECT fi.* 
            FROM flow_instances fi
            LEFT JOIN tsq_requests tsq ON fi.id = tsq.flow_instance_id
            WHERE fi.status = 'WAITING_CALLBACK'
                AND fi.created_at < NOW() - INTERVAL '5 minutes'
                AND tsq.id IS NULL
            LIMIT 20
        `);
        
        if (indeterminate.length === 0) {
            return;
        }
        
        logger.job('TSQScheduler', 'scheduleIndeterminate', {
            count: indeterminate.length,
            status: 'processing'
        });
        
        for (const instance of indeterminate) {
            try {
                // Parse the current payload from the flow instance
                const currentPayload = safeJsonParse(instance.current_payload, {});

                // Ensure sessionId and trackingNumber are set from instance if not in payload
                const tsqPayload = {
                    ...currentPayload,
                    sessionId: currentPayload.sessionId || instance.session_id,
                    trackingNumber: currentPayload.trackingNumber || instance.tracking_number
                };

                await tsqService.createTsqRequest(instance.id, tsqPayload, 'WAITING_CALLBACK_TIMEOUT');

                logger.tsq('Scheduled for indeterminate response', {
                    flowInstanceId: instance.id,
                    sessionId: instance.session_id,
                    reason: 'Callback wait timeout'
                });
            } catch (error) {
                logger.error(`Schedule TSQ failed`, error, {
                    flowInstanceId: instance.id
                });
            }
        }
    } catch (error) {
        logger.error('Schedule TSQ for indeterminate responses failed', error, {
            job: 'TSQScheduler',
            action: 'scheduleIndeterminate'
        });
    }
};

/**
 * Get TSQ statistics
 */
const getTsqStats = async () => {
    try {
        const stats = await tsqRequestsModel.raw(`
            SELECT 
                status,
                COUNT(*) as count,
                AVG(attempt_number) as avg_attempts
            FROM tsq_requests
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
        `);
        
        logger.debug('TSQ stats retrieved', { count: stats.length });
        return stats;
    } catch (error) {
        logger.error('Get TSQ stats failed', error, {
            job: 'TSQScheduler',
            action: 'getStats'
        });
        return [];
    }
};

/**
 * Clean up old TSQ requests
 */
const cleanupOldTsqRequests = async () => {
    try {
        const deleted = await tsqRequestsModel.raw(`
            DELETE FROM tsq_requests
            WHERE status IN ('SUCCESS', 'FAILED')
                AND response_at < NOW() - INTERVAL '30 days'
            RETURNING id
        `);
        
        if (deleted.length > 0) {
            logger.job('TSQScheduler', 'cleanup', {
                count: deleted.length,
                status: 'success',
                reason: 'Deleted old completed/failed TSQ requests'
            });
        }
    } catch (error) {
        logger.error('Cleanup old TSQ requests failed', error, {
            job: 'TSQScheduler',
            action: 'cleanup'
        });
    }
};

module.exports = {
    processPendingTsqRequests,
    scheduleTsqForIndeterminateResponses,
    getTsqStats,
    cleanupOldTsqRequests
};
