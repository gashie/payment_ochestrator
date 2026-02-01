const executionService = require('../services/executionService');
const { flowInstancesModel, stepExecutionsModel, jobQueueModel } = require('../models');
const { formatDateTime, formatAmount } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Generate unique session ID for testing
 */
const generateSessionId = () => {
    const now = new Date();
    const dateStr = formatDateTime(now);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `${dateStr}${random}`;
};

/**
 * Generate tracking number for testing
 */
const generateTrackingNumber = (prefix = 'TEST') => {
    const timestamp = Date.now().toString().slice(-8);
    return `${prefix}${timestamp}`;
};

/**
 * Test NEC (Name Enquiry Check) - Synchronous
 * POST /api/v1/test/nec
 */
const testNec = async (req, res) => {
    try {
        const {
            srcBankCode = '300300',
            destBankCode = '300315',
            srcAccountNumber = '0246089019',
            destAccountNumber = '0246089019',
            channelCode = '100',
            narration = 'Test NEC from Orchestrator'
        } = req.body;

        const sessionId = req.body.sessionId || generateSessionId();
        const trackingNumber = req.body.trackingNumber || generateTrackingNumber('NEC');

        const payload = {
            sessionId,
            trackingNumber,
            srcBankCode,
            destBankCode,
            srcAccountNumber,
            destAccountNumber,
            channelCode,
            narration,
            dateTime: formatDateTime(new Date())
        };

        const metadata = {
            callbackUrl: 'http://localhost:3002/api/v1/test/callback-receiver',
            applicationId: 'test-app-001',
            bankId: 'test-bank-001',
            testMode: true
        };

        logger.service('TestController', 'testNec', { sessionId, trackingNumber });

        // Create flow instance
        const result = await executionService.createFlowInstance({
            eventTypeCode: 'NEC',
            sessionId,
            trackingNumber,
            inputPayload: payload,
            bfsCallbackUrl: metadata.callbackUrl,
            metadata
        });

        const { instance } = result;

        // Execute synchronously
        const execResult = await executionService.executeFlowInstance(instance.id);

        // Mark callback as sent
        await flowInstancesModel.update(instance.id, {
            callback_sent: true,
            callback_sent_at: new Date()
        });

        res.json({
            success: true,
            message: 'NEC test completed',
            data: {
                flowInstanceId: instance.id,
                sessionId,
                trackingNumber,
                status: execResult.status,
                result: execResult.payload,
                testPayloadUsed: payload
            }
        });
    } catch (error) {
        logger.error('Test NEC failed', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Test FT (Funds Transfer) - Asynchronous
 * POST /api/v1/test/ft
 */
const testFt = async (req, res) => {
    try {
        const {
            srcBankCode = '300307',
            destBankCode = '300591',
            srcAccountNumber = '0011010104334',
            srcAccountName = 'FAUTINA ABDULAI',
            destAccountNumber = '0246436671',
            destAccountName = 'KWAKU MANU',
            amount = 100,
            channelCode = '100',
            narration = 'Test FT from Orchestrator'
        } = req.body;

        const sessionId = req.body.sessionId || generateSessionId();
        const trackingNumber = req.body.trackingNumber || generateTrackingNumber('FT');

        const payload = {
            sessionId,
            trackingNumber,
            srcBankCode,
            destBankCode,
            srcAccountNumber,
            srcAccountName,
            destAccountNumber,
            destAccountName,
            amount,
            channelCode,
            narration,
            dateTime: formatDateTime(new Date())
        };

        const metadata = {
            callbackUrl: 'http://localhost:3002/api/v1/test/callback-receiver',
            applicationId: 'test-app-001',
            bankId: 'test-bank-001',
            testMode: true
        };

        logger.service('TestController', 'testFt', { sessionId, trackingNumber, amount });

        // Create flow instance
        const result = await executionService.createFlowInstance({
            eventTypeCode: 'FT',
            sessionId,
            trackingNumber,
            inputPayload: payload,
            bfsCallbackUrl: metadata.callbackUrl,
            metadata
        });

        const { instance } = result;

        // Queue for async processing
        await jobQueueModel.create({
            job_type: 'EXECUTE_FLOW',
            payload: JSON.stringify({ flowInstanceId: instance.id }),
            status: 'PENDING',
            priority: 1
        });

        res.status(202).json({
            success: true,
            message: 'FT test request accepted for processing',
            data: {
                flowInstanceId: instance.id,
                sessionId,
                trackingNumber,
                status: 'ACCEPTED',
                testPayloadUsed: payload,
                note: 'Use GET /api/v1/test/status/:instanceId to check progress'
            }
        });
    } catch (error) {
        logger.error('Test FT failed', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Test FT Synchronously (waits for completion - useful for debugging)
 * POST /api/v1/test/ft-sync
 */
const testFtSync = async (req, res) => {
    try {
        const {
            srcBankCode = '300307',
            destBankCode = '300591',
            srcAccountNumber = '0011010104334',
            srcAccountName = 'FAUTINA ABDULAI',
            destAccountNumber = '0246436671',
            destAccountName = 'KWAKU MANU',
            amount = 100,
            channelCode = '100',
            narration = 'Test FT Sync from Orchestrator'
        } = req.body;

        const sessionId = req.body.sessionId || generateSessionId();
        const trackingNumber = req.body.trackingNumber || generateTrackingNumber('FTS');

        const payload = {
            sessionId,
            trackingNumber,
            srcBankCode,
            destBankCode,
            srcAccountNumber,
            srcAccountName,
            destAccountNumber,
            destAccountName,
            amount,
            channelCode,
            narration,
            dateTime: formatDateTime(new Date())
        };

        const metadata = {
            callbackUrl: 'http://localhost:3002/api/v1/test/callback-receiver',
            applicationId: 'test-app-001',
            bankId: 'test-bank-001',
            testMode: true
        };

        logger.service('TestController', 'testFtSync', { sessionId, trackingNumber, amount });

        // Create flow instance
        const result = await executionService.createFlowInstance({
            eventTypeCode: 'FT',
            sessionId,
            trackingNumber,
            inputPayload: payload,
            bfsCallbackUrl: metadata.callbackUrl,
            metadata
        });

        const { instance } = result;

        // Execute synchronously (will wait for callbacks if GIP supports sync mode)
        const execResult = await executionService.executeFlowInstance(instance.id);

        res.json({
            success: true,
            message: 'FT sync test completed',
            data: {
                flowInstanceId: instance.id,
                sessionId,
                trackingNumber,
                status: execResult.status,
                result: execResult.payload,
                testPayloadUsed: payload,
                note: execResult.status === 'WAITING_CALLBACK'
                    ? 'Flow is waiting for GIP callback. Check status endpoint for updates.'
                    : 'Flow completed'
            }
        });
    } catch (error) {
        logger.error('Test FT Sync failed', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Get test transaction status
 * GET /api/v1/test/status/:instanceId
 */
const getTestStatus = async (req, res) => {
    try {
        const { instanceId } = req.params;

        const instance = await flowInstancesModel.findById(instanceId);
        if (!instance) {
            return res.status(404).json({
                success: false,
                error: 'Flow instance not found'
            });
        }

        const steps = await stepExecutionsModel.findAll({
            where: { flow_instance_id: instanceId },
            orderBy: 'created_at ASC'
        });

        const stepsSummary = steps.map(s => ({
            stepCode: s.step_code,
            status: s.status,
            actionCode: s.api_response ? JSON.parse(s.api_response)?.actionCode : null,
            completedAt: s.completed_at
        }));

        res.json({
            success: true,
            data: {
                flowInstanceId: instance.id,
                sessionId: instance.session_id,
                trackingNumber: instance.tracking_number,
                status: instance.status,
                currentPayload: JSON.parse(instance.current_payload || '{}'),
                finalResponse: instance.final_response ? JSON.parse(instance.final_response) : null,
                callbackSent: instance.callback_sent,
                createdAt: instance.created_at,
                completedAt: instance.completed_at,
                steps: stepsSummary
            }
        });
    } catch (error) {
        logger.error('Get test status failed', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * Callback receiver for test transactions
 * POST /api/v1/test/callback-receiver
 */
const callbackReceiver = async (req, res) => {
    logger.info('Test callback received', req.body);

    res.json({
        success: true,
        message: 'Callback received',
        receivedAt: new Date().toISOString(),
        payload: req.body
    });
};

/**
 * Get sample payloads for testing
 * GET /api/v1/test/payloads
 */
const getSamplePayloads = async (req, res) => {
    const now = new Date();
    const sessionId = generateSessionId();

    res.json({
        success: true,
        data: {
            nec: {
                description: 'NEC (Name Enquiry Check) - Synchronous',
                endpoint: 'POST /api/v1/test/nec',
                minimalPayload: {},
                fullPayload: {
                    sessionId: sessionId,
                    trackingNumber: generateTrackingNumber('NEC'),
                    srcBankCode: '300300',
                    destBankCode: '300315',
                    srcAccountNumber: '0246089019',
                    destAccountNumber: '0246089019',
                    channelCode: '100',
                    narration: 'Name Enquiry Test'
                },
                testAccounts: [
                    { account: '0246089019', name: 'ENOCH DANSO CLINTON', bank: '300315' },
                    { account: '0246436671', name: 'KWAKU MANU', bank: '300591' },
                    { account: '0011010104334', name: 'FAUTINA ABDULAI', bank: '300307' }
                ]
            },
            ft: {
                description: 'FT (Funds Transfer) - Asynchronous',
                endpoint: 'POST /api/v1/test/ft',
                minimalPayload: {
                    amount: 100
                },
                fullPayload: {
                    sessionId: generateSessionId(),
                    trackingNumber: generateTrackingNumber('FT'),
                    srcBankCode: '300307',
                    destBankCode: '300591',
                    srcAccountNumber: '0011010104334',
                    srcAccountName: 'FAUTINA ABDULAI',
                    destAccountNumber: '0246436671',
                    destAccountName: 'KWAKU MANU',
                    amount: 100,
                    channelCode: '100',
                    narration: 'Test Transfer'
                }
            },
            ftSync: {
                description: 'FT Sync (Funds Transfer - waits for execution)',
                endpoint: 'POST /api/v1/test/ft-sync',
                note: 'Same payload as FT, but waits for flow execution'
            },
            statusCheck: {
                description: 'Check transaction status',
                endpoint: 'GET /api/v1/test/status/:instanceId'
            },
            helpers: {
                currentDateTime: formatDateTime(now),
                sampleSessionId: sessionId,
                sampleTrackingNumber: generateTrackingNumber('TEST'),
                amountFormat: {
                    input: 10000,
                    formatted: formatAmount(10000),
                    note: 'Amount is in smallest currency unit (pesewas/kobo), formatted to 12-char string'
                }
            }
        }
    });
};

/**
 * List recent test transactions
 * GET /api/v1/test/recent
 */
const getRecentTests = async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        const instances = await flowInstancesModel.raw(`
            SELECT fi.id, fi.session_id, fi.tracking_number, fi.status,
                   fi.created_at, fi.completed_at, et.code as event_type
            FROM flow_instances fi
            LEFT JOIN flows f ON fi.flow_id = f.id
            LEFT JOIN event_types et ON f.event_type_id = et.id
            ORDER BY fi.created_at DESC
            LIMIT $1
        `, [parseInt(limit)]);

        res.json({
            success: true,
            data: instances
        });
    } catch (error) {
        logger.error('Get recent tests failed', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    testNec,
    testFt,
    testFtSync,
    getTestStatus,
    callbackReceiver,
    getSamplePayloads,
    getRecentTests
};
