const { expectedCallbacksModel, receivedCallbacksModel, flowInstancesModel } = require('../models');
const callbackService = require('../services/callbackService');
const logger = require('../utils/logger');

/**
 * Check for timed out callbacks
 */
const checkTimedOutCallbacks = async () => {
    try {
        // Find callbacks that have timed out
        const timedOut = await expectedCallbacksModel.raw(`
            UPDATE expected_callbacks
            SET status = 'TIMEOUT'
            WHERE status = 'WAITING' 
                AND expected_by < NOW()
            RETURNING *
        `);
        
        if (timedOut.length === 0) {
            return;
        }
        
        logger.job('CallbackMatcher', 'checkTimedOut', {
            count: timedOut.length,
            status: 'processing'
        });
        
        for (const callback of timedOut) {
            try {
                // Update flow instance
                await flowInstancesModel.update(callback.flow_instance_id, {
                    status: 'FAILED',
                    error_message: `Callback timeout for step ${callback.step_id}`
                });
                
                logger.callback('Timeout detected', {
                    callbackId: callback.id,
                    flowInstanceId: callback.flow_instance_id,
                    reason: 'expected_by exceeded'
                });
                
                // Trigger TSQ or reversal based on configuration
                const instance = await flowInstancesModel.findById(callback.flow_instance_id);
                if (instance) {
                    const metadata = JSON.parse(instance.metadata || '{}');
                    
                    if (metadata.triggerTsqOnTimeout) {
                        // Queue TSQ job
                        const tsqService = require('../services/tsqService');
                        await tsqService.createTsqRequest(callback.flow_instance_id, 'TIMEOUT');
                        logger.tsq('Triggered on timeout', { 
                            flowInstanceId: callback.flow_instance_id 
                        });
                    }
                }
            } catch (error) {
                logger.error(`Handle timed out callback failed`, error, { 
                    callbackId: callback.id
                });
            }
        }
    } catch (error) {
        logger.error('Check timed out callbacks failed', error, {
            job: 'CallbackMatcher',
            action: 'checkTimedOut'
        });
    }
};

/**
 * Match unmatched callbacks
 */
const matchUnmatchedCallbacks = async () => {
    try {
        // Get unmatched callbacks
        const unmatched = await receivedCallbacksModel.findAll({
            where: { processed: false },
            orderBy: 'created_at ASC',
            limit: 100
        });
        
        if (unmatched.length === 0) {
            return;
        }
        
        logger.job('CallbackMatcher', 'matchUnmatched', {
            count: unmatched.length,
            status: 'processing'
        });
        
        for (const callback of unmatched) {
            try {
                const payload = JSON.parse(callback.payload);
                const { sessionId, trackingNumber } = payload;
                
                // Try to find matching expected callback
                const expectedCallback = await expectedCallbacksModel.findOne({
                    where: {
                        session_id: sessionId,
                        tracking_number: trackingNumber,
                        status: 'WAITING'
                    }
                });
                
                if (expectedCallback) {
                    // Match found - process callback
                    await callbackService.processIncomingCallback(payload);
                    
                    logger.callback('Match successful', {
                        callbackId: callback.id,
                        sessionId,
                        trackingNumber,
                        expectedCallbackId: expectedCallback.id
                    });
                    
                    // Update unmatched callback
                    await receivedCallbacksModel.update(callback.id, {
                        processed: true,
                        matched_to_instance_id: expectedCallback.flow_instance_id,
                        matched_to_step_id: expectedCallback.step_execution_id,
                        processed_at: new Date()
                    });
                }
            } catch (error) {
                logger.error(`Match callback failed`, error, { 
                    callbackId: callback.id
                });
            }
        }
    } catch (error) {
        logger.error('Match unmatched callbacks failed', error, {
            job: 'CallbackMatcher',
            action: 'matchUnmatched'
        });
    }
};

/**
 * Send pending BFS callbacks
 */
const sendPendingBfsCallbacks = async () => {
    try {
        // Find completed instances without BFS callback
        // Note: Only send callbacks for async requests (callback_sent = false)
        const pending = await flowInstancesModel.raw(`
            SELECT fi.*
            FROM flow_instances fi
            WHERE fi.status IN ('COMPLETED', 'FAILED')
                AND (fi.callback_sent = false OR fi.callback_sent IS NULL)
                AND fi.bfs_callback_url IS NOT NULL
                AND fi.created_at > NOW() - INTERVAL '24 hours'
            LIMIT 50
        `);
        
        if (pending.length === 0) {
            return;
        }
        
        logger.job('CallbackMatcher', 'sendBFS', {
            count: pending.length,
            status: 'processing'
        });
        
        for (const instance of pending) {
            try {
                await callbackService.sendCallbackToBfs(instance.id);
                
                logger.callback('BFS callback sent', { 
                    flowInstanceId: instance.id,
                    sessionId: instance.session_id,
                    status: instance.status
                });
            } catch (error) {
                logger.error(`Send BFS callback failed`, error, { 
                    flowInstanceId: instance.id
                });
                
                // Update retry count
                await flowInstancesModel.update(instance.id, {
                    error_count: (instance.error_count || 0) + 1,
                    last_error: error.message
                });
            }
        }
    } catch (error) {
        logger.error('Send pending BFS callbacks failed', error, {
            job: 'CallbackMatcher',
            action: 'sendBFS'
        });
    }
};

/**
 * Retry failed BFS callbacks
 */
const retryFailedBfsCallbacks = async () => {
    try {
        const maxRetries = 5;

        // Find instances with failed BFS callbacks
        const failed = await flowInstancesModel.raw(`
            SELECT fi.*
            FROM flow_instances fi
            WHERE fi.status IN ('COMPLETED', 'FAILED')
                AND (fi.callback_sent = false OR fi.callback_sent IS NULL)
                AND fi.bfs_callback_url IS NOT NULL
                AND fi.error_count > 0
                AND fi.error_count < $1
                AND fi.updated_at < NOW() - INTERVAL '5 minutes' * fi.error_count
            LIMIT 20
        `, [maxRetries]);
        
        if (failed.length === 0) {
            return;
        }
        
        logger.job('CallbackMatcher', 'retryBFS', {
            count: failed.length,
            maxRetries,
            status: 'processing'
        });
        
        for (const instance of failed) {
            try {
                await callbackService.sendCallbackToBfs(instance.id, true);
                
                logger.callback('BFS callback retry successful', { 
                    flowInstanceId: instance.id,
                    retryCount: instance.error_count 
                });
            } catch (error) {
                logger.error(`BFS callback retry failed`, error, { 
                    flowInstanceId: instance.id,
                    retryCount: instance.error_count
                });
            }
        }
    } catch (error) {
        logger.error('Retry failed BFS callbacks failed', error, {
            job: 'CallbackMatcher',
            action: 'retryBFS'
        });
    }
};

/**
 * Get callback statistics
 */
const getCallbackStats = async () => {
    try {
        const stats = await expectedCallbacksModel.raw(`
            SELECT 
                status,
                COUNT(*) as count,
                AVG(EXTRACT(EPOCH FROM (received_at - created_at))) as avg_wait_seconds
            FROM expected_callbacks
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
        `);
        
        return stats;
    } catch (error) {
        logger.error('Get callback stats failed', { error: error.message });
        return [];
    }
};

module.exports = {
    checkTimedOutCallbacks,
    matchUnmatchedCallbacks,
    sendPendingBfsCallbacks,
    retryFailedBfsCallbacks,
    getCallbackStats
};
