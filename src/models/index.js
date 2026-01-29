const { createModel } = require('./baseModel');

// Event Types
const eventTypesModel = createModel('event_types');

// Flows and Versions
const flowsModel = createModel('flows');
const flowVersionsModel = createModel('flow_versions');

// Steps and Transitions
const flowStepsModel = createModel('flow_steps');
const stepTransitionsModel = createModel('step_transitions');

// Field Mappings
const fieldMappingsModel = createModel('field_mappings');

// Runtime - Flow Instances
const flowInstancesModel = createModel('flow_instances');
const stepExecutionsModel = createModel('step_executions');

// Callbacks
const expectedCallbacksModel = createModel('expected_callbacks');
const receivedCallbacksModel = createModel('received_callbacks');

// TSQ and Reversals
const tsqRequestsModel = createModel('tsq_requests');
const reversalRequestsModel = createModel('reversal_requests');

// Logging
const processLogsModel = createModel('process_logs');
const eventLogsModel = createModel('event_logs');
const auditLogsModel = createModel('audit_logs');

// Alerts
const alertRulesModel = createModel('alert_rules');
const alertHistoryModel = createModel('alert_history');

// Job Queue
const jobQueueModel = createModel('job_queue');

// External APIs
const externalApisModel = createModel('external_apis');

// Users and Roles
const usersModel = createModel('users');
const rolesModel = createModel('roles');

module.exports = {
    eventTypesModel,
    flowsModel,
    flowVersionsModel,
    flowStepsModel,
    stepTransitionsModel,
    fieldMappingsModel,
    flowInstancesModel,
    stepExecutionsModel,
    expectedCallbacksModel,
    receivedCallbacksModel,
    tsqRequestsModel,
    reversalRequestsModel,
    processLogsModel,
    eventLogsModel,
    auditLogsModel,
    alertRulesModel,
    alertHistoryModel,
    jobQueueModel,
    externalApisModel,
    usersModel,
    rolesModel
};
