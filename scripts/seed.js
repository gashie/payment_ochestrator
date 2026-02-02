/**
 * Seed Script for Orchestrator Service
 * Populates database with initial flows, steps, and configurations
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'orchestrator_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres'
});

const seed = async () => {
    const client = await pool.connect();
    
    try {
        console.log('🌱 Starting Orchestrator database seeding...\n');

        await client.query('BEGIN');

        // 1. Create Roles
        console.log('Creating roles...');
        const rolesData = [
            { role_name: 'Super Admin', role_code: 'SUPER_ADMIN', description: 'Super Administrator', permissions: JSON.stringify(['*']) },
            { role_name: 'Flow Admin', role_code: 'FLOW_ADMIN', description: 'Flow Administrator', permissions: JSON.stringify(['flows:*', 'steps:*', 'mappings:*', 'monitoring:*']) },
            { role_name: 'Operator', role_code: 'OPERATOR', description: 'Operations user', permissions: JSON.stringify(['monitoring:*', 'instances:read', 'callbacks:process']) },
            { role_name: 'Viewer', role_code: 'VIEWER', description: 'Read-only access', permissions: JSON.stringify(['monitoring:read', 'reports:read']) }
        ];

        for (const role of rolesData) {
            await client.query(
                `INSERT INTO roles (id, role_name, role_code, description, permissions) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (role_code) DO UPDATE SET description = $4, permissions = $5`,
                [uuidv4(), role.role_name, role.role_code, role.description, role.permissions]
            );
        }
        console.log(`  ✅ Created ${rolesData.length} roles`);

        // Fetch actual role IDs from database
        const rolesResult = await client.query('SELECT id, role_code FROM roles');
        const roles = rolesResult.rows;

        // 2. Create Admin User
        console.log('Creating admin user...');
        const adminPassword = await bcrypt.hash('Admin@123', 10);
        const adminUserId = uuidv4();
        const superAdminRole = roles.find(r => r.role_code === 'SUPER_ADMIN');

        await client.query(
            `INSERT INTO users (id, username, email, password_hash, first_name, last_name, role_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (username) DO UPDATE SET email = $3, password_hash = $4`,
            [adminUserId, 'admin', 'admin@orchestrator.com', adminPassword, 'System', 'Administrator', superAdminRole.id, true]
        );
        console.log('  ✅ Created admin user');

        // 3. Create Event Types
        console.log('Creating event types...');
        const eventTypesData = [
            { event_code: 'NEC', event_name: 'Name Enquiry', description: 'Account name verification request', is_sync: true },
            { event_code: 'FT', event_name: 'Funds Transfer', description: 'Complete funds transfer (debit + credit)', is_sync: false },
            { event_code: 'FTD', event_name: 'Funds Transfer Debit', description: 'Debit leg of funds transfer', is_sync: false },
            { event_code: 'FTC', event_name: 'Funds Transfer Credit', description: 'Credit leg of funds transfer', is_sync: false },
            { event_code: 'TSQ', event_name: 'Transaction Status Query', description: 'Query transaction status', is_sync: true },
            { event_code: 'REV', event_name: 'Reversal', description: 'Transaction reversal', is_sync: false }
        ];

        for (const et of eventTypesData) {
            await client.query(
                `INSERT INTO event_types (id, event_code, event_name, description, is_sync) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (event_code) DO UPDATE SET event_name = $3, description = $4, is_sync = $5`,
                [uuidv4(), et.event_code, et.event_name, et.description, et.is_sync]
            );
        }
        console.log(`  ✅ Created ${eventTypesData.length} event types`);

        // Fetch actual event type IDs from database
        const eventTypesResult = await client.query('SELECT id, event_code FROM event_types');
        const eventTypes = eventTypesResult.rows;

        // 4. Create External APIs
        console.log('Creating external API configurations...');
        const externalApisData = [
            {
                api_code: 'GIP',
                api_name: 'Ghana Interbank Payment System',
                base_url: process.env.GIP_BASE_URL || 'http://localhost:4001/api/v1',
                default_headers: JSON.stringify({ 'Content-Type': 'application/json' }),
                timeout_ms: 30000,
                is_active: true
            },
            {
                api_code: 'BFS',
                api_name: 'Bank Flow System',
                base_url: process.env.BFS_BASE_URL || 'http://localhost:3001/api/v1',
                default_headers: JSON.stringify({ 'Content-Type': 'application/json' }),
                timeout_ms: 30000,
                is_active: true
            }
        ];

        for (const api of externalApisData) {
            await client.query(
                `INSERT INTO external_apis (id, api_code, api_name, base_url, default_headers, timeout_ms, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (api_code) DO UPDATE SET api_name = $3, base_url = $4, default_headers = $5`,
                [uuidv4(), api.api_code, api.api_name, api.base_url, api.default_headers, api.timeout_ms, api.is_active]
            );
        }
        console.log(`  ✅ Created ${externalApisData.length} external API configurations`);

        // Fetch actual external API IDs from database
        const externalApisResult = await client.query('SELECT id, api_code FROM external_apis');
        const externalApis = externalApisResult.rows;

        // 5. Create NEC Flow
        console.log('Creating NEC Flow...');
        const necEventType = eventTypes.find(e => e.event_code === 'NEC');
        const gipApi = externalApis.find(a => a.api_code === 'GIP');
        const bfsApi = externalApis.find(a => a.api_code === 'BFS');

        const necFlowId = uuidv4();
        await client.query(
            `INSERT INTO flows (id, flow_code, flow_name, event_type_id, description, is_active, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (flow_code) DO NOTHING`,
            [necFlowId, 'NEC_FLOW', 'NEC Flow', necEventType.id, 'Name Enquiry Flow - Synchronous account verification', true, 1]
        );

        // Fetch actual flow ID from database
        const necFlowResult = await client.query("SELECT id FROM flows WHERE flow_code = 'NEC_FLOW'");
        const actualNecFlowId = necFlowResult.rows[0]?.id || necFlowId;

        // NEC Request Mapping (for transform step)
        const necRequestMapping = [
            { source: 'srcBankCode', target: 'destBank' },
            { source: 'destBankCode', target: 'originBank' },
            { source: 'srcAccountNumber', target: 'accountToCredit' },
            { source: 'destAccountNumber', target: 'accountToDebit' },
            { source: null, target: 'functionCode', default_value: '230' },
            { source: 'channelCode', target: 'channelCode', default_value: '100' },
            { source: null, target: 'amount', default_value: '000000000000' },
            { source: 'narration', target: 'narration', default_value: 'Name Enquiry' },
            { source: null, target: 'dateTime', transform: 'formatDateTime' }
        ];

        // NEC Flow Steps
        const necSteps = [
            { id: uuidv4(), flow_id: actualNecFlowId, step_code: 'NEC_START', step_order: 1, step_type: 'START', step_name: 'Start', config: JSON.stringify({}), input_mapping: null },
            { id: uuidv4(), flow_id: actualNecFlowId, step_code: 'NEC_TRANSFORM_REQ', step_order: 2, step_type: 'TRANSFORM', step_name: 'Transform Request', config: JSON.stringify({ mapping_id: 'nec_request_mapping' }), input_mapping: JSON.stringify(necRequestMapping) },
            { id: uuidv4(), flow_id: actualNecFlowId, step_code: 'NEC_API_CALL', step_order: 3, step_type: 'API_CALL', step_name: 'Call GIP NEC', config: JSON.stringify({
                apiId: gipApi.id,
                pathTemplate: '/nec',
                method: 'POST',
                timeout_ms: 30000
            }), input_mapping: null },
            { id: uuidv4(), flow_id: actualNecFlowId, step_code: 'NEC_TRANSFORM_RES', step_order: 4, step_type: 'TRANSFORM', step_name: 'Transform Response', config: JSON.stringify({ mapping_id: 'nec_response_mapping' }), input_mapping: null },
            { id: uuidv4(), flow_id: actualNecFlowId, step_code: 'NEC_END', step_order: 5, step_type: 'END', step_name: 'End', config: JSON.stringify({}), input_mapping: null }
        ];

        for (const step of necSteps) {
            await client.query(
                `INSERT INTO flow_steps (id, flow_id, step_code, step_order, step_type, step_name, config, input_mapping)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (flow_id, step_code) DO UPDATE SET config = $7, input_mapping = $8`,
                [step.id, step.flow_id, step.step_code, step.step_order, step.step_type, step.step_name, step.config, step.input_mapping]
            );
        }

        // Fetch actual step IDs
        const necStepsResult = await client.query("SELECT id, step_code FROM flow_steps WHERE flow_id = $1 ORDER BY step_order", [actualNecFlowId]);
        const actualNecSteps = necStepsResult.rows;

        // NEC Flow Transitions
        for (let i = 0; i < actualNecSteps.length - 1; i++) {
            await client.query(
                `INSERT INTO step_transitions (id, flow_id, from_step_id, to_step_id, transition_type, conditions)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [uuidv4(), actualNecFlowId, actualNecSteps[i].id, actualNecSteps[i + 1].id, 'DEFAULT', JSON.stringify([])]
            );
        }
        console.log('  ✅ Created NEC Flow with 5 steps');

        // 6. Create FT Flow (Funds Transfer - Simplified: FTD → FTC → Callback)
        console.log('Creating FT Flow...');
        const ftEventType = eventTypes.find(e => e.event_code === 'FT');

        const ftFlowId = uuidv4();
        await client.query(
            `INSERT INTO flows (id, flow_code, flow_name, event_type_id, description, is_active, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (flow_code) DO UPDATE SET
                flow_name = EXCLUDED.flow_name,
                description = EXCLUDED.description,
                is_active = EXCLUDED.is_active`,
            [ftFlowId, 'FT_FLOW', 'FT Flow', ftEventType.id, 'Funds Transfer Flow - FTD → Callback → FTC → Callback → Complete (Reversal on FTC fail)', true, 1]
        );

        // Fetch actual FT flow ID from database
        const ftFlowResult = await client.query("SELECT id FROM flows WHERE flow_code = 'FT_FLOW'");
        const actualFtFlowId = ftFlowResult.rows[0]?.id || ftFlowId;

        // Clean up old FT flow data (in case of re-seeding)
        // Must delete in correct order due to foreign key constraints
        console.log('  Cleaning up old FT flow data...');

        // Get all flow instance IDs for this flow
        const oldInstances = await client.query(
            'SELECT id FROM flow_instances WHERE flow_id = $1',
            [actualFtFlowId]
        );
        const oldInstanceIds = oldInstances.rows.map(r => r.id);

        if (oldInstanceIds.length > 0) {
            // Delete related records for these instances
            await client.query('DELETE FROM expected_callbacks WHERE flow_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM received_callbacks WHERE matched_to_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM step_executions WHERE flow_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM tsq_requests WHERE flow_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM reversal_requests WHERE flow_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM process_logs WHERE flow_instance_id = ANY($1)', [oldInstanceIds]);
            await client.query('DELETE FROM flow_instances WHERE id = ANY($1)', [oldInstanceIds]);
            console.log(`    Removed ${oldInstanceIds.length} old flow instances and related data`);
        }

        // Now safe to delete steps and transitions
        await client.query('DELETE FROM step_transitions WHERE flow_id = $1', [actualFtFlowId]);
        await client.query('DELETE FROM flow_steps WHERE flow_id = $1', [actualFtFlowId]);
        console.log('  Cleaned up old FT flow steps');

        // FTD Request Mapping
        const ftdRequestMapping = [
            { source: 'srcBankCode', target: 'originBank' },
            { source: 'destBankCode', target: 'destBank' },
            { source: 'srcAccountNumber', target: 'accountToDebit' },
            { source: 'destAccountNumber', target: 'accountToCredit' },
            { source: 'srcAccountName', target: 'nameToDebit' },
            { source: 'destAccountName', target: 'nameToCredit' },
            { source: 'amount', target: 'amount', transform: 'formatAmount' },
            { source: null, target: 'functionCode', default_value: '241' },
            { source: 'channelCode', target: 'channelCode', default_value: '100' },
            { source: 'narration', target: 'narration' },
            { source: null, target: 'dateTime', transform: 'formatDateTime' }
        ];

        // FTC Request Mapping (swapped for credit leg)
        const ftcRequestMapping = [
            { source: 'srcBankCode', target: 'destBank' },
            { source: 'destBankCode', target: 'originBank' },
            { source: 'srcAccountNumber', target: 'accountToCredit' },
            { source: 'destAccountNumber', target: 'accountToDebit' },
            { source: 'srcAccountName', target: 'nameToCredit' },
            { source: 'destAccountName', target: 'nameToDebit' },
            { source: 'amount', target: 'amount', transform: 'formatAmount' },
            { source: null, target: 'functionCode', default_value: '240' },
            { source: 'channelCode', target: 'channelCode', default_value: '100' },
            { source: 'narration', target: 'narration' },
            { source: null, target: 'dateTime', transform: 'formatDateTime' }
        ];

        // FT Flow Steps (Simplified - No NEC)
        const ftStepsData = [
            { step_code: 'FT_START', step_order: 1, step_type: 'START', step_name: 'Start', config: {}, input_mapping: null },
            { step_code: 'FT_FTD_TRANSFORM', step_order: 2, step_type: 'TRANSFORM', step_name: 'Transform FTD Request', config: {}, input_mapping: ftdRequestMapping },
            { step_code: 'FT_FTD_CALL', step_order: 3, step_type: 'API_CALL', step_name: 'Send FTD to GIP', config: { apiId: gipApi.id, pathTemplate: '/ftd', method: 'POST', includeCallback: true }, input_mapping: null },
            { step_code: 'FT_FTD_CALLBACK', step_order: 4, step_type: 'CALLBACK', step_name: 'Wait FTD Callback', config: { timeout: 300000, callbackType: 'FTD_RESPONSE' }, input_mapping: null },
            { step_code: 'FT_FTD_CHECK', step_order: 5, step_type: 'CONDITION', step_name: 'Check FTD Result', config: { condition: "actionCode === '000'" }, input_mapping: null },
            { step_code: 'FT_FTC_TRANSFORM', step_order: 6, step_type: 'TRANSFORM', step_name: 'Transform FTC Request', config: {}, input_mapping: ftcRequestMapping },
            { step_code: 'FT_FTC_CALL', step_order: 7, step_type: 'API_CALL', step_name: 'Send FTC to GIP', config: { apiId: gipApi.id, pathTemplate: '/ftc', method: 'POST', includeCallback: true }, input_mapping: null },
            { step_code: 'FT_FTC_CALLBACK', step_order: 8, step_type: 'CALLBACK', step_name: 'Wait FTC Callback', config: { timeout: 300000, callbackType: 'FTC_RESPONSE' }, input_mapping: null },
            { step_code: 'FT_FTC_CHECK', step_order: 9, step_type: 'CONDITION', step_name: 'Check FTC Result', config: { condition: "actionCode === '000'" }, input_mapping: null },
            { step_code: 'FT_END_SUCCESS', step_order: 10, step_type: 'END', step_name: 'End Success', config: { status: 'SUCCESS' }, input_mapping: null },
            { step_code: 'FT_FTD_FAIL_END', step_order: 11, step_type: 'END', step_name: 'End FTD Failed', config: { status: 'FAILED', reason: 'FTD_FAILED' }, input_mapping: null },
            { step_code: 'FT_REVERSAL', step_order: 12, step_type: 'TASK', step_name: 'Trigger Reversal', config: { taskType: 'REVERSAL', reason: 'FTC_FAILED' }, input_mapping: null },
            { step_code: 'FT_END_REVERSAL', step_order: 13, step_type: 'END', step_name: 'End - Reversal Triggered', config: { status: 'FAILED', reason: 'FTC_FAILED_REVERSAL_TRIGGERED' }, input_mapping: null }
        ];

        for (const step of ftStepsData) {
            await client.query(
                `INSERT INTO flow_steps (id, flow_id, step_code, step_order, step_type, step_name, config, input_mapping)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (flow_id, step_code) DO UPDATE SET config = $7, input_mapping = $8, step_order = $4`,
                [uuidv4(), actualFtFlowId, step.step_code, step.step_order, step.step_type, step.step_name,
                 JSON.stringify(step.config), step.input_mapping ? JSON.stringify(step.input_mapping) : null]
            );
        }

        // Fetch actual FT step IDs
        const ftStepsResult = await client.query("SELECT id, step_code, step_order FROM flow_steps WHERE flow_id = $1 ORDER BY step_order", [actualFtFlowId]);
        const ftSteps = ftStepsResult.rows;

        // Build step lookup by step_code
        const ftStepLookup = {};
        ftSteps.forEach(s => { ftStepLookup[s.step_code] = s; });

        // FT Flow Transitions (Simplified)
        // START → FTD_TRANSFORM → FTD_CALL → FTD_CALLBACK → FTD_CHECK
        // FTD_CHECK (success) → FTC_TRANSFORM → FTC_CALL → FTC_CALLBACK → FTC_CHECK
        // FTD_CHECK (fail) → FTD_FAIL_END
        // FTC_CHECK (success) → END_SUCCESS
        // FTC_CHECK (fail) → REVERSAL → END_REVERSAL
        const ftTransitions = [
            { from: 'FT_START', to: 'FT_FTD_TRANSFORM', type: 'DEFAULT' },
            { from: 'FT_FTD_TRANSFORM', to: 'FT_FTD_CALL', type: 'DEFAULT' },
            { from: 'FT_FTD_CALL', to: 'FT_FTD_CALLBACK', type: 'DEFAULT' },
            { from: 'FT_FTD_CALLBACK', to: 'FT_FTD_CHECK', type: 'DEFAULT' },
            { from: 'FT_FTD_CHECK', to: 'FT_FTC_TRANSFORM', type: 'CONDITION', condition: 'SUCCESS' },
            { from: 'FT_FTD_CHECK', to: 'FT_FTD_FAIL_END', type: 'CONDITION', condition: 'FAILED' },
            { from: 'FT_FTC_TRANSFORM', to: 'FT_FTC_CALL', type: 'DEFAULT' },
            { from: 'FT_FTC_CALL', to: 'FT_FTC_CALLBACK', type: 'DEFAULT' },
            { from: 'FT_FTC_CALLBACK', to: 'FT_FTC_CHECK', type: 'DEFAULT' },
            { from: 'FT_FTC_CHECK', to: 'FT_END_SUCCESS', type: 'CONDITION', condition: 'SUCCESS' },
            { from: 'FT_FTC_CHECK', to: 'FT_REVERSAL', type: 'CONDITION', condition: 'FAILED' },
            { from: 'FT_REVERSAL', to: 'FT_END_REVERSAL', type: 'DEFAULT' }
        ];

        for (const trans of ftTransitions) {
            const fromStep = ftStepLookup[trans.from];
            const toStep = ftStepLookup[trans.to];
            if (fromStep && toStep) {
                await client.query(
                    `INSERT INTO step_transitions (id, flow_id, from_step_id, to_step_id, transition_type, conditions)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT DO NOTHING`,
                    [uuidv4(), actualFtFlowId, fromStep.id, toStep.id, trans.type, JSON.stringify([{ condition: trans.condition || null }])]
                );
            }
        }
        console.log(`  ✅ Created FT Flow with ${ftStepsData.length} steps (FTD → FTC → Callback, no NEC)`);

        // 7. Create Field Mappings
        console.log('Creating field mappings...');
        const fieldMappings = [
            // NEC Request Mapping (swapped)
            {
                mapping_code: 'nec_request_mapping',
                mapping_name: 'NEC Request Mapping',
                description: 'Transform incoming NEC request for GIP',
                mappings: JSON.stringify([
                    { source: 'srcBankCode', target: 'destBank', transform: null },
                    { source: 'destBankCode', target: 'originBank', transform: null },
                    { source: 'srcAccountNumber', target: 'accountToCredit', transform: null },
                    { source: 'destAccountNumber', target: 'accountToDebit', transform: null },
                    { source: null, target: 'functionCode', default_value: '230' },
                    { source: 'channelCode', target: 'channelCode', default_value: '100' },
                    { source: null, target: 'amount', default_value: '000000000000' },
                    { source: 'narration', target: 'narration', default_value: 'Name Enquiry' },
                    { source: null, target: 'dateTime', transform: 'formatDateTime' }
                ])
            },
            // FTD Request Mapping (normal)
            {
                mapping_code: 'ftd_request_mapping',
                mapping_name: 'FTD Request Mapping',
                description: 'Transform FT request for FTD (debit)',
                mappings: JSON.stringify([
                    { source: 'srcBankCode', target: 'originBank', transform: null },
                    { source: 'destBankCode', target: 'destBank', transform: null },
                    { source: 'srcAccountNumber', target: 'accountToDebit', transform: null },
                    { source: 'destAccountNumber', target: 'accountToCredit', transform: null },
                    { source: 'amount', target: 'amount', transform: 'formatAmount' },
                    { source: null, target: 'functionCode', default_value: '241' },
                    { source: 'channelCode', target: 'channelCode', default_value: '100' },
                    { source: 'narration', target: 'narration', transform: null },
                    { source: 'nameToDebit', target: 'nameToDebit', transform: null },
                    { source: 'nameToCredit', target: 'nameToCredit', transform: null },
                    { source: null, target: 'dateTime', transform: 'formatDateTime' }
                ])
            },
            // FTC Request Mapping (swapped)
            {
                mapping_code: 'ftc_request_mapping',
                mapping_name: 'FTC Request Mapping',
                description: 'Transform FT request for FTC (credit)',
                mappings: JSON.stringify([
                    { source: 'srcBankCode', target: 'destBank', transform: null },
                    { source: 'destBankCode', target: 'originBank', transform: null },
                    { source: 'srcAccountNumber', target: 'accountToCredit', transform: null },
                    { source: 'destAccountNumber', target: 'accountToDebit', transform: null },
                    { source: 'amount', target: 'amount', transform: 'formatAmount' },
                    { source: null, target: 'functionCode', default_value: '240' },
                    { source: 'channelCode', target: 'channelCode', default_value: '100' },
                    { source: 'narration', target: 'narration', transform: null },
                    { source: 'nameToDebit', target: 'nameToDebit', transform: null },
                    { source: 'nameToCredit', target: 'nameToCredit', transform: null },
                    { source: null, target: 'dateTime', transform: 'formatDateTime' }
                ])
            },
            // TSQ Request Mapping
            {
                mapping_code: 'tsq_request_mapping',
                mapping_name: 'TSQ Request Mapping',
                description: 'Transform request for Transaction Status Query',
                mappings: JSON.stringify([
                    { source: 'originBank', target: 'originBank', transform: null },
                    { source: 'destBank', target: 'destBank', transform: null },
                    { source: 'sessionId', target: 'sessionId', transform: null },
                    { source: 'trackingNumber', target: 'trackingNumber', transform: null },
                    { source: 'amount', target: 'amount', transform: null },
                    { source: 'accountToDebit', target: 'accountToDebit', transform: null },
                    { source: 'accountToCredit', target: 'accountToCredit', transform: null },
                    { source: 'channelCode', target: 'channelCode', default_value: '100' },
                    { source: null, target: 'functionCode', default_value: '111' },
                    { source: null, target: 'dateTime', transform: 'formatDateTime' }
                ])
            }
        ];

        for (const mapping of fieldMappings) {
            await client.query(
                `INSERT INTO field_mappings (id, mapping_code, mapping_name, description, mappings)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (mapping_code) DO UPDATE SET mapping_name = $3, description = $4, mappings = $5`,
                [uuidv4(), mapping.mapping_code, mapping.mapping_name, mapping.description, mapping.mappings]
            );
        }
        console.log(`  ✅ Created ${fieldMappings.length} field mappings`);

        // 8. Create Flow Versions (REQUIRED for flow execution)
        console.log('Creating flow versions...');
        
        // NEC Flow Version
        await client.query(
            `INSERT INTO flow_versions (id, flow_id, version, flow_definition, is_active, activated_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (flow_id, version) DO NOTHING`,
            [
                uuidv4(),
                actualNecFlowId,
                1,
                JSON.stringify({
                    flowId: actualNecFlowId,
                    version: 1,
                    name: 'NEC Flow v1',
                    steps: actualNecSteps,
                    description: 'Initial version of NEC flow'
                }),
                true,
                new Date(),
                adminUserId
            ]
        );

        // FT Flow Version
        await client.query(
            `INSERT INTO flow_versions (id, flow_id, version, flow_definition, is_active, activated_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (flow_id, version) DO NOTHING`,
            [
                uuidv4(),
                actualFtFlowId,
                1,
                JSON.stringify({
                    flowId: actualFtFlowId,
                    version: 1,
                    name: 'FT Flow v1',
                    steps: ftSteps,
                    description: 'Initial version of FT flow'
                }),
                true,
                new Date(),
                adminUserId
            ]
        );
        console.log('  ✅ Created 2 flow versions (NEC v1, FT v1)');

        // 8. Create Alert Rules
        console.log('Creating alert rules...');
        const alertRules = [
            { alert_name: 'Flow Failure Alert', alert_type: 'ERROR', trigger_event: 'FLOW_FAILED', channels: JSON.stringify(['webhook']), is_active: true },
            { alert_name: 'Callback Timeout Alert', alert_type: 'WARNING', trigger_event: 'CALLBACK_TIMEOUT', channels: JSON.stringify(['webhook']), is_active: true },
            { alert_name: 'TSQ Failure Alert', alert_type: 'ERROR', trigger_event: 'TSQ_FAILED', channels: JSON.stringify(['email']), is_active: true },
            { alert_name: 'Reversal Triggered Alert', alert_type: 'ERROR', trigger_event: 'REVERSAL_TRIGGERED', channels: JSON.stringify(['webhook']), is_active: true }
        ];

        for (const rule of alertRules) {
            await client.query(
                `INSERT INTO alert_rules (id, alert_name, alert_type, trigger_event, channels, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [uuidv4(), rule.alert_name, rule.alert_type, rule.trigger_event, rule.channels, rule.is_active]
            );
        }
        console.log(`  ✅ Created ${alertRules.length} alert rules`);

        // 9. Create System Configurations
        console.log('Creating system configurations...');
        const systemConfigs = [
            { key: 'ORCHESTRATOR_BASE_URL', value: 'http://localhost:3002', type: 'STRING', desc: 'Base URL for orchestrator callbacks (change this for production)' },
            { key: 'TSQ_MAX_RETRIES', value: '3', type: 'NUMBER', desc: 'Maximum TSQ retry attempts' },
            { key: 'TSQ_RETRY_INTERVAL', value: '300', type: 'NUMBER', desc: 'TSQ retry interval in seconds' },
            { key: 'CALLBACK_TIMEOUT', value: '300', type: 'NUMBER', desc: 'Callback wait timeout in seconds' },
            { key: 'JOB_PROCESS_INTERVAL', value: '5000', type: 'NUMBER', desc: 'Job processing interval in ms' }
        ];

        for (const cfg of systemConfigs) {
            await client.query(
                `INSERT INTO system_configurations (id, config_key, config_value, config_type, description)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (config_key) DO UPDATE SET
                    description = EXCLUDED.description,
                    config_type = EXCLUDED.config_type`,
                [uuidv4(), cfg.key, cfg.value, cfg.type, cfg.desc]
            );
        }
        console.log(`  ✅ Created ${systemConfigs.length} system configurations`);

        await client.query('COMMIT');

        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('🎉 Orchestrator database seeding completed!');
        console.log('='.repeat(60));
        console.log('\n📋 Summary:');
        console.log(`   • ${rolesData.length} roles`);
        console.log(`   • 1 admin user`);
        console.log(`   • ${eventTypesData.length} event types`);
        console.log(`   • ${externalApisData.length} external API configurations`);
        console.log(`   • 2 flows (NEC, FT)`);
        console.log(`   • ${actualNecSteps.length + ftSteps.length} total flow steps`);
        console.log(`   • ${fieldMappings.length} field mappings`);
        console.log(`   • ${alertRules.length} alert rules`);
        
        console.log('\n👤 Admin Login:');
        console.log('   Username: admin');
        console.log('   Password: Admin@123');

        console.log('\n📊 Flows Created:');
        console.log('   • NEC Flow (Synchronous): Start → Transform → API Call → Transform → End');
        console.log('   • FT Flow (Asynchronous): Start → FTD Transform → FTD Call → FTD Callback →');
        console.log('                             FTD Check → FTC Transform → FTC Call → FTC Callback →');
        console.log('                             FTC Check → Success OR Reversal');
        console.log('');
        console.log('   FT Flow Path:');
        console.log('     ┌─────────┐    ┌─────────────┐    ┌──────────┐    ┌─────────────┐');
        console.log('     │  START  │ → │ FTD Transform│ → │ FTD Call │ → │ FTD Callback │');
        console.log('     └─────────┘    └─────────────┘    └──────────┘    └─────────────┘');
        console.log('                                                              ↓');
        console.log('     ┌───────────┐   ┌─────────────┐    ┌──────────┐    ┌───────────┐');
        console.log('     │ FTD Check │ ← ┤ Success?    │ → │ FTC Trans│ → │ FTC Call  │');
        console.log('     └───────────┘   │ No→FTD Fail │    └──────────┘    └───────────┘');
        console.log('                     └─────────────┘                          ↓');
        console.log('     ┌───────────┐   ┌─────────────┐                    ┌───────────┐');
        console.log('     │ FTC Check │ ← │FTC Callback │ ←──────────────────┤           │');
        console.log('     └───────────┘   └─────────────┘                    └───────────┘');
        console.log('           ↓');
        console.log('     Success → END SUCCESS');
        console.log('     Failed  → REVERSAL → END REVERSAL');
        console.log('');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Seeding failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

// CLI handling
const command = process.argv[2];

if (command === 'help') {
    console.log(`
Orchestrator Service - Database Seeder

Usage:
  node seed.js          Run the seeder
  node seed.js help     Show this help message

Note: This script will populate the database with sample flows and configurations.
`);
} else {
    seed().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
