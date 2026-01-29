const {
    expectedCallbacksModel,
    receivedCallbacksModel,
    flowInstancesModel,
    stepExecutionsModel,
    processLogsModel
} = require('../models');
const executionService = require('./executionService');
const logger = require('../utils/logger');
const { safeJsonParse, isSuccessResponse } = require('../utils/helpers');
const axios = require('axios');

/**
 * Process incoming callback from external API
 */
const processIncomingCallback = async (callbackData) => {
    const { sessionId, trackingNumber } = callbackData;

    logger.info('Processing incoming callback', { sessionId, trackingNumber });

    // Store received callback
    const receivedCallback = await receivedCallbacksModel.create({
        session_id: sessionId,
        tracking_number: trackingNumber,
        payload: JSON.stringify(callbackData),
        source: callbackData.source || 'EXTERNAL',
        received_at: new Date()
    });

    // Find matching expected callback
    const expectedCallback = await expectedCallbacksModel.findOne({
        session_id: sessionId,
        is_matched: false
    });

    if (!expectedCallback) {
        logger.warn('No matching expected callback found', { sessionId, trackingNumber });
        
        // Store as unmatched for later processing
        await receivedCallbacksModel.update(receivedCallback.id, {
            is_matched: false,
            match_status: 'UNMATCHED'
        });

        return {
            status: 'UNMATCHED',
            receivedCallbackId: receivedCallback.id
        };
    }

    // Mark callbacks as matched
    await expectedCallbacksModel.update(expectedCallback.id, {
        is_matched: true,
        matched_at: new Date(),
        received_callback_id: receivedCallback.id
    });

    await receivedCallbacksModel.update(receivedCallback.id, {
        is_matched: true,
        match_status: 'MATCHED',
        expected_callback_id: expectedCallback.id,
        flow_instance_id: expectedCallback.flow_instance_id,
        step_execution_id: expectedCallback.step_execution_id
    });

    // Log the match
    await processLogsModel.create({
        flow_instance_id: expectedCallback.flow_instance_id,
        event_type: 'CALLBACK_RECEIVED',
        details: JSON.stringify({
            sessionId,
            trackingNumber,
            actionCode: callbackData.actionCode,
            stepExecutionId: expectedCallback.step_execution_id
        })
    });

    // Resume flow execution
    try {
        const result = await executionService.resumeAfterCallback(
            expectedCallback.flow_instance_id,
            expectedCallback.step_execution_id,
            callbackData
        );

        return {
            status: 'PROCESSED',
            receivedCallbackId: receivedCallback.id,
            flowResult: result
        };
    } catch (error) {
        logger.error('Failed to resume flow after callback', {
            error: error.message,
            instanceId: expectedCallback.flow_instance_id
        });

        return {
            status: 'ERROR',
            receivedCallbackId: receivedCallback.id,
            error: error.message
        };
    }
};

/**
 * Process callback for specific instance and step
 */
const processCallbackForStep = async (instanceId, stepExecutionId, callbackData) => {
    logger.info('Processing callback for step', { instanceId, stepExecutionId });

    // Store received callback
    const receivedCallback = await receivedCallbacksModel.create({
        session_id: callbackData.sessionId,
        tracking_number: callbackData.trackingNumber,
        payload: JSON.stringify(callbackData),
        source: 'DIRECT',
        is_matched: true,
        match_status: 'MATCHED',
        flow_instance_id: instanceId,
        step_execution_id: stepExecutionId,
        received_at: new Date()
    });

    // Update expected callback if exists
    const expectedCallback = await expectedCallbacksModel.findOne({
        flow_instance_id: instanceId,
        step_execution_id: stepExecutionId,
        is_matched: false
    });

    if (expectedCallback) {
        await expectedCallbacksModel.update(expectedCallback.id, {
            is_matched: true,
            matched_at: new Date(),
            received_callback_id: receivedCallback.id
        });
    }

    // Resume flow
    const result = await executionService.resumeAfterCallback(
        instanceId,
        stepExecutionId,
        callbackData
    );

    return {
        status: 'PROCESSED',
        receivedCallbackId: receivedCallback.id,
        flowResult: result
    };
};

/**
 * Send callback to BFS
 */
const sendCallbackToBfs = async (instanceId, payload) => {
    const instance = await flowInstancesModel.findById(instanceId);
    if (!instance) {
        throw new Error(`Flow instance not found: ${instanceId}`);
    }

    if (!instance.bfs_callback_url) {
        logger.warn('No BFS callback URL configured', { instanceId });
        return null;
    }

    const callbackPayload = {
        sessionId: instance.session_id,
        trackingNumber: instance.tracking_number,
        status: instance.status,
        ...payload,
        timestamp: new Date().toISOString()
    };

    logger.info('Sending callback to BFS', {
        instanceId,
        url: instance.bfs_callback_url,
        status: instance.status
    });

    try {
        const response = await axios({
            method: 'POST',
            url: instance.bfs_callback_url,
            data: callbackPayload,
            headers: {
                'Content-Type': 'application/json',
                'X-Instance-ID': instanceId,
                'X-Session-ID': instance.session_id
            },
            timeout: 30000
        });

        // Log successful callback
        await processLogsModel.create({
            flow_instance_id: instanceId,
            event_type: 'BFS_CALLBACK_SENT',
            details: JSON.stringify({
                url: instance.bfs_callback_url,
                status: response.status,
                payload: callbackPayload
            })
        });

        // Update instance
        await flowInstancesModel.update(instanceId, {
            callback_sent: true,
            callback_sent_at: new Date()
        });

        return {
            success: true,
            status: response.status,
            response: response.data
        };

    } catch (error) {
        logger.error('Failed to send callback to BFS', {
            instanceId,
            error: error.message
        });

        await processLogsModel.create({
            flow_instance_id: instanceId,
            event_type: 'BFS_CALLBACK_FAILED',
            details: JSON.stringify({
                url: instance.bfs_callback_url,
                error: error.message
            })
        });

        throw error;
    }
};

/**
 * Check for timed out callbacks
 */
const checkTimedOutCallbacks = async () => {
    logger.debug('Checking for timed out callbacks');

    const timedOut = await expectedCallbacksModel.raw(`
        SELECT ec.*, fi.session_id as instance_session_id
        FROM expected_callbacks ec
        JOIN flow_instances fi ON ec.flow_instance_id = fi.id
        WHERE ec.is_matched = false
        AND ec.timeout_at < NOW()
        AND ec.is_timed_out = false
    `);

    for (const callback of timedOut) {
        logger.warn('Callback timed out', {
            instanceId: callback.flow_instance_id,
            stepExecutionId: callback.step_execution_id,
            sessionId: callback.session_id
        });

        // Mark as timed out
        await expectedCallbacksModel.update(callback.id, {
            is_timed_out: true,
            timed_out_at: new Date()
        });

        // Update step execution
        await stepExecutionsModel.update(callback.step_execution_id, {
            status: 'TIMEOUT',
            error_message: 'Callback timeout',
            completed_at: new Date()
        });

        // Log timeout
        await processLogsModel.create({
            flow_instance_id: callback.flow_instance_id,
            event_type: 'CALLBACK_TIMEOUT',
            details: JSON.stringify({
                stepExecutionId: callback.step_execution_id,
                expectedAt: callback.timeout_at
            })
        });

        // Trigger TSQ if configured
        const instance = await flowInstancesModel.findById(callback.flow_instance_id);
        if (instance) {
            const currentPayload = safeJsonParse(instance.current_payload, {});
            currentPayload.callbackTimeout = true;
            currentPayload.needsTsq = true;

            await flowInstancesModel.update(callback.flow_instance_id, {
                current_payload: JSON.stringify(currentPayload),
                status: 'TIMEOUT'
            });
        }
    }

    return timedOut.length;
};

/**
 * Get callback statistics
 */
const getCallbackStats = async (timeRange = '24 hours') => {
    const stats = await expectedCallbacksModel.raw(`
        SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE is_matched = true) as matched,
            COUNT(*) FILTER (WHERE is_matched = false AND is_timed_out = false) as pending,
            COUNT(*) FILTER (WHERE is_timed_out = true) as timed_out,
            AVG(EXTRACT(EPOCH FROM (matched_at - created_at))) as avg_match_time_seconds
        FROM expected_callbacks
        WHERE created_at >= NOW() - INTERVAL '${timeRange}'
    `);

    return stats[0];
};

/**
 * List pending callbacks
 */
const listPendingCallbacks = async (limit = 50) => {
    return expectedCallbacksModel.raw(`
        SELECT ec.*, fi.session_id as instance_session_id, 
               fi.status as instance_status,
               se.status as step_status
        FROM expected_callbacks ec
        JOIN flow_instances fi ON ec.flow_instance_id = fi.id
        JOIN step_executions se ON ec.step_execution_id = se.id
        WHERE ec.is_matched = false
        AND ec.is_timed_out = false
        ORDER BY ec.created_at ASC
        LIMIT $1
    `, [limit]);
};

/**
 * Retry unmatched callbacks
 */
const retryUnmatchedCallbacks = async () => {
    const unmatched = await receivedCallbacksModel.findAll({
        where: { is_matched: false, match_status: 'UNMATCHED' },
        orderBy: 'received_at DESC',
        limit: 100
    });

    let matchedCount = 0;

    for (const callback of unmatched) {
        const payload = safeJsonParse(callback.payload, {});
        
        // Try to find matching expected callback
        const expectedCallback = await expectedCallbacksModel.findOne({
            session_id: callback.session_id,
            is_matched: false,
            is_timed_out: false
        });

        if (expectedCallback) {
            await expectedCallbacksModel.update(expectedCallback.id, {
                is_matched: true,
                matched_at: new Date(),
                received_callback_id: callback.id
            });

            await receivedCallbacksModel.update(callback.id, {
                is_matched: true,
                match_status: 'MATCHED_RETRY',
                expected_callback_id: expectedCallback.id,
                flow_instance_id: expectedCallback.flow_instance_id,
                step_execution_id: expectedCallback.step_execution_id
            });

            // Resume flow
            try {
                await executionService.resumeAfterCallback(
                    expectedCallback.flow_instance_id,
                    expectedCallback.step_execution_id,
                    payload
                );
                matchedCount++;
            } catch (error) {
                logger.error('Failed to resume flow on retry match', {
                    error: error.message,
                    callbackId: callback.id
                });
            }
        }
    }

    return matchedCount;
};

module.exports = {
    processIncomingCallback,
    processCallbackForStep,
    sendCallbackToBfs,
    checkTimedOutCallbacks,
    getCallbackStats,
    listPendingCallbacks,
    retryUnmatchedCallbacks
};
