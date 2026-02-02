const { jobQueueModel, flowInstancesModel } = require('../models');
const executionService = require('../services/executionService');
const logger = require('../utils/logger');

/**
 * Process pending flow execution jobs
 */
const processFlowExecutionJobs = async () => {
    try {
        // Get pending jobs with lock
        const jobs = await jobQueueModel.raw(`
            UPDATE job_queue
            SET status = 'PROCESSING', 
                locked_at = NOW(),
                locked_by = $1
            WHERE id IN (
                SELECT id FROM job_queue 
                WHERE job_type = 'EXECUTE_FLOW' 
                    AND status = 'PENDING'
                    AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
                ORDER BY priority DESC, created_at ASC
                LIMIT 10
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `, [process.env.WORKER_ID || 'worker-1']);
        
        if (jobs.length === 0) {
            return;
        }
        
        logger.job('FlowExecutor', 'processPending', {
            count: jobs.length,
            workerId: process.env.WORKER_ID || 'worker-1',
            status: 'processing'
        });
        
        for (const job of jobs) {
            try {
                const jobData = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
                const { flowInstanceId } = jobData;
                
                logger.flow('Executing flow instance', {
                    flowInstanceId,
                    jobId: job.id,
                    priority: job.priority
                });
                
                // Execute the flow
                const result = await executionService.executeFlowInstance(flowInstanceId);
                
                // Update job as completed
                await jobQueueModel.update(job.id, {
                    status: 'COMPLETED',
                    result: JSON.stringify(result),
                    completed_at: new Date()
                });
                
                logger.flow('Execution completed', { 
                    flowInstanceId,
                    status: result.status,
                    jobId: job.id
                });
            } catch (error) {
                logger.error(`Flow execution job failed`, error, { 
                    jobId: job.id,
                    flowInstanceId: (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload)?.flowInstanceId
                });
                
                // Update job as failed or retry
                const attemptNumber = (job.attempt_number || 0) + 1;
                const maxAttempts = job.max_attempts || 3;

                if (attemptNumber < maxAttempts) {
                    await jobQueueModel.update(job.id, {
                        status: 'PENDING',
                        attempt_number: attemptNumber,
                        error_message: error.message,
                        locked_at: null,
                        locked_by: null,
                        next_retry_at: new Date(Date.now() + attemptNumber * 30000) // Exponential backoff
                    });

                    logger.flow('Execution scheduled for retry', {
                        jobId: job.id,
                        attemptNumber,
                        nextRetryIn: `${attemptNumber * 30}s`
                    });
                } else {
                    await jobQueueModel.update(job.id, {
                        status: 'FAILED',
                        attempt_number: attemptNumber,
                        error_message: error.message,
                        completed_at: new Date()
                    });
                    
                    // Also update flow instance as failed
                    const jobData = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
                    if (jobData?.flowInstanceId) {
                        await flowInstancesModel.update(jobData.flowInstanceId, {
                            status: 'FAILED',
                            last_error: `Job execution failed after ${maxAttempts} attempts: ${error.message}`
                        });
                    }

                    logger.error('Flow execution max attempts exceeded', error, {
                        jobId: job.id,
                        maxAttempts,
                        flowInstanceId: jobData?.flowInstanceId
                    });
                }
            }
        }
    } catch (error) {
        logger.error('Process flow execution jobs failed', error, {
            job: 'FlowExecutor',
            action: 'processPending'
        });
    }
};

/**
 * Clean up stale jobs
 */
const cleanupStaleJobs = async () => {
    try {
        // Release jobs that have been locked for too long
        const released = await jobQueueModel.raw(`
            UPDATE job_queue
            SET status = 'PENDING', locked_at = NULL, locked_by = NULL
            WHERE status = 'PROCESSING' 
                AND locked_at < NOW() - INTERVAL '10 minutes'
            RETURNING id
        `);
        
        if (released.length > 0) {
            logger.job('FlowExecutor', 'cleanup', {
                action: 'released stale jobs',
                count: released.length
            });
        }
        
        // Archive old completed jobs
        await jobQueueModel.raw(`
            DELETE FROM job_queue
            WHERE status IN ('COMPLETED', 'FAILED')
                AND created_at < NOW() - INTERVAL '7 days'
        `);
    } catch (error) {
        logger.error('Cleanup stale jobs failed', error, {
            job: 'FlowExecutor',
            action: 'cleanup'
        });
    }
};

/**
 * Get job queue statistics
 */
const getJobQueueStats = async () => {
    try {
        const stats = await jobQueueModel.raw(`
            SELECT 
                job_type,
                status,
                COUNT(*) as count
            FROM job_queue
            GROUP BY job_type, status
        `);
        
        return stats;
    } catch (error) {
        logger.error('Get job queue stats failed', { error: error.message });
        return [];
    }
};

module.exports = {
    processFlowExecutionJobs,
    cleanupStaleJobs,
    getJobQueueStats
};
