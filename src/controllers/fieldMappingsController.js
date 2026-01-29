const { fieldMappingsModel, flowStepsModel } = require('../models');
const logger = require('../utils/logger');

/**
 * Create field mapping for a step
 */
const createFieldMapping = async (req, res) => {
    try {
        const {
            sourceField,
            targetField,
            transformationType,
            transformationConfig,
            defaultValue,
            isRequired,
            swapConfig
        } = req.body;
        
        const mapping = await fieldMappingsModel.create({
            step_id: req.params.stepId,
            source_field: sourceField,
            target_field: targetField,
            transformation_type: transformationType || 'DIRECT',
            transformation_config: transformationConfig ? JSON.stringify(transformationConfig) : null,
            default_value: defaultValue,
            is_required: isRequired || false,
            swap_config: swapConfig ? JSON.stringify(swapConfig) : null
        });
        
        res.status(201).json({
            success: true,
            data: mapping
        });
    } catch (error) {
        logger.error('Create field mapping failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get all field mappings for a step
 */
const getStepFieldMappings = async (req, res) => {
    try {
        const mappings = await fieldMappingsModel.findAll({
            where: { step_id: req.params.stepId }
        });
        res.json({
            success: true,
            data: mappings
        });
    } catch (error) {
        logger.error('Get field mappings failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get field mapping by ID
 */
const getFieldMappingById = async (req, res) => {
    try {
        const mapping = await fieldMappingsModel.findById(req.params.mappingId);
        if (!mapping) {
            return res.status(404).json({
                success: false,
                error: 'Field mapping not found'
            });
        }
        res.json({
            success: true,
            data: mapping
        });
    } catch (error) {
        logger.error('Get field mapping failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Update field mapping
 */
const updateFieldMapping = async (req, res) => {
    try {
        const {
            sourceField,
            targetField,
            transformationType,
            transformationConfig,
            defaultValue,
            isRequired,
            swapConfig
        } = req.body;
        
        const updateData = {};
        if (sourceField) updateData.source_field = sourceField;
        if (targetField) updateData.target_field = targetField;
        if (transformationType) updateData.transformation_type = transformationType;
        if (transformationConfig !== undefined) {
            updateData.transformation_config = transformationConfig ? JSON.stringify(transformationConfig) : null;
        }
        if (defaultValue !== undefined) updateData.default_value = defaultValue;
        if (isRequired !== undefined) updateData.is_required = isRequired;
        if (swapConfig !== undefined) {
            updateData.swap_config = swapConfig ? JSON.stringify(swapConfig) : null;
        }
        
        const mapping = await fieldMappingsModel.update(req.params.mappingId, updateData);
        res.json({
            success: true,
            data: mapping
        });
    } catch (error) {
        logger.error('Update field mapping failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Delete field mapping
 */
const deleteFieldMapping = async (req, res) => {
    try {
        await fieldMappingsModel.delete(req.params.mappingId);
        res.json({
            success: true,
            message: 'Field mapping deleted successfully'
        });
    } catch (error) {
        logger.error('Delete field mapping failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Bulk create field mappings
 */
const bulkCreateFieldMappings = async (req, res) => {
    try {
        const { mappings } = req.body;
        const created = [];
        
        for (const mapping of mappings) {
            const newMapping = await fieldMappingsModel.create({
                step_id: req.params.stepId,
                source_field: mapping.sourceField,
                target_field: mapping.targetField,
                transformation_type: mapping.transformationType || 'DIRECT',
                transformation_config: mapping.transformationConfig ? JSON.stringify(mapping.transformationConfig) : null,
                default_value: mapping.defaultValue,
                is_required: mapping.isRequired || false,
                swap_config: mapping.swapConfig ? JSON.stringify(mapping.swapConfig) : null
            });
            created.push(newMapping);
        }
        
        res.status(201).json({
            success: true,
            data: created
        });
    } catch (error) {
        logger.error('Bulk create field mappings failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Copy field mappings from another step
 */
const copyFieldMappings = async (req, res) => {
    try {
        const { sourceStepId } = req.body;
        const targetStepId = req.params.stepId;
        
        // Get source step mappings
        const sourceMappings = await fieldMappingsModel.findAll({
            where: { step_id: sourceStepId }
        });
        
        const created = [];
        for (const mapping of sourceMappings) {
            const newMapping = await fieldMappingsModel.create({
                step_id: targetStepId,
                source_field: mapping.source_field,
                target_field: mapping.target_field,
                transformation_type: mapping.transformation_type,
                transformation_config: mapping.transformation_config,
                default_value: mapping.default_value,
                is_required: mapping.is_required,
                swap_config: mapping.swap_config
            });
            created.push(newMapping);
        }
        
        res.status(201).json({
            success: true,
            data: created
        });
    } catch (error) {
        logger.error('Copy field mappings failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get predefined field mapping templates
 */
const getFieldMappingTemplates = async (req, res) => {
    try {
        const templates = {
            NEC_SWAPPED: {
                name: 'NEC Swapped Mapping',
                description: 'Standard NEC mapping with swapped bank codes',
                mappings: [
                    { sourceField: 'srcBankCode', targetField: 'destBank', transformationType: 'DIRECT' },
                    { sourceField: 'destBankCode', targetField: 'originBank', transformationType: 'DIRECT' },
                    { sourceField: 'srcAccountNumber', targetField: 'accountToDebit', transformationType: 'DIRECT' },
                    { sourceField: 'destAccountNumber', targetField: 'accountToCredit', transformationType: 'DIRECT' },
                    { sourceField: 'amount', targetField: 'amount', transformationType: 'FORMAT_AMOUNT' },
                    { sourceField: 'requestTimestamp', targetField: 'dateTime', transformationType: 'FORMAT_DATETIME' }
                ]
            },
            FTD_NORMAL: {
                name: 'FTD Normal Mapping',
                description: 'Standard FTD mapping',
                mappings: [
                    { sourceField: 'srcBankCode', targetField: 'originBank', transformationType: 'DIRECT' },
                    { sourceField: 'destBankCode', targetField: 'destBank', transformationType: 'DIRECT' },
                    { sourceField: 'srcAccountNumber', targetField: 'accountToDebit', transformationType: 'DIRECT' },
                    { sourceField: 'destAccountNumber', targetField: 'accountToCredit', transformationType: 'DIRECT' },
                    { sourceField: 'amount', targetField: 'amount', transformationType: 'FORMAT_AMOUNT' },
                    { sourceField: 'narration', targetField: 'narration', transformationType: 'DIRECT' },
                    { sourceField: 'requestTimestamp', targetField: 'dateTime', transformationType: 'FORMAT_DATETIME' }
                ]
            },
            FTC_SWAPPED: {
                name: 'FTC Swapped Mapping',
                description: 'Standard FTC mapping with swapped bank codes',
                mappings: [
                    { sourceField: 'srcBankCode', targetField: 'destBank', transformationType: 'DIRECT' },
                    { sourceField: 'destBankCode', targetField: 'originBank', transformationType: 'DIRECT' },
                    { sourceField: 'srcAccountNumber', targetField: 'accountToCredit', transformationType: 'DIRECT' },
                    { sourceField: 'destAccountNumber', targetField: 'accountToDebit', transformationType: 'DIRECT' },
                    { sourceField: 'amount', targetField: 'amount', transformationType: 'FORMAT_AMOUNT' },
                    { sourceField: 'narration', targetField: 'narration', transformationType: 'DIRECT' },
                    { sourceField: 'requestTimestamp', targetField: 'dateTime', transformationType: 'FORMAT_DATETIME' }
                ]
            }
        };
        
        res.json({
            success: true,
            data: templates
        });
    } catch (error) {
        logger.error('Get field mapping templates failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    createFieldMapping,
    getStepFieldMappings,
    getFieldMappingById,
    updateFieldMapping,
    deleteFieldMapping,
    bulkCreateFieldMappings,
    copyFieldMappings,
    getFieldMappingTemplates
};
