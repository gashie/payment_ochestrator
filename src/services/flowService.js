const {
    flowsModel,
    flowVersionsModel,
    flowStepsModel,
    stepTransitionsModel,
    fieldMappingsModel,
    eventTypesModel,
    flowInstancesModel
} = require('../models');
const logger = require('../utils/logger');
const { deepClone, safeJsonParse } = require('../utils/helpers');

/**
 * Get flow by event type code
 */
const getFlowByEventType = async (eventTypeCode) => {
    // Find active event type
    const eventType = await eventTypesModel.findOne({ event_code: eventTypeCode, is_active: true });
    if (!eventType) {
        logger.warn('Event type not found or inactive', { eventTypeCode });
        return null;
    }

    // Find active flow for this event type
    const flow = await flowsModel.findOne({ 
        event_type_id: eventType.id, 
        is_active: true 
    });

    if (!flow) {
        logger.warn('No active flow found for event type', { eventTypeCode });
        return null;
    }

    return { flow, eventType };
};

/**
 * Get complete flow definition with all steps and transitions
 */
const getFlowDefinition = async (flowId, version = null) => {
    // Get flow
    const flow = await flowsModel.findById(flowId);
    if (!flow) {
        throw new Error(`Flow not found: ${flowId}`);
    }

    // Get specific version or active version
    let flowVersion;
    if (version) {
        flowVersion = await flowVersionsModel.findOne({ 
            flow_id: flowId, 
            version: version 
        });
    } else {
        flowVersion = await flowVersionsModel.findOne({ 
            flow_id: flowId, 
            is_active: true 
        });
    }

    if (!flowVersion) {
        const allVersions = await flowVersionsModel.findAll({ where: { flow_id: flowId } });
        logger.error('Flow version not found', new Error(`No active version found for flow: ${flowId}`), {
            flowId,
            requestedVersion: version,
            availableVersions: allVersions.length
        });
        throw new Error(`No active version found for flow: ${flowId}. Available versions: ${allVersions.length}. Please run seed script or create a flow version.`);
    }

    // Get all steps for this flow version
    const steps = await flowStepsModel.findAll({
        where: { flow_id: flowId },
        orderBy: 'step_order ASC'
    });

    // Get all transitions
    const stepIds = steps.map(s => s.id);
    let transitions = [];
    if (stepIds.length > 0) {
        transitions = await stepTransitionsModel.raw(`
            SELECT * FROM step_transitions
            WHERE from_step_id = ANY($1) OR to_step_id = ANY($1)
            ORDER BY priority ASC
        `, [stepIds]);
    }

    // Get field mappings for each step (from step's built-in mapping fields)
    const stepsWithMappings = steps.map((step) => {
        // Parse input_mapping - can be array of mappings, default to empty array
        const parsedInput = safeJsonParse(step.input_mapping);
        const parsedOutput = safeJsonParse(step.output_mapping);
        const inputMapping = Array.isArray(parsedInput) ? parsedInput : [];
        const outputMapping = Array.isArray(parsedOutput) ? parsedOutput : [];
        return { ...step, fieldMappings: { input: inputMapping, output: outputMapping } };
    });

    // Find start and end steps
    const startStep = stepsWithMappings.find(s => s.step_type === 'START');
    const endSteps = stepsWithMappings.filter(s => s.step_type === 'END');

    // Build step graph
    const stepGraph = buildStepGraph(stepsWithMappings, transitions);

    return {
        flow,
        version: flowVersion,
        steps: stepsWithMappings,
        transitions,
        startStep,
        endSteps,
        stepGraph
    };
};

/**
 * Build a graph representation of steps and transitions
 */
const buildStepGraph = (steps, transitions) => {
    const graph = {};
    
    for (const step of steps) {
        graph[step.id] = {
            step,
            outgoing: [],
            incoming: []
        };
    }

    for (const transition of transitions) {
        if (graph[transition.from_step_id]) {
            graph[transition.from_step_id].outgoing.push(transition);
        }
        if (graph[transition.to_step_id]) {
            graph[transition.to_step_id].incoming.push(transition);
        }
    }

    return graph;
};

/**
 * Get next step based on current step and conditions
 */
const getNextStep = async (flowDefinition, currentStepId, executionData) => {
    const { stepGraph, steps } = flowDefinition;
    const currentNode = stepGraph[currentStepId];

    if (!currentNode) {
        throw new Error(`Step not found in graph: ${currentStepId}`);
    }

    // First try explicit transitions
    const outgoingTransitions = currentNode.outgoing
        .sort((a, b) => a.priority - b.priority);

    for (const transition of outgoingTransitions) {
        // Evaluate condition
        if (evaluateTransitionCondition(transition, executionData)) {
            const nextStepNode = stepGraph[transition.to_step_id];
            if (nextStepNode) {
                return nextStepNode.step;
            }
        }
    }

    // Fallback to step_order if no explicit transitions
    if (outgoingTransitions.length === 0) {
        const currentStep = currentNode.step;
        const currentOrder = currentStep.step_order;

        // Handle CONDITION steps - evaluate condition_config to branch
        if (currentStep.step_type === 'CONDITION') {
            const config = safeJsonParse(currentStep.config, {});
            const conditionField = config.condition_field;
            const successValues = config.success_values || [];
            const failureValues = config.failure_values || [];

            if (conditionField) {
                const fieldValue = getFieldValue(executionData, conditionField);

                // Check for failure first
                if (failureValues.includes(fieldValue)) {
                    // Find failure path step (usually ends with FAIL)
                    const failStep = steps.find(s =>
                        s.step_code.includes('FAIL') &&
                        s.step_code.startsWith(currentStep.step_code.replace('_CHECK', ''))
                    );
                    if (failStep) return failStep;
                }

                // Check for success
                if (successValues.includes(fieldValue)) {
                    // Continue to next step by order
                    const nextStep = steps.find(s => s.step_order === currentOrder + 1);
                    return nextStep || null;
                }

                // If value doesn't match any, treat as failure
                logger.warn('Condition value not in success or failure values', {
                    step: currentStep.step_code,
                    field: conditionField,
                    value: fieldValue
                });

                // Default to failure path for unknown values
                const failStep = steps.find(s =>
                    s.step_code.includes('FAIL') &&
                    s.step_order > currentOrder
                );
                return failStep || null;
            }
        }

        // For non-CONDITION steps, simply get next by step_order
        const nextStep = steps.find(s => s.step_order === currentOrder + 1);
        return nextStep || null;
    }

    // No valid transition found
    return null;
};

/**
 * Evaluate transition condition
 */
const evaluateTransitionCondition = (transition, data) => {
    if (!transition.condition_expression) {
        return true; // No condition means always true
    }

    try {
        const condition = safeJsonParse(transition.condition_expression);
        if (!condition) return true;

        return evaluateConditionObject(condition, data);
    } catch (error) {
        logger.error('Failed to evaluate transition condition', { 
            transitionId: transition.id, 
            error: error.message 
        });
        return false;
    }
};

/**
 * Evaluate condition object against data
 */
const evaluateConditionObject = (condition, data) => {
    if (!condition || typeof condition !== 'object') {
        return true;
    }

    // Handle logical operators
    if (condition.$and) {
        return condition.$and.every(c => evaluateConditionObject(c, data));
    }
    if (condition.$or) {
        return condition.$or.some(c => evaluateConditionObject(c, data));
    }
    if (condition.$not) {
        return !evaluateConditionObject(condition.$not, data);
    }

    // Handle field conditions
    for (const [field, value] of Object.entries(condition)) {
        if (field.startsWith('$')) continue;

        const actualValue = getFieldValue(data, field);

        if (typeof value === 'object' && value !== null) {
            // Operator-based condition
            for (const [op, expected] of Object.entries(value)) {
                if (!evaluateOperator(actualValue, op, expected)) {
                    return false;
                }
            }
        } else {
            // Direct equality
            if (actualValue !== value) {
                return false;
            }
        }
    }

    return true;
};

/**
 * Evaluate a comparison operator
 */
const evaluateOperator = (actual, operator, expected) => {
    switch (operator) {
        case '$eq': return actual === expected;
        case '$ne': return actual !== expected;
        case '$gt': return actual > expected;
        case '$gte': return actual >= expected;
        case '$lt': return actual < expected;
        case '$lte': return actual <= expected;
        case '$in': return Array.isArray(expected) && expected.includes(actual);
        case '$nin': return Array.isArray(expected) && !expected.includes(actual);
        case '$exists': return expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;
        case '$regex': return typeof actual === 'string' && new RegExp(expected).test(actual);
        case '$startsWith': return typeof actual === 'string' && actual.startsWith(expected);
        case '$endsWith': return typeof actual === 'string' && actual.endsWith(expected);
        case '$contains': return typeof actual === 'string' && actual.includes(expected);
        default: return actual === expected;
    }
};

/**
 * Get field value from nested object using dot notation
 */
const getFieldValue = (data, field) => {
    if (!data || !field) return undefined;
    
    const parts = field.split('.');
    let value = data;
    
    for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    
    return value;
};

/**
 * Create a new flow
 */
const createFlow = async (flowData) => {
    const {
        name,
        description,
        eventTypeCode,
        isSync = false,
        timeoutMs = 60000,
        metadata = {}
    } = flowData;

    // Get or create event type
    let eventType = await eventTypesModel.findOne({ event_code: eventTypeCode });
    if (!eventType) {
        eventType = await eventTypesModel.create({
            event_code: eventTypeCode,
            event_name: eventTypeCode,
            description: `Event type for ${eventTypeCode}`,
            is_active: true
        });
    }

    // Create flow
    const flow = await flowsModel.create({
        name,
        description,
        event_type_id: eventType.id,
        is_sync: isSync,
        timeout_ms: timeoutMs,
        is_active: true,
        metadata: JSON.stringify(metadata)
    });

    // Create initial version
    const version = await flowVersionsModel.create({
        flow_id: flow.id,
        version: 1,
        is_active: true,
        created_by: flowData.createdBy || 'SYSTEM'
    });

    logger.info('Flow created', { flowId: flow.id, name, eventTypeCode });

    return { flow, version };
};

/**
 * Add a step to a flow
 */
const addStep = async (stepData) => {
    const {
        flowId,
        stepType,
        name,
        description,
        config = {},
        sequenceNumber,
        timeout = 30000,
        retryCount = 0,
        retryDelay = 5000
    } = stepData;

    // Get max step order if not provided
    let stepOrder = sequenceNumber;
    if (!stepOrder) {
        const maxSeq = await flowStepsModel.raw(`
            SELECT COALESCE(MAX(step_order), 0) + 1 as next_seq
            FROM flow_steps WHERE flow_id = $1
        `, [flowId]);
        stepOrder = maxSeq[0].next_seq;
    }

    const step = await flowStepsModel.create({
        flow_id: flowId,
        step_type: stepType,
        name,
        description,
        config: JSON.stringify(config),
        step_order: stepOrder,
        timeout_ms: timeout,
        retry_count: retryCount,
        retry_delay_ms: retryDelay,
        is_active: true
    });

    logger.info('Step added to flow', { stepId: step.id, flowId, stepType, name });

    return step;
};

/**
 * Add a transition between steps
 */
const addTransition = async (transitionData) => {
    const {
        fromStepId,
        toStepId,
        name,
        conditionExpression = null,
        priority = 0
    } = transitionData;

    const transition = await stepTransitionsModel.create({
        from_step_id: fromStepId,
        to_step_id: toStepId,
        name,
        condition_expression: conditionExpression ? JSON.stringify(conditionExpression) : null,
        priority,
        is_active: true
    });

    logger.info('Transition added', { 
        transitionId: transition.id, 
        fromStepId, 
        toStepId 
    });

    return transition;
};

/**
 * Add field mapping to a step
 */
const addFieldMapping = async (mappingData) => {
    const {
        stepId,
        sourceField,
        targetField,
        transformType = null,
        transformConfig = null,
        defaultValue = null,
        isRequired = false,
        sequence = 0
    } = mappingData;

    const mapping = await fieldMappingsModel.create({
        step_id: stepId,
        source_field: sourceField,
        target_field: targetField,
        transform_type: transformType,
        transform_config: transformConfig ? JSON.stringify(transformConfig) : null,
        default_value: defaultValue,
        is_required: isRequired,
        sequence
    });

    return mapping;
};

/**
 * Generate BPMN XML for a flow (simplified version)
 */
const generateBpmnDiagram = async (flowId) => {
    const flowDef = await getFlowDefinition(flowId);
    const { flow, steps, transitions } = flowDef;

    // Build BPMN XML
    let bpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
    id="Definitions_${flow.id}"
    targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_${flow.id}" name="${flow.name}" isExecutable="true">
`;

    // Add elements for each step
    for (const step of steps) {
        const elementType = getBpmnElementType(step.step_type);
        bpmn += `    <bpmn:${elementType} id="Step_${step.id}" name="${step.name}"`;
        
        if (step.step_type === 'START') {
            bpmn += ` />\n`;
        } else if (step.step_type === 'END') {
            bpmn += ` />\n`;
        } else {
            bpmn += `>\n`;
            bpmn += `    </bpmn:${elementType}>\n`;
        }
    }

    // Add sequence flows for transitions
    for (const transition of transitions) {
        bpmn += `    <bpmn:sequenceFlow id="Flow_${transition.id}" `;
        bpmn += `sourceRef="Step_${transition.from_step_id}" `;
        bpmn += `targetRef="Step_${transition.to_step_id}"`;
        if (transition.condition_expression) {
            bpmn += ` name="${transition.name || 'condition'}"`;
        }
        bpmn += ` />\n`;
    }

    bpmn += `  </bpmn:process>
</bpmn:definitions>`;

    // Update flow with BPMN diagram
    await flowsModel.update(flow.id, {
        bpmn_diagram: bpmn
    });

    return bpmn;
};

/**
 * Map step type to BPMN element type
 */
const getBpmnElementType = (stepType) => {
    const mapping = {
        'START': 'startEvent',
        'END': 'endEvent',
        'TASK': 'task',
        'GATEWAY': 'exclusiveGateway',
        'EVENT': 'intermediateThrowEvent',
        'LISTENER': 'intermediateCatchEvent',
        'CALLBACK': 'receiveTask',
        'API_CALL': 'serviceTask',
        'TRANSFORM': 'scriptTask',
        'CONDITION': 'exclusiveGateway',
        'MANUAL': 'userTask',
        'ALERT': 'sendTask'
    };
    return mapping[stepType] || 'task';
};

/**
 * List all flows with optional filters
 */
const listFlows = async (filters = {}) => {
    const { isActive, eventTypeCode, limit = 50, offset = 0 } = filters;

    let query = `
        SELECT f.*, et.code as event_type_code, et.name as event_type_name,
               fv.version as current_version
        FROM flows f
        JOIN event_types et ON f.event_type_id = et.id
        LEFT JOIN flow_versions fv ON f.id = fv.flow_id AND fv.is_active = true
        WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;

    if (isActive !== undefined) {
        query += ` AND f.is_active = $${paramIndex++}`;
        values.push(isActive);
    }

    if (eventTypeCode) {
        query += ` AND et.code = $${paramIndex++}`;
        values.push(eventTypeCode);
    }

    query += ` ORDER BY f.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    values.push(limit, offset);

    return flowsModel.raw(query, values);
};

module.exports = {
    getFlowByEventType,
    getFlowDefinition,
    buildStepGraph,
    getNextStep,
    evaluateTransitionCondition,
    evaluateConditionObject,
    evaluateOperator,
    getFieldValue,
    createFlow,
    addStep,
    addTransition,
    addFieldMapping,
    generateBpmnDiagram,
    listFlows
};
