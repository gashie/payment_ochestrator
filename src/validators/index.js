const Joi = require('joi');

/**
 * Event type validation schemas
 */
const eventTypeSchemas = {
    create: Joi.object({
        code: Joi.string().max(50).required(),
        name: Joi.string().max(255).required(),
        description: Joi.string().allow(null, ''),
        isSync: Joi.boolean().default(false),
        timeout: Joi.number().integer().min(1000).default(30000),
        config: Joi.object().allow(null)
    })
};

/**
 * Flow validation schemas
 */
const flowSchemas = {
    create: Joi.object({
        eventTypeId: Joi.string().uuid().required(),
        name: Joi.string().max(255).required(),
        description: Joi.string().allow(null, ''),
        config: Joi.object().allow(null)
    }),
    update: Joi.object({
        name: Joi.string().max(255),
        description: Joi.string().allow(null, ''),
        status: Joi.string().valid('DRAFT', 'ACTIVE', 'INACTIVE'),
        config: Joi.object().allow(null)
    })
};

/**
 * Flow step validation schemas
 */
const flowStepSchemas = {
    create: Joi.object({
        name: Joi.string().max(255).required(),
        stepType: Joi.string().valid(
            'START', 'END', 'TASK', 'GATEWAY', 'EVENT', 
            'LISTENER', 'CALLBACK', 'API_CALL', 'TRANSFORM', 
            'CONDITION', 'MANUAL', 'ALERT'
        ).required(),
        sequenceNumber: Joi.number().integer().min(0).required(),
        config: Joi.object().allow(null),
        timeout: Joi.number().integer().min(1000),
        retryCount: Joi.number().integer().min(0).default(0),
        retryDelay: Joi.number().integer().min(0).default(0),
        isAsync: Joi.boolean().default(false),
        errorHandling: Joi.string().valid('FAIL', 'SKIP', 'MANUAL', 'RETRY').default('FAIL')
    }),
    update: Joi.object({
        name: Joi.string().max(255),
        stepType: Joi.string().valid(
            'START', 'END', 'TASK', 'GATEWAY', 'EVENT', 
            'LISTENER', 'CALLBACK', 'API_CALL', 'TRANSFORM', 
            'CONDITION', 'MANUAL', 'ALERT'
        ),
        sequenceNumber: Joi.number().integer().min(0),
        config: Joi.object().allow(null),
        timeout: Joi.number().integer().min(1000),
        retryCount: Joi.number().integer().min(0),
        retryDelay: Joi.number().integer().min(0),
        isAsync: Joi.boolean(),
        errorHandling: Joi.string().valid('FAIL', 'SKIP', 'MANUAL', 'RETRY')
    })
};

/**
 * Transition validation schemas
 */
const transitionSchemas = {
    create: Joi.object({
        fromStepId: Joi.string().uuid().required(),
        toStepId: Joi.string().uuid().required(),
        conditionType: Joi.string().valid('ALWAYS', 'CONDITION', 'DEFAULT').default('ALWAYS'),
        conditionConfig: Joi.object().allow(null),
        priority: Joi.number().integer().min(0).default(0)
    }),
    update: Joi.object({
        conditionType: Joi.string().valid('ALWAYS', 'CONDITION', 'DEFAULT'),
        conditionConfig: Joi.object().allow(null),
        priority: Joi.number().integer().min(0)
    })
};

/**
 * Field mapping validation schemas
 */
const fieldMappingSchemas = {
    create: Joi.object({
        sourceField: Joi.string().max(255).required(),
        targetField: Joi.string().max(255).required(),
        transformationType: Joi.string().valid(
            'DIRECT', 'FORMAT_AMOUNT', 'FORMAT_DATETIME', 
            'UPPERCASE', 'LOWERCASE', 'TRIM', 'PAD_START',
            'PAD_END', 'SUBSTRING', 'REPLACE', 'TEMPLATE',
            'CONSTANT', 'CONDITIONAL'
        ).default('DIRECT'),
        transformationConfig: Joi.object().allow(null),
        defaultValue: Joi.string().allow(null, ''),
        isRequired: Joi.boolean().default(false),
        swapConfig: Joi.object().allow(null)
    }),
    update: Joi.object({
        sourceField: Joi.string().max(255),
        targetField: Joi.string().max(255),
        transformationType: Joi.string().valid(
            'DIRECT', 'FORMAT_AMOUNT', 'FORMAT_DATETIME', 
            'UPPERCASE', 'LOWERCASE', 'TRIM', 'PAD_START',
            'PAD_END', 'SUBSTRING', 'REPLACE', 'TEMPLATE',
            'CONSTANT', 'CONDITIONAL'
        ),
        transformationConfig: Joi.object().allow(null),
        defaultValue: Joi.string().allow(null, ''),
        isRequired: Joi.boolean(),
        swapConfig: Joi.object().allow(null)
    }),
    bulkCreate: Joi.object({
        mappings: Joi.array().items(Joi.object({
            sourceField: Joi.string().max(255).required(),
            targetField: Joi.string().max(255).required(),
            transformationType: Joi.string().valid(
                'DIRECT', 'FORMAT_AMOUNT', 'FORMAT_DATETIME', 
                'UPPERCASE', 'LOWERCASE', 'TRIM', 'PAD_START',
                'PAD_END', 'SUBSTRING', 'REPLACE', 'TEMPLATE',
                'CONSTANT', 'CONDITIONAL'
            ).default('DIRECT'),
            transformationConfig: Joi.object().allow(null),
            defaultValue: Joi.string().allow(null, ''),
            isRequired: Joi.boolean().default(false),
            swapConfig: Joi.object().allow(null)
        })).min(1).required()
    })
};

/**
 * Process request validation schemas
 */
const processSchemas = {
    request: Joi.object({
        eventType: Joi.string().max(50).required(),
        payload: Joi.object({
            sessionId: Joi.string().max(20).required(),
            trackingNumber: Joi.string().max(10).required(),
            srcBankCode: Joi.string().max(10),
            destBankCode: Joi.string().max(10),
            srcAccountNumber: Joi.string().max(50),
            destAccountNumber: Joi.string().max(50),
            amount: Joi.alternatives().try(
                Joi.string(),
                Joi.number()
            ),
            narration: Joi.string().max(500),
            dateTime: Joi.string(),
            channelCode: Joi.string().max(10)
        }).required().unknown(true),
        metadata: Joi.object({
            callbackUrl: Joi.string().uri(),
            applicationId: Joi.string().uuid(),
            bankId: Joi.string().uuid(),
            priority: Joi.number().integer().min(0).max(10)
        }).unknown(true)
    }),
    resume: Joi.object({
        action: Joi.string().valid('CONTINUE', 'SKIP', 'RETRY', 'FAIL', 'COMPLETE').required(),
        overrideData: Joi.object().allow(null)
    }),
    cancel: Joi.object({
        reason: Joi.string().max(500).required()
    }),
    retry: Joi.object({
        fromStepId: Joi.string().uuid(),
        modifiedPayload: Joi.object()
    })
};

/**
 * Callback validation schemas
 */
const callbackSchemas = {
    receive: Joi.object({
        sessionId: Joi.string().max(20).required(),
        trackingNumber: Joi.string().max(10).required(),
        actionCode: Joi.string().max(10),
        approvalCode: Joi.string().max(100),
        amount: Joi.string(),
        dateTime: Joi.string(),
        functionCode: Joi.string().max(10),
        originBank: Joi.string().max(10),
        destBank: Joi.string().max(10),
        accountToDebit: Joi.string().max(50),
        accountToCredit: Joi.string().max(50),
        nameToDebit: Joi.string().max(255),
        nameToCredit: Joi.string().max(255),
        narration: Joi.string().max(500),
        channelCode: Joi.string().max(10)
    }).unknown(true),
    manualMatch: Joi.object({
        flowInstanceId: Joi.string().uuid().required(),
        expectedCallbackId: Joi.string().uuid()
    })
};

/**
 * Reversal validation schemas
 */
const reversalSchemas = {
    initiate: Joi.object({
        reversalType: Joi.string().valid('FTD_REVERSAL', 'FTC_REVERSAL', 'FULL_REVERSAL').default('FULL_REVERSAL'),
        reason: Joi.string().max(500).required()
    })
};

/**
 * Validation middleware factory
 */
const validate = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { abortEarly: false });
        
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors
            });
        }
        
        req.body = value;
        next();
    };
};

/**
 * Query validation middleware factory
 */
const validateQuery = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.query, { abortEarly: false });
        
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors
            });
        }
        
        req.query = value;
        next();
    };
};

module.exports = {
    eventTypeSchemas,
    flowSchemas,
    flowStepSchemas,
    transitionSchemas,
    fieldMappingSchemas,
    processSchemas,
    callbackSchemas,
    reversalSchemas,
    validate,
    validateQuery
};
