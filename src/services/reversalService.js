const {
    reversalRequestsModel,
    flowInstancesModel,
    stepExecutionsModel,
    processLogsModel,
    externalApisModel
} = require('../models');
const executionService = require('./executionService');
const flowService = require('./flowService');
const callbackService = require('./callbackService');
const logger = require('../utils/logger');
const { safeJsonParse, formatDateTime, formatAmount, deepClone } = require('../utils/helpers');
const axios = require('axios');

const REVERSAL_STATUSES = {
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    PARTIAL: 'PARTIAL',
    CANCELLED: 'CANCELLED'
};

const REVERSAL_TYPES = {
    FTD_REVERSAL: 'FTD_REVERSAL',  // Reverse a debit using credit (FTC)
    FTC_REVERSAL: 'FTC_REVERSAL',  // Reverse a credit using debit (FTD)
    FULL_REVERSAL: 'FULL_REVERSAL' // Reverse entire transaction
};

/**
 * Create a reversal request
 */
const createReversalRequest = async (params) => {
    const {
        originalInstanceId,
        reversalType,
        reason,
        initiatedBy = 'SYSTEM',
        metadata = {}
    } = params;

    // Get original instance
    const originalInstance = await flowInstancesModel.findById(originalInstanceId);
    if (!originalInstance) {
        throw new Error(`Original flow instance not found: ${originalInstanceId}`);
    }

    const originalPayload = safeJsonParse(originalInstance.current_payload, {});

    // Determine reversal function code and swap fields
    const reversalConfig = getReversalConfig(reversalType, originalPayload);

    // Create reversal request
    const reversalRequest = await reversalRequestsModel.create({
        original_instance_id: originalInstanceId,
        original_session_id: originalInstance.session_id,
        original_tracking_number: originalInstance.tracking_number,
        reversal_type: reversalType,
        reason: reason,
        status: REVERSAL_STATUSES.PENDING,
        original_payload: JSON.stringify(originalPayload),
        reversal_payload: JSON.stringify(reversalConfig.payload),
        initiated_by: initiatedBy,
        metadata: JSON.stringify(metadata)
    });

    logger.info('Reversal request created', {
        reversalId: reversalRequest.id,
        originalInstanceId,
        reversalType,
        reason
    });

    await processLogsModel.create({
        flow_instance_id: originalInstanceId,
        event_type: 'REVERSAL_CREATED',
        details: JSON.stringify({
            reversalId: reversalRequest.id,
            reversalType,
            reason
        })
    });

    return reversalRequest;
};

/**
 * Get reversal configuration based on type
 */
const getReversalConfig = (reversalType, originalPayload) => {
    const basePayload = {
        sessionId: originalPayload.sessionId,
        trackingNumber: originalPayload.trackingNumber,
        amount: originalPayload.amount,
        dateTime: formatDateTime(),
        channelCode: originalPayload.channelCode,
        narration: `REVERSAL: ${originalPayload.narration || ''}`
    };

    switch (reversalType) {
        case REVERSAL_TYPES.FTD_REVERSAL:
            // Reversing a debit - use credit (FTC) with swapped accounts
            return {
                functionCode: '240', // FTC
                payload: {
                    ...basePayload,
                    functionCode: '240',
                    // Swap: credit to the account that was debited
                    accountToCredit: originalPayload.accountToDebit,
                    accountToDebit: originalPayload.accountToCredit,
                    nameToCredit: originalPayload.nameToDebit,
                    nameToDebit: originalPayload.nameToCredit,
                    // Swap banks too
                    originBank: originalPayload.destBank,
                    destBank: originalPayload.originBank
                }
            };

        case REVERSAL_TYPES.FTC_REVERSAL:
            // Reversing a credit - use debit (FTD) with swapped accounts
            return {
                functionCode: '241', // FTD
                payload: {
                    ...basePayload,
                    functionCode: '241',
                    // Swap: debit the account that was credited
                    accountToDebit: originalPayload.accountToCredit,
                    accountToCredit: originalPayload.accountToDebit,
                    nameToDebit: originalPayload.nameToCredit,
                    nameToCredit: originalPayload.nameToDebit,
                    // Swap banks
                    originBank: originalPayload.destBank,
                    destBank: originalPayload.originBank
                }
            };

        case REVERSAL_TYPES.FULL_REVERSAL:
            // Full reversal - may need both FTD and FTC reversals
            return {
                functionCode: 'MULTI',
                payload: {
                    ...basePayload,
                    reversalSteps: ['FTC_REVERSAL', 'FTD_REVERSAL']
                }
            };

        default:
            throw new Error(`Unknown reversal type: ${reversalType}`);
    }
};

/**
 * Execute a reversal request
 */
const executeReversalRequest = async (reversalId) => {
    const reversalRequest = await reversalRequestsModel.findById(reversalId);
    if (!reversalRequest) {
        throw new Error(`Reversal request not found: ${reversalId}`);
    }

    if (reversalRequest.status !== REVERSAL_STATUSES.PENDING) {
        throw new Error(`Reversal not in PENDING status: ${reversalRequest.status}`);
    }

    // Update status
    await reversalRequestsModel.update(reversalId, {
        status: REVERSAL_STATUSES.IN_PROGRESS,
        started_at: new Date()
    });

    const reversalPayload = safeJsonParse(reversalRequest.reversal_payload, {});

    logger.info('Executing reversal request', {
        reversalId,
        reversalType: reversalRequest.reversal_type,
        sessionId: reversalPayload.sessionId
    });

    try {
        // Get GIP API configuration
        const gipApi = await externalApisModel.findOne({ code: 'GIP' });
        if (!gipApi) {
            throw new Error('GIP API configuration not found');
        }

        // Determine endpoint based on function code
        const endpoint = reversalPayload.functionCode === '240' ? '/credit' : '/debit';
        const url = `${gipApi.base_url}${endpoint}`;

        // Add callback URL for async reversal
        const callbackUrl = `${process.env.ORCHESTRATOR_BASE_URL}/api/v1/reversals/${reversalId}/callback`;
        reversalPayload.callbackUrl = callbackUrl;

        // Execute reversal
        const response = await axios({
            method: 'POST',
            url,
            data: reversalPayload,
            headers: {
                'Content-Type': 'application/json',
                ...safeJsonParse(gipApi.headers, {})
            },
            timeout: 30000
        });

        const responseData = response.data;

        // Store immediate response
        await reversalRequestsModel.update(reversalId, {
            response_payload: JSON.stringify(responseData),
            action_code: responseData.actionCode,
            approval_code: responseData.approvalCode
        });

        // Check if we need to wait for callback
        if (responseData.actionCode === '001') {
            // Pending - wait for callback
            await processLogsModel.create({
                flow_instance_id: reversalRequest.original_instance_id,
                event_type: 'REVERSAL_PENDING',
                details: JSON.stringify({
                    reversalId,
                    actionCode: responseData.actionCode,
                    waitingForCallback: true
                })
            });

            return {
                reversalId,
                status: 'PENDING_CALLBACK',
                actionCode: responseData.actionCode
            };
        }

        // Process immediate result
        return processReversalResult(reversalId, responseData);

    } catch (error) {
        logger.error('Reversal execution failed', {
            reversalId,
            error: error.message
        });

        await reversalRequestsModel.update(reversalId, {
            status: REVERSAL_STATUSES.FAILED,
            error_message: error.message,
            completed_at: new Date()
        });

        await processLogsModel.create({
            flow_instance_id: reversalRequest.original_instance_id,
            event_type: 'REVERSAL_FAILED',
            details: JSON.stringify({
                reversalId,
                error: error.message
            })
        });

        throw error;
    }
};

/**
 * Process reversal callback
 */
const processReversalCallback = async (reversalId, callbackData) => {
    const reversalRequest = await reversalRequestsModel.findById(reversalId);
    if (!reversalRequest) {
        throw new Error(`Reversal request not found: ${reversalId}`);
    }

    logger.info('Processing reversal callback', {
        reversalId,
        actionCode: callbackData.actionCode
    });

    // Store callback data
    await reversalRequestsModel.update(reversalId, {
        callback_payload: JSON.stringify(callbackData),
        callback_received_at: new Date()
    });

    return processReversalResult(reversalId, callbackData);
};

/**
 * Process reversal result
 */
const processReversalResult = async (reversalId, responseData) => {
    const reversalRequest = await reversalRequestsModel.findById(reversalId);
    const actionCode = responseData.actionCode;
    const approvalCode = responseData.approvalCode;

    let status;
    let description;

    if (actionCode === '000') {
        status = REVERSAL_STATUSES.SUCCESS;
        description = 'Reversal successful';
    } else {
        status = REVERSAL_STATUSES.FAILED;
        description = `Reversal failed with code ${actionCode}/${approvalCode}`;
    }

    // Update reversal request
    await reversalRequestsModel.update(reversalId, {
        status,
        action_code: actionCode,
        approval_code: approvalCode,
        completed_at: new Date()
    });

    // Log result
    await processLogsModel.create({
        flow_instance_id: reversalRequest.original_instance_id,
        event_type: status === REVERSAL_STATUSES.SUCCESS ? 'REVERSAL_SUCCESS' : 'REVERSAL_FAILED',
        details: JSON.stringify({
            reversalId,
            actionCode,
            approvalCode,
            description
        })
    });

    // Update original instance
    const originalInstance = await flowInstancesModel.findById(reversalRequest.original_instance_id);
    if (originalInstance) {
        const currentPayload = safeJsonParse(originalInstance.current_payload, {});
        currentPayload.reversalResult = {
            reversalId,
            status,
            actionCode,
            approvalCode,
            timestamp: new Date().toISOString()
        };

        await flowInstancesModel.update(originalInstance.id, {
            current_payload: JSON.stringify(currentPayload),
            status: status === REVERSAL_STATUSES.SUCCESS ? 'REVERSED' : 'REVERSAL_FAILED'
        });

        // Send callback to BFS
        await callbackService.sendCallbackToBfs(originalInstance.id, {
            status: status === REVERSAL_STATUSES.SUCCESS ? 'REVERSED' : 'REVERSAL_FAILED',
            reversalId,
            actionCode,
            approvalCode,
            description
        });
    }

    return {
        reversalId,
        status,
        actionCode,
        approvalCode,
        description
    };
};

/**
 * Process pending reversals
 */
const processPendingReversals = async () => {
    logger.debug('Processing pending reversals');

    const pendingReversals = await reversalRequestsModel.findAll({
        where: { status: REVERSAL_STATUSES.PENDING },
        orderBy: 'created_at ASC',
        limit: 20
    });

    const results = [];

    for (const reversal of pendingReversals) {
        try {
            const result = await executeReversalRequest(reversal.id);
            results.push(result);
        } catch (error) {
            results.push({ reversalId: reversal.id, error: error.message });
        }
    }

    return results;
};

/**
 * Get reversal statistics
 */
const getReversalStats = async (timeRange = '24 hours') => {
    const stats = await reversalRequestsModel.raw(`
        SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'SUCCESS') as success,
            COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
            COUNT(*) FILTER (WHERE status = 'PENDING') as pending,
            COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') as in_progress,
            SUM(CASE WHEN status = 'SUCCESS' THEN 
                CAST(original_payload->>'amount' AS NUMERIC) / 100 
                ELSE 0 END) as total_reversed_amount
        FROM reversal_requests
        WHERE created_at >= NOW() - INTERVAL '${timeRange}'
    `);

    return stats[0];
};

/**
 * List reversals for an instance
 */
const listReversalsForInstance = async (instanceId) => {
    return reversalRequestsModel.findAll({
        where: { original_instance_id: instanceId },
        orderBy: 'created_at DESC'
    });
};

/**
 * Cancel a pending reversal
 */
const cancelReversal = async (reversalId, reason) => {
    const reversal = await reversalRequestsModel.findById(reversalId);
    if (!reversal) {
        throw new Error(`Reversal not found: ${reversalId}`);
    }

    if (reversal.status !== REVERSAL_STATUSES.PENDING) {
        throw new Error(`Cannot cancel reversal in ${reversal.status} status`);
    }

    await reversalRequestsModel.update(reversalId, {
        status: REVERSAL_STATUSES.CANCELLED,
        error_message: reason,
        completed_at: new Date()
    });

    await processLogsModel.create({
        flow_instance_id: reversal.original_instance_id,
        event_type: 'REVERSAL_CANCELLED',
        details: JSON.stringify({
            reversalId,
            reason
        })
    });

    return { reversalId, status: 'CANCELLED', reason };
};

module.exports = {
    createReversalRequest,
    executeReversalRequest,
    processReversalCallback,
    processReversalResult,
    processPendingReversals,
    getReversalStats,
    listReversalsForInstance,
    cancelReversal,
    REVERSAL_STATUSES,
    REVERSAL_TYPES
};
