/**
 * Orchestrator Troubleshooter Server
 * Provides API endpoints for diagnostic queries
 *
 * @author Gashie
 * @version 2.0.0
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

// Load environment from parent orchestrator
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'orchestrator_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'admin'
});

// Test database connection
pool.query('SELECT NOW()')
    .then(() => console.log('✓ Database connected'))
    .catch(err => console.error('✗ Database connection failed:', err.message));

// ============================================
// DIAGNOSTIC ENDPOINTS
// ============================================

// Get flow instance by session ID or instance ID
app.get('/api/flow/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        const result = await pool.query(`
            SELECT
                fi.id,
                fi.session_id,
                fi.tracking_number,
                fi.status,
                fi.last_error,
                fi.current_step_id,
                fi.callback_sent,
                fi.error_count,
                fi.created_at,
                fi.completed_at,
                fi.current_payload,
                fs.step_code as current_step,
                fs.step_type as current_step_type,
                f.flow_code,
                f.flow_name
            FROM flow_instances fi
            LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
            LEFT JOIN flows f ON fi.flow_id = f.id
            WHERE fi.session_id = $1 OR fi.id::text = $1 OR fi.tracking_number = $1
            ORDER BY fi.created_at DESC
            LIMIT 1
        `, [identifier]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Flow not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get step executions for a flow
app.get('/api/flow/:instanceId/steps', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const result = await pool.query(`
            SELECT
                se.id,
                se.status,
                se.error_message,
                se.error_details,
                se.started_at,
                se.completed_at,
                se.input_payload,
                se.output_payload,
                se.transformed_payload,
                se.api_request,
                se.api_response,
                se.api_status_code,
                se.api_response_time_ms,
                se.action_code,
                se.approval_code,
                se.response_code,
                se.response_message,
                se.callback_payload,
                se.callback_received,
                se.callback_received_at,
                fs.step_code,
                fs.step_type,
                fs.step_order,
                fs.config as step_config,
                fs.input_mapping
            FROM step_executions se
            JOIN flow_steps fs ON se.step_id = fs.id
            WHERE se.flow_instance_id = $1
            ORDER BY se.started_at
        `, [instanceId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get expected callbacks for a flow
app.get('/api/flow/:instanceId/callbacks', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const result = await pool.query(`
            SELECT
                ec.id,
                ec.session_id,
                ec.tracking_number,
                ec.status,
                ec.callback_type,
                ec.expected_by,
                ec.received_at,
                ec.created_at,
                fs.step_code
            FROM expected_callbacks ec
            LEFT JOIN step_executions se ON ec.step_execution_id = se.id
            LEFT JOIN flow_steps fs ON se.step_id = fs.id
            WHERE ec.flow_instance_id = $1
            ORDER BY ec.created_at
        `, [instanceId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get received callbacks by session
app.get('/api/callbacks/received/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await pool.query(`
            SELECT
                id,
                session_id,
                tracking_number,
                action_code,
                approval_code,
                function_code,
                processed,
                matched_to_instance_id,
                created_at
            FROM received_callbacks
            WHERE session_id = $1
            ORDER BY created_at DESC
        `, [sessionId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get recent flows
app.get('/api/flows/recent', async (req, res) => {
    try {
        const limit = req.query.limit || 20;
        const result = await pool.query(`
            SELECT
                fi.id,
                fi.session_id,
                fi.tracking_number,
                fi.status,
                fi.last_error,
                fi.callback_sent,
                fi.created_at,
                fs.step_code as current_step,
                f.flow_code
            FROM flow_instances fi
            LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
            LEFT JOIN flows f ON fi.flow_id = f.id
            ORDER BY fi.created_at DESC
            LIMIT $1
        `, [limit]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get flow statistics
app.get('/api/stats', async (req, res) => {
    try {
        const flowStats = await pool.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM flow_instances
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
        `);

        const callbackStats = await pool.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM expected_callbacks
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
        `);

        const jobStats = await pool.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM job_queue
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
        `);

        const problemFlows = await pool.query(`
            SELECT COUNT(*) as count FROM flow_instances
            WHERE status IN ('FAILED', 'TIMEOUT')
            AND created_at > NOW() - INTERVAL '24 hours'
        `);

        const stuckFlows = await pool.query(`
            SELECT COUNT(*) as count FROM flow_instances
            WHERE status IN ('PENDING', 'WAITING_CALLBACK')
            AND created_at < NOW() - INTERVAL '10 minutes'
        `);

        res.json({
            success: true,
            data: {
                flows: flowStats.rows,
                callbacks: callbackStats.rows,
                jobs: jobStats.rows,
                problems: parseInt(problemFlows.rows[0].count),
                stuck: parseInt(stuckFlows.rows[0].count)
            }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get pending jobs
app.get('/api/jobs/pending', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                job_type,
                job_name,
                status,
                error_message,
                attempt_number,
                max_attempts,
                priority,
                created_at,
                started_at,
                scheduled_for
            FROM job_queue
            WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')
            ORDER BY priority DESC, created_at DESC
            LIMIT 50
        `);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get stuck flows (PENDING or WAITING_CALLBACK for too long)
app.get('/api/flows/stuck', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                fi.id,
                fi.session_id,
                fi.status,
                fi.created_at,
                fi.last_error,
                fs.step_code as current_step,
                f.flow_code,
                EXTRACT(EPOCH FROM (NOW() - fi.created_at))/60 as minutes_old
            FROM flow_instances fi
            LEFT JOIN flow_steps fs ON fi.current_step_id = fs.id
            LEFT JOIN flows f ON fi.flow_id = f.id
            WHERE fi.status IN ('PENDING', 'WAITING_CALLBACK', 'RUNNING')
            AND fi.created_at < NOW() - INTERVAL '5 minutes'
            ORDER BY fi.created_at
        `);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get timed out callbacks
app.get('/api/callbacks/timedout', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                ec.id,
                ec.session_id,
                ec.status,
                ec.expected_by,
                ec.created_at,
                fi.status as flow_status,
                fs.step_code
            FROM expected_callbacks ec
            JOIN flow_instances fi ON ec.flow_instance_id = fi.id
            LEFT JOIN step_executions se ON ec.step_execution_id = se.id
            LEFT JOIN flow_steps fs ON se.step_id = fs.id
            WHERE ec.status = 'TIMEOUT'
            ORDER BY ec.created_at DESC
            LIMIT 50
        `);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get callback spam (flows without callback_sent)
app.get('/api/flows/callback-spam', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                session_id,
                status,
                callback_sent,
                error_count,
                bfs_callback_url
            FROM flow_instances
            WHERE status IN ('COMPLETED', 'FAILED')
            AND (callback_sent = false OR callback_sent IS NULL)
            AND bfs_callback_url IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 50
        `);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// FIX ENDPOINTS
// ============================================

// Reset timed out callback
app.post('/api/fix/reset-callback/:callbackId', async (req, res) => {
    try {
        const { callbackId } = req.params;
        const minutes = req.body.minutes || 5;

        await pool.query(`
            UPDATE expected_callbacks
            SET status = 'PENDING',
                expected_by = NOW() + INTERVAL '${minutes} minutes'
            WHERE id = $1
        `, [callbackId]);

        // Also update flow instance status
        await pool.query(`
            UPDATE flow_instances fi
            SET status = 'WAITING_CALLBACK'
            FROM expected_callbacks ec
            WHERE ec.id = $1
            AND fi.id = ec.flow_instance_id
        `, [callbackId]);

        res.json({ success: true, message: `Callback reset with ${minutes} minute timeout` });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Create job to resume flow
app.post('/api/fix/resume-flow/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;

        // Update flow status
        await pool.query(`
            UPDATE flow_instances
            SET status = 'IN_PROGRESS'
            WHERE id = $1
        `, [instanceId]);

        // Create job
        const result = await pool.query(`
            INSERT INTO job_queue (job_type, payload, status, priority)
            VALUES ('EXECUTE_FLOW', $1, 'PENDING', 1)
            RETURNING id
        `, [JSON.stringify({ flowInstanceId: instanceId })]);

        res.json({ success: true, message: 'Job created', jobId: result.rows[0].id });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Stop callback spam
app.post('/api/fix/stop-spam', async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE flow_instances
            SET callback_sent = true
            WHERE status IN ('COMPLETED', 'FAILED', 'RUNNING')
            AND (callback_sent = false OR callback_sent IS NULL)
            RETURNING id, session_id
        `);

        res.json({
            success: true,
            message: `Marked ${result.rowCount} flows as callback_sent`,
            affected: result.rows
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Retry failed job
app.post('/api/fix/retry-job/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        await pool.query(`
            UPDATE job_queue
            SET status = 'PENDING', attempt_number = 0, error_message = NULL
            WHERE id = $1
        `, [jobId]);

        res.json({ success: true, message: 'Job reset for retry' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Execute raw query (for advanced users)
app.post('/api/query', async (req, res) => {
    try {
        const { sql } = req.body;

        // Basic safety check - only allow SELECT
        if (!sql.trim().toUpperCase().startsWith('SELECT')) {
            return res.json({ success: false, error: 'Only SELECT queries allowed' });
        }

        const result = await pool.query(sql);
        res.json({ success: true, data: result.rows, rowCount: result.rowCount });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get flow step configuration
app.get('/api/steps/:flowCode', async (req, res) => {
    try {
        const { flowCode } = req.params;
        const result = await pool.query(`
            SELECT
                fs.step_code,
                fs.step_type,
                fs.step_order,
                fs.config,
                fs.input_mapping
            FROM flow_steps fs
            JOIN flows f ON fs.flow_id = f.id
            WHERE f.flow_code = $1
            ORDER BY fs.step_order
        `, [flowCode]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get steps by flow ID (for visual builder)
app.get('/api/flows/:flowId/steps', async (req, res) => {
    try {
        const { flowId } = req.params;
        const result = await pool.query(`
            SELECT
                fs.id,
                fs.step_code,
                fs.step_type,
                fs.step_order,
                fs.config,
                fs.input_mapping
            FROM flow_steps fs
            WHERE fs.flow_id = $1
            ORDER BY fs.step_order
        `, [flowId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get flow definitions
app.get('/api/flows/definitions', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, flow_code, flow_name, description, is_sync, is_active, created_at
            FROM flows
            ORDER BY flow_code
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get event types
app.get('/api/events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                et.id,
                et.event_code as code,
                et.event_name as name,
                et.function_code,
                et.description,
                et.is_sync,
                et.is_active,
                et.default_timeout_seconds
            FROM event_types et
            ORDER BY et.event_code
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// FLOW CRUD ENDPOINTS
// ============================================

// Create new flow
app.post('/api/flows', async (req, res) => {
    try {
        const { flow_code, flow_name, description, is_sync, is_active } = req.body;

        if (!flow_code) {
            return res.json({ success: false, error: 'flow_code is required' });
        }

        const result = await pool.query(`
            INSERT INTO flows (flow_code, flow_name, description, is_sync, is_active)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [flow_code, flow_name || flow_code, description, is_sync || false, is_active !== false]);

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Update flow
app.put('/api/flows/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { flow_code, flow_name, description, is_sync, is_active } = req.body;

        const result = await pool.query(`
            UPDATE flows
            SET flow_code = COALESCE($2, flow_code),
                flow_name = COALESCE($3, flow_name),
                description = COALESCE($4, description),
                is_sync = COALESCE($5, is_sync),
                is_active = COALESCE($6, is_active),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, flow_code, flow_name, description, is_sync, is_active]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Flow not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Delete flow
app.delete('/api/flows/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // First delete all steps
        await pool.query('DELETE FROM flow_steps WHERE flow_id = $1', [id]);

        const result = await pool.query('DELETE FROM flows WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Flow not found' });
        }

        res.json({ success: true, message: 'Flow deleted' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// STEP CRUD ENDPOINTS
// ============================================

// Create new step
app.post('/api/steps', async (req, res) => {
    try {
        const { flow_id, step_code, step_name, step_type, step_order, config, input_mapping } = req.body;

        if (!flow_id || !step_code || !step_type) {
            return res.json({ success: false, error: 'flow_id, step_code, and step_type are required' });
        }

        // Use step_name if provided, otherwise derive from step_code
        const finalStepName = step_name || step_code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        const result = await pool.query(`
            INSERT INTO flow_steps (flow_id, step_code, step_name, step_type, step_order, config, input_mapping)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [flow_id, step_code, finalStepName, step_type, step_order || 0,
            config ? JSON.stringify(config) : null,
            input_mapping ? JSON.stringify(input_mapping) : null]);

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Update step
app.put('/api/steps/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { step_code, step_name, step_type, step_order, config, input_mapping } = req.body;

        const result = await pool.query(`
            UPDATE flow_steps
            SET step_code = COALESCE($2, step_code),
                step_name = COALESCE($3, step_name),
                step_type = COALESCE($4, step_type),
                step_order = COALESCE($5, step_order),
                config = COALESCE($6, config),
                input_mapping = COALESCE($7, input_mapping),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, step_code, step_name, step_type, step_order,
            config ? JSON.stringify(config) : null,
            input_mapping ? JSON.stringify(input_mapping) : null]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Step not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Delete step
app.delete('/api/steps/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM flow_steps WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Step not found' });
        }

        res.json({ success: true, message: 'Step deleted' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get single step details
app.get('/api/steps/detail/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`
            SELECT fs.*, f.flow_code, f.flow_name
            FROM flow_steps fs
            JOIN flows f ON fs.flow_id = f.id
            WHERE fs.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Step not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// EVENT TYPE CRUD ENDPOINTS
// ============================================

// Create event type
app.post('/api/events', async (req, res) => {
    try {
        const { code, name, description, function_code, is_sync, is_active } = req.body;

        if (!code) {
            return res.json({ success: false, error: 'code is required' });
        }

        const result = await pool.query(`
            INSERT INTO event_types (event_code, event_name, description, function_code, is_sync, is_active)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, event_code as code, event_name as name, description, function_code, is_sync, is_active
        `, [code, name || code, description, function_code, is_sync || false, is_active !== false]);

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Update event type
app.put('/api/events/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { code, name, description, function_code, is_sync, is_active } = req.body;

        const result = await pool.query(`
            UPDATE event_types
            SET event_code = COALESCE($2, event_code),
                event_name = COALESCE($3, event_name),
                description = COALESCE($4, description),
                function_code = COALESCE($5, function_code),
                is_sync = COALESCE($6, is_sync),
                is_active = COALESCE($7, is_active),
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, event_code as code, event_name as name, description, function_code, is_sync, is_active
        `, [id, code, name, description, function_code, is_sync, is_active]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Event type not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Delete event type
app.delete('/api/events/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM event_types WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Event type not found' });
        }

        res.json({ success: true, message: 'Event type deleted' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// SYSTEM CONFIGURATION ENDPOINTS
// ============================================

// Get all system configurations
app.get('/api/configs', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, config_key, config_value, config_type, description, is_active, updated_at
            FROM system_configurations
            WHERE is_active = true
            ORDER BY config_key
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get single config by key
app.get('/api/configs/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const result = await pool.query(
            'SELECT * FROM system_configurations WHERE config_key = $1',
            [key]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Configuration not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Update config value
app.put('/api/configs/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const { value, description } = req.body;

        const result = await pool.query(`
            UPDATE system_configurations
            SET config_value = COALESCE($2, config_value),
                description = COALESCE($3, description),
                updated_at = NOW()
            WHERE config_key = $1
            RETURNING *
        `, [key, value, description]);

        if (result.rows.length === 0) {
            // Create if doesn't exist
            const insertResult = await pool.query(`
                INSERT INTO system_configurations (config_key, config_value, description)
                VALUES ($1, $2, $3)
                RETURNING *
            `, [key, value, description || '']);

            return res.json({ success: true, data: insertResult.rows[0], created: true });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ success: true, status: 'healthy', database: 'connected' });
    } catch (err) {
        res.json({ success: false, status: 'unhealthy', database: 'disconnected', error: err.message });
    }
});

// Start server
const PORT = process.env.TROUBLESHOOTER_PORT || 3333;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║     ORCHESTRATOR TROUBLESHOOTER v2.0                   ║
║     by Gashie                                          ║
╠════════════════════════════════════════════════════════╣
║     Running on http://localhost:${PORT}                   ║
║     Open in browser to access the terminal UI          ║
╚════════════════════════════════════════════════════════╝
    `);
});
