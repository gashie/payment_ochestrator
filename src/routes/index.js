const express = require('express');
const router = express.Router();

// Controllers
const flowsController = require('../controllers/flowsController');
const flowStepsController = require('../controllers/flowStepsController');
const fieldMappingsController = require('../controllers/fieldMappingsController');
const processController = require('../controllers/processController');
const callbacksController = require('../controllers/callbacksController');
const monitoringController = require('../controllers/monitoringController');
const reportsController = require('../controllers/reportsController');

// Validators
const { 
    validate, 
    eventTypeSchemas, 
    flowSchemas, 
    flowStepSchemas,
    transitionSchemas,
    fieldMappingSchemas,
    processSchemas,
    callbackSchemas,
    reversalSchemas
} = require('../validators');

// ===========================================
// Health Check
// ===========================================
router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'orchestrator', timestamp: new Date().toISOString() });
});

// ===========================================
// Event Types Routes
// ===========================================
router.post('/event-types', validate(eventTypeSchemas.create), flowsController.createEventType);
router.get('/event-types', flowsController.getEventTypes);

// ===========================================
// Flows Routes
// ===========================================
router.post('/flows', validate(flowSchemas.create), flowsController.createFlow);
router.get('/flows', flowsController.getFlows);
router.get('/flows/:id', flowsController.getFlowById);
router.put('/flows/:id', validate(flowSchemas.update), flowsController.updateFlow);
router.delete('/flows/:id', flowsController.deleteFlow);
router.post('/flows/:id/clone', flowsController.cloneFlow);
router.get('/flows/:id/bpmn', flowsController.getFlowBpmnDiagram);

// Flow Versions
router.post('/flows/:id/versions', flowsController.createFlowVersion);
router.get('/flows/:id/versions', flowsController.getFlowVersions);
router.put('/flows/:id/versions/:versionId/activate', flowsController.activateFlowVersion);

// ===========================================
// Flow Steps Routes
// ===========================================
router.post('/flows/:flowId/steps', validate(flowStepSchemas.create), flowStepsController.createFlowStep);
router.get('/flows/:flowId/steps', flowStepsController.getFlowSteps);
router.get('/steps/:stepId', flowStepsController.getStepById);
router.put('/steps/:stepId', validate(flowStepSchemas.update), flowStepsController.updateFlowStep);
router.delete('/steps/:stepId', flowStepsController.deleteFlowStep);
router.post('/flows/:flowId/steps/reorder', flowStepsController.reorderSteps);

// Step Transitions
router.post('/transitions', validate(transitionSchemas.create), flowStepsController.createTransition);
router.get('/steps/:stepId/transitions', flowStepsController.getStepTransitions);
router.put('/transitions/:transitionId', validate(transitionSchemas.update), flowStepsController.updateTransition);
router.delete('/transitions/:transitionId', flowStepsController.deleteTransition);

// ===========================================
// Field Mappings Routes
// ===========================================
router.post('/steps/:stepId/field-mappings', validate(fieldMappingSchemas.create), fieldMappingsController.createFieldMapping);
router.get('/steps/:stepId/field-mappings', fieldMappingsController.getStepFieldMappings);
router.get('/field-mappings/:mappingId', fieldMappingsController.getFieldMappingById);
router.put('/field-mappings/:mappingId', validate(fieldMappingSchemas.update), fieldMappingsController.updateFieldMapping);
router.delete('/field-mappings/:mappingId', fieldMappingsController.deleteFieldMapping);
router.post('/steps/:stepId/field-mappings/bulk', validate(fieldMappingSchemas.bulkCreate), fieldMappingsController.bulkCreateFieldMappings);
router.post('/steps/:stepId/field-mappings/copy', fieldMappingsController.copyFieldMappings);
router.get('/field-mapping-templates', fieldMappingsController.getFieldMappingTemplates);

// ===========================================
// Process Routes (Main Transaction Processing)
// ===========================================
router.post('/process', validate(processSchemas.request), processController.processRequest);
router.get('/process/:instanceId', processController.getFlowInstanceStatus);
router.get('/process/session/:sessionId', processController.getFlowInstanceBySession);
router.post('/process/:instanceId/resume', validate(processSchemas.resume), processController.resumeFlowInstance);
router.post('/process/:instanceId/cancel', validate(processSchemas.cancel), processController.cancelFlowInstance);
router.post('/process/:instanceId/retry', validate(processSchemas.retry), processController.retryFlowInstance);
router.post('/process/:instanceId/tsq', processController.initiateTsq);
router.post('/process/:instanceId/reversal', validate(reversalSchemas.initiate), processController.initiateReversal);
router.get('/process/manual-interventions/pending', processController.getPendingManualInterventions);
router.get('/process/active', processController.getActiveFlowInstances);

// ===========================================
// Callback Routes
// ===========================================
router.post('/callbacks', validate(callbackSchemas.receive), callbacksController.receiveCallback);
router.post('/callbacks/ftd', validate(callbackSchemas.receive), callbacksController.receiveFtdCallback);
router.post('/callbacks/ftc', validate(callbackSchemas.receive), callbacksController.receiveFtcCallback);
router.get('/callbacks/expected', callbacksController.getExpectedCallbacks);
router.get('/callbacks/received', callbacksController.getReceivedCallbacks);
router.get('/callbacks/pending', callbacksController.getPendingCallbacks);
router.get('/callbacks/timed-out', callbacksController.getTimedOutCallbacks);
router.get('/callbacks/unmatched', callbacksController.getUnmatchedCallbacks);
router.get('/callbacks/:id', callbacksController.getCallbackById);
router.post('/callbacks/:callbackId/match', validate(callbackSchemas.manualMatch), callbacksController.manuallyMatchCallback);
router.post('/callbacks/bfs/:flowInstanceId/retry', callbacksController.retryBfsCallback);

// ===========================================
// Monitoring Routes
// ===========================================
router.get('/monitoring/dashboard', monitoringController.getDashboardStats);
router.get('/monitoring/active-instances', monitoringController.getActiveFlowInstancesView);
router.get('/monitoring/flow-statistics', monitoringController.getFlowStatistics);
router.get('/monitoring/pending-callbacks', monitoringController.getPendingCallbacksView);
router.get('/monitoring/process-logs', monitoringController.getProcessLogs);
router.get('/monitoring/event-logs', monitoringController.getEventLogs);
router.get('/monitoring/job-queue', monitoringController.getJobQueueStatus);
router.get('/monitoring/tsq-requests', monitoringController.getTsqRequests);
router.get('/monitoring/reversal-requests', monitoringController.getReversalRequests);
router.get('/monitoring/alert-history', monitoringController.getAlertHistory);
router.get('/monitoring/hourly-volume', monitoringController.getHourlyVolume);
router.get('/monitoring/health', monitoringController.getSystemHealth);

// ===========================================
// Reports Routes
// ===========================================
router.get('/reports/transaction-summary', reportsController.getTransactionSummaryReport);
router.get('/reports/flow-performance', reportsController.getFlowPerformanceReport);
router.get('/reports/failure-analysis', reportsController.getFailureAnalysisReport);
router.get('/reports/reversals', reportsController.getReversalReport);
router.get('/reports/tsq', reportsController.getTsqReport);
router.get('/reports/audit-logs', reportsController.getAuditLogs);
router.get('/reports/export/transactions', reportsController.exportTransactions);

module.exports = router;
