const cron = require('node-cron');
const flowExecutorJob = require('./flowExecutorJob');
const callbackMatcherJob = require('./callbackMatcherJob');
const tsqSchedulerJob = require('./tsqSchedulerJob');
const logger = require('../utils/logger');

/**
 * Initialize all background jobs
 */
const initializeJobs = () => {
    logger.info('✓ Initializing background jobs');
    
    // Process flow execution jobs every 5 seconds
    cron.schedule('*/5 * * * * *', async () => {
        try {
            await flowExecutorJob.processFlowExecutionJobs();
        } catch (error) {
            logger.error('Flow executor job error', error, {
                schedule: 'every 5 seconds'
            });
        }
    });
    logger.debug('Scheduled: Flow execution processor (every 5s)');
    
    // Check timed out callbacks every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
        try {
            await callbackMatcherJob.checkTimedOutCallbacks();
        } catch (error) {
            logger.error('Callback timeout check error', error, {
                schedule: 'every 30 seconds'
            });
        }
    });
    logger.debug('Scheduled: Callback timeout checker (every 30s)');
    
    // Match unmatched callbacks every minute
    cron.schedule('* * * * *', async () => {
        try {
            await callbackMatcherJob.matchUnmatchedCallbacks();
        } catch (error) {
            logger.error('Callback matcher error', error, {
                schedule: 'every minute'
            });
        }
    });
    logger.debug('Scheduled: Callback matcher (every 1m)');
    
    // Send pending BFS callbacks every 10 seconds
    cron.schedule('*/10 * * * * *', async () => {
        try {
            await callbackMatcherJob.sendPendingBfsCallbacks();
        } catch (error) {
            logger.error('BFS callback sender error', error, {
                schedule: 'every 10 seconds'
            });
        }
    });
    logger.debug('Scheduled: BFS callback sender (every 10s)');
    
    // Retry failed BFS callbacks every 2 minutes
    cron.schedule('*/2 * * * *', async () => {
        try {
            await callbackMatcherJob.retryFailedBfsCallbacks();
        } catch (error) {
            logger.error('BFS callback retry error', error, {
                schedule: 'every 2 minutes'
            });
        }
    });
    logger.debug('Scheduled: BFS callback retry (every 2m)');
    
    // Process TSQ requests every 30 seconds
    cron.schedule('*/30 * * * * *', async () => {
        try {
            await tsqSchedulerJob.processPendingTsqRequests();
        } catch (error) {
            logger.error('TSQ processor error', error, {
                schedule: 'every 30 seconds'
            });
        }
    });
    logger.debug('Scheduled: TSQ processor (every 30s)');
    
    // Schedule TSQ for indeterminate responses every minute
    cron.schedule('* * * * *', async () => {
        try {
            await tsqSchedulerJob.scheduleTsqForIndeterminateResponses();
        } catch (error) {
            logger.error('TSQ scheduler error', error, {
                schedule: 'every minute'
            });
        }
    });
    logger.debug('Scheduled: TSQ scheduler (every 1m)');
    
    // Cleanup stale jobs every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        try {
            await flowExecutorJob.cleanupStaleJobs();
        } catch (error) {
            logger.error('Stale job cleanup error', error, {
                schedule: 'every 5 minutes'
            });
        }
    });
    logger.debug('Scheduled: Job cleanup (every 5m)');
    
    // Cleanup old TSQ requests daily at 2am
    cron.schedule('0 2 * * *', async () => {
        try {
            await tsqSchedulerJob.cleanupOldTsqRequests();
        } catch (error) {
            logger.error('TSQ cleanup error', error, {
                schedule: 'daily at 2:00 AM'
            });
        }
    });
    logger.debug('Scheduled: TSQ cleanup (daily at 2:00 AM)');
    
    logger.info('✓ Background jobs initialized successfully');
};

/**
 * Get all job statistics
 */
const getAllJobStats = async () => {
    const [jobQueueStats, callbackStats, tsqStats] = await Promise.all([
        flowExecutorJob.getJobQueueStats(),
        callbackMatcherJob.getCallbackStats(),
        tsqSchedulerJob.getTsqStats()
    ]);
    
    return {
        jobQueue: jobQueueStats,
        callbacks: callbackStats,
        tsq: tsqStats
    };
};

module.exports = {
    start: initializeJobs,
    initializeJobs,
    getAllJobStats,
    flowExecutorJob,
    callbackMatcherJob,
    tsqSchedulerJob
};
