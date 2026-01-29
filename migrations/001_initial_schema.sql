-- Orchestrator Database Schema
-- Dynamic Flow Processing Engine with BPMN-like workflow management

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- SEQUENCE AND FUNCTION FOR UNIQUE ID GENERATION
-- =====================================================

-- Sequence for tracking numbers (6 digits)
CREATE SEQUENCE IF NOT EXISTS orch_tracking_number_seq
    START WITH 100000
    INCREMENT BY 1
    MINVALUE 100000
    MAXVALUE 999999
    CYCLE;

-- Sequence for session IDs (12 digits)
CREATE SEQUENCE IF NOT EXISTS orch_session_id_seq
    START WITH 100000000000
    INCREMENT BY 1
    MINVALUE 100000000000
    MAXVALUE 999999999999
    CYCLE;

-- Function to generate unique tracking number
CREATE OR REPLACE FUNCTION generate_orch_tracking_number()
RETURNS VARCHAR(12) AS $$
DECLARE
    seq_val BIGINT;
    result VARCHAR(12);
BEGIN
    seq_val := nextval('orch_tracking_number_seq');
    result := LPAD((seq_val % 1000000)::TEXT, 6, '0');
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to generate unique session ID
CREATE OR REPLACE FUNCTION generate_orch_session_id()
RETURNS VARCHAR(12) AS $$
DECLARE
    seq_val BIGINT;
    ts_part BIGINT;
    result VARCHAR(12);
BEGIN
    seq_val := nextval('orch_session_id_seq');
    ts_part := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT % 1000000;
    result := LPAD(((seq_val % 1000000) * 1000000 + ts_part)::TEXT, 12, '0');
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to format amount to defined length with leading zeros
CREATE OR REPLACE FUNCTION format_amount_dynamic(amount NUMERIC, length INT DEFAULT 12)
RETURNS VARCHAR AS $$
BEGIN
    RETURN LPAD((amount * 100)::BIGINT::TEXT, length, '0');
END;
$$ LANGUAGE plpgsql;

-- Function to convert timestamp to custom format (YYMMDDHHMMSS)
CREATE OR REPLACE FUNCTION format_datetime(ts TIMESTAMP)
RETURNS VARCHAR(12) AS $$
BEGIN
    RETURN TO_CHAR(ts, 'YYMMDDHH24MISS');
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- EVENT TYPES
-- =====================================================

CREATE TABLE IF NOT EXISTS event_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_code VARCHAR(50) NOT NULL UNIQUE,
    event_name VARCHAR(255) NOT NULL,
    function_code VARCHAR(10),
    description TEXT,
    is_sync BOOLEAN DEFAULT true,
    default_timeout_seconds INT DEFAULT 30,
    field_schema JSONB DEFAULT '{}',
    response_schema JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_event_types_code ON event_types(event_code);
CREATE INDEX idx_event_types_function ON event_types(function_code);

-- =====================================================
-- FLOW DEFINITIONS (BPMN-like workflows)
-- =====================================================

-- Main flow definitions
CREATE TABLE IF NOT EXISTS flows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_code VARCHAR(50) NOT NULL UNIQUE,
    flow_name VARCHAR(255) NOT NULL,
    description TEXT,
    version INT DEFAULT 1,
    event_type_id UUID REFERENCES event_types(id),
    is_sync BOOLEAN DEFAULT false,
    timeout_seconds INT DEFAULT 300,
    retry_config JSONB DEFAULT '{"max_retries": 3, "retry_interval": 300}',
    is_active BOOLEAN DEFAULT true,
    is_published BOOLEAN DEFAULT false,
    published_at TIMESTAMP,
    bpmn_diagram JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_flows_code ON flows(flow_code);
CREATE INDEX idx_flows_event ON flows(event_type_id);
CREATE INDEX idx_flows_active ON flows(is_active, is_published);

-- Flow versions for history
CREATE TABLE IF NOT EXISTS flow_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    version INT NOT NULL,
    flow_definition JSONB NOT NULL,
    is_active BOOLEAN DEFAULT false,
    activated_at TIMESTAMP,
    deactivated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    UNIQUE(flow_id, version)
);

CREATE INDEX idx_flow_versions_flow ON flow_versions(flow_id);

-- =====================================================
-- FLOW STEPS (Pipeline stages)
-- =====================================================

-- Step types: START, END, TASK, GATEWAY, EVENT, LISTENER, CALLBACK, API_CALL, TRANSFORM, CONDITION, MANUAL, ALERT
CREATE TABLE IF NOT EXISTS flow_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    step_code VARCHAR(50) NOT NULL,
    step_name VARCHAR(255) NOT NULL,
    step_type VARCHAR(50) NOT NULL,
    step_order INT NOT NULL DEFAULT 0,
    description TEXT,
    
    -- Configuration
    config JSONB DEFAULT '{}',
    
    -- API Call configuration
    api_endpoint VARCHAR(500),
    api_method VARCHAR(10) DEFAULT 'POST',
    api_headers JSONB DEFAULT '{}',
    api_timeout_ms INT DEFAULT 30000,
    
    -- Field mappings for this step
    input_mapping JSONB DEFAULT '{}',
    output_mapping JSONB DEFAULT '{}',
    
    -- Conditions and rules
    conditions JSONB DEFAULT '[]',
    validation_rules JSONB DEFAULT '[]',
    
    -- Error handling
    on_error_action VARCHAR(50) DEFAULT 'FAIL',
    error_handler_step_id UUID,
    retry_config JSONB DEFAULT '{"enabled": false, "max_retries": 0}',
    
    -- Listener/Callback configuration
    wait_for_callback BOOLEAN DEFAULT false,
    callback_timeout_seconds INT DEFAULT 300,
    callback_success_conditions JSONB DEFAULT '[]',
    callback_failure_conditions JSONB DEFAULT '[]',
    
    -- Manual intervention
    requires_approval BOOLEAN DEFAULT false,
    approval_roles JSONB DEFAULT '[]',
    
    -- BPMN positioning
    position_x INT DEFAULT 0,
    position_y INT DEFAULT 0,
    
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID,
    UNIQUE(flow_id, step_code)
);

CREATE INDEX idx_flow_steps_flow ON flow_steps(flow_id);
CREATE INDEX idx_flow_steps_type ON flow_steps(step_type);
CREATE INDEX idx_flow_steps_order ON flow_steps(flow_id, step_order);

-- Step connections (transitions)
CREATE TABLE IF NOT EXISTS step_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    from_step_id UUID NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
    to_step_id UUID NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
    transition_name VARCHAR(255),
    transition_type VARCHAR(50) DEFAULT 'DEFAULT',
    conditions JSONB DEFAULT '[]',
    priority INT DEFAULT 0,
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_step_transitions_flow ON step_transitions(flow_id);
CREATE INDEX idx_step_transitions_from ON step_transitions(from_step_id);
CREATE INDEX idx_step_transitions_to ON step_transitions(to_step_id);

-- =====================================================
-- FIELD MAPPINGS
-- =====================================================

CREATE TABLE IF NOT EXISTS field_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mapping_code VARCHAR(50) NOT NULL UNIQUE,
    mapping_name VARCHAR(255) NOT NULL,
    event_type_id UUID REFERENCES event_types(id),
    description TEXT,
    
    -- Source to target field mappings
    mappings JSONB NOT NULL DEFAULT '[]',
    
    -- Transformations
    transformations JSONB DEFAULT '[]',
    
    -- Swap configurations (for FTD/FTC/NEC)
    swap_config JSONB DEFAULT '{}',
    
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_field_mappings_code ON field_mappings(mapping_code);
CREATE INDEX idx_field_mappings_event ON field_mappings(event_type_id);

-- =====================================================
-- PROCESS EXECUTION (Runtime)
-- =====================================================

-- Flow instances (process executions)
CREATE TABLE IF NOT EXISTS flow_instances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_id UUID NOT NULL REFERENCES flows(id),
    session_id VARCHAR(12) NOT NULL DEFAULT generate_orch_session_id() UNIQUE,
    tracking_number VARCHAR(12) NOT NULL DEFAULT generate_orch_tracking_number(),
    bfs_session_id VARCHAR(12),
    bfs_tracking_number VARCHAR(12),
    parent_instance_id UUID REFERENCES flow_instances(id),
    
    -- Status: PENDING, RUNNING, WAITING, COMPLETED, FAILED, CANCELLED, MANUAL_REVIEW
    status VARCHAR(50) DEFAULT 'PENDING',
    current_step_id UUID REFERENCES flow_steps(id),
    
    -- Request data
    original_request JSONB NOT NULL,
    current_payload JSONB,
    
    -- Response data
    final_response JSONB,
    response_code VARCHAR(10),
    response_message TEXT,
    
    -- Callback info from BFS
    bfs_callback_url VARCHAR(500),
    callback_sent BOOLEAN DEFAULT false,
    callback_sent_at TIMESTAMP,
    
    -- Timing
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    expires_at TIMESTAMP,
    
    -- Error tracking
    error_count INT DEFAULT 0,
    last_error TEXT,
    error_details JSONB,
    
    -- Manual intervention
    requires_manual BOOLEAN DEFAULT false,
    manual_reason TEXT,
    manual_assigned_to UUID,
    manual_completed_by UUID,
    manual_completed_at TIMESTAMP,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_flow_instances_flow ON flow_instances(flow_id);
CREATE INDEX idx_flow_instances_session ON flow_instances(session_id);
CREATE INDEX idx_flow_instances_tracking ON flow_instances(tracking_number);
CREATE INDEX idx_flow_instances_bfs_session ON flow_instances(bfs_session_id);
CREATE INDEX idx_flow_instances_status ON flow_instances(status);
CREATE INDEX idx_flow_instances_current_step ON flow_instances(current_step_id);
CREATE INDEX idx_flow_instances_parent ON flow_instances(parent_instance_id);
CREATE INDEX idx_flow_instances_manual ON flow_instances(requires_manual) WHERE requires_manual = true;

-- Step executions (individual step runs)
CREATE TABLE IF NOT EXISTS step_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_instance_id UUID NOT NULL REFERENCES flow_instances(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES flow_steps(id),
    session_id VARCHAR(12),
    tracking_number VARCHAR(12),
    
    -- Status: PENDING, RUNNING, WAITING_CALLBACK, COMPLETED, FAILED, SKIPPED, TIMEOUT, MANUAL
    status VARCHAR(50) DEFAULT 'PENDING',
    
    -- Execution details
    input_payload JSONB,
    output_payload JSONB,
    transformed_payload JSONB,
    
    -- API call details
    api_request JSONB,
    api_response JSONB,
    api_status_code INT,
    api_response_time_ms INT,
    
    -- Response tracking
    response_code VARCHAR(10),
    response_message TEXT,
    action_code VARCHAR(10),
    approval_code VARCHAR(50),
    
    -- Callback handling
    waiting_for_callback BOOLEAN DEFAULT false,
    callback_received BOOLEAN DEFAULT false,
    callback_payload JSONB,
    callback_received_at TIMESTAMP,
    
    -- Timing
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    timeout_at TIMESTAMP,
    
    -- Retry tracking
    attempt_number INT DEFAULT 1,
    max_attempts INT DEFAULT 1,
    next_retry_at TIMESTAMP,
    
    -- Error tracking
    error_message TEXT,
    error_details JSONB,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_step_executions_instance ON step_executions(flow_instance_id);
CREATE INDEX idx_step_executions_step ON step_executions(step_id);
CREATE INDEX idx_step_executions_session ON step_executions(session_id);
CREATE INDEX idx_step_executions_status ON step_executions(status);
CREATE INDEX idx_step_executions_waiting ON step_executions(waiting_for_callback) WHERE waiting_for_callback = true;

-- =====================================================
-- CALLBACK MANAGEMENT
-- =====================================================

-- Expected callbacks (what we're waiting for)
CREATE TABLE IF NOT EXISTS expected_callbacks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_instance_id UUID NOT NULL REFERENCES flow_instances(id),
    step_execution_id UUID NOT NULL REFERENCES step_executions(id),
    session_id VARCHAR(12) NOT NULL,
    tracking_number VARCHAR(12) NOT NULL,
    callback_type VARCHAR(50) NOT NULL,
    
    -- Status: WAITING, RECEIVED, TIMEOUT, CANCELLED
    status VARCHAR(50) DEFAULT 'WAITING',
    
    -- Matching criteria
    match_fields JSONB DEFAULT '{}',
    
    -- Success/Failure conditions
    success_conditions JSONB DEFAULT '[]',
    failure_conditions JSONB DEFAULT '[]',
    
    -- Timing
    expected_by TIMESTAMP NOT NULL,
    received_at TIMESTAMP,
    
    -- Received data
    received_payload JSONB,
    match_result JSONB,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expected_callbacks_instance ON expected_callbacks(flow_instance_id);
CREATE INDEX idx_expected_callbacks_step ON expected_callbacks(step_execution_id);
CREATE INDEX idx_expected_callbacks_session ON expected_callbacks(session_id);
CREATE INDEX idx_expected_callbacks_tracking ON expected_callbacks(tracking_number);
CREATE INDEX idx_expected_callbacks_status ON expected_callbacks(status);
CREATE INDEX idx_expected_callbacks_expected ON expected_callbacks(expected_by) WHERE status = 'WAITING';

-- Received callbacks (external callbacks received)
CREATE TABLE IF NOT EXISTS received_callbacks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id VARCHAR(12),
    tracking_number VARCHAR(12),
    source VARCHAR(100) NOT NULL,
    callback_type VARCHAR(50),
    
    -- Payload
    payload JSONB NOT NULL,
    headers JSONB,
    
    -- Extracted fields
    action_code VARCHAR(10),
    approval_code VARCHAR(50),
    function_code VARCHAR(10),
    
    -- Processing status
    processed BOOLEAN DEFAULT false,
    matched_to_instance_id UUID REFERENCES flow_instances(id),
    matched_to_step_id UUID REFERENCES step_executions(id),
    processed_at TIMESTAMP,
    
    -- Error handling
    error_message TEXT,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_received_callbacks_session ON received_callbacks(session_id);
CREATE INDEX idx_received_callbacks_tracking ON received_callbacks(tracking_number);
CREATE INDEX idx_received_callbacks_processed ON received_callbacks(processed);

-- =====================================================
-- TSQ (Transaction Status Query) MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS tsq_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_instance_id UUID NOT NULL REFERENCES flow_instances(id),
    step_execution_id UUID REFERENCES step_executions(id),
    original_session_id VARCHAR(12) NOT NULL,
    original_tracking_number VARCHAR(12) NOT NULL,
    tsq_session_id VARCHAR(12) NOT NULL DEFAULT generate_orch_session_id(),
    tsq_tracking_number VARCHAR(12) NOT NULL DEFAULT generate_orch_tracking_number(),
    
    -- Status: PENDING, SENT, SUCCESS, FAILED, TIMEOUT, RETRY
    status VARCHAR(50) DEFAULT 'PENDING',
    
    -- Request/Response
    request_payload JSONB NOT NULL,
    response_payload JSONB,
    response_code VARCHAR(10),
    action_code VARCHAR(10),
    
    -- Retry tracking
    attempt_number INT DEFAULT 1,
    max_attempts INT DEFAULT 3,
    retry_interval_seconds INT DEFAULT 300,
    next_retry_at TIMESTAMP,
    
    -- Timing
    sent_at TIMESTAMP,
    response_at TIMESTAMP,
    expires_at TIMESTAMP,
    
    -- Result interpretation
    result_status VARCHAR(50),
    result_message TEXT,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tsq_requests_instance ON tsq_requests(flow_instance_id);
CREATE INDEX idx_tsq_requests_original_session ON tsq_requests(original_session_id);
CREATE INDEX idx_tsq_requests_status ON tsq_requests(status);
CREATE INDEX idx_tsq_requests_retry ON tsq_requests(next_retry_at) WHERE status IN ('PENDING', 'RETRY');

-- =====================================================
-- REVERSAL MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS reversal_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_instance_id UUID NOT NULL REFERENCES flow_instances(id),
    original_step_execution_id UUID REFERENCES step_executions(id),
    reversal_type VARCHAR(50) NOT NULL,
    
    -- Session tracking
    reversal_session_id VARCHAR(12) NOT NULL DEFAULT generate_orch_session_id(),
    reversal_tracking_number VARCHAR(12) NOT NULL DEFAULT generate_orch_tracking_number(),
    
    -- What we're reversing
    original_session_id VARCHAR(12) NOT NULL,
    original_tracking_number VARCHAR(12) NOT NULL,
    original_transaction_type VARCHAR(50),
    
    -- Status: PENDING, PROCESSING, SUCCESS, FAILED, MANUAL
    status VARCHAR(50) DEFAULT 'PENDING',
    
    -- Request/Response
    request_payload JSONB,
    response_payload JSONB,
    response_code VARCHAR(10),
    action_code VARCHAR(10),
    
    -- Reason and tracking
    reason TEXT,
    initiated_by VARCHAR(100),
    approved_by UUID,
    approved_at TIMESTAMP,
    
    -- Timing
    processed_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Linked reversal flow instance
    reversal_flow_instance_id UUID REFERENCES flow_instances(id),
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reversal_requests_instance ON reversal_requests(flow_instance_id);
CREATE INDEX idx_reversal_requests_original ON reversal_requests(original_session_id);
CREATE INDEX idx_reversal_requests_status ON reversal_requests(status);

-- =====================================================
-- AUDIT AND LOGGING
-- =====================================================

CREATE TABLE IF NOT EXISTS process_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flow_instance_id UUID REFERENCES flow_instances(id),
    step_execution_id UUID REFERENCES step_executions(id),
    session_id VARCHAR(12),
    log_level VARCHAR(20) NOT NULL DEFAULT 'INFO',
    log_type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    details JSONB,
    stack_trace TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_process_logs_instance ON process_logs(flow_instance_id);
CREATE INDEX idx_process_logs_step ON process_logs(step_execution_id);
CREATE INDEX idx_process_logs_session ON process_logs(session_id);
CREATE INDEX idx_process_logs_level ON process_logs(log_level);
CREATE INDEX idx_process_logs_created ON process_logs(created_at);

CREATE TABLE IF NOT EXISTS event_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL,
    event_source VARCHAR(100),
    flow_instance_id UUID REFERENCES flow_instances(id),
    step_execution_id UUID REFERENCES step_executions(id),
    session_id VARCHAR(12),
    tracking_number VARCHAR(12),
    event_data JSONB,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_event_logs_type ON event_logs(event_type);
CREATE INDEX idx_event_logs_instance ON event_logs(flow_instance_id);
CREATE INDEX idx_event_logs_session ON event_logs(session_id);
CREATE INDEX idx_event_logs_created ON event_logs(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID,
    action VARCHAR(50) NOT NULL,
    actor_type VARCHAR(50) NOT NULL,
    actor_id UUID,
    actor_name VARCHAR(255),
    ip_address VARCHAR(45),
    old_values JSONB,
    new_values JSONB,
    changes JSONB,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

-- =====================================================
-- ALERTS
-- =====================================================

CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_name VARCHAR(255) NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    trigger_event VARCHAR(100) NOT NULL,
    conditions JSONB DEFAULT '{}',
    channels JSONB DEFAULT '["webhook"]',
    recipients JSONB DEFAULT '[]',
    template JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    cooldown_seconds INT DEFAULT 300,
    last_triggered_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_alert_rules_event ON alert_rules(trigger_event);
CREATE INDEX idx_alert_rules_active ON alert_rules(is_active);

CREATE TABLE IF NOT EXISTS alert_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_rule_id UUID REFERENCES alert_rules(id),
    flow_instance_id UUID REFERENCES flow_instances(id),
    alert_type VARCHAR(50) NOT NULL,
    channel VARCHAR(50) NOT NULL,
    recipient VARCHAR(255),
    subject VARCHAR(500),
    message TEXT,
    payload JSONB,
    status VARCHAR(50) DEFAULT 'PENDING',
    sent_at TIMESTAMP,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_alert_history_rule ON alert_history(alert_rule_id);
CREATE INDEX idx_alert_history_instance ON alert_history(flow_instance_id);
CREATE INDEX idx_alert_history_status ON alert_history(status);

-- =====================================================
-- QUEUE MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS job_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type VARCHAR(100) NOT NULL,
    job_name VARCHAR(255),
    flow_instance_id UUID REFERENCES flow_instances(id),
    step_execution_id UUID REFERENCES step_executions(id),
    payload JSONB NOT NULL,
    priority INT DEFAULT 0,
    
    -- Status: PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED
    status VARCHAR(50) DEFAULT 'PENDING',
    
    -- Scheduling
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Retry
    attempt_number INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    next_retry_at TIMESTAMP,
    
    -- Results
    result JSONB,
    error_message TEXT,
    
    -- Locking
    locked_by VARCHAR(100),
    locked_at TIMESTAMP,
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_job_queue_type ON job_queue(job_type);
CREATE INDEX idx_job_queue_status ON job_queue(status);
CREATE INDEX idx_job_queue_scheduled ON job_queue(scheduled_for) WHERE status = 'PENDING';
CREATE INDEX idx_job_queue_instance ON job_queue(flow_instance_id);
CREATE INDEX idx_job_queue_locked ON job_queue(locked_by) WHERE locked_by IS NOT NULL;

-- =====================================================
-- CONFIGURATION
-- =====================================================

CREATE TABLE IF NOT EXISTS system_configurations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_key VARCHAR(255) NOT NULL UNIQUE,
    config_value TEXT,
    config_type VARCHAR(50) DEFAULT 'STRING',
    description TEXT,
    is_encrypted BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_sys_config_key ON system_configurations(config_key);

-- External API configurations
CREATE TABLE IF NOT EXISTS external_apis (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    api_name VARCHAR(255) NOT NULL,
    api_code VARCHAR(50) NOT NULL UNIQUE,
    base_url VARCHAR(500) NOT NULL,
    auth_type VARCHAR(50) DEFAULT 'NONE',
    auth_config JSONB DEFAULT '{}',
    default_headers JSONB DEFAULT '{}',
    timeout_ms INT DEFAULT 30000,
    retry_config JSONB DEFAULT '{"enabled": true, "max_retries": 3, "retry_interval_ms": 1000}',
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_external_apis_code ON external_apis(api_code);

-- =====================================================
-- USER MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_name VARCHAR(100) NOT NULL UNIQUE,
    role_code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    permissions JSONB DEFAULT '[]',
    is_system BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    role_id UUID REFERENCES roles(id),
    is_active BOOLEAN DEFAULT true,
    is_locked BOOLEAN DEFAULT false,
    failed_login_attempts INT DEFAULT 0,
    last_login_at TIMESTAMP,
    password_changed_at TIMESTAMP,
    must_change_password BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role_id);

-- =====================================================
-- REPORTS
-- =====================================================

CREATE TABLE IF NOT EXISTS report_definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_name VARCHAR(255) NOT NULL,
    report_code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    report_type VARCHAR(50) NOT NULL,
    query_template TEXT,
    parameters JSONB DEFAULT '[]',
    output_format VARCHAR(20) DEFAULT 'JSON',
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID,
    updated_by UUID
);

-- =====================================================
-- MONITORING VIEWS
-- =====================================================

-- Active flow instances summary view
CREATE OR REPLACE VIEW v_active_flow_instances AS
SELECT 
    fi.id,
    fi.session_id,
    fi.tracking_number,
    f.flow_code,
    f.flow_name,
    fi.status,
    fs.step_code as current_step_code,
    fs.step_name as current_step_name,
    fi.started_at,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - fi.started_at)) as duration_seconds,
    fi.error_count,
    fi.requires_manual
FROM flow_instances fi
JOIN flows f ON f.id = fi.flow_id
LEFT JOIN flow_steps fs ON fs.id = fi.current_step_id
WHERE fi.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

-- Flow instance statistics view
CREATE OR REPLACE VIEW v_flow_statistics AS
SELECT 
    f.flow_code,
    f.flow_name,
    COUNT(*) as total_instances,
    COUNT(*) FILTER (WHERE fi.status = 'COMPLETED') as completed_count,
    COUNT(*) FILTER (WHERE fi.status = 'FAILED') as failed_count,
    COUNT(*) FILTER (WHERE fi.status IN ('PENDING', 'RUNNING', 'WAITING')) as active_count,
    COUNT(*) FILTER (WHERE fi.requires_manual = true) as manual_review_count,
    AVG(EXTRACT(EPOCH FROM (fi.completed_at - fi.started_at))) FILTER (WHERE fi.status = 'COMPLETED') as avg_duration_seconds
FROM flows f
LEFT JOIN flow_instances fi ON fi.flow_id = f.id
WHERE fi.created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
GROUP BY f.id, f.flow_code, f.flow_name;

-- Pending callbacks view
CREATE OR REPLACE VIEW v_pending_callbacks AS
SELECT 
    ec.id,
    ec.session_id,
    ec.tracking_number,
    ec.callback_type,
    ec.expected_by,
    fi.status as instance_status,
    f.flow_code,
    EXTRACT(EPOCH FROM (ec.expected_by - CURRENT_TIMESTAMP)) as time_remaining_seconds
FROM expected_callbacks ec
JOIN flow_instances fi ON fi.id = ec.flow_instance_id
JOIN flows f ON f.id = fi.flow_id
WHERE ec.status = 'WAITING';

-- =====================================================
-- TRIGGERS FOR AUTO-UPDATE
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name 
        FROM information_schema.columns 
        WHERE column_name = 'updated_at' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
            CREATE TRIGGER update_%I_updated_at
            BEFORE UPDATE ON %I
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        ', t, t, t, t);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Insert default event types
INSERT INTO event_types (event_code, event_name, function_code, description, is_sync, default_timeout_seconds) VALUES
('NEC', 'Name Enquiry', '230', 'Account name verification', true, 30),
('FTD', 'Funds Transfer Debit', '241', 'Debit leg of funds transfer', false, 120),
('FTC', 'Funds Transfer Credit', '240', 'Credit leg of funds transfer', false, 120),
('FT', 'Funds Transfer', '241', 'Complete funds transfer cycle', false, 300),
('TSQ', 'Transaction Status Query', '111', 'Query transaction status', true, 30),
('REV', 'Reversal', '242', 'Transaction reversal', false, 120),
('CALLBACK', 'Callback Handler', NULL, 'Handle incoming callbacks', true, 10),
('ALERT', 'Alert Trigger', NULL, 'Trigger alert notifications', true, 10)
ON CONFLICT (event_code) DO NOTHING;

-- Insert default roles
INSERT INTO roles (role_name, role_code, description, permissions, is_system) VALUES
('Super Admin', 'SUPER_ADMIN', 'Full system access', '["*"]', true),
('Admin', 'ADMIN', 'Administrative access', '["admin.*", "flows.*", "instances.*"]', true),
('Operator', 'OPERATOR', 'Operations access', '["instances.view", "instances.manual", "monitoring.*"]', true),
('Viewer', 'VIEWER', 'Read-only access', '["instances.view", "flows.view", "monitoring.view"]', true)
ON CONFLICT (role_code) DO NOTHING;

-- Insert default system configurations
INSERT INTO system_configurations (config_key, config_value, config_type, description) VALUES
('BFS_CALLBACK_URL', 'http://localhost:3001/api/v1/callbacks/orchestrator', 'STRING', 'BFS callback URL'),
('GIP_BASE_URL', 'http://gip-simulator:8080', 'STRING', 'GIP API base URL'),
('TSQ_MAX_RETRIES', '3', 'NUMBER', 'Maximum TSQ retry attempts'),
('TSQ_RETRY_INTERVAL', '300', 'NUMBER', 'TSQ retry interval in seconds'),
('CALLBACK_TIMEOUT', '300', 'NUMBER', 'Callback wait timeout in seconds'),
('SESSION_ID_LENGTH', '12', 'NUMBER', 'Session ID length'),
('TRACKING_NUMBER_LENGTH', '6', 'NUMBER', 'Tracking number length'),
('JOB_PROCESS_INTERVAL', '5000', 'NUMBER', 'Job processing interval in ms'),
('CALLBACK_CHECK_INTERVAL', '10000', 'NUMBER', 'Callback check interval in ms')
ON CONFLICT (config_key) DO NOTHING;

-- Insert default field mappings
INSERT INTO field_mappings (mapping_code, mapping_name, description, mappings, swap_config) VALUES
('NEC_MAPPING', 'Name Enquiry Mapping', 'Field mapping for NEC requests', 
 '[{"source": "srcBankCode", "target": "destBank"}, {"source": "destBankCode", "target": "originBank"}, {"source": "srcAccountNumber", "target": "accountToDebit"}, {"source": "destAccountNumber", "target": "accountToCredit"}]',
 '{"srcBankCode": "destBank", "destBankCode": "originBank"}'),
('FTD_MAPPING', 'Funds Transfer Debit Mapping', 'Field mapping for FTD requests',
 '[{"source": "srcBankCode", "target": "originBank"}, {"source": "destBankCode", "target": "destBank"}, {"source": "srcAccountNumber", "target": "accountToDebit"}, {"source": "destAccountNumber", "target": "accountToCredit"}]',
 '{}'),
('FTC_MAPPING', 'Funds Transfer Credit Mapping', 'Field mapping for FTC requests',
 '[{"source": "srcBankCode", "target": "destBank"}, {"source": "destBankCode", "target": "originBank"}, {"source": "srcAccountNumber", "target": "accountToCredit"}, {"source": "destAccountNumber", "target": "accountToDebit"}]',
 '{"srcBankCode": "destBank", "destBankCode": "originBank", "srcAccountNumber": "accountToCredit", "destAccountNumber": "accountToDebit"}')
ON CONFLICT (mapping_code) DO NOTHING;

-- Insert default external API (GIP)
INSERT INTO external_apis (api_name, api_code, base_url, auth_type, default_headers, timeout_ms) VALUES
('Ghana Interbank Payment', 'GIP', 'http://gip-simulator:8080', 'NONE', '{"Content-Type": "application/json"}', 30000)
ON CONFLICT (api_code) DO NOTHING;
