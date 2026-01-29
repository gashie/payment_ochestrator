const executionService = require('../services/executionService');
const callbackService = require('../services/callbackService');
const tsqService = require('../services/tsqService');
const reversalService = require('../services/reversalService');
const { flowInstancesModel, stepExecutionsModel, jobQueueModel } = require('../models');
const logger = require('../utils/logger');

/**
 * Process incoming request from BFS
 */
const processRequest = async (req, res) => {
    try {
        const { eventType, payload, metadata } = req.body;
        const { isSync } = req.query;
        
        logger.service('ProcessController', 'processRequest', {
            eventType,
            sessionId: payload?.sessionId,
            isSync: isSync === 'true'
        }, req.requestId);
        
        // Create flow instance
        const result = await executionService.createFlowInstance({
            eventTypeCode: eventType,
            sessionId: payload?.sessionId,
            trackingNumber: payload?.trackingNumber,
            inputPayload: payload,
            bfsCallbackUrl: metadata?.callbackUrl,
            metadata
        });
        
        const { instance, flowDef, isSync: flowIsSync } = result;
        
        if (isSync === 'true') {
            // Synchronous processing - wait for completion
            const execResult = await executionService.executeFlowInstance(instance.id);

            // Mark callback as sent since sync response is the callback
            await flowInstancesModel.update(instance.id, {
                callback_sent: true,
                callback_sent_at: new Date()
            });

            logger.flow('Execution completed', {
                flowInstanceId: instance.id,
                status: execResult.status,
                isSync: true
            }, req.requestId);

            res.json({
                success: true,
                data: {
                    flowInstanceId: instance.id,
                    status: execResult.status,
                    result: execResult.payload
                }
            });
        } else {
            // Async processing - return immediately
            // Add to job queue for background processing
            await jobQueueModel.create({
                job_type: 'EXECUTE_FLOW',
                job_data: JSON.stringify({ flowInstanceId: instance.id }),
                status: 'PENDING',
                priority: 1
            });
            
            logger.flow('Queued for async processing', {
                flowInstanceId: instance.id,
                sessionId: instance.session_id
            }, req.requestId);
            
            res.status(202).json({
                success: true,
                data: {
                    flowInstanceId: instance.id,
                    sessionId: instance.session_id,
                    trackingNumber: instance.tracking_number,
                    status: 'ACCEPTED',
                    message: 'Request accepted for processing'
                }
            });
        }
    } catch (error) {
        logger.error('Process request failed', error, {
            requestId: req.requestId,
            eventType: req.body?.eventType
        });
        res.status(400).json({
            success: false,
            error: error.message,
            requestId: req.requestId
        });
    }
};

/**
 * Get flow instance status
 */
const getFlowInstanceStatus = async (req, res) => {
    try {
        const { instanceId } = req.params;
        
        const instance = await flowInstancesModel.findById(instanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        // Get step executions
        const steps = await stepExecutionsModel.findAll({
            where: { flow_instance_id: instanceId },
            orderBy: 'created_at ASC'
        });
        
        res.json({
            success: true,
            data: {
                instance,
                steps
            }
        });
    } catch (error) {
        logger.error('Get flow instance status failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get flow instance by session ID
 */
const getFlowInstanceBySession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const instance = await flowInstancesModel.findOne({
            where: { session_id: sessionId }
        });
        
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        const steps = await stepExecutionsModel.findAll({
            where: { flow_instance_id: instance.id },
            orderBy: 'created_at ASC'
        });
        
        res.json({
            success: true,
            data: {
                instance,
                steps
            }
        });
    } catch (error) {
        logger.error('Get flow instance by session failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Resume flow instance manually
 */
const resumeFlowInstance = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { action, overrideData } = req.body;
        
        const instance = await flowInstancesModel.findById(instanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        if (instance.status !== 'MANUAL_INTERVENTION') {
            return res.status(400).json({
                success: false,
                error: 'Flow instance is not in MANUAL_INTERVENTION status'
            });
        }
        
        // Update instance with manual action
        await flowInstancesModel.update(instanceId, {
            status: 'RUNNING',
            metadata: JSON.stringify({
                ...JSON.parse(instance.metadata || '{}'),
                manualAction: action,
                manualOverrideData: overrideData,
                resumedAt: new Date().toISOString(),
                resumedBy: req.user?.id || 'SYSTEM'
            })
        });
        
        // Resume execution
        const result = await executionService.executeFlowInstance(instanceId);
        
        res.json({
            success: true,
            data: {
                instanceId,
                status: result.status,
                result: result.output
            }
        });
    } catch (error) {
        logger.error('Resume flow instance failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Cancel flow instance
 */
const cancelFlowInstance = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { reason } = req.body;
        
        const instance = await flowInstancesModel.findById(instanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(instance.status)) {
            return res.status(400).json({
                success: false,
                error: `Cannot cancel flow instance with status ${instance.status}`
            });
        }
        
        await flowInstancesModel.update(instanceId, {
            status: 'CANCELLED',
            metadata: JSON.stringify({
                ...JSON.parse(instance.metadata || '{}'),
                cancelReason: reason,
                cancelledAt: new Date().toISOString(),
                cancelledBy: req.user?.id || 'SYSTEM'
            })
        });
        
        res.json({
            success: true,
            message: 'Flow instance cancelled successfully'
        });
    } catch (error) {
        logger.error('Cancel flow instance failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Retry flow instance from a specific step
 */
const retryFlowInstance = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { fromStepId, modifiedPayload } = req.body;
        
        const instance = await flowInstancesModel.findById(instanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        // Update instance for retry
        const currentPayload = JSON.parse(instance.current_payload || '{}');
        const newPayload = { ...currentPayload, ...modifiedPayload };
        
        await flowInstancesModel.update(instanceId, {
            status: 'RUNNING',
            current_step_id: fromStepId || instance.current_step_id,
            current_payload: JSON.stringify(newPayload),
            retry_count: (instance.retry_count || 0) + 1,
            metadata: JSON.stringify({
                ...JSON.parse(instance.metadata || '{}'),
                retriedAt: new Date().toISOString(),
                retriedBy: req.user?.id || 'SYSTEM',
                retryFromStep: fromStepId
            })
        });
        
        // Re-execute
        const result = await executionService.executeFlowInstance(instanceId);
        
        res.json({
            success: true,
            data: {
                instanceId,
                status: result.status,
                result: result.output
            }
        });
    } catch (error) {
        logger.error('Retry flow instance failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Initiate TSQ for a transaction
 */
const initiateTsq = async (req, res) => {
    try {
        const { instanceId } = req.params;
        
        const tsqRequest = await tsqService.createTsqRequest(instanceId, 'MANUAL');
        
        // Execute TSQ immediately
        const result = await tsqService.executeTsqRequest(tsqRequest.id);
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Initiate TSQ failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Initiate reversal for a transaction
 */
const initiateReversal = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { reversalType, reason } = req.body;
        
        const reversalRequest = await reversalService.createReversalRequest(
            instanceId,
            reversalType || 'FULL_REVERSAL',
            reason,
            req.user?.id || 'SYSTEM'
        );
        
        // Execute reversal
        const result = await reversalService.executeReversalRequest(reversalRequest.id);
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Initiate reversal failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get all pending manual intervention instances
 */
const getPendingManualInterventions = async (req, res) => {
    try {
        const instances = await flowInstancesModel.findAll({
            where: { status: 'MANUAL_INTERVENTION' },
            orderBy: 'created_at DESC'
        });
        
        res.json({
            success: true,
            data: instances
        });
    } catch (error) {
        logger.error('Get pending manual interventions failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get active flow instances
 */
const getActiveFlowInstances = async (req, res) => {
    try {
        const { status, eventType, limit = 100, offset = 0 } = req.query;
        
        let query = `
            SELECT fi.*, ev.code as event_type_code, f.name as flow_name
            FROM flow_instances fi
            LEFT JOIN flows f ON fi.flow_id = f.id
            LEFT JOIN event_types ev ON f.event_type_id = ev.id
            WHERE 1=1
        `;
        const values = [];
        let paramIndex = 1;
        
        if (status) {
            query += ` AND fi.status = $${paramIndex++}`;
            values.push(status);
        } else {
            query += ` AND fi.status NOT IN ('COMPLETED', 'CANCELLED')`;
        }
        
        if (eventType) {
            query += ` AND ev.code = $${paramIndex++}`;
            values.push(eventType);
        }
        
        query += ` ORDER BY fi.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        values.push(parseInt(limit), parseInt(offset));
        
        const instances = await flowInstancesModel.raw(query, values);
        
        res.json({
            success: true,
            data: instances
        });
    } catch (error) {
        logger.error('Get active flow instances failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    processRequest,
    getFlowInstanceStatus,
    getFlowInstanceBySession,
    resumeFlowInstance,
    cancelFlowInstance,
    retryFlowInstance,
    initiateTsq,
    initiateReversal,
    getPendingManualInterventions,
    getActiveFlowInstances
};
