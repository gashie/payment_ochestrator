const {
    flowInstancesModel,
    stepExecutionsModel,
    expectedCallbacksModel,
    externalApisModel,
    processLogsModel
} = require('../models');
const flowService = require('./flowService');
const configService = require('./configService');
const logger = require('../utils/logger');
const {
    deepClone,
    safeJsonParse,
    applyFieldMappings,
    formatDateTime,
    formatAmount,
    retry,
    sleep,
    shouldTriggerTsq,
    isSuccessResponse
} = require('../utils/helpers');
const axios = require('axios');

const INSTANCE_STATUSES = {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    WAITING_CALLBACK: 'WAITING_CALLBACK',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    MANUAL_INTERVENTION: 'MANUAL_INTERVENTION'
};

const STEP_STATUSES = {
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    SKIPPED: 'SKIPPED',
    WAITING: 'WAITING'
};

/**
 * Create and start a new flow instance
 */
const createFlowInstance = async (params) => {
    const {
        eventTypeCode,
        sessionId,
        trackingNumber,
        inputPayload,
        bfsCallbackUrl,
        metadata = {}
    } = params;

    // Get flow definition
    const flowInfo = await flowService.getFlowByEventType(eventTypeCode);
    if (!flowInfo) {
        throw new Error(`No active flow found for event type: ${eventTypeCode}`);
    }

    const { flow, eventType } = flowInfo;
    const flowDef = await flowService.getFlowDefinition(flow.id);

    // Create flow instance
    const instance = await flowInstancesModel.create({
        flow_id: flow.id,
        session_id: sessionId,
        tracking_number: trackingNumber,
        status: INSTANCE_STATUSES.PENDING,
        original_request: JSON.stringify(inputPayload),
        current_payload: JSON.stringify(inputPayload),
        bfs_callback_url: bfsCallbackUrl,
        metadata: JSON.stringify(metadata)
    });

    logger.info('Flow instance created', {
        instanceId: instance.id,
        flowId: flow.id,
        sessionId,
        eventTypeCode
    });

    // Log process start
    await createProcessLog(instance.id, 'INSTANCE_CREATED', {
        flowName: flow.name,
        eventTypeCode,
        sessionId
    });

    return {
        instance,
        flowDef,
        isSync: flow.is_sync
    };
};

/**
 * Execute a flow instance
 */
const executeFlowInstance = async (instanceId) => {
    const instance = await flowInstancesModel.findById(instanceId);
    if (!instance) {
        throw new Error(`Flow instance not found: ${instanceId}`);
    }

    // Update status to running
    await flowInstancesModel.update(instanceId, {
        status: INSTANCE_STATUSES.RUNNING,
        started_at: new Date()
    });

    const flowDef = await flowService.getFlowDefinition(instance.flow_id);
    let currentPayload = safeJsonParse(instance.current_payload, {});

    // Start from the START step
    const startStep = flowDef.startStep;
    if (!startStep) {
        throw new Error('Flow has no START step');
    }

    try {
        // Execute starting from START step
        const result = await executeFromStep(instance, flowDef, startStep, currentPayload);
        return result;
    } catch (error) {
        logger.error('Flow execution failed', {
            instanceId,
            error: error.message
        });

        await flowInstancesModel.update(instanceId, {
            status: INSTANCE_STATUSES.FAILED,
            last_error: error.message,
            completed_at: new Date()
        });

        await createProcessLog(instanceId, 'INSTANCE_FAILED', {
            error: error.message
        });

        throw error;
    }
};

/**
 * Execute from a specific step
 */
const executeFromStep = async (instance, flowDef, step, payload) => {
    let currentStep = step;
    let currentPayload = deepClone(payload);
    let stepCount = 0;
    const maxSteps = 100; // Safety limit

    while (currentStep && stepCount < maxSteps) {
        stepCount++;

        logger.debug('Executing step', {
            instanceId: instance.id,
            stepId: currentStep.id,
            stepType: currentStep.step_type,
            stepName: currentStep.name
        });

        // Create step execution record
        const stepExecution = await stepExecutionsModel.create({
            flow_instance_id: instance.id,
            step_id: currentStep.id,
            status: STEP_STATUSES.RUNNING,
            input_payload: JSON.stringify(currentPayload),
            started_at: new Date()
        });

        try {
            // Execute the step
            const result = await executeStep(instance, currentStep, currentPayload, stepExecution);

            // Update step execution
            await stepExecutionsModel.update(stepExecution.id, {
                status: result.status,
                output_payload: JSON.stringify(result.outputPayload),
                completed_at: new Date(),
                metadata: JSON.stringify(result.metadata || {})
            });

            // Update instance current payload
            currentPayload = result.outputPayload;
            await flowInstancesModel.update(instance.id, {
                current_payload: JSON.stringify(currentPayload),
                current_step_id: currentStep.id
            });

            // Check if we need to wait (callback, manual intervention)
            if (result.waitForCallback) {
                await flowInstancesModel.update(instance.id, {
                    status: INSTANCE_STATUSES.WAITING_CALLBACK
                });

                await createProcessLog(instance.id, 'WAITING_CALLBACK', {
                    stepId: currentStep.id,
                    stepName: currentStep.name,
                    callbackId: result.callbackId
                });

                return {
                    status: 'WAITING_CALLBACK',
                    instanceId: instance.id,
                    stepId: currentStep.id,
                    payload: currentPayload,
                    callbackId: result.callbackId
                };
            }

            if (result.manualIntervention) {
                await flowInstancesModel.update(instance.id, {
                    status: INSTANCE_STATUSES.MANUAL_INTERVENTION
                });

                return {
                    status: 'MANUAL_INTERVENTION',
                    instanceId: instance.id,
                    stepId: currentStep.id,
                    payload: currentPayload,
                    reason: result.reason
                };
            }

            // Get next step
            currentStep = await flowService.getNextStep(flowDef, currentStep.id, currentPayload);

            // Check if flow is complete (END step or no more steps)
            if (!currentStep || currentStep.step_type === 'END') {
                if (currentStep && currentStep.step_type === 'END') {
                    // Execute END step
                    await stepExecutionsModel.create({
                        flow_instance_id: instance.id,
                        step_id: currentStep.id,
                        status: STEP_STATUSES.COMPLETED,
                        input_payload: JSON.stringify(currentPayload),
                        output_payload: JSON.stringify(currentPayload),
                        started_at: new Date(),
                        completed_at: new Date()
                    });
                }

                // Complete the instance
                // For sync flows, mark callback_sent = true since response is returned directly
                const isSync = flowDef.flow && flowDef.flow.is_sync;
                await flowInstancesModel.update(instance.id, {
                    status: INSTANCE_STATUSES.COMPLETED,
                    final_response: JSON.stringify(currentPayload),
                    completed_at: new Date(),
                    callback_sent: isSync ? true : false
                });

                await createProcessLog(instance.id, 'INSTANCE_COMPLETED', {
                    finalPayload: currentPayload
                });

                return {
                    status: 'COMPLETED',
                    instanceId: instance.id,
                    payload: currentPayload
                };
            }

        } catch (error) {
            // Update step as failed
            await stepExecutionsModel.update(stepExecution.id, {
                status: STEP_STATUSES.FAILED,
                error_message: error.message,
                completed_at: new Date()
            });

            // Check if we should retry
            const retryConfig = safeJsonParse(currentStep.retry_config, { max_retries: 0 });
            if (stepExecution.attempt_number < (retryConfig.max_retries || 0)) {
                await stepExecutionsModel.update(stepExecution.id, {
                    attempt_number: (stepExecution.attempt_number || 1) + 1
                });

                await sleep(retryConfig.retry_interval_ms || 5000);
                continue; // Retry the same step
            }

            throw error;
        }
    }

    if (stepCount >= maxSteps) {
        throw new Error('Flow execution exceeded maximum step limit');
    }

    return {
        status: 'COMPLETED',
        instanceId: instance.id,
        payload: currentPayload
    };
};

/**
 * Execute a single step
 */
const executeStep = async (instance, step, payload, stepExecution) => {
    const stepType = step.step_type;
    const config = safeJsonParse(step.config, {});

    switch (stepType) {
        case 'START':
            return executeStartStep(step, payload);

        case 'END':
            return executeEndStep(step, payload);

        case 'TRANSFORM':
            return executeTransformStep(step, payload, stepExecution);

        case 'API_CALL':
            return executeApiCallStep(instance, step, payload, stepExecution);

        case 'LISTENER':
        case 'CALLBACK':
            return executeCallbackStep(instance, step, payload, stepExecution);

        case 'CONDITION':
        case 'GATEWAY':
            return executeConditionStep(step, payload);

        case 'MANUAL':
            return executeManualStep(step, payload);

        case 'ALERT':
            return executeAlertStep(instance, step, payload);

        case 'TASK':
            return executeTaskStep(instance, step, payload);

        default:
            logger.warn('Unknown step type', { stepType, stepId: step.id });
            return { status: STEP_STATUSES.COMPLETED, outputPayload: payload };
    }
};

/**
 * Execute START step
 */
const executeStartStep = async (step, payload) => {
    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: payload
    };
};

/**
 * Execute END step
 */
const executeEndStep = async (step, payload) => {
    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: payload
    };
};

/**
 * Execute TRANSFORM step - apply field mappings
 */
const executeTransformStep = async (step, payload, stepExecution) => {
    // Handle fieldMappings from multiple sources:
    // 1. step.fieldMappings.input (from flowService mapping)
    // 2. step.fieldMappings (if it's an array directly)
    // 3. step.input_mapping (raw from database, parsed)
    let mappings = [];

    if (step.fieldMappings) {
        if (Array.isArray(step.fieldMappings)) {
            mappings = step.fieldMappings;
        } else if (Array.isArray(step.fieldMappings.input)) {
            mappings = step.fieldMappings.input;
        } else if (typeof step.fieldMappings.input === 'object') {
            // Handle case where input is an object (from safeJsonParse default)
            mappings = [];
        }
    }

    // Fallback: check raw input_mapping from step
    if (mappings.length === 0 && step.input_mapping) {
        const parsed = safeJsonParse(step.input_mapping, []);
        if (Array.isArray(parsed)) {
            mappings = parsed;
        }
    }

    const config = safeJsonParse(step.config, {});

    if (mappings.length === 0 && !config.transformations) {
        return {
            status: STEP_STATUSES.COMPLETED,
            outputPayload: payload
        };
    }

    let transformedPayload = deepClone(payload);

    // Apply field mappings
    if (mappings.length > 0) {
        const swapConfig = config.swapConfig || null;
        const mappedData = applyFieldMappings(payload, mappings, swapConfig);
        transformedPayload = { ...transformedPayload, ...mappedData };
    }

    // Apply additional transformations from config
    if (config.transformations) {
        for (const transform of config.transformations) {
            transformedPayload = applyTransform(transformedPayload, transform);
        }
    }

    // Save the transformed payload to step execution
    if (stepExecution) {
        await stepExecutionsModel.update(stepExecution.id, {
            transformed_payload: JSON.stringify(transformedPayload)
        });
    }

    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: transformedPayload
    };
};

/**
 * Apply a single transformation
 */
const applyTransform = (payload, transform) => {
    const { type, field, value, sourceField } = transform;
    const result = deepClone(payload);

    switch (type) {
        case 'set':
            result[field] = value;
            break;
        case 'copy':
            result[field] = payload[sourceField];
            break;
        case 'delete':
            delete result[field];
            break;
        case 'formatAmount':
            result[field] = formatAmount(payload[sourceField || field]);
            break;
        case 'formatDateTime':
            result[field] = formatDateTime(new Date());
            break;
        default:
            break;
    }

    return result;
};

/**
 * Execute API_CALL step - call external API
 */
const executeApiCallStep = async (instance, step, payload, stepExecution) => {
    const config = safeJsonParse(step.config, {});
    const { apiId, method = 'POST', pathTemplate, includeCallback = false } = config;

    // Get external API configuration
    let apiConfig;
    if (apiId) {
        apiConfig = await externalApisModel.findById(apiId);
    } else if (config.url) {
        apiConfig = { base_url: config.url };
    }

    if (!apiConfig) {
        throw new Error(`External API configuration not found for step: ${step.id}`);
    }

    // Build request URL
    let url = apiConfig.base_url;
    if (pathTemplate) {
        url += interpolateTemplate(pathTemplate, payload);
    }

    // Apply field mappings for request body
    let requestBody = deepClone(payload);
    if (step.fieldMappings && step.fieldMappings.length > 0) {
        const swapConfig = config.swapConfig || null;
        requestBody = applyFieldMappings(payload, step.fieldMappings, swapConfig);
    }

    // Add callback URL if needed (from database config or env var)
    if (includeCallback) {
        const baseUrl = await configService.getOrchestratorBaseUrl();
        requestBody.callbackUrl = `${baseUrl}/api/v1/callbacks/receive/${instance.id}/${stepExecution.id}`;
    }

    // Build headers
    const headers = {
        'Content-Type': 'application/json',
        ...safeJsonParse(apiConfig.default_headers, {}),
        ...config.headers
    };

    logger.info('Calling external API', {
        instanceId: instance.id,
        stepId: step.id,
        url,
        method
    });

    // Save the API request before making the call
    await stepExecutionsModel.update(stepExecution.id, {
        api_request: JSON.stringify({
            url,
            method,
            headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined },
            body: requestBody
        }),
        transformed_payload: JSON.stringify(requestBody)
    });

    const startTime = Date.now();

    try {
        const response = await axios({
            method,
            url,
            data: requestBody,
            headers,
            timeout: step.timeout_ms || 30000
        });

        const responseTime = Date.now() - startTime;
        const responseData = response.data;

        // Filter out null/undefined values from response before merging
        const nonNullResponseFields = {};
        if (typeof responseData === 'object' && responseData !== null) {
            for (const [key, value] of Object.entries(responseData)) {
                if (value !== null && value !== undefined) {
                    nonNullResponseFields[key] = value;
                }
            }
        }

        // Merge response with payload - only non-null response values overwrite
        const outputPayload = {
            ...payload,
            apiResponse: responseData,
            ...nonNullResponseFields
        };

        // Update step execution with response
        await stepExecutionsModel.update(stepExecution.id, {
            api_response: JSON.stringify(responseData),
            api_status_code: response.status,
            api_response_time_ms: responseTime
        });

        // Check if callback is expected
        if (includeCallback) {
            // Register expected callback
            await expectedCallbacksModel.create({
                flow_instance_id: instance.id,
                step_execution_id: stepExecution.id,
                session_id: payload.sessionId,
                tracking_number: payload.trackingNumber,
                callback_type: config.callbackType || 'API_RESPONSE',
                status: 'PENDING',
                match_fields: JSON.stringify(config.expectedCallbackFields || ['actionCode']),
                expected_by: new Date(Date.now() + (config.callbackTimeout || 300000))
            });

            return {
                status: STEP_STATUSES.WAITING,
                outputPayload,
                waitForCallback: true,
                callbackId: stepExecution.id
            };
        }

        // Check if response indicates we need TSQ
        const actionCode = responseData.actionCode;
        if (shouldTriggerTsq(actionCode)) {
            outputPayload.needsTsq = true;
            outputPayload.tsqReason = actionCode;
        }

        return {
            status: STEP_STATUSES.COMPLETED,
            outputPayload
        };

    } catch (error) {
        const responseTime = Date.now() - startTime;

        logger.error('API call failed', {
            instanceId: instance.id,
            stepId: step.id,
            error: error.message,
            responseTime
        });

        await stepExecutionsModel.update(stepExecution.id, {
            api_response: JSON.stringify(error.response?.data || { error: error.message }),
            api_status_code: error.response?.status || 0,
            api_response_time_ms: responseTime,
            error_message: error.message,
            error_details: JSON.stringify({
                code: error.code,
                status: error.response?.status,
                statusText: error.response?.statusText
            })
        });

        throw error;
    }
};

/**
 * Execute CALLBACK/LISTENER step - wait for callback
 */
const executeCallbackStep = async (instance, step, payload, stepExecution) => {
    const config = safeJsonParse(step.config, {});

    // Register expected callback
    await expectedCallbacksModel.create({
        flow_instance_id: instance.id,
        step_execution_id: stepExecution.id,
        session_id: payload.sessionId,
        tracking_number: payload.trackingNumber,
        callback_type: config.callbackType || 'CALLBACK',
        status: 'PENDING',
        match_fields: JSON.stringify(config.expectedFields || ['actionCode']),
        expected_by: new Date(Date.now() + (config.timeout || 300000))
    });

    return {
        status: STEP_STATUSES.WAITING,
        outputPayload: payload,
        waitForCallback: true,
        callbackId: stepExecution.id
    };
};

/**
 * Execute CONDITION/GATEWAY step
 */
const executeConditionStep = async (step, payload) => {
    // Condition evaluation happens in transition selection
    // This step just passes through
    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: payload
    };
};

/**
 * Execute MANUAL step - requires human intervention
 */
const executeManualStep = async (step, payload) => {
    const config = safeJsonParse(step.config, {});

    return {
        status: STEP_STATUSES.WAITING,
        outputPayload: payload,
        manualIntervention: true,
        reason: config.reason || 'Manual intervention required'
    };
};

/**
 * Execute ALERT step
 */
const executeAlertStep = async (instance, step, payload) => {
    const config = safeJsonParse(step.config, {});

    // Create alert (would integrate with alert service)
    logger.info('Alert step executed', {
        instanceId: instance.id,
        stepId: step.id,
        alertType: config.alertType,
        message: interpolateTemplate(config.messageTemplate || '', payload)
    });

    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: payload,
        metadata: { alertSent: true }
    };
};

/**
 * Execute generic TASK step
 */
const executeTaskStep = async (instance, step, payload) => {
    const config = safeJsonParse(step.config, {});

    // Execute based on task type
    switch (config.taskType) {
        case 'log':
            logger.info('Task log', {
                instanceId: instance.id,
                message: interpolateTemplate(config.message || '', payload)
            });
            break;

        case 'delay':
            await sleep(config.delayMs || 1000);
            break;

        case 'validate':
            // Add validation logic
            break;

        default:
            break;
    }

    return {
        status: STEP_STATUSES.COMPLETED,
        outputPayload: payload
    };
};

/**
 * Interpolate template string with payload values
 */
const interpolateTemplate = (template, data) => {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return data[key] !== undefined ? data[key] : match;
    });
};

/**
 * Create process log entry
 */
const createProcessLog = async (instanceId, logType, details = {}) => {
    try {
        await processLogsModel.create({
            flow_instance_id: instanceId,
            log_type: logType,
            message: logType,
            details: JSON.stringify(details)
        });
    } catch (error) {
        logger.error('Failed to create process log', { error: error.message });
    }
};

/**
 * Resume flow instance after callback received
 */
const resumeAfterCallback = async (instanceId, stepExecutionId, callbackPayload) => {
    const instance = await flowInstancesModel.findById(instanceId);
    if (!instance) {
        throw new Error(`Flow instance not found: ${instanceId}`);
    }

    const stepExecution = await stepExecutionsModel.findById(stepExecutionId);
    if (!stepExecution) {
        throw new Error(`Step execution not found: ${stepExecutionId}`);
    }

    // Get flow definition
    const flowDef = await flowService.getFlowDefinition(instance.flow_id);

    // Merge callback payload with current payload
    let currentPayload = safeJsonParse(instance.current_payload, {});
    currentPayload = {
        ...currentPayload,
        callbackResponse: callbackPayload,
        ...callbackPayload
    };

    // Update step execution with callback data
    await stepExecutionsModel.update(stepExecutionId, {
        status: STEP_STATUSES.COMPLETED,
        output_payload: JSON.stringify(currentPayload),
        callback_payload: JSON.stringify(callbackPayload),
        callback_received: true,
        callback_received_at: new Date(),
        action_code: callbackPayload.actionCode,
        approval_code: callbackPayload.approvalCode,
        response_code: callbackPayload.responseCode,
        response_message: callbackPayload.responseMessage || callbackPayload.narration,
        completed_at: new Date()
    });

    // Update instance
    await flowInstancesModel.update(instanceId, {
        status: INSTANCE_STATUSES.RUNNING,
        current_payload: JSON.stringify(currentPayload)
    });

    // Get current step and continue
    const currentStep = flowDef.steps.find(s => s.id === stepExecution.step_id);
    const nextStep = await flowService.getNextStep(flowDef, currentStep.id, currentPayload);

    if (!nextStep) {
        // Flow complete
        await flowInstancesModel.update(instanceId, {
            status: INSTANCE_STATUSES.COMPLETED,
            final_response: JSON.stringify(currentPayload),
            completed_at: new Date()
        });

        return {
            status: 'COMPLETED',
            instanceId,
            payload: currentPayload
        };
    }

    // Refresh instance data
    const refreshedInstance = await flowInstancesModel.findById(instanceId);

    // Continue execution
    return executeFromStep(refreshedInstance, flowDef, nextStep, currentPayload);
};

/**
 * Get flow instance status
 */
const getInstanceStatus = async (instanceId) => {
    const instance = await flowInstancesModel.findById(instanceId);
    if (!instance) {
        return null;
    }

    const stepExecutions = await stepExecutionsModel.findAll({
        where: { flow_instance_id: instanceId },
        orderBy: 'started_at ASC'
    });

    return {
        instance,
        stepExecutions,
        currentPayload: safeJsonParse(instance.current_payload, {}),
        outputPayload: safeJsonParse(instance.final_response, null)
    };
};

module.exports = {
    createFlowInstance,
    executeFlowInstance,
    executeFromStep,
    executeStep,
    resumeAfterCallback,
    getInstanceStatus,
    createProcessLog,
    INSTANCE_STATUSES,
    STEP_STATUSES
};
