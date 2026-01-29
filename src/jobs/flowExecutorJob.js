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
                const jobData = JSON.parse(job.job_data);
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
                    flowInstanceId: JSON.parse(job.job_data)?.flowInstanceId
                });
                
                // Update job as failed or retry
                const retryCount = (job.retry_count || 0) + 1;
                const maxRetries = 3;
                
                if (retryCount < maxRetries) {
                    await jobQueueModel.update(job.id, {
                        status: 'PENDING',
                        retry_count: retryCount,
                        error_message: error.message,
                        locked_at: null,
                        locked_by: null,
                        scheduled_at: new Date(Date.now() + retryCount * 30000) // Exponential backoff
                    });
                    
                    logger.flow('Execution scheduled for retry', {
                        jobId: job.id,
                        retryCount,
                        nextRetryIn: `${retryCount * 30}s`
                    });
                } else {
                    await jobQueueModel.update(job.id, {
                        status: 'FAILED',
                        retry_count: retryCount,
                        error_message: error.message,
                        failed_at: new Date()
                    });
                    
                    // Also update flow instance as failed
                    const jobData = JSON.parse(job.job_data);
                    await flowInstancesModel.update(jobData.flowInstanceId, {
                        status: 'FAILED',
                        error_message: `Job execution failed after ${maxRetries} retries: ${error.message}`
                    });
                    
                    logger.error('Flow execution max retries exceeded', error, {
                        jobId: job.id,
                        maxRetries,
                        flowInstanceId: jobData.flowInstanceId
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
