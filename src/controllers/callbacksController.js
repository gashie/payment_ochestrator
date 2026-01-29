const callbackService = require('../services/callbackService');
const { expectedCallbacksModel, receivedCallbacksModel, flowInstancesModel } = require('../models');
const logger = require('../utils/logger');

/**
 * Receive callback from external API (e.g., GIP)
 */
const receiveCallback = async (req, res) => {
    try {
        const payload = req.body;
        const { sessionId, trackingNumber } = payload;
        
        logger.info('Received callback', { sessionId, trackingNumber });
        
        // Process the callback
        const result = await callbackService.processIncomingCallback(payload);
        
        res.json({
            success: true,
            data: {
                message: 'Callback received and processed',
                matched: result.matched,
                flowInstanceId: result.flowInstanceId
            }
        });
    } catch (error) {
        logger.error('Receive callback failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Receive FTD callback
 */
const receiveFtdCallback = async (req, res) => {
    try {
        const payload = req.body;
        
        logger.info('Received FTD callback', { 
            sessionId: payload.sessionId, 
            trackingNumber: payload.trackingNumber,
            actionCode: payload.actionCode 
        });
        
        const result = await callbackService.processIncomingCallback({
            ...payload,
            callbackType: 'FTD'
        });
        
        res.json({
            success: true,
            data: {
                message: 'FTD callback received',
                matched: result.matched
            }
        });
    } catch (error) {
        logger.error('Receive FTD callback failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Receive FTC callback
 */
const receiveFtcCallback = async (req, res) => {
    try {
        const payload = req.body;
        
        logger.info('Received FTC callback', { 
            sessionId: payload.sessionId, 
            trackingNumber: payload.trackingNumber,
            actionCode: payload.actionCode 
        });
        
        const result = await callbackService.processIncomingCallback({
            ...payload,
            callbackType: 'FTC'
        });
        
        res.json({
            success: true,
            data: {
                message: 'FTC callback received',
                matched: result.matched
            }
        });
    } catch (error) {
        logger.error('Receive FTC callback failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get expected callbacks
 */
const getExpectedCallbacks = async (req, res) => {
    try {
        const { status, flowInstanceId, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (status) where.status = status;
        if (flowInstanceId) where.flow_instance_id = flowInstanceId;
        
        const callbacks = await expectedCallbacksModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get expected callbacks failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get received callbacks
 */
const getReceivedCallbacks = async (req, res) => {
    try {
        const { matched, sessionId, limit = 100, offset = 0 } = req.query;
        
        let where = {};
        if (matched !== undefined) where.matched = matched === 'true';
        if (sessionId) where.session_id = sessionId;
        
        const callbacks = await receivedCallbacksModel.findAll({
            where,
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get received callbacks failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get callback by ID
 */
const getCallbackById = async (req, res) => {
    try {
        const callback = await receivedCallbacksModel.findById(req.params.id);
        if (!callback) {
            return res.status(404).json({
                success: false,
                error: 'Callback not found'
            });
        }
        
        res.json({
            success: true,
            data: callback
        });
    } catch (error) {
        logger.error('Get callback failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Manually match unmatched callback
 */
const manuallyMatchCallback = async (req, res) => {
    try {
        const { callbackId } = req.params;
        const { flowInstanceId, expectedCallbackId } = req.body;
        
        // Get the unmatched callback
        const callback = await receivedCallbacksModel.findById(callbackId);
        if (!callback) {
            return res.status(404).json({
                success: false,
                error: 'Callback not found'
            });
        }
        
        if (callback.matched) {
            return res.status(400).json({
                success: false,
                error: 'Callback is already matched'
            });
        }
        
        // Update callback as matched
        await receivedCallbacksModel.update(callbackId, {
            matched: true,
            flow_instance_id: flowInstanceId,
            expected_callback_id: expectedCallbackId,
            matched_at: new Date()
        });
        
        // Update expected callback if provided
        if (expectedCallbackId) {
            await expectedCallbacksModel.update(expectedCallbackId, {
                status: 'RECEIVED',
                received_callback_id: callbackId,
                received_at: new Date()
            });
        }
        
        // Resume the flow instance
        const result = await callbackService.resumeAfterCallback(flowInstanceId, callback.payload);
        
        res.json({
            success: true,
            data: {
                message: 'Callback manually matched and flow resumed',
                result
            }
        });
    } catch (error) {
        logger.error('Manual callback match failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get pending callbacks (expected but not received)
 */
const getPendingCallbacks = async (req, res) => {
    try {
        const callbacks = await expectedCallbacksModel.findAll({
            where: { status: 'PENDING' },
            orderBy: 'timeout_at ASC'
        });
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get pending callbacks failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get timed out callbacks
 */
const getTimedOutCallbacks = async (req, res) => {
    try {
        const callbacks = await expectedCallbacksModel.findAll({
            where: { status: 'TIMEOUT' },
            orderBy: 'timeout_at DESC'
        });
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get timed out callbacks failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Retry sending callback to BFS
 */
const retryBfsCallback = async (req, res) => {
    try {
        const { flowInstanceId } = req.params;
        
        const instance = await flowInstancesModel.findById(flowInstanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }
        
        const result = await callbackService.sendCallbackToBfs(flowInstanceId, true);
        
        res.json({
            success: true,
            data: {
                message: 'BFS callback retry initiated',
                result
            }
        });
    } catch (error) {
        logger.error('Retry BFS callback failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get unmatched callbacks
 */
const getUnmatchedCallbacks = async (req, res) => {
    try {
        const { limit = 100, offset = 0 } = req.query;
        
        const callbacks = await receivedCallbacksModel.findAll({
            where: { matched: false },
            orderBy: 'created_at DESC',
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        res.json({
            success: true,
            data: callbacks
        });
    } catch (error) {
        logger.error('Get unmatched callbacks failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    receiveCallback,
    receiveFtdCallback,
    receiveFtcCallback,
    getExpectedCallbacks,
    getReceivedCallbacks,
    getCallbackById,
    manuallyMatchCallback,
    getPendingCallbacks,
    getTimedOutCallbacks,
    retryBfsCallback,
    getUnmatchedCallbacks
};
