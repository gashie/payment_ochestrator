const flowService = require('../services/flowService');
const { flowStepsModel, stepTransitionsModel, fieldMappingsModel } = require('../models');
const logger = require('../utils/logger');

/**
 * Create flow step
 */
const createFlowStep = async (req, res) => {
    try {
        const step = await flowService.createFlowStep(req.params.flowId, req.body);
        res.status(201).json({
            success: true,
            data: step
        });
    } catch (error) {
        logger.error('Create flow step failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get all steps for a flow
 */
const getFlowSteps = async (req, res) => {
    try {
        const steps = await flowStepsModel.findAll({
            where: { flow_id: req.params.flowId },
            orderBy: 'step_order ASC'
        });
        res.json({
            success: true,
            data: steps
        });
    } catch (error) {
        logger.error('Get flow steps failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get step by ID
 */
const getStepById = async (req, res) => {
    try {
        const step = await flowStepsModel.findById(req.params.stepId);
        if (!step) {
            return res.status(404).json({
                success: false,
                error: 'Step not found'
            });
        }
        
        // Get transitions for this step
        const transitions = await stepTransitionsModel.findAll({
            where: { from_step_id: step.id }
        });
        
        // Get field mappings
        const fieldMappings = await fieldMappingsModel.findAll({
            where: { step_id: step.id }
        });
        
        res.json({
            success: true,
            data: {
                ...step,
                transitions,
                fieldMappings
            }
        });
    } catch (error) {
        logger.error('Get step failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Update flow step
 */
const updateFlowStep = async (req, res) => {
    try {
        const step = await flowStepsModel.update(req.params.stepId, req.body);
        res.json({
            success: true,
            data: step
        });
    } catch (error) {
        logger.error('Update flow step failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Delete flow step
 */
const deleteFlowStep = async (req, res) => {
    try {
        // First delete transitions
        await stepTransitionsModel.deleteWhere({ from_step_id: req.params.stepId });
        await stepTransitionsModel.deleteWhere({ to_step_id: req.params.stepId });
        
        // Delete field mappings
        await fieldMappingsModel.deleteWhere({ step_id: req.params.stepId });
        
        // Delete the step
        await flowStepsModel.delete(req.params.stepId);
        
        res.json({
            success: true,
            message: 'Step deleted successfully'
        });
    } catch (error) {
        logger.error('Delete flow step failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Create step transition
 */
const createTransition = async (req, res) => {
    try {
        const { fromStepId, toStepId, conditionType, conditionConfig, priority } = req.body;
        
        const transition = await stepTransitionsModel.create({
            from_step_id: fromStepId,
            to_step_id: toStepId,
            condition_type: conditionType || 'ALWAYS',
            condition_config: conditionConfig ? JSON.stringify(conditionConfig) : null,
            priority: priority || 0
        });
        
        res.status(201).json({
            success: true,
            data: transition
        });
    } catch (error) {
        logger.error('Create transition failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get transitions for a step
 */
const getStepTransitions = async (req, res) => {
    try {
        const transitions = await stepTransitionsModel.findAll({
            where: { from_step_id: req.params.stepId },
            orderBy: 'priority ASC'
        });
        res.json({
            success: true,
            data: transitions
        });
    } catch (error) {
        logger.error('Get step transitions failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Update transition
 */
const updateTransition = async (req, res) => {
    try {
        const { conditionType, conditionConfig, priority } = req.body;
        
        const updateData = {};
        if (conditionType) updateData.condition_type = conditionType;
        if (conditionConfig) updateData.condition_config = JSON.stringify(conditionConfig);
        if (priority !== undefined) updateData.priority = priority;
        
        const transition = await stepTransitionsModel.update(req.params.transitionId, updateData);
        res.json({
            success: true,
            data: transition
        });
    } catch (error) {
        logger.error('Update transition failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Delete transition
 */
const deleteTransition = async (req, res) => {
    try {
        await stepTransitionsModel.delete(req.params.transitionId);
        res.json({
            success: true,
            message: 'Transition deleted successfully'
        });
    } catch (error) {
        logger.error('Delete transition failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Reorder steps
 */
const reorderSteps = async (req, res) => {
    try {
        const { stepOrder } = req.body; // Array of { stepId, sequenceNumber }
        
        for (const item of stepOrder) {
            await flowStepsModel.update(item.stepId, {
                step_order: item.sequenceNumber
            });
        }
        
        res.json({
            success: true,
            message: 'Steps reordered successfully'
        });
    } catch (error) {
        logger.error('Reorder steps failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    createFlowStep,
    getFlowSteps,
    getStepById,
    updateFlowStep,
    deleteFlowStep,
    createTransition,
    getStepTransitions,
    updateTransition,
    deleteTransition,
    reorderSteps
};
