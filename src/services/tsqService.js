const {
    tsqRequestsModel,
    flowInstancesModel,
    stepExecutionsModel,
    externalApisModel,
    processLogsModel
} = require('../models');
const callbackService = require('./callbackService');
const logger = require('../utils/logger');
const { safeJsonParse, formatDateTime, shouldTriggerTsq, isSuccessResponse } = require('../utils/helpers');
const axios = require('axios');

const TSQ_STATUSES = {
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    NOT_FOUND: 'NOT_FOUND',
    EXPIRED: 'EXPIRED'
};

const TSQ_FUNCTION_CODE = '111';
const MAX_TSQ_RETRIES = 3;
const TSQ_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create TSQ request for a flow instance
 */
const createTsqRequest = async (instanceId, originalPayload, reason) => {
    const instance = await flowInstancesModel.findById(instanceId);
    if (!instance) {
        throw new Error(`Flow instance not found: ${instanceId}`);
    }

    // Use instance values as fallback for critical fields
    const sessionId = originalPayload.sessionId || instance.session_id;
    const trackingNumber = originalPayload.trackingNumber || instance.tracking_number;

    if (!sessionId) {
        throw new Error(`Cannot create TSQ: sessionId is required (instanceId: ${instanceId})`);
    }

    // Build TSQ payload
    const tsqPayload = {
        originBank: originalPayload.originBank,
        destBank: originalPayload.destBank,
        sessionId: sessionId,
        trackingNumber: trackingNumber,
        amount: originalPayload.amount,
        dateTime: originalPayload.dateTime || formatDateTime(),
        accountToDebit: originalPayload.accountToDebit,
        accountToCredit: originalPayload.accountToCredit,
        channelCode: originalPayload.channelCode,
        functionCode: TSQ_FUNCTION_CODE,
        narration: originalPayload.narration
    };

    // Create TSQ record
    const tsqRequest = await tsqRequestsModel.create({
        flow_instance_id: instanceId,
        original_session_id: sessionId,
        original_tracking_number: trackingNumber,
        request_payload: JSON.stringify(tsqPayload),
        status: TSQ_STATUSES.PENDING,
        attempt_number: 1,
        max_attempts: MAX_TSQ_RETRIES,
        result_message: reason,
        metadata: JSON.stringify({ originalFunctionCode: originalPayload.functionCode, reason }),
        next_retry_at: new Date(Date.now() + TSQ_RETRY_INTERVAL_MS)
    });

    logger.info('TSQ request created', {
        tsqId: tsqRequest.id,
        instanceId,
        sessionId: originalPayload.sessionId,
        reason
    });

    await processLogsModel.create({
        flow_instance_id: instanceId,
        log_type: 'TSQ_CREATED',
        message: `TSQ request created: ${reason}`,
        details: JSON.stringify({
            tsqId: tsqRequest.id,
            reason,
            nextRetryAt: tsqRequest.next_retry_at
        })
    });

    return tsqRequest;
};

/**
 * Execute TSQ request
 */
const executeTsqRequest = async (tsqId) => {
    const tsqRequest = await tsqRequestsModel.findById(tsqId);
    if (!tsqRequest) {
        throw new Error(`TSQ request not found: ${tsqId}`);
    }

    if (tsqRequest.status !== TSQ_STATUSES.PENDING) {
        logger.warn('TSQ request not in PENDING status', { tsqId, status: tsqRequest.status });
        return null;
    }

    // Update status
    await tsqRequestsModel.update(tsqId, {
        status: TSQ_STATUSES.IN_PROGRESS,
        sent_at: new Date(),
        attempt_number: (tsqRequest.attempt_number || 0) + 1
    });

    const payload = safeJsonParse(tsqRequest.request_payload, {});

    // Get external API configuration (GIP)
    const gipApi = await externalApisModel.findOne({ code: 'GIP' });
    if (!gipApi) {
        throw new Error('GIP API configuration not found');
    }

    const url = `${gipApi.base_url}/tsq`;

    logger.info('Executing TSQ request', {
        tsqId,
        url,
        sessionId: payload.sessionId
    });

    try {
        const response = await axios({
            method: 'POST',
            url,
            data: payload,
            headers: {
                'Content-Type': 'application/json',
                ...safeJsonParse(gipApi.headers, {})
            },
            timeout: 30000
        });

        const responseData = response.data;
        const actionCode = responseData.actionCode;
        const approvalCode = responseData.approvalCode;

        // Store response
        await tsqRequestsModel.update(tsqId, {
            response_payload: JSON.stringify(responseData),
            action_code: actionCode,
            approval_code: approvalCode
        });

        // Evaluate response
        const result = evaluateTsqResponse(actionCode, approvalCode, (tsqRequest.attempt_number || 0) + 1);

        await tsqRequestsModel.update(tsqId, {
            status: result.status,
            result_status: result.finalResult || result.status,
            result_message: result.description,
            response_at: new Date(),
            next_retry_at: result.shouldRetry ? new Date(Date.now() + TSQ_RETRY_INTERVAL_MS) : null
        });

        // Log result
        await processLogsModel.create({
            flow_instance_id: tsqRequest.flow_instance_id,
            log_type: 'TSQ_EXECUTED',
            message: `TSQ executed: ${result.status}`,
            details: JSON.stringify({
                tsqId,
                actionCode,
                approvalCode,
                result: result.status,
                attemptNumber: (tsqRequest.attempt_number || 0) + 1
            })
        });

        // Update flow instance based on TSQ result
        await updateInstanceFromTsq(tsqRequest, result, responseData);

        return {
            tsqId,
            status: result.status,
            actionCode,
            approvalCode,
            description: result.description,
            shouldRetry: result.shouldRetry
        };

    } catch (error) {
        logger.error('TSQ request failed', {
            tsqId,
            error: error.message
        });

        const newAttemptNumber = (tsqRequest.attempt_number || 0) + 1;
        const shouldRetry = newAttemptNumber < MAX_TSQ_RETRIES;

        await tsqRequestsModel.update(tsqId, {
            status: shouldRetry ? TSQ_STATUSES.PENDING : TSQ_STATUSES.FAILED,
            result_message: error.message,
            next_retry_at: shouldRetry ? new Date(Date.now() + TSQ_RETRY_INTERVAL_MS) : null
        });

        throw error;
    }
};

/**
 * Evaluate TSQ response based on actionCode and approvalCode
 */
const evaluateTsqResponse = (actionCode, approvalCode, retryCount) => {
    // 000/000 → Transaction successful
    if (actionCode === '000' && approvalCode && !['381', '990'].includes(approvalCode)) {
        return {
            status: TSQ_STATUSES.SUCCESS,
            description: 'Transaction successful',
            shouldRetry: false,
            finalResult: 'SUCCESS'
        };
    }

    // 381/null → Retry; fail after 3 attempts
    if (actionCode === '381' || (actionCode === '000' && approvalCode === '381')) {
        if (retryCount >= MAX_TSQ_RETRIES) {
            return {
                status: TSQ_STATUSES.NOT_FOUND,
                description: 'Transaction not found after max retries',
                shouldRetry: false,
                finalResult: 'NOT_FOUND'
            };
        }
        return {
            status: TSQ_STATUSES.PENDING,
            description: 'Transaction not found, will retry',
            shouldRetry: true
        };
    }

    // 999/null → Fix request fields
    if (actionCode === '999') {
        return {
            status: TSQ_STATUSES.FAILED,
            description: 'Invalid request fields',
            shouldRetry: false,
            finalResult: 'VALIDATION_ERROR'
        };
    }

    // 000/990 → Pending; retry, then manual check
    if (actionCode === '000' && approvalCode === '990') {
        if (retryCount >= MAX_TSQ_RETRIES) {
            return {
                status: TSQ_STATUSES.PENDING,
                description: 'Transaction still pending, requires manual check',
                shouldRetry: false,
                finalResult: 'MANUAL_CHECK_REQUIRED'
            };
        }
        return {
            status: TSQ_STATUSES.PENDING,
            description: 'Transaction pending, will retry',
            shouldRetry: true
        };
    }

    // Other codes → Fail transaction
    return {
        status: TSQ_STATUSES.FAILED,
        description: `Transaction failed with code ${actionCode}/${approvalCode}`,
        shouldRetry: false,
        finalResult: 'FAILED'
    };
};

/**
 * Update flow instance based on TSQ result
 */
const updateInstanceFromTsq = async (tsqRequest, result, responseData) => {
    const instance = await flowInstancesModel.findById(tsqRequest.flow_instance_id);
    if (!instance) return;

    const currentPayload = safeJsonParse(instance.current_payload, {});

    // Update payload with TSQ result
    currentPayload.tsqResult = {
        status: result.status,
        actionCode: responseData.actionCode,
        approvalCode: responseData.approvalCode,
        description: result.description,
        timestamp: new Date().toISOString()
    };

    if (result.finalResult === 'SUCCESS') {
        // TSQ confirmed success - merge response data
        Object.assign(currentPayload, responseData);
        currentPayload.transactionConfirmed = true;

        await flowInstancesModel.update(instance.id, {
            current_payload: JSON.stringify(currentPayload),
            status: 'COMPLETED',
            completed_at: new Date()
        });

        // Send callback to BFS
        await callbackService.sendCallbackToBfs(instance.id, {
            status: 'SUCCESS',
            actionCode: responseData.actionCode,
            approvalCode: responseData.approvalCode,
            tsqConfirmed: true
        });

    } else if (result.finalResult === 'FAILED' || result.finalResult === 'NOT_FOUND') {
        currentPayload.transactionFailed = true;
        currentPayload.failureReason = result.description;

        await flowInstancesModel.update(instance.id, {
            current_payload: JSON.stringify(currentPayload),
            status: 'FAILED',
            error_message: result.description,
            completed_at: new Date()
        });

        // Send failure callback to BFS
        await callbackService.sendCallbackToBfs(instance.id, {
            status: 'FAILED',
            actionCode: responseData.actionCode,
            approvalCode: responseData.approvalCode,
            failureReason: result.description
        });

    } else if (result.finalResult === 'MANUAL_CHECK_REQUIRED') {
        currentPayload.requiresManualCheck = true;

        await flowInstancesModel.update(instance.id, {
            current_payload: JSON.stringify(currentPayload),
            status: 'MANUAL_INTERVENTION'
        });

    } else {
        // Still pending/retrying
        await flowInstancesModel.update(instance.id, {
            current_payload: JSON.stringify(currentPayload)
        });
    }
};

/**
 * Process pending TSQ requests
 */
const processPendingTsqRequests = async () => {
    logger.debug('Processing pending TSQ requests');

    const pendingRequests = await tsqRequestsModel.raw(`
        SELECT * FROM tsq_requests
        WHERE status = 'PENDING'
        AND next_retry_at <= NOW()
        AND attempt_number < max_attempts
        ORDER BY next_retry_at ASC
        LIMIT 50
    `);

    logger.debug(`Found ${pendingRequests.length} pending TSQ requests`);

    const results = [];

    for (const request of pendingRequests) {
        try {
            const result = await executeTsqRequest(request.id);
            results.push(result);
        } catch (error) {
            logger.error('Failed to execute TSQ request', {
                tsqId: request.id,
                error: error.message
            });
            results.push({ tsqId: request.id, error: error.message });
        }
    }

    return results;
};

/**
 * Get TSQ statistics
 */
const getTsqStats = async (timeRange = '24 hours') => {
    const stats = await tsqRequestsModel.raw(`
        SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'SUCCESS') as success,
            COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
            COUNT(*) FILTER (WHERE status = 'NOT_FOUND') as not_found,
            COUNT(*) FILTER (WHERE status = 'PENDING') as pending,
            AVG(attempt_number) as avg_attempts
        FROM tsq_requests
        WHERE created_at >= NOW() - INTERVAL '${timeRange}'
    `);

    return stats[0];
};

/**
 * List TSQ requests for an instance
 */
const listTsqRequestsForInstance = async (instanceId) => {
    return tsqRequestsModel.findAll({
        where: { flow_instance_id: instanceId },
        orderBy: 'created_at DESC'
    });
};

/**
 * Mark expired TSQ requests
 */
const markExpiredTsqRequests = async () => {
    const result = await tsqRequestsModel.raw(`
        UPDATE tsq_requests
        SET status = 'EXPIRED',
            updated_at = NOW()
        WHERE status = 'PENDING'
        AND attempt_number >= max_attempts
        AND next_retry_at < NOW() - INTERVAL '1 hour'
        RETURNING id, flow_instance_id
    `);

    for (const expired of result) {
        await processLogsModel.create({
            flow_instance_id: expired.flow_instance_id,
            log_type: 'TSQ_EXPIRED',
            message: 'TSQ request expired',
            details: JSON.stringify({ tsqId: expired.id })
        });
    }

    return result.length;
};

module.exports = {
    createTsqRequest,
    executeTsqRequest,
    evaluateTsqResponse,
    processPendingTsqRequests,
    getTsqStats,
    listTsqRequestsForInstance,
    markExpiredTsqRequests,
    TSQ_STATUSES,
    TSQ_FUNCTION_CODE,
    MAX_TSQ_RETRIES
};
