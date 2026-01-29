const flowService = require('../services/flowService');
const logger = require('../utils/logger');

/**
 * Create new event type
 */
const createEventType = async (req, res) => {
    try {
        const eventType = await flowService.createEventType(req.body);
        res.status(201).json({
            success: true,
            data: eventType
        });
    } catch (error) {
        logger.error('Create event type failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get all event types
 */
const getEventTypes = async (req, res) => {
    try {
        const eventTypes = await flowService.getEventTypes();
        res.json({
            success: true,
            data: eventTypes
        });
    } catch (error) {
        logger.error('Get event types failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Create new flow
 */
const createFlow = async (req, res) => {
    try {
        const flow = await flowService.createFlow(req.body);
        res.status(201).json({
            success: true,
            data: flow
        });
    } catch (error) {
        logger.error('Create flow failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get all flows
 */
const getFlows = async (req, res) => {
    try {
        const { eventTypeId, status } = req.query;
        const flows = await flowService.getFlows({ eventTypeId, status });
        res.json({
            success: true,
            data: flows
        });
    } catch (error) {
        logger.error('Get flows failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get flow by ID
 */
const getFlowById = async (req, res) => {
    try {
        const flow = await flowService.getFlowById(req.params.id);
        if (!flow) {
            return res.status(404).json({
                success: false,
                error: 'Flow not found'
            });
        }
        res.json({
            success: true,
            data: flow
        });
    } catch (error) {
        logger.error('Get flow failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Update flow
 */
const updateFlow = async (req, res) => {
    try {
        const flow = await flowService.updateFlow(req.params.id, req.body);
        res.json({
            success: true,
            data: flow
        });
    } catch (error) {
        logger.error('Update flow failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Create flow version
 */
const createFlowVersion = async (req, res) => {
    try {
        const version = await flowService.createFlowVersion(req.params.id, req.body);
        res.status(201).json({
            success: true,
            data: version
        });
    } catch (error) {
        logger.error('Create flow version failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get flow versions
 */
const getFlowVersions = async (req, res) => {
    try {
        const versions = await flowService.getFlowVersions(req.params.id);
        res.json({
            success: true,
            data: versions
        });
    } catch (error) {
        logger.error('Get flow versions failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Activate flow version
 */
const activateFlowVersion = async (req, res) => {
    try {
        const version = await flowService.activateFlowVersion(
            req.params.id, 
            req.params.versionId
        );
        res.json({
            success: true,
            data: version
        });
    } catch (error) {
        logger.error('Activate flow version failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get BPMN diagram for flow
 */
const getFlowBpmnDiagram = async (req, res) => {
    try {
        const diagram = await flowService.generateBpmnDiagram(req.params.id);
        res.json({
            success: true,
            data: diagram
        });
    } catch (error) {
        logger.error('Get BPMN diagram failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Clone flow
 */
const cloneFlow = async (req, res) => {
    try {
        const { name, description } = req.body;
        const flow = await flowService.cloneFlow(req.params.id, { name, description });
        res.status(201).json({
            success: true,
            data: flow
        });
    } catch (error) {
        logger.error('Clone flow failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Delete flow
 */
const deleteFlow = async (req, res) => {
    try {
        await flowService.deleteFlow(req.params.id);
        res.json({
            success: true,
            message: 'Flow deleted successfully'
        });
    } catch (error) {
        logger.error('Delete flow failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    createEventType,
    getEventTypes,
    createFlow,
    getFlows,
    getFlowById,
    updateFlow,
    createFlowVersion,
    getFlowVersions,
    activateFlowVersion,
    getFlowBpmnDiagram,
    cloneFlow,
    deleteFlow
};
